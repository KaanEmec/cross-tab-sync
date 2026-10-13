// Wiring of the automatic sync (PROTOCOL.md "Client behavior (v0.2 automatic sync)"): browser
// events are recorded one at a time, interleaved with runs through a single in-process queue, so
// every read-modify-write of the persisted state is exclusive. The engine holds no sync state of
// its own: everything it decides on is loaded from storage per event.

import type { TabInfo } from "../adapter/types.js";
import { onActivity } from "./activity.js";
import { recordCreated, recordRemoved, recordUpdated, type Ctx, type Outcome, type TabEvent } from "./changes.js";
import { isShareableUrl } from "./eligibility.js";
import { continueHere, handOver, resetForBrowserStartup } from "./handover.js";
import { BusyError, withRunLock } from "./lock.js";
import { isPaired, loadState, saveState, type State } from "./state.js";
import { idGen, nowMs, type Deps } from "./store.js";
import { syncRun } from "./sync.js";

/** Local changes are sent about this long after the first one. */
export const SYNC_DEBOUNCE_MS = 2_000;

/** Schedules `fn` after `ms`; returns a cancel function. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

const timeoutScheduler: Scheduler = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

const ignore = () => undefined;

/** A URL the page committed: load complete, or a URL change on an already loaded page (in-page navigation). */
export function isCommitted(tab: TabInfo, change: { url?: string; status?: string }): boolean {
  return change.status === "complete" || (change.url !== undefined && tab.status === "complete");
}

function outcome(o: Outcome): Step {
  return { patch: o.patch, ops: o.ops.length, activity: o.activity };
}

interface Step {
  patch: Partial<State>;
  /** Number of journaled operations. */
  ops: number;
  activity: boolean;
}

export class SyncEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private cancelTimer: (() => void) | null = null;

  constructor(
    readonly deps: Deps,
    private readonly schedule: Scheduler = timeoutScheduler,
  ) {}

  /** Subscribe to tab and window events. In a service worker, call synchronously at top level. */
  attach(): void {
    const a = this.deps.adapter;
    a.onTabCreated((tab) => this.event(async (s, ctx) => outcome(recordCreated(s, await this.toEvent(tab), ctx))));
    a.onTabUpdated((tab, change) => {
      if (!isCommitted(tab, change)) return;
      this.event(async (s, ctx) => outcome(recordUpdated(s, await this.toEvent(tab), ctx)));
    });
    a.onTabRemoved((tabId, windowClosing) => this.event(async (s, ctx) => outcome(recordRemoved(s, tabId, windowClosing, ctx))));
    // A tab the extension just created can become active in its own new window: not the user.
    a.onTabActivated((tabId) =>
      this.event(async (s) => ({ patch: {}, ops: 0, activity: !s.expected.some((e) => e.kind === "load" && e.tabId === tabId) })),
    );
    a.onWindowFocusChanged((windowId) => {
      if (windowId !== null) this.event((s) => this.focused(s, windowId));
    });
    a.onStartup(() => void this.startup().catch(ignore));
  }

  /** True while anything is queued or running. */
  get busy(): boolean {
    return this.depth > 0;
  }

  /** Run `fn` after everything queued before it. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const run = this.chain.then(fn);
    const done = () => {
      this.depth--;
    };
    this.chain = run.then(done, done);
    return run;
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.depth > 0) await this.chain;
  }

  /** Queued run under the persisted run lock; a run that finds the lock held exits (BusyError). */
  locked<T>(action: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(() => withRunLock(this.deps.adapter.storage, action, fn, () => nowMs(this.deps)));
  }

  /** Owner or follower run now (alarm, Sync now, debounced local changes). */
  runNow(action = "sync"): Promise<State> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    return this.locked(action, () => syncRun(this.deps));
  }

  /** Debounced run: the first request schedules it, later ones ride along. */
  requestSync(): void {
    if (this.cancelTimer) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      void this.runNow().catch(ignore);
    }, SYNC_DEBOUNCE_MS);
  }

  /** Continue here (manual or automatic). A failed attempt keeps the interaction fresh for a retry. */
  takeover(action = "takeover"): Promise<State> {
    return this.locked(action, async () => {
      try {
        return await continueHere(this.deps);
      } catch (e) {
        await saveState(this.deps.adapter.storage, { freshPending: true });
        throw e;
      }
    });
  }

  handOver(): Promise<State> {
    return this.locked("handOver", () => handOver(this.deps));
  }

  /** Browser startup: set mappings aside, start the grace period, catch up shortly after. */
  async startup(): Promise<void> {
    await this.enqueue(() => resetForBrowserStartup(this.deps));
    this.requestSync();
  }

  /** Worker (re)start: send what an earlier worker journaled but did not get to send. */
  async resume(): Promise<void> {
    const s = await this.enqueue(() => loadState(this.deps.adapter.storage));
    if (isPaired(s) && s.generation !== null && s.pending.length > 0) this.requestSync();
  }

  private event(step: (s: State, ctx: Ctx) => Promise<Step>): void {
    void this.enqueue(() => this.process(step)).catch(ignore);
  }

  /** Load state, apply one event, write all changed fields at once, then schedule follow-ups. */
  private async process(step: (s: State, ctx: Ctx) => Promise<Step>): Promise<void> {
    const storage = this.deps.adapter.storage;
    const s = await loadState(storage);
    if (!isPaired(s)) return;
    const now = nowMs(this.deps);
    const out = await step(s, { now, newId: idGen(this.deps) });
    const isOwner = s.generation !== null;
    const decision = out.activity ? onActivity(s, { now, isOwner }) : null;
    await saveState(storage, { ...out.patch, ...decision?.patch });
    if (decision?.takeover) void this.takeover().catch(ignore);
    else if (isOwner && (out.ops > 0 || decision?.fresh)) this.requestSync();
  }

  private async toEvent(tab: TabInfo): Promise<TabEvent> {
    let eligible = !tab.incognito && isShareableUrl(tab.url);
    if (eligible) {
      const w = (await this.deps.adapter.getWindows()).find((x) => x.id === tab.windowId);
      eligible = Boolean(w && w.type === "normal" && !w.incognito);
    }
    return { id: tab.id, url: tab.url, pinned: tab.pinned, active: tab.active, eligible };
  }

  /** Remember the last focused normal window: it receives tabs created by application. */
  private async focused(s: State, windowId: number): Promise<Step> {
    const w = (await this.deps.adapter.getWindows()).find((x) => x.id === windowId);
    const receiving = w && w.type === "normal" && !w.incognito && s.receivingWindowId !== w.id;
    return { patch: receiving ? { receivingWindowId: w.id } : {}, ops: 0, activity: true };
  }
}
