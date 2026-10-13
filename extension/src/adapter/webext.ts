// BrowserAdapter over the promise-returning `chrome.*` API (Brave and Safari, MV3, no polyfill).

import type { BrowserAdapter, KeyValueStorage, TabInfo, Unsubscribe, WindowInfo } from "./types.js";

function toTab(t: chrome.tabs.Tab): TabInfo | null {
  if (t.id === undefined || t.id < 0) return null;
  return {
    id: t.id,
    windowId: t.windowId,
    // Safari reports "" for sites the user has not granted access to: treat as no URL.
    url: t.url || undefined,
    pinned: Boolean(t.pinned),
    incognito: Boolean(t.incognito),
    index: t.index,
    active: Boolean(t.active),
    status: t.status,
  };
}

function toWindow(w: chrome.windows.Window): WindowInfo | null {
  if (w.id === undefined || w.id < 0) return null;
  return { id: w.id, type: w.type ?? "normal", incognito: Boolean(w.incognito), focused: Boolean(w.focused) };
}

function requireTab(t: chrome.tabs.Tab | undefined): TabInfo {
  const tab = t ? toTab(t) : null;
  if (!tab) throw new Error("Browser did not return a tab");
  return tab;
}

function listen<A extends unknown[]>(event: chrome.events.Event<(...args: A) => void>, cb: (...args: A) => void): Unsubscribe {
  event.addListener(cb);
  return () => event.removeListener(cb);
}

export const storageLocal: KeyValueStorage = {
  get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

/** `chrome.storage.session` (Safari 16.4+, Chrome 102+), or null where the engine lacks it. */
function storageSession(): KeyValueStorage | null {
  const area = chrome.storage.session;
  if (!area) return null;
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

export function createWebExtAdapter(): BrowserAdapter {
  return {
    storage: storageLocal,
    sessionStorage: storageSession(),

    async queryTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.map(toTab).filter((t): t is TabInfo => t !== null);
    },

    async getWindows() {
      const windows = await chrome.windows.getAll();
      return windows.map(toWindow).filter((w): w is WindowInfo => w !== null);
    },

    async getLastFocusedWindow() {
      let w: chrome.windows.Window;
      try {
        w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      } catch {
        // Some engines reject the filter; fall back and check the type ourselves.
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
      if (!w || w.id === undefined) throw new Error("Browser did not return a window");
      // Safari before 18.4 omitted `tabs` from the result; look the tab up instead.
      const first = w.tabs?.[0] ?? (await chrome.tabs.query({ windowId: w.id }))[0];
      return { windowId: w.id, tab: requireTab(first) };
    },

    async updateTab(tabId, props) {
      const update: chrome.tabs.UpdateProperties = {};
      if (props.url !== undefined) update.url = props.url;
      if (props.pinned !== undefined) update.pinned = props.pinned;
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
      const existing = await chrome.alarms.get(name).catch(() => undefined);
      if (!existing) await chrome.alarms.create(name, { periodInMinutes });
    },

    onAlarm: (cb) => listen(chrome.alarms.onAlarm, (alarm: chrome.alarms.Alarm) => cb(alarm.name)),
    onTabCreated: (cb) =>
      listen(chrome.tabs.onCreated, (t: chrome.tabs.Tab) => {
        const tab = toTab(t);
        if (tab) cb(tab);
      }),
    onTabRemoved: (cb) =>
      listen(chrome.tabs.onRemoved, (tabId: number, info: chrome.tabs.OnRemovedInfo) =>
        cb(tabId, info.isWindowClosing, info.windowId),
      ),
    onTabUpdated: (cb) =>
      listen(chrome.tabs.onUpdated, (_id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
        const tab = toTab(t);
        if (tab) cb(tab, { url: change.url, status: change.status });
      }),
    onTabActivated: (cb) =>
      listen(chrome.tabs.onActivated, (info: chrome.tabs.OnActivatedInfo) => cb(info.tabId, info.windowId)),
    onWindowFocusChanged: (cb) =>
      listen(chrome.windows.onFocusChanged, (windowId: number) =>
        cb(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId),
      ),
    onWindowRemoved: (cb) => listen(chrome.windows.onRemoved, (windowId: number) => cb(windowId)),
    onStartup: (cb) => listen(chrome.runtime.onStartup, () => cb()),
  };
}
