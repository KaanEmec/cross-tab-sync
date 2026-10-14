// Wiring of the automatic sync (PROTOCOL.md "Client behavior (v0.2 automatic sync)"): browser
// events are recorded one at a time, interleaved with runs through a single in-process queue, so
// every read-modify-write of the persisted state is exclusive. The engine holds no sync state of
// its own: everything it decides on is loaded from storage per event.

import type { TabInfo } from "../adapter/types.js";
import { onActivity, onDemoted, type ActivityKind } from "./activity.js";
import { diag, errText, flushDiag, refreshDiagnostics, setDiagSink } from "./diag.js";
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
import { idGen, keyBlocked, nowMs, type Deps } from "./store.js";
import { isRetryableKind, KEY_MISMATCH_MESSAGE } from "./status.js";
import { syncRun } from "./sync.js";

/** Local changes are sent about this long after the first one. */
export const SYNC_DEBOUNCE_MS = 2_000;
/**
 * Any counted activity signal makes an owner verify its ownership at most this often (Safari does
 * not reliably report window focus when the app is activated, so focus alone is not enough).
 */
export const VERIFY_INTERVAL_MS = 10_000;

/**
 * After a startup reset the open tabs are re-matched by URL at once and again after these delays:
 * Safari restores tabs lazily (no tab events until a tab is activated) and restores can trickle in.
 */
export const REMATCH_DELAYS_MS = [5_000, 30_000];

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

/** Swallow an error the caller cannot act on; traced when diagnostics are on. */
const ignore = (e?: unknown) => {
  if (e !== undefined) diag(`caught ${errText(e)}`);
};

/** A URL the page committed: load complete, or a URL change on an already loaded page (in-page navigation). */
export function isCommitted(tab: TabInfo, change: { url?: string; status?: string }): boolean {
  return change.status === "complete" || (change.url !== undefined && tab.status === "complete");
}

function outcome(o: Outcome, kind?: ActivityKind): Step {
  return { patch: o.patch, ops: o.ops.length, activity: o.activity, kind };
}

/** Takeover decision for the diagnostics trace. */
function activityText(s: State, isOwner: boolean, d: ReturnType<typeof onActivity> | null): string {
  if (!d) return "paused";
  if (!d.counted) return "not counted (startup)";
  if (d.takeover) return "fresh, takeover";
  if (!d.fresh) return s.suppressAutoTakeover && !isOwner ? "not fresh (suppressed after hand over)" : "not fresh";
  return isOwner ? "fresh, owner" : "fresh, takeover rate-limited (pending)";
}

interface Step {
  patch: Partial<State>;
  /** Number of journaled operations. */
  ops: number;
  activity: boolean;
  /** What kind of activity signal (diagnostics). */
  kind?: ActivityKind;
}

export class SyncEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private cancelTimer: (() => void) | null = null;
  private cancelRelease: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  /**
   * Last ownership verification started by an activity signal. In memory only: a restarted worker
   * may verify once more, which costs one empty batch.
   */
  private lastVerifyAt = -Infinity;

  /**
   * `retrySchedule` runs the backoff retries and `rematchSchedule` the delayed re-matches after a
   * startup reset (separate so tests can fire them on their own).
   */
  constructor(
    readonly deps: Deps,
    private readonly schedule: Scheduler = timeoutScheduler,
    private readonly retrySchedule: Scheduler = schedule,
    private readonly rematchSchedule: Scheduler = schedule,
  ) {
    // Server copy of the diagnostics trace (only sent while diagnostics are on).
    setDiagSink(async (lines) => {
      const s = await loadState(deps.adapter.storage);
      if (isPaired(s)) await deps.api({ baseUrl: s.serverUrl, token: s.token }).postDiag(lines);
    });
  }

  /** Subscribe to tab and window events. In a service worker, call synchronously at top level. */
  attach(): void {
    const a = this.deps.adapter;
    a.onTabCreated((tab) =>
      this.event(`created tab=${tab.id} win=${tab.windowId}`, async (s, ctx) =>
        outcome(recordCreated(s, await this.toEvent(tab, s.serverUrl), ctx), "created"),
      ),
    );
    a.onTabUpdated((tab, change) => {
      if (!isCommitted(tab, change)) return;
      this.event(`updated tab=${tab.id} win=${tab.windowId} status=${change.status ?? "-"}`, async (s, ctx) =>
        outcome(recordUpdated(s, await this.toEvent(tab, s.serverUrl), ctx)),
      );
    });
    a.onTabRemoved((tabId, windowClosing, windowId) =>
      this.event(`removed tab=${tabId} win=${windowId} windowClosing=${windowClosing}`, async (s, ctx) =>
        outcome(recordRemoved(s, tabId, windowClosing, windowId, ctx)),
      ),
    );
    a.onWindowRemoved((windowId) =>
      this.event(`windowRemoved win=${windowId}`, async (s, ctx) => outcome(recordWindowRemoved(s, windowId, ctx))),
    );
    // A tab the extension just created can become active in its own new window: not the user.
    a.onTabActivated((tabId, windowId) =>
      this.event(`activated tab=${tabId} win=${windowId}`, async (s, ctx) => ({
        patch: {},
        ops: 0,
        activity: !s.expected.some((e) => e.kind === "load" && e.created && e.tabId === tabId && e.until > ctx.now),
        kind: "activated",
      })),
    );
    a.onWindowFocusChanged((windowId) => {
      if (windowId !== null) this.event(`focus win=${windowId}`, (s) => this.focused(s, windowId));
    });
    a.onStartup(() => {
      diag("onStartup");
      void this.startup().catch(ignore);
    });
  }

  /** True while anything is queued or running. */
  get busy(): boolean {
    return this.depth > 0;
  }

  /** Run `fn` after everything queued before it. `label` names the task in the diagnostics trace. */
  enqueue<T>(fn: () => Promise<T>, label = "task"): Promise<T> {
    this.depth++;
    const run = this.chain.then(async () => {
      await refreshDiagnostics(this.deps.adapter.storage).catch(() => undefined);
      const started = Date.now();
      diag(`task ${label} start`);
      try {
        return await fn();
      } finally {
        diag(`task ${label} end ${Date.now() - started}ms`);
        flushDiag();
      }
    });
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
      } catch (e) {
        diag(`${action} failed: ${errText(e)}`);
        throw e;
      } finally {
        await this.scheduleRetry().catch(ignore);
      }
    }, action);
  }

  /**
   * Tab ids from a previous browser session must never be read against the current tabs, and
   * restored tabs' events can arrive before runtime.onStartup. So every queued task first checks a
   * marker in session storage (cleared when the browser exits) and runs the startup reset when it
   * is missing. Without session storage, only runtime.onStartup resets. After a reset the open
   * tabs are re-matched by URL (tabs.query reports URLs of restored tabs that never loaded and send
   * no events, as in Safari) now and after REMATCH_DELAYS_MS; restored tabs' events still re-match
   * on their own during the stale-mapping window.
   */
  private async ensureSession(force: boolean | "always" = false): Promise<void> {
    const marker = this.deps.adapter.sessionStorage;
    if (!marker) {
      if (force) await this.reset(force === "always" ? "update" : "onStartup (no session storage)");
      return;
    }
    if (force !== "always" && (await marker.get([SESSION_MARKER]))[SESSION_MARKER] !== undefined) return;
    await this.reset(force === "always" ? "update" : "session marker missing");
    await marker.set({ [SESSION_MARKER]: nowMs(this.deps) });
  }

  private async reset(reason: string): Promise<void> {
    diag(`startup reset: ${reason}`);
    await resetForBrowserStartup(this.deps);
    await rematchTabs(this.deps);
    for (const ms of REMATCH_DELAYS_MS) {
      this.rematchSchedule(() => {
        void this.enqueue(async () => {
          await this.ensureSession();
          await rematchTabs(this.deps);
        }, `rematch +${ms}ms`).catch(ignore);
      }, ms);
    }
  }

  /**
   * Owner or follower run now (alarm, Sync now, debounced local changes, retry, `verify` after
   * activity while owner). Paused: nothing runs (Sync now reports it). Automatic runs
   * before `nextRetryAt` wait for the retry timer. A run that finds ownership lost takes over right
   * after it when the user was active here moments ago (activity.onDemoted).
   */
  runNow(action = "sync"): Promise<State> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    return this.locked(action, async () => {
      const s = await loadState(this.deps.adapter.storage);
      if (s.paused) {
        diag(`run ${action} skipped: paused`);
        if (action === "syncNow") throw new Error(PAUSED_MESSAGE);
        return s;
      }
      // Another key: nothing runs automatically until the browser pairs again; Sync now says why.
      if (keyBlocked(s)) {
        diag(`run ${action} skipped: key`);
        if (action === "syncNow") throw new Error(s.lastError ?? KEY_MISMATCH_MESSAGE);
        return s;
      }
      if (BACKED_OFF.has(action) && s.nextRetryAt !== null && s.nextRetryAt > nowMs(this.deps)) {
        diag(`run ${action} skipped: backing off`);
        return s;
      }
      diag(`run ${action} start as ${s.generation !== null ? "owner" : "follower"} pending=${s.pending.length}`);
      try {
        const out = await syncRun(this.deps);
        diag(`run ${action} end: ${out.statusText ?? "-"}; error: ${out.lastError ?? "none"}`);
        return out;
      } finally {
        if (s.generation !== null) await this.afterDemotion().catch(ignore);
      }
    });
  }

  /** Called after a run that started as owner: take over again if it demoted a device in use. */
  private async afterDemotion(): Promise<void> {
    const storage = this.deps.adapter.storage;
    const s = await loadState(storage);
    if (!isPaired(s) || s.paused || s.generation !== null) return;
    const d = onDemoted(s, nowMs(this.deps));
    diag(`demoted: ${d.takeover ? "taking over" : d.patch.freshPending ? "takeover rate-limited, pending" : "no recent activity, following"}`);
    await saveState(storage, d.patch);
    // Queued behind this run, so it starts once the run lock is released.
    if (d.takeover) void this.takeover().catch(ignore);
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
      diag(`${action}${s.paused ? " skipped: paused" : ""}`);
      if (s.paused) {
        if (action === "takeover") return s;
        throw new Error(PAUSED_MESSAGE);
      }
      // Another key: never acquire. Manual Continue here shows the message instead.
      if (keyBlocked(s)) {
        if (action === "takeover") return s;
        throw new Error(s.lastError ?? KEY_MISMATCH_MESSAGE);
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
    }, "pause");
  }

  /**
   * Resume: release held closes first (those whose windows are gone are dropped, never sent; a
   * tab that is merely absent is only unmapped by the run), then run in the current role.
   */
  async unpause(): Promise<State> {
    await this.enqueue(() => saveState(this.deps.adapter.storage, { paused: false, statusText: null }), "resume sync");
    await this.enqueue(() => this.process((s, ctx) => this.release(s, ctx)), "release held closes");
    return this.runNow("resume");
  }

  /**
   * Browser startup (`browser`): set mappings aside unless already done for this session, start
   * the grace period, re-match the open tabs by URL, catch up shortly after. Extension update
   * (`update`): the same reset always (the tabs are already loaded and send no restore events).
   */
  async startup(reason: "browser" | "update" = "browser"): Promise<void> {
    await this.enqueue(() => this.ensureSession(reason === "update" ? "always" : true), `startup ${reason}`);
    this.requestSync();
  }

  /** Worker (re)start: send what an earlier worker journaled, release closes it held, rearm the retry. */
  async resume(): Promise<void> {
    const s = await this.enqueue(async () => {
      await this.ensureSession();
      return loadState(this.deps.adapter.storage);
    }, "worker resume");
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
      this.event("release held closes", (s, ctx) => this.release(s, ctx));
    }, CLOSE_HOLD_MS);
  }

  private async release(s: State, ctx: Ctx): Promise<Step> {
    const alive = new Set((await this.deps.adapter.getWindows()).map((w) => w.id));
    const out = releaseHeld(s, alive, ctx);
    if (out.waiting) this.scheduleRelease();
    return outcome(out);
  }

  private event(label: string, step: (s: State, ctx: Ctx) => Promise<Step>): void {
    diag(`event ${label}`);
    void this.enqueue(() => this.process(step), label).catch(ignore);
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
    const decision = out.activity && !s.paused ? onActivity(s, { now, isOwner, kind: out.kind }) : null;
    if (out.activity) diag(`activity ${out.kind ?? "-"}: ${activityText(s, isOwner, decision)}`);
    await saveState(storage, { ...out.patch, ...decision?.patch });
    if (out.patch.heldCloses?.some((h) => !h.done)) this.scheduleRelease();
    if (s.paused) return;
    if (decision?.takeover) void this.takeover().catch(ignore);
    // Any counted signal (at most every VERIFY_INTERVAL_MS, regardless of the idle rule; a fresh
    // interaction always) makes an owner verify its ownership at once (empty batch when nothing is
    // pending): if another device took over, the run's 409 stale_owner demotes and the takeover
    // follows (afterDemotion).
    else if (isOwner && (decision?.fresh || (decision?.counted && now - this.lastVerifyAt >= VERIFY_INTERVAL_MS))) {
      this.lastVerifyAt = now;
      diag(`verify ownership (${decision?.fresh ? "fresh interaction" : "activity"})`);
      void this.runNow("verify").catch(ignore);
    } else if (isOwner && out.ops > 0) this.requestSync();
  }

  private async toEvent(tab: TabInfo, serverUrl: string): Promise<TabEvent> {
    let eligible = !tab.incognito && isShareableUrl(tab.url, serverUrl);
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
  private async focused(s: State, windowId: number): Promise<Step> {
    const w = (await this.deps.adapter.getWindows()).find((x) => x.id === windowId);
    const normal = w !== undefined && w.type === "normal";
    const receiving = normal && !w.incognito && s.receivingWindowId !== w.id;
    return { patch: receiving ? { receivingWindowId: w.id } : {}, ops: 0, activity: normal, kind: "focus" };
  }
}
