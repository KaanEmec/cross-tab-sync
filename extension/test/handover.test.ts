import { beforeEach, describe, expect, it } from "vitest";
import { FakeBrowser } from "../src/adapter/fake.js";
import { ApiError } from "../src/core/client.js";
import {
  continueHere,
  createPairingCode,
  disconnect,
  handOver,
  heartbeat,
  pair,
  pairFromPending,
  refreshOwner,
  resetForBrowserStartup,
  type Deps,
} from "../src/core/handover.js";
import { list } from "../src/core/journal.js";
import { loadState, saveState } from "../src/core/state.js";
import { FakeServer } from "./support/fakeServer.js";

let server: FakeServer;
let codeSeq = 0;

beforeEach(() => {
  server = new FakeServer();
});

interface Dev {
  b: FakeBrowser;
  deps: Deps;
  state: () => ReturnType<typeof loadState>;
}

async function device(name: string, setup: (b: FakeBrowser) => void = () => {}): Promise<Dev> {
  const b = new FakeBrowser();
  setup(b);
  const deps: Deps = { adapter: b, api: server.api, browser: name.includes("Safari") ? "safari" : "brave" };
  const code = `PAIR${++codeSeq}`.padEnd(8, "0");
  server.codes.add(code);
  await pair(deps, { serverUrl: "https://sync.example/", deviceName: name, code });
  return { b, deps, state: () => loadState(b.storage) };
}

const urls = (b: FakeBrowser) => b.tabs.map((t) => t.url);
const createCalls = (b: FakeBrowser) => b.calls.filter((c) => c.method === "createTab" || c.method === "createWindow");

describe("pairing", () => {
  it("stores credentials and normalized server URL", async () => {
    const d = await device("Mac Safari");
    const s = await d.state();
    expect(s).toMatchObject({ serverUrl: "https://sync.example", deviceName: "Mac Safari", deviceId: "dev-1" });
    expect(s.token).toMatch(/^cts_/);
  });

  it("surfaces an invalid code without storing credentials", async () => {
    const b = new FakeBrowser();
    const deps: Deps = { adapter: b, api: server.api, browser: "brave" };
    await expect(pair(deps, { serverUrl: "https://sync.example", deviceName: "x", code: "WRONG000" })).rejects.toMatchObject({
      code: "invalid_code",
    });
    const s = await loadState(b.storage);
    expect(s.token).toBeNull();
    expect(s.lastError).toBeTruthy();
  });

  it("completes a pairing saved by the popup exactly once", async () => {
    const b = new FakeBrowser();
    const deps: Deps = { adapter: b, api: server.api, browser: "brave" };
    await saveState(b.storage, {
      pendingPair: { serverUrl: "https://sync.example", deviceName: "Brave", code: "GOODCODE", createdAt: Date.now() },
    });
    expect((await pairFromPending(deps))?.deviceId).toBe("dev-1");
    expect(await pairFromPending(deps)).toBeNull();
    expect((await loadState(b.storage)).pendingPair).toBeNull();
  });

  it("creates a pairing code for another device", async () => {
    const d = await device("Mac Safari");
    const { code } = await createPairingCode(d.deps);
    expect(server.codes.has(code)).toBe(true);
  });
});

describe("Continue here", () => {
  it("acquires, reuses tabs by URL, creates the rest in the background, publishes local extras", async () => {
    const other = await device("Brave", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }, { url: "https://b/" }] }));
    await continueHere(other.deps);
    expect(server.openUrls()).toEqual(["https://a/", "https://b/"]);

    let focused = 0;
    let privateWin = 0;
    const mac = await device("Mac Safari", (b) => {
      b.addWindow({ tabs: [{ url: "https://b/" }] });
      focused = b.addWindow({ focused: true, tabs: [{ url: "https://local/", active: true }, { url: "about:blank" }] });
      privateWin = b.addWindow({ incognito: true, tabs: [{ url: "https://secret/" }] });
    });
    const activeBefore = mac.b.activeTabs();

    const s = await continueHere(mac.deps);

    // Reused https://b/, created only https://a/, in the last focused normal window, in the background.
    expect(createCalls(mac.b)).toEqual([{ method: "createTab", args: [{ windowId: focused, url: "https://a/", pinned: false }] }]);
    expect(mac.b.tabs.find((t) => t.url === "https://a/")?.active).toBe(false);
    expect(mac.b.activeTabs()).toEqual(activeBefore);
    expect(mac.b.lastFocusedWindowId).toBe(focused);
    // Local extra published; private and non-http tabs not.
    expect(server.openUrls().sort()).toEqual(["https://a/", "https://b/", "https://local/"]);
    expect(server.openUrls()).not.toContain("https://secret/");
    expect(mac.b.tabs.filter((t) => t.windowId === privateWin)).toHaveLength(1);

    expect(s.generation).toBe(2);
    expect(s.lastRevision).toBe(server.revision);
    expect(s.pending).toEqual([]);
    expect(s.statusText).toBe(`Owner, generation 2, revision ${server.revision}`);
    expect(s.receivingWindowId).toBe(focused);
    expect(new Set(Object.values(s.mappings.tabs).map((m) => m.entryId)).size).toBe(3);
    expect(server.owner?.deviceId).toBe(s.deviceId);
    expect(server.requests.find((r) => r.path === "acquire" && r.device === s.deviceId)?.body).toEqual({ force: true });
  });

  it("preserves existing local duplicates and never removes tabs", async () => {
    const other = await device("Brave", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(other.deps);
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }, { url: "https://a/" }] }));
    const s = await continueHere(mac.deps);
    expect(urls(mac.b)).toEqual(["https://a/", "https://a/"]);
    expect(createCalls(mac.b)).toEqual([]);
    expect(mac.b.calls.some((c) => c.method === "removeTab")).toBe(false);
    expect(s.mappings.urlCounts).toEqual({ "https://a/": 2 });
  });

  it("falls back to the persisted receiving window, then creates an unfocused window", async () => {
    const other = await device("Brave", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }, { url: "https://b/" }] }));
    await continueHere(other.deps);

    const mac = await device("Mac Safari", (b) => b.addWindow({ type: "popup" }));
    await continueHere(mac.deps);
    expect(mac.b.calls.map((c) => c.method)).toEqual(["createWindow", "createTab"]);
    expect(mac.b.lastFocusedWindowId).toBeNull();
    const s = await mac.state();
    expect(s.receivingWindowId).toBe(mac.b.tabs[0]?.windowId);
  });

  it("with an unreachable server surfaces the error and changes nothing locally", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://local/", active: true }] }));
    const before = await mac.state();
    server.unreachable = true;

    await expect(continueHere(mac.deps)).rejects.toMatchObject({ code: "network_error" });

    const after = await mac.state();
    expect(after.lastError).toBe("Server is unreachable");
    expect(after.generation).toBeNull();
    expect(after.mappings).toEqual(before.mappings);
    expect(after.pending).toEqual([]);
    expect(mac.b.calls).toEqual([]);
    expect(urls(mac.b)).toEqual(["https://local/"]);
  });
});

describe("Hand over", () => {
  it("publishes unmapped tabs, releases, and reports the revision", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    const win = mac.b.windows[0]!.id;
    mac.b.addTab(win, { url: "https://new/" });
    mac.b.addTab(win, { url: "https://new/" });
    mac.b.addTab(win, { url: "brave://settings/" });

    const s = await handOver(mac.deps);

    expect(server.openUrls().sort()).toEqual(["https://a/", "https://new/"]);
    expect(server.owner).toBeNull();
    expect(s.generation).toBeNull();
    expect(s.pending).toEqual([]);
    expect(s.lastRevision).toBe(server.revision);
    expect(s.statusText).toBe(`Handed over at revision ${server.revision}`);
    expect(s.lastError).toBeNull();
  });

  it("refuses when this device is not the owner", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true }));
    await expect(handOver(mac.deps)).rejects.toThrow(/not the owner/);
    expect((await mac.state()).lastError).toMatch(/not the owner/);
  });

  it("round trip: Safari hands over, Brave continues with the same tabs", async () => {
    const mac = await device("Mac Safari", (b) =>
      b.addWindow({ focused: true, tabs: [{ url: "https://a/", pinned: true }, { url: "https://b/#frag", active: true }] }),
    );
    await continueHere(mac.deps);
    await handOver(mac.deps);

    const brave = await device("Brave", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://b/#frag", active: true }] }));
    const s = await continueHere(brave.deps);
    expect(urls(brave.b).sort()).toEqual(["https://a/", "https://b/#frag"]);
    expect(brave.b.tabs.find((t) => t.url === "https://a/")?.pinned).toBe(true);
    expect(brave.b.tabs.find((t) => t.url === "https://b/#frag")?.active).toBe(true);
    expect(s.statusText).toMatch(/^Owner, generation 2/);
  });
});

describe("stale owner", () => {
  it("drops owner state, keeps journaled ops, applies nothing, and recovers on Continue here", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    const brave = await device("Brave", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://brave/" }] }));
    await continueHere(brave.deps);
    const revisionBefore = server.revision;

    mac.b.addTab(mac.b.windows[0]!.id, { url: "https://late/" });
    const err = await handOver(mac.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "stale_owner" });

    const s = await mac.state();
    expect(s.generation).toBeNull();
    expect(s.owner).toMatchObject({ name: "Brave", generation: 2 });
    expect(s.statusText).toMatch(/Brave \(generation 2\) took over/);
    expect(list(s.pending).map((o) => o.type === "open" && o.url)).toEqual(["https://late/"]);
    expect(server.revision).toBe(revisionBefore);
    expect(server.owner?.name).toBe("Brave");

    const s2 = await continueHere(mac.deps);
    expect(s2.pending).toEqual([]);
    expect(server.openUrls()).toContain("https://late/");
    expect(urls(mac.b)).toContain("https://brave/");
  });

  it("heartbeat detects a lost ownership", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true }));
    await continueHere(mac.deps);
    const brave = await device("Brave", (b) => b.addWindow({ focused: true }));
    await continueHere(brave.deps);
    await heartbeat(mac.deps);
    expect((await mac.state()).generation).toBeNull();
  });

  it("status refresh notices another owner", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true }));
    await continueHere(mac.deps);
    const brave = await device("Brave", (b) => b.addWindow({ focused: true }));
    await continueHere(brave.deps);
    expect(await refreshOwner(mac.deps)).toBe(true);
    const s = await mac.state();
    expect(s.generation).toBeNull();
    expect(s.owner?.name).toBe("Brave");
    server.unreachable = true;
    expect(await refreshOwner(mac.deps)).toBe(false);
  });
});

describe("revoked device", () => {
  it("clears credentials on 401 device_revoked", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    server.devices.find((d) => d.name === "Mac Safari")!.revoked = true;

    await expect(handOver(mac.deps)).rejects.toMatchObject({ code: "device_revoked" });
    const s = await mac.state();
    expect(s.token).toBeNull();
    expect(s.deviceId).toBeNull();
    expect(s.generation).toBeNull();
    expect(s.pending).toEqual([]);
    expect(s.serverUrl).toBe("https://sync.example");
    expect(s.lastError).toMatch(/revoked/);
    expect(urls(mac.b)).toEqual(["https://a/"]);
  });
});

describe("journal replay", () => {
  it("resends the same opIds after a lost response without duplicating entries", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true }));
    await continueHere(mac.deps);
    mac.b.addTab(mac.b.windows[0]!.id, { url: "https://x/" });

    server.dropNextOperationsResponse = true;
    await expect(handOver(mac.deps)).rejects.toMatchObject({ code: "network_error" });
    const s1 = await mac.state();
    expect(s1.pending).toHaveLength(1);
    expect(s1.generation).not.toBeNull();
    const opId = s1.pending[0]!.op.opId;
    const revisionAfterLoss = server.revision;

    const s2 = await handOver(mac.deps);
    const sent = server.requests.filter((r) => r.path === "operations").map((r) => (r.body as { operations: { opId: string }[] }).operations);
    expect(sent.at(-1)!.map((o) => o.opId)).toEqual([opId]);
    expect(server.revision).toBe(revisionAfterLoss);
    expect(server.openUrls()).toEqual(["https://x/"]);
    expect(s2.pending).toEqual([]);
  });

  it("follows coalesced results to the existing entry", async () => {
    const brave = await device("Brave", (b) => b.addWindow({ focused: true }));
    await continueHere(brave.deps);
    const entryId = "11111111-1111-4111-8111-111111111111";
    server.inject("dev-x", [{ opId: "o1", type: "open", entryId, url: "https://dup/" }]);
    brave.b.addTab(brave.b.windows[0]!.id, { url: "https://dup/" });
    // brave's lastRevision predates the injected op, so it also arrives as catchUp.
    const s = await handOver(brave.deps);
    expect(Object.values(s.mappings.tabs).map((m) => m.entryId)).toEqual([entryId]);
    expect(server.openUrls()).toEqual(["https://dup/"]);
  });
});

describe("catchUp", () => {
  it("applies foreign opens in the background, reusing local tabs, and never closes on close", async () => {
    const mac = await device("Mac Safari", (b) =>
      b.addWindow({ focused: true, tabs: [{ url: "https://keep/", active: true }, { url: "https://local-match/" }] }),
    );
    await continueHere(mac.deps);
    const keepEntry = (await mac.state()).mappings.tabs[String(mac.b.tabs[0]!.id)]!.entryId;
    const activeBefore = mac.b.activeTabs();

    server.inject("dev-other", [
      { opId: "c1", type: "open", entryId: "E-new", url: "https://remote/" },
      { opId: "c2", type: "open", entryId: "E-match", url: "https://elsewhere/" },
      { opId: "c3", type: "close", entryId: keepEntry },
    ]);
    mac.b.addTab(mac.b.windows[0]!.id, { url: "https://mine/" });

    const s = await handOver(mac.deps);

    expect(urls(mac.b)).toEqual(["https://keep/", "https://local-match/", "https://mine/", "https://remote/", "https://elsewhere/"]);
    expect(mac.b.activeTabs()).toEqual(activeBefore);
    expect(mac.b.calls.some((c) => c.method === "removeTab")).toBe(false);
    const byUrl = (u: string) => Object.entries(s.mappings.tabs).find(([id]) => mac.b.tabs.find((t) => String(t.id) === id)?.url === u)?.[1];
    expect(byUrl("https://remote/")?.entryId).toBe("E-new");
    expect(byUrl("https://keep/")).toBeUndefined(); // unmapped, tab kept
    expect(s.lastRevision).toBe(server.revision);
  });

  it("does not create a tab for a foreign open whose URL is already open locally", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true }));
    await continueHere(mac.deps);
    mac.b.addTab(mac.b.windows[0]!.id, { url: "https://same/" });
    server.inject("dev-other", [{ opId: "c1", type: "open", entryId: "E1", url: "https://same/" }]);
    const s = await handOver(mac.deps);
    expect(urls(mac.b)).toEqual(["https://same/"]);
    expect(Object.values(s.mappings.tabs).map((m) => m.entryId)).toEqual(["E1"]);
    expect(createCalls(mac.b)).toEqual([]);
  });

  it("catches up through changes when there is nothing to publish", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    const sentBefore = server.requests.filter((r) => r.path === "operations").length;
    server.inject("dev-other", [{ opId: "c1", type: "open", entryId: "E1", url: "https://remote/" }]);
    const s = await handOver(mac.deps);
    expect(server.requests.filter((r) => r.path === "operations").length).toBe(sentBefore);
    expect(urls(mac.b)).toEqual(["https://a/", "https://remote/"]);
    expect(mac.b.tabs[1]!.active).toBe(false);
    expect(s.lastRevision).toBe(server.revision);
    expect(s.statusText).toBe(`Handed over at revision ${server.revision}`);
  });
});

describe("lifecycle", () => {
  it("disconnect releases, revokes and forgets credentials", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    const s = await disconnect(mac.deps);
    expect(s.token).toBeNull();
    expect(s.statusText).toBe("Disconnected");
    expect(server.owner).toBeNull();
    expect(server.devices[0]!.revoked).toBe(true);
    expect(urls(mac.b)).toEqual(["https://a/"]);
  });

  it("browser startup clears tab mappings (tab ids are per browser session)", async () => {
    const mac = await device("Mac Safari", (b) => b.addWindow({ focused: true, tabs: [{ url: "https://a/" }] }));
    await continueHere(mac.deps);
    await resetForBrowserStartup(mac.deps);
    const s = await mac.state();
    expect(s.mappings.tabs).toEqual({});
    expect(s.token).not.toBeNull();
  });
});
