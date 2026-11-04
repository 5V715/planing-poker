// Planning Poker — peer-to-peer via PeerJS (WebRTC).
// The session token maps to a fixed peer ID. Whoever claims that ID first is the
// host and keeps the shared state; everyone else connects to the host. If the
// host leaves, the remaining players race to claim the ID and the room carries on.

(() => {
  const DECKS = {
    fib: { label: "Fibonacci", cards: ["0", "½", "1", "2", "3", "5", "8", "13", "21", "40", "100", "?", "☕"] },
    tshirt: { label: "T-shirt", cards: ["XS", "S", "M", "L", "XL", "XXL", "?", "☕"] },
  };
  const cardsOf = (deck) => (DECKS[deck] || DECKS.fib).cards;
  const ID_PREFIX = "planning-poker-v1-";
  const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  // Stable per-browser id so a reconnecting player keeps their seat.
  let clientId = store.get("pp-client-id");
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 12);
    store.set("pp-client-id", clientId);
  }

  // Optional self-hosted PeerJS server: ?peerhost=example.com&peerport=443&peerpath=/
  const params = new URLSearchParams(location.search);
  const peerOptions = { debug: 0 };
  if (params.get("peerhost")) {
    peerOptions.host = params.get("peerhost");
    peerOptions.port = Number(params.get("peerport") || 443);
    peerOptions.path = params.get("peerpath") || "/";
    peerOptions.secure = params.get("peersecure") !== "0";
  }

  let token = null;
  let myName = "";
  let myVote = null;
  let peer = null;
  let isHost = false;
  let hostConn = null;
  let retryTimer = null;
  let generation = 0; // bumps on every (re)connect so stale callbacks are ignored

  // Host-only: full state + live connections.
  let state = freshState();
  const conns = new Map(); // DataConnection -> clientId
  const lastSeen = new Map(); // DataConnection -> timestamp (heartbeat)
  let hostLastSeen = 0;
  const PING_MS = 2000;
  const TIMEOUT_MS = 7000;

  // What this browser renders (votes masked until reveal).
  let view = null;

  // Per-player animation bookkeeping (last rendered state + running animation).
  const seen = new Map();
  const anims = new Map();
  const ANIM_MS = 700;

  function freshState() {
    return { topic: "", deck: "fib", revealed: false, players: {}, history: [] };
  }

  // ---------- History (revealed rounds) ----------

  const HISTORY_MAX = 100;
  const historyKey = () => "pp-history-" + token;

  function loadHistory() {
    try {
      const h = JSON.parse(store.get(historyKey()) || "[]");
      return Array.isArray(h) ? h : [];
    } catch { return []; }
  }

  function saveHistory(h) {
    store.set(historyKey(), JSON.stringify(h || []));
  }

  // Union of rounds by id, newest first.
  function mergeHistory(...lists) {
    const byId = new Map();
    for (const list of lists) for (const r of list || []) if (r && r.id && !byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX);
  }

  // Result summary for a list of card values.
  function summarize(votes, deck) {
    const counts = {};
    for (const v of votes) counts[v] = (counts[v] || 0) + 1;
    let label, value;
    if (deck === "tshirt") {
      // Most voted size(s); "?" and "☕" don't count.
      const sized = Object.entries(counts).filter(([v]) => v !== "?" && v !== "☕");
      const top = Math.max(0, ...sized.map(([, c]) => c));
      label = "Most votes";
      value = top ? sized.filter(([, c]) => c === top).map(([v]) => v).join(" / ") : "–";
    } else {
      const nums = votes.map((v) => (v === "½" ? 0.5 : Number(v))).filter((n) => !Number.isNaN(n));
      label = "Average";
      value = nums.length
        ? (Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10).toString()
        : "–";
    }
    const dist = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} × ${c}`).join("  ·  ");
    const consensus = votes.length > 1 && Object.keys(counts).length === 1;
    return { label, value, dist, consensus };
  }

  function newToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join("");
  }

  function cleanToken(t) {
    return (t || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  }

  // ---------- Networking ----------

  function connect() {
    clearTimeout(retryTimer);
    const gen = ++generation;
    teardown();
    setStatus("Connecting…", "warn");

    // 1) Try to become the host by claiming the session's peer ID.
    const p = new Peer(ID_PREFIX + token.toLowerCase(), peerOptions);
    peer = p;
    p.on("open", () => {
      if (gen !== generation) return;
      becomeHost();
    });
    p.on("connection", (conn) => {
      if (gen !== generation) return;
      acceptGuest(conn);
    });
    p.on("error", (err) => {
      if (gen !== generation) return;
      if (err.type === "unavailable-id") {
        // Someone is already hosting — join them as a guest.
        p.destroy();
        joinAsGuest(gen);
      } else {
        handleNetError(err, gen);
      }
    });
    p.on("disconnected", () => {
      // Lost the signalling server; existing P2P links still work. Try to re-register.
      if (gen === generation && !p.destroyed) setTimeout(() => !p.destroyed && p.reconnect(), 2000);
    });
  }

  function joinAsGuest(gen) {
    isHost = false;
    const p = new Peer(peerOptions);
    peer = p;
    p.on("open", () => {
      if (gen !== generation) return;
      const conn = p.connect(ID_PREFIX + token.toLowerCase(), { reliable: true });
      hostConn = conn;
      conn.on("open", () => {
        if (gen !== generation) return;
        setStatus("Connected", "ok");
        hostLastSeen = Date.now();
        conn.send({ type: "join", id: clientId, name: myName, vote: myVote });
      });
      conn.on("data", (msg) => {
        if (gen !== generation) return;
        hostLastSeen = Date.now();
        if (msg && msg.type === "state") {
          view = msg.state;
          view.history = mergeHistory(view.history, loadHistory());
          syncMyVoteFromView();
          render();
        }
      });
      conn.on("close", () => {
        if (gen !== generation) return;
        // Host went away: try to take over (random delay reduces collisions).
        scheduleRetry(300 + Math.random() * 1500, "Host left — reconnecting…");
      });
      conn.on("error", () => {});
    });
    p.on("error", (err) => {
      if (gen !== generation) return;
      handleNetError(err, gen);
    });
  }

  function handleNetError(err, gen) {
    if (gen !== generation) return;
    console.warn("PeerJS error:", err.type, err);
    if (err.type === "browser-incompatible") {
      setStatus("Browser not supported", "warn");
      return;
    }
    // peer-unavailable: the host left between our ID check and connect, etc.
    scheduleRetry(1500 + Math.random() * 1500, "Reconnecting…");
  }

  function scheduleRetry(ms, label) {
    setStatus(label, "warn");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  }

  function teardown() {
    if (hostConn) { try { hostConn.close(); } catch {} hostConn = null; }
    for (const c of conns.keys()) { try { c.close(); } catch {} }
    conns.clear();
    lastSeen.clear();
    if (peer && !peer.destroyed) { try { peer.destroy(); } catch {} }
    peer = null;
  }

  function becomeHost() {
    isHost = true;
    // Carry over the topic/round we last saw (if we took over from a previous host).
    const prev = view;
    state = freshState();
    if (prev) {
      state.topic = prev.topic || "";
      state.deck = DECKS[prev.deck] ? prev.deck : "fib";
      state.revealed = !!prev.revealed;
    }
    state.history = mergeHistory(prev && prev.history, loadHistory());
    state.players[clientId] = { name: myName, vote: myVote };
    setStatus("Connected (hosting)", "ok");
    broadcast();
  }

  function acceptGuest(conn) {
    lastSeen.set(conn, Date.now());
    conn.on("data", (msg) => {
      lastSeen.set(conn, Date.now());
      handleMessage(msg, conn);
    });
    conn.on("close", () => dropGuest(conn));
    conn.on("error", () => {});
  }

  function dropGuest(conn) {
    {
      const id = conns.get(conn);
      conns.delete(conn);
      lastSeen.delete(conn);
      try { conn.close(); } catch {}
      // Only drop the player if they have no other live connection.
      if (id && ![...conns.values()].includes(id)) {
        delete state.players[id];
        broadcast();
      }
    }
  }

  // Heartbeat: WebRTC can take ~30s to notice a vanished peer, so ping both ways.
  setInterval(() => {
    const now = Date.now();
    if (isHost) {
      for (const [conn, seen] of [...lastSeen]) {
        if (now - seen > TIMEOUT_MS) dropGuest(conn);
        else if (conn.open) conn.send({ type: "ping" });
      }
    } else if (hostConn && hostConn.open) {
      if (now - hostLastSeen > TIMEOUT_MS) {
        hostConn = null;
        scheduleRetry(300 + Math.random() * 1500, "Host left — reconnecting…");
      } else {
        hostConn.send({ type: "ping" });
      }
    }
  }, PING_MS);

  // Host: apply a message from a guest (conn) or from ourselves (conn = null).
  function handleMessage(msg, conn) {
    if (!msg || typeof msg !== "object") return;
    const id = conn ? conns.get(conn) : clientId;

    if (msg.type === "join" && conn) {
      const pid = String(msg.id || conn.peer).slice(0, 32);
      conns.set(conn, pid);
      const vote = cardsOf(state.deck).includes(msg.vote) ? msg.vote : null;
      state.players[pid] = { name: cleanName(msg.name), vote };
    } else if (!id || !state.players[id]) {
      return;
    } else if (msg.type === "vote") {
      if (msg.value !== null && !cardsOf(state.deck).includes(msg.value)) return;
      state.players[id].vote = msg.value;
      state.players[id].n = (state.players[id].n || 0) + 1;
    } else if (msg.type === "reveal") {
      if (state.revealed) return;
      state.revealed = true;
      const votes = Object.values(state.players)
        .filter((p) => p.vote !== null)
        .map((p) => [p.name, p.vote]);
      if (votes.length) {
        state.history = [
          { id: Math.random().toString(36).slice(2, 10), at: Date.now(), topic: state.topic, deck: state.deck, votes },
          ...state.history,
        ].slice(0, HISTORY_MAX);
      }
    } else if (msg.type === "reset") {
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "deck") {
      if (!DECKS[msg.deck] || msg.deck === state.deck) return;
      state.deck = msg.deck;
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "revote") {
      // Start a fresh round for a topic from the history.
      state.topic = String(msg.topic || "").slice(0, 300);
      if (DECKS[msg.deck]) state.deck = msg.deck;
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "topic") {
      state.topic = String(msg.topic || "").slice(0, 300);
      // Naming the round right after revealing it? Keep the history entry in sync.
      if (state.revealed && state.history[0]) state.history[0].topic = state.topic;
    } else {
      return;
    }
    broadcast();
  }

  // Each player only learns *whether* others voted until the cards are revealed.
  function viewFor(pid) {
    const players = {};
    for (const [id, p] of Object.entries(state.players)) {
      const vote = state.revealed || id === pid ? p.vote : p.vote === null ? null : true;
      players[id] = { name: p.name, vote, n: p.n || 0 };
    }
    return { topic: state.topic, deck: state.deck, revealed: state.revealed, players, history: state.history };
  }

  function broadcast() {
    for (const [conn, pid] of conns) {
      if (conn.open) conn.send({ type: "state", state: viewFor(pid) });
    }
    view = viewFor(clientId);
    render();
  }

  function send(msg) {
    if (isHost) handleMessage(msg, null);
    else if (hostConn && hostConn.open) hostConn.send(msg);
  }

  // After reconnecting, the host's state is the source of truth for our vote.
  function syncMyVoteFromView() {
    const me = view && view.players[clientId];
    if (me) myVote = me.vote === true ? myVote : me.vote;
  }

  function cleanName(n) {
    return String(n || "").trim().slice(0, 24) || "Anonymous";
  }

  // ---------- UI ----------

  function setStatus(text, kind) {
    const el = $("status");
    el.hidden = false;
    el.textContent = text;
    el.className = "status " + (kind || "");
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 2500);
  }

  function inviteUrl() {
    const u = new URL(location.href);
    u.hash = token;
    return u.toString();
  }

  function render() {
    if (!view) return;
    const players = Object.entries(view.players).sort((a, b) =>
      a[0] === clientId ? -1 : b[0] === clientId ? 1 : a[1].name.localeCompare(b[1].name)
    );

    // Topic (don't clobber while typing).
    const topicEl = $("topic");
    if (document.activeElement !== topicEl) {
      topicEl.value = view.topic || "";
      // Show the topic with clickable links unless someone is editing it.
      const tv = $("topic-view");
      tv.replaceChildren(linkify(view.topic || ""));
      tv.hidden = !view.topic;
      topicEl.hidden = !!view.topic;
    }

    // Players
    const list = $("players");
    list.innerHTML = "";
    const now = Date.now();
    let flipIndex = 0;
    for (const [id, p] of players) {
      const li = document.createElement("li");
      const voted = p.vote !== null;
      li.className = "player" + (id === clientId ? " me" : "") +
        (voted ? (view.revealed ? " shown" : " voted") : "");

      // Animate what changed since the last render.
      const before = seen.get(id);
      if (before) {
        let anim = null;
        if (!before.revealed && view.revealed && voted) anim = "anim-flip";
        else if (!view.revealed && !before.voted && voted) anim = "anim-in";
        else if (!view.revealed && before.voted && voted && p.n !== before.n) anim = "anim-change";
        else if (!view.revealed && before.voted && !voted) anim = "anim-out";
        // Revealed cards flip one after another.
        if (anim) anims.set(id, { cls: anim, at: anim === "anim-flip" ? now + 90 * flipIndex++ : now });
      }
      seen.set(id, { voted, n: p.n, revealed: view.revealed });
      // Re-renders rebuild the DOM, so resume a running animation where it was.
      const a = anims.get(id);
      if (a && now - a.at < ANIM_MS) {
        li.classList.add(a.cls);
        li.style.setProperty("--anim-delay", `${a.at - now}ms`);
      }

      const slot = document.createElement("div");
      slot.className = "slot";
      slot.textContent = view.revealed && voted ? p.vote : "";
      const name = document.createElement("div");
      name.className = "pname";
      name.textContent = p.name + (id === clientId ? " (you)" : "");
      li.append(slot, name);
      list.append(li);
    }

    // Deck
    const deck = $("deck");
    deck.innerHTML = "";
    $("deck-select").value = view.deck || "fib";
    for (const value of cardsOf(view.deck)) {
      const b = document.createElement("button");
      b.textContent = value;
      b.disabled = view.revealed;
      if (myVote === value) b.classList.add("selected");
      b.onclick = () => {
        myVote = myVote === value ? null : value;
        send({ type: "vote", value: myVote });
        render();
      };
      deck.append(b);
    }

    // Buttons
    const votes = players.map(([, p]) => p.vote).filter((v) => v !== null);
    $("reveal").disabled = view.revealed || votes.length === 0;
    $("reset").textContent = view.revealed ? "New round" : "Clear votes";

    // Results
    const res = $("results");
    if (view.revealed && votes.length) {
      res.hidden = false;
      res.innerHTML = "";
      const sum = summarize(votes, view.deck);
      const avg = document.createElement("div");
      avg.innerHTML = `<div class="small muted"></div><div class="big"></div>`;
      avg.firstChild.textContent = sum.label;
      avg.lastChild.textContent = sum.value;
      const dist = document.createElement("div");
      dist.className = "dist";
      dist.textContent = sum.dist;
      res.append(avg, dist);
      if (sum.consensus) {
        const c = document.createElement("div");
        c.className = "big";
        c.textContent = "🎉 Consensus!";
        res.append(c);
      }
    } else {
      res.hidden = true;
    }

    renderHistory();
  }

  // Text -> fragment with http(s) links turned into <a>. Ticket URLs get short labels.
  const URL_RE = /https?:\/\/[^\s<>"']+/g;

  function linkLabel(href) {
    try {
      const u = new URL(href);
      const parts = u.pathname.split("/").filter(Boolean);
      const jira = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i) ||
        (u.searchParams.get("selectedIssue") || "").match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
      if (jira) return jira[1].toUpperCase();
      const gh = u.pathname.match(/^\/[^/]+\/([^/]+)\/(?:issues|pull)\/(\d+)/);
      if (gh && /github|gitlab/.test(u.hostname)) return `${gh[1]}#${gh[2]}`;
      const last = parts[parts.length - 1];
      return u.hostname.replace(/^www\./, "") + (last ? ` › ${decodeURIComponent(last)}` : "");
    } catch {
      return href;
    }
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      // Leave trailing punctuation out of the link.
      const href = m[0].replace(/[.,;:!?)\]]+$/, "");
      frag.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "🔗 " + linkLabel(href);
      a.title = href;
      a.addEventListener("click", (e) => e.stopPropagation());
      frag.append(a);
      last = m.index + href.length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function renderHistory() {
    const history = view.history || [];
    saveHistory(history);
    $("history-section").hidden = history.length === 0;
    $("history-count").textContent = history.length ? `(${history.length})` : "";
    const ol = $("history");
    const open = new Set([...ol.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    ol.innerHTML = "";
    for (const r of history) {
      const sum = summarize(r.votes.map(([, v]) => v), r.deck);
      const li = document.createElement("li");
      const det = document.createElement("details");
      det.dataset.id = r.id;
      det.open = open.has(r.id);

      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.className = "h-topic";
      title.replaceChildren(r.topic ? linkify(r.topic) : "Untitled round");
      const result = document.createElement("span");
      result.className = "h-result";
      result.textContent = (sum.consensus ? "🎉 " : "") + sum.value;
      const meta = document.createElement("span");
      meta.className = "h-meta";
      meta.textContent = `${fmtTime(r.at)} · ${DECKS[r.deck] ? DECKS[r.deck].label : ""} · ${sum.dist}`;
      summary.append(title, result, meta);

      const votes = document.createElement("ul");
      votes.className = "h-votes";
      for (const [name, v] of r.votes) {
        const vi = document.createElement("li");
        const b = document.createElement("b");
        b.textContent = v;
        vi.append(b, document.createTextNode(" " + name));
        votes.append(vi);
      }
      const again = document.createElement("button");
      again.className = "secondary small-btn";
      again.textContent = "Vote again";
      again.onclick = () => {
        myVote = null;
        send({ type: "revote", topic: r.topic, deck: r.deck });
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
      det.append(summary, votes, again);
      li.append(det);
      ol.append(li);
    }
  }

  function historyAsText() {
    return (view.history || []).slice().reverse().map((r) => {
      const sum = summarize(r.votes.map(([, v]) => v), r.deck);
      const votes = r.votes.map(([n, v]) => `${n}: ${v}`).join(", ");
      return `${r.topic || "Untitled round"} — ${sum.label}: ${sum.value} (${votes})`;
    }).join("\n");
  }

  function showRoom() {
    $("landing").hidden = true;
    $("room").hidden = false;
    $("room-token").textContent = token;
    document.title = `Planning Poker · ${token}`;
    view = { topic: "", deck: "fib", revealed: false, players: { [clientId]: { name: myName, vote: null } }, history: loadHistory() };
    render();
    connect();
  }

  function enter(t) {
    const name = $("name").value.trim();
    if (!name) {
      $("name").focus();
      showLandingError("Please enter your name.");
      return;
    }
    myName = cleanName(name);
    store.set("pp-name", myName);
    token = t;
    if (location.hash.slice(1) !== token) history.replaceState(null, "", "#" + token);
    showRoom();
  }

  function showLandingError(msg) {
    const el = $("landing-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function showLanding() {
    $("room").hidden = true;
    $("landing").hidden = false;
    $("name").value = store.get("pp-name") || "";
    const invited = cleanToken(location.hash.slice(1));
    $("join-hint").hidden = !invited;
    $("join-invite").hidden = !invited;
    $("create").hidden = !!invited;
    $("join-box").hidden = !!invited;
    if (invited) $("join-token").textContent = invited;
    ($("name").value ? (invited ? $("join-invite") : $("create")) : $("name")).focus();
  }

  // ---------- Wire up ----------

  $("create").onclick = () => enter(newToken());
  $("join-invite").onclick = () => enter(cleanToken(location.hash.slice(1)));
  $("join").onclick = () => {
    const t = cleanToken($("token-input").value);
    if (t.length < 4) return showLandingError("That token looks too short.");
    enter(t);
  };
  $("name").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    (cleanToken(location.hash.slice(1)) ? $("join-invite") : $("create")).click();
  });
  $("token-input").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());

  $("reveal").onclick = () => send({ type: "reveal" });
  $("reset").onclick = () => {
    myVote = null;
    send({ type: "reset" });
    render();
  };
  $("deck-select").addEventListener("change", (e) => {
    myVote = null;
    send({ type: "deck", deck: e.target.value });
    render();
  });
  let topicTimer;
  const saveTopic = () => {
    clearTimeout(topicTimer);
    if ($("topic").value !== (view && view.topic)) send({ type: "topic", topic: $("topic").value });
  };
  $("topic").addEventListener("input", () => {
    clearTimeout(topicTimer);
    topicTimer = setTimeout(saveTopic, 300);
  });
  // Return saves the topic right away and closes the keyboard.
  $("topic").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("topic").blur();
    }
  });
  $("topic").addEventListener("blur", () => {
    saveTopic();
    if (view) view.topic = $("topic").value;
    render();
  });
  // Tap the topic (not a link) to edit it.
  const editTopic = () => {
    $("topic-view").hidden = true;
    $("topic").hidden = false;
    $("topic").focus();
  };
  $("topic-view").addEventListener("click", editTopic);
  $("topic-view").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      editTopic();
    }
  });

  $("history-copy").onclick = async () => {
    const text = historyAsText();
    try {
      await navigator.clipboard.writeText(text);
      toast("History copied");
    } catch {
      prompt("Copy the history:", text);
    }
  };

  $("invite").onclick = async () => {
    const url = inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied");
    } catch {
      prompt("Copy this invite link:", url);
    }
  };

  window.addEventListener("hashchange", () => {
    if (cleanToken(location.hash.slice(1)) !== token) location.reload();
  });

  // Release the session ID quickly when the tab closes so someone else can host.
  window.addEventListener("pagehide", () => {
    if (peer && !peer.destroyed) peer.destroy();
  });

  // Reconnect when a phone comes back from the background.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && token && peer && peer.destroyed) connect();
  });

  showLanding();
})();
