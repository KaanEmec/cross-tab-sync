// In-memory BrowserAdapter for tests. Mirrors the behavior the real adapter guarantees:
// created tabs are never active, windows are created unfocused, storage values are cloned.
// API calls emit the events a browser would (synchronously); `user*` helpers simulate the user.

import type { BrowserAdapter, KeyValueStorage, TabInfo, Unsubscribe, WindowInfo } from "./types.js";

export class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }
}

type Listener<A extends unknown[]> = (...args: A) => void;

class Emitter<A extends unknown[]> {
  private readonly listeners = new Set<Listener<A>>();
  on(cb: Listener<A>): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(...args: A): void {
    for (const cb of this.listeners) cb(...args);
  }
}

export interface FakeTabInit {
  url?: string;
  pinned?: boolean;
  active?: boolean;
}

export class FakeBrowser implements BrowserAdapter {
  readonly storage = new MemoryStorage();
  /** Cleared by `restart()`. Set to null to simulate an engine without storage.session. */
  sessionStorage: MemoryStorage | null = new MemoryStorage();
  windows: WindowInfo[] = [];
  tabs: TabInfo[] = [];
  lastFocusedWindowId: number | null = null;
  alarms = new Map<string, number>();
  /** Host permission for the server origin (permissions.contains). */
  hostPermission = true;
  /** When set, createTab rejects for these URLs. */
  failCreateFor = new Set<string>();
  readonly calls: { method: string; args: unknown[] }[] = [];

  readonly events = {
    alarm: new Emitter<[string]>(),
    tabCreated: new Emitter<[TabInfo]>(),
    tabRemoved: new Emitter<[number, boolean, number]>(),
    windowRemoved: new Emitter<[number]>(),
    tabUpdated: new Emitter<[TabInfo, { url?: string; status?: string }]>(),
    tabActivated: new Emitter<[number, number]>(),
    windowFocus: new Emitter<[number | null]>(),
    startup: new Emitter<[]>(),
  };
  /** Server-side redirects applied when a tab loads a URL (from = requested, to = final). */
  redirects = new Map<string, string>();

  private nextId = 1;

  addWindow(init: { type?: string; incognito?: boolean; tabs?: FakeTabInit[]; focused?: boolean } = {}): number {
    const id = this.nextId++;
    this.windows.push({ id, type: init.type ?? "normal", incognito: Boolean(init.incognito), focused: Boolean(init.focused) });
    if (init.focused) this.lastFocusedWindowId = id;
    for (const t of init.tabs ?? []) this.addTab(id, t);
    return id;
  }

  addTab(windowId: number, init: FakeTabInit = {}): TabInfo {
    const win = this.windows.find((w) => w.id === windowId);
    if (!win) throw new Error(`no window ${windowId}`);
    const tab: TabInfo = {
      id: this.nextId++,
      windowId,
      url: init.url,
      pinned: Boolean(init.pinned),
      incognito: win.incognito,
      index: this.tabs.filter((t) => t.windowId === windowId).length,
      active: Boolean(init.active),
      status: "complete",
    };
    this.tabs.push(tab);
    return tab;
  }

  activeTabs(): Record<number, number | undefined> {
    const out: Record<number, number | undefined> = {};
    for (const w of this.windows) out[w.id] = this.tabs.find((t) => t.windowId === w.id && t.active)?.id;
    return out;
  }

  async queryTabs(): Promise<TabInfo[]> {
    return this.tabs.map((t) => ({ ...t }));
  }

  async getWindows(): Promise<WindowInfo[]> {
    return this.windows.map((w) => ({ ...w }));
  }

  async getLastFocusedWindow(): Promise<WindowInfo | null> {
    const w = this.windows.find((x) => x.id === this.lastFocusedWindowId);
    return w && w.type === "normal" && !w.incognito ? { ...w } : null;
  }

  async createTab(opts: { windowId: number; url: string; pinned?: boolean }): Promise<TabInfo> {
    this.calls.push({ method: "createTab", args: [opts] });
    if (this.failCreateFor.has(opts.url)) throw new Error("create failed");
    const tab = this.addTab(opts.windowId, { pinned: opts.pinned, active: false });
    this.events.tabCreated.emit({ ...tab });
    this.load(tab, opts.url);
    return { ...tab };
  }

  async createWindow(url: string): Promise<{ windowId: number; tab: TabInfo }> {
    this.calls.push({ method: "createWindow", args: [url] });
    const windowId = this.addWindow();
    // A brand-new window necessarily shows its only tab; the window itself is not focused.
    const tab = this.addTab(windowId, { active: true });
    this.events.tabCreated.emit({ ...tab });
    this.events.tabActivated.emit(tab.id, windowId);
    this.load(tab, url);
    return { windowId, tab: { ...tab } };
  }

  async updateTab(tabId: number, props: { url?: string; pinned?: boolean }): Promise<void> {
    this.calls.push({ method: "updateTab", args: [tabId, props] });
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    if (props.pinned !== undefined) tab.pinned = props.pinned;
    if (props.url !== undefined) this.load(tab, props.url);
  }

  async removeTab(tabId: number): Promise<void> {
    this.calls.push({ method: "removeTab", args: [tabId] });
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    this.events.tabRemoved.emit(tabId, false, tab.windowId);
  }

  /**
   * Load `url` in `tab` like a browser: a loading phase with the requested URL, the redirect target
   * (from `redirects`) while still loading, then complete.
   */
  private load(tab: TabInfo, url: string): void {
    tab.url = url;
    tab.status = "loading";
    this.events.tabUpdated.emit({ ...tab }, { url, status: "loading" });
    const final = this.redirects.get(url);
    if (final) {
      tab.url = final;
      this.events.tabUpdated.emit({ ...tab }, { url: final });
    }
    tab.status = "complete";
    this.events.tabUpdated.emit({ ...tab }, { status: "complete" });
  }

  /** The loaded page changes its own URL (history.replaceState, hash, script redirect). */
  pageRewritesUrl(tabId: number, url: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    tab.url = url;
    this.events.tabUpdated.emit({ ...tab }, { url });
  }

  /**
   * Browser quit and relaunch: windows, tabs and session storage are gone and ids restart from 1,
   * so restored tabs reuse ids of the previous session. Restore with `restoreTab`, then emit
   * `events.startup` (possibly after the restored-tab events, as browsers may do).
   */
  restart(): void {
    this.tabs = [];
    this.windows = [];
    this.lastFocusedWindowId = null;
    this.nextId = 1;
    void this.sessionStorage?.remove([...this.sessionStorage.data.keys()]);
  }

  // --- user actions -------------------------------------------------------------------------

  /** New tab (Chrome-like: created without URL, then the page commits). */
  userOpenTab(windowId: number, url: string, opts: { active?: boolean } = {}): TabInfo {
    const tab = this.addTab(windowId, {});
    tab.status = "loading";
    this.events.tabCreated.emit({ ...tab });
    if (opts.active) this.userActivate(tab.id);
    this.load(tab, url);
    return { ...tab };
  }

  userNavigate(tabId: number, url: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    this.load(tab, url);
  }

  userActivate(tabId: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    for (const t of this.tabs) if (t.windowId === tab.windowId) t.active = t.id === tabId;
    this.events.tabActivated.emit(tabId, tab.windowId);
  }

  userCloseTab(tabId: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    this.events.tabRemoved.emit(tabId, false, tab.windowId);
    const next = this.tabs.find((t) => t.windowId === tab.windowId);
    if (tab.active && next) this.userActivate(next.id);
  }

  userFocusWindow(windowId: number | null): void {
    for (const w of this.windows) w.focused = w.id === windowId;
    if (windowId !== null) this.lastFocusedWindowId = windowId;
    this.events.windowFocus.emit(windowId);
  }

  /** `reportsWindowClosing: false` simulates an engine that reports each tab as an individual close. */
  userCloseWindow(windowId: number, opts: { reportsWindowClosing?: boolean; windowEvent?: boolean } = {}): void {
    const closing = this.tabs.filter((t) => t.windowId === windowId);
    this.tabs = this.tabs.filter((t) => t.windowId !== windowId);
    this.windows = this.windows.filter((w) => w.id !== windowId);
    for (const t of closing) this.events.tabRemoved.emit(t.id, opts.reportsWindowClosing ?? true, windowId);
    if (opts.windowEvent ?? true) this.events.windowRemoved.emit(windowId);
  }

  /** Session restore: a tab appears with its URL already known. */
  restoreTab(windowId: number, url: string): TabInfo {
    const tab = this.addTab(windowId, { url });
    this.events.tabCreated.emit({ ...tab });
    this.events.tabUpdated.emit({ ...tab }, { status: "complete" });
    return { ...tab };
  }

  async hasHostPermission(_pattern: string): Promise<boolean> {
    return this.hostPermission;
  }

  async ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
    if (!this.alarms.has(name)) this.alarms.set(name, periodInMinutes);
  }

  onAlarm = (cb: (name: string) => void) => this.events.alarm.on(cb);
  onTabCreated = (cb: (tab: TabInfo) => void) => this.events.tabCreated.on(cb);
  onTabRemoved = (cb: (tabId: number, windowClosing: boolean, windowId: number) => void) => this.events.tabRemoved.on(cb);
  onWindowRemoved = (cb: (windowId: number) => void) => this.events.windowRemoved.on(cb);
  onTabUpdated = (cb: (tab: TabInfo, change: { url?: string; status?: string }) => void) => this.events.tabUpdated.on(cb);
  onTabActivated = (cb: (tabId: number, windowId: number) => void) => this.events.tabActivated.on(cb);
  onWindowFocusChanged = (cb: (windowId: number | null) => void) => this.events.windowFocus.on(cb);
  onStartup = (cb: () => void) => this.events.startup.on(cb);
}
