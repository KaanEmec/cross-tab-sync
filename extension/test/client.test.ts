import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, normalizeServerUrl, originPattern, type FetchLike, type Operation } from "../src/core/client.js";
import { createCipher, generateKey, type Cipher } from "../src/core/crypto.js";

function mockFetch(status: number, body?: unknown, raw?: string) {
  return vi.fn<FetchLike>(async () =>
    new Response(status === 204 ? null : (raw ?? (body === undefined ? null : JSON.stringify(body))), { status }),
  );
}

const KEY = generateKey();
let cipher: Cipher;
beforeAll(async () => {
  cipher = await createCipher(KEY);
});

const client = (fetch: FetchLike, token: string | null = "cts_abc", withCipher: Cipher | null = cipher) =>
  new ApiClient({ baseUrl: "https://sync.example/", token, fetch, cipher: withCipher ?? undefined });

/** JSON body of the n-th request. */
const sentBody = (f: ReturnType<typeof mockFetch>, n = 0) => JSON.parse(f.mock.calls[n]![1]?.body as string);

describe("ApiClient", () => {
  it("pairs without auth and returns credentials", async () => {
    const f = mockFetch(201, { deviceId: "d1", token: "cts_x" });
    await expect(client(f, null).pair({ code: "ABCD2345", name: "Mac", browser: "safari" })).resolves.toEqual({
      deviceId: "d1",
      token: "cts_x",
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://sync.example/v2/pair");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(JSON.parse(init?.body as string)).toEqual({ code: "ABCD2345", name: "Mac", browser: "safari" });
  });

  it("sends bearer token and JSON bodies", async () => {
    const f = mockFetch(200, { revision: 3, results: [], catchUp: { operations: [] } });
    await client(f).operations({ generation: 2, baseRevision: 1, operations: [] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://sync.example/v2/session/operations");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer cts_abc");
    expect(JSON.parse(init?.body as string)).toEqual({ generation: 2, baseRevision: 1, operations: [] });
  });

  it.each([
    ["session", (c: ApiClient) => c.session(), "GET", "/v2/session"],
    ["changes", (c: ApiClient) => c.changes(7), "GET", "/v2/session/changes?since=7"],
    ["acquire", (c: ApiClient) => c.acquire(true), "POST", "/v2/session/acquire"],
    ["pairingCodes", (c: ApiClient) => c.createPairingCode(), "POST", "/v2/pairing-codes"],
    ["devices", (c: ApiClient) => c.devices(), "GET", "/v2/devices"],
    ["renameDevice", (c: ApiClient) => c.renameDevice("a/b", "Mac"), "PATCH", "/v2/devices/a%2Fb"],
    ["merge", (c: ApiClient) => c.merge([]), "POST", "/v2/session/merge"],
    ["snapshots", (c: ApiClient) => c.snapshots(), "GET", "/v2/snapshots"],
    ["restore", (c: ApiClient) => c.restoreSnapshot(4, 2), "POST", "/v2/snapshots/4/restore"],
  ])("%s hits the right endpoint", async (_name, call, method, path) => {
    const f = mockFetch(200, { devices: [], snapshots: [], revision: 1, results: [], operations: [], entries: [], session: { entries: [] } });
    await call(client(f));
    expect(f.mock.calls[0]![0]).toBe("https://sync.example" + path);
    expect(f.mock.calls[0]![1]?.method).toBe(method);
  });

  it("handles 204 responses", async () => {
    const f = mockFetch(204);
    await expect(client(f).release(4)).resolves.toBeUndefined();
    await expect(client(f).heartbeat(4)).resolves.toBeUndefined();
    await expect(client(f).deleteDevice("a/b")).resolves.toBeUndefined();
    expect(f.mock.calls[2]![0]).toBe("https://sync.example/v2/devices/a%2Fb");
  });

  it("maps error bodies to ApiError with code and owner", async () => {
    const owner = { deviceId: "d2", name: "Brave", generation: 9, lastSeenAt: "t" };
    const f = mockFetch(409, { error: "stale_owner", message: "stale", owner });
    const err = await client(f).heartbeat(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "stale_owner", message: "stale" });
    expect((err as ApiError).owner).toEqual(owner);
  });

  it("maps device_revoked", async () => {
    const err = await client(mockFetch(401, { error: "device_revoked", message: "revoked" })).session().catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: "device_revoked" });
  });

  it("maps non-JSON errors to http_<status>", async () => {
    const err = await client(mockFetch(502, undefined, "<html>bad gateway</html>")).session().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "http_502" });
  });

  it("maps fetch failures to network_error", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await client(f).session().catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: "network_error", message: "Server is unreachable" });
  });

  it("refuses authenticated calls without a token", async () => {
    const f = mockFetch(200, {});
    await expect(client(f, null).session()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("ApiClient encryption", () => {
  const url = "https://example.com/path?q=1#frag";
  const opens = (u: string): Operation => ({ opId: "o1", type: "open", entryId: "e1", url: u, pinned: true, position: 3 });

  it("seals open/navigate URLs in operations and merge; other operations pass through", async () => {
    const f = mockFetch(200, { revision: 3, results: [], catchUp: { operations: [] } });
    const close: Operation = { opId: "o2", type: "close", entryId: "e2" };
    const navigate: Operation = { opId: "o3", type: "navigate", entryId: "e3", url };
    await client(f).operations({ generation: 1, baseRevision: 0, operations: [opens(url), close, navigate] });
    await client(f).merge([{ ...navigate, baseRevision: 7 }]);

    const raw = (f.mock.calls[0]![1]?.body as string) + (f.mock.calls[1]![1]?.body as string);
    expect(raw).not.toContain("example.com");
    const [open, closed, nav] = sentBody(f).operations;
    expect(open).toMatchObject({ opId: "o1", type: "open", entryId: "e1", pinned: true, position: 3 });
    expect(open).not.toHaveProperty("url");
    expect(open.urlKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await cipher.open(open)).toBe(url);
    expect(closed).toEqual(close);
    expect(nav.urlKey).toBe(open.urlKey); // deterministic: the server coalesces on it
    expect(nav.urlEnc).not.toBe(open.urlEnc); // fresh nonce
    const [merged] = sentBody(f, 1).operations;
    expect(merged).toMatchObject({ opId: "o3", type: "navigate", baseRevision: 7, urlKey: open.urlKey });
    expect(await cipher.open(merged)).toBe(url);
  });

  it("opens entries in session and acquire, and operations in changes and catchUp", async () => {
    const a = await cipher.seal("https://a.example/");
    const b = await cipher.seal("https://b.example/");
    const entry = { id: "e1", ...a, pinned: false, position: 0, updatedRevision: 1 };
    const logged = { seq: 2, deviceId: "d2", op: { opId: "o", type: "navigate", entryId: "e1", ...b }, result: { status: "applied" } };
    const session = { revision: 2, owner: null, entries: [entry] };

    const s = await client(mockFetch(200, session)).session();
    expect(s.entries).toEqual([{ id: "e1", url: "https://a.example/", pinned: false, position: 0, updatedRevision: 1 }]);
    const acq = await client(mockFetch(200, { generation: 4, session })).acquire(true);
    expect(acq).toMatchObject({ generation: 4, session: { entries: [{ url: "https://a.example/" }] } });
    expect(acq.session.entries[0]).not.toHaveProperty("urlEnc");
    const ch = await client(mockFetch(200, { revision: 2, owner: null, operations: [logged] })).changes(1);
    expect(ch.operations[0]!.op).toEqual({ opId: "o", type: "navigate", entryId: "e1", url: "https://b.example/" });
    const ops = await client(mockFetch(200, { revision: 2, results: [], catchUp: { operations: [logged] } })).operations({
      generation: 1,
      baseRevision: 1,
      operations: [],
    });
    expect(ops.catchUp?.operations[0]!.op).toMatchObject({ url: "https://b.example/" });
    // A close carries no URL fields and passes through.
    const close = { ...logged, op: { opId: "c", type: "close", entryId: "e1" } };
    expect((await client(mockFetch(200, { revision: 3, owner: null, operations: [close] })).changes(2)).operations[0]!.op).toEqual(close.op);
  });

  it("reads the session revision without decrypting (pairing check)", async () => {
    const f = mockFetch(200, { revision: 5, owner: null, entries: [{ id: "e", urlKey: "x", urlEnc: "y" }] });
    await expect(client(f, "cts_abc", null).sessionRevision()).resolves.toBe(5);
    expect(f.mock.calls[0]![0]).toBe("https://sync.example/v2/session");
  });

  it("reports key_mismatch for data sealed with another key, a tampered ciphertext, or no key", async () => {
    const other = await createCipher(generateKey());
    const foreign = await other.seal("https://secret.example/");
    const session = { revision: 1, owner: null, entries: [{ id: "e1", ...foreign, pinned: false, position: 0, updatedRevision: 1 }] };
    const err = await client(mockFetch(200, session)).session().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 200, code: "key_mismatch" });
    expect(String((err as Error).message)).not.toContain("secret");

    const mine = await cipher.seal("https://a.example/");
    const tampered = { ...mine, urlEnc: mine.urlEnc.slice(0, -2) + (mine.urlEnc.endsWith("AA") ? "BA" : "AA") };
    const logged = { seq: 1, deviceId: "d", op: { opId: "o", type: "open", entryId: "e", ...tampered }, result: { status: "applied" } };
    await expect(client(mockFetch(200, { revision: 1, owner: null, operations: [logged] })).changes(0)).rejects.toMatchObject({
      code: "key_mismatch",
    });

    const f = mockFetch(200, { revision: 1, results: [] });
    await expect(client(f, "cts_abc", null).merge([{ ...opens(url), baseRevision: 0 }])).rejects.toMatchObject({ code: "key_mismatch" });
    expect(f).not.toHaveBeenCalled(); // nothing leaves without a key
    await expect(client(f, "cts_abc", null).merge([{ opId: "c", type: "close", entryId: "e", baseRevision: 0 }])).resolves.toBeTruthy();
  });
});

describe("normalizeServerUrl", () => {
  it("sends each merge operation with its own baseRevision and restore with the generation", async () => {
    const f = mockFetch(200, { revision: 2, results: [] });
    const op = { opId: "o", type: "close" as const, entryId: "e", baseRevision: 5 };
    await client(f).merge([op]);
    expect(JSON.parse(f.mock.calls[0]![1]?.body as string)).toEqual({ operations: [op] });
    await client(f).restoreSnapshot(9, 3);
    expect(JSON.parse(f.mock.calls[1]![1]?.body as string)).toEqual({ generation: 3 });
  });

  it("derives the host permission pattern from the server URL", () => {
    expect(originPattern("https://sync.example:8443/cts")).toBe("https://sync.example/*");
    expect(originPattern("nope")).toBeNull();
  });

  it.each([
    ["https://sync.example/", "https://sync.example"],
    ["  https://sync.example/cts/ ", "https://sync.example/cts"],
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
  ])("%s -> %s", (input, out) => expect(normalizeServerUrl(input)).toBe(out));

  it.each(["http://sync.example", "http://[::1]:8080", "ftp://x", "not a url", "https://x/?a=1"])("rejects %s", (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });
});
