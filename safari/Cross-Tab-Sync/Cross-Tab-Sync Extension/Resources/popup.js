"use strict";
(() => {
  // src/adapter/webext.ts
  var storageLocal = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys)
  };

  // src/core/crypto.ts
  var KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder("utf-8", { fatal: true });
  function base64url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromBase64url(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("Invalid base64url");
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  function decodeKey(key) {
    const bytes = KEY_PATTERN.test(key) ? fromBase64url(key) : null;
    if (!bytes || bytes.length !== 32 || base64url(bytes) !== key) throw new Error("Invalid encryption key");
    return bytes;
  }

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
  var SHAPE = "#CODE.KEY (or #CODE for the first browser)";
  function normalizeCode(input) {
    return input.toUpperCase().replace(/[\s-]+/g, "");
  }
  function isKey(text) {
    try {
      decodeKey(text);
      return true;
    } catch {
      return false;
    }
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
      const code2 = checkCode(text);
      if (!knownServerUrl.trim()) {
        throw new Error(`Paste the whole pairing link (server address and code, e.g. ${EXAMPLE}) or enter the server URL under Advanced`);
      }
      return { serverUrl: normalizeServerUrl(knownServerUrl), code: code2 };
    }
    const hash = text.indexOf("#");
    const fragment = hash < 0 ? "" : text.slice(hash + 1);
    if (!fragment.trim()) throw new Error(`This link has no pairing code. A pairing link ends with ${SHAPE}, e.g. ${EXAMPLE}`);
    let base = hash < 0 ? text : text.slice(0, hash);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base.trim())) base = `https://${base.trim()}`;
    const dot = fragment.indexOf(".");
    const serverUrl2 = normalizeServerUrl(base);
    const code = checkCode(dot < 0 ? fragment : fragment.slice(0, dot));
    if (dot < 0) return { serverUrl: serverUrl2, code };
    const key = fragment.slice(dot + 1).trim();
    if (!isKey(key)) {
      throw new Error(`The encryption key in this link is incomplete or damaged. A pairing link ends with ${SHAPE}; copy the whole link again.`);
    }
    return { serverUrl: serverUrl2, code, key };
  }
  function resolvePairingForm(form, knownServerUrl = "") {
    return parsePairingInput(form.link.trim() ? form.link : form.code, form.serverUrl.trim() || knownServerUrl);
  }
  function browserLabel(browser) {
    if (browser === "safari") return "Safari";
    if (browser === "brave") return "Brave";
    return browser ? browser[0].toUpperCase() + browser.slice(1) : "Browser";
  }

  // src/core/status.ts
  var RETRY_MAX_MS = 5 * 6e4;
  function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  var APPLIED_ELSEWHERE_NOTE = "Applied on other devices: unknown. The server confirms receipt, not that other browsers opened the tabs.";

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
    const days = Math.round(secs / 86400);
    if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
    return `on ${new Date(iso).toLocaleDateString()}`;
  }
  function secondsAgo(iso, now) {
    const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1e3));
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs} s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
    return `on ${new Date(iso).toLocaleDateString()}`;
  }
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function driverOf(s) {
    if (!s.paired) return "none";
    if (s.isOwner) return "self";
    return s.owner ? "other" : "none";
  }
  function toneOf(s) {
    if (s.lastError) return "bad";
    if (!s.paired) return "off";
    if (s.paused) return "warn";
    return s.isOwner ? "ok" : "neutral";
  }
  function heroTitle(s) {
    if (!s.paired) return "Not connected";
    if (s.paused) return "Paused";
    if (s.isOwner) return "This browser is driving";
    return s.owner ? `Following ${s.owner.name}` : "Nobody is driving";
  }
  function heroDetail(s, ctx) {
    if (!s.paired) return "Paste a pairing link from another browser or your server.";
    if (ctx.working) return "Syncing now";
    const n = s.pendingCount;
    const waiting = plural(n, "change") + " waiting";
    const retry = s.nextRetryAt !== null ? `retrying at ${clock(s.nextRetryAt)}` : null;
    if (s.paused) return n > 0 ? `${waiting}, kept until you resume` : "Tabs are not shared until you resume";
    if (ctx.offline || !s.online) {
      if (n > 0) return `Offline, ${waiting}`;
      return retry ? `Offline, ${retry}` : "Offline";
    }
    if (n > 0) return retry ? `${waiting}, ${retry}` : waiting;
    if (!s.lastSuccessAt) return "Not synced yet";
    return `${s.isOwner ? "Saved" : "Synced"} ${secondsAgo(s.lastSuccessAt, ctx.now)}`;
  }
  function otherLabel(s, devices2) {
    if (s.paired && !s.isOwner && s.owner) return s.owner.name;
    if (!s.paired || !devices2) return "Other browsers";
    const others = devices2.filter((d) => !d.isSelf && !d.revokedAt);
    if (others.length === 0) return "No other browsers";
    if (others.length === 1) return others[0].name;
    return `${others.length} other browsers`;
  }
  function heroView(s, ctx) {
    return {
      tone: toneOf(s),
      driver: driverOf(s),
      title: heroTitle(s),
      detail: heroDetail(s, ctx),
      selfLabel: s.paired && s.deviceName ? s.deviceName : "This browser",
      otherLabel: otherLabel(s, ctx.devices)
    };
  }
  function primaryAction(s) {
    if (s.paused) return { label: "Resume sync", request: "resume", title: "Start syncing this browser again" };
    if (s.isOwner) return { label: "Hand over", request: "handOver", title: "Save this browser's tabs and let another browser drive" };
    return { label: "Continue here", request: "continueHere", title: "Open the shared tabs here and drive from this browser" };
  }
  function errorFix(s) {
    if (!s.lastError) return null;
    if (s.errorKind === "permission") return "grant";
    if (s.errorKind === "unreachable" || s.errorKind === "server") return "retry";
    return null;
  }
  var ACTIVITY_WORDS = { activated: "Tab switch", focus: "Window focus", created: "New tab" };
  function activityLine(s) {
    if (s.lastActivityAt === null) return "None yet";
    const time = clock(s.lastActivityAt);
    return s.lastActivityKind ? `${ACTIVITY_WORDS[s.lastActivityKind] ?? s.lastActivityKind}, ${time}` : time;
  }
  function deviceRows(devices2, now) {
    return devices2.map((d) => {
      const revoked = Boolean(d.revokedAt);
      const seen = relativeTime(d.lastSeenAt, now);
      return {
        id: d.id,
        name: d.name,
        browser: browserLabel(d.browser),
        shortId: shortId(d.id),
        seen: `Seen ${seen}`,
        revokedNote: revoked ? `Revoked ${relativeTime(d.revokedAt, now)}` : null,
        isSelf: d.isSelf,
        revoked,
        canRevoke: !d.isSelf && !revoked
      };
    });
  }
  function devicesSummary(devices2) {
    return plural(devices2.filter((d) => !d.revokedAt).length, "browser");
  }
  function snapshotRows(snaps, selfId, devices2) {
    const names = new Map(devices2.map((d) => [d.id, d.name]));
    return snaps.map((s) => ({
      id: s.id,
      when: new Date(s.createdAt).toLocaleString(void 0, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      device: s.deviceId === selfId ? "This browser" : names.get(s.deviceId) ?? "A removed browser",
      tabs: plural(s.entryCount, "tab"),
      why: s.reason === "restore" ? "Taken before a restore" : "Taken before a change"
    }));
  }
  var SNAPSHOT_LIMIT = 6;
  function snapshotList(rows, expanded) {
    if (expanded || rows.length <= SNAPSHOT_LIMIT) return { rows, more: null };
    return { rows: rows.slice(0, SNAPSHOT_LIMIT), more: `Show all ${rows.length}` };
  }
  function snapshotsSummary(count) {
    return count === 0 ? "None yet" : plural(count, "snapshot");
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
      syncKey: null,
      keyVerified: false,
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

  // src/popup/popup.ts
  var $ = (id) => document.getElementById(id);
  var hero = $("hero");
  var pairView = $("pair-view");
  var mainView = $("main-view");
  var errorBox = $("error");
  var errorFixBtn = $("error-fix");
  var idChip = $("id-chip");
  var primaryBtn = $("primary");
  var syncNowBtn = $("sync-now");
  var pauseSwitch = $("pause");
  var pairLink = $("pair-link");
  var pairTarget = $("pair-target");
  var pairHint = Array.from(pairTarget.childNodes, (n) => n.cloneNode(true));
  var serverUrl = $("server-url");
  var deviceName = $("device-name");
  var pairCode = $("pair-code");
  var devicesSection = $("devices-section");
  var recoverSection = $("recover-section");
  var renameForm = $("rename-form");
  var renameInput = $("rename-input");
  var inviteLink = $("invite-link");
  var buttons = () => Array.from(document.querySelectorAll("button"));
  var busy = false;
  var reachable;
  var last = null;
  var devices = null;
  var devicesRequested = false;
  var snapshots = null;
  var showAllSnapshots = false;
  var errorKindShown = null;
  async function send(req) {
    try {
      return await chrome.runtime.sendMessage(req);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function showError(message, fix = null) {
    $("error-text").textContent = message ?? "";
    errorBox.hidden = !message;
    errorKindShown = message ? fix : null;
    errorFixBtn.hidden = !errorKindShown;
    errorFixBtn.textContent = fix === "grant" ? "Grant access" : fix === "retry" ? "Retry now" : "";
  }
  function renderHero(s) {
    const working = busy || s.running;
    const offline = s.paired && (reachable === false || !s.online);
    const v = heroView(s, { now: Date.now(), offline, working, devices });
    hero.dataset.tone = v.tone;
    hero.dataset.driver = v.driver;
    hero.dataset.working = String(working);
    $("relay-self").textContent = v.selfLabel;
    $("relay-other").textContent = v.otherLabel;
    $("hero-title").textContent = v.title;
    const detail = $("hero-detail");
    detail.textContent = v.detail;
    detail.title = s.paired && s.isOwner ? APPLIED_ELSEWHERE_NOTE : "";
    syncNowBtn.dataset.working = String(working);
  }
  function render(s) {
    last = s;
    if (s.reachable !== void 0) reachable = s.reachable;
    pairView.hidden = s.paired;
    mainView.hidden = !s.paired;
    idChip.hidden = !s.paired;
    renderHero(s);
    showError(s.lastError, errorFix(s));
    if (!s.paired) {
      devices = null;
      devicesRequested = false;
      snapshots = null;
      showAllSnapshots = false;
      if (!serverUrl.value) serverUrl.value = s.serverUrl;
      if (!deviceName.value) deviceName.value = s.deviceName;
      return;
    }
    const id = s.deviceId ?? "";
    $("id-chip-text").textContent = shortId(id);
    const blocked = busy || s.running;
    const action = primaryAction(s);
    primaryBtn.textContent = action.label;
    primaryBtn.title = action.title;
    primaryBtn.disabled = blocked;
    syncNowBtn.disabled = blocked || s.paused;
    const syncLabel = s.nextRetryAt !== null ? "Retry now" : "Sync now";
    syncNowBtn.title = syncLabel;
    syncNowBtn.setAttribute("aria-label", syncLabel);
    renderIdentity(s);
    renderSettings(s, blocked);
    if (!devicesRequested) {
      devicesRequested = true;
      void loadDevices(false);
    }
  }
  function renderIdentity(s) {
    const id = s.deviceId ?? "";
    $("self-name").textContent = s.deviceName;
    $("self-browser").textContent = browserLabel("safari");
    $("self-browser").title = s.pairedAt ? `Paired ${new Date(s.pairedAt).toLocaleString()}` : "";
    $("self-id").textContent = shortId(id);
    $("self-id").title = id;
  }
  function renderSettings(s, blocked) {
    pauseSwitch.setAttribute("aria-checked", String(!s.paused));
    pauseSwitch.title = s.paused ? "Resume sync" : "Pause sync";
    pauseSwitch.disabled = blocked;
    let host = s.serverUrl;
    try {
      host = new URL(s.serverUrl).host;
    } catch {
    }
    $("settings-summary").textContent = s.paused ? "Paused" : host;
    const server = $("self-server");
    server.textContent = s.serverUrl;
    server.title = `${s.serverUrl}
Revision ${s.lastRevision}` + (s.minRevision !== null ? `, server history from revision ${s.minRevision}` : "");
    $("encryption-row").hidden = !s.encrypted;
    $("last-activity").textContent = activityLine(s);
    $("last-result-row").hidden = !s.statusText;
    $("last-result").textContent = s.statusText ?? "";
  }
  function fill(list, items, empty) {
    if (items.length === 0) items = [el("li", "empty", empty)];
    list.replaceChildren(...items);
  }
  function row(title, meta, trailing, className = "") {
    const li = el("li", className);
    const main = el("div", "row-main");
    const metaLine = el("span", "row-meta");
    for (const part of meta) metaLine.append(typeof part === "string" ? el("span", "", part) : part);
    main.append(el("span", "row-title", title), metaLine);
    li.append(main);
    if (trailing) li.append(trailing);
    return li;
  }
  function renderDevices() {
    if (!devices) return;
    $("devices-summary").textContent = devicesSummary(devices);
    const rows = deviceRows(devices, Date.now()).filter((d) => !d.isSelf).map((d) => {
      const trailing = d.canRevoke ? confirmButton("Revoke", "Confirm revoke", () => void revoke(d.id), "text-btn danger") : el("span", "tag", "revoked");
      if (d.revokedNote) trailing.title = d.revokedNote;
      return row(d.name, [el("code", "", d.shortId), d.seen], trailing, d.revoked ? "revoked" : "");
    });
    fill($("devices"), rows, "No other browsers yet.");
    if (last) renderHero(last);
  }
  function copyText(text, source, label) {
    const original = label.textContent;
    const glyph = label.parentElement?.querySelector("use") ?? null;
    const glyphHref = glyph?.getAttribute("href") ?? "";
    const flash = (msg, done = false) => {
      label.textContent = msg;
      if (done) glyph?.setAttribute("href", "#i-check");
      setTimeout(() => {
        label.textContent = original;
        glyph?.setAttribute("href", glyphHref);
      }, 1500);
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
    navigator.clipboard.writeText(text).then(() => flash("Copied", true), select);
  }
  function setBusy(value) {
    busy = value;
    for (const b of buttons()) b.disabled = value;
    if (last) renderHero(last);
  }
  async function run(req) {
    setBusy(true);
    const res = await send(req);
    if (res.ok && req.type !== "getStatus") reachable = true;
    busy = false;
    for (const b of buttons()) b.disabled = false;
    if (res.status) render(res.status);
    else if (last) renderHero(last);
    if (!res.ok) showError(res.error);
    return res;
  }
  function confirmTwice(btn, armedLabel, action) {
    const label = btn.textContent ?? "";
    let timer = null;
    let armedAt = 0;
    const disarm = () => {
      timer = null;
      btn.textContent = label;
      delete btn.dataset.armed;
    };
    btn.addEventListener("click", () => {
      if (timer !== null && Date.now() - armedAt < 400) return;
      if (timer === null) {
        armedAt = Date.now();
        btn.textContent = armedLabel;
        btn.dataset.armed = "";
        timer = setTimeout(disarm, 4e3);
        return;
      }
      clearTimeout(timer);
      disarm();
      action();
    });
  }
  function confirmButton(label, armedLabel, action, className) {
    const b = el("button", className, label);
    b.type = "button";
    confirmTwice(b, armedLabel, action);
    return b;
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
  async function loadDevices(reportErrors = true) {
    const res = await send({ type: "listDevices" });
    if (!res.ok) {
      if (reportErrors) showError(res.error);
      return;
    }
    devices = res.devices ?? [];
    renderDevices();
  }
  async function loadSnapshots() {
    const [snaps, devs] = await Promise.all([send({ type: "listSnapshots" }), send({ type: "listDevices" })]);
    if (!snaps.ok) return showError(snaps.error);
    if (devs.ok) {
      devices = devs.devices ?? [];
      renderDevices();
    }
    snapshots = snaps.snapshots ?? [];
    renderSnapshots();
  }
  function renderSnapshots() {
    if (!snapshots) return;
    $("snapshots-summary").textContent = snapshotsSummary(snapshots.length);
    const view = snapshotList(snapshotRows(snapshots, last?.deviceId ?? null, devices ?? []), showAllSnapshots);
    const items = view.rows.map((r) => {
      let li;
      const restore = confirmButton(
        "Restore",
        "Confirm restore",
        () => {
          li.classList.add("restoring");
          void run({ type: "restoreSnapshot", id: r.id }).then(async (res) => {
            li.classList.remove("restoring");
            if (res.ok) await loadSnapshots();
          });
        },
        "btn small secondary"
      );
      li = row(r.when, [r.device, r.tabs], restore);
      li.title = r.why;
      return li;
    });
    if (view.more) {
      const more = el("button", "text-btn", view.more);
      more.type = "button";
      more.addEventListener("click", () => {
        showAllSnapshots = true;
        renderSnapshots();
      });
      const li = el("li", "more");
      li.append(more);
      items.push(li);
    }
    fill($("snapshots"), items, "No snapshots yet.");
  }
  async function revoke(id) {
    if ((await run({ type: "revokeDevice", id })).ok) await loadDevices();
  }
  function pairingTarget() {
    return resolvePairingForm({ link: pairLink.value, serverUrl: serverUrl.value, code: pairCode.value }, last?.serverUrl ?? "");
  }
  function showRename(open) {
    renameForm.hidden = !open;
    $("self-name-line").hidden = open;
    if (open) {
      renameInput.value = last?.deviceName ?? "";
      renameInput.focus();
      renameInput.select();
    } else {
      $("rename").focus();
    }
  }
  pairLink.addEventListener("input", () => {
    let host = "";
    try {
      host = new URL(pairingTarget().serverUrl).host;
    } catch {
    }
    if (host) pairTarget.textContent = `Pairs with ${host}`;
    else pairTarget.replaceChildren(...pairHint.map((n) => n.cloneNode(true)));
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
    if (!deviceName.value.trim()) return showError("Enter a name for this browser.");
    showError(null);
    const saved = saveState(storageLocal, {
      pendingPair: { ...target, deviceName: deviceName.value, createdAt: Date.now() },
      lastError: null
    });
    const granted = requestOrigin(target.serverUrl);
    void Promise.all([saved, granted]).then(async ([, ok]) => {
      if (!ok) {
        await saveState(storageLocal, { pendingPair: null });
        showError("Pairing needs access to the server, and access was not granted for this address.");
        return;
      }
      const res = await run({ type: "pair" });
      if (res.ok) pairLink.value = pairCode.value = "";
    });
  });
  primaryBtn.addEventListener("click", () => {
    if (last) void run({ type: primaryAction(last).request });
  });
  syncNowBtn.addEventListener("click", () => void run({ type: "syncNow" }));
  pauseSwitch.addEventListener("click", () => void run({ type: last?.paused ? "resume" : "pause" }));
  errorFixBtn.addEventListener("click", () => {
    if (errorKindShown === "retry") return void run({ type: "syncNow" });
    void requestOrigin(last?.serverUrl ?? "").then(async (ok) => {
      if (ok) await run({ type: "syncNow" });
    });
  });
  devicesSection.addEventListener("toggle", () => void (devicesSection.open && loadDevices()));
  recoverSection.addEventListener("toggle", () => void (recoverSection.open && loadSnapshots()));
  idChip.addEventListener("click", () => copyText(last?.deviceId ?? "", $("id-chip-text"), $("id-chip-text")));
  $("copy-id").addEventListener("click", () => copyText(last?.deviceId ?? "", $("self-id"), $("copy-id")));
  $("copy-link").addEventListener("click", () => copyText(inviteLink.value, inviteLink, $("copy-link").querySelector("span")));
  $("rename").addEventListener("click", () => showRename(true));
  $("rename-cancel").addEventListener("click", () => showRename(false));
  renameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      showRename(false);
    }
  });
  renameForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = renameInput.value.trim();
    if (!name) return showError("Enter a name for this browser.");
    void run({ type: "renameDevice", name }).then(async (res) => {
      if (!res.ok) return;
      showRename(false);
      await loadDevices();
    });
  });
  $("invite").addEventListener("click", async () => {
    const res = await run({ type: "createPairingCode" });
    if (!res.ok || !res.pairingCode) return;
    const { link, expiresAt } = res.pairingCode;
    inviteLink.value = link;
    $("invite-note").textContent = "This link contains your encryption key. Share it privately. It is valid 10 minutes. Paste it into the other browser's extension; do not open it as a page.";
    $("invite-note").title = `Valid until ${clock(Date.parse(expiresAt))}, single use.`;
    $("invite-box").hidden = false;
    inviteLink.focus();
    inviteLink.select();
  });
  confirmTwice(
    $("disconnect"),
    "Click again to disconnect. Pairing again gives this browser a new identity.",
    () => void run({ type: "disconnect" })
  );
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local" || busy) return;
    void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
  });
  setInterval(() => {
    if (last && !busy) renderHero(last);
  }, 1e3);
  void run({ type: "getStatus", refresh: true });
})();
