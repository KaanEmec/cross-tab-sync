// v1.0 offline work: followers merge their journal, forks, backoff, reconnect, expired history, pause.
import { beforeEach, describe, expect, it } from "vitest";
import { PAUSED_MESSAGE } from "../src/core/engine.js";
import { saveState } from "../src/core/state.js";
import { RETRY_BASE_MS, RETRY_MAX_MS } from "../src/core/status.js";
import { Clock, device, type Dev } from "./support/devices.js";
import { FakeServer } from "./support/fakeServer.js";

let server: FakeServer;
let clock: Clock;

beforeEach(() => {
  server = new FakeServer();
  clock = new Clock();
});

const entryOf = (url: string) => server.session().entries.find((e) => e.url === url)!.id;
const removals = (d: Dev) => d.b.calls.filter((c) => c.method === "removeTab").length;
const long = (i: number) => `https://long.example/${i}/${"x".repeat(1900)}`;

async function owner(name: string, urls: string[]): Promise<Dev> {
  const d = await device(server, clock, name, { tabs: urls.map((url) => ({ url })) });
  await d.engine.takeover();
  await d.settle();
  return d;
}

/** A follower that applied the session, past the post-load grace, with recent activity. */
async function follower(name: string): Promise<Dev> {
  const d = await device(server, clock, name);
  await d.engine.runNow();
  await d.settle();
  clock.advance(15_000);
  await d.quiet();
  return d;
}

describe("follower journal through merge", () => {
  it("reaches the server without ownership, each operation with the revision it was recorded at", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    const base = (await mac.state()).lastRevision;
    const requests = server.requests.length;
    mac.b.userOpenTab(mac.win, "https://m/");
    mac.b.userNavigate(mac.tab("https://a/"), "https://a2/");
    await mac.settle();
    expect((await mac.state()).pending.map((p) => p.baseRevision)).toEqual([base, base]);
    expect(server.requests.length).toBe(requests); // followers only journal between runs

    await mac.engine.runNow("alarm");
    await mac.settle();
    expect(mac.merged().map((o) => [o.type, o.baseRevision])).toEqual([
      ["open", base],
      ["navigate", base],
    ]);
    expect(mac.sent()).toEqual([]);
    expect(mac.acquires()).toBe(0);
    expect(server.owner?.deviceId).toBe(brave.id);
    expect(server.openUrls().sort()).toEqual(["https://a2/", "https://m/"]);
    const s = await mac.state();
    expect(s.pending).toEqual([]);
    expect(s.generation).toBeNull();

    await brave.engine.runNow();
    await brave.settle();
    expect(await brave.urls()).toEqual(["https://a2/", "https://m/"]);
  });

  it("forked: local tabs follow the fork and later batches carry the new entry id", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    const a = entryOf("https://a/");
    mac.b.userNavigate(mac.tab("https://a/"), "https://a/mac");
    for (let i = 0; i < 40; i++) mac.b.userOpenTab(mac.win, long(i)); // pushes the next op into a later batch
    await mac.settle();
    const pinOp = { opId: crypto.randomUUID(), type: "update" as const, entryId: a, pinned: true };
    const s0 = await mac.state();
    await saveState(mac.b.storage, { pending: [...s0.pending, { op: pinOp, queuedAt: "", baseRevision: s0.lastRevision }] });
    brave.b.userNavigate(brave.tab("https://a/"), "https://a/brave");
    await brave.settle();

    await mac.engine.runNow();
    await mac.settle();
    const merges = server.requests.filter((r) => r.path === "merge" && r.device === mac.id);
    expect(merges.length).toBeGreaterThan(1);
    const fork = entryOf("https://a/mac");
    expect(fork).not.toBe(a);
    const s = await mac.state();
    expect(s.mappings.tabs[String(mac.tab("https://a/mac"))]?.entryId).toBe(fork);
    const lastOps = mac.merged().filter((o) => o.opId === pinOp.opId);
    expect(lastOps.map((o) => o.entryId)).toEqual([fork]); // rewritten before it was sent
    expect(server.session().entries.find((e) => e.id === fork)?.pinned).toBe(true);
    expect(server.session().entries.find((e) => e.id === a)?.url).toBe("https://a/brave");
    expect(await mac.urls()).toContain("https://a/brave"); // the remote URL got its own tab
    expect(s.mappings.tabs[String(mac.tab("https://a/brave"))]?.entryId).toBe(a);
    expect(s.pending).toEqual([]);
  });
});

describe("offline and reconnect", () => {
  it("backs off 30 s doubling to 5 min, skips automatic runs meanwhile, and resets on success", async () => {
    await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    mac.b.userOpenTab(mac.win, "https://m/");
    await mac.settle();
    server.unreachable = true;
    await expect(mac.engine.runNow("syncNow")).rejects.toMatchObject({ code: "network_error" });
    let s = await mac.state();
    expect(s).toMatchObject({ online: false, retryAttempts: 1, nextRetryAt: clock.t + RETRY_BASE_MS, errorKind: "unreachable" });
    expect(mac.retries.size).toBe(1);

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = clock.t;
      mac.retries.fire();
      await mac.engine.idle();
      s = await mac.state();
      delays.push(s.nextRetryAt! - clock.t);
      expect(clock.t - before).toBe(i === 0 ? RETRY_BASE_MS : delays[i - 1]);
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, RETRY_MAX_MS, RETRY_MAX_MS]);

    const requests = server.requests.length;
    server.unreachable = false;
    await mac.engine.runNow("alarm"); // before nextRetryAt: waits for the retry timer
    expect(server.requests.length).toBe(requests);
    mac.retries.fire();
    await mac.engine.idle();
    s = await mac.state();
    expect(s).toMatchObject({ online: true, retryAttempts: 0, nextRetryAt: null, errorKind: null, lastError: null, pending: [] });
    expect(s.pendingCount).toBe(0);
    expect(mac.retries.size).toBe(0);
    expect(server.openUrls()).toContain("https://m/");
  });

  it("resubmits the same opIds in order after an outage and a lost response; the server applies once", async () => {
    await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    server.unreachable = true;
    mac.b.userOpenTab(mac.win, "https://x/");
    mac.b.userOpenTab(mac.win, "https://y/");
    mac.b.userNavigate(mac.tab("https://a/"), "https://a2/");
    await mac.settle();
    const ids = (await mac.state()).pending.map((p) => p.op.opId);
    await expect(mac.engine.runNow("syncNow")).rejects.toMatchObject({ code: "network_error" });
    expect((await mac.state()).pending.map((p) => p.op.opId)).toEqual(ids);
    expect((await mac.state()).pendingCount).toBe(3);

    server.unreachable = false;
    server.dropNextOperationsResponse = true; // applied, but the answer is lost
    await expect(mac.engine.runNow("syncNow")).rejects.toMatchObject({ code: "network_error" });
    expect((await mac.state()).pending.map((p) => p.op.opId)).toEqual(ids);
    mac.retries.fire();
    await mac.engine.idle();

    expect(mac.merged().map((o) => o.opId)).toEqual([...ids, ...ids]);
    expect(server.log.filter((l) => ids.includes(l.op.opId))).toHaveLength(3);
    expect(server.openUrls().sort()).toEqual(["https://a2/", "https://x/", "https://y/"]);
    expect((await mac.state()).pending).toEqual([]);
  });

  it("fullResync on operations: rebuilds from the session, detaches vanished entries, merges the rest", async () => {
    const mac = await owner("Mac Safari", ["https://a/", "https://b/"]);
    const b = entryOf("https://b/");
    server.unreachable = true;
    await mac.quiet();
    for (let i = 0; i < 40; i++) mac.b.userOpenTab(mac.win, long(i));
    await mac.settle();
    expect((await mac.state()).pending).toHaveLength(40);
    server.inject("dev-x", [{ opId: crypto.randomUUID(), type: "close", entryId: b }]);
    server.historyStart = server.revision; // mac's lastRevision is now outside the history
    server.unreachable = false;

    await mac.engine.runNow("syncNow");
    await mac.settle();
    const paths = server.requests.filter((r) => r.device === mac.id).map((r) => r.path);
    expect(paths.slice(-3)).toEqual(["operations", "session", "merge"]);
    expect(removals(mac)).toBe(0);
    expect(await mac.urls()).toContain("https://b/");
    const s = await mac.state();
    expect(Object.values(s.detached)).toEqual(["https://b/"]);
    expect(s.pending).toEqual([]);
    expect(s.lastRevision).toBe(server.session().revision - mac.merged().length);
    expect(server.openUrls()).toHaveLength(41);
    expect(server.openUrls()).not.toContain("https://b/");
  });
});

describe("pause and resume", () => {
  it("pause blocks runs and automatic takeover but keeps journaling; resume reconciles first", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    const w2 = mac.b.addWindow({ tabs: [] });
    await mac.engine.pause();
    const before = server.requests.length;

    mac.b.userOpenTab(mac.win, "https://paused/");
    await mac.settle();
    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://a/")); // fresh interaction: no takeover while paused
    await mac.settle();
    await mac.engine.runNow("alarm");
    await expect(mac.engine.runNow("syncNow")).rejects.toThrow(PAUSED_MESSAGE);
    await expect(mac.engine.takeover("continueHere")).rejects.toThrow(PAUSED_MESSAGE);
    expect(server.requests.length).toBe(before);
    expect(mac.acquires()).toBe(0);
    expect((await mac.state()).pending.map((p) => p.op.type)).toEqual(["open"]);

    // A removal held when the worker stopped; its window is gone by the time sync resumes.
    const t = mac.b.tabs.find((x) => x.url === "https://b/")!;
    mac.b.tabs = mac.b.tabs.map((x) => (x.id === t.id ? { ...x, windowId: w2 } : x));
    mac.b.userCloseTab(t.id);
    await mac.engine.idle();
    expect((await mac.state()).heldCloses.filter((h) => !h.done)).toHaveLength(1);
    mac.b.userCloseWindow(w2, { windowEvent: false });
    clock.advance(3_000);

    const s = await mac.engine.unpause();
    await mac.settle();
    expect(s.paused).toBe(false);
    expect(mac.merged().map((o) => o.type)).toEqual(["open"]); // no close for the vanished window
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/", "https://paused/"]);
    expect(mac.acquires()).toBe(0);
    expect((await mac.state()).pending).toEqual([]);
  });
});
