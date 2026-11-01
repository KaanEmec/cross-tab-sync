import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WRITE_GRANULARITY_MS,
  FRESH_IDLE_MS,
  onActivity,
  onDemoted,
  RECENT_ACTIVITY_MS,
  STARTUP_SUPPRESSION_MS,
  TAKEOVER_INTERVAL_MS,
  type ActivityState,
} from "../src/core/activity.js";

const T0 = 10_000_000;
const st = (over: Partial<ActivityState> = {}): ActivityState => ({
  startupAt: null,
  lastActivityAt: null,
  lastActivityKind: null,
  lastTakeoverAt: null,
  suppressAutoTakeover: false,
  freshPending: false,
  ...over,
});

describe("activity", () => {
  it("signals in the startup window are not activity", () => {
    const d = onActivity(st({ startupAt: T0 }), { now: T0 + STARTUP_SUPPRESSION_MS - 1, isOwner: false });
    expect(d).toEqual({ patch: {}, counted: false, fresh: false, takeover: false });
    expect(onActivity(st({ startupAt: T0 }), { now: T0 + STARTUP_SUPPRESSION_MS, isOwner: false }).takeover).toBe(true);
  });

  it("the first signal is fresh and takes over once; continued signals do not", () => {
    const d = onActivity(st(), { now: T0, isOwner: false });
    expect(d).toMatchObject({ fresh: true, takeover: true, patch: { lastActivityAt: T0, lastTakeoverAt: T0 } });
    const after = st({ lastActivityAt: T0, lastTakeoverAt: T0 });
    expect(onActivity(after, { now: T0 + 20_000, isOwner: false }).takeover).toBe(false);
  });

  it("a signal after 60 s of quiet is fresh; the owner does not take over", () => {
    const s = st({ lastActivityAt: T0 });
    expect(onActivity(s, { now: T0 + FRESH_IDLE_MS - 1, isOwner: false }).fresh).toBe(false);
    expect(onActivity(s, { now: T0 + FRESH_IDLE_MS, isOwner: false })).toMatchObject({ fresh: true, takeover: true });
    expect(onActivity(s, { now: T0 + FRESH_IDLE_MS, isOwner: true })).toMatchObject({ fresh: true, takeover: false });
  });

  it("the first signal after losing ownership is fresh", () => {
    const s = st({ lastActivityAt: T0, freshPending: true });
    expect(onActivity(s, { now: T0 + 1000, isOwner: false })).toMatchObject({
      fresh: true,
      takeover: true,
      patch: { freshPending: false },
    });
  });

  it("takeover is rate limited; the deferred interaction takes over after the interval", () => {
    const s = st({ lastActivityAt: T0, lastTakeoverAt: T0, freshPending: true });
    const d = onActivity(s, { now: T0 + 10_000, isOwner: false });
    expect(d).toMatchObject({ fresh: true, takeover: false, patch: { freshPending: true } });
    const later = { ...s, ...d.patch };
    expect(onActivity(later, { now: T0 + TAKEOVER_INTERVAL_MS, isOwner: false }).takeover).toBe(true);
  });

  it("manual Hand over suppresses takeover until a fresh interaction by the idle rule", () => {
    const s = st({ lastActivityAt: T0, suppressAutoTakeover: true, freshPending: true });
    expect(onActivity(s, { now: T0 + 30_000, isOwner: false })).toMatchObject({ fresh: false, takeover: false });
    const d = onActivity(s, { now: T0 + FRESH_IDLE_MS, isOwner: false });
    expect(d).toMatchObject({ fresh: true, takeover: true, patch: { suppressAutoTakeover: false } });
  });

  it("rewrites lastActivityAt only every few seconds", () => {
    const s = st({ lastActivityAt: T0 });
    expect(onActivity(s, { now: T0 + 1000, isOwner: true }).patch).toEqual({});
    expect(onActivity(s, { now: T0 + ACTIVITY_WRITE_GRANULARITY_MS, isOwner: true, kind: "focus" }).patch).toEqual({
      lastActivityAt: T0 + ACTIVITY_WRITE_GRANULARITY_MS,
      lastActivityKind: "focus",
    });
  });

  it("ownership found lost right after a signal here takes over; rate limited it stays pending", () => {
    const s = st({ lastActivityAt: T0, lastTakeoverAt: T0 - TAKEOVER_INTERVAL_MS, freshPending: true });
    expect(onDemoted(s, T0 + RECENT_ACTIVITY_MS - 1)).toEqual({ patch: { lastTakeoverAt: T0 + RECENT_ACTIVITY_MS - 1, freshPending: false }, takeover: true });
    expect(onDemoted(s, T0 + RECENT_ACTIVITY_MS)).toEqual({ patch: {}, takeover: false });
    expect(onDemoted(st({ freshPending: true }), T0)).toEqual({ patch: {}, takeover: false });
    const limited = st({ lastActivityAt: T0, lastTakeoverAt: T0 - 1000, freshPending: true });
    expect(onDemoted(limited, T0 + 1000)).toEqual({ patch: { freshPending: true }, takeover: false });
  });
});
