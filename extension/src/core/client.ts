// Typed client for the endpoints in docs/PROTOCOL.md. No logging: requests carry URLs and tokens.

export type BrowserKind = "safari" | "brave";

export interface Owner {
  deviceId: string;
  name: string;
  generation: number;
  lastSeenAt: string;
}

export interface Entry {
  id: string;
  url: string;
  pinned: boolean;
  position: number;
  updatedRevision: number;
}

export interface Session {
  revision: number;
  owner: Owner | null;
  entries: Entry[];
}

export type Operation =
  | { opId: string; type: "open"; entryId: string; url: string; pinned?: boolean; position?: number }
  | { opId: string; type: "navigate"; entryId: string; url: string }
  | { opId: string; type: "close"; entryId: string }
  | { opId: string; type: "update"; entryId: string; pinned?: boolean; position?: number };

export type OpStatus = "applied" | "coalesced" | "ignored";

export interface OpResult {
  opId: string;
  status: OpStatus;
  entryId?: string;
  replayed?: boolean;
}

/** Item of `catchUp.operations` and `changes.operations`; `op` is exactly what the sender sent. */
export interface LoggedOperation {
  seq: number;
  deviceId: string;
  op: Operation;
  result: { status: OpStatus; entryId?: string };
}

export interface OperationsResponse {
  revision: number;
  results: OpResult[];
  catchUp: { operations: LoggedOperation[] };
}

export interface ChangesResponse {
  revision: number;
  owner: Owner | null;
  operations: LoggedOperation[];
}

export interface Device {
  id: string;
  name: string;
  browser: string;
  createdAt: string;
  lastSeenAt: string;
  isSelf: boolean;
}

/** Error codes from PROTOCOL.md plus `network_error` (no HTTP response) and `http_<status>`. */
export type ErrorCode =
  | "invalid_request"
  | "invalid_code"
  | "unauthorized"
  | "device_revoked"
  | "not_found"
  | "owner_active"
  | "stale_owner"
  | "history_expired"
  | "payload_too_large"
  | "internal"
  | "network_error"
  | (string & {});

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Owner carried by `409 owner_active` / `409 stale_owner`. */
  get owner(): Owner | null {
    const o = this.body["owner"];
    return o && typeof o === "object" ? (o as Owner) : null;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Normalize a user-entered server address to an origin-like base URL without a trailing slash.
 * HTTPS is required except for loopback hosts (local development with CTS_ALLOW_INSECURE=1).
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Server URL is not a valid URL");
  }
  // Only loopback hosts listed in optional_host_permissions may use plain http.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Server URL must use https:// (http:// only for localhost)");
  }
  if (url.search || url.hash) throw new Error("Server URL must not contain a query or fragment");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  pair(body: { code: string; name: string; browser: BrowserKind }): Promise<{ deviceId: string; token: string }> {
    return this.request("POST", "/v1/pair", body, false);
  }

  createPairingCode(): Promise<{ code: string; expiresAt: string }> {
    return this.request("POST", "/v1/pairing-codes");
  }

  async devices(): Promise<Device[]> {
    const res = await this.request<{ devices: Device[] }>("GET", "/v1/devices");
    return res.devices;
  }

  async deleteDevice(id: string): Promise<void> {
    await this.request("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
  }

  session(): Promise<Session> {
    return this.request("GET", "/v1/session");
  }

  changes(since: number): Promise<ChangesResponse> {
    return this.request("GET", `/v1/session/changes?since=${encodeURIComponent(String(since))}`);
  }

  acquire(force: boolean): Promise<{ generation: number; session: Session }> {
    return this.request("POST", "/v1/session/acquire", { force });
  }

  async release(generation: number): Promise<void> {
    await this.request("POST", "/v1/session/release", { generation });
  }

  async heartbeat(generation: number): Promise<void> {
    await this.request("POST", "/v1/session/heartbeat", { generation });
  }

  operations(body: { generation: number; baseRevision: number; operations: Operation[] }): Promise<OperationsResponse> {
    return this.request("POST", "/v1/session/operations", body);
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError(0, "unauthorized", "This device is not paired");
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
        credentials: "omit",
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ApiError(0, "network_error", timedOut ? "Server did not respond in time" : "Server is unreachable");
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => "");
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const code = typeof obj["error"] === "string" ? obj["error"] : `http_${res.status}`;
      const message = typeof obj["message"] === "string" ? obj["message"] : `Request failed with status ${res.status}`;
      throw new ApiError(res.status, code, message, obj);
    }
    if (data === undefined) throw new ApiError(res.status, "invalid_response", "Server returned an invalid response");
    return data as T;
  }
}
