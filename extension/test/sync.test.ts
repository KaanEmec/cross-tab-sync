// Scenarios for the v0.2 automatic sync: engine + fake browsers + fake server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommitted, SyncEngine } from "../src/core/engine.js";
import { list } from "../src/core/journal.js";
import { BusyError } from "../src/core/lock.js";
import { saveState } from "../src/core/state.js";
import { Clock, device, ManualTimers, type Dev } from "./support/devices.js";
import { FakeServer } from "./support/fakeServer.js";

let server: FakeServer;
let clock: Clock;

beforeEach(() => {
  server = new FakeServer();
  clock = new Clock();
});
// Request bodies never carry a field named `url`: URLs travel sealed.
afterEach(() => {
  expect(server.leaks).toEqual([]);
});


const removals = (d: Dev) => d.b.calls.filter((c) => c.method === "removeTab").length;
/**
 * A new tab page keeps the device's window open while its shared tabs are closed (a browser closes
 * a window with its last tab; removals that empty a window are a teardown, not closes).
 */
const keepWindow = (d: Dev) => d.b.addTab(d.win, { url: "chrome://newtab/" });
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
    await server.inject("dev-x", [{ opId: crypto.randomUUID(), type: "open", entryId: crypto.randomUUID(), url: "https://remote/" }]);
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
    await server.inject(brave.id, [{ opId: crypto.randomUUID(), type: "update", entryId: entryOf("https://c/"), pinned: true }]);

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

  it("a close keeps the active tab open and detached; it is not republished until it moves to another site", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    await mac.quiet();
    keepWindow(brave);
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

    // A same-site URL change (a feed rewriting its URL) keeps it local.
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/other");
    mac.b.pageRewritesUrl(mac.tab("https://a/other"), "https://a/other?feed=2");
    await mac.settle();
    expect(server.openUrls()).toEqual([]);
    expect(Object.values((await mac.state()).detached)).toEqual(["https://a/other?feed=2"]);

    // Moving to another site is a fresh opening.
    mac.b.userNavigate(mac.tab("https://a/other?feed=2"), "https://elsewhere/");
    await mac.settle();
    expect(server.openUrls()).toEqual(["https://elsewhere/"]);
    s = await mac.state();
    expect(s.detached).toEqual({});
  });

  it("takeover republishes a detached tab only when it shows another site", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari");
    await mac.quiet();
    const w2 = mac.b.addWindow();
    const [a, b] = [mac.tab("https://a/"), mac.tab("https://b/")];
    // a and b become the active tabs of their windows, so a remote close detaches them.
    mac.b.userActivate(a);
    mac.b.tabs.find((t) => t.id === b)!.windowId = w2;
    mac.b.userActivate(b);
    await mac.settle();
    keepWindow(brave);
    brave.b.userCloseTab(brave.tab("https://a/"));
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    expect(Object.values((await mac.state()).detached).sort()).toEqual(["https://a/", "https://b/"]);

    // URL changes whose events were missed (e.g. the worker was asleep).
    mac.b.tabs.find((t) => t.id === a)!.url = "https://a/feed?x=1";
    mac.b.tabs.find((t) => t.id === b)!.url = "https://other-site/";
    clock.advance(61_000);
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    expect(server.openUrls().sort()).toEqual(["https://c/", "https://other-site/"]);
    expect((await mac.state()).detached).toEqual({ [String(a)]: "https://a/feed?x=1" });
  });

  it("navigate onto a URL already open locally closes background copies and keeps the active one", async () => {
    await owner("Brave", ["https://x/", "https://y/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://x/", active: true }, { url: "https://x/" }] });
    expect(await mac.urls()).toEqual(["https://x/", "https://x/", "https://y/"]);
    const activeBefore = mac.b.activeTabs();
    const x = entryOf("https://x/");
    const y = entryOf("https://y/");
    await server.inject("dev-1", [{ opId: crypto.randomUUID(), type: "navigate", entryId: x, url: "https://y/" }]);

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

    server.historyStart = server.revision;
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
  it("demotes, then submits the journal through merge as a follower without taking over", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    const brave = await device(server, clock, "Brave", { tabs: [{ url: "https://brave/" }] });
    await brave.engine.takeover();
    await brave.settle();
    const acquires = mac.acquires();

    mac.b.userOpenTab(mac.win, "https://late/");
    await mac.settle();
    const s = await mac.state();
    expect(s.generation).toBeNull();
    expect(s.owner?.name).toBe("Brave");
    expect(s.freshPending).toBe(true);
    expect(s.pending).toEqual([]);
    expect(server.openUrls()).toContain("https://late/"); // merged: no ownership needed
    expect(server.owner?.name).toBe("Brave");
    expect(mac.acquires()).toBe(acquires);
    expect(await mac.urls()).toContain("https://brave/"); // continued as a follower in the same run
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

    clock.advance(11_000); // a restore-related activation just after 10 s (Brave) is still suppressed
    mac.b.userActivate(c.id);
    await mac.settle();
    expect(mac.acquires()).toBe(0);
    clock.advance(19_000);
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

describe("live testing fixes", () => {
  it("a restored tab finishing its load long after browser startup does not take over", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    clock.advance(120_000);
    mac.b.restart();
    const win = mac.b.addWindow({ focused: true });
    const a = mac.b.restoreTab(win, "https://a/");
    mac.b.events.startup.emit();
    await mac.settle();

    // ~35 s later the active restored tab finishes loading and the page rewrites its URL; another
    // restored tab is created late. None of it is the user.
    clock.advance(35_000);
    const t = mac.b.tabs.find((x) => x.id === a.id)!;
    t.active = true;
    mac.b.events.tabUpdated.emit({ ...t }, { status: "complete" });
    mac.b.pageRewritesUrl(a.id, "https://a/#restored");
    const b = mac.b.restoreTab(win, "https://b/");
    // Focus moving to a popup or devtools window is not activity either.
    mac.b.userFocusWindow(mac.b.addWindow({ type: "popup" }));
    await mac.settle();
    expect(mac.acquires()).toBe(0);
    expect((await mac.state()).generation).toBeNull();

    mac.b.userActivate(b.id); // the user
    await mac.settle();
    expect(mac.acquires()).toBe(1);
  });

  it("a click on a device that silently lost ownership takes over right after the run that finds out", async () => {
    const mac = await owner("Mac Safari", ["https://a/", "https://b/"]);
    const brave = await device(server, clock, "Brave");
    await brave.engine.takeover();
    await brave.settle();
    expect((await mac.state()).generation).not.toBeNull(); // mac has not noticed
    const sent = mac.sent().length;

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://b/"));
    await mac.engine.idle(); // no debounce timer fired: the run and the takeover are immediate
    expect(mac.timers.size).toBe(0);
    const s = await mac.state();
    expect(s.generation).not.toBeNull();
    expect(server.owner?.deviceId).toBe(mac.id);
    expect(mac.acquires()).toBe(2);
    expect(mac.sent().length).toBe(sent); // the verifying run was an empty batch
  });

  for (const [signal, act] of [
    ["window focus", (d: Dev) => d.b.userFocusWindow(d.win)],
    ["a tab switch without a focus event (Safari)", (d: Dev) => d.b.userActivate(d.tab("https://b/"))],
  ] as const) {
    it(`${signal} makes a silently superseded owner verify at once and take over, even inside the idle window`, async () => {
      const mac = await owner("Mac Safari", ["https://a/", "https://b/"]);
      const generation = (await mac.state()).generation;
      clock.advance(30_000); // past the takeover rate limit of mac's own takeover
      await mac.quiet();
      const brave = await device(server, clock, "Brave");
      await brave.engine.takeover();
      await brave.settle();

      clock.advance(20_000); // not a fresh interaction: within 60 s of the last activity
      const before = server.requests.length;
      act(mac);
      await mac.engine.idle();
      const calls = server.requests.slice(before).filter((r) => r.device === mac.id);
      const paths = calls.map((r) => r.path);
      const acquire = paths.indexOf("acquire");
      // One empty batch (409 stale_owner), the follower pull of that run, then the takeover (session
      // decrypted before anything is sent, catch-up, acquire).
      expect(paths.slice(0, acquire)).toEqual(["operations", "changes", "session", "changes"]);
      expect(calls[0]!.body).toMatchObject({ generation, operations: [] });
      expect(paths.filter((p) => p === "acquire")).toHaveLength(1);
      expect((await mac.state()).generation).not.toBeNull();
      expect(server.owner?.deviceId).toBe(mac.id);

      // Rate limited: another signal within 10 s does not verify again.
      clock.advance(5_000);
      const after = server.requests.length;
      act(mac);
      await mac.engine.idle();
      expect(server.requests.length).toBe(after);
    });
  }

  it("a run that finds ownership lost without recent activity here only follows", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    await mac.quiet();
    const brave = await device(server, clock, "Brave");
    await brave.engine.takeover();
    await brave.settle();
    clock.advance(16_000);
    await mac.engine.runNow("alarm");
    await mac.settle();
    const s = await mac.state();
    expect(s.generation).toBeNull();
    expect(s.freshPending).toBe(true);
    expect(mac.acquires()).toBe(1);
  });

  it("a takeover during the close hold does not recreate the closed tab; the close is sent after the hold", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    clock.advance(15_000);
    mac.b.userCloseTab(mac.tab("https://a/"));
    await mac.engine.idle();
    expect((await mac.state()).heldCloses.filter((h) => !h.done)).toHaveLength(1);

    await mac.engine.takeover(); // before the hold releases (its timer has not fired)
    await mac.engine.idle();
    expect(await mac.urls()).toEqual(["https://b/"]);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/"]);

    await mac.settle(); // release: the entry has no local copy, so the close goes out
    expect(mac.sent().filter((o) => o.type === "close")).toHaveLength(1);
    expect(server.openUrls()).toEqual(["https://b/"]);
    expect(await mac.urls()).toEqual(["https://b/"]);
  });

  it("tabs being removed asynchronously are not republished by the materialize in the same run", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://mine/", active: true }] });
    mac.b.asyncRemove = true;
    // A remote close, and a navigate onto a URL open locally (the background copy is closed).
    brave.b.userCloseTab(brave.tab("https://c/"));
    brave.b.userNavigate(brave.tab("https://a/"), "https://b/");
    await brave.settle();

    await mac.engine.takeover(); // catch-up applies both, then materializes while the tabs are still listed
    await mac.settle();
    await mac.b.flush();
    await mac.settle();
    expect(removals(mac)).toBe(2);
    expect(mac.sent().filter((o) => o.type === "open").map((o) => o.type === "open" && o.url)).toEqual(["https://mine/"]);
    expect(server.openUrls().sort()).toEqual(["https://b/", "https://mine/"]);
    expect(await mac.urls()).toEqual(["https://b/", "https://mine/"]);
    const s = await mac.state();
    expect(s.pending).toEqual([]);
    expect(s.detached).toEqual({});
  });

  it("Safari restart: restored tabs that send no events are re-matched by URL, so closing one closes its entry", async () => {
    await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari");
    clock.advance(120_000);
    mac.b.restart();
    const win = mac.b.addWindow({ focused: true });
    // Lazily restored: listed by tabs.query with their URLs, but no onCreated/onUpdated.
    mac.b.addTab(win, { url: "https://a/", active: true });
    const b = mac.b.addTab(win, { url: "https://b/" });
    mac.b.events.startup.emit();
    await mac.settle();
    const urls = async () => Object.values((await mac.state()).mappings.tabs).map((m) => m.url).sort();
    expect(await urls()).toEqual(["https://a/", "https://b/"]);

    // A window restored a little later, also silently: the delayed re-match finds it.
    clock.advance(3_000);
    const late = mac.b.addWindow();
    const c = mac.b.addTab(late, { url: "https://c/" });
    mac.b.addTab(late, { url: "https://c2/" });
    mac.rematches.fire();
    await mac.settle();
    expect(await urls()).toEqual(["https://a/", "https://b/", "https://c/"]);
    expect((await mac.state()).pending).toEqual([]);

    // Past the startup grace: closing a never-activated restored tab closes its entry.
    mac.b.userCloseTab(b.id);
    mac.b.userCloseTab(c.id);
    await mac.settle();
    expect(list((await mac.state()).pending).map((o) => o.type)).toEqual(["close", "close"]);
    await mac.engine.runNow(); // a follower sends its journal on its next run
    await mac.settle();
    expect(mac.merged().filter((o) => o.type === "close")).toHaveLength(2);
    expect(server.openUrls()).toEqual(["https://a/"]);
  });

  it("closing a Safari pinned tab, reported once per window, closes its entry once", async () => {
    const mac = await device(server, clock, "Mac Safari", { tabs: [{ url: "https://pinned/", pinned: true }, { url: "https://keep/" }] });
    mac.b.addWindow({ tabs: [{ url: "https://pinned/", pinned: true }] });
    mac.b.addWindow({ tabs: [{ url: "https://pinned/", pinned: true }] });
    await mac.engine.takeover();
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://keep/", "https://pinned/"]);

    for (const t of mac.b.tabs.filter((x) => x.url === "https://pinned/")) mac.b.userCloseTab(t.id);
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "close")).toHaveLength(1);
    expect(server.openUrls()).toEqual(["https://keep/"]);
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
    server.historyStart = server.revision;
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

    await mac.engine.runNow(); // merge forks the stale navigate, then the pull brings the remote URL
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a/brave", "https://a/mac"]);
    expect((await mac.state()).pending).toEqual([]);
    expect(server.openUrls().sort()).toEqual(["https://a/brave", "https://a/mac"]);

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
    server.historyStart = server.revision;

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
    keepWindow(brave);
    brave.b.userCloseTab(brave.tab("https://a/"));
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();
    await mac.settle();
    expect(server.openUrls()).toEqual([]);

    // The b tab moves to another site while the run is queued: its event is recorded only after the run.
    const run = mac.engine.runNow();
    mac.b.userNavigate(mac.tab("https://b/"), "https://b2/local");
    await run;
    await mac.settle();
    expect(removals(mac)).toBe(0);
    expect(await mac.urls()).toEqual(["https://a/local", "https://b2/local"]);

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/local"));
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/local", "https://b2/local"]);
    await brave.engine.runNow();
    await brave.settle();
    expect(await brave.urls()).toEqual(["https://a/local", "https://b2/local"]);
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

  it("a window closing as individual tab removals produces no close ops; rapid individual closes do", async () => {
    const mac = await owner("Mac Safari", ["https://keep/"]);
    const w2 = mac.b.addWindow({ tabs: [{ url: "https://w1/" }, { url: "https://w2/" }] });
    const blank = { url: "chrome://newtab/" };
    const w3 = mac.b.addWindow({ tabs: [{ url: "https://w3/" }, { url: "https://w4/" }, { url: "https://w5/" }, blank, blank, blank] });
    mac.b.userFocusWindow(mac.win);
    await mac.settle();
    await mac.engine.takeover(); // publishes the new windows' tabs
    await mac.settle();
    expect(server.openUrls()).toHaveLength(6);

    // Engine reports isWindowClosing false and no windows.onRemoved: the window is gone at release.
    mac.b.userCloseWindow(w2, { reportsWindowClosing: false, windowEvent: false });
    await mac.settle();
    expect(server.openUrls()).toHaveLength(6);
    expect(mac.sent().filter((o) => o.type === "close")).toEqual([]);
    expect((await mac.state()).heldCloses).toEqual([]);

    // Three tabs of a window that keeps three others, closed one after another within 2 s: three closes.
    for (const id of mac.b.tabs.filter((t) => t.windowId === w3 && t.url?.startsWith("https:")).map((t) => t.id)) {
      mac.b.userCloseTab(id);
      clock.advance(300);
    }
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "close")).toHaveLength(3);
    expect(server.openUrls().sort()).toEqual(["https://keep/", "https://w1/", "https://w2/"]); // the closed window's entries stay
    expect((await mac.state()).heldCloses).toEqual([]);
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
    mac.b.userActivate(mac.tab("https://m1/")); // mac still believes it owns: run, stale_owner, takeover
    await both();
    expect((await mac.state()).generation).not.toBeNull();
    expect(mac.acquires()).toBe(2);
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

/** A new engine over the same browser and storage, as after the service worker was terminated. */
async function restartWorker(d: Dev): Promise<{ engine: SyncEngine; timers: ManualTimers }> {
  const timers = new ManualTimers(clock);
  const engine = new SyncEngine(d.deps, timers.schedule, new ManualTimers(clock).schedule, new ManualTimers(clock).schedule);
  await engine.resume();
  return { engine, timers };
}

/** Fire a restarted worker's timers until nothing is left. */
async function settleWorker(w: { engine: SyncEngine; timers: ManualTimers }): Promise<void> {
  for (let i = 0; i < 20 && (w.timers.size > 0 || w.engine.busy); i++) {
    await w.engine.idle();
    if (w.timers.size > 0) w.timers.fire();
  }
  await w.engine.idle();
}

describe("second live test fixes", () => {
  it("received tabs go to the frontmost window, not the stale persisted one", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    const a = mac.win;
    const b = mac.b.addWindow({ tabs: [{ url: "https://local/", active: true }] });
    await saveState(mac.b.storage, { receivingWindowId: a }); // persisted by the last focus event
    // The user brings window B to the front; Safari reports no focus event.
    for (const w of mac.b.windows) w.focused = w.id === b;
    mac.b.lastFocusedWindowId = b;

    brave.b.userOpenTab(brave.win, "https://new/");
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    expect(mac.b.tabs.find((t) => t.url === "https://new/")?.windowId).toBe(b);
    expect(mac.b.tabs.find((t) => t.url === "https://new/")?.active).toBe(false);

    // The browser's focused window wins over a last-focused answer that lags behind.
    for (const w of mac.b.windows) w.focused = w.id === a;
    brave.b.userOpenTab(brave.win, "https://newer/");
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    expect(mac.b.tabs.find((t) => t.url === "https://newer/")?.windowId).toBe(a);
  });

  it("a live page rewriting its URL every second is one navigate; the other browser loads it once", async () => {
    const mac = await owner("Mac Safari", ["https://deploy/"]);
    const brave = await follower("Brave");
    const tab = mac.tab("https://deploy/");
    for (const run of ["1", "2", "3"]) {
      mac.b.pageRewritesUrl(tab, `https://deploy/?run=${run}`);
      await mac.engine.idle();
      clock.advance(1_000);
    }
    expect((await mac.state()).pending).toEqual([]); // held
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "navigate").map((o) => o.type === "navigate" && o.url)).toEqual(["https://deploy/?run=3"]);
    expect(server.openUrls()).toEqual(["https://deploy/?run=3"]);

    await brave.engine.runNow();
    await brave.settle();
    expect(brave.b.calls.filter((c) => c.method === "updateTab")).toHaveLength(1);
    expect(await brave.urls()).toEqual(["https://deploy/?run=3"]);
  });

  it("a page that returns to its URL within the hold publishes nothing; a later change is a new navigate", async () => {
    const mac = await owner("Mac Safari", ["https://feed/"]);
    const tab = mac.tab("https://feed/");
    mac.b.pageRewritesUrl(tab, "https://feed/#loading");
    await mac.engine.idle();
    clock.advance(1_000);
    mac.b.pageRewritesUrl(tab, "https://feed/");
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "navigate")).toEqual([]);
    const s = await mac.state();
    expect(s.mappings.tabs[String(tab)]).toEqual({ entryId: entryOf("https://feed/"), url: "https://feed/" });
    expect(s.heldNavigates).toEqual([]);

    mac.b.userNavigate(tab, "https://feed/page2");
    await mac.settle();
    mac.b.userNavigate(tab, "https://feed/page3");
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "navigate").map((o) => o.type === "navigate" && o.url)).toEqual([
      "https://feed/page2",
      "https://feed/page3",
    ]);
  });

  it("a remote navigate or close of an entry whose navigation is still held forks, like a journaled one", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/", "https://keep/"]);
    const mac = await follower("Mac Safari");
    clock.advance(15_000); // past the post-load grace of the tabs the follower just received
    await mac.quiet();
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/mac");
    mac.b.userNavigate(mac.tab("https://b/"), "https://b/mac");
    await mac.engine.idle(); // both held, nothing journaled
    expect((await mac.state()).pending).toEqual([]);
    brave.b.userNavigate(brave.tab("https://a/"), "https://a/brave");
    brave.b.userCloseTab(brave.tab("https://b/"));
    await brave.settle();

    await mac.engine.runNow(); // applies both before the holds release
    await mac.settle();
    expect(removals(mac)).toBe(0);
    expect(await mac.urls()).toEqual(["https://a/brave", "https://a/mac", "https://b/mac", "https://keep/"]);
    expect(mac.merged().map((o) => o.type)).toEqual(["open", "open"]); // the forks, no navigate
    await mac.engine.runNow();
    await mac.settle();
    expect(server.openUrls().sort()).toEqual(["https://a/brave", "https://a/mac", "https://b/mac", "https://keep/"]);
    expect((await mac.state()).heldNavigates).toEqual([]);
  });

  it("held navigates survive a worker restart and are released by the new worker", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/next");
    await mac.engine.idle(); // held; the worker dies before the release
    expect((await mac.state()).heldNavigates).toHaveLength(1);

    const w = await restartWorker(mac);
    expect(w.timers.size).toBe(1);
    await settleWorker(w);
    expect(mac.sent().filter((o) => o.type === "navigate").map((o) => o.type === "navigate" && o.url)).toEqual(["https://a/next"]);
    expect(server.openUrls()).toEqual(["https://a/next"]);
    expect((await mac.state()).heldNavigates).toEqual([]);
  });

  it("a navigation still held when the browser quits is journaled by the startup reset", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/last");
    await mac.engine.idle();
    clock.advance(1_000);
    mac.b.restart();
    mac.b.restoreTab(mac.b.addWindow({ focused: true }), "https://a/last");
    mac.b.events.startup.emit();
    await mac.settle();
    expect(mac.sent().filter((o) => o.type === "navigate").map((o) => o.type === "navigate" && o.url)).toEqual(["https://a/last"]);
    expect(server.openUrls()).toEqual(["https://a/last"]);
    const s = await mac.state();
    expect(s.heldNavigates).toEqual([]);
    expect(Object.values(s.mappings.tabs)).toEqual([{ entryId: entryOf("https://a/last"), url: "https://a/last" }]);
  });

  describe("window teardown on Windows (tabs removed one by one, isWindowClosing false)", () => {
    /** An owner with a second window of `shared` shared tabs (and `blank` new tab pages). */
    async function withWindow(shared: number, blank = 0): Promise<{ mac: Dev; w2: number; ids: number[] }> {
      const mac = await owner("Brave", ["https://keep/"]);
      const tabs = [
        ...Array.from({ length: shared }, (_, i) => ({ url: `https://t${i}/` })),
        ...Array.from({ length: blank }, () => ({ url: "chrome://newtab/" })),
      ];
      const w2 = mac.b.addWindow({ tabs });
      await mac.engine.takeover(); // publishes the new window's tabs
      await mac.settle();
      expect(server.openUrls()).toHaveLength(shared + 1);
      const ids = mac.b.tabs.filter((t) => t.windowId === w2 && t.url?.startsWith("https:")).map((t) => t.id);
      return { mac, w2, ids };
    }

    /** Remove tabs one second apart; each removal is processed before the next. */
    async function removeSlowly(d: Dev, ids: number[]): Promise<void> {
      for (const id of ids) {
        d.b.userCloseTab(id);
        await d.engine.idle();
        clock.advance(1_000);
      }
    }
    const closes = (d: Dev) => d.sent().filter((o) => o.type === "close");

    it("ten removals a second apart from a window that then disappears: no close", async () => {
      const { mac, w2, ids } = await withWindow(10);
      await removeSlowly(mac, ids);
      mac.b.windows = mac.b.windows.filter((w) => w.id !== w2); // no windows.onRemoved
      await mac.settle();
      expect(closes(mac)).toEqual([]);
      expect(server.openUrls()).toHaveLength(11);
      expect((await mac.state()).heldCloses).toEqual([]);
    });

    it("ten removals a second apart from a window still listed without tabs: no close", async () => {
      const { mac, ids } = await withWindow(10);
      await removeSlowly(mac, ids);
      await mac.settle();
      expect(closes(mac)).toEqual([]);
      expect(server.openUrls()).toHaveLength(11);
    });

    it("ten removals a second apart from a window that keeps its other tabs: ten closes", async () => {
      const { mac, ids } = await withWindow(10, 10);
      await removeSlowly(mac, ids);
      await mac.settle();
      expect(closes(mac)).toHaveLength(10);
      expect(server.openUrls()).toEqual(["https://keep/"]);
    });

    it("two of three tabs closed within 2 s: two closes", async () => {
      const { mac, ids } = await withWindow(3);
      mac.b.userCloseTab(ids[0]!);
      await mac.engine.idle();
      clock.advance(500);
      mac.b.userCloseTab(ids[1]!);
      await mac.settle();
      expect(closes(mac)).toHaveLength(2);
      expect(server.openUrls().sort()).toEqual(["https://keep/", "https://t2/"]);
    });

    it("one removal from a window that keeps other tabs is one close after the 2 s hold", async () => {
      const { mac, ids } = await withWindow(2);
      const before = clock.t;
      mac.b.userCloseTab(ids[0]!);
      await mac.engine.idle();
      expect(closes(mac)).toEqual([]);
      expect((await mac.state()).heldCloses).toHaveLength(1);
      await mac.settle();
      expect(closes(mac)).toHaveLength(1);
      expect(clock.t - before).toBeGreaterThanOrEqual(2_000);
    });

    it("a worker killed mid-teardown: the restarted worker sends nothing", async () => {
      const { mac, w2, ids } = await withWindow(10);
      await removeSlowly(mac, ids.slice(0, 5));
      // The worker dies; the browser finishes closing the window while it is down.
      mac.b.tabs = mac.b.tabs.filter((t) => t.windowId !== w2);
      mac.b.windows = mac.b.windows.filter((w) => w.id !== w2);
      const w = await restartWorker(mac);
      await settleWorker(w);
      expect(closes(mac)).toEqual([]);
      expect(server.openUrls()).toHaveLength(11);
      expect((await mac.state()).heldCloses).toEqual([]);
    });
  });
});
