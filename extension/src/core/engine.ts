// Wiring of the automatic sync (PROTOCOL.md "Client behavior (v0.2 automatic sync)"): browser
// events are recorded one at a time, interleaved with runs through a single in-process queue, so
// every read-modify-write of the persisted state is exclusive. The engine holds no sync state of
// its own: everything it decides on is loaded from storage per event.

import type { TabInfo } from "../adapter/types.js";
import { onActivity } from "./activity.js";
import {
  CLOSE_HOLD_MS,
  recordCreated,
  recordRemoved,
  recordUpdated,
  recordWindowRemoved,
  releaseHeld,
  type Ctx,
  type Outcome,
  type TabEvent,
} from "./changes.js";
import { isShareableUrl } from "./eligibility.js";
import { continueHere, handOver, rematchTabs, resetForBrowserStartup } from "./handover.js";
import { withRunLock } from "./lock.js";
import { restoreSnapshot } from "./recovery.js";
import { isPaired, loadState, saveState, type State } from "./state.js";
import { idGen, nowMs, type Deps } from "./store.js";
import { isRetryableKind } from "./status.js";
import { syncRun } from "./sync.js";

/** Local changes are sent about this long after the first one. */
export const SYNC_DEBOUNCE_MS = 2_000;

/** Key in session storage present for the lifetime of one browser session. */
export const SESSION_MARKER = "cts.browserSession";

export const PAUSED_MESSAGE = "Sync is paused. Resume to sync again.";

/** Automatic runs wait for `nextRetryAt` after a failure; the retry timer runs them. */
const BACKED_OFF = new Set(["sync", "alarm"]);

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
  private cancelRelease: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;

  /** `retrySchedule` runs the backoff retries (separate so tests can fire them on their own). */
  constructor(
    readonly deps: Deps,
    private readonly schedule: Scheduler = timeoutScheduler,
    private readonly retrySchedule: Scheduler = schedule,
  ) {}

  /** Subscribe to tab and window events. In a service worker, call synchronously at top level. */
  attach(): void {
    const a = this.deps.adapter;
    a.onTabCreated((tab) => this.event(async (s, ctx) => outcome(recordCreated(s, await this.toEvent(tab), ctx))));
    a.onTabUpdated((tab, change) => {
      if (!isCommitted(tab, change)) return;
      this.event(async (s, ctx) => outcome(recordUpdated(s, await this.toEvent(tab), ctx)));
    });
    a.onTabRemoved((tabId, windowClosing, windowId) =>
      this.event(async (s, ctx) => outcome(recordRemoved(s, tabId, windowClosing, windowId, ctx))),
    );
    a.onWindowRemoved((windowId) => this.event(async (s, ctx) => outcome(recordWindowRemoved(s, windowId, ctx))));
    // A tab the extension just created can become active in its own new window: not the user.
    a.onTabActivated((tabId) =>
      this.event(async (s, ctx) => ({
        patch: {},
        ops: 0,
        activity: !s.expected.some((e) => e.kind === "load" && e.created && e.tabId === tabId && e.until > ctx.now),
      })),
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

  /**
   * Queued run under the persisted run lock; a run that finds the lock held exits (BusyError).
   * Afterwards the retry timer is armed for `nextRetryAt` (set by a failure) or cancelled.
   */
  locked<T>(action: string, fn: () => Promise<T>): Promise<T> {
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
  private async ensureSession(force: boolean | "always" = false): Promise<void> {
    const marker = this.deps.adapter.sessionStorage;
    if (!marker) {
      if (force) await resetForBrowserStartup(this.deps);
      return;
    }
    if (force !== "always" && (await marker.get([SESSION_MARKER]))[SESSION_MARKER] !== undefined) return;
    await resetForBrowserStartup(this.deps);
    await marker.set({ [SESSION_MARKER]: nowMs(this.deps) });
  }

  /**
   * Owner or follower run now (alarm, Sync now, debounced local changes, retry). Paused: nothing
   * runs (Sync now reports it). Automatic runs before `nextRetryAt` wait for the retry timer.
   */
  runNow(action = "sync"): Promise<State> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    return this.locked(action, async () => {
      const s = await loadState(this.deps.adapter.storage);
      if (s.paused) {
        if (action === "syncNow") throw new Error(PAUSED_MESSAGE);
        return s;
      }
      if (BACKED_OFF.has(action) && s.nextRetryAt !== null && s.nextRetryAt > nowMs(this.deps)) return s;
      return syncRun(this.deps);
    });
  }

  /** Debounced run: the first request schedules it, later ones ride along. */
  requestSync(): void {
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
  takeover(action = "takeover"): Promise<State> {
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

  handOver(): Promise<State> {
    return this.locked("handOver", async () => {
      if ((await loadState(this.deps.adapter.storage)).paused) throw new Error(PAUSED_MESSAGE);
      return handOver(this.deps);
    });
  }

  /** Restore a server snapshot (taking over first when not owner), then materialize it. */
  restore(snapshotId: number): Promise<State> {
    return this.locked("restore", async () => {
      if ((await loadState(this.deps.adapter.storage)).paused) throw new Error(PAUSED_MESSAGE);
      return restoreSnapshot(this.deps, snapshotId);
    });
  }

  /** Pause: no runs and no automatic takeover; local changes are still journaled. */
  async pause(): Promise<State> {
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
  async unpause(): Promise<State> {
    await this.enqueue(() => saveState(this.deps.adapter.storage, { paused: false, statusText: null }));
    await this.enqueue(() => this.process((s, ctx) => this.release(s, ctx)));
    return this.runNow("resume");
  }

  /**
   * Browser startup (`browser`): set mappings aside unless already done for this session, start
   * the grace period, catch up shortly after. Extension update (`update`): the same reset always.
   */
  async startup(reason: "browser" | "update" = "browser"): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureSession(reason === "update" ? "always" : true);
      // The tabs are already loaded after an update (no restore events): re-match them now.
      if (reason === "update") await rematchTabs(this.deps);
    });
    this.requestSync();
  }

  /** Worker (re)start: send what an earlier worker journaled, release closes it held, rearm the retry. */
  async resume(): Promise<void> {
    const s = await this.enqueue(async () => {
      await this.ensureSession();
      return loadState(this.deps.adapter.storage);
    });
    if (s.heldCloses.some((h) => !h.done)) this.scheduleRelease(); // journaling continues while paused
    if (s.paused) return;
    if (isPaired(s) && s.generation !== null && s.pending.length > 0) this.requestSync();
    await this.scheduleRetry();
  }

  /** Arm the retry timer for the persisted `nextRetryAt`, or cancel it (success, paused, unpaired). */
  private async scheduleRetry(): Promise<void> {
    const s = await loadState(this.deps.adapter.storage);
    this.cancelRetry?.();
    this.cancelRetry = null;
    if (!isPaired(s) || s.paused || s.nextRetryAt === null) return;
    // A due retry is only armed while the last failure is one a retry can fix.
    if (s.nextRetryAt <= nowMs(this.deps) && !isRetryableKind(s.errorKind)) return;
    this.cancelRetry = this.retrySchedule(
      () => {
        this.cancelRetry = null;
        void this.runNow("retry").catch(ignore);
      },
      Math.max(0, s.nextRetryAt - nowMs(this.deps)),
    );
  }

  /** Release held closes once CLOSE_HOLD_MS has passed (see changes.releaseHeld). */
  private scheduleRelease(): void {
    if (this.cancelRelease) return;
    this.cancelRelease = this.schedule(() => {
      this.cancelRelease = null;
      this.event((s, ctx) => this.release(s, ctx));
    }, CLOSE_HOLD_MS);
  }

  private async release(s: State, ctx: Ctx): Promise<Step> {
    const alive = new Set((await this.deps.adapter.getWindows()).map((w) => w.id));
    const out = releaseHeld(s, alive, ctx);
    if (out.waiting) this.scheduleRelease();
    return outcome(out);
  }

  private event(step: (s: State, ctx: Ctx) => Promise<Step>): void {
    void this.enqueue(() => this.process(step)).catch(ignore);
  }

  /** Load state, apply one event, write all changed fields at once, then schedule follow-ups. */
  private async process(step: (s: State, ctx: Ctx) => Promise<Step>): Promise<void> {
    const storage = this.deps.adapter.storage;
    await this.ensureSession();
    const s = await loadState(storage);
    if (!isPaired(s)) return;
    const now = nowMs(this.deps);
    const out = await step(s, { now, newId: idGen(this.deps) });
    const isOwner = s.generation !== null;
    // Paused: journal only; activity neither takes over nor triggers a run.
    const decision = out.activity && !s.paused ? onActivity(s, { now, isOwner }) : null;
    await saveState(storage, { ...out.patch, ...decision?.patch });
    if (out.patch.heldCloses?.some((h) => !h.done)) this.scheduleRelease();
    if (s.paused) return;
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
