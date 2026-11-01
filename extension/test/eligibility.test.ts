import { describe, expect, it } from "vitest";
import type { TabInfo, WindowInfo } from "../src/adapter/types.js";
import { eligibleTabs, isShareableUrl, MAX_URL_BYTES } from "../src/core/eligibility.js";

const win = (id: number, over: Partial<WindowInfo> = {}): WindowInfo => ({ id, type: "normal", incognito: false, focused: false, ...over });
let next = 100;
const tab = (windowId: number, url: string | undefined, over: Partial<TabInfo> = {}): TabInfo => ({
  id: next++, windowId, url, pinned: false, incognito: false, index: 0, active: false, ...over,
});

describe("isShareableUrl", () => {
  it("excludes pages on the sync server's own origin (an opened invite link would leak its key)", () => {
    const server = "https://tabs.example.com/cts";
    expect(isShareableUrl("https://tabs.example.com/#ABCD2345.key", server)).toBe(false);
    expect(isShareableUrl("https://tabs.example.com/cts/anything", server)).toBe(false);
    expect(isShareableUrl("http://tabs.example.com/", server)).toBe(true); // another origin
    expect(isShareableUrl("https://tabs.example.com:8443/", server)).toBe(true);
    expect(isShareableUrl("https://other.example.com/", server)).toBe(true);
    expect(isShareableUrl("https://tabs.example.com/", "")).toBe(true);
    const w = win(1);
    expect(eligibleTabs([tab(1, "https://tabs.example.com/#X"), tab(1, "https://a.example/")], [w], server).map((t) => t.url)).toEqual([
      "https://a.example/",
    ]);
  });

  it.each([
    ["https://example.com/a?q=1#frag", true],
    ["http://localhost:8080/", true],
    ["chrome://newtab/", false],
    ["about:blank", false],
    ["file:///etc/hosts", false],
    ["safari-web-extension://abc/popup.html", false],
    ["", false],
    [undefined, false],
    ["https://", false],
    ["https://example.com/%zz", false],
    ["https://example.com/a%2", false],
    ["https://example.com/?q=100%", false],
    ["https://example.com/%E2%82%AC?x=%2F", true],
    ["https://:443/", false],
  ])("%s -> %s", (url, expected) => {
    expect(isShareableUrl(url)).toBe(expected);
  });

  it("rejects URLs over the server byte limit", () => {
    const base = "https://example.com/";
    expect(isShareableUrl(base + "a".repeat(MAX_URL_BYTES - base.length))).toBe(true);
    expect(isShareableUrl(base + "a".repeat(MAX_URL_BYTES - base.length + 1))).toBe(false);
  });
});

describe("eligibleTabs", () => {
  it("keeps http(s) tabs in normal non-private windows only", () => {
    const windows = [win(1), win(2, { incognito: true }), win(3, { type: "popup" })];
    const keep = tab(1, "https://a.example/");
    const tabs = [
      keep,
      tab(1, "chrome://settings/"),
      tab(1, ""), // Safari: no site access -> empty URL
      tab(1, undefined), // discarded placeholder without URL
      tab(2, "https://private.example/", { incognito: true }),
      tab(3, "https://popup.example/"),
      tab(9, "https://unknown-window.example/"),
      tab(1, "https://flagged.example/", { incognito: true }),
    ];
    expect(eligibleTabs(tabs, windows).map((t) => t.id)).toEqual([keep.id]);
  });

  it("orders by window then index", () => {
    const tabs = [tab(2, "https://c/", { index: 0 }), tab(1, "https://b/", { index: 1 }), tab(1, "https://a/", { index: 0 })];
    expect(eligibleTabs(tabs, [win(1), win(2)]).map((t) => t.url)).toEqual(["https://a/", "https://b/", "https://c/"]);
  });
});
