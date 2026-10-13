// In-memory implementation of the PROTOCOL.md server semantics, enough to drive handover tests.
import {
  ApiError,
  type Entry,
  type LoggedOperation,
  type OpResult,
  type Operation,
  type Owner,
  type Session,
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

export class FakeServer {
  revision = 0;
  generation = 0;
  owner: Owner | null = null;
  entries: (Entry & { open: boolean })[] = [];
  log: LoggedOperation[] = [];
  results = new Map<string, OpResult>();
  devices: Device[] = [];
  codes = new Set<string>(["GOODCODE"]);
  unreachable = false;
  /** Apply the next operations batch but fail as if the response was lost. */
  dropNextOperationsResponse = false;
  requests: { path: string; body?: unknown; device?: string }[] = [];
  /** Test hook to delay a heartbeat between authentication and the ownership check. */
  beforeHeartbeat?: () => Promise<void>;

  addDevice(name: string): Device {
    const n = this.devices.length + 1;
    const d = { id: `dev-${n}`, name, token: `cts_token${n}`, revoked: false };
    this.devices.push(d);
    return d;
  }

  session(): Session {
    return {
      revision: this.revision,
      owner: this.owner ? { ...this.owner } : null,
      entries: this.entries
        .filter((e) => e.open)
        .map(({ open: _open, ...e }) => ({ ...e }))
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

  private apply(deviceId: string, op: Operation): OpResult {
    const known = this.results.get(op.opId);
    if (known) return { ...known, replayed: true };
    let result: OpResult;
    const openByUrl = (url: string) => this.entries.find((e) => e.open && e.url === url);
    const byId = (id: string) => this.entries.find((e) => e.id === id);
    switch (op.type) {
      case "open": {
        const existing = openByUrl(op.url);
        if (existing) {
          result = { opId: op.opId, status: "coalesced", entryId: existing.id };
        } else {
          this.entries.push({
            id: op.entryId,
            url: op.url,
            pinned: op.pinned ?? false,
            position: op.position ?? this.entries.length,
            updatedRevision: this.revision + 1,
            open: true,
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
          e.url = op.url;
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
    const d = this.devices.find((x) => x.token === token);
    if (!d) throw new ApiError(401, "unauthorized", "unknown token");
    if (d.revoked) throw new ApiError(401, "device_revoked", "device revoked");
    return d;
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
    deleteDevice: async (id) => {
      this.auth(cfg.token);
      const d = this.devices.find((x) => x.id === id);
      if (!d) throw new ApiError(404, "not_found", "not found");
      d.revoked = true;
      if (this.owner?.deviceId === id) this.owner = null;
    },
    session: async () => {
      this.auth(cfg.token);
      return this.session();
    },
    changes: async (since) => {
      this.auth(cfg.token);
      return { revision: this.revision, owner: this.owner, operations: this.log.filter((l) => l.seq > since) };
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
      await this.beforeHeartbeat?.();
      this.checkOwner(d, generation);
    },
    operations: async ({ generation, baseRevision, operations }) => {
      const d = this.auth(cfg.token);
      this.requests.push({ path: "operations", body: { generation, baseRevision, operations }, device: d.id });
      this.checkOwner(d, generation);
      validateBatch({ baseRevision, operations });
      const catchUp = this.log.filter((l) => l.seq > baseRevision && l.deviceId !== d.id);
      const results = operations.map((op) => this.apply(d.id, op));
      if (this.dropNextOperationsResponse) {
        this.dropNextOperationsResponse = false;
        throw new ApiError(0, "network_error", "Server is unreachable");
      }
      return { revision: this.revision, results, catchUp: { operations: catchUp } };
    },
  });
}
