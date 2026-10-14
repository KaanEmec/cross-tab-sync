"use strict";
(() => {
  // src/adapter/webext.ts
  var storageLocal = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys)
  };

  // src/core/client.ts
  function normalizeServerUrl(input) {
    let url;
    try {
      url = new URL(input.trim());
    } catch {
      throw new Error("Server URL is not a valid URL");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Server URL must use https:// (http:// only for localhost)");
    }
    if (url.search || url.hash) throw new Error("Server URL must not contain a query or fragment");
    return (url.origin + url.pathname).replace(/\/+$/, "");
  }
  function originPattern(serverUrl2) {
    try {
      const u = new URL(serverUrl2.trim());
      return `${u.protocol}//${u.hostname}/*`;
    } catch {
      return null;
    }
  }

  // src/core/pairing.ts
  var CODE_LENGTH = 8;
  var EXAMPLE = "https://tabs.example.com#ABCD2345";
  function normalizeCode(input) {
    return input.toUpperCase().replace(/[\s-]+/g, "");
  }
  function checkCode(raw) {
    const code = normalizeCode(raw);
    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(code)) {
      throw new Error(`A pairing code has ${CODE_LENGTH} letters and digits, e.g. ABCD2345`);
    }
    return code;
  }
  function parsePairingInput(input, knownServerUrl = "") {
    const text = input.trim();
    if (!text) throw new Error(`Paste the pairing link, e.g. ${EXAMPLE}`);
    if (/^[A-Za-z0-9\s-]+$/.test(text)) {
      const code = checkCode(text);
      if (!knownServerUrl.trim()) {
        throw new Error(`Paste the whole pairing link (server address and code, e.g. ${EXAMPLE}) or enter the server URL under Advanced`);
      }
      return { serverUrl: normalizeServerUrl(knownServerUrl), code };
    }
    const hash = text.indexOf("#");
    const fragment = hash < 0 ? "" : text.slice(hash + 1);
    if (!fragment.trim()) throw new Error(`This link has no pairing code. A pairing link ends with #CODE, e.g. ${EXAMPLE}`);
    let base = hash < 0 ? text : text.slice(0, hash);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base.trim())) base = `https://${base.trim()}`;
    return { serverUrl: normalizeServerUrl(base), code: checkCode(fragment) };
  }
  function resolvePairingForm(form, knownServerUrl = "") {
    return parsePairingInput(form.link.trim() ? form.link : form.code, form.serverUrl.trim() || knownServerUrl);
  }
  function browserLabel(browser) {
    if (browser === "safari") return "Safari";
    if (browser === "brave") return "Brave";
    return browser ? browser[0].toUpperCase() + browser.slice(1) : "Browser";
  }

  // src/core/devices.ts
  function shortId(id) {
    return id.slice(0, 8);
  }
  function relativeTime(iso, now) {
    if (!iso) return "never";
    const secs = Math.round((now - Date.parse(iso)) / 1e3);
    if (secs < 45) return "just now";
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
    return new Date(iso).toLocaleString();
  }
  function ownerLine(owner, selfId) {
    if (!owner) return "No owner";
    const label = `${owner.name} (${shortId(owner.deviceId)})`;
    return owner.deviceId === selfId ? `${label}, this device` : label;
  }
  function deviceRows(devices, now) {
    return devices.map((d) => {
      const revoked = Boolean(d.revokedAt);
      const seen = revoked ? `revoked ${relativeTime(d.revokedAt, now)}` : `last seen ${relativeTime(d.lastSeenAt, now)}`;
      return {
        id: d.id,
        title: d.isSelf ? `${d.name} (this device)` : d.name,
        detail: `${browserLabel(d.browser)} \xB7 ${shortId(d.id)} \xB7 ${seen}`,
        isSelf: d.isSelf,
        revoked,
        canRevoke: !d.isSelf && !revoked
      };
    });
  }

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
      pairedAt: null,
      lastRevision: 0,
      generation: null,
      owner: null,
      mappings: emptyMappings(),
      staleMappings: null,
      pending: [],
      lastSuccessAt: null,
      lastError: null,
      statusText: null,
      receivingWindowId: null,
      pendingPair: null,
      runLock: null,
      expected: [],
      detached: {},
      startupAt: null,
      lastActivityAt: null,
      lastActivityKind: null,
      lastTakeoverAt: null,
      suppressAutoTakeover: false,
      freshPending: false,
      heldCloses: [],
      removedWindows: {},
      errorKind: null,
      online: true,
      pendingCount: 0,
      nextRetryAt: null,
      retryAttempts: 0,
      paused: false,
      minRevision: null,
      diagnostics: null
    };
  }
  var PREFIX = "cts.";
  var KEYS = Object.keys(defaultState());
  async function saveState(storage, patch) {
    const items = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== void 0) items[PREFIX + k] = v;
    }
    if (patch.pending) items[PREFIX + "pendingCount"] = patch.pending.length;
    if (Object.keys(items).length > 0) await storage.set(items);
  }
  var RUN_LOCK_TTL_MS = 2 * 60 * 1e3;

  // src/core/status.ts
  var RETRY_MAX_MS = 5 * 6e4;
  function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  var APPLIED_ELSEWHERE_NOTE = "Applied on other devices: unknown. The server confirms receipt, not that other browsers opened the tabs.";
  var RESTORE_NOTE = "Restore reopens the saved URLs as shared tabs. Unsaved form input and page state cannot be recovered.";

  // src/popup/popup.ts
  var $ = (id) => document.getElementById(id);
  var pairView = $("pair-view");
  var mainView = $("main-view");
  var errorEl = $("error");
  var badge = $("badge");
  var pairLink = $("pair-link");
  var pairTarget = $("pair-target");
  var pairHint = pairTarget.innerHTML;
  var serverUrl = $("server-url");
  var deviceName = $("device-name");
  var pairCode = $("pair-code");
  var recover = $("recover-section");
  var deviceSection = $("device-section");
  var devicesSection = $("devices-section");
  var renameForm = $("rename-form");
  var renameInput = $("rename-input");
  var buttons = () => Array.from(document.querySelectorAll("button"));
  var busy = false;
  var reachable;
  var last = null;
  $("applied-note").textContent = APPLIED_ELSEWHERE_NOTE;
  $("restore-note").textContent = RESTORE_NOTE;
  async function send(req) {
    try {
      return await chrome.runtime.sendMessage(req);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  var relative = (iso) => relativeTime(iso, Date.now());
  var ACTIVITY_WORDS = { activated: "tab switch", focus: "window focus", created: "new tab" };
  function lastActivity(s) {
    if (s.lastActivityAt === null) return "";
    const kind = s.lastActivityKind ? `${ACTIVITY_WORDS[s.lastActivityKind] ?? s.lastActivityKind}, ` : "";
    return `Last activity: ${kind}${new Date(s.lastActivityAt).toLocaleTimeString()}`;
  }
  function showError(message) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  }
  function render(s) {
    last = s;
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
    const offline = reachable === false || !s.online;
    badge.textContent = s.paused ? "Paused" : offline ? "Offline" : s.isOwner ? "Owner" : "Follower";
    badge.classList.toggle("owner", s.isOwner && !offline && !s.paused);
    $("role").textContent = s.isOwner ? "Owner (publishes changes)" : "Follower (applies changes)";
    $("owner").textContent = ownerLine(s.owner, s.deviceId);
    $("owner").title = s.owner ? `Generation ${s.owner.generation}` : "";
    $("last-sync").textContent = relative(s.lastSuccessAt);
    $("last-sync").title = `Revision ${s.lastRevision}` + (s.minRevision !== null ? `; server history from revision ${s.minRevision}` : "");
    $("sync-state").textContent = s.summary;
    $("status-text").textContent = s.running ? "Working\u2026" : s.statusText ?? "";
    $("last-activity").textContent = lastActivity(s);
    $("last-activity").hidden = s.lastActivityAt === null;
    renderIdentity(s);
    const handOver = $("hand-over");
    const continueHere = $("continue-here");
    const syncNow = $("sync-now");
    const blocked = busy || s.running;
    handOver.classList.toggle("primary", s.isOwner);
    continueHere.classList.toggle("primary", !s.isOwner);
    handOver.disabled = blocked || s.paused || !s.isOwner;
    handOver.title = s.isOwner ? "Publish this browser's tabs and release control" : "Only the owner can hand over";
    continueHere.disabled = blocked || s.paused;
    syncNow.disabled = blocked || s.paused;
    syncNow.textContent = s.nextRetryAt !== null ? "Retry now" : "Sync now";
    $("pause").textContent = s.paused ? "Resume sync" : "Pause sync";
    $("pause").disabled = blocked;
    $("grant").hidden = s.errorKind !== "permission";
    showError(s.lastError);
  }
  function renderIdentity(s) {
    const id = s.deviceId ?? "";
    $("self-summary").textContent = `\xB7 ${s.deviceName} (${shortId(id)})`;
    $("self-name").textContent = s.deviceName;
    $("self-browser").textContent = browserLabel("safari");
    $("self-id").textContent = shortId(id);
    $("self-id").title = id;
    $("self-server").textContent = s.serverUrl;
    $("self-since").textContent = s.pairedAt ? new Date(s.pairedAt).toLocaleString() : "unknown";
  }
  function copyText(text, source, btn) {
    const label = btn.textContent;
    const flash = (msg) => {
      btn.textContent = msg;
      setTimeout(() => btn.textContent = label, 2e3);
    };
    const select = () => {
      if (source instanceof HTMLInputElement) {
        source.focus();
        source.select();
      } else {
        window.getSelection()?.selectAllChildren(source);
      }
      flash(navigator.userAgent.includes("Mac") ? "Press \u2318C" : "Press Ctrl+C");
    };
    if (!navigator.clipboard?.writeText) return select();
    navigator.clipboard.writeText(text).then(() => flash("Copied"), select);
  }
  function setBusy(value) {
    busy = value;
    for (const b of buttons()) b.disabled = value;
    if (value) $("status-text").textContent = "Working\u2026";
  }
  async function run(req) {
    setBusy(true);
    const res = await send(req);
    if (res.ok && req.type !== "getStatus") reachable = true;
    busy = false;
    for (const b of buttons()) b.disabled = false;
    if (res.status) render(res.status);
    if (!res.ok) showError(res.error);
    return res;
  }
  function confirmTwice(btn, armedLabel, action) {
    const label = btn.textContent ?? "";
    let timer = null;
    let armedAt = 0;
    btn.addEventListener("click", () => {
      if (timer !== null && Date.now() - armedAt < 400) return;
      if (timer === null) {
        armedAt = Date.now();
        btn.textContent = armedLabel;
        timer = setTimeout(() => {
          timer = null;
          btn.textContent = label;
        }, 4e3);
        return;
      }
      clearTimeout(timer);
      timer = null;
      btn.textContent = label;
      action();
    });
  }
  async function requestOrigin(url) {
    const pattern = originPattern(url);
    if (!pattern || !chrome.permissions?.request) return true;
    try {
      return await chrome.permissions.request({ origins: [pattern] });
    } catch {
      return false;
    }
  }
  function item(text, detail, button2, className = "") {
    const li = document.createElement("li");
    if (className) li.className = className;
    const span = document.createElement("span");
    span.textContent = text;
    const small = document.createElement("small");
    small.textContent = detail;
    span.append(small);
    li.append(span);
    if (button2) li.append(button2);
    return li;
  }
  function fill(list, items, empty) {
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = empty;
      items = [li];
    }
    list.replaceChildren(...items);
  }
  function button(label, armedLabel, action, danger = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "danger";
    confirmTwice(b, armedLabel, action);
    return b;
  }
  async function loadSnapshots() {
    const [snaps, devs] = await Promise.all([send({ type: "listSnapshots" }), send({ type: "listDevices" })]);
    if (!snaps.ok) return showError(snaps.error);
    const names = new Map((devs.ok ? devs.devices ?? [] : []).map((d) => [d.id, d.name]));
    const rows = (snaps.snapshots ?? []).map((s) => {
      const who = s.deviceId === last?.deviceId ? "this device" : names.get(s.deviceId) ?? "a removed device";
      const why = s.reason === "restore" ? "before a restore" : "before a change";
      const restore = button("Restore", "Confirm restore", () => {
        void run({ type: "restoreSnapshot", id: s.id }).then(async (r) => {
          if (r.ok) await loadSnapshots();
        });
      });
      return item(`${new Date(s.createdAt).toLocaleString()} \xB7 ${s.entryCount} tab(s)`, `${who}, ${why}`, restore);
    });
    fill($("snapshots"), rows, "No snapshots yet");
  }
  async function revoke(id) {
    if ((await run({ type: "revokeDevice", id })).ok) await loadDevices();
  }
  async function loadDevices() {
    const res = await send({ type: "listDevices" });
    if (!res.ok) return showError(res.error);
    const rows = deviceRows(res.devices ?? [], Date.now()).map((d) => {
      const action = d.canRevoke ? button("Revoke", "Confirm revoke", () => void revoke(d.id), true) : void 0;
      return item(d.title, d.detail, action, d.revoked ? "revoked" : "");
    });
    fill($("devices"), rows, "No devices");
  }
  function pairingTarget() {
    return resolvePairingForm({ link: pairLink.value, serverUrl: serverUrl.value, code: pairCode.value }, last?.serverUrl ?? "");
  }
  pairLink.addEventListener("input", () => {
    let host = "";
    try {
      host = new URL(pairingTarget().serverUrl).host;
    } catch {
    }
    if (host) pairTarget.textContent = `Pairs with ${host}.`;
    else pairTarget.innerHTML = pairHint;
  });
  pairView.addEventListener("submit", (ev) => {
    ev.preventDefault();
    let target;
    try {
      target = pairingTarget();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!deviceName.value.trim()) return showError("Enter a device name");
    showError(null);
    const saved = saveState(storageLocal, {
      pendingPair: { serverUrl: target.serverUrl, deviceName: deviceName.value, code: target.code, createdAt: Date.now() },
      lastError: null
    });
    const granted = requestOrigin(target.serverUrl);
    void Promise.all([saved, granted]).then(async ([, ok]) => {
      if (!ok) {
        await saveState(storageLocal, { pendingPair: null });
        showError("Permission to reach the server was denied or is not available for this address. Pairing needs access to the server.");
        return;
      }
      const res = await run({ type: "pair" });
      if (res.ok) pairLink.value = pairCode.value = "";
    });
  });
  $("hand-over").addEventListener("click", () => void run({ type: "handOver" }));
  $("continue-here").addEventListener("click", () => void run({ type: "continueHere" }));
  $("sync-now").addEventListener("click", () => void run({ type: "syncNow" }));
  $("pause").addEventListener("click", () => void run({ type: last?.paused ? "resume" : "pause" }));
  $("grant").addEventListener("click", () => {
    void requestOrigin(last?.serverUrl ?? "").then(async (ok) => {
      if (ok) await run({ type: "syncNow" });
    });
  });
  recover.addEventListener("toggle", () => void (recover.open && loadSnapshots()));
  devicesSection.addEventListener("toggle", () => void (devicesSection.open && loadDevices()));
  deviceSection.addEventListener("toggle", () => void (deviceSection.open && last?.paired && !last.pairedAt && send({ type: "listDevices" })));
  $("copy-id").addEventListener("click", (ev) => copyText(last?.deviceId ?? "", $("self-id"), ev.currentTarget));
  function showRename(open) {
    renameForm.hidden = !open;
    $("rename").hidden = open;
    if (open) {
      renameInput.value = last?.deviceName ?? "";
      renameInput.focus();
      renameInput.select();
    }
  }
  $("rename").addEventListener("click", () => showRename(true));
  $("rename-cancel").addEventListener("click", () => showRename(false));
  renameForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = renameInput.value.trim();
    if (!name) return showError("Enter a device name");
    void run({ type: "renameDevice", name }).then(async (res) => {
      if (!res.ok) return;
      showRename(false);
      if (devicesSection.open) await loadDevices();
    });
  });
  var inviteLink = $("invite-link");
  $("invite").addEventListener("click", async () => {
    const res = await run({ type: "createPairingCode" });
    if (!res.ok || !res.pairingCode) return;
    const { link, expiresAt } = res.pairingCode;
    const expires = clock(Date.parse(expiresAt));
    inviteLink.value = link;
    $("invite-note").textContent = `Valid until ${expires}, single use. In the other browser, open Cross-Tab-Sync and paste this link.`;
    $("invite-box").hidden = false;
    $("invite").textContent = "New invitation link";
  });
  $("copy-link").addEventListener("click", (ev) => copyText(inviteLink.value, inviteLink, ev.currentTarget));
  var disconnect = $("disconnect");
  disconnect.title = "Releases ownership and revokes this device on the server. Your tabs stay open.";
  confirmTwice(disconnect, "Click again to disconnect. Pairing again gives this browser a new identity.", () => void run({ type: "disconnect" }));
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local" || busy) return;
    void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
  });
  void run({ type: "getStatus", refresh: true });
})();
