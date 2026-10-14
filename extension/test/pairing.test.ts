// Pairing links, device identity (rename, duplicate names) and the device list view model.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBrowser } from "../src/adapter/fake.js";
import type { Device } from "../src/core/client.js";
import {
  activityLine,
  deviceRows,
  devicesSummary,
  errorFix,
  heroView,
  type HeroContext,
  ownerLine,
  primaryAction,
  relativeTime,
  secondsAgo,
  shortId,
  SNAPSHOT_LIMIT,
  snapshotList,
  snapshotRows,
  snapshotsSummary,
} from "../src/core/devices.js";
import { createPairingCode, pair, pairFromPending, type Deps } from "../src/core/handover.js";
import { statusView, type StatusView } from "../src/core/messages.js";
import { defaultDeviceName, normalizeCode, pairingLink, parsePairingInput, resolvePairingForm } from "../src/core/pairing.js";
import { listDevices, renameDevice } from "../src/core/recovery.js";
import { loadState, saveState } from "../src/core/state.js";
import { FakeServer } from "./support/fakeServer.js";

describe("parsePairingInput", () => {
  it.each([
    ["https://tabs.example.com#ABCD2345", "https://tabs.example.com", "ABCD2345"],
    ["https://tabs.example.com/#abcd-2345", "https://tabs.example.com", "ABCD2345"],
    ["https://tabs.example.com/cts#ABCD2345", "https://tabs.example.com/cts", "ABCD2345"],
    ["http://127.0.0.1:8080#ABCD2345", "http://127.0.0.1:8080", "ABCD2345"],
    ["  https://tabs.example.com#ABCD 2345 \n", "https://tabs.example.com", "ABCD2345"],
    ["tabs.example.com#ABCD2345", "https://tabs.example.com", "ABCD2345"],
  ])("link %j", (input, serverUrl, code) => {
    expect(parsePairingInput(input)).toEqual({ serverUrl, code });
  });

  const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

  it.each([
    [`https://tabs.example.com#ABCD2345.${KEY}`, "https://tabs.example.com"],
    [`https://tabs.example.com/cts/#abcd-2345.${KEY}`, "https://tabs.example.com/cts"],
    [`  http://127.0.0.1:8080#ABCD2345.${KEY} \n`, "http://127.0.0.1:8080"],
  ])("invite link with a key %j", (input, serverUrl) => {
    expect(parsePairingInput(input)).toEqual({ serverUrl, code: "ABCD2345", key: KEY });
  });

  it.each([
    [`https://tabs.example.com#ABCD2345.`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}`],
    [`https://tabs.example.com#ABCD2345.${KEY}x`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}+`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}9`], // not canonical
  ])("rejects a damaged key %j, naming the #CODE.KEY format", (input) => {
    expect(() => parsePairingInput(input)).toThrow(/#CODE\.KEY/);
  });

  it("checks the code before the key", () => {
    expect(() => parsePairingInput(`https://tabs.example.com#ABC.${KEY}`)).toThrow(/8 letters and digits/);
  });

  it("accepts a bare code when the server is known", () => {
    expect(parsePairingInput(" abcd-2345 ", "https://tabs.example.com/")).toEqual({ serverUrl: "https://tabs.example.com", code: "ABCD2345" });
    expect(() => parsePairingInput("ABCD2345")).toThrow(/whole pairing link/);
    expect(() => parsePairingInput("ABCD2345", "  ")).toThrow(/whole pairing link/);
  });

  it.each([
    ["", /Paste the pairing link/],
    ["   ", /Paste the pairing link/],
    ["https://tabs.example.com", /no pairing code.*#CODE/],
    ["https://tabs.example.com/#", /no pairing code/],
    ["https://tabs.example.com#ABC", /8 letters and digits/],
    ["https://tabs.example.com#ABCD_2345", /8 letters and digits/],
    ["http://tabs.example.com#ABCD2345", /https/],
    ["https://tabs.example.com/?a=1#ABCD2345", /query/],
    ["ABCD", /8 letters and digits/],
  ])("rejects %j", (input, message) => {
    expect(() => parsePairingInput(input, "https://known.example")).toThrow(message);
  });

  it("resolves the popup form: link first, then the Advanced fields", () => {
    const known = "https://old.example";
    expect(resolvePairingForm({ link: "https://new.example#ABCD2345", serverUrl: "", code: "" }, known)).toEqual({
      serverUrl: "https://new.example",
      code: "ABCD2345",
    });
    expect(resolvePairingForm({ link: "ABCD2345", serverUrl: "", code: "" }, known).serverUrl).toBe(known);
    expect(resolvePairingForm({ link: "ABCD2345", serverUrl: "https://adv.example", code: "" }, known).serverUrl).toBe("https://adv.example");
    expect(resolvePairingForm({ link: " ", serverUrl: "https://adv.example", code: "wxyz-2345" }, "")).toEqual({
      serverUrl: "https://adv.example",
      code: "WXYZ2345",
    });
  });

  it("builds links and default names", () => {
    expect(pairingLink("https://tabs.example.com", "ABCD2345")).toBe("https://tabs.example.com#ABCD2345");
    expect(pairingLink("https://tabs.example.com", "ABCD2345", "k".repeat(43))).toBe(`https://tabs.example.com#ABCD2345.${"k".repeat(43)}`);
    expect(normalizeCode("ab cd-23 45")).toBe("ABCD2345");
    expect(defaultDeviceName("brave", "mac")).toBe("Brave on macOS");
    expect(defaultDeviceName("safari", "mac")).toBe("Safari on macOS");
    expect(defaultDeviceName("brave", "win")).toBe("Brave on Windows");
    expect(defaultDeviceName("brave", "")).toBe("Brave");
  });
});

describe("pairing from a link", () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
  });
  const browser = (kind: "brave" | "safari" = "brave"): Deps => ({ adapter: new FakeBrowser(), api: server.api, browser: kind });

  /** What the popup does: parse the field, save the form, then the worker pairs from it. */
  async function pairWithLink(deps: Deps, link: string, deviceName: string) {
    const target = parsePairingInput(link);
    await saveState(deps.adapter.storage, { pendingPair: { ...target, deviceName, createdAt: Date.now() } });
    return pairFromPending(deps);
  }

  it("pairs from a link, invites another browser, and suffixes its duplicate name", async () => {
    const mac = browser();
    const s = await pairWithLink(mac, "https://sync.example/#good-code", "Brave on macOS");
    expect(s).toMatchObject({ serverUrl: "https://sync.example", deviceName: "Brave on macOS", deviceId: "dev-1" });
    expect(s?.pairedAt).toEqual(expect.any(String));
    expect(server.requests.find((r) => r.path === "pair")?.body).toEqual({ code: "GOODCODE", name: "Brave on macOS", browser: "brave" });

    // First browser of an empty session: it generated the key.
    const key = s!.syncKey!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statusView(s!).encrypted).toBe(true);
    expect(JSON.stringify(statusView(s!))).not.toContain(key);

    // Invite another browser: the link carries the server URL, the new code and the key.
    const invite = await createPairingCode(mac);
    expect(invite.link).toBe(`https://sync.example#${invite.code}.${key}`);
    expect(server.codes.has(invite.code)).toBe(true);

    const other = browser();
    const t = await pairWithLink(other, invite.link, "Brave on macOS");
    expect(t).toMatchObject({ deviceName: "Brave on macOS 2", deviceId: "dev-2", syncKey: key });
    expect(t?.statusText).toMatch(/^Paired as "Brave on macOS 2" \(another device is named "Brave on macOS"\)/);
    expect(server.codes.has(invite.code)).toBe(false); // single use
  });

  it("falls back to a locally built link when the server does not send one", async () => {
    const mac = browser();
    await pair(mac, { serverUrl: "https://sync.example", deviceName: "Mac", code: "GOODCODE" });
    const api = server.api;
    const noLink: Deps = {
      ...mac,
      api: (cfg) => Object.assign(api(cfg), { createPairingCode: async () => ({ code: "ABCD2345", expiresAt: "2026-01-01T00:00:00.000Z" }) }),
    };
    const key = (await loadState(mac.adapter.storage)).syncKey;
    expect((await createPairingCode(noLink)).link).toBe(`https://sync.example#ABCD2345.${key}`);
  });

  it("renames this device, round trip through the server", async () => {
    const mac = browser("safari");
    const brave = browser();
    await pair(mac, { serverUrl: "https://sync.example", deviceName: "Safari on macOS", code: "GOODCODE" });
    server.codes.add("SECOND22");
    await pair(brave, { serverUrl: "https://sync.example", deviceName: "Brave on Windows", code: "SECOND22" });
    await saveState(mac.adapter.storage, { owner: { deviceId: "dev-1", name: "Safari on macOS", generation: 1, lastSeenAt: "t" } });

    let s = await renameDevice(mac, "  Work Mac ");
    expect(s).toMatchObject({ deviceName: "Work Mac", statusText: 'Renamed to "Work Mac"' });
    expect(s.owner?.name).toBe("Work Mac");
    expect(server.devices[0]!.name).toBe("Work Mac");
    expect((await listDevices(brave)).map((d) => d.name)).toEqual(["Work Mac", "Brave on Windows"]);

    s = await renameDevice(mac, "brave on windows");
    expect(s.deviceName).toBe("brave on windows 2");
    expect(s.statusText).toMatch(/another device is named "brave on windows"/);

    await expect(renameDevice(mac, "   ")).rejects.toThrow(/required/);
    await expect(renameDevice(mac, "x".repeat(65))).rejects.toThrow(/64/);
    await expect(server.api({ baseUrl: "", token: "cts_token1" }).renameDevice("dev-2", "Mine")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("backfills pairedAt and the server's name from the device list", async () => {
    const mac = browser();
    await pair(mac, { serverUrl: "https://sync.example", deviceName: "Mac", code: "GOODCODE" });
    await saveState(mac.adapter.storage, { pairedAt: null, deviceName: "stale" });
    await listDevices(mac);
    const s = await loadState(mac.adapter.storage);
    expect(s).toMatchObject({ pairedAt: server.devices[0]!.createdAt, deviceName: "Mac" });
    expect(statusView(s).pairedAt).toBe(s.pairedAt);
  });
});

describe("device list view model", () => {
  const now = Date.parse("2026-10-13T10:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const dev = (over: Partial<Device>): Device => ({
    id: "00000000-0000-4000-8000-000000000000",
    name: "x",
    browser: "brave",
    createdAt: ago(86_400_000 * 3),
    lastSeenAt: ago(0),
    isSelf: false,
    ...over,
  });

  it("marks this device, shows short ids and last seen, greys revoked ones without Revoke", () => {
    const rows = deviceRows(
      [
        dev({ id: "1a2b3c4d-0000-4000-8000-000000000001", name: "Brave on macOS", isSelf: true }),
        dev({ id: "5e6f7a8b-0000-4000-8000-000000000002", name: "Safari on macOS", browser: "safari", lastSeenAt: ago(5 * 60_000) }),
        dev({ id: "9c0d1e2f-0000-4000-8000-000000000003", name: "Old Brave", lastSeenAt: ago(3 * 3600_000), revokedAt: ago(2 * 3600_000) }),
      ],
      now,
    );
    expect(rows).toEqual([
      {
        id: "1a2b3c4d-0000-4000-8000-000000000001",
        name: "Brave on macOS",
        browser: "Brave",
        shortId: "1a2b3c4d",
        seen: "Seen just now",
        revokedNote: null,
        isSelf: true,
        revoked: false,
        canRevoke: false,
      },
      {
        id: "5e6f7a8b-0000-4000-8000-000000000002",
        name: "Safari on macOS",
        browser: "Safari",
        shortId: "5e6f7a8b",
        seen: "Seen 5 min ago",
        revokedNote: null,
        isSelf: false,
        revoked: false,
        canRevoke: true,
      },
      {
        id: "9c0d1e2f-0000-4000-8000-000000000003",
        name: "Old Brave",
        browser: "Brave",
        shortId: "9c0d1e2f",
        seen: "Seen 3 h ago",
        revokedNote: "Revoked 2 h ago",
        isSelf: false,
        revoked: true,
        canRevoke: false,
      },
    ]);
    // No middle-dot meta strings anywhere in the rows.
    expect(JSON.stringify(rows)).not.toContain("\u00b7");
  });

  it("summarizes active browsers", () => {
    expect(devicesSummary([dev({ isSelf: true }), dev({}), dev({ revokedAt: ago(0) })])).toBe("2 browsers");
    expect(devicesSummary([dev({ isSelf: true })])).toBe("1 browser");
  });

  it("builds snapshot rows with device names and tab counts", () => {
    const snap = (over: Partial<{ id: number; deviceId: string; reason: string; entryCount: number }>) => ({
      id: 1,
      revision: 3,
      deviceId: "self",
      reason: "operations",
      createdAt: ago(60_000),
      entryCount: 12,
      ...over,
    });
    const rows = snapshotRows(
      [snap({}), snap({ id: 2, deviceId: "other", entryCount: 1, reason: "restore" }), snap({ id: 3, deviceId: "gone" })],
      "self",
      [dev({ id: "other", name: "Safari on macOS" })],
    );
    expect(rows.map(({ when: _when, ...r }) => r)).toEqual([
      { id: 1, device: "This browser", tabs: "12 tabs", why: "Taken before a change" },
      { id: 2, device: "Safari on macOS", tabs: "1 tab", why: "Taken before a restore" },
      { id: 3, device: "A removed browser", tabs: "12 tabs", why: "Taken before a change" },
    ]);
    expect(rows[0]!.when).toEqual(expect.any(String));
    expect(snapshotsSummary(0)).toBe("None yet");
    expect(snapshotsSummary(1)).toBe("1 snapshot");
    expect(snapshotsSummary(4)).toBe("4 snapshots");

    const many = Array.from({ length: 20 }, (_, i) => i);
    expect(snapshotList(many, false)).toEqual({ rows: many.slice(0, SNAPSHOT_LIMIT), more: "Show all 20" });
    expect(snapshotList(many, true)).toEqual({ rows: many, more: null });
    expect(snapshotList(many.slice(0, 6), false)).toEqual({ rows: many.slice(0, 6), more: null });
  });

  it("formats the owner line and relative times", () => {
    const owner = { deviceId: "1a2b3c4d-0000-4000-8000-000000000001", name: "Brave on macOS", generation: 3, lastSeenAt: ago(0) };
    expect(ownerLine(owner, null)).toBe("Brave on macOS (1a2b3c4d)");
    expect(ownerLine(owner, owner.deviceId)).toBe("Brave on macOS (1a2b3c4d), this device");
    expect(ownerLine(null, owner.deviceId)).toBe("No owner");
    expect(shortId("1a2b3c4d-0000")).toBe("1a2b3c4d");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(ago(30_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * 3600_000), now)).toBe("5 h ago");
    expect(relativeTime(ago(30 * 3600_000), now)).toBe("yesterday");
    expect(relativeTime(ago(3 * 86_400_000), now)).toBe("3 days ago");
    expect(relativeTime(ago(30 * 86_400_000), now)).toMatch(/^on /);
  });
});

describe("hero view model", () => {
  const now = Date.parse("2026-10-13T10:00:00.000Z");
  const self = "1a2b3c4d-0000-4000-8000-000000000001";
  const other = { deviceId: "5e6f7a8b-0000-4000-8000-000000000002", name: "Safari on macOS", generation: 4, lastSeenAt: "t" };
  const base: StatusView = {
    paired: true,
    serverUrl: "https://sync.example",
    deviceName: "Brave on macOS",
    deviceId: self,
    pairedAt: null,
    owner: null,
    isOwner: false,
    generation: null,
    lastRevision: 7,
    minRevision: null,
    lastSuccessAt: new Date(now - 12_000).toISOString(),
    pendingCount: 0,
    online: true,
    nextRetryAt: null,
    paused: false,
    encrypted: true,
    summary: "",
    lastError: null,
    errorKind: null,
    statusText: null,
    running: false,
    lastActivityAt: null,
    lastActivityKind: null,
  };
  const ctx: HeroContext = { now, offline: false, working: false, devices: null };
  const view = (over: Partial<StatusView>, c: Partial<HeroContext> = {}) => heroView({ ...base, ...over }, { ...ctx, ...c });

  it("maps each state to a status line, a driver dot and a tone", () => {
    expect(view({ isOwner: true, generation: 4, owner: { ...other, deviceId: self, name: "Brave on macOS" } })).toMatchObject({
      title: "This browser is driving",
      driver: "self",
      tone: "ok",
      detail: "Saved 12 s ago",
      selfLabel: "Brave on macOS",
    });
    expect(view({ owner: other })).toMatchObject({
      title: "Following Safari on macOS",
      driver: "other",
      tone: "neutral",
      detail: "Synced 12 s ago",
      otherLabel: "Safari on macOS",
    });
    expect(view({})).toMatchObject({ title: "Nobody is driving", driver: "none", tone: "neutral" });
    expect(view({ paused: true, owner: other })).toMatchObject({ title: "Paused", driver: "other", tone: "warn" });
    expect(view({ paired: false, deviceId: null })).toMatchObject({
      title: "Not connected",
      driver: "none",
      tone: "off",
      selfLabel: "This browser",
      otherLabel: "Other browsers",
    });
    expect(view({ owner: other, lastError: "Cannot reach", errorKind: "unreachable" })).toMatchObject({ tone: "bad", driver: "other" });
  });

  it("describes pending work, retries and offline in the detail line", () => {
    const retryAt = new Date(2026, 9, 13, 10, 42).getTime();
    expect(view({ pendingCount: 3, nextRetryAt: retryAt }).detail).toBe("3 changes waiting, retrying at 10:42");
    expect(view({ pendingCount: 1 }).detail).toBe("1 change waiting");
    expect(view({ pendingCount: 3, online: false }).detail).toBe("Offline, 3 changes waiting");
    expect(view({ pendingCount: 3 }, { offline: true }).detail).toBe("Offline, 3 changes waiting");
    expect(view({}, { offline: true }).detail).toBe("Offline");
    expect(view({ lastSuccessAt: null }).detail).toBe("Not synced yet");
    expect(view({}, { working: true }).detail).toBe("Syncing now");
    expect(view({ paused: true, pendingCount: 2 }).detail).toBe("2 changes waiting, kept until you resume");
    expect(view({ isOwner: true, lastSuccessAt: new Date(now - 5 * 60_000).toISOString() }).detail).toBe("Saved 5 min ago");
  });

  it("labels the other relay dot from the device list when not following", () => {
    const d = (id: string, name: string, over: Partial<Device> = {}): Device => ({
      id,
      name,
      browser: "brave",
      createdAt: "t",
      lastSeenAt: "t",
      isSelf: id === self,
      ...over,
    });
    const mine = d(self, "Brave on macOS");
    expect(view({ isOwner: true }, { devices: [mine, d("b", "Safari on macOS")] }).otherLabel).toBe("Safari on macOS");
    expect(view({ isOwner: true }, { devices: [mine, d("b", "Safari"), d("c", "Edge")] }).otherLabel).toBe("2 other browsers");
    expect(view({ isOwner: true }, { devices: [mine, d("c", "Old", { revokedAt: "t" })] }).otherLabel).toBe("No other browsers");
    expect(view({ isOwner: true }).otherLabel).toBe("Other browsers");
  });

  it("picks the primary action, the error fix and the activity line", () => {
    expect(primaryAction({ ...base, isOwner: true })).toMatchObject({ label: "Hand over", request: "handOver" });
    expect(primaryAction({ ...base, owner: other })).toMatchObject({ label: "Continue here", request: "continueHere" });
    expect(primaryAction(base)).toMatchObject({ label: "Continue here", request: "continueHere" });
    expect(primaryAction({ ...base, paused: true, isOwner: true })).toMatchObject({ label: "Resume sync", request: "resume" });

    expect(errorFix({ lastError: "x", errorKind: "permission" })).toBe("grant");
    expect(errorFix({ lastError: "x", errorKind: "unreachable" })).toBe("retry");
    expect(errorFix({ lastError: "x", errorKind: "server" })).toBe("retry");
    expect(errorFix({ lastError: "x", errorKind: "device_revoked" })).toBeNull();
    expect(errorFix({ lastError: null, errorKind: "server" })).toBeNull();

    expect(activityLine({ lastActivityAt: null, lastActivityKind: null })).toBe("None yet");
    expect(activityLine({ lastActivityAt: new Date(2026, 9, 13, 10, 22).getTime(), lastActivityKind: "activated" })).toBe("Tab switch, 10:22");
  });

  it("counts seconds for the saved line", () => {
    expect(secondsAgo(new Date(now - 2_000).toISOString(), now)).toBe("just now");
    expect(secondsAgo(new Date(now - 12_000).toISOString(), now)).toBe("12 s ago");
    expect(secondsAgo(new Date(now - 90_000).toISOString(), now)).toBe("1 min ago");
    expect(secondsAgo(new Date(now - 2 * 3600_000).toISOString(), now)).toBe("2 h ago");
  });
});
