// In-memory implementation of the PROTOCOL.md (v2) server semantics behind a `fetch` handler, so
// the real ApiClient (sealing and opening URLs) runs in every test. Like the real server it stores
// `urlKey`/`urlEnc` verbatim and coalesces on `urlKey`. Plaintext views for assertions come from a
// test-only oracle (`urlKey` -> URL, recorded by the test cipher), never from decryption.
import {
  ApiClient,
  ApiError,
  type Entry,
  type FetchLike,
  type LoggedOperation,
  type OpResult,
  type Operation,
  type Owner,
  type Session,
  type Snapshot,
  type WireEntry,
  type WireLoggedOperation,
  type WireOperation,
} from "../../src/core/client.js";
import { cipherFor, type Cipher } from "../../src/core/crypto.js";
import type { Api } from "../../src/core/handover.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const URL_ENC = /^[A-Za-z0-9_-]{1,4096}$/;
const MAX_BODY = 256 * 1024;
const encoder = new TextEncoder();

/** Root key shared by test devices (as if every device paired from an invite link). */
export const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

/** urlKey -> URL for every URL a test cipher sealed or opened. */
const oracle = new Map<string, string>();
const testCiphers = new Map<string, Cipher>();

/** A cipher for `key` that also records plaintexts for test assertions. */
export function testCipher(key = TEST_KEY): Cipher {
  let c = testCiphers.get(key);
  if (!c) {
    const inner = cipherFor(key);
    c = {
      seal: async (url) => {
        const f = await inner.seal(url);
        oracle.set(f.urlKey, url);
        return f;
      },
      open: async (f) => {
        const url = await inner.open(f);
        oracle.set(f.urlKey, url);
        return url;
      },
    };
    testCiphers.set(key, c);
  }
  return c;
}

/** The plaintext URL behind a `urlKey` (test oracle). */
export function plainUrl(urlKey: string): string {
  return oracle.get(urlKey) ?? `<sealed ${urlKey.slice(0, 8)}>`;
}

/** An operation with its URL fields replaced by the plaintext URL (assertions only). */
export function plainOp<T extends WireOperation>(op: T): Operation {
  if (!("urlKey" in op)) return op as Operation;
  const { urlKey, urlEnc: _e, ...rest } = op;
  return { ...rest, url: plainUrl(urlKey) } as Operation;
}

/** UUIDv5 (SHA-1) of `name` in the namespace `ns`, as the server derives forked entry ids. */
export async function uuidv5(ns: string, name: string): Promise<string> {
  const nsBytes = Uint8Array.from(ns.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
  const nameBytes = encoder.encode(name);
  const data = new Uint8Array(nsBytes.length + nameBytes.length);
  data.set(nsBytes);
  data.set(nameBytes, nsBytes.length);
  const b = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const bad = (msg: string) => new ApiError(400, "invalid_request", msg);

/** Shape checks as the server does them: ids, `urlKey`/`urlEnc` length and alphabet, never decoded. */
function validateBatch(body: { baseRevision: number; operations: WireOperation[] }, bytes: number): void {
  const tooLarge = (msg: string) => new ApiError(413, "payload_too_large", msg);
  if (bytes > MAX_BODY) throw tooLarge("body too large");
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) throw bad("baseRevision required");
  if (!Array.isArray(body.operations)) throw bad("operations required");
  if (body.operations.length > 500) throw tooLarge("at most 500 operations per batch");
  for (const op of body.operations) {
    if (!UUID.test(op.opId) || !UUID.test(op.entryId)) throw bad("ids must be lowercase UUIDs");
    if ("url" in op) throw bad("unknown field url");
    if (op.type === "open" || op.type === "navigate") {
      if (!URL_KEY.test(op.urlKey) || !URL_ENC.test(op.urlEnc)) throw bad("invalid urlKey or urlEnc");
    }
  }
}

interface Device {
  id: string;
  name: string;
  browser: string;
  token: string;
  createdAt: string;
  revoked: boolean;
  revokedAt: string | null;
}

/** Revoked devices stay in the device list this long. */
const REVOKED_LISTED_MS = 7 * 24 * 3600_000;

type ServerEntry = WireEntry & { open: boolean; urlRevision: number; urlDevice: string };
type WireMergeOperation = WireOperation & { baseRevision: number };
type WireSnapshot = Snapshot & { entries: WireEntry[] };

/** Network failure: the fetch handler rejects like a browser `fetch` does. */
class Unreachable extends Error {}

/** A recorded request: short route name, body with plaintext ops (test oracle), raw size. */
export interface RecordedRequest {
  path: string;
  body?: unknown;
  device?: string;
  /** UTF-8 bytes of the request body as sent. */
  bytes?: number;
}

export class FakeServer {
  revision = 0;
  generation = 0;
  owner: Owner | null = null;
  entries: ServerEntry[] = [];
  log: WireLoggedOperation[] = [];
  results = new Map<string, OpResult>();
  devices: Device[] = [];
  codes = new Set<string>(["GOODCODE"]);
  unreachable = false;
  /** Apply the next operations or merge batch but fail as if the response was lost. */
  dropNextOperationsResponse = false;
  requests: RecordedRequest[] = [];
  /** `changes?since=` below this revision answers `410 history_expired`. */
  historyStart = 0;
  /** Test hook to delay an operations request between authentication and the ownership check. */
  beforeOperations?: () => Promise<void>;
  /** Answer the next N authenticated requests with this HTTP status and error code (default `internal`). */
  failNext: { status: number; count: number; code?: string } | null = null;
  snapshots: WireSnapshot[] = [];
  /** Restore ids per (snapshot, generation, index): a retry in the same generation replays. */
  private restoreIds = new Map<string, { opId: string; entryId: string }>();

  /** Oldest retained sequence number: `changes?since=` below `minRevision - 1` is 410. */
  get minRevision(): number {
    return this.historyStart + 1;
  }

  /** Base outside the retained history (`base < minRevision - 1`), as the server checks it. */
  private expired(base: number): boolean {
    return base < this.historyStart;
  }

  private snapshot(deviceId: string, reason: string): void {
    const entries = this.wireSession().entries;
    if (entries.length === 0) return;
    const id = (this.snapshots[0]?.id ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.snapshots.unshift({ id, revision: this.revision, deviceId, reason, createdAt, entryCount: entries.length, entries });
  }

  private snapshotIfNeeded(deviceId: string, ops: WireOperation[]): void {
    if (ops.some((op) => !this.results.has(op.opId) && (op.type === "close" || op.type === "navigate"))) {
      this.snapshot(deviceId, "operations");
    }
  }

  /** Clock for createdAt / revokedAt and the 7-day revoked window. */
  now = () => Date.now();

  /** The server's duplicate rule: lowest free " N" suffix among other active devices, ignoring case. */
  private uniqueName(name: string, exceptId: string): string {
    const taken = new Set(this.devices.filter((d) => !d.revoked && d.id !== exceptId).map((d) => d.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = [...name].slice(0, 64 - suffix.length).join("").trimEnd() + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  addDevice(name: string, browser = "brave"): Device {
    const n = this.devices.length + 1;
    const id = `dev-${n}`;
    const createdAt = new Date(this.now()).toISOString();
    const d = { id, name: this.uniqueName(name, id), browser, token: `cts_token${n}`, createdAt, revoked: false, revokedAt: null };
    this.devices.push(d);
    return d;
  }

  private deviceJson(x: Device, self: string) {
    const lastSeenAt = new Date(this.now()).toISOString();
    const out = { id: x.id, name: x.name, browser: x.browser, createdAt: x.createdAt, lastSeenAt, isSelf: x.id === self };
    return x.revokedAt ? { ...out, revokedAt: x.revokedAt } : out;
  }

  /** The session as the server sends it. */
  wireSession() {
    return {
      revision: this.revision,
      minRevision: this.minRevision,
      owner: this.owner ? { ...this.owner } : null,
      entries: this.entries
        .filter((e) => e.open)
        .map(({ open: _open, urlRevision: _r, urlDevice: _d, ...e }): WireEntry => ({ ...e }))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    };
  }

  /** The session with plaintext URLs (test oracle), for assertions. */
  session(): Session {
    const s = this.wireSession();
    return { ...s, entries: s.entries.map(({ urlKey, urlEnc: _e, ...e }): Entry => ({ ...e, url: plainUrl(urlKey) })) };
  }

  openUrls(): string[] {
    return this.session().entries.map((e) => e.url);
  }

  /** The log with plaintext URLs, for assertions. */
  plainLog(): LoggedOperation[] {
    return this.log.map((l) => ({ ...l, op: plainOp(l.op) }));
  }

  /**
   * Apply plaintext ops as `deviceId` without ownership checks (simulates history written by
   * another device). URLs are sealed with `key` (default: the shared test key).
   */
  async inject(deviceId: string, ops: Operation[], key = TEST_KEY): Promise<OpResult[]> {
    const cipher = testCipher(key);
    const wire = await Promise.all(
      ops.map(async (op): Promise<WireOperation> => {
        if (!("url" in op)) return op;
        const { url, ...rest } = op;
        return { ...rest, ...(await cipher.seal(url)) } as WireOperation;
      }),
    );
    return wire.map((op) => this.apply(deviceId, op));
  }

  /**
   * Merge rules: an entry moved (URL changed by another device after `baseRevision`, or the base is
   * expired or ahead of the session) forks a navigate into an open of a fresh entry (UUIDv5 of the
   * opId and "forked") and ignores close/update. Entries whose URL this batch itself set are never
   * moved. Later ops of the batch on a forked entry are redirected to the fork.
   */
  private async merge(deviceId: string, ops: WireMergeOperation[]): Promise<OpResult[]> {
    const forks = new Map<string, string>();
    const own = new Set<string>();
    const out: OpResult[] = [];
    for (const { baseRevision, ...plain } of ops) {
      const op = { ...plain, entryId: forks.get(plain.entryId) ?? plain.entryId } as WireOperation;
      const known = this.results.get(op.opId);
      if (known) {
        out.push({ ...known, replayed: true });
        continue;
      }
      const e = this.entries.find((x) => x.id === op.entryId);
      const expired = this.expired(baseRevision) || baseRevision > this.revision;
      const moved =
        op.type !== "open" &&
        e?.open === true &&
        !own.has(e.id) &&
        (expired || (e.urlRevision > baseRevision && e.urlDevice !== deviceId));
      if (!moved) {
        const r = this.apply(deviceId, op);
        if (r.status === "applied" && (op.type === "open" || op.type === "navigate")) own.add(op.entryId);
        out.push(r);
        continue;
      }
      if (op.type !== "navigate") {
        const result: OpResult = { opId: op.opId, status: "ignored" };
        this.results.set(op.opId, result);
        out.push(result);
        continue;
      }
      const forkId = await uuidv5(op.opId, "forked");
      const fork: WireOperation = { opId: op.opId, type: "open", entryId: forkId, urlKey: op.urlKey, urlEnc: op.urlEnc, pinned: e!.pinned };
      const r = this.apply(deviceId, fork);
      if (r.status !== "applied") {
        out.push(r);
        continue;
      }
      forks.set(plain.entryId, forkId);
      own.add(forkId);
      const forked: OpResult = { ...r, status: "forked" };
      this.results.set(op.opId, forked);
      out.push(forked);
    }
    return out;
  }

  private apply(deviceId: string, op: WireOperation): OpResult {
    const known = this.results.get(op.opId);
    if (known) return { ...known, replayed: true };
    let result: OpResult;
    const openByKey = (urlKey: string) => this.entries.find((e) => e.open && e.urlKey === urlKey);
    const byId = (id: string) => this.entries.find((e) => e.id === id);
    switch (op.type) {
      case "open": {
        const existing = openByKey(op.urlKey);
        const same = byId(op.entryId);
        if (same) {
          result = same.open ? { opId: op.opId, status: "coalesced", entryId: same.id } : { opId: op.opId, status: "ignored" };
        } else if (existing) {
          result = { opId: op.opId, status: "coalesced", entryId: existing.id };
        } else {
          this.entries.push({
            id: op.entryId,
            urlKey: op.urlKey,
            urlEnc: op.urlEnc,
            pinned: op.pinned ?? false,
            position: op.position ?? this.entries.length,
            updatedRevision: this.revision + 1,
            open: true,
            urlRevision: this.revision + 1,
            urlDevice: deviceId,
          });
          result = { opId: op.opId, status: "applied", entryId: op.entryId };
        }
        break;
      }
      case "navigate": {
        const e = byId(op.entryId);
        const other = openByKey(op.urlKey);
        if (!e || !e.open) result = { opId: op.opId, status: "ignored" };
        else if (other && other.id !== e.id) {
          e.open = false;
          result = { opId: op.opId, status: "coalesced", entryId: other.id };
        } else {
          Object.assign(e, { urlKey: op.urlKey, urlEnc: op.urlEnc, urlRevision: this.revision + 1, urlDevice: deviceId });
          result = { opId: op.opId, status: "applied", entryId: e.id };
        }
        break;
      }
      case "close": {
        const e = byId(op.entryId);
        if (!e || !e.open) result = { opId: op.opId, status: "ignored" };
        else {
          e.open = false;
          result = { opId: op.opId, status: "applied", entryId: e.id };
        }
        break;
      }
      case "update": {
        const e = byId(op.entryId);
        if (!e || !e.open) result = { opId: op.opId, status: "ignored" };
        else {
          if (op.pinned !== undefined) e.pinned = op.pinned;
          if (op.position !== undefined) e.position = op.position;
          result = { opId: op.opId, status: "applied", entryId: e.id };
        }
        break;
      }
    }
    this.results.set(op.opId, result);
    if (result.status !== "ignored") {
      this.revision++;
      this.log.push({ seq: this.revision, deviceId, op, result });
    }
    return result;
  }

  private auth(token: string | null): Device {
    if (this.unreachable) throw new Unreachable();
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      const code = this.failNext.code ?? "internal";
      throw new ApiError(this.failNext.status, code, `${code} (${this.failNext.status})`);
    }
    const d = this.devices.find((x) => x.token === token);
    if (!d) throw new ApiError(401, "unauthorized", "unknown token");
    if (d.revoked) throw new ApiError(401, "device_revoked", "device revoked");
    return d;
  }

  private dropResponse(): void {
    if (!this.dropNextOperationsResponse) return;
    this.dropNextOperationsResponse = false;
    throw new Unreachable();
  }

  private checkOwner(d: Device, generation: number): void {
    if (!this.owner || this.owner.deviceId !== d.id || this.owner.generation !== generation) {
      throw new ApiError(409, "stale_owner", "stale owner", { owner: this.owner });
    }
  }

  /** The real client over this server's `fetch`, with a test cipher when `key` is given. */
  api = (cfg: { baseUrl: string; token: string | null; key?: string | null }): Api =>
    new ApiClient({ baseUrl: cfg.baseUrl, token: cfg.token, fetch: this.fetch, cipher: cfg.key ? testCipher(cfg.key) : undefined });

  /** HTTP surface: `/v2/...` routes, JSON bodies, `{error, message, ...}` errors. */
  fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://fake.invalid");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = headers["Authorization"]?.replace(/^Bearer /, "") ?? null;
    const text = typeof init?.body === "string" ? init.body : "";
    const json = (status: number, body: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    try {
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const out = await this.route(method, url, token, body, encoder.encode(text).length);
      if (out === undefined) return json(204, undefined);
      return json(out.status, out.body);
    } catch (e) {
      if (e instanceof Unreachable) throw new TypeError("Failed to fetch");
      // A 2xx failure (failNext) is a response the client cannot parse.
      if (e instanceof ApiError && e.status < 300) return new Response("<html>", { status: e.status });
      if (e instanceof ApiError) return json(e.status, { ...e.body, error: e.code, message: e.message });
      throw e;
    }
  };

  private async route(
    method: string,
    url: URL,
    token: string | null,
    body: Record<string, unknown>,
    bytes: number,
  ): Promise<{ status: number; body: unknown } | undefined> {
    const ok = (b: unknown, status = 200) => ({ status, body: b });
    const path = url.pathname;
    const route = `${method} ${path.replace(/^\/v2\/(devices|snapshots)\/[^/]+/, "/v2/$1/{id}")}`;
    const param = decodeURIComponent(path.split("/")[3] ?? "");

    if (route === "POST /v2/pair") {
      if (this.unreachable) throw new Unreachable();
      const { code, name, browser } = body as { code: string; name: string; browser: string };
      this.requests.push({ path: "pair", body: { code, name, browser } });
      if (!this.codes.delete(code)) throw new ApiError(400, "invalid_code", "invalid or expired code");
      const d = this.addDevice(name, browser);
      return ok({ deviceId: d.id, token: d.token, name: d.name }, 201);
    }
    const d = this.auth(token);
    switch (route) {
      case "POST /v2/pairing-codes": {
        const code = `CODE${this.codes.size}`.padEnd(8, "X");
        this.codes.add(code);
        const base = url.origin === "http://fake.invalid" ? "https://sync.example" : url.origin;
        return ok({ code, expiresAt: new Date(this.now() + 600_000).toISOString(), link: `${base}#${code}` }, 201);
      }
      case "GET /v2/devices": {
        const cutoff = this.now() - REVOKED_LISTED_MS;
        const recent = this.devices
          .filter((x) => x.revokedAt && Date.parse(x.revokedAt) > cutoff)
          .sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!));
        return ok({ devices: [...this.devices.filter((x) => !x.revoked), ...recent].map((x) => this.deviceJson(x, d.id)) });
      }
      case "PATCH /v2/devices/{id}": {
        if (param !== d.id) throw new ApiError(403, "forbidden", "a device can only rename itself");
        const trimmed = String(body["name"] ?? "").trim();
        if (!trimmed || [...trimmed].length > 64) throw bad("bad name");
        d.name = this.uniqueName(trimmed, d.id);
        if (this.owner?.deviceId === d.id) this.owner = { ...this.owner, name: d.name };
        return ok(this.deviceJson(d, d.id));
      }
      case "DELETE /v2/devices/{id}": {
        const x = this.devices.find((y) => y.id === param);
        if (!x || x.revoked) throw new ApiError(404, "not_found", "not found");
        x.revoked = true;
        x.revokedAt = new Date(this.now()).toISOString();
        if (this.owner?.deviceId === param) this.owner = null;
        return undefined;
      }
      case "GET /v2/session":
        this.requests.push({ path: "session", device: d.id });
        return ok(this.wireSession());
      case "GET /v2/session/changes": {
        const since = Number(url.searchParams.get("since"));
        this.requests.push({ path: "changes", body: { since }, device: d.id });
        if (since < 0 || since > this.revision || this.expired(since)) throw new ApiError(410, "history_expired", "history expired");
        const operations = this.log.filter((l) => l.seq > since);
        return ok({ revision: this.revision, minRevision: this.minRevision, owner: this.owner, operations });
      }
      case "POST /v2/session/acquire": {
        const force = body["force"] === true;
        this.requests.push({ path: "acquire", body: { force }, device: d.id });
        if (this.owner?.deviceId === d.id) return ok({ generation: this.owner.generation, session: this.wireSession() });
        if (this.owner && !force) throw new ApiError(409, "owner_active", "owner active", { owner: this.owner });
        this.generation++;
        this.owner = { deviceId: d.id, name: d.name, generation: this.generation, lastSeenAt: new Date().toISOString() };
        return ok({ generation: this.generation, session: this.wireSession() });
      }
      case "POST /v2/session/release":
        this.checkOwner(d, body["generation"] as number);
        this.owner = null;
        return undefined;
      case "POST /v2/session/heartbeat":
        this.checkOwner(d, body["generation"] as number);
        return undefined;
      case "POST /v2/session/operations": {
        const { generation, baseRevision, operations } = body as { generation: number; baseRevision: number; operations: WireOperation[] };
        this.requests.push({ path: "operations", body: { generation, baseRevision, operations: operations.map(plainOp) }, device: d.id, bytes });
        validateBatch({ baseRevision, operations }, bytes); // 400/413 before 409, as the server
        await this.beforeOperations?.();
        this.checkOwner(d, generation);
        const fullResync = this.expired(baseRevision);
        const catchUp = this.log.filter((l) => l.seq > baseRevision && l.deviceId !== d.id);
        this.snapshotIfNeeded(d.id, operations);
        const results = operations.map((op) => this.apply(d.id, op));
        this.dropResponse();
        if (fullResync) return ok({ revision: this.revision, results, fullResync: true });
        return ok({ revision: this.revision, results, catchUp: { operations: catchUp } });
      }
      case "POST /v2/session/merge": {
        const operations = body["operations"] as WireMergeOperation[];
        this.requests.push({ path: "merge", body: { operations: operations.map((o) => ({ ...plainOp(o), baseRevision: o.baseRevision })) }, device: d.id, bytes });
        validateBatch({ baseRevision: 0, operations }, bytes);
        this.snapshotIfNeeded(d.id, operations);
        const results = await this.merge(d.id, operations);
        this.dropResponse();
        return ok({ revision: this.revision, results });
      }
      case "GET /v2/snapshots":
        return ok({ snapshots: this.snapshots.map(({ entries: _e, ...s }) => ({ ...s })) });
      case "POST /v2/snapshots/{id}/restore": {
        const id = Number(param);
        const generation = body["generation"] as number;
        this.requests.push({ path: "restore", body: { id, generation }, device: d.id });
        this.checkOwner(d, generation);
        const snap = this.snapshots.find((s) => s.id === id);
        if (!snap) throw new ApiError(404, "not_found", "not found");
        const ops: WireOperation[] = snap.entries.map((e, i) => {
          const key = `${id}:${generation}:${i}`;
          const ids = this.restoreIds.get(key) ?? { opId: crypto.randomUUID(), entryId: crypto.randomUUID() };
          this.restoreIds.set(key, ids);
          return { ...ids, type: "open", urlKey: e.urlKey, urlEnc: e.urlEnc, pinned: e.pinned, position: e.position };
        });
        if (ops.some((op) => !this.results.has(op.opId))) this.snapshot(d.id, "restore");
        const results = ops.map((op) => this.apply(d.id, op));
        return ok({ revision: this.revision, results });
      }
      default:
        // Includes /v2/diag (like a server without CTS_DEBUG) and every /v1 route.
        throw new ApiError(404, "not_found", "no such endpoint");
    }
  }
}
