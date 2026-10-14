// In-memory implementation of the PROTOCOL.md server semantics, enough to drive handover and sync tests.
import {
  ApiError,
  type Entry,
  type LoggedOperation,
  type MergeOperation,
  type OpResult,
  type Operation,
  type Owner,
  type Session,
  type Snapshot,
} from "../../src/core/client.js";
import type { Api } from "../../src/core/handover.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

/** Mirrors the Go server: url.Parse-style escapes, http(s), non-empty host, 2048 bytes. */
export function serverAcceptsUrl(url: string): boolean {
  if (encoder.encode(url).length > 2048 || /%(?![0-9A-Fa-f]{2})/.test(url)) return false;
  const m = /^(https?):\/\/([^/?#]*)/.exec(url);
  return Boolean(m && m[2] && m[2].replace(/^.*@/, "").replace(/:\d*$/, ""));
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

function validateBatch(body: { baseRevision: number; operations: Operation[] }): void {
  const bad = (msg: string) => new ApiError(400, "invalid_request", msg, { error: "invalid_request" });
  const tooLarge = (msg: string) => new ApiError(413, "payload_too_large", msg, { error: "payload_too_large" });
  if (encoder.encode(JSON.stringify(body)).length > 64 * 1024) throw tooLarge("body too large");
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) throw bad("baseRevision required");
  if (body.operations.length > 500) throw tooLarge("at most 500 operations per batch");
  for (const op of body.operations) {
    if (!UUID.test(op.opId) || !UUID.test(op.entryId)) throw bad("ids must be lowercase UUIDs");
    if ((op.type === "open" || op.type === "navigate") && !serverAcceptsUrl(op.url)) throw bad("invalid url");
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

type ServerEntry = Entry & { open: boolean; urlRevision: number; urlDevice: string };

export class FakeServer {
  revision = 0;
  generation = 0;
  owner: Owner | null = null;
  entries: ServerEntry[] = [];
  log: LoggedOperation[] = [];
  results = new Map<string, OpResult>();
  devices: Device[] = [];
  codes = new Set<string>(["GOODCODE"]);
  unreachable = false;
  /** Apply the next operations or merge batch but fail as if the response was lost. */
  dropNextOperationsResponse = false;
  requests: { path: string; body?: unknown; device?: string }[] = [];
  /** `changes?since=` below this revision answers `410 history_expired`. */
  historyStart = 0;
  /** Test hook to delay an operations request between authentication and the ownership check. */
  beforeOperations?: () => Promise<void>;
  /** Answer the next N authenticated requests with this HTTP status and error code (default `internal`). */
  failNext: { status: number; count: number; code?: string } | null = null;
  snapshots: (Snapshot & { entries: Entry[] })[] = [];
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
    const entries = this.session().entries;
    if (entries.length === 0) return;
    const id = (this.snapshots[0]?.id ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.snapshots.unshift({ id, revision: this.revision, deviceId, reason, createdAt, entryCount: entries.length, entries });
  }

  private snapshotIfNeeded(deviceId: string, ops: Operation[]): void {
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

  session(): Session {
    return {
      revision: this.revision,
      minRevision: this.minRevision,
      owner: this.owner ? { ...this.owner } : null,
      entries: this.entries
        .filter((e) => e.open)
        .map(({ open: _open, urlRevision: _r, urlDevice: _d, ...e }) => ({ ...e }))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    };
  }

  openUrls(): string[] {
    return this.session().entries.map((e) => e.url);
  }

  /** Apply ops as `deviceId` without ownership checks (simulates history written by another device). */
  inject(deviceId: string, ops: Operation[]): OpResult[] {
    return ops.map((op) => this.apply(deviceId, op));
  }

  /**
   * Merge rules: an entry moved (URL changed by another device after `baseRevision`, or the base is
   * expired or ahead of the session) forks a navigate into an open of a fresh entry (UUIDv5 of the
   * opId and "forked") and ignores close/update. Entries whose URL this batch itself set are never
   * moved. Later ops of the batch on a forked entry are redirected to the fork.
   */
  private async merge(deviceId: string, ops: MergeOperation[]): Promise<OpResult[]> {
    const forks = new Map<string, string>();
    const own = new Set<string>();
    const out: OpResult[] = [];
    for (const { baseRevision, ...plain } of ops) {
      const op = { ...plain, entryId: forks.get(plain.entryId) ?? plain.entryId } as Operation;
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
      const r = this.apply(deviceId, { opId: op.opId, type: "open", entryId: forkId, url: op.url, pinned: e!.pinned });
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

  private apply(deviceId: string, op: Operation): OpResult {
    const known = this.results.get(op.opId);
    if (known) return { ...known, replayed: true };
    let result: OpResult;
    const openByUrl = (url: string) => this.entries.find((e) => e.open && e.url === url);
    const byId = (id: string) => this.entries.find((e) => e.id === id);
    switch (op.type) {
      case "open": {
        const existing = openByUrl(op.url);
        const same = byId(op.entryId);
        if (same) {
          result = same.open ? { opId: op.opId, status: "coalesced", entryId: same.id } : { opId: op.opId, status: "ignored" };
        } else if (existing) {
          result = { opId: op.opId, status: "coalesced", entryId: existing.id };
        } else {
          this.entries.push({
            id: op.entryId,
            url: op.url,
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
        const other = openByUrl(op.url);
        if (!e || !e.open) result = { opId: op.opId, status: "ignored" };
        else if (other && other.id !== e.id) {
          e.open = false;
          result = { opId: op.opId, status: "coalesced", entryId: other.id };
        } else {
          Object.assign(e, { url: op.url, urlRevision: this.revision + 1, urlDevice: deviceId });
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
    if (this.unreachable) throw new ApiError(0, "network_error", "Server is unreachable");
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      const code = this.failNext.code ?? "internal";
      throw new ApiError(this.failNext.status, code, `${code} (${this.failNext.status})`, { error: code });
    }
    const d = this.devices.find((x) => x.token === token);
    if (!d) throw new ApiError(401, "unauthorized", "unknown token");
    if (d.revoked) throw new ApiError(401, "device_revoked", "device revoked");
    return d;
  }

  private dropResponse(): void {
    if (!this.dropNextOperationsResponse) return;
    this.dropNextOperationsResponse = false;
    throw new ApiError(0, "network_error", "Server is unreachable");
  }

  private checkOwner(d: Device, generation: number): void {
    if (!this.owner || this.owner.deviceId !== d.id || this.owner.generation !== generation) {
      throw new ApiError(409, "stale_owner", "stale owner", { error: "stale_owner", owner: this.owner });
    }
  }

  api = (cfg: { baseUrl: string; token: string | null }): Api => ({
    pair: async ({ code, name, browser }) => {
      if (this.unreachable) throw new ApiError(0, "network_error", "Server is unreachable");
      this.requests.push({ path: "pair", body: { code, name, browser } });
      if (!this.codes.delete(code)) throw new ApiError(400, "invalid_code", "invalid or expired code");
      const d = this.addDevice(name, browser);
      return { deviceId: d.id, token: d.token, name: d.name };
    },
    createPairingCode: async () => {
      this.auth(cfg.token);
      const code = `CODE${this.codes.size}`.padEnd(8, "X");
      this.codes.add(code);
      return { code, expiresAt: new Date(this.now() + 600_000).toISOString(), link: `${cfg.baseUrl}#${code}` };
    },
    devices: async () => {
      const d = this.auth(cfg.token);
      const cutoff = this.now() - REVOKED_LISTED_MS;
      const recent = this.devices
        .filter((x) => x.revokedAt && Date.parse(x.revokedAt) > cutoff)
        .sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!));
      return [...this.devices.filter((x) => !x.revoked), ...recent].map((x) => this.deviceJson(x, d.id));
    },
    renameDevice: async (id, name) => {
      const d = this.auth(cfg.token);
      if (id !== d.id) throw new ApiError(403, "forbidden", "a device can only rename itself", { error: "forbidden" });
      const trimmed = name.trim();
      if (!trimmed || [...trimmed].length > 64) throw new ApiError(400, "invalid_request", "bad name", { error: "invalid_request" });
      d.name = this.uniqueName(trimmed, d.id);
      if (this.owner?.deviceId === d.id) this.owner = { ...this.owner, name: d.name };
      return this.deviceJson(d, d.id);
    },
    deleteDevice: async (id) => {
      this.auth(cfg.token);
      const d = this.devices.find((x) => x.id === id);
      if (!d || d.revoked) throw new ApiError(404, "not_found", "not found");
      d.revoked = true;
      d.revokedAt = new Date(this.now()).toISOString();
      if (this.owner?.deviceId === id) this.owner = null;
    },
    session: async () => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "session", device: d.id });
      return this.session();
    },
    changes: async (since) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "changes", body: { since }, device: d.id });
      if (since < 0 || since > this.revision || this.expired(since)) {
        throw new ApiError(410, "history_expired", "history expired", { error: "history_expired" });
      }
      const operations = this.log.filter((l) => l.seq > since);
      return { revision: this.revision, minRevision: this.minRevision, owner: this.owner, operations };
    },
    acquire: async (force) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "acquire", body: { force }, device: d.id });
      if (this.owner?.deviceId === d.id) return { generation: this.owner.generation, session: this.session() };
      if (this.owner && !force) throw new ApiError(409, "owner_active", "owner active", { owner: this.owner });
      this.generation++;
      this.owner = { deviceId: d.id, name: d.name, generation: this.generation, lastSeenAt: new Date().toISOString() };
      return { generation: this.generation, session: this.session() };
    },
    release: async (generation) => {
      const d = this.auth(cfg.token);
      this.checkOwner(d, generation);
      this.owner = null;
    },
    heartbeat: async (generation) => {
      const d = this.auth(cfg.token);
      this.checkOwner(d, generation);
    },
    operations: async ({ generation, baseRevision, operations }) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "operations", body: { generation, baseRevision, operations }, device: d.id });
      validateBatch({ baseRevision, operations }); // 400/413 before 409, as the server
      await this.beforeOperations?.();
      this.checkOwner(d, generation);
      const fullResync = this.expired(baseRevision);
      const catchUp = this.log.filter((l) => l.seq > baseRevision && l.deviceId !== d.id);
      this.snapshotIfNeeded(d.id, operations);
      const results = operations.map((op) => this.apply(d.id, op));
      this.dropResponse();
      if (fullResync) return { revision: this.revision, results, fullResync: true };
      return { revision: this.revision, results, catchUp: { operations: catchUp } };
    },
    merge: async (operations) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "merge", body: { operations }, device: d.id });
      validateBatch({ baseRevision: 0, operations });
      this.snapshotIfNeeded(d.id, operations);
      const results = await this.merge(d.id, operations);
      this.dropResponse();
      return { revision: this.revision, results };
    },
    snapshots: async () => {
      this.auth(cfg.token);
      return this.snapshots.map(({ entries: _e, ...s }) => ({ ...s }));
    },
    restoreSnapshot: async (id, generation) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "restore", body: { id, generation }, device: d.id });
      this.checkOwner(d, generation);
      const snap = this.snapshots.find((s) => s.id === id);
      if (!snap) throw new ApiError(404, "not_found", "not found", { error: "not_found" });
      const ops: Operation[] = snap.entries.map((e, i) => {
        const key = `${id}:${generation}:${i}`;
        const ids = this.restoreIds.get(key) ?? { opId: crypto.randomUUID(), entryId: crypto.randomUUID() };
        this.restoreIds.set(key, ids);
        return { ...ids, type: "open", url: e.url, pinned: e.pinned, position: e.position };
      });
      if (ops.some((op) => !this.results.has(op.opId))) this.snapshot(d.id, "restore");
      const results = ops.map((op) => this.apply(d.id, op));
      return { revision: this.revision, results };
    },
  });
}
