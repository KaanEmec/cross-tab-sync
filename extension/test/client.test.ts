import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, normalizeServerUrl, type FetchLike } from "../src/core/client.js";

function mockFetch(status: number, body?: unknown, raw?: string) {
  return vi.fn<FetchLike>(async () =>
    new Response(status === 204 ? null : (raw ?? (body === undefined ? null : JSON.stringify(body))), { status }),
  );
}

const client = (fetch: FetchLike, token: string | null = "cts_abc") => new ApiClient({ baseUrl: "https://sync.example/", token, fetch });

describe("ApiClient", () => {
  it("pairs without auth and returns credentials", async () => {
    const f = mockFetch(201, { deviceId: "d1", token: "cts_x" });
    await expect(client(f, null).pair({ code: "ABCD2345", name: "Mac", browser: "safari" })).resolves.toEqual({
      deviceId: "d1",
      token: "cts_x",
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://sync.example/v1/pair");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(JSON.parse(init?.body as string)).toEqual({ code: "ABCD2345", name: "Mac", browser: "safari" });
  });

  it("sends bearer token and JSON bodies", async () => {
    const f = mockFetch(200, { revision: 3, results: [], catchUp: { operations: [] } });
    await client(f).operations({ generation: 2, baseRevision: 1, operations: [] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://sync.example/v1/session/operations");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer cts_abc");
    expect(JSON.parse(init?.body as string)).toEqual({ generation: 2, baseRevision: 1, operations: [] });
  });

  it.each([
    ["session", (c: ApiClient) => c.session(), "GET", "/v1/session"],
    ["changes", (c: ApiClient) => c.changes(7), "GET", "/v1/session/changes?since=7"],
    ["acquire", (c: ApiClient) => c.acquire(true), "POST", "/v1/session/acquire"],
    ["pairingCodes", (c: ApiClient) => c.createPairingCode(), "POST", "/v1/pairing-codes"],
    ["devices", (c: ApiClient) => c.devices(), "GET", "/v1/devices"],
  ])("%s hits the right endpoint", async (_name, call, method, path) => {
    const f = mockFetch(200, { devices: [] });
    await call(client(f));
    expect(f.mock.calls[0]![0]).toBe("https://sync.example" + path);
    expect(f.mock.calls[0]![1]?.method).toBe(method);
  });

  it("handles 204 responses", async () => {
    const f = mockFetch(204);
    await expect(client(f).release(4)).resolves.toBeUndefined();
    await expect(client(f).heartbeat(4)).resolves.toBeUndefined();
    await expect(client(f).deleteDevice("a/b")).resolves.toBeUndefined();
    expect(f.mock.calls[2]![0]).toBe("https://sync.example/v1/devices/a%2Fb");
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

describe("normalizeServerUrl", () => {
  it.each([
    ["https://sync.example/", "https://sync.example"],
    ["  https://sync.example/cts/ ", "https://sync.example/cts"],
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
  ])("%s -> %s", (input, out) => expect(normalizeServerUrl(input)).toBe(out));

  it.each(["http://sync.example", "ftp://x", "not a url", "https://x/?a=1"])("rejects %s", (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });
});
