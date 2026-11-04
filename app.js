// Planning Poker — peer-to-peer via PeerJS (WebRTC).
// The session token maps to a fixed peer ID. Whoever claims that ID first is the
// host and keeps the shared state; everyone else connects to the host. If the
// host leaves, the remaining players race to claim the ID and the room carries on.

(() => {
  const DECKS = {
    fib: { label: "Fibonacci", cards: ["0", "½", "1", "2", "3", "5", "8", "13", "21", "40", "100", "?", "☕"] },
    tshirt: { label: "T-shirt", cards: ["XS", "S", "M", "L", "XL", "XXL", "?", "☕"] },
  };

  // Linear team estimation scales. T-shirt sizes are stored in Linear as numbers.
  const LINEAR_SCALES = {
    fibonacci: { label: "Fibonacci", base: [1, 2, 3, 5, 8], extended: [13, 21] },
    exponential: { label: "Exponential", base: [1, 2, 4, 8, 16], extended: [32, 64] },
    linear: { label: "Linear", base: [1, 2, 3, 4, 5], extended: [6, 7] },
    tShirt: { label: "T-shirt", base: [1, 2, 3, 5, 8], extended: [13, 21] },
  };
  const TSHIRT_SIZES = { 0: "–", 1: "XS", 2: "S", 3: "M", 5: "L", 8: "XL", 13: "XXL", 21: "XXXL" };

  // Card list for a Linear scale: [{ card, value }] where value is what Linear stores.
  function linearCards(scale) {
    const def = scale && LINEAR_SCALES[scale.type];
    if (!def) return null;
    const nums = [...(scale.allowZero ? [0] : []), ...def.base, ...(scale.extended ? def.extended : [])];
    return nums.map((n) => ({ card: scale.type === "tShirt" ? TSHIRT_SIZES[n] || String(n) : String(n), value: n }));
  }

  // { label, cards, sizes } for a deck id. "linear" uses the current ticket's team scale.
  function deckInfo(deck, scale) {
    if (deck === "linear") {
      const lc = linearCards(scale);
      if (lc) {
        return {
          label: `Linear · ${LINEAR_SCALES[scale.type].label}`,
          cards: [...lc.map((c) => c.card), "?", "☕"],
          sizes: scale.type === "tShirt",
        };
      }
    }
    const d = DECKS[deck] || DECKS.fib;
    return { label: d.label, cards: d.cards, sizes: deck === "tshirt" };
  }

  // Linear estimate number -> how it reads on that team's scale.
  function estimateLabel(estimate, scale) {
    if (estimate === null || estimate === undefined) return null;
    if (scale && scale.type === "tShirt") return TSHIRT_SIZES[estimate] || String(estimate);
    return `${estimate} ${estimate === 1 ? "point" : "points"}`;
  }
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
    return { topic: "", deck: "fib", revealed: false, players: {}, history: [], ticket: null, linearScale: null };
  }

  // ---------- Linear tickets ----------

  // "ENG-123" from a Linear URL in the topic, or a bare key when the topic has no other link.
  function linearRef(topic) {
    const t = topic || "";
    const m = t.match(/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/);
    if (m) return { id: m[1].toUpperCase(), fromUrl: true };
    if (/https?:\/\//.test(t)) return null;
    const k = t.match(/\b([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/);
    return k ? { id: k[1], fromUrl: false } : null;
  }

  function topicMentions(topic, ticket) {
    const ref = linearRef(topic);
    return !!ref && ref.id === ticket.identifier.toUpperCase();
  }

  function cleanScale(sc) {
    if (!sc || typeof sc !== "object") return null;
    const type = String(sc.type || "");
    if (!LINEAR_SCALES[type] && type !== "notUsed") return null;
    return { type, allowZero: !!sc.allowZero, extended: !!sc.extended };
  }

  // Tickets arrive from other players: keep only expected fields, bounded in size.
  function cleanTicket(t) {
    if (!t || typeof t !== "object") return null;
    const identifier = String(t.identifier || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return null;
    const url = String(t.url || "");
    const color = String(t.stateColor || "");
    return {
      identifier,
      title: String(t.title || "").slice(0, 300),
      url: /^https:\/\/linear\.app\//.test(url) ? url.slice(0, 500) : "",
      description: String(t.description || "").slice(0, 20000),
      estimate: Number.isFinite(t.estimate) ? t.estimate : null,
      stateName: String(t.stateName || "").slice(0, 60),
      stateColor: /^#[0-9a-f]{3,8}$/i.test(color) ? color : "",
      team: String(t.team || "").slice(0, 80),
      scale: cleanScale(t.scale),
    };
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
  function summarize(votes, sizes) {
    const counts = {};
    for (const v of votes) counts[v] = (counts[v] || 0) + 1;
    let label, value;
    if (sizes) {
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
      state.ticket = cleanTicket(prev.ticket);
      state.linearScale = state.ticket ? state.ticket.scale : cleanScale(prev.linearScale);
      state.deck = DECKS[prev.deck] || (prev.deck === "linear" && linearCards(state.linearScale)) ? prev.deck : "fib";
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
      const vote = deckInfo(state.deck, state.linearScale).cards.includes(msg.vote) ? msg.vote : null;
      state.players[pid] = { name: cleanName(msg.name), vote };
    } else if (!id || !state.players[id]) {
      return;
    } else if (msg.type === "vote") {
      if (msg.value !== null && !deckInfo(state.deck, state.linearScale).cards.includes(msg.value)) return;
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
          {
            id: Math.random().toString(36).slice(2, 10), at: Date.now(), topic: state.topic, votes,
            deck: state.deck,
            deckLabel: deckInfo(state.deck, state.linearScale).label,
            sizes: deckInfo(state.deck, state.linearScale).sizes,
            title: state.ticket ? state.ticket.title : undefined,
          },
          ...state.history,
        ].slice(0, HISTORY_MAX);
      }
    } else if (msg.type === "reset") {
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "deck") {
      if (msg.deck === state.deck) return;
      if (!DECKS[msg.deck] && !(msg.deck === "linear" && linearCards(state.linearScale))) return;
      state.deck = msg.deck;
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "revote") {
      // Start a fresh round for a topic from the history.
      state.topic = String(msg.topic || "").slice(0, 300);
      if (state.ticket && !topicMentions(state.topic, state.ticket)) state.ticket = null;
      if (DECKS[msg.deck] || (msg.deck === "linear" && linearCards(state.linearScale))) state.deck = msg.deck;
      state.revealed = false;
      for (const p of Object.values(state.players)) p.vote = null;
    } else if (msg.type === "topic") {
      state.topic = String(msg.topic || "").slice(0, 300);
      // Naming the round right after revealing it? Keep the history entry in sync.
      if (state.revealed && state.history[0]) state.history[0].topic = state.topic;
      if (state.ticket && !topicMentions(state.topic, state.ticket)) state.ticket = null;
    } else if (msg.type === "ticket") {
      // A player with Linear connected loaded the ticket named in the topic.
      const t = cleanTicket(msg.ticket);
      if (!t || !topicMentions(state.topic, t)) return;
      state.ticket = t;
      if (linearCards(t.scale)) {
        const before = deckInfo(state.deck, state.linearScale).cards.join();
        state.linearScale = t.scale;
        state.deck = "linear";
        // Different cards than before? Votes from the old deck no longer fit.
        if (deckInfo("linear", t.scale).cards.join() !== before) {
          state.revealed = false;
          for (const p of Object.values(state.players)) p.vote = null;
        }
      }
      if (state.revealed && state.history[0] && !state.history[0].title) state.history[0].title = t.title;
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
    return {
      topic: state.topic, deck: state.deck, revealed: state.revealed, players, history: state.history,
      ticket: state.ticket, linearScale: state.linearScale,
    };
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
    const sel = $("deck-select");
    let linOpt = sel.querySelector('option[value="linear"]');
    if (linearCards(view.linearScale)) {
      if (!linOpt) {
        linOpt = document.createElement("option");
        linOpt.value = "linear";
        sel.append(linOpt);
      }
      linOpt.textContent = deckInfo("linear", view.linearScale).label;
    } else if (linOpt) {
      linOpt.remove();
    }
    sel.value = view.deck || "fib";
    for (const value of deckInfo(view.deck, view.linearScale).cards) {
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
      const sum = summarize(votes, deckInfo(view.deck, view.linearScale).sizes);
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
    renderTicket();
    maybeFetchTicket();
  }

  // ---------- Ticket card ----------

  let ticketFetch = null; // { id, status: "loading" | "error", message }
  let ticketExpanded = false;
  let shownTicketId = null;

  function maybeFetchTicket(force) {
    const ref = linearRef(view.topic);
    const lin = window.PPLinear;
    if (!ref || !lin || !lin.connected) return;
    if (!force && view.ticket && view.ticket.identifier === ref.id) return;
    if (ticketFetch && ticketFetch.id === ref.id && (ticketFetch.status === "loading" || !force)) return;
    ticketFetch = { id: ref.id, status: "loading", fromUrl: ref.fromUrl };
    renderTicket();
    lin.fetchIssue(ref.id).then(
      (t) => {
        if (!ticketFetch || ticketFetch.id !== ref.id) return;
        ticketFetch = null;
        send({ type: "ticket", ticket: t });
        render();
      },
      (e) => {
        if (!ticketFetch || ticketFetch.id !== ref.id) return;
        ticketFetch = { id: ref.id, status: "error", fromUrl: ref.fromUrl, message: e.message || String(e) };
        renderTicket();
      }
    );
  }

  // Markdown -> sanitized HTML. Images are shown as links (Linear uploads need a login).
  function renderMarkdown(md) {
    const box = document.createElement("div");
    if (!window.marked || !window.DOMPurify) {
      box.textContent = md;
      box.classList.add("plain");
      return box;
    }
    const html = window.marked.parse(md, { gfm: true, breaks: true });
    if (!renderMarkdown.hooked) {
      // Move image URLs aside while still in the sanitizer's inert document, so nothing loads.
      window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "IMG") {
          node.setAttribute("data-src", node.getAttribute("src") || "");
          node.removeAttribute("src");
          node.removeAttribute("srcset");
        }
      });
      renderMarkdown.hooked = true;
    }
    box.innerHTML = window.DOMPurify.sanitize(html, {
      FORBID_TAGS: ["style", "form", "iframe", "video", "audio", "source", "picture"],
      FORBID_ATTR: ["style", "class", "id"],
    });
    for (const img of box.querySelectorAll("img")) {
      const src = img.getAttribute("data-src") || "";
      const a = document.createElement("a");
      a.textContent = "🖼 " + (img.getAttribute("alt") || "image");
      if (/^https?:/.test(src)) a.href = src;
      img.replaceWith(a);
    }
    for (const a of box.querySelectorAll("a")) {
      const href = a.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href)) a.removeAttribute("href");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    for (const cb of box.querySelectorAll("input")) {
      if (cb.type === "checkbox") cb.disabled = true;
      else cb.remove();
    }
    return box;
  }

  function renderTicket() {
    const card = $("ticket");
    const t = view.ticket;
    const ref = linearRef(view.topic);
    const lin = window.PPLinear;

    // Status line when there's no ticket loaded yet.
    const note = $("ticket-note");
    let noteText = "";
    if (!t && ref && ticketFetch && ticketFetch.id === ref.id) {
      if (ticketFetch.status === "loading") noteText = `Loading ${ref.id} from Linear…`;
      else if (ticketFetch.fromUrl) noteText = `Couldn't load ${ref.id} from Linear: ${ticketFetch.message}`;
    } else if (!t && ref && ref.fromUrl && !(lin && lin.connected)) {
      noteText = "Connect Linear (logo at the top) to load this ticket and its estimate scale.";
    }
    note.textContent = noteText;
    note.hidden = !noteText;

    if (!t) {
      card.hidden = true;
      shownTicketId = null;
      return;
    }
    card.hidden = false;
    $("ticket-id").textContent = t.identifier;
    if (t.url) $("ticket-id").href = t.url; else $("ticket-id").removeAttribute("href");
    $("ticket-state").textContent = t.stateName;
    $("ticket-state").hidden = !t.stateName;
    $("ticket-state-dot").style.background = t.stateColor || "var(--muted)";
    $("ticket-title").textContent = t.title;

    const est = estimateLabel(t.estimate, t.scale);
    const meta = [];
    if (t.team) meta.push(t.team);
    if (t.scale && t.scale.type === "notUsed") meta.push("estimates are off for this team");
    else if (t.scale && LINEAR_SCALES[t.scale.type]) meta.push(`${LINEAR_SCALES[t.scale.type].label} scale`);
    meta.push(est ? `Linear estimate: ${est}` : "Not estimated yet");
    $("ticket-meta").textContent = meta.join(" · ");

    $("ticket-refresh").hidden = !(lin && lin.connected);

    // Only rebuild the description when the ticket changes (keeps scroll/expand state).
    const key = t.identifier + "|" + t.description;
    if (shownTicketId !== key) {
      if (!shownTicketId || shownTicketId.split("|")[0] !== t.identifier) ticketExpanded = false;
      shownTicketId = key;
      const desc = $("ticket-desc");
      desc.replaceChildren(t.description ? renderMarkdown(t.description) : "");
      desc.hidden = !t.description;
    }
    const desc = $("ticket-desc");
    desc.classList.toggle("collapsed", !ticketExpanded);
    // Show the toggle only if the text is actually cut off.
    requestAnimationFrame(() => {
      const overflowing = desc.scrollHeight > desc.clientHeight + 4;
      $("ticket-more").hidden = !t.description || (!overflowing && !ticketExpanded);
      $("ticket-more").textContent = ticketExpanded ? "Show less" : "Show more";
    });
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
      const lin = u.hostname === "linear.app" && u.pathname.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/);
      if (lin) return lin[1].toUpperCase();
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
      const sum = summarize(r.votes.map(([, v]) => v), r.sizes ?? r.deck === "tshirt");
      const li = document.createElement("li");
      const det = document.createElement("details");
      det.dataset.id = r.id;
      det.open = open.has(r.id);

      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.className = "h-topic";
      title.replaceChildren(r.topic ? linkify(r.topic) : "Untitled round");
      if (r.title) title.append(" · " + r.title);
      const result = document.createElement("span");
      result.className = "h-result";
      result.textContent = (sum.consensus ? "🎉 " : "") + sum.value;
      const meta = document.createElement("span");
      meta.className = "h-meta";
      meta.textContent = `${fmtTime(r.at)} · ${r.deckLabel || (DECKS[r.deck] ? DECKS[r.deck].label : "")} · ${sum.dist}`;
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
      const sum = summarize(r.votes.map(([, v]) => v), r.sizes ?? r.deck === "tshirt");
      const votes = r.votes.map(([n, v]) => `${n}: ${v}`).join(", ");
      return `${r.topic || "Untitled round"}${r.title ? " · " + r.title : ""} — ${sum.label}: ${sum.value} (${votes})`;
    }).join("\n");
  }

  function showRoom() {
    $("landing").hidden = true;
    $("room").hidden = false;
    $("room-token").textContent = token;
    document.title = `Planning Poker · ${token}`;
    view = {
      topic: "", deck: "fib", revealed: false, players: { [clientId]: { name: myName, vote: null } },
      history: loadHistory(), ticket: null, linearScale: null,
    };
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

  $("ticket-more").onclick = () => {
    ticketExpanded = !ticketExpanded;
    renderTicket();
  };
  $("ticket-refresh").onclick = () => maybeFetchTicket(true);
  // Linear connected/disconnected in this browser: try loading the ticket.
  window.addEventListener("pp-linear-change", () => view && render());

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
