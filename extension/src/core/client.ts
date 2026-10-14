// Typed client for the endpoints in docs/PROTOCOL.md (v2). No logging: requests carry tokens.
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

/** `POST /v2/pairing-codes`. `link` is the server URL with the code as fragment (absent on older servers). */
export interface PairingCode {
  code: string;
  expiresAt: string;
  link?: string;
}

/**
 * Error codes from PROTOCOL.md plus client-only ones: `network_error` (no HTTP response),
 * `http_<status>`, and `key_mismatch` (a URL could not be decrypted: another key, or no key).
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
  | "internal"
  | "network_error"
  | "key_mismatch"
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

  /** `name` in the response is the stored name, suffixed when another device uses it (absent on older servers). */
  pair(body: { code: string; name: string; browser: BrowserKind }): Promise<{ deviceId: string; token: string; name?: string }> {
    return this.request("POST", "/v2/pair", body, false);
  }

  createPairingCode(): Promise<PairingCode> {
    return this.request("POST", "/v2/pairing-codes");
  }

  /** Rename this device (self only); the response carries the stored, possibly suffixed, name. */
  renameDevice(id: string, name: string): Promise<Device> {
    return this.request("PATCH", `/v2/devices/${encodeURIComponent(id)}`, { name });
  }

  async devices(): Promise<Device[]> {
    const res = await this.request<{ devices: Device[] }>("GET", "/v2/devices");
    return res.devices;
  }

  async deleteDevice(id: string): Promise<void> {
    await this.request("DELETE", `/v2/devices/${encodeURIComponent(id)}`);
  }

  async session(): Promise<Session> {
    return this.openSession(await this.request<WireSession>("GET", "/v2/session"));
  }

  /** The session revision only, without decrypting entries (pairing checks whether the session is empty). */
  async sessionRevision(): Promise<number> {
    return (await this.request<{ revision: number }>("GET", "/v2/session")).revision;
  }

  async changes(since: number): Promise<ChangesResponse> {
    const res = await this.request<Omit<ChangesResponse, "operations"> & { operations: WireLoggedOperation[] }>("GET", `/v2/session/changes?since=${encodeURIComponent(String(since))}`);
    return { ...res, operations: await this.openLogged(res.operations) };
  }

  async acquire(force: boolean): Promise<{ generation: number; session: Session }> {
    const res = await this.request<{ generation: number; session: WireSession }>("POST", "/v2/session/acquire", { force });
    return { ...res, session: await this.openSession(res.session) };
  }

  async release(generation: number): Promise<void> {
    await this.request("POST", "/v2/session/release", { generation });
  }

  async heartbeat(generation: number): Promise<void> {
    await this.request("POST", "/v2/session/heartbeat", { generation });
  }

  async operations(body: { generation: number; baseRevision: number; operations: Operation[] }): Promise<OperationsResponse> {
    const sealed = { ...body, operations: await this.sealAll(body.operations) };
    type Wire = Omit<OperationsResponse, "catchUp"> & { catchUp?: { operations: WireLoggedOperation[] } };
    const { catchUp, ...res } = await this.request<Wire>("POST", "/v2/session/operations", sealed);
    return catchUp ? { ...res, catchUp: { operations: await this.openLogged(catchUp.operations) } } : res;
  }

  async merge(operations: MergeOperation[]): Promise<BatchResponse> {
    return this.request("POST", "/v2/session/merge", { operations: await this.sealAll(operations) });
  }

  /** Diagnostics trace lines (core/diag.ts); the server accepts them only with CTS_DEBUG (else 404). */
  async postDiag(lines: string[]): Promise<void> {
    await this.request("POST", "/v2/diag", { lines });
  }

  async snapshots(): Promise<Snapshot[]> {
    const res = await this.request<{ snapshots: Snapshot[] }>("GET", "/v2/snapshots");
    return res.snapshots;
  }

  restoreSnapshot(id: number, generation: number): Promise<BatchResponse> {
    return this.request("POST", `/v2/snapshots/${encodeURIComponent(String(id))}/restore`, { generation });
  }

  private requireCipher(): Cipher {
    if (!this.cipher) throw new ApiError(0, "key_mismatch", "This device has no encryption key");
    return this.cipher;
  }

  /** Seal the URL of every `open`/`navigate`; other fields (e.g. `baseRevision`) pass through. */
  private sealAll<T extends Operation>(ops: T[]): Promise<Sealed<T>[]> {
    return Promise.all(
      ops.map(async (op) => {
        if (!("url" in op)) return op as Sealed<T>;
        const { url, ...rest } = op;
        return { ...rest, ...(await this.sealUrl(url)) } as Sealed<T>;
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

  private openOp(op: WireOperation): Promise<Operation> {
    if (!("urlKey" in op)) return Promise.resolve(op);
    const { urlKey, urlEnc, ...rest } = op;
    return this.openUrl({ urlKey, urlEnc }).then((url) => ({ ...rest, url }) as Operation);
  }

  private openLogged(items: WireLoggedOperation[]): Promise<LoggedOperation[]> {
    return Promise.all(items.map(async (l) => ({ ...l, op: await this.openOp(l.op) })));
  }

  private async openSession(s: WireSession): Promise<Session> {
    const entries = await Promise.all(
      s.entries.map(async ({ urlKey, urlEnc, ...rest }) => ({ ...rest, url: await this.openUrl({ urlKey, urlEnc }) })),
    );
    return { ...s, entries };
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
