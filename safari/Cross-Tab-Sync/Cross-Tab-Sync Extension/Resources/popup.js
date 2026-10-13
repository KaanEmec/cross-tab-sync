"use strict";
(() => {
  // src/adapter/webext.ts
  var storageLocal = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys)
  };

  // src/core/mapping.ts
  function emptyMappings() {
    return { tabs: {}, urlCounts: {} };
  }

  // src/core/state.ts
  var PENDING_PAIR_TTL_MS = 10 * 60 * 1e3;
  function defaultState() {
    return {
      serverUrl: "",
      deviceName: "",
      deviceId: null,
      token: null,
      lastRevision: 0,
      generation: null,
      owner: null,
      mappings: emptyMappings(),
      staleMappings: null,
      pending: [],
      lastSync: null,
      lastError: null,
      statusText: null,
      receivingWindowId: null,
      pendingPair: null,
      runLock: null,
      expected: [],
      detached: {},
      startupAt: null,
      lastActivityAt: null,
      lastTakeoverAt: null,
      suppressAutoTakeover: false,
      freshPending: false,
      heldCloses: [],
      removedWindows: {}
    };
  }
  var PREFIX = "cts.";
  var KEYS = Object.keys(defaultState());
  async function saveState(storage, patch) {
    const items = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== void 0) items[PREFIX + k] = v;
    }
    if (Object.keys(items).length > 0) await storage.set(items);
  }
  var RUN_LOCK_TTL_MS = 2 * 60 * 1e3;

  // src/popup/popup.ts
  var $ = (id) => document.getElementById(id);
  var pairView = $("pair-view");
  var mainView = $("main-view");
  var errorEl = $("error");
  var badge = $("badge");
  var serverUrl = $("server-url");
  var deviceName = $("device-name");
  var pairCode = $("pair-code");
  var buttons = Array.from(document.querySelectorAll("button"));
  var busy = false;
  var reachable;
  async function send(req) {
    try {
      return await chrome.runtime.sendMessage(req);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  function relative(iso) {
    if (!iso) return "never";
    const secs = Math.round((Date.now() - Date.parse(iso)) / 1e3);
    if (secs < 45) return "just now";
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
    return new Date(iso).toLocaleString();
  }
  function showError(message) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  }
  function render(s) {
    pairView.hidden = s.paired;
    mainView.hidden = !s.paired;
    badge.hidden = !s.paired;
    if (!s.paired) {
      if (!serverUrl.value) serverUrl.value = s.serverUrl;
      if (!deviceName.value) deviceName.value = s.deviceName;
      showError(s.lastError);
      return;
    }
    if (s.reachable !== void 0) reachable = s.reachable;
    badge.textContent = reachable === false ? "Offline" : s.isOwner ? "Owner" : "Follower";
    badge.classList.toggle("owner", s.isOwner && reachable !== false);
    $("role").textContent = s.isOwner ? "Owner (publishes changes)" : "Follower (applies changes)";
    const o = s.owner;
    $("owner").textContent = !o ? "No owner" : o.deviceId === s.deviceId ? `This device (gen. ${o.generation})` : `${o.name} (gen. ${o.generation})`;
    $("last-sync").textContent = relative(s.lastSync);
    $("pending").textContent = String(s.pendingCount);
    $("status-text").textContent = s.running ? "Working\u2026" : s.statusText ?? "";
    $("identity").textContent = `${s.deviceName} \xB7 ${hostOf(s.serverUrl)}`;
    $("identity").title = s.serverUrl;
    const handOver = $("hand-over");
    const continueHere = $("continue-here");
    handOver.classList.toggle("primary", s.isOwner);
    continueHere.classList.toggle("primary", !s.isOwner);
    handOver.disabled = busy || s.running || !s.isOwner;
    handOver.title = s.isOwner ? "Publish this browser's tabs and release control" : "Only the owner can hand over";
    continueHere.disabled = busy || s.running;
    $("sync-now").disabled = busy || s.running;
    showError(s.lastError);
  }
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  function setBusy(value) {
    busy = value;
    for (const b of buttons) b.disabled = value;
    if (value) $("status-text").textContent = "Working\u2026";
  }
  async function run(req) {
    setBusy(true);
    const res = await send(req);
    if (res.ok && req.type !== "getStatus") reachable = true;
    busy = false;
    for (const b of buttons) b.disabled = false;
    if (res.status) render(res.status);
    if (!res.ok) showError(res.error);
    return res;
  }
  async function requestOrigin(url) {
    let pattern;
    try {
      const u = new URL(url.trim());
      pattern = `${u.protocol}//${u.hostname}/*`;
    } catch {
      return true;
    }
    if (!chrome.permissions?.request) return true;
    try {
      return await chrome.permissions.request({ origins: [pattern] });
    } catch {
      return false;
    }
  }
  pairView.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const saved = saveState(storageLocal, {
      pendingPair: { serverUrl: serverUrl.value, deviceName: deviceName.value, code: pairCode.value, createdAt: Date.now() },
      lastError: null
    });
    const granted = requestOrigin(serverUrl.value);
    void Promise.all([saved, granted]).then(async ([, ok]) => {
      if (!ok) {
        await saveState(storageLocal, { pendingPair: null });
        showError("Permission to reach the server was denied or is not available for this address. Pairing needs access to the server.");
        return;
      }
      const res = await run({ type: "pair" });
      if (res.ok) pairCode.value = "";
    });
  });
  $("hand-over").addEventListener("click", () => void run({ type: "handOver" }));
  $("continue-here").addEventListener("click", () => void run({ type: "continueHere" }));
  $("sync-now").addEventListener("click", () => void run({ type: "syncNow" }));
  $("create-code").addEventListener("click", async () => {
    const res = await run({ type: "createPairingCode" });
    const el = $("pairing-code");
    if (res.ok && res.pairingCode) {
      const expires = new Date(res.pairingCode.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      el.textContent = res.pairingCode.code;
      const small = document.createElement("small");
      small.textContent = `Enter on the other device. Valid until ${expires}, single use.`;
      el.append(small);
      el.hidden = false;
    }
  });
  var disconnectArmed = null;
  $("disconnect").addEventListener("click", () => {
    const btn = $("disconnect");
    if (disconnectArmed === null) {
      btn.textContent = "Click again to disconnect";
      btn.title = "Your tabs stay open";
      disconnectArmed = setTimeout(() => {
        disconnectArmed = null;
        btn.textContent = "Disconnect";
      }, 4e3);
      return;
    }
    clearTimeout(disconnectArmed);
    disconnectArmed = null;
    btn.textContent = "Disconnect";
    void run({ type: "disconnect" });
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local" || busy) return;
    void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
  });
  void run({ type: "getStatus", refresh: true });
})();
