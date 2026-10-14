// Invite links, Start syncing and joining, popup screens, device identity (rename, duplicate names) and the device list view model.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBrowser } from "../src/adapter/fake.js";
import { ApiClient, ApiError, type Device } from "../src/core/client.js";
import { DEFAULT_SERVER_URL } from "../src/core/config.js";
import { keyCheck } from "../src/core/crypto.js";
import {
  activityLine,
  deviceRows,
  devicesSummary,
  errorFix,
  heroView,
  type HeroContext,
  inviteNote,
  ownerLine,
  primaryAction,
  screenOf,
  relativeTime,
  secondsAgo,
  shortId,
  SNAPSHOT_LIMIT,
  snapshotList,
  snapshotRows,
  snapshotsSummary,
} from "../src/core/devices.js";
import { createPairingCode, pair, pairFromPending, startSyncing, type Deps } from "../src/core/handover.js";
import { statusView, type StatusView } from "../src/core/messages.js";
import { defaultDeviceName, normalizeCode, pairingLink, pairSubmitAction, parsePairingInput, startServerUrl } from "../src/core/pairing.js";
import { listDevices, renameDevice } from "../src/core/recovery.js";
import { loadState, saveState } from "../src/core/state.js";
import { clock, pairingRefusal } from "../src/core/status.js";
import { FakeServer, TEST_KEY } from "./support/fakeServer.js";

describe("parsePairingInput", () => {
  const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

  it.each([
    [`https://tabs.example.com#ABCD2345.${KEY}`, "https://tabs.example.com"],
    [`https://tabs.example.com/cts/#abcd-2345.${KEY}`, "https://tabs.example.com/cts"],
    [`  http://127.0.0.1:8080#ABCD 2345.${KEY} \n`, "http://127.0.0.1:8080"],
    [`tabs.example.com#ABCD2345.${KEY}`, "https://tabs.example.com"],
  ])("invite link %j", (input, serverUrl) => {
    expect(parsePairingInput(input)).toEqual({ serverUrl, code: "ABCD2345", key: KEY });
  });

  it.each([
    [`https://tabs.example.com#ABCD2345.`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}`],
    [`https://tabs.example.com#ABCD2345.${KEY}x`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}+`],
    [`https://tabs.example.com#ABCD2345.${KEY.slice(0, 42)}9`], // not canonical
  ])("rejects a damaged key %j", (input) => {
    expect(() => parsePairingInput(input)).toThrow(/key in this link is incomplete or damaged/);
  });

  it("rejects a link without a key and a bare code", () => {
    expect(() => parsePairingInput("https://tabs.example.com#ABCD2345")).toThrow(/no encryption key/);
    expect(() => parsePairingInput("https://tabs.example.com/#")).toThrow(/no encryption key/);
    expect(() => parsePairingInput("ABCD2345")).toThrow(/not a whole invite link.*#CODE\.KEY/);
    expect(() => parsePairingInput(" abcd-2345 ")).toThrow(/not a whole invite link/);
  });

  it.each([
    ["", /Paste the invite link/],
    ["   ", /Paste the invite link/],
    ["https://tabs.example.com", /not a whole invite link/],
    [`#ABCD2345.${KEY}`, /no server address/],
    [`https://tabs.example.com#ABC.${KEY}`, /incomplete/],
    [`https://tabs.example.com#ABCD_2345.${KEY}`, /incomplete/],
    [`http://tabs.example.com#ABCD2345.${KEY}`, /https/],
    [`https://tabs.example.com/?a=1#ABCD2345.${KEY}`, /query/],
  ])("rejects %j", (input, message) => {
    expect(() => parsePairingInput(input)).toThrow(message);
  });

  it("Start syncing uses the default server unless Advanced names one", () => {
    expect(DEFAULT_SERVER_URL).toBe("https://cts.kexperiments.com");
    expect(startServerUrl("")).toBe(DEFAULT_SERVER_URL);
    expect(startServerUrl("  ")).toBe(DEFAULT_SERVER_URL);
    expect(startServerUrl(" https://tabs.example.com/ ")).toBe("https://tabs.example.com");
    expect(startServerUrl(" tabs.example.com ")).toBe("https://tabs.example.com"); // a bare host, as in invite links
    expect(startServerUrl("tabs.example.com/cts/")).toBe("https://tabs.example.com/cts");
    expect(() => startServerUrl("http://tabs.example.com")).toThrow(/https/);
  });

  it("joins on every submit once the invite field is shown, unless Start syncing was clicked", () => {
    expect(pairSubmitAction(false, null)).toBe("start"); // Enter in the name field
    expect(pairSubmitAction(true, null)).toBe("join"); // Enter in any field with the invite field shown
    expect(pairSubmitAction(true, "start")).toBe("start");
    expect(pairSubmitAction(true, "join")).toBe("join");
  });

  it("builds links and default names", () => {
    expect(pairingLink("https://tabs.example.com", "ABCD2345", "k".repeat(43))).toBe(`https://tabs.example.com#ABCD2345.${"k".repeat(43)}`);
    expect(normalizeCode("ab cd-23 45")).toBe("ABCD2345");
    expect(defaultDeviceName("brave", "mac")).toBe("Brave on macOS");
    expect(defaultDeviceName("safari", "mac")).toBe("Safari on macOS");
    expect(defaultDeviceName("brave", "win")).toBe("Brave on Windows");
    expect(defaultDeviceName("brave", "")).toBe("Brave");
  });
});

describe("Start syncing and joining", () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
  });
  const browser = (kind: "brave" | "safari" = "brave"): Deps => ({ adapter: new FakeBrowser(), api: server.api, browser: kind });

  /** What the popup does for Start syncing: save the form, then the worker finishes it. */
  async function start(deps: Deps, deviceName: string, serverUrl = "https://sync.example") {
    await saveState(deps.adapter.storage, { pendingPair: { serverUrl, deviceName, createdAt: Date.now() } });
    return pairFromPending(deps);
  }

  /** What the popup does for an invite link: parse the field, save the form, then the worker pairs. */
  async function pairWithLink(deps: Deps, link: string, deviceName: string) {
    const target = parsePairingInput(link);
    await saveState(deps.adapter.storage, { pendingPair: { ...target, deviceName, createdAt: Date.now() } });
    return pairFromPending(deps);
  }

  it("starts a session with a fresh key, invites another browser, and suffixes its duplicate name", async () => {
    const mac = browser();
    const s = await start(mac, "Brave on macOS");
    expect(s).toMatchObject({ serverUrl: "https://sync.example", deviceName: "Brave on macOS", deviceId: "dev-1", keyVerified: true });
    expect(s?.pairedAt).toEqual(expect.any(String));
    expect(server.requests.map((r) => r.path)).toEqual(["sessions"]);
    const key = s!.syncKey!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.requests[0]!.body).toEqual({ keyCheck: await keyCheck(key), name: "Brave on macOS", browser: "brave" });
    expect(server.keyCheck).toBe(await keyCheck(key));
    expect(JSON.stringify(server.requests)).not.toContain(key); // the key itself never leaves
    const view = statusView(s!);
    expect(view.encrypted).toBe(true);
    expect(JSON.stringify(view)).not.toContain(key);
    expect(screenOf(view)).toBe("welcome");
    expect(await pairFromPending(mac)).toBeNull(); // the saved form is consumed: no second session

    // The popup creates the first invite at once; that ends the welcome screen.
    const invite = await createPairingCode(mac);
    expect(invite.link).toBe(`https://sync.example#${invite.code}.${key}`);
    expect(server.codes.has(invite.code)).toBe(true);
    expect(screenOf(statusView(await loadState(mac.adapter.storage)))).toBe("main");

    const other = browser();
    const t = await pairWithLink(other, invite.link, "Brave on macOS");
    expect(t).toMatchObject({ deviceName: "Brave on macOS 2", deviceId: "dev-2", syncKey: key, keyVerified: true, invitePending: false });
    expect(t?.statusText).toMatch(/^Paired as "Brave on macOS 2" \(another device is named "Brave on macOS"\)/);
    expect(screenOf(statusView(t!))).toBe("main");
    expect(server.codes.has(invite.code)).toBe(false); // single use
    // Joining compares the key check before anything else.
    expect(server.requests.slice(-2).map((r) => r.path)).toEqual(["pair", "session"]);
  });

  it("maps a closed server, the rate limit and an older server to plain messages", async () => {
    const first = browser();
    await start(first, "Mac");
    const late = browser();
    await expect(start(late, "Brave")).rejects.toMatchObject({ status: 403, code: "sessions_closed" });
    expect(await loadState(late.adapter.storage)).toMatchObject({
      token: null,
      syncKey: null,
      lastError: expect.stringMatching(/^This server does not take new sessions\. Paste an invite link instead/),
    });

    server.rateLimited = 90;
    const at = Date.now();
    await expect(start(late, "Brave")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect((await loadState(late.adapter.storage)).lastError).toBe(`Too many attempts. Try again at ${clock(at + 90_000)}.`);

    const old: Deps = {
      ...browser(),
      api: (cfg) => new ApiClient({ ...cfg, fetch: async () => new Response(JSON.stringify({ error: "not_found", message: "no" }), { status: 404 }) }),
    };
    await expect(startSyncing(old, { serverUrl: "https://old.example", deviceName: "Brave" })).rejects.toMatchObject({ code: "old_server" });
    const s = await loadState(old.adapter.storage);
    expect(s).toMatchObject({ errorKind: "server", lastError: "This server runs an older version.", token: null });
    expect(errorFix(statusView(s))).toBeNull(); // unpaired: the form is the fix
    await expect(pair(old, { serverUrl: "https://old.example", deviceName: "Brave", code: "ABCD2345", key: TEST_KEY })).rejects.toMatchObject({
      code: "old_server",
    });
    expect((await loadState(old.adapter.storage)).lastError).toBe("This server runs an older version.");
  });

  it("maps a full session, a used code and a rate-limited join to plain messages", async () => {
    const mac = browser();
    await start(mac, "Mac");
    const { link } = await createPairingCode(mac);
    server.maxDevices = 1;
    const brave = browser();
    await expect(pairWithLink(brave, link, "Brave")).rejects.toMatchObject({ code: "session_full" });
    expect((await loadState(brave.adapter.storage)).lastError).toMatch(/^Too many browsers are paired/);
    server.maxDevices = 10;
    await expect(pairWithLink(brave, link, "Brave")).rejects.toMatchObject({ code: "invalid_code" });
    expect((await loadState(brave.adapter.storage)).lastError).toMatch(/expired or was already used/);
    server.rateLimited = 30;
    await expect(pairWithLink(brave, (await createPairingCode(mac)).link, "Brave")).rejects.toMatchObject({ code: "rate_limited" });
    expect((await loadState(brave.adapter.storage)).lastError).toMatch(/^Too many attempts\. Try again at \d\d:\d\d\.$/);
    expect(pairingRefusal(new ApiError(429, "rate_limited", "x"), 0)).toBe("Too many attempts. Try again in a few minutes.");
    expect(pairingRefusal(new ApiError(400, "invalid_request", "x"), 0)).toBeNull();
  });

  it("an unreachable server is named in the error; nothing is retried while unpaired", async () => {
    server.unreachable = true;
    for (const run of [
      (d: Deps) => startSyncing(d, { serverUrl: "https://sync.example/", deviceName: "Brave" }),
      (d: Deps) => pair(d, { serverUrl: "https://sync.example", deviceName: "Brave", code: "GOODCODE", key: TEST_KEY }),
    ]) {
      const d = browser();
      await saveState(d.adapter.storage, { serverUrl: "https://stale.example" }); // left by an earlier Disconnect
      await expect(run(d)).rejects.toMatchObject({ code: "network_error" });
      const s = await loadState(d.adapter.storage);
      expect(s).toMatchObject({ serverUrl: "https://sync.example", token: null, errorKind: "unreachable", online: true, nextRetryAt: null, retryAttempts: 0 });
      expect(s.lastError).toMatch(/^Cannot reach https:\/\/sync\.example\./);
      expect(statusView(s).paired).toBe(false);
    }
  });

  it("a second Start syncing or join after pairing keeps the first session", async () => {
    const mac = browser();
    const first = await startSyncing(mac, { serverUrl: "https://sync.example", deviceName: "Mac" });
    const before = server.requests.length;
    // E.g. the popup's message and permissions.onAdded both finishing saved forms.
    expect(await startSyncing(mac, { serverUrl: "https://other.example", deviceName: "Mac" })).toEqual(first);
    expect(await pair(mac, { serverUrl: "https://sync.example", deviceName: "Mac", code: "GOODCODE", key: TEST_KEY })).toEqual(first);
    expect(server.requests.length).toBe(before);
    expect(server.devices.filter((d) => !d.revoked)).toHaveLength(1);
  });

  it("shows a saved or running pairing as finishing", async () => {
    const d = browser();
    const now = Date.now();
    const s = await loadState(d.adapter.storage);
    expect(statusView(s, now).finishing).toBe(false);
    const pendingPair = { serverUrl: "https://sync.example", deviceName: "Brave", createdAt: now };
    expect(statusView({ ...s, pendingPair }, now).finishing).toBe(true);
    expect(statusView({ ...s, pendingPair }, now + 11 * 60_000).finishing).toBe(false); // expired form
    expect(statusView({ ...s, runLock: { action: "pair", startedAt: now } }, now).finishing).toBe(true);
    expect(statusView({ ...s, runLock: { action: "alarm", startedAt: now } }, now).finishing).toBe(false);
    const view = statusView({ ...s, pendingPair }, now);
    expect(heroView(view, { now, offline: false, working: false, devices: null }).detail).toBe("Finishing… this takes a few seconds.");
    const paired = await startSyncing(d, { serverUrl: "https://sync.example", deviceName: "Brave" });
    expect(statusView({ ...paired, pendingPair }, now).finishing).toBe(false);
  });

  it("a session whose credentials cannot be stored is removed again", async () => {
    for (const join of [false, true]) {
      server = new FakeServer();
      const inviter = join ? browser() : null;
      const link = inviter ? (await startSyncing(inviter, { serverUrl: "https://sync.example", deviceName: "Mac" }), (await createPairingCode(inviter)).link) : "";
      const d = browser();
      const storage = d.adapter.storage;
      const set = storage.set.bind(storage);
      storage.set = async (items) => {
        if ("cts.token" in items && items["cts.token"]) throw new Error("storage full");
        return set(items);
      };
      const run = join ? pairWithLink(d, link, "Brave") : startSyncing(d, { serverUrl: "https://sync.example", deviceName: "Brave" });
      await expect(run).rejects.toThrow("storage full");
      const created = server.devices.at(-1)!;
      expect(created).toMatchObject({ name: "Brave", revoked: true });
      expect((await loadState(storage)).token).toBeNull();
    }
  });

  it("refuses a join without a key before contacting the server", async () => {
    const brave = browser();
    await expect(pair(brave, { serverUrl: "https://sync.example", deviceName: "Brave", code: "GOODCODE" })).rejects.toThrow(/no encryption key/);
    await saveState(brave.adapter.storage, { pendingPair: { serverUrl: "https://sync.example", deviceName: "Brave", code: "GOODCODE", createdAt: Date.now() } });
    await expect(pairFromPending(brave)).rejects.toThrow(/no encryption key/);
    expect(server.requests).toEqual([]);
    expect(server.codes.has("GOODCODE")).toBe(true);
  });

  it("renames this device, round trip through the server", async () => {
    const mac = browser("safari");
    const brave = browser();
    await startSyncing(mac, { serverUrl: "https://sync.example", deviceName: "Safari on macOS" });
    server.codes.add("SECOND22");
    const key = (await loadState(mac.adapter.storage)).syncKey!;
    await pair(brave, { serverUrl: "https://sync.example", deviceName: "Brave on Windows", code: "SECOND22", key });
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
    await startSyncing(mac, { serverUrl: "https://sync.example", deviceName: "Mac" });
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
    invitePending: false,
    finishing: false,
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

    expect(errorFix({ paired: true, lastError: "x", errorKind: "permission" })).toBe("grant");
    expect(errorFix({ paired: true, lastError: "x", errorKind: "unreachable" })).toBe("retry");
    expect(errorFix({ paired: true, lastError: "x", errorKind: "server" })).toBe("retry");
    expect(errorFix({ paired: true, lastError: "x", errorKind: "device_revoked" })).toBeNull();
    expect(errorFix({ paired: true, lastError: null, errorKind: "server" })).toBeNull();
    expect(errorFix({ paired: false, lastError: "x", errorKind: "unreachable" })).toBeNull();

    expect(activityLine({ lastActivityAt: null, lastActivityKind: null })).toBe("None yet");
    expect(activityLine({ lastActivityAt: new Date(2026, 9, 13, 10, 22).getTime(), lastActivityKind: "activated" })).toBe("Tab switch, 10:22");
  });

  it("picks the popup screen and the invite caption", () => {
    expect(screenOf({ paired: false, invitePending: false })).toBe("pair");
    expect(screenOf({ paired: false, invitePending: true })).toBe("pair");
    expect(screenOf(base)).toBe("main");
    expect(screenOf({ ...base, invitePending: true })).toBe("welcome");
    expect(view({ paired: false, deviceId: null }).detail).toBe("Start syncing here, or paste an invite link from your other browser.");
    expect(inviteNote(true)).toMatch(/^Install the extension in your other browser and paste this link there\. /);
    expect(inviteNote(false)).toMatch(/do not open it as a page/);
    for (const welcome of [true, false]) expect(inviteNote(welcome)).toMatch(/encryption key.*10 minutes/);
  });

  it("counts seconds for the saved line", () => {
    expect(secondsAgo(new Date(now - 2_000).toISOString(), now)).toBe("just now");
    expect(secondsAgo(new Date(now - 12_000).toISOString(), now)).toBe("12 s ago");
    expect(secondsAgo(new Date(now - 90_000).toISOString(), now)).toBe("1 min ago");
    expect(secondsAgo(new Date(now - 2 * 3600_000).toISOString(), now)).toBe("2 h ago");
  });
});
