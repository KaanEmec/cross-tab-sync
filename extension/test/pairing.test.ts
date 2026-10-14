// Pairing links, device identity (rename, duplicate names) and the device list view model.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBrowser } from "../src/adapter/fake.js";
import type { Device } from "../src/core/client.js";
import { deviceRows, ownerLine, relativeTime, shortId } from "../src/core/devices.js";
import { createPairingCode, pair, pairFromPending, type Deps } from "../src/core/handover.js";
import { statusView } from "../src/core/messages.js";
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

    // Invite another browser: the link carries the server URL and the new code.
    const invite = await createPairingCode(mac);
    expect(invite.link).toBe(`https://sync.example#${invite.code}`);
    expect(server.codes.has(invite.code)).toBe(true);

    const other = browser();
    const t = await pairWithLink(other, invite.link, "Brave on macOS");
    expect(t).toMatchObject({ deviceName: "Brave on macOS 2", deviceId: "dev-2" });
    expect(t?.statusText).toMatch(/^Paired as "Brave on macOS 2" \(another device is named "Brave on macOS"\)/);
    expect(server.codes.has(invite.code)).toBe(false); // single use
  });

  it("falls back to a locally built link when the server does not send one", async () => {
    const mac = browser();
    await pair(mac, { serverUrl: "https://sync.example", deviceName: "Mac", code: "GOODCODE" });
    const api = server.api;
    const noLink: Deps = {
      ...mac,
      api: (cfg) => ({ ...api(cfg), createPairingCode: async () => ({ code: "ABCD2345", expiresAt: "2026-01-01T00:00:00.000Z" }) }),
    };
    expect((await createPairingCode(noLink)).link).toBe("https://sync.example#ABCD2345");
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
        dev({ id: "9c0d1e2f-0000-4000-8000-000000000003", name: "Old Brave", lastSeenAt: ago(3 * 86_400_000), revokedAt: ago(2 * 3600_000) }),
      ],
      now,
    );
    expect(rows).toEqual([
      {
        id: "1a2b3c4d-0000-4000-8000-000000000001",
        title: "Brave on macOS (this device)",
        detail: "Brave · 1a2b3c4d · last seen just now",
        isSelf: true,
        revoked: false,
        canRevoke: false,
      },
      {
        id: "5e6f7a8b-0000-4000-8000-000000000002",
        title: "Safari on macOS",
        detail: "Safari · 5e6f7a8b · last seen 5 min ago",
        isSelf: false,
        revoked: false,
        canRevoke: true,
      },
      {
        id: "9c0d1e2f-0000-4000-8000-000000000003",
        title: "Old Brave",
        detail: "Brave · 9c0d1e2f · revoked 2 h ago",
        isSelf: false,
        revoked: true,
        canRevoke: false,
      },
    ]);
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
  });
});
