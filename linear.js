// Linear connection: lets this browser hold a personal API key (PAT).
// The key only ever goes to api.linear.app — never to other players.

(() => {
  const API = "https://api.linear.app/graphql";
  const K_KEY = "pp-linear-key";       // only when "Remember on this device" is on
  const K_SLUG = "pp-linear-slug";     // workspace slug (not secret)
  const K_VIEWER = "pp-linear-viewer"; // cached name/workspace for instant display

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  let key = store.get(K_KEY) || null;
  let remembered = !!key;
  let viewer = null;
  try { viewer = key ? JSON.parse(store.get(K_VIEWER) || "null") : null; } catch {}
  let status = key ? "checking" : "off"; // off | checking | on | err
  let problem = "";

  // ---------- API ----------

  async function gql(query, variables, withKey = key) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: withKey },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw { kind: "network", message: "Couldn't reach Linear. Check your connection and try again." };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    const errs = (body && body.errors) || [];
    const authErr = res.status === 401 || res.status === 403 ||
      errs.some((e) => /auth/i.test(e.message || "") || /AUTH/.test((e.extensions && e.extensions.code) || ""));
    if (authErr) throw { kind: "auth", message: "Linear didn't accept this key. It may be mistyped, expired or revoked." };
    if (!res.ok || errs.length || !body || !body.data) {
      throw { kind: "other", message: "Linear returned an error: " + ((errs[0] && errs[0].message) || res.status) };
    }
    return body.data;
  }

  async function fetchViewer(withKey) {
    const data = await gql("query { viewer { name displayName organization { name urlKey } } }", null, withKey);
    const v = data.viewer;
    return { name: v.name || v.displayName, org: v.organization.name, slug: v.organization.urlKey };
  }

  async function check() {
    if (!key) return;
    status = "checking";
    render();
    try {
      viewer = await fetchViewer(key);
      if (remembered) store.set(K_VIEWER, JSON.stringify(viewer));
      status = "on";
      problem = "";
    } catch (e) {
      status = "err";
      problem = e.message;
    }
    render();
  }

  // ---------- Helpers ----------

  // Accepts "acme", "linear.app/acme" or any full Linear URL.
  function parseSlug(text) {
    const t = (text || "").trim();
    const m = t.match(/linear\.app\/([^/\s?#]+)/i);
    return (m ? m[1] : t).toLowerCase().replace(/[^a-z0-9-]/g, "");
  }

  function createKeyUrl(slug) {
    return `https://linear.app/${encodeURIComponent(slug)}/settings/account/security/api-key/new`;
  }

  function initials(name) {
    return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  }

  // ---------- UI ----------

  function render() {
    const btn = $("linear-btn");
    btn.classList.remove("off", "on", "err", "busy");
    let label;
    if (status === "off") {
      btn.classList.add("off");
      label = "Connect Linear";
    } else if (status === "err") {
      btn.classList.add("err");
      label = "Linear: key not working";
    } else {
      btn.classList.add("on");
      if (status === "checking") btn.classList.add("busy");
      label = viewer ? `${viewer.name} · ${viewer.slug}` : "Linear";
    }
    $("linear-label").textContent = label;
    btn.setAttribute("aria-label", label);
    btn.title = label;

    // Connected view (if open)
    if (viewer) {
      $("linear-avatar").textContent = initials(viewer.name);
      $("linear-name").textContent = viewer.name;
      $("linear-meta").textContent =
        (status === "err" ? `${viewer.org} · key not working · ` : `Connected to ${viewer.org} · `) +
        (remembered ? "remembered on this device" : "kept for this tab only");
    } else {
      $("linear-avatar").textContent = "?";
      $("linear-name").textContent = "Linear key";
      $("linear-meta").textContent = remembered ? "Remembered on this device" : "Kept for this tab only";
    }
    $("linear-problem").hidden = status !== "err";
    $("linear-problem").textContent = problem;
    $("linear-retry").hidden = status !== "err";
  }

  function updateCreateLink() {
    const slug = parseSlug($("linear-slug").value);
    const a = $("linear-create");
    if (slug) {
      a.href = createKeyUrl(slug);
      a.setAttribute("aria-disabled", "false");
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
    }
  }

  function showError(msg) {
    $("linear-error").textContent = msg || "";
    $("linear-error").hidden = !msg;
  }

  function openSheet(mode) {
    const connectMode = mode === "connect" || !key;
    $("linear-connect").hidden = !connectMode;
    $("linear-connected").hidden = connectMode;
    $("linear-title-text").textContent = connectMode ? "Connect Linear" : "Linear";
    if (connectMode) {
      $("linear-slug").value = store.get(K_SLUG) || (viewer && viewer.slug) || "";
      $("linear-key").value = "";
      $("linear-key").type = "password";
      $("linear-show").textContent = "Show";
      $("linear-remember").checked = key ? remembered : true;
      showError("");
      updateCreateLink();
    }
    render();
    $("linear-scrim").hidden = false;
    $("linear-sheet").hidden = false;
    const focusEl = connectMode ? ($("linear-slug").value ? $("linear-key") : $("linear-slug")) : $("linear-close");
    focusEl.focus();
  }

  function closeSheet() {
    $("linear-scrim").hidden = true;
    $("linear-sheet").hidden = true;
    $("linear-btn").focus();
  }

  async function connect() {
    const slug = parseSlug($("linear-slug").value);
    const newKey = $("linear-key").value.trim();
    const remember = $("linear-remember").checked;
    if (!newKey) {
      showError("Paste your Linear API key first.");
      $("linear-key").focus();
      return;
    }
    showError("");
    const submit = $("linear-submit");
    submit.disabled = true;
    submit.textContent = "Checking…";
    try {
      const v = await fetchViewer(newKey);
      key = newKey;
      remembered = remember;
      viewer = v;
      status = "on";
      problem = "";
      // The key decides the workspace; keep the slug in sync with it.
      store.set(K_SLUG, v.slug || slug);
      if (remember) {
        store.set(K_KEY, key);
        store.set(K_VIEWER, JSON.stringify(v));
      } else {
        store.del(K_KEY);
        store.del(K_VIEWER);
      }
      render();
      closeSheet();
      toast(`Connected to Linear as ${v.name}`);
    } catch (e) {
      showError(e.message);
    } finally {
      submit.disabled = false;
      submit.textContent = "Connect";
    }
  }

  function forget() {
    key = null;
    viewer = null;
    remembered = false;
    status = "off";
    problem = "";
    store.del(K_KEY);
    store.del(K_VIEWER);
    render();
    closeSheet();
    toast("Linear key forgotten");
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 2500);
  }

  // ---------- Wire up ----------

  $("linear-btn").onclick = () => openSheet(key ? "status" : "connect");
  $("linear-close").onclick = closeSheet;
  $("linear-scrim").onclick = closeSheet;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("linear-sheet").hidden) closeSheet();
  });

  $("linear-slug").addEventListener("input", updateCreateLink);
  // Pasting a full Linear URL keeps just the workspace part.
  $("linear-slug").addEventListener("change", () => {
    $("linear-slug").value = parseSlug($("linear-slug").value);
    if ($("linear-slug").value) store.set(K_SLUG, $("linear-slug").value);
    updateCreateLink();
  });
  $("linear-create").addEventListener("click", () => {
    const slug = parseSlug($("linear-slug").value);
    if (slug) store.set(K_SLUG, slug);
    // Come back to the key field after creating the key.
    setTimeout(() => $("linear-key").focus(), 300);
  });

  $("linear-show").onclick = () => {
    const input = $("linear-key");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("linear-show").textContent = show ? "Hide" : "Show";
  };
  $("linear-key").addEventListener("keydown", (e) => e.key === "Enter" && connect());
  $("linear-submit").onclick = connect;

  $("linear-change").onclick = () => openSheet("connect");
  $("linear-forget").onclick = forget;
  $("linear-retry").onclick = check;

  // For later features (loading tickets, saving estimates).
  window.PPLinear = {
    get connected() { return status === "on"; },
    get viewer() { return viewer; },
    request: (query, variables) => gql(query, variables),
  };

  render();
  check();
})();
