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
      active: Boolean(t.active)
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
  function createWebExtAdapter() {
    return {
      storage: storageLocal,
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
      async ensureAlarm(name, periodInMinutes) {
        const existing = await chrome.alarms.get(name).catch(() => void 0);
        if (!existing) await chrome.alarms.create(name, { periodInMinutes });
      },
      onAlarm: (cb) => listen(chrome.alarms.onAlarm, (alarm) => cb(alarm.name)),
      onTabCreated: (cb) => listen(chrome.tabs.onCreated, (t) => {
        const tab = toTab(t);
        if (tab) cb(tab);
      }),
      onTabRemoved: (cb) => listen(chrome.tabs.onRemoved, (tabId, info) => cb(tabId, info.isWindowClosing)),
      onTabUpdated: (cb) => listen(chrome.tabs.onUpdated, (_id, change, t) => {
        const tab = toTab(t);
        if (tab) cb(tab, { url: change.url, status: change.status });
      }),
      onTabActivated: (cb) => listen(chrome.tabs.onActivated, (info) => cb(info.tabId, info.windowId)),
      onWindowFocusChanged: (cb) => listen(
        chrome.windows.onFocusChanged,
        (windowId) => cb(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId)
      )
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

  // src/core/eligibility.ts
  var MAX_URL_BYTES = 2048;
  var encoder = new TextEncoder();
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
    return encoder.encode(url).length <= MAX_URL_BYTES;
  }
  function eligibleTabs(tabs, windows) {
    const normal = new Set(windows.filter((w) => w.type === "normal" && !w.incognito).map((w) => w.id));
    return tabs.filter((t) => !t.incognito && normal.has(t.windowId) && isShareableUrl(t.url)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  }

  // src/core/journal.ts
  function newOpId() {
    return crypto.randomUUID();
  }
  function append(journal, ops, now = /* @__PURE__ */ new Date()) {
    const known = new Set(journal.map((p) => p.op.opId));
    const added = ops.filter((op) => !known.has(op.opId)).map((op) => ({ op, queuedAt: now.toISOString() }));
    return [...journal, ...added];
  }
  function acknowledge(journal, opIds) {
    const acked = new Set(opIds);
    return journal.filter((p) => !acked.has(p.op.opId));
  }
  function list(journal) {
    return journal.map((p) => p.op);
  }
  function pendingEntryIds(journal) {
    return new Set(journal.filter((p) => p.op.type === "open").map((p) => p.op.entryId));
  }
  var MAX_BATCH_OPS = 500;
  var MAX_BATCH_BYTES = 60 * 1024;
  var encoder2 = new TextEncoder();
  function batches(ops, maxOps = MAX_BATCH_OPS, maxBytes = MAX_BATCH_BYTES) {
    const out = [];
    let current2 = [];
    let bytes = 0;
    for (const op of ops) {
      const size = encoder2.encode(JSON.stringify(op)).length + 1;
      if (current2.length > 0 && (current2.length >= maxOps || bytes + size > maxBytes)) {
        out.push(current2);
        current2 = [];
        bytes = 0;
      }
      current2.push(op);
      bytes += size;
    }
    if (current2.length > 0) out.push(current2);
    return out;
  }

  // src/core/mapping.ts
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
  function rematchByUrl(stored, tabs, base = emptyMappings()) {
    const claimed = new Set(Object.keys(base.tabs).map(Number));
    let m = base;
    for (const old of Object.values(stored.tabs)) {
      const tab = tabs.find((t) => t.url === old.url && !claimed.has(t.id));
      if (!tab) continue;
      claimed.add(tab.id);
      m = setMapping(m, tab.id, old.entryId, old.url);
    }
    return m;
  }
  function reconcileMappings(m, allTabs) {
    const present = new Set(allTabs.map((t) => String(t.id)));
    const tabs = {};
    for (const [k, v] of Object.entries(m.tabs)) if (present.has(k)) tabs[k] = v;
    return { ...m, tabs };
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
      runLock: null
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
      pending: []
    };
  }
  var RUN_LOCK_TTL_MS = 2 * 60 * 1e3;
  function isLocked(s, now) {
    return s.runLock !== null && now - s.runLock.startedAt < RUN_LOCK_TTL_MS;
  }

  // src/core/handover.ts
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
  var nowIso = (deps2) => (deps2.now ? deps2.now() : /* @__PURE__ */ new Date()).toISOString();
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
  async function fail(store, e, sentGeneration) {
    if (e instanceof ApiError && e.code === "stale_owner") {
      const persisted = (await loadState(store.deps.adapter.storage)).generation;
      if (sentGeneration !== void 0 && persisted !== sentGeneration) throw e;
      const owner = e.owner;
      await store.set({
        generation: null,
        owner,
        statusText: `Not the owner: ${ownerLabel(owner)} took over. Use Continue here to take control.`,
        lastError: "Ownership was taken by another device; nothing was applied."
      });
    } else if (e instanceof ApiError && e.code === "device_revoked") {
      await store.set({
        ...clearedCredentials(),
        statusText: "Disconnected",
        lastError: "This device was revoked on the server. Pair it again."
      });
    } else {
      await store.set({ lastError: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
  async function captureTabs(adapter2) {
    const [all, windows] = await Promise.all([adapter2.queryTabs(), adapter2.getWindows()]);
    return { all, eligible: eligibleTabs(all, windows) };
  }
  async function currentMappings(store, all, eligible) {
    let mappings = reconcileMappings(store.s.mappings, all);
    if (store.s.staleMappings) mappings = rematchByUrl(store.s.staleMappings, eligible, mappings);
    await store.set({ mappings, staleMappings: null });
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
  async function createTabs(store, items) {
    if (items.length === 0) return { created: 0, failed: 0 };
    const { adapter: adapter2 } = store.deps;
    let windowId = await resolveReceivingWindow(adapter2, store.s.receivingWindowId);
    let created = 0;
    let failed = 0;
    for (const item of items) {
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
        await store.set({ mappings: setMapping(store.s.mappings, tab.id, item.entryId, item.url), receivingWindowId: windowId });
        created++;
      } catch {
        failed++;
      }
    }
    return { created, failed };
  }
  function applyResults(mappings, ops, results) {
    const byId = new Map(ops.map((op) => [op.opId, op]));
    let m = mappings;
    for (const r of results) {
      const op = byId.get(r.opId);
      if (!op || r.status !== "coalesced" || !r.entryId || r.entryId === op.entryId) continue;
      m = remapEntry(m, op.entryId, r.entryId);
    }
    return m;
  }
  async function applyCatchUp(store, ops) {
    const foreign = ops.filter((l) => l.deviceId !== store.s.deviceId && l.result.status !== "ignored").sort((a, b) => a.seq - b.seq);
    if (foreign.length === 0) return;
    const { adapter: adapter2 } = store.deps;
    const { all, eligible } = await captureTabs(adapter2);
    let mappings = await currentMappings(store, all, eligible);
    const toCreate = [];
    for (const { op, result } of foreign) {
      const target = result.entryId ?? op.entryId;
      switch (op.type) {
        case "open": {
          if (target !== op.entryId) mappings = remapEntry(mappings, op.entryId, target);
          if (tabsForEntry(mappings, target).length > 0 || toCreate.some((c) => c.entryId === target)) break;
          const reuse = eligible.filter((t) => t.url === op.url && mappings.tabs[String(t.id)] === void 0);
          if (reuse.length > 0) {
            for (const t of reuse) mappings = setMapping(mappings, t.id, target, op.url);
          } else {
            toCreate.push({ entryId: target, url: op.url, pinned: op.pinned ?? false });
          }
          break;
        }
        case "navigate": {
          const tabIds = tabsForEntry(mappings, op.entryId);
          mappings = remapEntry(mappings, op.entryId, target, op.url);
          const pendingCreate = toCreate.find((c) => c.entryId === op.entryId);
          if (pendingCreate) Object.assign(pendingCreate, { entryId: target, url: op.url });
          for (const id of tabIds) await adapter2.updateTab(id, { url: op.url }).catch(() => void 0);
          break;
        }
        case "close": {
          mappings = removeMappings(mappings, tabsForEntry(mappings, op.entryId));
          const i = toCreate.findIndex((c) => c.entryId === op.entryId);
          if (i >= 0) toCreate.splice(i, 1);
          break;
        }
        case "update": {
          if (op.pinned === void 0) break;
          for (const id of tabsForEntry(mappings, op.entryId)) {
            await adapter2.updateTab(id, { pinned: op.pinned }).catch(() => void 0);
          }
          break;
        }
      }
    }
    await store.set({ mappings });
    await createTabs(store, toCreate);
  }
  async function flush(store) {
    const deps2 = store.deps;
    const generation = store.s.generation;
    if (generation === null) throw new Error("This device is not the owner");
    const api = apiFor(deps2, store.s);
    const pending = batches(list(store.s.pending));
    if (pending.length === 0) {
      try {
        const res = await api.changes(store.s.lastRevision);
        await applyCatchUp(store, res.operations);
        await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), lastSync: nowIso(deps2) });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
      }
      return { rejected: 0 };
    }
    let rejected = 0;
    for (const batch of pending) {
      let res;
      try {
        res = await api.operations({ generation, baseRevision: store.s.lastRevision, operations: batch });
      } catch (e) {
        if (!(e instanceof ApiError && (e.code === "invalid_request" || e.code === "payload_too_large"))) throw e;
        const entryIds = new Set(batch.map((op) => op.entryId));
        const tabIds = Object.entries(store.s.mappings.tabs).filter(([, m]) => entryIds.has(m.entryId)).map(([k]) => Number(k));
        await store.set({
          pending: acknowledge(store.s.pending, batch.map((op) => op.opId)),
          mappings: removeMappings(store.s.mappings, tabIds)
        });
        rejected += batch.length;
        continue;
      }
      await store.set({
        pending: acknowledge(store.s.pending, res.results.map((r) => r.opId)),
        mappings: applyResults(store.s.mappings, batch, res.results)
      });
      await applyCatchUp(store, res.catchUp?.operations ?? []);
      await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), lastSync: nowIso(deps2) });
    }
    return { rejected };
  }
  function rejectedMessage(rejected) {
    return rejected > 0 ? `${rejected} change(s) were rejected by the server and dropped` : null;
  }
  async function handOver(deps2) {
    const store = await Store.open(deps2);
    try {
      requirePaired(store.s);
      const generation = store.s.generation;
      if (generation === null) throw new Error("This device is not the owner. Use Continue here to take control first.");
      const { all, eligible } = await captureTabs(deps2.adapter);
      const p = plan({
        entries: null,
        tabs: eligible,
        mappings: await currentMappings(store, all, eligible),
        pendingEntries: pendingEntryIds(store.s.pending),
        newId: idGen(deps2)
      });
      await store.set({ mappings: p.mappings, pending: append(store.s.pending, p.open) });
      const { rejected } = await flush(store);
      await apiFor(deps2, store.s).release(generation);
      await store.set({
        generation: null,
        owner: null,
        lastSync: nowIso(deps2),
        lastError: rejectedMessage(rejected),
        statusText: `Handed over at revision ${store.s.lastRevision}`
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
      const { generation, session } = await apiFor(deps2, store.s).acquire(true);
      await store.set({
        generation,
        owner: session.owner ?? {
          deviceId: store.s.deviceId ?? "",
          name: store.s.deviceName,
          generation,
          lastSeenAt: nowIso(deps2)
        },
        lastRevision: session.revision,
        lastSync: nowIso(deps2)
      });
      const { all, eligible } = await captureTabs(deps2.adapter);
      const p = plan({
        entries: session.entries,
        tabs: eligible,
        mappings: await currentMappings(store, all, eligible),
        pendingEntries: pendingEntryIds(store.s.pending),
        newId: idGen(deps2)
      });
      await store.set({ mappings: p.mappings, pending: append(store.s.pending, p.open) });
      const { failed } = await createTabs(store, p.create);
      const { rejected } = await flush(store);
      const errors = [failed > 0 ? `${failed} tab(s) could not be created` : null, rejectedMessage(rejected)];
      await store.set({
        lastSync: nowIso(deps2),
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
      const serverUrl = normalizeServerUrl(input.serverUrl);
      const deviceName = input.deviceName.trim();
      const code = input.code.replace(/\s+/g, "");
      if (!deviceName) throw new Error("Device name is required");
      if (deviceName.length > 64) throw new Error("Device name must be at most 64 characters");
      if (!code) throw new Error("Pairing code is required");
      const res = await deps2.api({ baseUrl: serverUrl, token: null }).pair({ code, name: deviceName, browser: deps2.browser });
      await store.set({
        ...clearedCredentials(),
        serverUrl,
        deviceName,
        deviceId: res.deviceId,
        token: res.token,
        mappings: emptyMappings(),
        lastSync: nowIso(deps2),
        lastError: null,
        statusText: "Paired. Use Continue here to take control on this device."
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
    await store.set({ ...clearedCredentials(), lastError: null, lastSync: null, statusText: "Disconnected" });
    return store.s;
  }
  async function refreshOwner(deps2) {
    const store = await Store.open(deps2);
    if (!isPaired(store.s)) return false;
    const api = apiFor(deps2, store.s);
    let owner;
    try {
      try {
        owner = (await api.changes(store.s.lastRevision)).owner;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
        owner = (await api.session()).owner;
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "device_revoked") await fail(store, e).catch(() => void 0);
      return false;
    }
    const lostOwnership = store.s.generation !== null && (!owner || owner.deviceId !== store.s.deviceId || owner.generation !== store.s.generation);
    await store.set(
      lostOwnership ? { owner, generation: null, statusText: `Not the owner: ${ownerLabel(owner)} took over.` } : { owner }
    );
    return true;
  }
  async function heartbeat(deps2) {
    const store = await Store.open(deps2);
    const generation = store.s.generation;
    if (!isPaired(store.s) || generation === null) return;
    try {
      await apiFor(deps2, store.s).heartbeat(generation);
      await store.set({ lastSync: nowIso(deps2) });
    } catch (e) {
      await fail(store, e, generation).catch(() => void 0);
    }
  }
  async function resetForBrowserStartup(deps2) {
    const s = await loadState(deps2.adapter.storage);
    const previous = [...Object.values(s.staleMappings?.tabs ?? {}), ...Object.values(s.mappings.tabs)];
    const staleMappings = {
      tabs: Object.fromEntries(previous.map((m, i) => [`stale-${i}`, m])),
      urlCounts: s.mappings.urlCounts
    };
    await saveState(deps2.adapter.storage, {
      mappings: emptyMappings(),
      staleMappings: previous.length > 0 ? staleMappings : null,
      receivingWindowId: null,
      runLock: null
    });
  }
  async function updateMappedUrl(deps2, tabId, url) {
    if (!isShareableUrl(url)) return;
    const s = await loadState(deps2.adapter.storage);
    const m = s.mappings.tabs[String(tabId)];
    if (!m || m.url === url) return;
    await saveState(deps2.adapter.storage, { mappings: setMapping(s.mappings, tabId, m.entryId, url) });
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

  // src/core/messages.ts
  function statusView(s, now = Date.now()) {
    return {
      paired: isPaired(s),
      serverUrl: s.serverUrl,
      deviceName: s.deviceName,
      deviceId: s.deviceId,
      owner: s.owner,
      isOwner: s.generation !== null,
      generation: s.generation,
      lastRevision: s.lastRevision,
      lastSync: s.lastSync,
      pendingCount: s.pending.length,
      lastError: s.lastError,
      statusText: s.statusText,
      running: isLocked(s, now)
    };
  }

  // src/background/index.ts
  var HEARTBEAT_ALARM = "heartbeat";
  var HEARTBEAT_MINUTES = 5;
  var adapter = createWebExtAdapter();
  var deps = {
    adapter,
    api: (cfg) => new ApiClient(cfg),
    browser: "safari"
  };
  var current = null;
  async function exclusive(action, fn) {
    if (current) throw new BusyError(action);
    const run = withRunLock(adapter.storage, action, fn);
    current = run;
    try {
      return await run;
    } finally {
      current = null;
    }
  }
  async function pairExclusive() {
    if (current) await current.catch(() => void 0);
    const result = await exclusive("pair", () => pairFromPending(deps));
    if (result) return;
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
    await adapter.ensureAlarm(HEARTBEAT_ALARM, HEARTBEAT_MINUTES);
  }
  void adapter.ensureAlarm(HEARTBEAT_ALARM, HEARTBEAT_MINUTES);
  void saveState(adapter.storage, { runLock: null });
  chrome.runtime.onInstalled.addListener(() => {
    void setup();
  });
  chrome.runtime.onStartup.addListener(() => {
    void resetForBrowserStartup(deps).then(setup);
  });
  adapter.onAlarm((name) => {
    if (name !== HEARTBEAT_ALARM) return;
    void exclusive("heartbeat", () => heartbeat(deps)).catch(() => void 0);
  });
  var urlUpdates = Promise.resolve();
  adapter.onTabUpdated((tab, change) => {
    if (change.url === void 0 && change.status !== "complete") return;
    urlUpdates = urlUpdates.then(() => current?.catch(() => void 0)).then(() => updateMappedUrl(deps, tab.id, tab.url)).catch(() => void 0);
  });
  adapter.onWindowFocusChanged((windowId) => {
    if (windowId === null) return;
    void adapter.getWindows().then((windows) => {
      const w = windows.find((x) => x.id === windowId);
      if (w && w.type === "normal" && !w.incognito) return saveState(adapter.storage, { receivingWindowId: w.id });
    });
  });
  chrome.permissions?.onAdded?.addListener((perms) => {
    if (!perms.origins?.length) return;
    void pairExclusive().catch(() => void 0);
  });
  async function handle(req) {
    let pairingCode;
    let reachable;
    switch (req.type) {
      case "getStatus":
        if (req.refresh && !current && !isLocked(await loadState(adapter.storage), Date.now())) {
          reachable = await refreshOwner(deps);
        }
        break;
      case "pair":
        await pairExclusive();
        break;
      case "handOver":
        await exclusive("handOver", () => handOver(deps));
        break;
      case "continueHere":
        await exclusive("continueHere", () => continueHere(deps));
        break;
      case "createPairingCode":
        pairingCode = await createPairingCode(deps);
        break;
      case "disconnect":
        await exclusive("disconnect", () => disconnect(deps));
        break;
      default:
        throw new Error("Unknown request");
    }
    const status = statusView(await loadState(adapter.storage));
    if (reachable !== void 0) status.reachable = reachable;
    return pairingCode ? { ok: true, status, pairingCode } : { ok: true, status };
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
