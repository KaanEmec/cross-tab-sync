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

function validateBatch(body: { baseRevision: number; operations: Operation[] }): void {
  const bad = (msg: string) => new ApiError(400, "invalid_request", msg, { error: "invalid_request" });
  if (encoder.encode(JSON.stringify(body)).length > 64 * 1024) {
    throw new ApiError(413, "payload_too_large", "body too large", { error: "payload_too_large" });
  }
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) throw bad("baseRevision required");
  if (body.operations.length > 500) throw bad("too many operations");
  for (const op of body.operations) {
    if (!UUID.test(op.opId) || !UUID.test(op.entryId)) throw bad("ids must be lowercase UUIDs");
    if ((op.type === "open" || op.type === "navigate") && !serverAcceptsUrl(op.url)) throw bad("invalid url");
  }
}

interface Device {
  id: string;
  name: string;
  token: string;
  revoked: boolean;
}

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
  /** Answer the next N authenticated requests with this HTTP status (5xx simulation). */
  failNext: { status: number; count: number } | null = null;
  snapshots: (Snapshot & { entries: Entry[] })[] = [];
  /** Restore ids per (snapshot, generation, index): a retry in the same generation replays. */
  private restoreIds = new Map<string, { opId: string; entryId: string }>();

  /** Oldest retained sequence number: `changes?since=` below `minRevision - 1` is 410. */
  get minRevision(): number {
    return this.historyStart + 1;
  }

  /** Base outside the retained history (a base at the current revision is never expired). */
  private expired(base: number): boolean {
    return base > this.revision || (base < this.historyStart && base < this.revision);
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

  addDevice(name: string): Device {
    const n = this.devices.length + 1;
    const d = { id: `dev-${n}`, name, token: `cts_token${n}`, revoked: false };
    this.devices.push(d);
    return d;
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
   * expired) forks a navigate into an open of a fresh entry and ignores close/update. Later ops of
   * the batch on a forked entry are redirected to the fork.
   */
  private merge(deviceId: string, ops: MergeOperation[]): OpResult[] {
    const forks = new Map<string, string>();
    return ops.map(({ baseRevision, ...plain }) => {
      const op = { ...plain, entryId: forks.get(plain.entryId) ?? plain.entryId } as Operation;
      const known = this.results.get(op.opId);
      if (known) return { ...known, replayed: true };
      const e = this.entries.find((x) => x.id === op.entryId);
      const moved =
        op.type !== "open" &&
        e?.open === true &&
        (this.expired(baseRevision) || (e.urlRevision > baseRevision && e.urlDevice !== deviceId));
      if (!moved) return this.apply(deviceId, op);
      if (op.type !== "navigate") {
        const result: OpResult = { opId: op.opId, status: "ignored" };
        this.results.set(op.opId, result);
        return result;
      }
      const fork: Operation = { opId: op.opId, type: "open", entryId: crypto.randomUUID(), url: op.url, pinned: e!.pinned };
      const r = this.apply(deviceId, fork);
      if (r.status !== "applied") return r;
      forks.set(plain.entryId, fork.entryId);
      const forked: OpResult = { ...r, status: "forked" };
      this.results.set(op.opId, forked);
      return forked;
    });
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
      throw new ApiError(this.failNext.status, "internal", "internal error", { error: "internal" });
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
    pair: async ({ code, name }) => {
      if (this.unreachable) throw new ApiError(0, "network_error", "Server is unreachable");
      if (!this.codes.delete(code)) throw new ApiError(400, "invalid_code", "invalid or expired code");
      const d = this.addDevice(name);
      return { deviceId: d.id, token: d.token };
    },
    createPairingCode: async () => {
      this.auth(cfg.token);
      const code = `CODE${this.codes.size}`.padEnd(8, "X");
      this.codes.add(code);
      return { code, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },
    devices: async () => {
      const d = this.auth(cfg.token);
      const at = new Date().toISOString();
      return this.devices
        .filter((x) => !x.revoked)
        .map((x) => ({ id: x.id, name: x.name, browser: "brave", createdAt: at, lastSeenAt: at, isSelf: x.id === d.id }));
    },
    deleteDevice: async (id) => {
      this.auth(cfg.token);
      const d = this.devices.find((x) => x.id === id);
      if (!d) throw new ApiError(404, "not_found", "not found");
      d.revoked = true;
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
      if (since < this.historyStart) throw new ApiError(410, "history_expired", "history expired", { error: "history_expired" });
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
      await this.beforeOperations?.();
      this.checkOwner(d, generation);
      validateBatch({ baseRevision, operations });
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
      const results = this.merge(d.id, operations);
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
