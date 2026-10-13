// Review fixes: retry timer after non-retryable errors, 403 vs malformed batches, takeover merges
// the follower journal first, worker restart, and the expired-base own-entry exemption.
import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/core/engine.js";
import { saveState } from "../src/core/state.js";
import { Clock, device, ManualTimers, type Dev } from "./support/devices.js";
import { FakeServer, uuidv5 } from "./support/fakeServer.js";

let server: FakeServer;
let clock: Clock;

beforeEach(() => {
  server = new FakeServer();
  clock = new Clock();
});

const entryOf = (url: string) => server.session().entries.find((e) => e.url === url)!.id;

async function owner(name: string, urls: string[]): Promise<Dev> {
  const d = await device(server, clock, name, { tabs: urls.map((url) => ({ url })) });
  await d.engine.takeover();
  await d.settle();
  return d;
}

async function follower(name: string): Promise<Dev> {
  const d = await device(server, clock, name);
  await d.engine.runNow();
  await d.settle();
  clock.advance(15_000);
  await d.quiet();
  return d;
}

describe("retry timer", () => {
  it("a non-retryable answer after a backoff leaves no retry scheduled", async () => {
    await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    mac.b.userOpenTab(mac.win, "https://m/");
    await mac.settle();
    server.unreachable = true;
    await expect(mac.engine.runNow("syncNow")).rejects.toMatchObject({ code: "network_error" });
    expect(mac.retries.size).toBe(1);

    server.unreachable = false;
    server.failNext = { status: 200, count: 1, code: "invalid_response" };
    mac.retries.fire();
    await mac.engine.idle();
    const s = await mac.state();
    expect(s).toMatchObject({ nextRetryAt: null, retryAttempts: 0, online: true, errorKind: null });
    expect(s.pending).toHaveLength(1); // kept for the next run
    expect(mac.retries.size).toBe(0);
    expect(mac.timers.size).toBe(0);
  });

  it("a 403 invalid_request (HTTPS required) keeps the journal and reports the error", async () => {
    const mac = await owner("Mac Safari", ["https://a/"]);
    await mac.quiet();
    server.failNext = { status: 403, count: 1, code: "invalid_request" };
    mac.b.userOpenTab(mac.win, "https://b/");
    await mac.settle();
    let s = await mac.state();
    expect(s.pending.map((p) => p.op.type)).toEqual(["open"]);
    expect(s.lastError).toBe("invalid_request (403)");
    expect(Object.values(s.mappings.tabs).map((m) => m.url)).toContain("https://b/");

    await mac.engine.runNow("syncNow");
    s = await mac.state();
    expect(s.pending).toEqual([]);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/"]);
  });
});

describe("takeover merges the follower journal first", () => {
  it("a stale close journaled while following does not close another device's navigated page", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    mac.b.userCloseTab(mac.tab("https://a/"));
    await mac.settle();
    expect((await mac.state()).pending.map((p) => p.op.type)).toEqual(["close"]);
    brave.b.userNavigate(brave.tab("https://a/"), "https://a/brave");
    await brave.settle();

    clock.advance(61_000);
    mac.b.userActivate(mac.tab("https://b/"));
    await mac.settle();
    expect(mac.acquires()).toBe(1);
    expect(mac.merged().map((o) => o.type)).toEqual(["close"]);
    expect(mac.sent().filter((o) => o.type === "close")).toEqual([]);
    expect(server.openUrls().sort()).toEqual(["https://a/brave", "https://b/"]);
    expect(await mac.urls()).toEqual(["https://a/brave", "https://b/"]);
    expect((await mac.state()).pending).toEqual([]);
  });

  it("with expired history the journal still goes through merge", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    mac.b.userOpenTab(mac.win, "https://x/");
    await mac.settle();
    brave.b.userOpenTab(brave.win, "https://c/");
    await brave.settle();
    server.historyStart = server.revision; // mac's lastRevision is outside the history

    await mac.engine.takeover("continueHere");
    await mac.settle();
    expect(server.requests.filter((r) => r.device === mac.id).map((r) => r.path).slice(-4)).toEqual([
      "merge",
      "changes", // 410
      "acquire",
      "operations",
    ]);
    expect(mac.merged().map((o) => o.type === "open" && o.url)).toEqual(["https://x/"]);
    expect(mac.sent()).toEqual([]);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://c/", "https://x/"]);
    expect(await mac.urls()).toEqual(["https://a/", "https://c/", "https://x/"]);
  });

  it("after a lost merge response, the takeover replays the same opIds", async () => {
    await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    mac.b.userOpenTab(mac.win, "https://x/");
    mac.b.userOpenTab(mac.win, "https://y/");
    await mac.settle();
    const ids = (await mac.state()).pending.map((p) => p.op.opId);
    server.dropNextOperationsResponse = true;
    await expect(mac.engine.runNow("syncNow")).rejects.toMatchObject({ code: "network_error" });

    await mac.engine.takeover("continueHere");
    await mac.settle();
    expect(mac.merged().map((o) => o.opId)).toEqual([...ids, ...ids]);
    expect(mac.sent().map((o) => o.opId).filter((id) => ids.includes(id))).toEqual([]);
    expect(server.log.filter((l) => ids.includes(l.op.opId))).toHaveLength(2);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://x/", "https://y/"]);
    expect((await mac.state()).pending).toEqual([]);
  });
});

describe("worker restart", () => {
  /** A new engine over the same browser and storage, as after the service worker was terminated. */
  function restart(mac: Dev): { engine: SyncEngine; timers: ManualTimers; retries: ManualTimers } {
    const timers = new ManualTimers(clock);
    const retries = new ManualTimers(clock);
    return { engine: new SyncEngine(mac.deps, timers.schedule, retries.schedule), timers, retries };
  }

  it("re-arms the retry, skips it when paused, and releases held closes either way", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    mac.b.userCloseTab(mac.tab("https://a/"));
    await mac.engine.idle(); // held; the old worker dies before releasing it
    await saveState(mac.b.storage, { nextRetryAt: clock.t + 45_000, errorKind: "unreachable", online: false, paused: true });

    let w = restart(mac);
    await w.engine.resume();
    expect(w.retries.size).toBe(0); // paused: no retry
    expect(w.timers.size).toBe(1); // the held close is still released
    w.timers.fire();
    await w.engine.idle();
    expect((await mac.state()).pending.map((p) => p.op.type)).toEqual(["close"]);

    await saveState(mac.b.storage, { paused: false });
    w = restart(mac);
    await w.engine.resume();
    expect(w.retries.size).toBe(1);
    w.retries.fire();
    await w.engine.idle();
    expect(server.openUrls()).toEqual(["https://b/"]);
    expect((await mac.state()).nextRetryAt).toBeNull();

    // A due retry left behind by a non-retryable error is not armed.
    await saveState(mac.b.storage, { nextRetryAt: clock.t - 1, errorKind: "unauthorized" });
    w = restart(mac);
    await w.engine.resume();
    expect(w.retries.size).toBe(0);
  });
});

describe("merge fidelity", () => {
  it("derives forked ids as UUIDv5 like the server", async () => {
    expect(await uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "forked")).toBe("ccee5b53-138f-52d5-93cb-88a50cca858a");
  });

  it("with an expired base, navigating an entry the same batch opened is applied, not forked", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    const tab = mac.b.userOpenTab(mac.win, "https://x/");
    mac.b.userNavigate(tab.id, "https://x2/");
    await mac.settle();
    const s0 = await mac.state();
    expect(s0.pending.map((p) => p.op.type)).toEqual(["open", "navigate"]);
    brave.b.userOpenTab(brave.win, "https://c/");
    await brave.settle();
    server.historyStart = s0.lastRevision + 1; // mac's base is expired

    await mac.engine.runNow();
    await mac.settle();
    const nav = s0.pending[1]!.op;
    expect(server.results.get(nav.opId)?.status).toBe("applied");
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://c/", "https://x2/"]);
    expect((await mac.state()).mappings.tabs[String(tab.id)]?.entryId).toBe(entryOf("https://x2/"));
  });
});
