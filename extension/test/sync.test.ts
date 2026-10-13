// Scenarios for the v0.2 automatic sync: engine + fake browsers + fake server.
import { beforeEach, describe, expect, it } from "vitest";
import { isCommitted } from "../src/core/engine.js";
import { list } from "../src/core/journal.js";
import { BusyError } from "../src/core/lock.js";
import { saveState } from "../src/core/state.js";
import { Clock, device, type Dev } from "./support/devices.js";
import { FakeServer } from "./support/fakeServer.js";

let server: FakeServer;
let clock: Clock;

beforeEach(() => {
  server = new FakeServer();
  clock = new Clock();
});

const removals = (d: Dev) => d.b.calls.filter((c) => c.method === "removeTab").length;
const entryOf = (url: string) => server.session().entries.find((e) => e.url === url)!.id;

/** An owner with the given tabs, already flushed. */
async function owner(name: string, urls: string[]): Promise<Dev> {
  const d = await device(server, clock, name, { tabs: urls.map((url) => ({ url })) });
  await d.engine.takeover();
  await d.settle();
  return d;
}

/** A follower that has applied the session (first run = full resync). */
async function follower(name: string, opts: Parameters<typeof device>[3] = {}): Promise<Dev> {
  const d = await device(server, clock, name, opts);
  await d.engine.runNow();
  await d.settle();
  return d;
}

describe("owner run", () => {
  it("journals one open per distinct URL and flushes after the debounce", async () => {
    const mac = await owner("Mac Safari", []);
    mac.b.userOpenTab(mac.win, "https://x/");
    mac.b.userOpenTab(mac.win, "https://x/");
    mac.b.userOpenTab(mac.win, "https://y/");
    expect(mac.timers.size).toBe(0); // nothing processed yet: events are queued
    await mac.engine.idle();
    expect(mac.timers.size).toBe(1); // one debounced run for all three
    await mac.settle();

    expect(server.openUrls().sort()).toEqual(["https://x/", "https://y/"]);
    expect(mac.sent().filter((o) => o.type === "open").map((o) => o.type === "open" && o.url)).toEqual(["https://x/", "https://y/"]);
    const s = await mac.state();
    expect(s.pending).toEqual([]);
    expect(s.lastRevision).toBe(server.revision);
  });

  it("flushes, then applies catchUp from other devices", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    server.inject("dev-x", [{ opId: crypto.randomUUID(), type: "open", entryId: crypto.randomUUID(), url: "https://remote/" }]);
    mac.b.userOpenTab(mac.win, "https://mine/");
    await mac.settle();

    expect(server.openUrls().sort()).toEqual(["https://a/", "https://mine/", "https://remote/"]);
    expect(await mac.urls()).toEqual(["https://a/", "https://mine/", "https://remote/"]);
    expect(mac.b.tabs.find((t) => t.url === "https://remote/")?.active).toBe(false);
    const s = await mac.state();
    expect(s.lastRevision).toBe(server.revision);
    expect(s.pending).toEqual([]);
  });

  it("closing one of two copies keeps the entry; closing the last closes it; window close only unmaps", async () => {
    const mac = await owner("Mac Safari", ["https://a/", "https://a/", "https://b/"]);
    const [a1, a2] = mac.b.tabs.filter((t) => t.url === "https://a/").map((t) => t.id);
    mac.b.userCloseTab(a1!);
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/"]);
    mac.b.userCloseTab(a2!);
    await mac.settle();
    expect(server.openUrls()).toEqual(["https://b/"]);

    mac.b.userCloseWindow(mac.win);
    await mac.settle();
    expect(server.openUrls()).toEqual(["https://b/"]);
    expect((await mac.state()).mappings.tabs).toEqual({});
  });

  it("navigation: a single copy navigates, one of two copies opens, onto a mapped URL joins and closes", async () => {
    const mac = await owner("Mac Safari", ["https://a/", "https://b/", "https://b/", "https://c/"]);
    const aEntry = entryOf("https://a/");
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/next?x=1#y");
    await mac.settle();
    expect(server.session().entries.find((e) => e.id === aEntry)?.url).toBe("https://a/next?x=1#y");

    mac.b.userNavigate(mac.tab("https://b/"), "https://b2/");
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/next?x=1#y", "https://b/", "https://b2/", "https://c/"]);

    mac.b.userNavigate(mac.tab("https://c/"), "https://b2/");
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/next?x=1#y", "https://b/", "https://b2/"]);
    const s = await mac.state();
    const b2 = entryOf("https://b2/");
    expect(Object.values(s.mappings.tabs).filter((m) => m.entryId === b2)).toHaveLength(2);
  });
});

describe("run scheduling", () => {
  it("a run that finds the persisted lock held exits without touching the server", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    await saveState(mac.b.storage, { runLock: { action: "other", startedAt: clock.t } });
    const before = server.requests.length;
    await expect(mac.engine.runNow()).rejects.toBeInstanceOf(BusyError);
    expect(server.requests.length).toBe(before);
  });

  it("commits on load complete and on in-page URL changes of a loaded page", async () => {
    const tab = { id: 1, windowId: 1, pinned: false, incognito: false, index: 0, active: true, url: "https://a/#x" };
    expect(isCommitted({ ...tab, status: "loading" }, { url: "https://a/#x", status: "loading" })).toBe(false);
    expect(isCommitted({ ...tab, status: "complete" }, { status: "complete" })).toBe(true);
    expect(isCommitted({ ...tab, status: "complete" }, { url: "https://a/#x" })).toBe(true);

    const mac = await owner("Mac Safari", ["https://a/"]);
    const t = mac.b.tabs[0]!;
    t.url = "https://a/#section";
    mac.b.events.tabUpdated.emit({ ...t }, { url: t.url });
    await mac.settle();
    expect(server.openUrls()).toEqual(["https://a/#section"]);
  });
});

describe("follower application", () => {
  it("applies open/navigate/close/update without changing the active tab, and records no echoes", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://mine/", active: true }] });
    const activeBefore = mac.b.activeTabs();
    expect(await mac.urls()).toEqual(["https://a/", "https://b/", "https://c/", "https://mine/"]);

    mac.b.redirects.set("https://a2/", "https://a2/final");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a2/");
    brave.b.userCloseTab(brave.tab("https://b/"));
    brave.b.userOpenTab(brave.win, "https://d/");
    await brave.settle();
    server.inject(brave.id, [{ opId: crypto.randomUUID(), type: "update", entryId: entryOf("https://c/"), pinned: true }]);

    await mac.engine.runNow();
    await mac.settle();

    expect(await mac.urls()).toEqual(["https://a2/final", "https://c/", "https://d/", "https://mine/"]);
    expect(mac.b.tabs.find((t) => t.url === "https://c/")?.pinned).toBe(true);
    expect(mac.b.activeTabs()).toEqual(activeBefore);
    expect(mac.b.lastFocusedWindowId).toBe(mac.win);
    const s = await mac.state();
    expect(s.pending).toEqual([]); // creates, the redirected navigation and the removal were not echoed
    expect(s.generation).toBeNull();
    expect(mac.acquires()).toBe(0);
    expect(s.lastRevision).toBe(server.revision);
    expect(s.statusText).toBe(`Following Brave, revision ${server.revision}`);
  });

  it("a close keeps the active tab open and detached; it is not republished until it navigates", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    await mac.quiet();
    mac.b.userActivate(mac.tab("https://a/"));
    brave.b.userCloseTab(brave.tab("https://a/"));
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();
    await mac.settle();

    await mac.engine.runNow();
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a/"]);
    let s = await mac.state();
    expect(s.mappings.tabs).toEqual({});
    expect(Object.values(s.detached)).toEqual(["https://a/"]);
    expect(s.pending).toEqual([]);

    // Taking over does not resurrect it.
    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/"));
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    expect(server.openUrls()).toEqual([]);

    // Navigating it is a fresh opening.
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/other");
    await mac.settle();
    expect(server.openUrls()).toEqual(["https://a/other"]);
    s = await mac.state();
    expect(s.detached).toEqual({});
  });

  it("navigate onto a URL already open locally closes background copies and keeps the active one", async () => {
    await owner("Brave", ["https://x/", "https://y/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://x/", active: true }, { url: "https://x/" }] });
    expect(await mac.urls()).toEqual(["https://x/", "https://x/", "https://y/"]);
    const activeBefore = mac.b.activeTabs();
    const x = entryOf("https://x/");
    const y = entryOf("https://y/");
    server.inject("dev-1", [{ opId: crypto.randomUUID(), type: "navigate", entryId: x, url: "https://y/" }]);

    await mac.engine.runNow();
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://y/", "https://y/"]); // background x copy closed, active one navigated
    expect(mac.b.activeTabs()).toEqual(activeBefore);
    expect(removals(mac)).toBe(1);
    const s = await mac.state();
    expect(new Set(Object.values(s.mappings.tabs).map((m) => m.entryId))).toEqual(new Set([y]));
    expect(s.pending).toEqual([]);
  });

  it("410 history_expired: full resync creates missing tabs and never closes", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    await mac.quiet();
    mac.b.userOpenTab(mac.win, "https://local/");
    brave.b.userCloseTab(brave.tab("https://a/"));
    brave.b.userOpenTab(brave.win, "https://c/");
    await brave.settle();
    await mac.settle();
    expect(list((await mac.state()).pending).map((o) => o.type)).toEqual(["open"]); // held while following

    server.historyStart = server.revision + 1;
    await mac.engine.runNow();
    await mac.settle();
    expect(server.requests.filter((r) => r.device === mac.id).map((r) => r.path)).toContain("session");
    expect(removals(mac)).toBe(0);
    expect(await mac.urls()).toEqual(["https://a/", "https://b/", "https://c/", "https://local/"]);
    const s = await mac.state();
    expect(s.lastRevision).toBe(server.revision);
    expect(Object.values(s.detached)).toEqual(["https://a/"]); // its entry is gone: kept, not republished

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://b/"));
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://b/", "https://c/", "https://local/"]);
  });
});

describe("stale owner", () => {
  it("demotes and keeps the journal; the next takeover publishes it", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    const brave = await device(server, clock, "Brave", { tabs: [{ url: "https://brave/" }] });
    await brave.engine.takeover();
    await brave.settle();

    mac.b.userOpenTab(mac.win, "https://late/");
    await mac.settle();
    let s = await mac.state();
    expect(s.generation).toBeNull();
    expect(s.owner?.name).toBe("Brave");
    expect(s.freshPending).toBe(true);
    expect(list(s.pending).map((o) => o.type === "open" && o.url)).toEqual(["https://late/"]);
    expect(server.openUrls()).not.toContain("https://late/");
    expect(await mac.urls()).toContain("https://brave/"); // continued as a follower in the same run

    clock.advance(31_000);
    mac.b.userActivate(mac.tab("https://a/"));
    await mac.settle();
    s = await mac.state();
    expect(s.generation).not.toBeNull();
    expect(s.pending).toEqual([]);
    expect(server.openUrls()).toContain("https://late/");
  });
});

describe("automatic ownership", () => {
  it("a fresh interaction takes over once; repeated signals do not; takeovers are rate limited", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://m/", active: true }] });
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    expect((await mac.state()).generation).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      clock.advance(5_000);
      mac.b.userActivate(mac.tab("https://a/"));
      mac.b.userActivate(mac.tab("https://m/"));
    }
    await mac.settle();
    expect(mac.acquires()).toBe(1);

    // Brave takes it back; mac learns from stale_owner on its next run.
    await brave.engine.takeover();
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    expect((await mac.state()).generation).toBeNull();

    mac.b.userActivate(mac.tab("https://a/")); // 25 s after mac's takeover: rate limited, stays pending
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    clock.advance(6_000);
    mac.b.userActivate(mac.tab("https://m/"));
    await mac.settle();
    expect(mac.acquires()).toBe(2);
  });

  it("manual Hand over suppresses automatic takeover until a fresh interaction", async () => {
    const mac = await owner("Mac Safari", ["https://a/", "https://b/"]);
    await mac.engine.handOver();
    await mac.settle();
    expect((await mac.state()).generation).toBeNull();
    const before = mac.acquires();
    for (const dt of [1_000, 20_000, 30_000]) {
      clock.advance(dt);
      mac.b.userActivate(mac.tab("https://b/"));
      await mac.settle();
    }
    expect(mac.acquires()).toBe(before);
    clock.advance(60_000);
    mac.b.userActivate(mac.tab("https://a/"));
    await mac.settle();
    expect(mac.acquires()).toBe(before + 1);
  });

  it("never fires from remote application or alarm runs", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    // No normal window: the first application creates one (its tab becomes active in it).
    const mac = await follower("Mac Safari", { noWindow: true });
    expect(mac.b.calls[0]?.method).toBe("createWindow");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a2/");
    brave.b.userCloseTab(brave.tab("https://b/"));
    brave.b.userOpenTab(brave.win, "https://c/");
    await brave.settle();
    for (let i = 0; i < 3; i++) {
      clock.advance(61_000);
      await mac.engine.runNow("alarm");
      await mac.settle();
    }
    expect(await mac.urls()).toEqual(["https://a2/", "https://c/"]);
    expect(mac.acquires()).toBe(0);
    expect((await mac.state()).pending).toEqual([]);

    mac.b.userActivate(mac.tab("https://c/"));
    await mac.settle();
    expect(mac.acquires()).toBe(1);
  });

  it("browser restart with reused tab ids: restored tabs re-match even before onStartup, grace suppresses closes and activity", async () => {
    await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari");
    const oldIds = Object.keys((await mac.state()).mappings.tabs).map(Number).sort();
    clock.advance(120_000);

    // Relaunch: ids restart from 1, so restored tabs reuse ids of the previous session but in a
    // different order; their events arrive before runtime.onStartup.
    mac.b.restart();
    const win = mac.b.addWindow({ focused: true });
    const c = mac.b.restoreTab(win, "https://c/");
    const b = mac.b.restoreTab(win, "https://b/");
    const a = mac.b.restoreTab(win, "https://a/");
    expect([a.id, b.id, c.id].sort()).toEqual(oldIds); // same ids, other URLs
    mac.b.userActivate(a.id);
    mac.b.userCloseTab(b.id);
    mac.b.events.startup.emit();
    await mac.settle();
    let s = await mac.state();
    expect(s.pending).toEqual([]); // no bogus navigate, no close
    expect(mac.acquires()).toBe(0); // restore and the first signals are not activity
    expect(Object.fromEntries(Object.entries(s.mappings.tabs).map(([k, m]) => [k, m.url]))).toEqual({
      [String(a.id)]: "https://a/",
      [String(c.id)]: "https://c/",
    });
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/", "https://c/"]);

    clock.advance(10_000);
    mac.b.userActivate(a.id);
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/", "https://c/"]); // b was not closed
    mac.b.userCloseTab(a.id);
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://b/", "https://c/"]);
    s = await mac.state();
    expect(s.pending).toEqual([]);
  });
});

describe("review fixes", () => {
  it("takeover applies a remote navigation made since the last follower run", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a2/");
    await brave.settle();

    clock.advance(61_000);
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    expect((await mac.state()).generation).not.toBeNull();
    expect(await mac.urls()).toEqual(["https://a2/", "https://b/"]);
    expect(server.openUrls().sort()).toEqual(["https://a2/", "https://b/"]);
  });

  it("takeover applies a remote closure made since the last follower run", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();

    clock.advance(61_000);
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a/"]); // the background copy was closed, not left behind
    expect((await mac.state()).detached).toEqual({});
    expect(server.openUrls()).toEqual(["https://a/"]);
  });

  it("a full resync navigates local copies whose entry moved while nothing local is pending", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a2/");
    await brave.settle();
    server.historyStart = server.revision + 1;
    await mac.engine.runNow();
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a2/", "https://b/"]);
    expect((await mac.state()).pending).toEqual([]);
  });

  it("divergent navigation keeps both URLs on both devices", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    clock.advance(15_000); // past the post-load grace of the tabs the follower just received
    await mac.quiet();
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/mac");
    await mac.settle();
    expect(list((await mac.state()).pending).map((o) => o.type)).toEqual(["navigate"]);
    brave.b.userNavigate(brave.tab("https://a/"), "https://a/brave");
    await brave.settle();

    await mac.engine.runNow(); // follower run sees the remote navigate of the same entry
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a/brave", "https://a/mac"]);
    expect(list((await mac.state()).pending).map((o) => o.type === "open" && o.url)).toEqual(["https://a/mac"]);

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/mac"));
    await mac.settle();
    await brave.engine.runNow(); // stale owner: follows
    await brave.settle();
    const both = ["https://a/brave", "https://a/mac"];
    expect(server.openUrls().sort()).toEqual(both);
    expect(await mac.urls()).toEqual(both);
    expect(await brave.urls()).toEqual(both);
  });

  it("divergent navigation found only in the session snapshot (history expired) keeps both", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    clock.advance(15_000); // past the post-load grace of the tabs the follower just received
    await mac.quiet();
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/mac");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a/brave");
    await brave.settle();
    await mac.settle();
    server.historyStart = server.revision + 1;

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/mac"));
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/brave", "https://a/mac"]);
    expect(await mac.urls()).toEqual(["https://a/brave", "https://a/mac"]);
  });

  it("a remote close racing a local navigation keeps the local page and publishes it", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    clock.advance(15_000); // past the post-load grace of the tabs the follower just received
    await mac.quiet();
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/local"); // journaled, held while following
    brave.b.userCloseTab(brave.tab("https://a/"));
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();
    await mac.settle();
    expect(server.openUrls()).toEqual([]);

    // The b tab navigates while the run is queued: its event is recorded only after the run.
    const run = mac.engine.runNow();
    mac.b.userNavigate(mac.tab("https://b/"), "https://b/local");
    await run;
    await mac.settle();
    expect(removals(mac)).toBe(0);
    expect(await mac.urls()).toEqual(["https://a/local", "https://b/local"]);

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/local"));
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/local", "https://b/local"]);
    await brave.engine.runNow();
    await brave.settle();
    expect(await brave.urls()).toEqual(["https://a/local", "https://b/local"]);
  });

  it("post-load URL rewrites of a page the extension loaded are not journaled", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    mac.b.redirects.set("https://a2/", "https://a2/login");
    brave.b.userNavigate(brave.tab("https://a/"), "https://a2/");
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    const tab = mac.tab("https://a2/login");
    clock.advance(3_000);
    mac.b.pageRewritesUrl(tab, "https://a2/login#step=2");
    mac.b.pageRewritesUrl(tab, "https://a2/home");
    await mac.settle();
    let s = await mac.state();
    expect(s.pending).toEqual([]);
    expect(s.mappings.tabs[String(tab)]).toEqual({ entryId: entryOf("https://a2/"), url: "https://a2/home", base: "https://a2/" });

    clock.advance(10_000); // grace over: a user navigation is recorded again
    mac.b.userNavigate(tab, "https://elsewhere/");
    await mac.settle();
    s = await mac.state();
    expect(s.pending.map((p) => [p.op.type, p.base])).toEqual([["navigate", "https://a2/"]]);
  });

  it("a window closing as individual tab removals produces no close ops", async () => {
    const mac = await owner("Mac Safari", ["https://keep/"]);
    const w2 = mac.b.addWindow({ tabs: [{ url: "https://w1/" }, { url: "https://w2/" }] });
    const w3 = mac.b.addWindow({ tabs: [{ url: "https://w3/" }, { url: "https://w4/" }, { url: "https://w5/" }] });
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    await mac.engine.takeover(); // publishes the new windows' tabs
    await mac.settle();
    expect(server.openUrls()).toHaveLength(6);

    // Engine reports isWindowClosing false and no windows.onRemoved: the window is gone at release.
    mac.b.userCloseWindow(w2, { reportsWindowClosing: false, windowEvent: false });
    // Window still listed, but three removals in one burst.
    for (const id of mac.b.tabs.filter((t) => t.windowId === w3).map((t) => t.id)) mac.b.userCloseTab(id);
    await mac.settle();
    expect(server.openUrls()).toHaveLength(6);
    expect(mac.sent().filter((o) => o.type === "close")).toEqual([]);
    expect((await mac.state()).heldCloses.every((h) => h.done)).toBe(true);

    mac.b.userCloseTab(mac.tab("https://keep/")); // a single close still closes
    await mac.settle();
    expect(server.openUrls()).not.toContain("https://keep/");
  });

  it("a failed create clears its expectation", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await device(server, clock, "Mac Safari");
    mac.b.failCreateFor.add("https://b/");
    await mac.engine.runNow();
    await mac.settle();
    const s = await mac.state();
    expect(s.lastError).toBe("1 tab(s) could not be created");
    expect(s.expected.filter((e) => e.kind === "create")).toEqual([]);
    expect(await mac.urls()).toEqual(["https://a/"]);
  });
});

describe("two devices", () => {
  it("alternating activity converges to the same entry set", async () => {
    const mac = await device(server, clock, "Mac Safari", { tabs: [{ url: "https://m1/", active: true }] });
    const brave = await device(server, clock, "Brave", { tabs: [{ url: "https://b1/", active: true }] });
    const both = async () => {
      await mac.settle();
      await brave.settle();
    };

    mac.b.userFocusWindow(mac.win); // fresh: mac takes over and publishes m1
    await both();
    mac.b.userOpenTab(mac.win, "https://x/", { active: true });
    mac.b.userOpenTab(mac.win, "https://y/");
    await both();

    clock.advance(61_000);
    brave.b.userFocusWindow(brave.win); // brave takes over: gets m1, x, y; publishes b1
    await both();
    expect(await brave.urls()).toEqual(["https://b1/", "https://m1/", "https://x/", "https://y/"]);
    clock.advance(15_000); // past the post-load grace of the tabs brave just received
    brave.b.userNavigate(brave.tab("https://x/"), "https://x2/");
    brave.b.userCloseTab(brave.tab("https://y/"));
    brave.b.userOpenTab(brave.win, "https://z/", { active: true });
    await both();

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://m1/")); // mac still believes it owns: run, stale_owner, follow
    await both();
    expect((await mac.state()).generation).toBeNull();
    mac.b.userActivate(mac.tab("https://x2/")); // first signal after losing ownership: takeover
    await both();
    expect((await mac.state()).generation).not.toBeNull();
    mac.b.userOpenTab(mac.win, "https://w/", { active: true });
    mac.b.userCloseTab(mac.tab("https://b1/"));
    await both();

    clock.advance(5 * 60_000);
    await brave.engine.runNow("alarm"); // stale_owner, then follows
    await mac.engine.runNow("alarm");
    await both();

    const expected = ["https://m1/", "https://w/", "https://x2/", "https://z/"];
    expect(server.openUrls().sort()).toEqual(expected);
    expect(await mac.urls()).toEqual(expected);
    expect(await brave.urls()).toEqual(expected);
    expect((await mac.state()).pending).toEqual([]);
    expect((await brave.state()).pending).toEqual([]);
    expect(server.owner?.deviceId).toBe(mac.id);
  });
});
