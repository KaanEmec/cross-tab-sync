// Automatic ownership (PROTOCOL.md "Automatic ownership"). Pure: decides whether an activity
// signal is a fresh interaction and whether it triggers a takeover.

/** Signals right after browser startup come from session restore, not the user. */
export const STARTUP_SUPPRESSION_MS = 10_000;
/** A signal after this much quiet is a fresh interaction. */
export const FRESH_IDLE_MS = 60_000;
/** At most one takeover attempt per this interval. */
export const TAKEOVER_INTERVAL_MS = 30_000;
/** `lastActivityAt` is only rewritten when it moved by this much (fewer storage writes). */
export const ACTIVITY_WRITE_GRANULARITY_MS = 5_000;
/** A run that finds ownership lost takes over at once when the last signal is this recent. */
export const RECENT_ACTIVITY_MS = 15_000;

export interface ActivityState {
  startupAt: number | null;
  lastActivityAt: number | null;
  lastTakeoverAt: number | null;
  suppressAutoTakeover: boolean;
  freshPending: boolean;
}

export interface Decision {
  patch: Partial<ActivityState>;
  /** Counted as activity at all (false inside the startup window). */
  counted: boolean;
  fresh: boolean;
  takeover: boolean;
}

const within = (since: number | null, now: number, ms: number) => since !== null && now >= since && now - since < ms;

/**
 * Evaluate one activity signal: a tab activated (not one the extension created), focus moving to a
 * normal window, or a user-created tab with an eligible URL. Navigation and page loads are never
 * signals (restored tabs finish loading long after startup). Callers never pass heartbeats or
 * events caused by remote application.
 *
 * Fresh interaction: no signal for FRESH_IDLE_MS, or the first signal after ownership was lost
 * (`freshPending`). After a manual Hand over (`suppressAutoTakeover`, with the hand over counted as
 * the latest interaction) only the idle rule makes a signal fresh. A fresh signal on a non-owner
 * takes over unless the last attempt was less than TAKEOVER_INTERVAL_MS ago; a rate-limited fresh
 * interaction stays pending so the next signal after the interval takes over.
 */
export function onActivity(s: ActivityState, ctx: { now: number; isOwner: boolean }): Decision {
  const { now } = ctx;
  if (within(s.startupAt, now, STARTUP_SUPPRESSION_MS)) return { patch: {}, counted: false, fresh: false, takeover: false };

  const idle = s.lastActivityAt === null || now - s.lastActivityAt >= FRESH_IDLE_MS;
  const fresh = idle || (s.freshPending && !s.suppressAutoTakeover);
  const patch: Partial<ActivityState> = {};
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

/**
 * A run found this device no longer owner (`409 stale_owner`). If the user was active here within
 * RECENT_ACTIVITY_MS, the signal that triggered the run was the user coming back: take over now
 * instead of waiting for another signal. Rate limited like `onActivity`; a rate-limited takeover
 * stays pending (`freshPending`).
 */
export function onDemoted(s: ActivityState, now: number): { patch: Partial<ActivityState>; takeover: boolean } {
  if (!within(s.lastActivityAt, now, RECENT_ACTIVITY_MS)) return { patch: {}, takeover: false };
  if (within(s.lastTakeoverAt, now, TAKEOVER_INTERVAL_MS)) return { patch: { freshPending: true }, takeover: false };
  return { patch: { lastTakeoverAt: now, freshPending: false }, takeover: true };
}
