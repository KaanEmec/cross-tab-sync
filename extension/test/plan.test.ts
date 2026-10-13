import { describe, expect, it } from "vitest";
import type { Entry } from "../src/core/client.js";
import type { EligibleTab } from "../src/core/eligibility.js";
import { emptyMappings, setMapping, type Mappings } from "../src/core/mapping.js";
import { plan } from "../src/core/plan.js";

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};
const entry = (id: string, url: string, pinned = false): Entry => ({ id, url, pinned, position: 0, updatedRevision: 1 });
const tab = (id: number, url: string, over: Partial<EligibleTab> = {}): EligibleTab => ({
  id, windowId: 1, url, pinned: false, incognito: false, index: id, active: false, ...over,
});
const run = (entries: Entry[] | null, tabs: EligibleTab[], mappings: Mappings = emptyMappings(), pending: string[] = []) =>
  plan({ entries, tabs, mappings, pendingEntries: new Set(pending), newId: ids() });

describe("plan (Continue here)", () => {
  it("reuses local tabs by exact URL before creating", () => {
    const p = run([entry("A", "https://a/"), entry("B", "https://b/?q=1#x", true)], [tab(1, "https://a/"), tab(2, "https://b/?q=1")]);
    expect(p.create).toEqual([{ entryId: "B", url: "https://b/?q=1#x", pinned: true }]);
    expect(p.mappings.tabs["1"]?.entryId).toBe("A");
    // "https://b/?q=1" is not the same URL: published as a new entry, not reused.
    expect(p.open).toMatchObject([{ type: "open", url: "https://b/?q=1", entryId: "id1", opId: "id2" }]);
    expect(p.mappings.tabs["2"]?.entryId).toBe("id1");
  });

  it("keeps local duplicates: all map to the entry, nothing created or published", () => {
    const p = run([entry("A", "https://a/")], [tab(1, "https://a/"), tab(2, "https://a/"), tab(3, "https://a/")]);
    expect(p.create).toEqual([]);
    expect(p.open).toEqual([]);
    expect(Object.values(p.mappings.tabs).map((m) => m.entryId)).toEqual(["A", "A", "A"]);
    expect(p.mappings.urlCounts).toEqual({ "https://a/": 3 });
  });

  it("an entry already mapped to a tab is satisfied even if that tab navigated", () => {
    const m = setMapping(emptyMappings(), 1, "A", "https://a/");
    const p = run([entry("A", "https://a/")], [tab(1, "https://a/next")], m);
    expect(p.create).toEqual([]);
    expect(p.open).toEqual([]);
  });

  it("publishes one open per distinct unmapped URL", () => {
    const p = run([], [tab(1, "https://x/"), tab(2, "https://x/"), tab(3, "https://y/", { pinned: true })]);
    expect(p.open.map((o) => [o.url, o.pinned, o.position])).toEqual([
      ["https://x/", false, 0],
      ["https://y/", true, 2],
    ]);
    expect(p.mappings.tabs["1"]?.entryId).toBe(p.mappings.tabs["2"]?.entryId);
  });

  it("drops mappings to entries gone from the session and republishes those tabs", () => {
    const m = setMapping(emptyMappings(), 1, "gone", "https://old/");
    const p = run([], [tab(1, "https://old/")], m);
    expect(p.open).toHaveLength(1);
    expect(p.mappings.tabs["1"]?.entryId).not.toBe("gone");
  });

  it("keeps a tab mapped to a pending entry, but reuses it when the session already has its URL", () => {
    const m = setMapping(setMapping(emptyMappings(), 1, "p1", "https://p/"), 2, "p2", "https://q/");
    const p = run([entry("Q", "https://q/")], [tab(1, "https://p/"), tab(2, "https://q/")], m, ["p1", "p2"]);
    expect(p.mappings.tabs["1"]?.entryId).toBe("p1");
    expect(p.mappings.tabs["2"]?.entryId).toBe("Q");
    expect(p.create).toEqual([]);
    expect(p.open).toEqual([]);
  });

  it("never plans closures or touches the active tab", () => {
    const p = run([entry("A", "https://a/")], [tab(1, "https://local/", { active: true })]);
    expect(Object.keys(p)).toEqual(["mappings", "create", "open"]);
    expect(p.create).toEqual([{ entryId: "A", url: "https://a/", pinned: false }]);
    expect(p.mappings.tabs["1"]).toBeDefined();
  });
});

describe("plan (Hand over)", () => {
  it("publishes only unmapped tabs and joins duplicates of mapped tabs", () => {
    const m = setMapping(emptyMappings(), 1, "A", "https://a/");
    const p = run(null, [tab(1, "https://a/"), tab(2, "https://a/"), tab(3, "https://new/")], m);
    expect(p.open.map((o) => o.url)).toEqual(["https://new/"]);
    expect(p.mappings.tabs["2"]?.entryId).toBe("A");
    expect(p.create).toEqual([]);
  });

  it("does not drop mappings without session knowledge", () => {
    const m = setMapping(emptyMappings(), 1, "unknown", "https://a/");
    expect(run(null, [tab(1, "https://a/")], m).open).toEqual([]);
  });
});
