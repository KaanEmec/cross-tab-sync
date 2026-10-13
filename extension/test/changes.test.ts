import { describe, expect, it } from "vitest";
import {
  EXPECT_TTL_MS,
  recordCreated,
  recordRemoved,
  recordUpdated,
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

  it("a created tab with a URL is an addition; without one it waits for onUpdated; both are activity", () => {
    const withUrl = recordCreated(state(), tab(1, "https://x/"), ctx());
    expect(withUrl.ops).toHaveLength(1);
    expect(withUrl.activity).toBe(true);
    const blank = recordCreated(state(), tab(2, undefined), ctx());
    expect(blank).toEqual({ patch: {}, ops: [], activity: true });
  });

  it("ignores tabs the run already mapped, and ineligible URLs", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    expect(recordCreated(s, tab(1, "https://x/"), ctx())).toEqual({ patch: {}, ops: [], activity: false });
    expect(recordUpdated(state(), tab(2, "chrome://newtab/"), ctx()).ops).toEqual([]);
    expect(recordUpdated(state(), tab(3, "https://private/", { eligible: false }), ctx()).ops).toEqual([]);
  });

  it("navigation activity is reported only for the active tab", () => {
    expect(recordUpdated(state(), tab(1, "https://x/"), ctx()).activity).toBe(false);
    expect(recordUpdated(state(), tab(1, "https://x/", { active: true }), ctx()).activity).toBe(true);
  });
});

describe("closures", () => {
  const two = () => state({ mappings: mapped([[1, "E", "https://x/"], [2, "E", "https://x/"]]) });

  it("closing one of two copies emits nothing; closing the last emits close", () => {
    let s = two();
    const first = recordRemoved(s, 1, false, ctx());
    expect(first.ops).toEqual([]);
    s = next(s, first);
    const last = recordRemoved(s, 2, false, ctx());
    expect(last.ops).toEqual([{ opId: "id1", type: "close", entryId: "E" }]);
    expect(next(s, last).mappings.tabs).toEqual({});
  });

  it("window closure only unmaps", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    const o = recordRemoved(s, 1, true, ctx());
    expect(o.ops).toEqual([]);
    expect(next(s, o).mappings.tabs).toEqual({});
  });

  it("removals during the startup grace only unmap", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), startupAt: T0 });
    expect(recordRemoved(s, 1, false, ctx(T0 + STARTUP_GRACE_MS - 1)).ops).toEqual([]);
    expect(recordRemoved(s, 1, false, ctx(T0 + STARTUP_GRACE_MS)).ops).toHaveLength(1);
  });

  it("unmapped tabs produce nothing", () => {
    expect(recordRemoved(state(), 9, false, ctx())).toEqual({ patch: {}, ops: [], activity: false });
  });
});

describe("navigation", () => {
  it("single copy: navigate, mapping follows", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]) });
    const o = recordUpdated(s, tab(1, "https://x/next?q=1#f", { active: true }), ctx());
    expect(o.ops).toEqual([{ opId: "id1", type: "navigate", entryId: "E", url: "https://x/next?q=1#f" }]);
    expect(next(s, o).mappings.tabs["1"]).toEqual({ entryId: "E", url: "https://x/next?q=1#f" });
    expect(o.activity).toBe(true);
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
  it("a load started by the extension is not navigation, redirects included", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), expected: [{ kind: "load", tabId: 1, until: T0 + 1 }] });
    const o = recordUpdated(s, tab(1, "https://x/redirected", { active: true }), ctx());
    expect(o.ops).toEqual([]);
    expect(o.activity).toBe(false);
    const after = next(s, o);
    expect(after.expected).toEqual([]);
    expect(after.mappings.tabs["1"]?.url).toBe("https://x/redirected");
  });

  it("a removal by the extension does not close the entry", () => {
    const s = state({ mappings: mapped([[1, "E", "https://x/"]]), expected: [{ kind: "remove", tabId: 1, until: T0 + 1 }] });
    const o = recordRemoved(s, 1, false, ctx());
    expect(o.ops).toEqual([]);
    expect(next(s, o).expected).toEqual([]);
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

  it("navigating publishes a fresh open and ends the detachment", () => {
    const o = recordUpdated(s(), tab(1, "https://y/"), ctx());
    expect(o.ops.map((op) => op.type)).toEqual(["open"]);
    expect(o.patch.detached).toEqual({});
  });

  it("closing ends the detachment without an operation", () => {
    const o = recordRemoved(s(), 1, false, ctx());
    expect(o).toEqual({ patch: { detached: {} }, ops: [], activity: false });
  });
});

describe("after a browser restart", () => {
  it("restored tabs re-match stale mappings by URL instead of publishing", () => {
    const staleMappings = { tabs: { "stale-0": { entryId: "E", url: "https://x/" } }, urlCounts: {} };
    const s = state({ staleMappings, startupAt: T0, detached: { "stale-0": "https://d/" } });
    const o = recordCreated(s, tab(5, "https://x/"), ctx(T0 + 1000));
    expect(o.ops).toEqual([]);
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
