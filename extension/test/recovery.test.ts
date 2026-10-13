// v1.0 recovery, devices, status strings and upgrade safety.
import { beforeEach, describe, expect, it } from "vitest";
import { statusView } from "../src/core/messages.js";
import { listDevices, listSnapshots, revokeDevice } from "../src/core/recovery.js";
import { defaultState, loadState } from "../src/core/state.js";
import { APPLIED_ELSEWHERE_NOTE, clock as hhmm, retryDelay, syncSummary } from "../src/core/status.js";
import { Clock, device, type Dev } from "./support/devices.js";
import { FakeServer } from "./support/fakeServer.js";

let server: FakeServer;
let clock: Clock;

beforeEach(() => {
  server = new FakeServer();
  clock = new Clock();
});

async function owner(name: string, urls: string[]): Promise<Dev> {
  const d = await device(server, clock, name, { tabs: urls.map((url) => ({ url })) });
  await d.engine.takeover();
  await d.settle();
  return d;
}

async function follower(name: string, opts: Parameters<typeof device>[3] = {}): Promise<Dev> {
  const d = await device(server, clock, name, opts);
  await d.engine.runNow();
  await d.settle();
  return d;
}

describe("restore", () => {
  it("takes over when not owner, restores, and opens the restored entries in the background", async () => {
    const brave = await owner("Brave", ["https://a/", "https://b/", "https://c/"]);
    const mac = await follower("Mac Safari", { tabs: [{ url: "https://mine/", active: true }] });
    clock.advance(15_000);
    brave.b.userCloseTab(brave.tab("https://b/"));
    brave.b.userCloseTab(brave.tab("https://c/"));
    await brave.settle();
    await mac.engine.runNow();
    await mac.settle();
    expect(await mac.urls()).toEqual(["https://a/", "https://mine/"]);
    const activeBefore = mac.b.activeTabs();

    const snaps = await listSnapshots(mac.deps);
    const full = snaps.find((s) => s.entryCount === 3)!; // a, b, c before the closes
    expect(full.deviceId).toBe(brave.id);
    const s = await mac.engine.restore(full.id);
    await mac.settle();

    expect(mac.acquires()).toBe(1);
    const restore = server.requests.find((r) => r.path === "restore")!;
    expect(restore.body).toEqual({ id: full.id, generation: s.generation });
    expect(server.owner?.deviceId).toBe(mac.id);
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/", "https://c/", "https://mine/"]);
    expect(await mac.urls()).toEqual(["https://a/", "https://b/", "https://c/", "https://mine/"]);
    expect(mac.b.tabs.filter((t) => t.url === "https://b/" || t.url === "https://c/").every((t) => !t.active)).toBe(true);
    expect(mac.b.activeTabs()).toEqual(activeBefore);
    expect(s.statusText).toMatch(/^Restored 2 tab\(s\)\. Owner, generation \d+/);
    expect((await mac.state()).pending).toEqual([]);
    expect((await listSnapshots(mac.deps))[0]?.reason).toBe("restore"); // pre-restore state kept

    await brave.engine.runNow(); // stale owner: follows and receives the restored tabs
    await brave.settle();
    expect(await brave.urls()).toEqual(["https://a/", "https://b/", "https://c/", "https://mine/"]);
  });
});

describe("devices", () => {
  it("lists devices and revokes another one; that device is cleared on its next run", async () => {
    const brave = await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");
    const devices = await listDevices(mac.deps);
    expect(devices.map((d) => [d.name, d.isSelf])).toEqual([
      ["Brave", false],
      ["Mac Safari", true],
    ]);
    await expect(revokeDevice(mac.deps, mac.id)).rejects.toThrow(/Disconnect/);

    const s = await revokeDevice(mac.deps, brave.id);
    expect(s.owner).toBeNull();
    expect(server.owner).toBeNull();
    expect((await listDevices(mac.deps)).map((d) => d.name)).toEqual(["Mac Safari"]);
    await expect(brave.engine.runNow("syncNow")).rejects.toMatchObject({ code: "device_revoked" });
    const b = await brave.state();
    expect(b).toMatchObject({ token: null, errorKind: "device_revoked", lastError: "This device was revoked on the server. Pair it again." });
  });
});

describe("status", () => {
  const run = async (d: Dev) => d.engine.runNow("syncNow").catch((e: unknown) => e);

  it("explains each error class with an action", async () => {
    await owner("Brave", ["https://a/"]);
    const mac = await follower("Mac Safari");

    server.unreachable = true;
    await run(mac);
    let s = await mac.state();
    expect(s).toMatchObject({ errorKind: "unreachable", online: false });
    expect(s.lastError).toBe("Cannot reach https://sync.example. Check the connection or the server; changes are kept and retried.");

    mac.b.hostPermission = false;
    await run(mac);
    s = await mac.state();
    expect(s.errorKind).toBe("permission");
    expect(s.lastError).toBe("Grant access to https://sync.example in the extension's site permissions.");

    server.unreachable = false;
    server.failNext = { status: 503, count: 1 };
    await run(mac);
    s = await mac.state();
    expect(s).toMatchObject({ errorKind: "server", online: false, lastError: "The server failed (HTTP 503). Changes are kept and retried." });

    server.devices.find((d) => d.id === mac.id)!.token = "cts_rotated";
    await run(mac);
    s = await mac.state();
    expect(s.errorKind).toBe("unauthorized");
    expect(s.lastError).toBe("The server does not accept this device's credentials. Disconnect, then pair again with a new code.");
    // The server answered: no retry can fix this, so none stays scheduled.
    expect(s).toMatchObject({ online: true, nextRetryAt: null, retryAttempts: 0 });
    expect(mac.retries.size).toBe(0);
  });

  it("summarizes saved, waiting, offline and paused work", () => {
    const base = { paused: false, online: true, pendingCount: 0, nextRetryAt: null, lastSuccessAt: "2026-10-13T10:00:00.000Z" };
    const at = Date.parse("2026-10-13T10:05:00.000Z");
    expect(syncSummary(base)).toBe("Saved to server");
    expect(syncSummary({ ...base, lastSuccessAt: null })).toBe("Not synced yet");
    expect(syncSummary({ ...base, pendingCount: 1 })).toBe("1 change waiting");
    expect(syncSummary({ ...base, pendingCount: 3, online: false, nextRetryAt: at })).toBe(`3 changes waiting (offline, retrying at ${hhmm(at)})`);
    expect(syncSummary({ ...base, pendingCount: 2, nextRetryAt: at })).toBe(`2 changes waiting (retrying at ${hhmm(at)})`);
    expect(syncSummary({ ...base, online: false })).toBe("Offline");
    expect(syncSummary({ ...base, paused: true, pendingCount: 2 })).toBe("Paused, 2 changes waiting");
    expect(hhmm(at)).toMatch(/^\d\d:\d\d$/);
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(APPLIED_ELSEWHERE_NOTE).toMatch(/^Applied on other devices: unknown\./);

    const view = statusView({ ...defaultState(), pending: [], paused: true });
    expect(view).toMatchObject({ paused: true, pendingCount: 0, summary: "Paused", online: true });
  });
});

describe("upgrade", () => {
  it("an extension update runs the browser-startup reset even inside the same browser session", async () => {
    await owner("Brave", ["https://a/", "https://b/"]);
    const mac = await follower("Mac Safari");
    const before = await mac.state();
    expect(Object.keys(before.mappings.tabs)).toHaveLength(2);

    clock.advance(60_000);
    await mac.engine.startup("update");
    const s = await loadState(mac.b.storage);
    expect(s.staleMappings).toBeNull(); // set aside, then re-matched by URL right away
    expect(Object.values(s.mappings.tabs).map((m) => m.url).sort()).toEqual(["https://a/", "https://b/"]);
    expect(s.startupAt).toBe(clock.t);
    expect(s.expected).toEqual([]);

    mac.b.userCloseTab(mac.tab("https://a/")); // inside the startup grace: unmap only
    await mac.settle();
    expect((await mac.state()).pending).toEqual([]);
    expect(server.openUrls()).toContain("https://a/");
  });
});
