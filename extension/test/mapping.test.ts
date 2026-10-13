import { describe, expect, it } from "vitest";
import type { TabInfo } from "../src/adapter/types.js";
import {
  countUrls,
  emptyMappings,
  entryForTab,
  reconcileMappings,
  remapEntry,
  removeMappings,
  setMapping,
  tabsForEntry,
} from "../src/core/mapping.js";

const tab = (id: number, url?: string): TabInfo => ({ id, windowId: 1, url, pinned: false, incognito: false, index: 0, active: false });

describe("mapping", () => {
  it("counts duplicate URLs", () => {
    expect(countUrls([{ url: "https://a/" }, { url: "https://b/" }, { url: "https://a/" }])).toEqual({
      "https://a/": 2,
      "https://b/": 1,
    });
  });

  it("maps several tabs to one entry and looks up both ways", () => {
    let m = setMapping(emptyMappings(), 1, "e1", "https://a/");
    m = setMapping(m, 2, "e1", "https://a/");
    m = setMapping(m, 3, "e2", "https://b/");
    expect(entryForTab(m, 2)).toBe("e1");
    expect(tabsForEntry(m, "e1")).toEqual([1, 2]);
    expect(tabsForEntry(removeMappings(m, [1]), "e1")).toEqual([2]);
  });

  it("is immutable", () => {
    const m = emptyMappings();
    setMapping(m, 1, "e", "https://a/");
    expect(m.tabs).toEqual({});
  });

  it("remaps a coalesced entry", () => {
    let m = setMapping(emptyMappings(), 1, "local", "https://a/");
    m = remapEntry(m, "local", "server");
    expect(m.tabs["1"]).toEqual({ entryId: "server", url: "https://a/" });
  });

  it("reconcile drops tabs that are gone and keeps tabs whose URL changed or is hidden", () => {
    let m = setMapping(emptyMappings(), 1, "e1", "https://a/");
    m = setMapping(m, 2, "e2", "https://b/");
    m = setMapping(m, 3, "e3", "https://c/");
    const r = reconcileMappings(m, [tab(1, "https://a/"), tab(2, "https://elsewhere/"), tab(4, "https://c/")]);
    expect(Object.keys(r.tabs)).toEqual(["1", "2"]);
    expect(reconcileMappings(m, [tab(3, "")]).tabs["3"]?.entryId).toBe("e3");
  });
});
