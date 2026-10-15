import { describe, expect, it } from "vitest";
import {
  CLOSE_HOLD_MAX_MS,
  CLOSE_HOLD_MS,
  EXPECT_TTL_MS,
  LOAD_GRACE_MS,
  NAVIGATE_MAX_HOLD_MS,
  NAVIGATE_SETTLE_MS,
  nextRelease,
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
  heldNavigates: [],
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
/** Open windows and their tab counts: window W keeps plenty of tabs. */
const alive = new Map([[W, 20]]);
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

  it("copies of one entry closed together are one closure (Safari pinned tab in every window)", () => {
    const copies = state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"], [3, "E", "https://x/"]]) });
    // Reported from three windows, or all from the window where it was closed.
    for (const windows of [[1, 2, 3], [W, W, W]]) {
      let s = copies;
      for (const [i, id] of [1, 2, 3].entries()) s = next(s, recordRemoved(s, id, false, windows[i]!, ctx(T0 + i)));
      const released = releaseHeld(s, new Map([[1, 5], [2, 5], [3, 5]]), ctx(T0 + 2 + CLOSE_HOLD_MS));
      expect(released.ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    }
    // With another entry among them: one close per entry.
    let mixed = state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"], [3, "F", "https://y/"]]) });
    for (const [i, id] of [1, 2, 3].entries()) mixed = next(mixed, recordRemoved(mixed, id, false, W, ctx(T0 + i)));
    expect(releaseHeld(mixed, alive, ctx(T0 + 2 + CLOSE_HOLD_MS)).ops.map((o) => o.entryId)).toEqual(["E", "F"]);
  });

  it("held closes are dropped when the window is gone or was reported removed; rapid closes are not", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"], [2, "F", "https://y/"], [3, "G", "https://z/"]]) });
    expect(closeTab(s, 1).ops).toHaveLength(1);
    const removed = next(s, recordRemoved(s, 1, false, W, ctx()));
    expect(releaseHeld(removed, new Map(), ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([]);
    const reported = next(removed, recordWindowRemoved(removed, W, ctx(T0 + 10)));
    expect(releaseHeld(reported, alive, ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([]);

    // Three different tabs closed within 600 ms (cmd-W, cmd-W, cmd-W): the window's holds slide to
    // 2 s after the last removal, then three closes.
    let rapid = s;
    for (const [i, id] of [1, 2, 3].entries()) rapid = next(rapid, recordRemoved(rapid, id, false, W, ctx(T0 + i * 300)));
    expect(nextRelease(rapid)).toBe(T0 + 600 + CLOSE_HOLD_MS);
    const early = releaseHeld(rapid, alive, ctx(T0 + CLOSE_HOLD_MS));
    expect(early).toMatchObject({ ops: [], waiting: true });
    const late = releaseHeld(rapid, alive, ctx(T0 + 600 + CLOSE_HOLD_MS));
    expect(late.ops.map((o) => o.entryId)).toEqual(["E", "F", "G"]);
    expect(next(rapid, late).heldCloses).toEqual([]); // released holds are not kept
    // The same removals from a window that is gone by the release: none.
    expect(releaseHeld(next(s, recordRemoved(s, 1, false, W, ctx())), new Map(), ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([]);
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

describe("window teardown (removals one by one, isWindowClosing false)", () => {
  const ten = () =>
    state({ mappings: mapped(Array.from({ length: 10 }, (_, i): [number, string, string] => [i + 1, `E${i}`, `https://t${i}/`])) });
  /** Ten removals from window W, one second apart. */
  function removeTen(): LocalState {
    let s = ten();
    for (let i = 0; i < 10; i++) {
      s = next(s, recordRemoved(s, i + 1, false, W, ctx(T0 + i * 1000)));
      // Each removal extends the window's holds: nothing is due between removals.
      expect(releaseHeld(s, new Map([[W, 0]]), ctx(T0 + i * 1000 + 999)).ops).toEqual([]);
    }
    expect(nextRelease(s)).toBe(T0 + 9000 + CLOSE_HOLD_MS);
    return s;
  }
  const at = ctx(T0 + 9000 + CLOSE_HOLD_MS);

  it("a window that disappears, or is still listed with no tabs: no close", () => {
    const s = removeTen();
    for (const windows of [new Map<number, number>(), new Map([[W, 0]])]) {
      const r = releaseHeld(s, windows, at);
      expect(r.ops).toEqual([]);
      expect(next(s, r).heldCloses).toEqual([]);
      expect(r.waiting).toBe(false);
    }
  });

  it("a window that keeps other tabs: ten closes, however few are left once the removals stopped", () => {
    for (const left of [10, 1]) {
      const r = releaseHeld(removeTen(), new Map([[W, left]]), at);
      expect(r.ops.map((o) => o.entryId)).toEqual(Array.from({ length: 10 }, (_, i) => `E${i}`));
    }
  });

  it("two of three tabs closed within 2 s: two closes", () => {
    let s = state({ mappings: mapped([[1, "E", "https://x/"], [2, "F", "https://y/"], [3, "G", "https://z/"]]) });
    s = next(s, recordRemoved(s, 1, false, W, ctx(T0)));
    s = next(s, recordRemoved(s, 2, false, W, ctx(T0 + 500)));
    expect(releaseHeld(s, new Map([[W, 1]]), ctx(T0 + 500 + CLOSE_HOLD_MS)).ops.map((o) => o.entryId)).toEqual(["E", "F"]);
  });

  it("the cap firing while removals still arrive drops them when fewer tabs are left than removals", () => {
    let s = ten();
    for (let i = 0; i < 10; i++) s = next(s, recordRemoved(s, i + 1, false, W, ctx(T0 + i * 1600)));
    // Last removal at 14.4 s: at the 15 s cap removals are still arriving.
    const capped = ctx(T0 + CLOSE_HOLD_MAX_MS);
    expect(releaseHeld(s, new Map([[W, 9]]), capped).ops).toEqual([]);
    expect(releaseHeld(s, new Map([[W, 10]]), capped).ops).toHaveLength(10);
  });

  it("one removal from a window that keeps other tabs is one close after 2 s", () => {
    const s = next(ten(), recordRemoved(ten(), 1, false, W, ctx()));
    expect(releaseHeld(s, new Map([[W, 9]]), ctx(T0 + CLOSE_HOLD_MS - 1)).ops).toEqual([]);
    expect(releaseHeld(s, new Map([[W, 9]]), ctx(T0 + CLOSE_HOLD_MS)).ops).toEqual([{ opId: "id1", type: "close", entryId: "E0" }]);
  });

  it("holds slide at most CLOSE_HOLD_MAX_MS from the window's first removal; other windows are separate", () => {
    let s = ten();
    for (let i = 0; i < 8; i++) s = next(s, recordRemoved(s, i + 1, false, W, ctx(T0 + i * 1900)));
    s = next(s, recordRemoved(s, 10, false, 2, ctx(T0 + 1000)));
    expect(nextRelease(s)).toBe(T0 + 1000 + CLOSE_HOLD_MS); // window 2's single removal
    expect(releaseHeld(s, new Map([[W, 20], [2, 5]]), ctx(T0 + 3000)).ops.map((o) => o.entryId)).toEqual(["E9"]);
    const capped = releaseHeld(s, new Map([[W, 20], [2, 5]]), ctx(T0 + CLOSE_HOLD_MAX_MS));
    expect(capped.ops.map((o) => o.entryId)).toEqual(["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E9"]);
  });
});

describe("held navigations", () => {
  const one = () => state({ mappings: mapped([[1, "E", "https://x/"]]) });
  const release = (s: LocalState, now: number) => releaseHeld(s, alive, ctx(now));
  /** Distinct op ids across releases (the journal keeps one operation per opId). */
  let seq = 0;
  const releaseNew = (s: LocalState, now: number) => releaseHeld(s, alive, { now, newId: () => `op${++seq}` });

  it("URL changes within the hold become one navigate with the last URL", () => {
    let s = one();
    for (const [i, url] of ["https://x/1", "https://x/2", "https://x/3"].entries()) {
      s = next(s, recordUpdated(s, tab(1, url), ctx(T0 + i * 2000)));
    }
    expect(s.heldNavigates).toEqual([{ tabId: 1, entryId: "E", firstAt: T0, at: T0 + 4000 }]);
    expect(nextRelease(s)).toBe(T0 + 4000 + NAVIGATE_SETTLE_MS);
    expect(release(s, T0 + 4000 + NAVIGATE_SETTLE_MS - 1).ops).toEqual([]);
    const r = release(s, T0 + 4000 + NAVIGATE_SETTLE_MS);
    expect(r.ops).toEqual([{ opId: "id1", type: "navigate", entryId: "E", url: "https://x/3" }]);
    expect(next(s, r).pending.map((p) => p.base)).toEqual(["https://x/"]);
  });

  it("a page that returns to its mapped URL produces nothing", () => {
    let s = one();
    s = next(s, recordUpdated(s, tab(1, "https://x/#live"), ctx(T0)));
    s = next(s, recordUpdated(s, tab(1, "https://x/"), ctx(T0 + 1000)));
    expect(s.mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/" });
    const r = release(s, T0 + 1000 + NAVIGATE_SETTLE_MS);
    expect(r.ops).toEqual([]);
    expect(next(s, r).heldNavigates).toEqual([]);
  });

  it("a change after the hold is a new navigate", () => {
    let s = one();
    s = next(s, recordUpdated(s, tab(1, "https://x/1"), ctx(T0)));
    s = next(s, releaseNew(s, T0 + NAVIGATE_SETTLE_MS));
    s = next(s, recordUpdated(s, tab(1, "https://x/2"), ctx(T0 + NAVIGATE_SETTLE_MS + 1)));
    const r = releaseNew(s, T0 + 2 * NAVIGATE_SETTLE_MS + 1);
    expect(r.ops).toMatchObject([{ type: "navigate", entryId: "E", url: "https://x/2" }]);
    expect(next(s, r).pending.map((p) => [p.op.type === "navigate" && p.op.url, p.base])).toEqual([
      ["https://x/1", "https://x/"],
      ["https://x/2", "https://x/1"],
    ]);
  });

  it("a page rewriting its URL every 3 s publishes at most once per NAVIGATE_MAX_HOLD_MS", () => {
    let s = one();
    let navigates = 0;
    for (let t = 0; t <= 63_000; t += 1000) {
      if (t % 3000 === 0) s = next(s, recordUpdated(s, tab(1, `https://x/?t=${t}`), ctx(T0 + t)));
      const r = releaseNew(s, T0 + t);
      navigates += r.ops.length;
      s = next(s, r);
    }
    // Released 30 s after the first change of each hold (0 s, then 33 s), with the latest URL.
    expect(navigates).toBe(2);
    expect(s.pending.map((p) => p.op.type === "navigate" && p.op.url)).toEqual(["https://x/?t=30000", "https://x/?t=63000"]);
    expect(NAVIGATE_MAX_HOLD_MS).toBe(30_000);
  });

  it("closing the tab drops its held navigate; the close rules apply", () => {
    let s = one();
    s = next(s, recordUpdated(s, tab(1, "https://x/1"), ctx(T0)));
    s = next(s, recordRemoved(s, 1, false, W, ctx(T0 + 1000)));
    expect(s.heldNavigates).toEqual([]);
    expect(release(s, T0 + 1000 + NAVIGATE_SETTLE_MS).ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    // Window closing: unmap only, nothing at all.
    let w = one();
    w = next(w, recordUpdated(w, tab(1, "https://x/1"), ctx(T0)));
    w = next(w, recordRemoved(w, 1, true, W, ctx(T0 + 1000)));
    expect(w.heldNavigates).toEqual([]);
    expect(release(w, T0 + NAVIGATE_MAX_HOLD_MS).ops).toEqual([]);
  });
});

describe("navigation", () => {
  it("single copy: navigate after the hold, mapping follows", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    const o = recordUpdated(s, tab(1, "https://x/next?q=1#f", { active: true }), ctx());
    expect(o.ops).toEqual([]); // held
    expect(o.activity).toBe(false);
    const held = next(s, o);
    expect(held.mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/next?q=1#f", base: "https://x/" });
    expect(held.heldNavigates).toEqual([{ tabId: 1, entryId: "E", firstAt: T0, at: T0 }]);
    const r = releaseHeld(held, alive, ctx(T0 + NAVIGATE_SETTLE_MS));
    expect(r.ops).toEqual([{ opId: "id1", type: "navigate", entryId: "E", url: "https://x/next?q=1#f" }]);
    const after = next(held, r);
    expect(after.mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/next?q=1#f" });
    expect(after.pending[0]?.base).toBe("https://x/");
    expect(after.heldNavigates).toEqual([]);
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
    after = next(after, recordUpdated(after, tab(1, "https://elsewhere/"), ctx(T0 + LOAD_GRACE_MS)));
    const user = releaseHeld(after, alive, ctx(T0 + LOAD_GRACE_MS + NAVIGATE_SETTLE_MS));
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
    expect(o.patch.heldNavigates).toHaveLength(1);
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
