// Typed client for the endpoints in docs/PROTOCOL.md (v3). No logging: requests carry tokens.
// URLs are end-to-end encrypted here, at the HTTP boundary: callers and the rest of the core see
// plaintext `url` fields, the wire carries only `urlKey`/`urlEnc` (core/crypto.ts).

import { KeyMismatchError, type Cipher, type UrlFields } from "./crypto.js";

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
  /** base64url(HMAC(K_mac, "cts-key-check")), sent by the browser that started the session. */
  keyCheck?: string | null;
  /** Oldest retained operation sequence number (v1.0). */
  minRevision?: number;
  owner: Owner | null;
  entries: Entry[];
}

export type Operation =
  | { opId: string; type: "open"; entryId: string; url: string; pinned?: boolean; position?: number }
  | { opId: string; type: "navigate"; entryId: string; url: string }
  | { opId: string; type: "close"; entryId: string }
  | { opId: string; type: "update"; entryId: string; pinned?: boolean; position?: number };

/** Operations and entries as they travel: the URL sealed into `urlKey`/`urlEnc`. */
type Sealed<T> = T extends { url: string } ? Omit<T, "url"> & UrlFields : T;
export type WireOperation = Sealed<Operation>;
export type WireEntry = Sealed<Entry>;

export type WireLoggedOperation = Omit<LoggedOperation, "op"> & { op: WireOperation };
type WireSession = Omit<Session, "entries"> & { entries: WireEntry[] };

/** `forked` only in `merge` results: a navigate on a moved entry opened a fresh entry (`entryId`). */
export type OpStatus = "applied" | "coalesced" | "ignored" | "forked";

/** A journaled operation as sent to `merge`: with the revision the device had applied when recording it. */
export type MergeOperation = Operation & { baseRevision: number };

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
  /** Absent when `fullResync` is set. */
  catchUp?: { operations: LoggedOperation[] };
  /** `baseRevision` is older than the retained history: reload `GET session`. */
  fullResync?: boolean;
}

/** `merge` and snapshot `restore`. */
export interface BatchResponse {
  revision: number;
  results: OpResult[];
}

export interface ChangesResponse {
  revision: number;
  minRevision?: number;
  owner: Owner | null;
  operations: LoggedOperation[];
}

export interface Snapshot {
  id: number;
  /** Revision just before the change that triggered the snapshot. */
  revision: number;
  deviceId: string;
  reason: "operations" | "restore" | (string & {});
  createdAt: string;
  entryCount: number;
}

export interface Device {
  id: string;
  name: string;
  browser: string;
  createdAt: string;
  lastSeenAt: string;
  isSelf: boolean;
  /** Set for devices revoked within the last 7 days (still listed, greyed out). */
  revokedAt?: string;
}

/** `POST /v3/pairing-codes`. */
export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** `POST /v3/sessions` and `POST /v3/pair`: the new device. `name` is the stored, possibly suffixed, name. */
export interface Paired {
  deviceId: string;
  token: string;
  name?: string;
}

/**
 * Error codes from PROTOCOL.md plus client-only ones: `network_error` (no HTTP response),
 * `http_<status>`, `old_server` (a `404` from a route every v3 server has), `key_mismatch` (a URL
 * could not be decrypted: another key, or no key) and `bad_wire` (a received operation or entry is
 * not in sealed form). The last two mean "key" to the user.
 */
export type ErrorCode =
  | "invalid_request"
  | "invalid_code"
  | "unauthorized"
  | "forbidden"
  | "device_revoked"
  | "not_found"
  | "owner_active"
  | "stale_owner"
  | "history_expired"
  | "payload_too_large"
  | "sessions_closed"
  | "session_full"
  | "rate_limited"
  | "internal"
  | "network_error"
  | "old_server"
  | "key_mismatch"
  | "bad_wire"
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

  /** Seconds from the `Retry-After` header of `429 rate_limited`, when given. */
  get retryAfter(): number | null {
    const v = this.body["retryAfter"];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  }
}

/** A `404` from a route every v3 server has. */
export const OLD_SERVER_MESSAGE = "This server runs an older version.";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Seals and opens URLs. Absent before pairing: only calls that carry no URLs work then. */
  cipher?: Cipher;
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

/** Host permission pattern for a server URL (`https://host/*`), as requested at pairing. Null if invalid. */
export function originPattern(serverUrl: string): string | null {
  try {
    const u = new URL(serverUrl.trim());
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Throws `bad_wire` unless `item` has no `url` and, when `sealed`, string `urlKey` and `urlEnc`. */
function checkWire(item: object, sealed: boolean): void {
  const fields = item as Record<string, unknown>;
  const ok = !("url" in fields) && (!sealed || (typeof fields["urlKey"] === "string" && typeof fields["urlEnc"] === "string"));
  if (!ok) throw new ApiError(200, "bad_wire", "The server sent a tab that is not encrypted with this browser's key");
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly cipher: Cipher | null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.cipher = opts.cipher ?? null;
  }

  /** Start a new session with this browser as its first device (Start syncing). */
  createSession(body: { keyCheck: string; name: string; browser: BrowserKind }): Promise<Paired> {
    return this.request("POST", "/v3/sessions", body, false);
  }

  /** Join the session of an invite code. */
  pair(body: { code: string; name: string; browser: BrowserKind }): Promise<Paired> {
    return this.request("POST", "/v3/pair", body, false);
  }

  createPairingCode(): Promise<PairingCode> {
    return this.request("POST", "/v3/pairing-codes");
  }

  /** Rename this device (self only); the response carries the stored, possibly suffixed, name. */
  renameDevice(id: string, name: string): Promise<Device> {
    return this.request("PATCH", `/v3/devices/${encodeURIComponent(id)}`, { name });
  }

  async devices(): Promise<Device[]> {
    const res = await this.request<{ devices: Device[] }>("GET", "/v3/devices");
    return res.devices;
  }

  async deleteDevice(id: string): Promise<void> {
    await this.request("DELETE", `/v3/devices/${encodeURIComponent(id)}`, undefined, true, true);
  }

  async session(): Promise<Session> {
    return this.openSession(await this.request<WireSession>("GET", "/v3/session"));
  }

  /** The session's key check only, without decrypting entries (joining checks it first). */
  async sessionKeyCheck(): Promise<string | null> {
    return (await this.request<{ keyCheck?: string | null }>("GET", "/v3/session")).keyCheck ?? null;
  }

  async changes(since: number): Promise<ChangesResponse> {
    const res = await this.request<Omit<ChangesResponse, "operations"> & { operations: WireLoggedOperation[] }>("GET", `/v3/session/changes?since=${encodeURIComponent(String(since))}`);
    return { ...res, operations: await this.openLogged(res.operations) };
  }

  /** A session this device cannot open gives the ownership straight back (best effort). */
  async acquire(force: boolean): Promise<{ generation: number; session: Session }> {
    const res = await this.request<{ generation: number; session: WireSession }>("POST", "/v3/session/acquire", { force });
    try {
      return { ...res, session: await this.openSession(res.session) };
    } catch (e) {
      await this.release(res.generation).catch(() => undefined);
      throw e;
    }
  }

  async release(generation: number): Promise<void> {
    await this.request("POST", "/v3/session/release", { generation });
  }

  async heartbeat(generation: number): Promise<void> {
    await this.request("POST", "/v3/session/heartbeat", { generation });
  }

  async operations(body: { generation: number; baseRevision: number; operations: Operation[] }): Promise<OperationsResponse> {
    const sealed = { ...body, operations: await this.sealAll(body.operations) };
    type Wire = Omit<OperationsResponse, "catchUp"> & { catchUp?: { operations: WireLoggedOperation[] } };
    const { catchUp, ...res } = await this.request<Wire>("POST", "/v3/session/operations", sealed);
    return catchUp ? { ...res, catchUp: { operations: await this.openLogged(catchUp.operations) } } : res;
  }

  async merge(operations: MergeOperation[]): Promise<BatchResponse> {
    return this.request("POST", "/v3/session/merge", { operations: await this.sealAll(operations) });
  }

  /** Diagnostics trace lines (core/diag.ts); the server accepts them only with CTS_DEBUG (else 404). */
  async postDiag(lines: string[]): Promise<void> {
    await this.request("POST", "/v3/diag", { lines }, true, true);
  }

  async snapshots(): Promise<Snapshot[]> {
    const res = await this.request<{ snapshots: Snapshot[] }>("GET", "/v3/snapshots");
    return res.snapshots;
  }

  restoreSnapshot(id: number, generation: number): Promise<BatchResponse> {
    return this.request("POST", `/v3/snapshots/${encodeURIComponent(String(id))}/restore`, { generation }, true, true);
  }

  private requireCipher(): Cipher {
    if (!this.cipher) throw new ApiError(0, "key_mismatch", "This device has no encryption key");
    return this.cipher;
  }

  /**
   * Seal the URL of every `open`/`navigate`; other fields (e.g. `baseRevision`) pass through. A
   * `url` field never leaves, whatever the operation type.
   */
  private sealAll<T extends Operation>(ops: T[]): Promise<Sealed<T>[]> {
    return Promise.all(
      ops.map(async (op) => {
        const { url, ...rest } = op as T & { url?: string };
        if (op.type !== "open" && op.type !== "navigate") return rest as Sealed<T>;
        return { ...rest, ...(await this.sealUrl(url ?? "")) } as Sealed<T>;
      }),
    );
  }

  /** Sealing fails only for a missing or malformed key: nothing is sent. */
  private async sealUrl(url: string): Promise<UrlFields> {
    try {
      return await this.requireCipher().seal(url);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(0, "key_mismatch", "The encryption key is not valid");
    }
  }

  /** A decryption failure is `key_mismatch` (status 200: the server answered); nothing is applied. */
  private async openUrl(fields: UrlFields): Promise<string> {
    try {
      return await this.requireCipher().open(fields);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const why = e instanceof KeyMismatchError ? e.message : "The encryption key is not valid";
      throw new ApiError(200, "key_mismatch", why);
    }
  }

  /**
   * Received operations, decided by type: `open`/`navigate` must carry exactly the sealed fields
   * (a plaintext `url` would be a forgery: the server cannot make one we could verify), nothing
   * carries `url`. The whole response is refused before anything is decrypted or applied.
   */
  private openLogged(items: WireLoggedOperation[]): Promise<LoggedOperation[]> {
    for (const { op } of items) checkWire(op, op.type === "open" || op.type === "navigate");
    return Promise.all(
      items.map(async (l) => {
        if (!("urlKey" in l.op)) return l as LoggedOperation;
        const { urlKey, urlEnc, ...rest } = l.op;
        return { ...l, op: { ...rest, url: await this.openUrl({ urlKey, urlEnc }) } as Operation };
      }),
    );
  }

  private async openSession(s: WireSession): Promise<Session> {
    for (const e of s.entries) checkWire(e, true);
    const entries = await Promise.all(
      s.entries.map(async ({ urlKey, urlEnc, ...rest }) => ({ ...rest, url: await this.openUrl({ urlKey, urlEnc }) })),
    );
    return { ...s, entries };
  }

  /**
   * `mayNotFind`: the route answers `404 not_found` for an unknown id (or a disabled feature).
   * Elsewhere a `404` means the server predates v3 (`old_server`).
   */
  private async request<T>(method: string, path: string, body?: unknown, auth = true, mayNotFind = false): Promise<T> {
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
      if (res.status === 404 && !mayNotFind) throw new ApiError(404, "old_server", OLD_SERVER_MESSAGE, obj);
      const retryAfter = res.status === 429 ? Number(res.headers.get("Retry-After") ?? NaN) : NaN;
      throw new ApiError(res.status, code, message, Number.isFinite(retryAfter) ? { ...obj, retryAfter } : obj);
    }
    if (data === undefined) throw new ApiError(res.status, "invalid_response", "Server returned an invalid response");
    return data as T;
  }
}
