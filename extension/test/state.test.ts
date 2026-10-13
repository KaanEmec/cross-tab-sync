import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/adapter/fake.js";
import { BusyError, withRunLock } from "../src/core/lock.js";
import { statusView } from "../src/core/messages.js";
import { defaultState, isPaired, loadState, RUN_LOCK_TTL_MS, saveState } from "../src/core/state.js";

describe("state", () => {
  it("loads defaults from empty storage", async () => {
    expect(await loadState(new MemoryStorage())).toEqual(defaultState());
  });

  it("saves partial patches without clobbering other fields", async () => {
    const st = new MemoryStorage();
    await saveState(st, { serverUrl: "https://s", token: "t", deviceId: "d" });
    await saveState(st, { lastRevision: 5 });
    const s = await loadState(st);
    expect(s).toMatchObject({ serverUrl: "https://s", token: "t", lastRevision: 5 });
    expect(isPaired(s)).toBe(true);
  });

  it("status view reports pending count and ownership", async () => {
    const s = { ...defaultState(), generation: 3, pending: [{ op: { opId: "1", type: "close" as const, entryId: "e" }, queuedAt: "" }] };
    expect(statusView(s)).toMatchObject({ isOwner: true, pendingCount: 1, paired: false, running: false });
  });
});

describe("run lock", () => {
  it("rejects a second run while one holds the lock and releases afterwards", async () => {
    const st = new MemoryStorage();
    let release!: () => void;
    const first = withRunLock(st, "continueHere", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    await expect(withRunLock(st, "handOver", async () => 1)).rejects.toBeInstanceOf(BusyError);
    expect((await loadState(st)).runLock?.action).toBe("continueHere");
    release();
    await first;
    expect((await loadState(st)).runLock).toBeNull();
    await expect(withRunLock(st, "handOver", async () => 2)).resolves.toBe(2);
  });

  it("takes over an abandoned lock", async () => {
    const st = new MemoryStorage();
    await saveState(st, { runLock: { action: "handOver", startedAt: 0 } });
    await expect(withRunLock(st, "continueHere", async () => "ok", () => RUN_LOCK_TTL_MS + 1)).resolves.toBe("ok");
  });

  it("releases the lock when the run throws", async () => {
    const st = new MemoryStorage();
    await expect(withRunLock(st, "x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await loadState(st)).runLock).toBeNull();
  });
});
