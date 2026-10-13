/** Browser-neutral view of a tab. `url` is missing for tabs the browser does not expose. */
export interface TabInfo {
  id: number;
  windowId: number;
  url?: string;
  pinned: boolean;
  incognito: boolean;
  index: number;
  active: boolean;
}

export interface WindowInfo {
  id: number;
  /** "normal", "popup", "panel", "app", "devtools". Only "normal" windows take part in sync. */
  type: string;
  incognito: boolean;
  focused: boolean;
}

/** Minimal key/value storage, satisfied by `chrome.storage.local` and by an in-memory map. */
export interface KeyValueStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export type Unsubscribe = () => void;

export interface BrowserAdapter {
  storage: KeyValueStorage;

  queryTabs(): Promise<TabInfo[]>;
  getWindows(): Promise<WindowInfo[]>;
  /** Last focused normal window, or null when there is none. */
  getLastFocusedWindow(): Promise<WindowInfo | null>;
  /** Always creates the tab in the background (`active: false`). */
  createTab(opts: { windowId: number; url: string; pinned?: boolean }): Promise<TabInfo>;
  /** Creates an unfocused normal window showing `url`; returns the window and its single tab. */
  createWindow(url: string): Promise<{ windowId: number; tab: TabInfo }>;
  /** Never activates the tab. */
  updateTab(tabId: number, props: { url?: string; pinned?: boolean }): Promise<void>;
  removeTab(tabId: number): Promise<void>;

  /** Create the periodic alarm unless it already exists (Safari does not persist alarms). */
  ensureAlarm(name: string, periodInMinutes: number): Promise<void>;

  // Event subscriptions. In a service worker these must be called synchronously at top level.
  onAlarm(cb: (name: string) => void): Unsubscribe;
  onTabCreated(cb: (tab: TabInfo) => void): Unsubscribe;
  onTabRemoved(cb: (tabId: number, windowClosing: boolean) => void): Unsubscribe;
  onTabUpdated(cb: (tab: TabInfo) => void): Unsubscribe;
  onTabActivated(cb: (tabId: number, windowId: number) => void): Unsubscribe;
  onWindowFocusChanged(cb: (windowId: number | null) => void): Unsubscribe;
}
