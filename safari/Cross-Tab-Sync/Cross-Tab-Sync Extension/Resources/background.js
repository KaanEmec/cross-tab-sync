"use strict";
(() => {
  // src/adapter/webext.ts
  function toTab(t) {
    if (t.id === void 0 || t.id < 0) return null;
    return {
      id: t.id,
      windowId: t.windowId,
      // Safari reports "" for sites the user has not granted access to: treat as no URL.
      url: t.url || void 0,
      pinned: Boolean(t.pinned),
      incognito: Boolean(t.incognito),
      index: t.index,
      active: Boolean(t.active),
      status: t.status
    };
  }
  function toWindow(w) {
    if (w.id === void 0 || w.id < 0) return null;
    return { id: w.id, type: w.type ?? "normal", incognito: Boolean(w.incognito), focused: Boolean(w.focused) };
  }
  function requireTab(t) {
    const tab = t ? toTab(t) : null;
    if (!tab) throw new Error("Browser did not return a tab");
    return tab;
  }
  function listen(event, cb) {
    event.addListener(cb);
    return () => event.removeListener(cb);
  }
  var storageLocal = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys)
  };
  function storageSession() {
    const area = chrome.storage.session;
    if (!area) return null;
    return {
      get: (keys) => area.get(keys),
      set: (items) => area.set(items),
      remove: (keys) => area.remove(keys)
    };
  }
  function createWebExtAdapter() {
    return {
      storage: storageLocal,
      sessionStorage: storageSession(),
      async queryTabs() {
        const tabs = await chrome.tabs.query({});
        return tabs.map(toTab).filter((t) => t !== null);
      },
      async getWindows() {
        const windows = await chrome.windows.getAll();
        return windows.map(toWindow).filter((w) => w !== null);
      },
      async getLastFocusedWindow() {
        let w;
        try {
          w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        } catch {
          w = await chrome.windows.getLastFocused();
        }
        const info = toWindow(w);
        return info && info.type === "normal" && !info.incognito ? info : null;
      },
      async createTab({ windowId, url, pinned }) {
        return requireTab(await chrome.tabs.create({ windowId, url, pinned: Boolean(pinned), active: false }));
      },
      async createWindow(url) {
        const w = await chrome.windows.create({ url, focused: false, type: "normal" });
        if (!w || w.id === void 0) throw new Error("Browser did not return a window");
        const first = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
        return { windowId: w.id, tab: requireTab(first) };
      },
      async updateTab(tabId, props) {
        const update = {};
        if (props.url !== void 0) update.url = props.url;
        if (props.pinned !== void 0) update.pinned = props.pinned;
        await chrome.tabs.update(tabId, update);
      },
      async removeTab(tabId) {
        await chrome.tabs.remove(tabId);
      },
      async hasHostPermission(pattern) {
        if (!chrome.permissions?.contains) return true;
        return chrome.permissions.contains({ origins: [pattern] });
      },
      async ensureAlarm(name, periodInMinutes) {
        const existing = await chrome.alarms.get(name).catch(() => void 0);
        if (!existing) await chrome.alarms.create(name, { periodInMinutes });
      },
      onAlarm: (cb) => listen(chrome.alarms.onAlarm, (alarm) => cb(alarm.name)),
      onTabCreated: (cb) => listen(chrome.tabs.onCreated, (t) => {
        const tab = toTab(t);
        if (tab) cb(tab);
      }),
      onTabRemoved: (cb) => listen(
        chrome.tabs.onRemoved,
        (tabId, info) => cb(tabId, info.isWindowClosing, info.windowId)
      ),
      onTabUpdated: (cb) => listen(chrome.tabs.onUpdated, (_id, change, t) => {
        const tab = toTab(t);
        if (tab) cb(tab, { url: change.url, status: change.status });
      }),
      onTabActivated: (cb) => listen(chrome.tabs.onActivated, (info) => cb(info.tabId, info.windowId)),
      onWindowFocusChanged: (cb) => listen(
        chrome.windows.onFocusChanged,
        (windowId) => cb(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId)
      ),
      onWindowRemoved: (cb) => listen(chrome.windows.onRemoved, (windowId) => cb(windowId)),
      onStartup: (cb) => listen(chrome.runtime.onStartup, () => cb())
    };
  }

  // src/core/client.ts
  var ApiError = class extends Error {
    status;
    code;
    body;
    constructor(status, code, message, body = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.body = body;
    }
    /** Owner carried by `409 owner_active` / `409 stale_owner`. */
    get owner() {
      const o = this.body["owner"];
      return o && typeof o === "object" ? o : null;
    }
  };
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
  var ApiClient = class {
    baseUrl;
    token;
    fetchImpl;
    timeoutMs;
    constructor(opts) {
      this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
      this.token = opts.token ?? null;
      this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
      this.timeoutMs = opts.timeoutMs ?? 15e3;
    }
    pair(body) {
      return this.request("POST", "/v1/pair", body, false);
    }
    createPairingCode() {
      return this.request("POST", "/v1/pairing-codes");
    }
    async devices() {
      const res = await this.request("GET", "/v1/devices");
      return res.devices;
    }
    async deleteDevice(id) {
      await this.request("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
    }
    session() {
      return this.request("GET", "/v1/session");
    }
    changes(since) {
      return this.request("GET", `/v1/session/changes?since=${encodeURIComponent(String(since))}`);
    }
    acquire(force) {
      return this.request("POST", "/v1/session/acquire", { force });
    }
    async release(generation) {
      await this.request("POST", "/v1/session/release", { generation });
    }
    async heartbeat(generation) {
      await this.request("POST", "/v1/session/heartbeat", { generation });
    }
    operations(body) {
      return this.request("POST", "/v1/session/operations", body);
    }
    merge(operations) {
      return this.request("POST", "/v1/session/merge", { operations });
    }
    async snapshots() {
      const res = await this.request("GET", "/v1/snapshots");
      return res.snapshots;
    }
    restoreSnapshot(id, generation) {
      return this.request("POST", `/v1/snapshots/${encodeURIComponent(String(id))}/restore`, { generation });
    }
    async request(method, path, body, auth = true) {
      const headers = { Accept: "application/json" };
      if (body !== void 0) headers["Content-Type"] = "application/json";
      if (auth) {
        if (!this.token) throw new ApiError(0, "unauthorized", "This device is not paired");
        headers["Authorization"] = `Bearer ${this.token}`;
      }
      let res;
      try {
        res = await this.fetchImpl(this.baseUrl + path, {
          method,
          headers,
          body: body === void 0 ? void 0 : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
          credentials: "omit"
        });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new ApiError(0, "network_error", timedOut ? "Server did not respond in time" : "Server is unreachable");
      }
      if (res.status === 204) return void 0;
      const text = await res.text().catch(() => "");
      let data = void 0;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = void 0;
        }
      }
      if (!res.ok) {
        const obj = data && typeof data === "object" ? data : {};
        const code = typeof obj["error"] === "string" ? obj["error"] : `http_${res.status}`;
        const message = typeof obj["message"] === "string" ? obj["message"] : `Request failed with status ${res.status}`;
        throw new ApiError(res.status, code, message, obj);
      }
      if (data === void 0) throw new ApiError(res.status, "invalid_response", "Server returned an invalid response");
      return data;
    }
  };

  // src/core/activity.ts
  var STARTUP_SUPPRESSION_MS = 1e4;
  var FRESH_IDLE_MS = 6e4;
  var TAKEOVER_INTERVAL_MS = 3e4;
  var ACTIVITY_WRITE_GRANULARITY_MS = 5e3;
  var RECENT_ACTIVITY_MS = 15e3;
  var within = (since, now, ms) => since !== null && now >= since && now - since < ms;
  function onActivity(s, ctx) {
    const { now } = ctx;
    if (within(s.startupAt, now, STARTUP_SUPPRESSION_MS)) return { patch: {}, counted: false, fresh: false, takeover: false };
    const idle = s.lastActivityAt === null || now - s.lastActivityAt >= FRESH_IDLE_MS;
    const fresh = idle || s.freshPending && !s.suppressAutoTakeover;
    const patch = {};
    if (fresh || !within(s.lastActivityAt, now, ACTIVITY_WRITE_GRANULARITY_MS)) patch.lastActivityAt = now;
    if (!fresh) return { patch, counted: true, fresh, takeover: false };
    if (s.suppressAutoTakeover) patch.suppressAutoTakeover = false;
    if (s.freshPending) patch.freshPending = false;
    if (ctx.isOwner) return { patch, counted: true, fresh, takeover: false };
    if (within(s.lastTakeoverAt, now, TAKEOVER_INTERVAL_MS)) {
      patch.freshPending = true;
      return { patch, counted: true, fresh, takeover: false };
    }
    patch.lastTakeoverAt = now;
    return { patch, counted: true, fresh, takeover: true };
  }
  function onDemoted(s, now) {
    if (!within(s.lastActivityAt, now, RECENT_ACTIVITY_MS)) return { patch: {}, takeover: false };
    if (within(s.lastTakeoverAt, now, TAKEOVER_INTERVAL_MS)) return { patch: { freshPending: true }, takeover: false };
    return { patch: { lastTakeoverAt: now, freshPending: false }, takeover: true };
  }

  // src/core/journal.ts
  function newOpId() {
    return crypto.randomUUID();
  }
  function append(journal, ops, now = /* @__PURE__ */ new Date(), meta = {}) {
    const known = new Set(journal.map((p) => p.op.opId));
    const added = ops.filter((op) => !known.has(op.opId)).map((op) => {
      const p = { op, queuedAt: now.toISOString() };
      const base = meta.bases?.[op.opId];
      if (base) p.base = base;
      if (meta.baseRevision !== void 0) p.baseRevision = meta.baseRevision;
      return p;
    });
    return [...journal, ...added];
  }
  function pendingChanges(journal, entryId) {
    return journal.filter((p) => p.op.entryId === entryId && (p.op.type === "navigate" || p.op.type === "open"));
  }
  function acknowledge(journal, opIds) {
    const acked = new Set(opIds);
    return journal.filter((p) => !acked.has(p.op.opId));
  }
  function list(journal) {
    return journal.map((p) => p.op);
  }
  function toMerge(journal) {
    return journal.map((p) => ({ ...p.op, baseRevision: p.baseRevision ?? 0 }));
  }
  function redirect(journal, from, to) {
    if (from === to || !journal.some((p) => p.op.entryId === from)) return journal;
    return journal.map((p) => p.op.entryId === from ? { ...p, op: { ...p.op, entryId: to } } : p);
  }
  function pendingEntryIds(journal) {
    return new Set(journal.filter((p) => p.op.type === "open").map((p) => p.op.entryId));
  }
  var MAX_BATCH_OPS = 500;
  var MAX_BATCH_BYTES = 60 * 1024;
  var encoder = new TextEncoder();
  function batches(ops, maxOps = MAX_BATCH_OPS, maxBytes = MAX_BATCH_BYTES) {
    const out = [];
    let current = [];
    let bytes = 0;
    for (const op of ops) {
      const size = encoder.encode(JSON.stringify(op)).length + 1;
      if (current.length > 0 && (current.length >= maxOps || bytes + size > maxBytes)) {
        out.push(current);
        current = [];
        bytes = 0;
      }
      current.push(op);
      bytes += size;
    }
    if (current.length > 0) out.push(current);
    return out;
  }

  // src/core/mapping.ts
  function serverUrl(m) {
    return m.base ?? m.url;
  }
  function emptyMappings() {
    return { tabs: {}, urlCounts: {} };
  }
  function countUrls(tabs) {
    const counts = {};
    for (const t of tabs) counts[t.url] = (counts[t.url] ?? 0) + 1;
    return counts;
  }
  function tabsForEntry(m, entryId) {
    return Object.entries(m.tabs).filter(([, v]) => v.entryId === entryId).map(([k]) => Number(k));
  }
  function setMapping(m, tabId, entryId, url) {
    return { ...m, tabs: { ...m.tabs, [String(tabId)]: { entryId, url } } };
  }
  function removeMappings(m, tabIds) {
    const tabs = { ...m.tabs };
    for (const id of tabIds) delete tabs[String(id)];
    return { ...m, tabs };
  }
  function remapEntry(m, from, to, url) {
    if (from === to && url === void 0) return m;
    const tabs = {};
    for (const [k, v] of Object.entries(m.tabs)) {
      tabs[k] = v.entryId === from ? { entryId: to, url: url ?? v.url } : v;
    }
    return { ...m, tabs };
  }
  function claimByUrl(stored, tabs, base = emptyMappings()) {
    const claimed = new Set(Object.keys(base.tabs).map(Number));
    let m = base;
    const rest = {};
    for (const [key, old] of Object.entries(stored.tabs)) {
      const tab = tabs.find((t) => t.url === old.url && !claimed.has(t.id));
      if (!tab) {
        rest[key] = old;
        continue;
      }
      claimed.add(tab.id);
      m = { ...m, tabs: { ...m.tabs, [String(tab.id)]: old } };
    }
    return { mappings: m, rest: Object.keys(rest).length > 0 ? { ...stored, tabs: rest } : null };
  }
  function reconcileMappings(m, allTabs) {
    const present = new Set(allTabs.map((t) => String(t.id)));
    const tabs = {};
    for (const [k, v] of Object.entries(m.tabs)) if (present.has(k)) tabs[k] = v;
    return { ...m, tabs };
  }

  // src/core/changes.ts
  var EXPECT_TTL_MS = 3e4;
  var LOAD_GRACE_MS = 1e4;
  var CLOSE_HOLD_MS = 2e3;
  var BURST_REMOVALS = 3;
  var STARTUP_GRACE_MS = 1e4;
  var STALE_MAPPINGS_TTL_MS = 6e4;
  function inStartupGrace(startupAt, now, windowMs = STARTUP_GRACE_MS) {
    return startupAt !== null && now >= startupAt && now - startupAt < windowMs;
  }
  function sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  }
  function pruneExpected(expected, now) {
    const kept = expected.filter((e) => e.until > now);
    return kept.length === expected.length ? expected : kept;
  }
  function expectLoads(expected, tabIds, now, until) {
    const ids = new Set(tabIds);
    const others = pruneExpected(expected, now).filter((e) => !(e.kind === "load" && ids.has(e.tabId)));
    return [...others, ...[...ids].map((tabId) => ({ kind: "load", tabId, until }))];
  }
  var Draft = class {
    constructor(s, ctx) {
      this.s = s;
      this.ctx = ctx;
      const expected = pruneExpected(s.expected, ctx.now);
      if (expected !== s.expected) this.set("expected", expected);
      if (s.staleMappings && !inStartupGrace(s.startupAt, ctx.now, STALE_MAPPINGS_TTL_MS)) this.set("staleMappings", null);
      const staleDetached = Object.keys(s.detached).filter((k) => k.startsWith("stale-"));
      if (staleDetached.length > 0 && !inStartupGrace(s.startupAt, ctx.now, STALE_MAPPINGS_TTL_MS)) {
        const detached = { ...s.detached };
        for (const k of staleDetached) delete detached[k];
        this.set("detached", detached);
      }
    }
    s;
    ctx;
    changed = /* @__PURE__ */ new Set();
    ops = [];
    /** Server URL before each journaled `navigate`, by opId. */
    bases = {};
    set(key, value) {
      this.s = { ...this.s, [key]: value };
      this.changed.add(key);
    }
    map(tabId, entryId, url) {
      this.set("mappings", setMapping(this.s.mappings, tabId, entryId, url));
    }
    unmap(tabId) {
      this.set("mappings", removeMappings(this.s.mappings, [tabId]));
    }
    undetach(key) {
      if (this.s.detached[key] === void 0) return;
      const detached = { ...this.s.detached };
      delete detached[key];
      this.set("detached", detached);
    }
    /** Remove and return the first expectation matching `pred`. */
    take(pred) {
      const i = this.s.expected.findIndex(pred);
      if (i < 0) return void 0;
      const e = this.s.expected[i];
      this.set("expected", this.s.expected.filter((_, j) => j !== i));
      return e;
    }
    expect(e) {
      this.set("expected", [...this.s.expected, e]);
    }
    done(activity) {
      if (this.ops.length > 0) {
        const meta = { bases: this.bases, baseRevision: this.s.lastRevision ?? 0 };
        this.set("pending", append(this.s.pending, this.ops, new Date(this.ctx.now), meta));
      }
      const patch = {};
      for (const k of this.changed) patch[k] = this.s[k];
      return { patch, ops: this.ops, activity };
    }
  };
  function mappedTabWithUrl(m, url, exceptTabId) {
    for (const [k, v] of Object.entries(m.tabs)) if (v.url === url && Number(k) !== exceptTabId) return v;
    return void 0;
  }
  function takeCreate(d, tab) {
    const exp = d.take((e) => e.kind === "create" && e.url === tab.url);
    if (!exp || exp.kind !== "create") return false;
    d.map(tab.id, exp.entryId, tab.url);
    d.expect({ kind: "load", tabId: tab.id, until: d.ctx.now + EXPECT_TTL_MS });
    return true;
  }
  function addition(d, tab) {
    const stale = d.s.staleMappings;
    const old = stale && Object.entries(stale.tabs).find(([, v]) => v.url === tab.url);
    if (stale && old) {
      const tabs = { ...stale.tabs };
      delete tabs[old[0]];
      d.set("staleMappings", Object.keys(tabs).length > 0 ? { ...stale, tabs } : null);
      d.map(tab.id, old[1].entryId, tab.url);
      return true;
    }
    const staleDetached = Object.entries(d.s.detached).find(([k, url]) => k.startsWith("stale-") && url === tab.url);
    if (staleDetached) {
      const detached = { ...d.s.detached, [String(tab.id)]: tab.url };
      delete detached[staleDetached[0]];
      d.set("detached", detached);
      return true;
    }
    const existing = mappedTabWithUrl(d.s.mappings, tab.url);
    if (existing) {
      d.map(tab.id, existing.entryId, tab.url);
      return false;
    }
    const entryId = d.ctx.newId();
    d.ops.push({ opId: d.ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
    d.map(tab.id, entryId, tab.url);
    return false;
  }
  function recordCreated(s, tab, ctx) {
    const d = new Draft(s, ctx);
    if (d.s.mappings.tabs[String(tab.id)]) return d.done(false);
    if (!tab.eligible || !tab.url) return d.done(false);
    const withUrl = { ...tab, url: tab.url };
    if (takeCreate(d, withUrl)) return d.done(false);
    return d.done(!addition(d, withUrl));
  }
  function recordUpdated(s, tab, ctx) {
    const d = new Draft(s, ctx);
    const key = String(tab.id);
    const mapped = d.s.mappings.tabs[key];
    const load = d.s.expected.find((e) => e.kind === "load" && e.tabId === tab.id);
    if (load) {
      if (load.kind === "load" && !load.completed) {
        const settled = { ...load, completed: true, until: ctx.now + LOAD_GRACE_MS };
        d.set("expected", d.s.expected.map((e) => e === load ? settled : e));
      }
      if (mapped && tab.eligible && tab.url && tab.url !== mapped.url) {
        const base = serverUrl(mapped);
        const tabs = { ...d.s.mappings.tabs, [key]: tab.url === base ? { entryId: mapped.entryId, url: base } : { entryId: mapped.entryId, url: tab.url, base } };
        d.set("mappings", { ...d.s.mappings, tabs });
      }
      return d.done(false);
    }
    if (!tab.eligible || !tab.url) return d.done(false);
    const withUrl = { ...tab, url: tab.url };
    const detachedUrl = d.s.detached[key];
    if (detachedUrl !== void 0) {
      if (sameOrigin(detachedUrl, tab.url)) {
        if (detachedUrl !== tab.url) d.set("detached", { ...d.s.detached, [key]: tab.url });
        return d.done(false);
      }
      d.undetach(key);
      addition(d, withUrl);
      return d.done(false);
    }
    if (!mapped) {
      if (!takeCreate(d, withUrl)) addition(d, withUrl);
      return d.done(false);
    }
    if (mapped.url === tab.url) return d.done(false);
    const copies = tabsForEntry(d.s.mappings, mapped.entryId);
    const dest = mappedTabWithUrl(d.s.mappings, tab.url, tab.id);
    if (dest && dest.entryId !== mapped.entryId) {
      d.map(tab.id, dest.entryId, tab.url);
      if (copies.length === 1) d.ops.push({ opId: ctx.newId(), type: "close", entryId: mapped.entryId });
    } else if (copies.length === 1) {
      const opId = ctx.newId();
      d.ops.push({ opId, type: "navigate", entryId: mapped.entryId, url: tab.url });
      d.bases[opId] = serverUrl(mapped);
      d.map(tab.id, mapped.entryId, tab.url);
    } else {
      const entryId = ctx.newId();
      d.ops.push({ opId: ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
      d.map(tab.id, entryId, tab.url);
    }
    return d.done(false);
  }
  function recordRemoved(s, tabId, windowClosing, windowId, ctx) {
    const d = new Draft(s, ctx);
    const ours = d.take((e) => e.kind === "remove" && e.tabId === tabId) !== void 0;
    d.take((e) => e.kind === "load" && e.tabId === tabId);
    d.undetach(String(tabId));
    const mapped = d.s.mappings.tabs[String(tabId)];
    if (!mapped) return d.done(false);
    d.unmap(tabId);
    if (ours || windowClosing || inStartupGrace(d.s.startupAt, ctx.now)) return d.done(false);
    const recent = d.s.heldCloses.filter((h) => !h.done || ctx.now - h.at < 2 * CLOSE_HOLD_MS);
    d.set("heldCloses", [...recent, { entryId: mapped.entryId, tabId, windowId, at: ctx.now }]);
    return d.done(false);
  }
  function recordWindowRemoved(s, windowId, ctx) {
    const d = new Draft(s, ctx);
    d.set("removedWindows", { ...d.s.removedWindows, [String(windowId)]: ctx.now });
    return d.done(false);
  }
  function releaseHeld(s, aliveWindows, ctx) {
    const d = new Draft(s, ctx);
    const held = d.s.heldCloses;
    const due = held.filter((h) => !h.done && ctx.now - h.at >= CLOSE_HOLD_MS);
    const waiting = held.some((h) => !h.done && ctx.now - h.at < CLOSE_HOLD_MS);
    const kept = held.filter((h) => ctx.now - h.at < 2 * CLOSE_HOLD_MS || !h.done && !due.includes(h)).map((h) => due.includes(h) ? { ...h, done: true } : h);
    if (due.length > 0 || kept.length !== held.length) d.set("heldCloses", kept);
    const closed = /* @__PURE__ */ new Set();
    for (const h of due) {
      const burst = held.filter((o) => o.windowId === h.windowId && Math.abs(o.at - h.at) < CLOSE_HOLD_MS);
      const windowClosing = burst.length >= BURST_REMOVALS && burst.some((o) => o.entryId !== h.entryId);
      const windowGone = !aliveWindows.has(h.windowId) || d.s.removedWindows[String(h.windowId)] !== void 0;
      if (windowGone || windowClosing || closed.has(h.entryId)) continue;
      if (tabsForEntry(d.s.mappings, h.entryId).length > 0) continue;
      closed.add(h.entryId);
      d.ops.push({ opId: ctx.newId(), type: "close", entryId: h.entryId });
    }
    const recent = Object.entries(d.s.removedWindows).filter(([, at]) => ctx.now - at < EXPECT_TTL_MS);
    if (recent.length !== Object.keys(d.s.removedWindows).length) d.set("removedWindows", Object.fromEntries(recent));
    return { ...d.done(false), waiting };
  }

  // src/core/eligibility.ts
  var MAX_URL_BYTES = 2048;
  var encoder2 = new TextEncoder();
  var BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
  function isShareableUrl(url) {
    if (!url) return false;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
    if (BAD_ESCAPE.test(url)) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (!parsed.hostname) return false;
    } catch {
      return false;
    }
    return encoder2.encode(url).length <= MAX_URL_BYTES;
  }
  function eligibleTabs(tabs, windows) {
    const normal = new Set(windows.filter((w) => w.type === "normal" && !w.incognito).map((w) => w.id));
    return tabs.filter((t) => !t.incognito && normal.has(t.windowId) && isShareableUrl(t.url)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
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
      minRevision: null
    };
  }
  var PREFIX = "cts.";
  var KEYS = Object.keys(defaultState());
  async function loadState(storage) {
    const raw = await storage.get(KEYS.map((k) => PREFIX + k));
    const state = defaultState();
    for (const k of KEYS) {
      const v = raw[PREFIX + k];
      if (v !== void 0) state[k] = v;
    }
    return state;
  }
  async function saveState(storage, patch) {
    const items = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== void 0) items[PREFIX + k] = v;
    }
    if (patch.pending) items[PREFIX + "pendingCount"] = patch.pending.length;
    if (Object.keys(items).length > 0) await storage.set(items);
  }
  function isPaired(s) {
    return Boolean(s.token && s.deviceId && s.serverUrl);
  }
  function clearedCredentials() {
    return {
      deviceId: null,
      token: null,
      lastRevision: 0,
      generation: null,
      owner: null,
      mappings: emptyMappings(),
      staleMappings: null,
      pending: [],
      expected: [],
      detached: {},
      lastTakeoverAt: null,
      suppressAutoTakeover: false,
      freshPending: false,
      heldCloses: [],
      removedWindows: {},
      online: true,
      nextRetryAt: null,
      retryAttempts: 0,
      paused: false,
      minRevision: null,
      errorKind: null
    };
  }
  var RUN_LOCK_TTL_MS = 2 * 60 * 1e3;
  function isLocked(s, now) {
    return s.runLock !== null && now - s.runLock.startedAt < RUN_LOCK_TTL_MS;
  }

  // src/core/status.ts
  var RETRY_BASE_MS = 3e4;
  var RETRY_MAX_MS = 5 * 6e4;
  function retryDelay(attempt) {
    return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
  }
  function isRetryableKind(kind) {
    return kind === "unreachable" || kind === "server" || kind === "permission";
  }
  function isRetryable(e) {
    return e instanceof ApiError && (e.code === "network_error" || e.status >= 500);
  }
  function classify(e, hasPermission2) {
    if (!(e instanceof ApiError)) return null;
    if (e.code === "device_revoked") return "device_revoked";
    if (e.code === "unauthorized" && e.status === 401) return "unauthorized";
    if (e.code === "network_error") return hasPermission2 ? "unreachable" : "permission";
    if (e.status >= 500) return "server";
    return null;
  }
  function hostOf(serverUrl2) {
    try {
      return new URL(serverUrl2).origin;
    } catch {
      return serverUrl2;
    }
  }
  function errorMessage(kind, serverUrl2, status = 0) {
    switch (kind) {
      case "device_revoked":
        return "This device was revoked on the server. Pair it again.";
      case "unauthorized":
        return "The server does not accept this device's credentials. Disconnect, then pair again with a new code.";
      case "permission":
        return `Grant access to ${hostOf(serverUrl2)} in the extension's site permissions.`;
      case "unreachable":
        return `Cannot reach ${hostOf(serverUrl2)}. Check the connection or the server; changes are kept and retried.`;
      case "server":
        return `The server failed${status ? ` (HTTP ${status})` : ""}. Changes are kept and retried.`;
    }
  }
  function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function syncSummary(f) {
    const n = f.pendingCount;
    const waiting = `${n} change${n === 1 ? "" : "s"} waiting`;
    if (f.paused) return n > 0 ? `Paused, ${waiting}` : "Paused";
    const retry = f.nextRetryAt !== null ? `retrying at ${clock(f.nextRetryAt)}` : null;
    const why = [f.online ? null : "offline", retry].filter(Boolean).join(", ");
    if (n > 0) return why ? `${waiting} (${why})` : waiting;
    if (!f.online) return retry ? `Offline (${retry})` : "Offline";
    return f.lastSuccessAt ? "Saved to server" : "Not synced yet";
  }

  // src/core/store.ts
  var Store = class _Store {
    constructor(deps2, s) {
      this.deps = deps2;
      this.s = s;
    }
    deps;
    s;
    static async open(deps2) {
      return new _Store(deps2, await loadState(deps2.adapter.storage));
    }
    async set(patch) {
      this.s = { ...this.s, ...patch };
      await saveState(this.deps.adapter.storage, patch);
    }
  };
  var nowDate = (deps2) => deps2.now ? deps2.now() : /* @__PURE__ */ new Date();
  var nowIso = (deps2) => nowDate(deps2).toISOString();
  var nowMs = (deps2) => nowDate(deps2).getTime();
  var idGen = (deps2) => deps2.newId ?? newOpId;
  function apiFor(deps2, s) {
    return deps2.api({ baseUrl: s.serverUrl, token: s.token });
  }
  function requirePaired(s) {
    if (!isPaired(s)) throw new Error("This device is not paired");
  }
  function ownerLabel(o) {
    return o ? `${o.name} (generation ${o.generation})` : "another device";
  }
  function isStaleOwner(e) {
    return e instanceof ApiError && e.code === "stale_owner";
  }
  async function demote(store, e, sentGeneration) {
    const persisted = (await loadState(store.deps.adapter.storage)).generation;
    if (sentGeneration !== void 0 && persisted !== sentGeneration) return false;
    const owner = e.owner;
    await store.set({
      generation: null,
      owner,
      freshPending: true,
      statusText: `Not the owner: ${ownerLabel(owner)} took over. Use Continue here to take control.`,
      // Routine in automatic mode: not an error. A manual action that failed reports it itself.
      lastError: null
    });
    return true;
  }
  function succeeded(deps2) {
    return { lastSuccessAt: nowIso(deps2), online: true, nextRetryAt: null, retryAttempts: 0, errorKind: null };
  }
  async function hasPermission(deps2, serverUrl2) {
    const pattern = originPattern(serverUrl2);
    if (!pattern || !deps2.adapter.hasHostPermission) return true;
    return deps2.adapter.hasHostPermission(pattern).catch(() => true);
  }
  async function fail(store, e, sentGeneration) {
    if (isStaleOwner(e)) {
      await demote(store, e, sentGeneration);
      throw e;
    }
    const kind = classify(e, e instanceof ApiError && e.code === "network_error" ? await hasPermission(store.deps, store.s.serverUrl) : true);
    const message = kind ? errorMessage(kind, store.s.serverUrl, e instanceof ApiError ? e.status : 0) : null;
    if (kind === "device_revoked") {
      await store.set({ ...clearedCredentials(), statusText: "Disconnected", lastError: message, errorKind: kind });
    } else if (isRetryable(e)) {
      const retryAttempts = store.s.retryAttempts + 1;
      await store.set({
        online: false,
        retryAttempts,
        nextRetryAt: nowMs(store.deps) + retryDelay(retryAttempts),
        errorKind: kind,
        lastError: message
      });
    } else if (e instanceof ApiError && e.status > 0) {
      await store.set({ online: true, nextRetryAt: null, retryAttempts: 0, errorKind: kind, lastError: message ?? e.message });
    } else {
      await store.set({ lastError: message ?? (e instanceof Error ? e.message : String(e)) });
    }
    throw e;
  }

  // src/core/apply.ts
  async function captureTabs(adapter2) {
    const [all, windows] = await Promise.all([adapter2.queryTabs(), adapter2.getWindows()]);
    return { all, eligible: eligibleTabs(all, windows) };
  }
  function pendingClosedIds(journal) {
    return new Set(journal.filter((p) => p.op.type === "close").map((p) => p.op.entryId));
  }
  function reconcileDetached(detached, all, eligible, mappings, live) {
    const present = new Set(all.map((t) => String(t.id)));
    const out = {};
    const stale = [];
    for (const [k, url] of Object.entries(detached)) {
      if (k.startsWith("stale-")) stale.push(url);
      else if (present.has(k)) out[k] = url;
    }
    stale.forEach((url, i) => {
      const tab = eligible.find((t) => t.url === url && !mappings.tabs[String(t.id)] && out[String(t.id)] === void 0);
      if (tab) out[String(tab.id)] = url;
      else if (live) out[`stale-${i}`] = url;
    });
    return out;
  }
  async function currentMappings(store, all, eligible) {
    const live = inStartupGrace(store.s.startupAt, nowMs(store.deps), STALE_MAPPINGS_TTL_MS);
    let mappings = reconcileMappings(store.s.mappings, all);
    let staleMappings = null;
    if (store.s.staleMappings) {
      const r = claimByUrl(store.s.staleMappings, eligible, mappings);
      mappings = r.mappings;
      staleMappings = live ? r.rest : null;
    }
    const detached = reconcileDetached(store.s.detached, all, eligible, mappings, live);
    await store.set({ mappings, staleMappings, detached });
    return mappings;
  }
  async function resolveReceivingWindow(adapter2, persisted) {
    const windows = (await adapter2.getWindows()).filter((w) => w.type === "normal" && !w.incognito);
    const ids = new Set(windows.map((w) => w.id));
    const last = await adapter2.getLastFocusedWindow().catch(() => null);
    if (last && ids.has(last.id)) return last.id;
    if (persisted !== null && ids.has(persisted)) return persisted;
    return windows[0]?.id ?? null;
  }
  var expiry = (store) => nowMs(store.deps) + EXPECT_TTL_MS;
  function forkEntry(mappings, pending, entryId, newId, now, baseRevision = 0) {
    const copies = tabsForEntry(mappings, entryId);
    const first = mappings.tabs[String(copies[0])];
    if (!first) return null;
    const changes = new Set(pendingChanges(pending, entryId));
    const fresh = newId();
    return {
      mappings: remapEntry(mappings, entryId, fresh, first.url),
      pending: append(
        pending.filter((p) => !changes.has(p)),
        [{ opId: newId(), type: "open", entryId: fresh, url: first.url }],
        now,
        { baseRevision }
      )
    };
  }
  function pendingBase(pending, entryId) {
    const p = pendingChanges(pending, entryId)[0];
    if (!p) return void 0;
    return p.op.type === "open" ? p.op.url : p.base;
  }
  async function createTabs(store, items) {
    if (items.length === 0) return { created: 0, failed: 0 };
    const { adapter: adapter2 } = store.deps;
    const until = expiry(store);
    await store.set({
      expected: [
        ...pruneExpected(store.s.expected, nowMs(store.deps)),
        ...items.map((i) => ({ kind: "create", url: i.url, entryId: i.entryId, until }))
      ]
    });
    let windowId = await resolveReceivingWindow(adapter2, store.s.receivingWindowId);
    let created = 0;
    let failed = 0;
    for (const item of items) {
      const others = (e) => !(e.kind === "create" && e.entryId === item.entryId);
      const { eligible } = await captureTabs(adapter2);
      const same = eligible.filter((t) => t.url === item.url);
      if (same.length > 0) {
        let mappings = store.s.mappings;
        const detached = { ...store.s.detached };
        for (const t of same) {
          if (mappings.tabs[String(t.id)]) continue;
          mappings = setMapping(mappings, t.id, item.entryId, item.url);
          delete detached[String(t.id)];
        }
        await store.set({ mappings, detached, expected: store.s.expected.filter(others) });
        continue;
      }
      try {
        let tab;
        if (windowId === null) {
          const w = await adapter2.createWindow(item.url);
          windowId = w.windowId;
          tab = w.tab;
          if (item.pinned) await adapter2.updateTab(tab.id, { pinned: true });
        } else {
          tab = await adapter2.createTab({ windowId, url: item.url, pinned: item.pinned });
        }
        await store.set({
          mappings: setMapping(store.s.mappings, tab.id, item.entryId, item.url),
          receivingWindowId: windowId,
          expected: [...store.s.expected.filter(others), { kind: "load", tabId: tab.id, until: expiry(store), created: true }]
        });
        created++;
      } catch {
        failed++;
        await store.set({ expected: store.s.expected.filter(others) });
      }
    }
    return { created, failed };
  }
  function applyResults(mappings, ops, results) {
    const byId = new Map(ops.map((op) => [op.opId, op]));
    let m = mappings;
    for (const r of results) {
      const op = byId.get(r.opId);
      if (!op || r.status !== "coalesced" && r.status !== "forked" || !r.entryId || r.entryId === op.entryId) continue;
      m = remapEntry(m, op.entryId, r.entryId);
    }
    return m;
  }
  async function applyRemote(store, ops, sentNavigated = /* @__PURE__ */ new Set(), revive = /* @__PURE__ */ new Set()) {
    const foreign = ops.filter((l) => l.deviceId !== store.s.deviceId && l.result.status !== "ignored").sort((a, b) => a.seq - b.seq);
    if (foreign.length === 0) return;
    const { adapter: adapter2 } = store.deps;
    const { all, eligible } = await captureTabs(adapter2);
    let mappings = await currentMappings(store, all, eligible);
    let pending = store.s.pending;
    const newId = idGen(store.deps);
    const base = store.s.lastRevision;
    const detached = { ...store.s.detached };
    const byId = new Map(all.map((t) => [t.id, t]));
    const loading = (id) => store.s.expected.some((e) => e.kind === "load" && e.tabId === id);
    const toCreate = [];
    const navigateTo = /* @__PURE__ */ new Map();
    const remove = /* @__PURE__ */ new Set();
    const pin = /* @__PURE__ */ new Map();
    const urlOf = (id) => navigateTo.get(id) ?? byId.get(id)?.url ?? mappings.tabs[String(id)]?.url;
    const localWithUrl = (url, except = []) => eligible.filter((t) => !remove.has(t.id) && !except.includes(t.id) && urlOf(t.id) === url);
    const adopt = (tabs, entryId, url) => {
      for (const t of tabs) {
        if (mappings.tabs[String(t.id)]) continue;
        mappings = setMapping(mappings, t.id, entryId, url);
        delete detached[String(t.id)];
      }
    };
    const fork = (entryId) => {
      const f = forkEntry(mappings, pending, entryId, newId, nowDate(store.deps), base);
      if (!f) return false;
      ({ mappings, pending } = f);
      return true;
    };
    const ensureTab = (entryId, url) => {
      const dest = localWithUrl(url);
      if (dest.length > 0) adopt(dest, entryId, url);
      else if (!toCreate.some((c) => c.entryId === entryId)) toCreate.push({ entryId, url, pinned: false });
    };
    const dropTab = (id) => {
      const url = urlOf(id);
      mappings = removeMappings(mappings, [id]);
      navigateTo.delete(id);
      if (byId.get(id)?.active) {
        if (url) detached[String(id)] = url;
      } else {
        remove.add(id);
      }
    };
    for (const { op, result } of foreign) {
      const target = result.entryId ?? op.entryId;
      switch (op.type) {
        case "open": {
          if (target !== op.entryId) mappings = remapEntry(mappings, op.entryId, target);
          if (tabsForEntry(mappings, target).length > 0 || toCreate.some((c) => c.entryId === target)) break;
          const local = localWithUrl(op.url);
          if (local.length > 0) adopt(local, target, op.url);
          else toCreate.push({ entryId: target, url: op.url, pinned: op.pinned ?? false });
          break;
        }
        case "navigate": {
          const copies = tabsForEntry(mappings, op.entryId).filter((id) => !remove.has(id));
          const localUrl = mappings.tabs[String(copies[0])]?.url;
          if (copies.length === 0 && revive.has(op.entryId) && !toCreate.some((c) => c.entryId === op.entryId)) {
            ensureTab(target, op.url);
            break;
          }
          if (copies.length > 0 && localUrl !== op.url && sentNavigated.has(op.entryId)) {
            const fresh = newId();
            pending = append(pending, [{ opId: newId(), type: "open", entryId: fresh, url: op.url }], nowDate(store.deps), { baseRevision: base });
            ensureTab(fresh, op.url);
            break;
          }
          if (localUrl !== op.url && pendingChanges(pending, op.entryId).length > 0 && fork(op.entryId)) {
            ensureTab(target, op.url);
            break;
          }
          const planned = toCreate.find((c) => c.entryId === op.entryId);
          if (planned) Object.assign(planned, { entryId: target, url: op.url });
          const dest = localWithUrl(op.url, copies);
          mappings = remapEntry(mappings, op.entryId, target, op.url);
          if (dest.length > 0) {
            for (const id of copies) {
              if (byId.get(id)?.active) navigateTo.set(id, op.url);
              else dropTab(id);
            }
            adopt(dest, target, op.url);
            if (planned) toCreate.splice(toCreate.indexOf(planned), 1);
          } else {
            for (const id of copies) if (urlOf(id) !== op.url) navigateTo.set(id, op.url);
          }
          break;
        }
        case "close": {
          const i = toCreate.findIndex((c) => c.entryId === op.entryId);
          if (i >= 0) toCreate.splice(i, 1);
          if (pendingChanges(pending, op.entryId).length > 0 && fork(op.entryId)) break;
          for (const id of tabsForEntry(mappings, op.entryId)) {
            const live = byId.get(id)?.url;
            const m = mappings.tabs[String(id)];
            if (live !== void 0 && live !== m.url && !loading(id)) {
              mappings = removeMappings(mappings, [id]);
              detached[String(id)] = m.url;
            } else {
              dropTab(id);
            }
          }
          break;
        }
        case "update": {
          if (op.pinned === void 0) break;
          for (const id of tabsForEntry(mappings, op.entryId)) pin.set(id, op.pinned);
          const planned = toCreate.find((c) => c.entryId === op.entryId);
          if (planned) planned.pinned = op.pinned;
          break;
        }
      }
    }
    const now = await adapter2.queryTabs();
    const current = new Map(now.map((t) => [t.id, t]));
    for (const id of [...remove]) {
      const t = current.get(id);
      if (!t) remove.delete(id);
      else if (t.active) {
        remove.delete(id);
        if (t.url) detached[String(id)] = t.url;
      }
    }
    for (const id of [...navigateTo.keys()]) if (!current.has(id) || remove.has(id)) navigateTo.delete(id);
    const until = expiry(store);
    const expected = [
      ...expectLoads(store.s.expected, navigateTo.keys(), nowMs(store.deps), until),
      ...[...remove].map((tabId) => ({ kind: "remove", tabId, until }))
    ];
    await store.set({ mappings, detached, expected, pending });
    for (const [id, url] of navigateTo) await adapter2.updateTab(id, { url }).catch(() => void 0);
    for (const id of remove) await adapter2.removeTab(id).catch(() => void 0);
    for (const [id, pinned] of pin) {
      const t = current.get(id);
      if (t && !remove.has(id) && t.pinned !== pinned) await adapter2.updateTab(id, { pinned }).catch(() => void 0);
    }
    await createTabs(store, toCreate);
  }

  // src/core/plan.ts
  function plan(input) {
    const { entries, tabs, pendingEntries, newId } = input;
    let mappings = input.mappings;
    const eligibleById = new Map(tabs.map((t) => [t.id, t]));
    if (entries) {
      const byId = new Set(entries.map((e) => e.id));
      const sessionUrls = new Set(entries.map((e) => e.url));
      const drop = [];
      for (const [key, m] of Object.entries(mappings.tabs)) {
        const tab = eligibleById.get(Number(key));
        if (!tab || byId.has(m.entryId)) continue;
        if (!pendingEntries.has(m.entryId) || sessionUrls.has(tab.url)) drop.push(tab.id);
      }
      mappings = removeMappings(mappings, drop);
    }
    const isMapped = (tabId) => mappings.tabs[String(tabId)] !== void 0;
    const create = [];
    const urlToEntry = /* @__PURE__ */ new Map();
    if (entries) {
      const mappedEntries = new Set(Object.values(mappings.tabs).map((m) => m.entryId));
      for (const entry of entries) {
        if (!urlToEntry.has(entry.url)) urlToEntry.set(entry.url, entry.id);
        if (mappedEntries.has(entry.id)) continue;
        const reuse = tabs.filter((t) => t.url === entry.url && !isMapped(t.id));
        if (reuse.length === 0) {
          create.push({ entryId: entry.id, url: entry.url, pinned: entry.pinned });
        } else {
          for (const t of reuse) mappings = setMapping(mappings, t.id, entry.id, entry.url);
        }
        mappedEntries.add(entry.id);
      }
    }
    for (const m of Object.values(mappings.tabs)) if (!urlToEntry.has(m.url)) urlToEntry.set(m.url, m.entryId);
    const open = [];
    tabs.forEach((tab, position) => {
      if (isMapped(tab.id)) return;
      let entryId = urlToEntry.get(tab.url);
      if (!entryId) {
        entryId = newId();
        urlToEntry.set(tab.url, entryId);
        open.push({ opId: newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned, position });
      }
      mappings = setMapping(mappings, tab.id, entryId, tab.url);
    });
    return { mappings: { ...mappings, urlCounts: countUrls(tabs) }, create, open };
  }

  // src/core/materialize.ts
  async function materialize(store, entries, publish) {
    const { all, eligible } = await captureTabs(store.deps.adapter);
    let before = await currentMappings(store, all, eligible);
    let pending = store.s.pending;
    const newId = idGen(store.deps);
    const now = nowDate(store.deps);
    const baseRevision = store.s.lastRevision;
    const sessionIds = entries ? new Set(entries.map((e) => e.id)) : null;
    if (sessionIds) {
      for (const entryId of new Set(Object.values(before.tabs).map((m) => m.entryId))) {
        if (sessionIds.has(entryId) || !pendingChanges(pending, entryId).some((p2) => p2.op.type === "navigate")) continue;
        const f = forkEntry(before, pending, entryId, newId, now, baseRevision);
        if (f) ({ mappings: before, pending } = f);
      }
    }
    const pendingIds = pendingEntryIds(pending);
    const closed = pendingClosedIds(pending);
    const detached = { ...store.s.detached };
    const urlOf = new Map(eligible.map((t) => [String(t.id), t.url]));
    const orphan = (key) => {
      const m = before.tabs[key];
      return sessionIds !== null && m !== void 0 && !sessionIds.has(m.entryId) && !pendingIds.has(m.entryId);
    };
    const stays = (key) => {
      const was = detached[key];
      const url = urlOf.get(key);
      return was !== void 0 && url !== void 0 && sameOrigin(was, url);
    };
    const keep = (key) => !orphan(key) && !stays(key);
    const p = plan({
      entries: entries && entries.filter((e) => !closed.has(e.id)),
      tabs: eligible,
      mappings: before,
      pendingEntries: pendingIds,
      newId
    });
    let mappings = p.mappings;
    const open = [];
    const fresh = new Set(p.open.map((o) => o.entryId));
    for (const key of Object.keys(mappings.tabs)) {
      if (!fresh.has(mappings.tabs[key].entryId)) delete detached[key];
    }
    for (const op of p.open) {
      const keys = Object.keys(mappings.tabs).filter((k) => mappings.tabs[k].entryId === op.entryId);
      if (publish && keys.some(keep)) {
        open.push(op);
        for (const k of keys) delete detached[k];
        continue;
      }
      mappings = removeMappings(mappings, keys.map(Number));
      for (const k of keys) if (orphan(k) || stays(k)) detached[k] = op.url;
    }
    pending = append(pending, open, now, { baseRevision });
    const create = [...p.create];
    const navigateTo = /* @__PURE__ */ new Map();
    for (const entry of entries ?? []) {
      const copies = tabsForEntry(mappings, entry.id);
      const m = mappings.tabs[String(copies[0])];
      if (!m || entry.url === m.url || entry.url === serverUrl(m)) continue;
      if (pendingChanges(pending, entry.id).length === 0) {
        for (const id of copies) navigateTo.set(id, entry.url);
        mappings = remapEntry(mappings, entry.id, entry.id, entry.url);
        continue;
      }
      const base = pendingBase(pending, entry.id);
      if (base === void 0 || base === entry.url) continue;
      const f = forkEntry(mappings, pending, entry.id, newId, now, baseRevision);
      if (!f) continue;
      ({ mappings, pending } = f);
      const local = eligible.find((t) => t.url === entry.url && !mappings.tabs[String(t.id)]);
      if (local) mappings = setMapping(mappings, local.id, entry.id, entry.url);
      else create.push({ entryId: entry.id, url: entry.url, pinned: entry.pinned });
    }
    const until = expiry(store);
    await store.set({
      mappings,
      detached,
      pending,
      expected: expectLoads(store.s.expected, navigateTo.keys(), nowMs(store.deps), until)
    });
    for (const [id, url] of navigateTo) await store.deps.adapter.updateTab(id, { url }).catch(() => void 0);
    const { failed } = await createTabs(store, create);
    return { open, failed };
  }

  // src/core/merge.ts
  function isMalformed(e) {
    return e instanceof ApiError && (e.status === 400 && e.code === "invalid_request" || e.status === 413 && e.code === "payload_too_large");
  }
  async function dropBatch(store, batch) {
    const entryIds = new Set(batch.map((op) => op.entryId));
    const tabIds = Object.entries(store.s.mappings.tabs).filter(([, m]) => entryIds.has(m.entryId)).map(([k]) => Number(k));
    await store.set({
      pending: acknowledge(store.s.pending, batch.map((op) => op.opId)),
      mappings: removeMappings(store.s.mappings, tabIds)
    });
    return batch.length;
  }
  async function applyMergeResults(store, batch, results, revive) {
    const deps2 = store.deps;
    let mappings = applyResults(store.s.mappings, batch, results);
    let pending = acknowledge(store.s.pending, results.map((r) => r.opId));
    const byId = new Map(batch.map((op) => [op.opId, op]));
    for (const r of results) {
      const op = byId.get(r.opId);
      if (!op) continue;
      if (r.entryId && r.entryId !== op.entryId) {
        pending = redirect(pending, op.entryId, r.entryId);
        if (op.type === "navigate") revive.add(op.entryId);
      }
      if (r.status !== "ignored") continue;
      if (op.type === "close") revive.add(op.entryId);
      if (op.type === "navigate") {
        const f = forkEntry(mappings, pending, op.entryId, idGen(deps2), nowDate(deps2), store.s.lastRevision);
        if (f) ({ mappings, pending } = f);
      }
    }
    await store.set({ pending, mappings });
  }
  async function submitJournal(store) {
    const api = apiFor(store.deps, store.s);
    const revive = /* @__PURE__ */ new Set();
    let rejected = 0;
    for (; ; ) {
      const batch = batches(toMerge(store.s.pending))[0];
      if (!batch) break;
      let res;
      try {
        res = await api.merge(batch);
      } catch (e) {
        if (!isMalformed(e)) throw e;
        rejected += await dropBatch(store, batch);
        continue;
      }
      await applyMergeResults(store, batch, res.results, revive);
      if (batch.every((op) => store.s.pending.some((p) => p.op.opId === op.opId))) break;
    }
    return { rejected, revive };
  }

  // src/core/sync.ts
  function rejectedMessage(rejected) {
    return rejected > 0 ? `${rejected} change(s) were rejected by the server and dropped` : null;
  }
  function createFailedMessage(failed) {
    return failed > 0 ? `${failed} tab(s) could not be created` : null;
  }
  var joined = (...msgs) => msgs.filter(Boolean).join("; ") || null;
  function followingText(owner, deviceId, revision) {
    const who = !owner ? "no owner" : owner.deviceId === deviceId ? "this device" : owner.name;
    return `Following ${who}, revision ${revision}`;
  }
  async function flush(store) {
    const deps2 = store.deps;
    const generation = store.s.generation;
    if (generation === null) throw new Error("This device is not the owner");
    const api = apiFor(deps2, store.s);
    let rejected = 0;
    let failed = 0;
    for (let first = true; ; first = false) {
      const batch = batches(list(store.s.pending))[0] ?? [];
      if (batch.length === 0 && !first) break;
      let res;
      try {
        res = await api.operations({ generation, baseRevision: store.s.lastRevision, operations: batch });
      } catch (e) {
        if (!isMalformed(e)) throw e;
        rejected += await dropBatch(store, batch);
        continue;
      }
      let mappings = applyResults(store.s.mappings, batch, res.results);
      let pending = acknowledge(store.s.pending, res.results.map((r) => r.opId));
      const status = new Map(res.results.map((r) => [r.opId, r.status]));
      const navigated = /* @__PURE__ */ new Set();
      for (const op of batch) {
        if (op.type !== "navigate") continue;
        if (status.get(op.opId) === "applied") navigated.add(op.entryId);
        if (status.get(op.opId) === "ignored") {
          const f = forkEntry(mappings, pending, op.entryId, idGen(deps2), nowDate(deps2), store.s.lastRevision);
          if (f) ({ mappings, pending } = f);
        }
      }
      await store.set({ pending, mappings });
      if (res.fullResync) {
        failed += await resync(store);
        rejected += (await submitJournal(store)).rejected;
        break;
      }
      await applyRemote(store, res.catchUp?.operations ?? [], navigated);
      await store.set({ lastRevision: res.revision, ...succeeded(deps2) });
      if (batch.length > 0 && batch.every((op) => store.s.pending.some((p) => p.op.opId === op.opId))) break;
    }
    return { rejected, failed };
  }
  async function resync(store) {
    const session = await apiFor(store.deps, store.s).session();
    const { failed } = await materialize(store, session.entries, false);
    await store.set({
      lastRevision: session.revision,
      minRevision: session.minRevision ?? store.s.minRevision,
      owner: session.owner,
      ...succeeded(store.deps)
    });
    return failed;
  }
  async function followerRun(store) {
    const sent = await submitJournal(store);
    let failed = 0;
    if (store.s.lastRevision === 0) {
      failed = await resync(store);
    } else {
      let res;
      try {
        res = await apiFor(store.deps, store.s).changes(store.s.lastRevision);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
      }
      if (res) {
        await applyRemote(store, res.operations, /* @__PURE__ */ new Set(), sent.revive);
        await store.set({
          lastRevision: Math.max(store.s.lastRevision, res.revision),
          minRevision: res.minRevision ?? store.s.minRevision,
          owner: res.owner
        });
      } else {
        failed = await resync(store);
      }
    }
    const again = store.s.pending.length > 0 ? await submitJournal(store) : { rejected: 0 };
    await store.set({
      ...succeeded(store.deps),
      lastError: joined(createFailedMessage(failed), rejectedMessage(sent.rejected + again.rejected)),
      statusText: followingText(store.s.owner, store.s.deviceId, store.s.lastRevision)
    });
  }
  async function ownerRun(store) {
    const generation = store.s.generation;
    try {
      const { rejected, failed } = await flush(store);
      await store.set({
        ...succeeded(store.deps),
        lastError: joined(createFailedMessage(failed), rejectedMessage(rejected)),
        statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`
      });
    } catch (e) {
      if (!isStaleOwner(e) || !await demote(store, e, generation)) throw e;
      await followerRun(store);
    }
  }
  async function syncRun(deps2) {
    const store = await Store.open(deps2);
    if (!isPaired(store.s)) return store.s;
    const generation = store.s.generation;
    try {
      if (generation !== null) await ownerRun(store);
      else await followerRun(store);
    } catch (e) {
      return fail(store, e, generation);
    }
    return store.s;
  }

  // src/core/handover.ts
  async function handOver(deps2) {
    const store = await Store.open(deps2);
    try {
      requirePaired(store.s);
      const generation = store.s.generation;
      if (generation === null) throw new Error("This device is not the owner. Use Continue here to take control first.");
      await materialize(store, null, true);
      const { rejected, failed } = await flush(store);
      await apiFor(deps2, store.s).release(generation);
      await store.set({
        generation: null,
        owner: null,
        ...succeeded(deps2),
        lastError: [createFailedMessage(failed), rejectedMessage(rejected)].filter(Boolean).join("; ") || null,
        statusText: `Handed over at revision ${store.s.lastRevision}`,
        suppressAutoTakeover: true,
        lastActivityAt: nowMs(deps2),
        freshPending: false
      });
      return store.s;
    } catch (e) {
      return fail(store, e, store.s.generation);
    }
  }
  async function continueHere(deps2) {
    const store = await Store.open(deps2);
    try {
      requirePaired(store.s);
      await store.set({ lastTakeoverAt: nowMs(deps2), suppressAutoTakeover: false, freshPending: false });
      const api = apiFor(deps2, store.s);
      const merged = await submitJournal(store);
      if (store.s.lastRevision > 0) {
        try {
          const res = await api.changes(store.s.lastRevision);
          await applyRemote(store, res.operations, /* @__PURE__ */ new Set(), merged.revive);
          await store.set({
            lastRevision: Math.max(store.s.lastRevision, res.revision),
            minRevision: res.minRevision ?? store.s.minRevision,
            owner: res.owner
          });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
        }
      }
      const { generation, session } = await api.acquire(true);
      await store.set({
        generation,
        owner: session.owner ?? {
          deviceId: store.s.deviceId ?? "",
          name: store.s.deviceName,
          generation,
          lastSeenAt: nowIso(deps2)
        },
        lastRevision: session.revision,
        minRevision: session.minRevision ?? store.s.minRevision
      });
      const { failed } = await materialize(store, session.entries, true);
      const flushed = await flush(store);
      const errors = [createFailedMessage(failed + flushed.failed), rejectedMessage(merged.rejected + flushed.rejected)];
      await store.set({
        ...succeeded(deps2),
        lastError: errors.filter(Boolean).join("; ") || null,
        statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`
      });
      return store.s;
    } catch (e) {
      return fail(store, e, store.s.generation);
    }
  }
  async function pair(deps2, input) {
    const store = await Store.open(deps2);
    try {
      const serverUrl2 = normalizeServerUrl(input.serverUrl);
      const deviceName = input.deviceName.trim();
      const code = input.code.replace(/\s+/g, "");
      if (!deviceName) throw new Error("Device name is required");
      if (deviceName.length > 64) throw new Error("Device name must be at most 64 characters");
      if (!code) throw new Error("Pairing code is required");
      const res = await deps2.api({ baseUrl: serverUrl2, token: null }).pair({ code, name: deviceName, browser: deps2.browser });
      await store.set({
        ...clearedCredentials(),
        serverUrl: serverUrl2,
        deviceName,
        deviceId: res.deviceId,
        token: res.token,
        mappings: emptyMappings(),
        ...succeeded(deps2),
        lastError: null,
        statusText: "Paired. This browser follows the shared tabs and takes over when you use it."
      });
      return store.s;
    } catch (e) {
      return fail(store, e);
    }
  }
  async function pairFromPending(deps2, now = Date.now()) {
    const s = await loadState(deps2.adapter.storage);
    const pending = s.pendingPair;
    if (!pending) return null;
    await saveState(deps2.adapter.storage, { pendingPair: null });
    if (now - pending.createdAt > PENDING_PAIR_TTL_MS) return null;
    return pair(deps2, pending);
  }
  async function createPairingCode(deps2) {
    const store = await Store.open(deps2);
    try {
      requirePaired(store.s);
      return await apiFor(deps2, store.s).createPairingCode();
    } catch (e) {
      return fail(store, e);
    }
  }
  async function disconnect(deps2) {
    const store = await Store.open(deps2);
    if (isPaired(store.s)) {
      const api = apiFor(deps2, store.s);
      if (store.s.generation !== null) await api.release(store.s.generation).catch(() => void 0);
      if (store.s.deviceId) await api.deleteDevice(store.s.deviceId).catch(() => void 0);
    }
    await store.set({ ...clearedCredentials(), lastError: null, lastSuccessAt: null, statusText: "Disconnected" });
    return store.s;
  }
  async function refreshOwner(deps2) {
    const store = await Store.open(deps2);
    if (!isPaired(store.s)) return false;
    const api = apiFor(deps2, store.s);
    let owner;
    let minRevision;
    try {
      try {
        ({ owner, minRevision } = await api.changes(store.s.lastRevision));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
        ({ owner, minRevision } = await api.session());
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "device_revoked") await fail(store, e).catch(() => void 0);
      return false;
    }
    const lostOwnership = store.s.generation !== null && (!owner || owner.deviceId !== store.s.deviceId || owner.generation !== store.s.generation);
    const known = { owner, minRevision: minRevision ?? store.s.minRevision, ...succeeded(deps2) };
    await store.set(
      lostOwnership ? { ...known, generation: null, freshPending: true, statusText: `Not the owner: ${ownerLabel(owner)} took over.` } : known
    );
    return true;
  }
  async function resetForBrowserStartup(deps2) {
    const s = await loadState(deps2.adapter.storage);
    const previous = [...Object.values(s.staleMappings?.tabs ?? {}), ...Object.values(s.mappings.tabs)];
    const staleMappings = {
      tabs: Object.fromEntries(previous.map((m, i) => [`stale-${i}`, m])),
      urlCounts: s.mappings.urlCounts
    };
    const detached = Object.fromEntries(Object.values(s.detached).map((url, i) => [`stale-${i}`, url]));
    await saveState(deps2.adapter.storage, {
      mappings: emptyMappings(),
      staleMappings: previous.length > 0 ? staleMappings : null,
      detached,
      expected: [],
      // Removals still held belong to the shutdown of the previous session: unmap only.
      heldCloses: [],
      removedWindows: {},
      receivingWindowId: null,
      runLock: null,
      startupAt: nowMs(deps2)
    });
  }
  async function rematchTabs(deps2) {
    const store = await Store.open(deps2);
    if (!isPaired(store.s)) return;
    const { all, eligible } = await captureTabs(deps2.adapter);
    await currentMappings(store, all, eligible);
  }

  // src/core/lock.ts
  var BusyError = class extends Error {
    constructor(action) {
      super(`Another sync run is in progress (${action})`);
      this.name = "BusyError";
    }
  };
  async function withRunLock(storage, action, fn, now = Date.now) {
    const s = await loadState(storage);
    if (isLocked(s, now())) throw new BusyError(s.runLock?.action ?? action);
    await saveState(storage, { runLock: { action, startedAt: now() } });
    try {
      return await fn();
    } finally {
      await storage.set({ "cts.runLock": null });
    }
  }

  // src/core/recovery.ts
  async function read(deps2, fn) {
    const store = await Store.open(deps2);
    requirePaired(store.s);
    try {
      const result = await fn(store);
      await store.set(succeeded(deps2));
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.code === "device_revoked") return fail(store, e);
      const kind = classify(e, true);
      throw kind ? new Error(errorMessage(kind, store.s.serverUrl, e instanceof ApiError ? e.status : 0)) : e;
    }
  }
  function listSnapshots(deps2) {
    return read(deps2, (store) => apiFor(deps2, store.s).snapshots());
  }
  function listDevices(deps2) {
    return read(deps2, (store) => apiFor(deps2, store.s).devices());
  }
  async function revokeDevice(deps2, deviceId) {
    const store = await Store.open(deps2);
    requirePaired(store.s);
    if (deviceId === store.s.deviceId) throw new Error("Use Disconnect to remove this device");
    try {
      await apiFor(deps2, store.s).deleteDevice(deviceId);
      if (store.s.owner?.deviceId === deviceId) await store.set({ owner: null });
      return store.s;
    } catch (e) {
      return fail(store, e);
    }
  }
  async function restoreSnapshot(deps2, snapshotId) {
    let store = await Store.open(deps2);
    requirePaired(store.s);
    const tookOver = store.s.generation === null;
    if (tookOver) {
      await continueHere(deps2);
      store = await Store.open(deps2);
    }
    const generation = store.s.generation;
    let flushed = { rejected: 0, failed: 0 };
    try {
      if (generation === null || !isPaired(store.s)) throw new Error("This device is not the owner");
      if (!tookOver) flushed = await flush(store);
      const res = await apiFor(deps2, store.s).restoreSnapshot(snapshotId, generation);
      const failed = await resync(store);
      const reopened = res.results.filter((r) => r.status === "applied").length;
      await store.set({
        lastError: [createFailedMessage(failed + flushed.failed), rejectedMessage(flushed.rejected)].filter(Boolean).join("; ") || null,
        statusText: `Restored ${reopened} tab(s). Owner, generation ${generation}, revision ${store.s.lastRevision}`
      });
      return store.s;
    } catch (e) {
      return fail(store, e, generation);
    }
  }

  // src/core/engine.ts
  var SYNC_DEBOUNCE_MS = 2e3;
  var FOCUS_VERIFY_INTERVAL_MS = 1e4;
  var SESSION_MARKER = "cts.browserSession";
  var PAUSED_MESSAGE = "Sync is paused. Resume to sync again.";
  var BACKED_OFF = /* @__PURE__ */ new Set(["sync", "alarm"]);
  var timeoutScheduler = (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  };
  var ignore = () => void 0;
  function isCommitted(tab, change) {
    return change.status === "complete" || change.url !== void 0 && tab.status === "complete";
  }
  function outcome(o) {
    return { patch: o.patch, ops: o.ops.length, activity: o.activity };
  }
  var SyncEngine = class {
    /** `retrySchedule` runs the backoff retries (separate so tests can fire them on their own). */
    constructor(deps2, schedule = timeoutScheduler, retrySchedule = schedule) {
      this.deps = deps2;
      this.schedule = schedule;
      this.retrySchedule = retrySchedule;
    }
    deps;
    schedule;
    retrySchedule;
    chain = Promise.resolve();
    depth = 0;
    cancelTimer = null;
    cancelRelease = null;
    cancelRetry = null;
    /**
     * Last ownership verification started by a signal. In memory only: a restarted worker may verify
     * once more, which costs one empty batch.
     */
    lastVerifyAt = -Infinity;
    /** Subscribe to tab and window events. In a service worker, call synchronously at top level. */
    attach() {
      const a = this.deps.adapter;
      a.onTabCreated((tab) => this.event(async (s, ctx) => outcome(recordCreated(s, await this.toEvent(tab), ctx))));
      a.onTabUpdated((tab, change) => {
        if (!isCommitted(tab, change)) return;
        this.event(async (s, ctx) => outcome(recordUpdated(s, await this.toEvent(tab), ctx)));
      });
      a.onTabRemoved(
        (tabId, windowClosing, windowId) => this.event(async (s, ctx) => outcome(recordRemoved(s, tabId, windowClosing, windowId, ctx)))
      );
      a.onWindowRemoved((windowId) => this.event(async (s, ctx) => outcome(recordWindowRemoved(s, windowId, ctx))));
      a.onTabActivated(
        (tabId) => this.event(async (s, ctx) => ({
          patch: {},
          ops: 0,
          activity: !s.expected.some((e) => e.kind === "load" && e.created && e.tabId === tabId && e.until > ctx.now)
        }))
      );
      a.onWindowFocusChanged((windowId) => {
        if (windowId !== null) this.event((s) => this.focused(s, windowId));
      });
      a.onStartup(() => void this.startup().catch(ignore));
    }
    /** True while anything is queued or running. */
    get busy() {
      return this.depth > 0;
    }
    /** Run `fn` after everything queued before it. */
    enqueue(fn) {
      this.depth++;
      const run = this.chain.then(fn);
      const done = () => {
        this.depth--;
      };
      this.chain = run.then(done, done);
      return run;
    }
    /** Resolves when the queue is empty (tests). */
    async idle() {
      while (this.depth > 0) await this.chain;
    }
    /**
     * Queued run under the persisted run lock; a run that finds the lock held exits (BusyError).
     * Afterwards the retry timer is armed for `nextRetryAt` (set by a failure) or cancelled.
     */
    locked(action, fn) {
      return this.enqueue(async () => {
        await this.ensureSession();
        try {
          return await withRunLock(this.deps.adapter.storage, action, fn, () => nowMs(this.deps));
        } finally {
          await this.scheduleRetry().catch(ignore);
        }
      });
    }
    /**
     * Tab ids from a previous browser session must never be read against the current tabs, and
     * restored tabs' events can arrive before runtime.onStartup. So every queued task first checks a
     * marker in session storage (cleared when the browser exits) and runs the startup reset when it
     * is missing. Without session storage, only runtime.onStartup resets.
     */
    async ensureSession(force = false) {
      const marker = this.deps.adapter.sessionStorage;
      if (!marker) {
        if (force) await resetForBrowserStartup(this.deps);
        return;
      }
      if (force !== "always" && (await marker.get([SESSION_MARKER]))[SESSION_MARKER] !== void 0) return;
      await resetForBrowserStartup(this.deps);
      await marker.set({ [SESSION_MARKER]: nowMs(this.deps) });
    }
    /**
     * Owner or follower run now (alarm, Sync now, debounced local changes, retry, `verify` after a
     * fresh interaction while owner). Paused: nothing runs (Sync now reports it). Automatic runs
     * before `nextRetryAt` wait for the retry timer. A run that finds ownership lost takes over right
     * after it when the user was active here moments ago (activity.onDemoted).
     */
    runNow(action = "sync") {
      this.cancelTimer?.();
      this.cancelTimer = null;
      return this.locked(action, async () => {
        const s = await loadState(this.deps.adapter.storage);
        if (s.paused) {
          if (action === "syncNow") throw new Error(PAUSED_MESSAGE);
          return s;
        }
        if (BACKED_OFF.has(action) && s.nextRetryAt !== null && s.nextRetryAt > nowMs(this.deps)) return s;
        try {
          return await syncRun(this.deps);
        } finally {
          if (s.generation !== null) await this.afterDemotion().catch(ignore);
        }
      });
    }
    /** Called after a run that started as owner: take over again if it demoted a device in use. */
    async afterDemotion() {
      const storage = this.deps.adapter.storage;
      const s = await loadState(storage);
      if (!isPaired(s) || s.paused || s.generation !== null) return;
      const d = onDemoted(s, nowMs(this.deps));
      await saveState(storage, d.patch);
      if (d.takeover) void this.takeover().catch(ignore);
    }
    /** Debounced run: the first request schedules it, later ones ride along. */
    requestSync() {
      if (this.cancelTimer) return;
      this.cancelTimer = this.schedule(() => {
        this.cancelTimer = null;
        void this.runNow().catch(ignore);
      }, SYNC_DEBOUNCE_MS);
    }
    /**
     * Continue here (manual, and automatic `takeover`). A failed attempt keeps the interaction fresh
     * for a retry. Paused: automatic takeover is skipped, manual Continue here is refused.
     */
    takeover(action = "takeover") {
      return this.locked(action, async () => {
        const s = await loadState(this.deps.adapter.storage);
        if (s.paused) {
          if (action === "takeover") return s;
          throw new Error(PAUSED_MESSAGE);
        }
        try {
          return await continueHere(this.deps);
        } catch (e) {
          await saveState(this.deps.adapter.storage, { freshPending: true });
          throw e;
        }
      });
    }
    handOver() {
      return this.locked("handOver", async () => {
        if ((await loadState(this.deps.adapter.storage)).paused) throw new Error(PAUSED_MESSAGE);
        return handOver(this.deps);
      });
    }
    /** Restore a server snapshot (taking over first when not owner), then materialize it. */
    restore(snapshotId) {
      return this.locked("restore", async () => {
        if ((await loadState(this.deps.adapter.storage)).paused) throw new Error(PAUSED_MESSAGE);
        return restoreSnapshot(this.deps, snapshotId);
      });
    }
    /** Pause: no runs and no automatic takeover; local changes are still journaled. */
    async pause() {
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.cancelRetry?.();
      this.cancelRetry = null;
      return this.enqueue(async () => {
        const storage = this.deps.adapter.storage;
        await saveState(storage, { paused: true, statusText: "Paused. Local changes are kept and sent when you resume." });
        return loadState(storage);
      });
    }
    /**
     * Resume: release held closes first (those whose windows are gone are dropped, never sent; a
     * tab that is merely absent is only unmapped by the run), then run in the current role.
     */
    async unpause() {
      await this.enqueue(() => saveState(this.deps.adapter.storage, { paused: false, statusText: null }));
      await this.enqueue(() => this.process((s, ctx) => this.release(s, ctx)));
      return this.runNow("resume");
    }
    /**
     * Browser startup (`browser`): set mappings aside unless already done for this session, start
     * the grace period, catch up shortly after. Extension update (`update`): the same reset always.
     */
    async startup(reason = "browser") {
      await this.enqueue(async () => {
        await this.ensureSession(reason === "update" ? "always" : true);
        if (reason === "update") await rematchTabs(this.deps);
      });
      this.requestSync();
    }
    /** Worker (re)start: send what an earlier worker journaled, release closes it held, rearm the retry. */
    async resume() {
      const s = await this.enqueue(async () => {
        await this.ensureSession();
        return loadState(this.deps.adapter.storage);
      });
      if (s.heldCloses.some((h) => !h.done)) this.scheduleRelease();
      if (s.paused) return;
      if (isPaired(s) && s.generation !== null && s.pending.length > 0) this.requestSync();
      await this.scheduleRetry();
    }
    /** Arm the retry timer for the persisted `nextRetryAt`, or cancel it (success, paused, unpaired). */
    async scheduleRetry() {
      const s = await loadState(this.deps.adapter.storage);
      this.cancelRetry?.();
      this.cancelRetry = null;
      if (!isPaired(s) || s.paused || s.nextRetryAt === null) return;
      if (s.nextRetryAt <= nowMs(this.deps) && !isRetryableKind(s.errorKind)) return;
      this.cancelRetry = this.retrySchedule(
        () => {
          this.cancelRetry = null;
          void this.runNow("retry").catch(ignore);
        },
        Math.max(0, s.nextRetryAt - nowMs(this.deps))
      );
    }
    /** Release held closes once CLOSE_HOLD_MS has passed (see changes.releaseHeld). */
    scheduleRelease() {
      if (this.cancelRelease) return;
      this.cancelRelease = this.schedule(() => {
        this.cancelRelease = null;
        this.event((s, ctx) => this.release(s, ctx));
      }, CLOSE_HOLD_MS);
    }
    async release(s, ctx) {
      const alive = new Set((await this.deps.adapter.getWindows()).map((w) => w.id));
      const out = releaseHeld(s, alive, ctx);
      if (out.waiting) this.scheduleRelease();
      return outcome(out);
    }
    event(step) {
      void this.enqueue(() => this.process(step)).catch(ignore);
    }
    /** Load state, apply one event, write all changed fields at once, then schedule follow-ups. */
    async process(step) {
      const storage = this.deps.adapter.storage;
      await this.ensureSession();
      const s = await loadState(storage);
      if (!isPaired(s)) return;
      const now = nowMs(this.deps);
      const out = await step(s, { now, newId: idGen(this.deps) });
      const isOwner = s.generation !== null;
      const decision = out.activity && !s.paused ? onActivity(s, { now, isOwner }) : null;
      await saveState(storage, { ...out.patch, ...decision?.patch });
      if (out.patch.heldCloses?.some((h) => !h.done)) this.scheduleRelease();
      if (s.paused) return;
      if (decision?.takeover) void this.takeover().catch(ignore);
      else if (isOwner && (decision?.fresh || out.verify && decision?.counted && now - this.lastVerifyAt >= FOCUS_VERIFY_INTERVAL_MS)) {
        this.lastVerifyAt = now;
        void this.runNow("verify").catch(ignore);
      } else if (isOwner && out.ops > 0) this.requestSync();
    }
    async toEvent(tab) {
      let eligible = !tab.incognito && isShareableUrl(tab.url);
      if (eligible) {
        const w = (await this.deps.adapter.getWindows()).find((x) => x.id === tab.windowId);
        eligible = Boolean(w && w.type === "normal" && !w.incognito);
      }
      return { id: tab.id, url: tab.url, pinned: tab.pinned, active: tab.active, eligible };
    }
    /**
     * Remember the last focused normal window: it receives tabs created by application. Focus on a
     * normal window is activity; devtools, popups and unknown windows are not.
     */
    async focused(s, windowId) {
      const w = (await this.deps.adapter.getWindows()).find((x) => x.id === windowId);
      const normal = w !== void 0 && w.type === "normal";
      const receiving = normal && !w.incognito && s.receivingWindowId !== w.id;
      return { patch: receiving ? { receivingWindowId: w.id } : {}, ops: 0, activity: normal, verify: normal };
    }
  };

  // src/core/messages.ts
  function statusView(s, now = Date.now()) {
    const pendingCount = s.pending.length;
    return {
      paired: isPaired(s),
      serverUrl: s.serverUrl,
      deviceName: s.deviceName,
      deviceId: s.deviceId,
      owner: s.owner,
      isOwner: s.generation !== null,
      generation: s.generation,
      lastRevision: s.lastRevision,
      minRevision: s.minRevision,
      lastSuccessAt: s.lastSuccessAt,
      pendingCount,
      online: s.online,
      nextRetryAt: s.nextRetryAt,
      paused: s.paused,
      summary: syncSummary({ ...s, pendingCount }),
      lastError: s.lastError,
      errorKind: s.errorKind,
      statusText: s.statusText,
      running: isLocked(s, now)
    };
  }

  // src/background/index.ts
  var SYNC_ALARM = "heartbeat";
  var SYNC_MINUTES = 5;
  var adapter = createWebExtAdapter();
  var deps = {
    adapter,
    api: (cfg) => new ApiClient(cfg),
    browser: "safari"
  };
  var engine = new SyncEngine(deps);
  async function pairQueued() {
    const result = await engine.locked("pair", () => pairFromPending(deps));
    if (result) {
      engine.requestSync();
      return;
    }
    const s = await loadState(adapter.storage);
    if (!isPaired(s)) throw new Error(s.lastError ?? "Pairing form expired or was already used; enter the code again");
  }
  async function setup() {
    const state = await loadState(adapter.storage);
    if (!state.deviceName) {
      const os = await chrome.runtime.getPlatformInfo().then((p) => p.os).catch(() => "");
      const osName = os === "mac" ? "macOS" : os === "win" ? "Windows" : os === "linux" ? "Linux" : "";
      const browserName = true ? "Safari" : "Brave";
      await saveState(adapter.storage, { deviceName: osName ? `${browserName} on ${osName}` : browserName });
    }
    await adapter.ensureAlarm(SYNC_ALARM, SYNC_MINUTES);
  }
  void adapter.ensureAlarm(SYNC_ALARM, SYNC_MINUTES);
  void engine.enqueue(() => saveState(adapter.storage, { runLock: null })).then(() => engine.resume());
  chrome.runtime.onInstalled.addListener((details) => {
    void setup();
    if (details.reason === "update") void engine.startup("update").catch(() => void 0);
  });
  engine.attach();
  adapter.onStartup(() => void setup());
  adapter.onAlarm((name) => {
    if (name !== SYNC_ALARM) return;
    void engine.runNow("alarm").catch(() => void 0);
  });
  chrome.permissions?.onAdded?.addListener((perms) => {
    if (!perms.origins?.length) return;
    void pairQueued().catch(() => void 0);
  });
  async function handle(req) {
    let pairingCode;
    let reachable;
    let snapshots;
    let devices;
    switch (req.type) {
      case "getStatus":
        if (req.refresh && !engine.busy) reachable = await engine.enqueue(() => refreshOwner(deps));
        break;
      case "pair":
        await pairQueued();
        break;
      case "handOver":
        await engine.handOver();
        break;
      case "continueHere":
        await engine.takeover("continueHere");
        break;
      case "syncNow":
        await engine.runNow("syncNow");
        break;
      case "pause":
        await engine.pause();
        break;
      case "resume":
        await engine.unpause();
        break;
      case "listSnapshots":
        snapshots = await listSnapshots(deps);
        break;
      case "restoreSnapshot":
        await engine.restore(req.id);
        break;
      case "listDevices":
        devices = await listDevices(deps);
        break;
      case "revokeDevice":
        await engine.enqueue(() => revokeDevice(deps, req.id));
        break;
      case "createPairingCode":
        pairingCode = await createPairingCode(deps);
        break;
      case "disconnect":
        await engine.locked("disconnect", () => disconnect(deps));
        break;
      default:
        throw new Error("Unknown request");
    }
    const status = statusView(await loadState(adapter.storage));
    if (reachable !== void 0) status.reachable = reachable;
    return { ok: true, status, pairingCode, snapshots, devices };
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    handle(msg).then(sendResponse).catch(async (e) => {
      const status = await loadState(adapter.storage).then((s) => statusView(s)).catch(() => void 0);
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), status });
    });
    return true;
  });
})();
