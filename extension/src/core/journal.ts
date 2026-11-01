import { diag, short } from "./diag.js";
import type { MergeOperation, Operation } from "./client.js";

/**
 * Pending operation journal. Operations are written here before they are sent and removed only
 * when the server returns a result for their `opId`, so a retry after a crash or a network error
 * resends the same ids and the server replays the stored result instead of applying twice.
 */
export interface PendingOp {
  op: Operation;
  queuedAt: string;
  /** For `navigate`: the entry's server URL before this change (detects divergent remote navigation). */
  base?: string;
  /**
   * The device's `lastRevision` when the change was recorded: the causal base `merge` checks it
   * against. Missing in journals written before v1.0 (sent as 0: treated conservatively).
   */
  baseRevision?: number;
}

export type Journal = PendingOp[];

export function newOpId(): string {
  return crypto.randomUUID();
}

export function append(
  journal: Journal,
  ops: Operation[],
  now: Date = new Date(),
  meta: { bases?: Record<string, string>; baseRevision?: number } = {},
): Journal {
  const known = new Set(journal.map((p) => p.op.opId));
  const added = ops
    .filter((op) => !known.has(op.opId))
    .map((op): PendingOp => {
      const p: PendingOp = { op, queuedAt: now.toISOString() };
      const base = meta.bases?.[op.opId];
      if (base) p.base = base;
      if (meta.baseRevision !== undefined) p.baseRevision = meta.baseRevision;
      return p;
    });
  if (added.length > 0) diag(`journal + ${added.map((p) => `${p.op.type}:${short(p.op.entryId)}`).join(" ")} (now ${journal.length + added.length})`);
  return [...journal, ...added];
}

/** Pending `navigate`/`open` of this device for an entry: local changes a remote one would overwrite. */
export function pendingChanges(journal: Journal, entryId: string): PendingOp[] {
  return journal.filter((p) => p.op.entryId === entryId && (p.op.type === "navigate" || p.op.type === "open"));
}

export function acknowledge(journal: Journal, opIds: Iterable<string>): Journal {
  const acked = new Set(opIds);
  return journal.filter((p) => !acked.has(p.op.opId));
}

export function list(journal: Journal): Operation[] {
  return journal.map((p) => p.op);
}

/** The journal as `merge` operations, each with its own causal base. */
export function toMerge(journal: Journal): MergeOperation[] {
  return journal.map((p) => ({ ...p.op, baseRevision: p.baseRevision ?? 0 }));
}

/**
 * Point pending operations for entry `from` at `to` (the server forked or coalesced it). The
 * server redirects within one batch only; later batches carry the new id from the journal.
 */
export function redirect(journal: Journal, from: string, to: string): Journal {
  if (from === to || !journal.some((p) => p.op.entryId === from)) return journal;
  return journal.map((p) => (p.op.entryId === from ? { ...p, op: { ...p.op, entryId: to } } : p));
}

/** Entry ids that have a pending `open` (the entry may not exist on the server yet). */
export function pendingEntryIds(journal: Journal): Set<string> {
  return new Set(journal.filter((p) => p.op.type === "open").map((p) => p.op.entryId));
}

export const MAX_BATCH_OPS = 500;
/** Request bodies are capped at 256 KiB; leave room for the envelope. */
export const MAX_BATCH_BYTES = 240 * 1024;

const encoder = new TextEncoder();

/**
 * Encoded size of an operation on the wire. The URL travels sealed (PROTOCOL.md "Encryption"):
 * a 43-character `urlKey` plus the base64url of the padded URL (64-byte blocks), with a margin
 * for ids, nonce, tag and field names.
 */
export function wireSize(op: Operation): number {
  if (op.type !== "open" && op.type !== "navigate") return encoder.encode(JSON.stringify(op)).length;
  return 43 + (Math.ceil((encoder.encode(op.url).length + 2) / 64) * 64 * 4) / 3 + 80;
}

/** Split operations into batches within the server limits, preserving order. */
export function batches<T extends Operation>(ops: T[], maxOps = MAX_BATCH_OPS, maxBytes = MAX_BATCH_BYTES): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = wireSize(op) + 1;
    if (current.length > 0 && (current.length >= maxOps || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}
