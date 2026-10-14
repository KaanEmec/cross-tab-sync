import { describe, expect, it } from "vitest";
import {
  BURST_REMOVALS,
  CLOSE_HOLD_MS,
  EXPECT_TTL_MS,
  LOAD_GRACE_MS,
  recordCreated,
  recordRemoved,
  recordUpdated,
  recordWindowRemoved,
  releaseHeld,
  STALE_MAPPINGS_TTL_MS,
  STARTUP_GRACE_MS,
  type LocalState,
  type Outcome,
  type TabEvent,
} from "../src/core/changes.js";
import { list } from "../src/core/journal.js";
import { emptyMappings, setMapping, tabsForEntry, type Mappings } from "../src/core/mapping.js";

const T0 = 1_000_000;

function ctx(now = T0) {
  let n = 0;
  return { now, newId: () => `id${++n}` };
}

const state = (over: Partial<LocalState> = {}): LocalState => ({
  mappings: emptyMappings(),
  staleMappings: null,
  pending: [],
  expected: [],
  detached: {},
  startupAt: null,
  heldCloses: [],
  removedWindows: {},
  ...over,
});

const tab = (id: number, url?: string, over: Partial<TabEvent> = {}): TabEvent => ({
  id,
  url,
  pinned: false,
  active: false,
  eligible: Boolean(url?.startsWith("http")),
  ...over,
});

const next = (s: LocalState, o: Outcome): LocalState => ({ ...s, ...o.patch });

function mapped(pairs: [number, string, string][]): Mappings {
  let m = emptyMappings();
  for (const [id, entry, url] of pairs) m = setMapping(m, id, entry, url);
  return m;
}

describe("additions", () => {
  it("journals one open per distinct URL; a duplicate copy joins the entry without an operation", () => {
    let s = state();
    const a = recordUpdated(s, tab(1, "https://x/"), ctx());
    expect(a.ops).toEqual([{ opId: "id2", type: "open", entryId: "id1", url: "https://x/", pinned: false }]);
    s = next(s, a);
    const b = recordUpdated(s, tab(2, "https://x/"), ctx());
    expect(b.ops).toEqual([]);
    s = next(s, b);
    expect(tabsForEntry(s.mappings, "id1").sort()).toEqual([1, 2]);
    s = next(s, recordUpdated(s, tab(3, "https://y/"), { now: T0, newId: (() => { let n = 10; return () => `id${++n}`; })() }));
    expect(list(s.pending).map((o) => o.type === "open" && o.url)).toEqual(["https://x/", "https://y/"]);
  });

  it("a created tab with a URL is an addition and activity; without an eligible one it waits for onUpdated and is not", () => {
    const withUrl = recordCreated(state(), tab(1, "https://x/"), ctx());
    expect(withUrl.ops).toHaveLength(1);
    expect(withUrl.activity).toBe(true);
    const blank = recordCreated(state(), tab(2, undefined), ctx());
    expect(blank).toEqual({ patch: {}, ops: [], activity: false });
    for (const url of ["chrome://newtab/", "chrome-extension://abc/popup.html", "about:blank"]) {
      expect(recordCreated(state(), tab(3, url), ctx()).activity).toBe(false);
    }
  });

  it("ignores tabs the run already mapped, and ineligible URLs", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    expect(recordCreated(s, tab(1, "https://x/"), ctx())).toEqual({ patch: {}, ops: [], activity: false });
    expect(recordUpdated(state(), tab(2, "chrome://newtab/"), ctx()).ops).toEqual([]);
    expect(recordUpdated(state(), tab(3, "https://private/", { eligible: false }), ctx()).ops).toEqual([]);
  });

  it("navigation and page loads are never activity, not even in the active tab", () => {
    expect(recordUpdated(state(), tab(1, "https://x/"), ctx()).activity).toBe(false);
    expect(recordUpdated(state(), tab(1, "https://x/", { active: true }), ctx()).activity).toBe(false);
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    expect(recordUpdated(s, tab(1, "https://x/", { active: true }), ctx()).activity).toBe(false); // load complete
    expect(recordUpdated(s, tab(1, "https://x/y", { active: true }), ctx()).activity).toBe(false);
  });
});

const W = 1;
const alive = new Set([W]);
/** Remove a tab individually, then release held closes after the hold. */
function closeTab(s: LocalState, tabId: number, at = T0): { s: LocalState; ops: Outcome["ops"] } {
  const removed = next(s, recordRemoved(s, tabId, false, W, ctx(at)));
  const released = releaseHeld(removed, alive, ctx(at + CLOSE_HOLD_MS));
  return { s: next(removed, released), ops: released.ops };
}

describe("closures", () => {
  const two = () => state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"]]) });

  it("closing one of two copies emits nothing; closing the last emits close after the hold", () => {
    const first = closeTab(two(), 1);
    expect(first.ops).toEqual([]);
    const removed = recordRemoved(first.s, 2, false, W, ctx(T0 + 5000));
    expect(removed.ops).toEqual([]); // held, not journaled yet
    const s = next(first.s, removed);
    expect(releaseHeld(s, alive, ctx(T0 + 5000 + CLOSE_HOLD_MS - 1))).toMatchObject({ ops: [], waiting: true });
    const released = releaseHeld(s, alive, ctx(T0 + 5000 + CLOSE_HOLD_MS));
    expect(released.ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    expect(released.waiting).toBe(false);
    expect(next(s, released).mappings.tabs).toEqual({});
  });

  it("window closure only unmaps", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    const o = recordRemoved(s, 1, true, W, ctx());
    expect(o.ops).toEqual([]);
    expect(next(s, o).mappings.tabs).toEqual({});
    expect(next(s, o).heldCloses).toEqual([]);
  });

  it("a burst made only of copies of one entry is one closure (Safari pinned tab in every window)", () => {
    const copies = state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"], [3, "E", "https://x/"]]) });
    // Reported from three windows, or all from the window where it was closed.
    for (const windows of [[1, 2, 3], [W, W, W]]) {
      let s = copies;
      for (const [i, id] of [1, 2, 3].entries()) s = next(s, recordRemoved(s, id, false, windows[i]!, ctx(T0 + i)));
      const released = releaseHeld(s, new Set([1, 2, 3]), ctx(T0 + 2 + CLOSE_HOLD_MS));
      expect(released.ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    }
    // One other entry in the burst makes it a window closing again.
    let mixed = state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"], [3, "F", "https://y/"]]) });
    for (const [i, id] of [1, 2, 3].entries()) mixed = next(mixed, recordRemoved(mixed, id, false, W, ctx(T0 + i)));
    expect(releaseHeld(mixed, alive, ctx(T0 + 2 + CLOSE_HOLD_MS)).ops).toEqual([]);
  });

  it("held closes are dropped when the window is gone, was reported removed, or closed in a burst", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"], [2, "F", "https://y/"], [3, "G", "https://z/"]]) });
    expect(closeTab(s, 1).ops).toHaveLength(1);
    const removed = next(s, recordRemoved(s, 1, false, W, ctx()));
    expect(releaseHeld(removed, new Set(), ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([]);
    const reported = next(removed, recordWindowRemoved(removed, W, ctx(T0 + 10)));
    expect(releaseHeld(reported, alive, ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([]);

    let burst = s;
    for (const [i, id] of [1, 2, 3].entries()) burst = next(burst, recordRemoved(burst, id, false, W, ctx(T0 + i * 300)));
    expect(BURST_REMOVALS).toBe(3);
    // Released in two steps: the early removal still counts toward the burst.
    const early = releaseHeld(burst, alive, ctx(T0 + CLOSE_HOLD_MS));
    expect(early.ops).toEqual([]);
    expect(releaseHeld(next(burst, early), alive, ctx(T0 + 600 + CLOSE_HOLD_MS)).ops).toEqual([]);
  });

  it("removals during the startup grace only unmap", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), startupAt: T0 });
    expect(next(s, recordRemoved(s, 1, false, W, ctx(T0 + STARTUP_GRACE_MS - 1))).heldCloses).toEqual([]);
    expect(closeTab(s, 1, T0 + STARTUP_GRACE_MS).ops).toHaveLength(1);
  });

  it("unmapped tabs produce nothing", () => {
    expect(recordRemoved(state(), 9, false, W, ctx())).toEqual({ patch: {}, ops: [], activity: false });
  });
});

describe("navigation", () => {
  it("single copy: navigate, mapping follows", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    const o = recordUpdated(s, tab(1, "https://x/next?q=1#f", { active: true }), ctx());
    expect(o.ops).toEqual([{ opId: "id1", type: "navigate", entryId: "E", url: "https://x/next?q=1#f" }]);
    expect(next(s, o).mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/next?q=1#f" });
    expect(o.activity).toBe(false);
  });

  it("one of several copies: detaches and is a fresh open", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"]]) });
    const o = recordUpdated(s, tab(1, "https://y/"), ctx());
    expect(o.ops).toEqual([{ opId: "id2", type: "open", entryId: "id1", url: "https://y/", pinned: false }]);
    const after = next(s, o);
    expect(after.mappings.tabs["1"]?.entryId).toBe("id1");
    expect(tabsForEntry(after.mappings, "E")).toEqual([2]);
  });

  it("onto a URL already mapped: joins that entry and closes the old one if it was the last copy", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"], [2, "F", "https://y/"]]) });
    const o = recordUpdated(s, tab(1, "https://y/"), ctx());
    expect(o.ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    expect(next(s, o).mappings.tabs["1"]).toEqual({ entryId: "F", url: "https://y/" });

    const withCopy = state({ mappings: mapped([[1, "E", "https://x/"], [3, "E", "https://x/"], [2, "F", "https://y/"]]) });
    expect(recordUpdated(withCopy, tab(1, "https://y/"), ctx()).ops).toEqual([]);
  });

  it("navigating to a browser page keeps the mapping and publishes nothing", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    expect(recordUpdated(s, tab(1, "about:blank"), ctx())).toEqual({ patch: {}, ops: [], activity: false });
  });
});

describe("echo suppression", () => {
  it("a load started by the extension is not navigation, redirects and later rewrites included", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), expected: [{ kind: "load", tabId: 1, until: T0 + 1 }] });
    const o = recordUpdated(s, tab(1, "https://x/redirected", { active: true }), ctx());
    expect(o.ops).toEqual([]);
    expect(o.activity).toBe(false);
    let after = next(s, o);
    // Kept for a grace period after the first committed event, remembering the server URL.
    expect(after.expected).toEqual([{ kind: "load", tabId: 1, until: T0 + LOAD_GRACE_MS, completed: true }]);
    expect(after.mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/redirected", base: "https://x/" });
    const rewrite = recordUpdated(after, tab(1, "https://x/redirected#tab=2"), ctx(T0 + LOAD_GRACE_MS - 1));
    expect(rewrite.ops).toEqual([]);
    after = next(after, rewrite);
    expect(after.expected[0]).toMatchObject({ until: T0 + LOAD_GRACE_MS }); // not extended
    // After the grace a user navigation is recorded, based on the server URL.
    const user = recordUpdated(after, tab(1, "https://elsewhere/"), ctx(T0 + LOAD_GRACE_MS));
    expect(user.ops).toEqual([{ opId: "id1", type: "navigate", entryId: "E", url: "https://elsewhere/" }]);
    expect(next(after, user).pending[0]?.base).toBe("https://x/");
  });

  it("a tab the extension is removing (still listed, removal is asynchronous) is never an addition", () => {
    const s = state({ expected: [{ kind: "remove", tabId: 1, until: T0 + 1 }] });
    expect(recordCreated(s, tab(1, "https://x/"), ctx())).toEqual({ patch: {}, ops: [], activity: false });
    expect(recordUpdated(s, tab(1, "https://x/"), ctx())).toEqual({ patch: {}, ops: [], activity: false });
  });

  it("a removal by the extension does not close the entry", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), expected: [{ kind: "remove", tabId: 1, until: T0 + 1 }] });
    const o = recordRemoved(s, 1, false, W, ctx());
    expect(o.ops).toEqual([]);
    expect(next(s, o).expected).toEqual([]);
    expect(next(s, o).heldCloses).toEqual([]);
  });

  it("a create announced by URL maps the tab to its entry when the run could not", () => {
    const s = state({ expected: [{ kind: "create", url: "https://x/", entryId: "E", until: T0 + 1 }] });
    const o = recordUpdated(s, tab(7, "https://x/"), ctx());
    expect(o.ops).toEqual([]);
    const after = next(s, o);
    expect(after.mappings.tabs["7"]?.entryId).toBe("E");
    expect(after.expected).toEqual([{ kind: "load", tabId: 7, until: T0 + EXPECT_TTL_MS }]);
  });

  it("expired expectations are dropped and not honored", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), expected: [{ kind: "load", tabId: 1, until: T0 }] });
    const o = recordUpdated(s, tab(1, "https://y/"), ctx());
    expect(o.ops.map((op) => op.type)).toEqual(["navigate"]);
    expect(o.patch.expected).toEqual([]);
  });
});

describe("detached tabs", () => {
  const s = () => state({ detached: { "1": "https://x/" } });

  it("are not republished while they show the same URL", () => {
    expect(recordUpdated(s(), tab(1, "https://x/"), ctx()).ops).toEqual([]);
  });

  it("a same-site URL change only updates the detached URL (feeds rewrite their URL constantly)", () => {
    const o = recordUpdated(s(), tab(1, "https://x/feed?update=2", { active: true }), ctx());
    expect(o).toEqual({ patch: { detached: { "1": "https://x/feed?update=2" } }, ops: [], activity: false });
    // Another port or scheme is another site.
    expect(recordUpdated(s(), tab(1, "https://x:8443/"), ctx()).ops.map((op) => op.type)).toEqual(["open"]);
    expect(recordUpdated(s(), tab(1, "http://x/"), ctx()).ops.map((op) => op.type)).toEqual(["open"]);
  });

  it("moving to another site publishes a fresh open and ends the detachment", () => {
    const o = recordUpdated(s(), tab(1, "https://y/"), ctx());
    expect(o.ops.map((op) => op.type)).toEqual(["open"]);
    expect(o.patch.detached).toEqual({});
  });

  it("closing ends the detachment without an operation", () => {
    const o = recordRemoved(s(), 1, false, W, ctx());
    expect(o).toEqual({ patch: { detached: {} }, ops: [], activity: false });
  });
});

describe("after a browser restart", () => {
  it("restored tabs re-match stale mappings by URL instead of publishing", () => {
    const staleMappings = { tabs: { "stale-0": { entryId: "E", url: "https://x/" } }, urlCounts: {} };
    const s = state({ staleMappings, startupAt: T0, detached: { "stale-0": "https://d/" } });
    const o = recordCreated(s, tab(5, "https://x/"), ctx(T0 + 1000));
    expect(o.ops).toEqual([]);
    expect(o.activity).toBe(false); // restored, not created by the user
    expect(next(s, o).mappings.tabs["5"]?.entryId).toBe("E");
    expect(next(s, o).staleMappings).toBeNull();

    const d = recordUpdated(s, tab(6, "https://d/"), ctx(T0 + 1000));
    expect(d.ops).toEqual([]);
    expect(d.patch.detached).toEqual({ "6": "https://d/" });
  });

  it("stale mappings expire", () => {
    const staleMappings = { tabs: { "stale-0": { entryId: "E", url: "https://x/" } }, urlCounts: {} };
    const o = recordCreated(state({ staleMappings, startupAt: T0 }), tab(5, "https://x/"), ctx(T0 + STALE_MAPPINGS_TTL_MS));
    expect(o.ops.map((op) => op.type)).toEqual(["open"]);
    expect(o.patch.staleMappings).toBeNull();
  });
});
