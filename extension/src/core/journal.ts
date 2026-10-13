import type { Operation } from "./client.js";

/**
 * Pending operation journal. Operations are written here before they are sent and removed only
 * when the server returns a result for their `opId`, so a retry after a crash or a network error
 * resends the same ids and the server replays the stored result instead of applying twice.
 */
export interface PendingOp {
  op: Operation;
  queuedAt: string;
}

export type Journal = PendingOp[];

export function newOpId(): string {
  return crypto.randomUUID();
}

export function append(journal: Journal, ops: Operation[], now: Date = new Date()): Journal {
  const known = new Set(journal.map((p) => p.op.opId));
  const added = ops.filter((op) => !known.has(op.opId)).map((op) => ({ op, queuedAt: now.toISOString() }));
  return [...journal, ...added];
}

export function acknowledge(journal: Journal, opIds: Iterable<string>): Journal {
  const acked = new Set(opIds);
  return journal.filter((p) => !acked.has(p.op.opId));
}

export function list(journal: Journal): Operation[] {
  return journal.map((p) => p.op);
}

/** Entry ids that have a pending `open` (the entry may not exist on the server yet). */
export function pendingEntryIds(journal: Journal): Set<string> {
  return new Set(journal.filter((p) => p.op.type === "open").map((p) => p.op.entryId));
}

export const MAX_BATCH_OPS = 500;
/** Request bodies are capped at 64 KiB; leave room for the envelope. */
export const MAX_BATCH_BYTES = 60 * 1024;

const encoder = new TextEncoder();

/** Split operations into batches within the server limits, preserving order. */
export function batches(ops: Operation[], maxOps = MAX_BATCH_OPS, maxBytes = MAX_BATCH_BYTES): Operation[][] {
  const out: Operation[][] = [];
  let current: Operation[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = encoder.encode(JSON.stringify(op)).length + 1;
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
