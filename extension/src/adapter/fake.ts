// In-memory BrowserAdapter for tests. Mirrors the behavior the real adapter guarantees:
// created tabs are never active, windows are created unfocused, storage values are cloned.

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
  windows: WindowInfo[] = [];
  tabs: TabInfo[] = [];
  lastFocusedWindowId: number | null = null;
  alarms = new Map<string, number>();
  /** When set, createTab rejects for these URLs. */
  failCreateFor = new Set<string>();
  readonly calls: { method: string; args: unknown[] }[] = [];

  readonly events = {
    alarm: new Emitter<[string]>(),
    tabCreated: new Emitter<[TabInfo]>(),
    tabRemoved: new Emitter<[number, boolean]>(),
    tabUpdated: new Emitter<[TabInfo, { url?: string; status?: string }]>(),
    tabActivated: new Emitter<[number, number]>(),
    windowFocus: new Emitter<[number | null]>(),
  };

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
    return { ...this.addTab(opts.windowId, { url: opts.url, pinned: opts.pinned, active: false }) };
  }

  async createWindow(url: string): Promise<{ windowId: number; tab: TabInfo }> {
    this.calls.push({ method: "createWindow", args: [url] });
    const windowId = this.addWindow();
    // A brand-new window necessarily shows its only tab; the window itself is not focused.
    const tab = this.addTab(windowId, { url, active: true });
    return { windowId, tab: { ...tab } };
  }

  async updateTab(tabId: number, props: { url?: string; pinned?: boolean }): Promise<void> {
    this.calls.push({ method: "updateTab", args: [tabId, props] });
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    if (props.url !== undefined) tab.url = props.url;
    if (props.pinned !== undefined) tab.pinned = props.pinned;
  }

  async removeTab(tabId: number): Promise<void> {
    this.calls.push({ method: "removeTab", args: [tabId] });
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
  }

  async ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
    if (!this.alarms.has(name)) this.alarms.set(name, periodInMinutes);
  }

  onAlarm = (cb: (name: string) => void) => this.events.alarm.on(cb);
  onTabCreated = (cb: (tab: TabInfo) => void) => this.events.tabCreated.on(cb);
  onTabRemoved = (cb: (tabId: number, windowClosing: boolean) => void) => this.events.tabRemoved.on(cb);
  onTabUpdated = (cb: (tab: TabInfo, change: { url?: string; status?: string }) => void) => this.events.tabUpdated.on(cb);
  onTabActivated = (cb: (tabId: number, windowId: number) => void) => this.events.tabActivated.on(cb);
  onWindowFocusChanged = (cb: (windowId: number | null) => void) => this.events.windowFocus.on(cb);
}
