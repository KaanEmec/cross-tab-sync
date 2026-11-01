// Submitting the pending journal through `merge` (PROTOCOL.md "Merge rules (offline changes,
// v1.0)"): any paired device, no ownership needed or claimed. Each operation carries the revision
// the device had applied when it recorded it, so the server can keep both sides of a divergence.

import { forkEntry, applyResults } from "./apply.js";
import { ApiError, type BatchResponse, type OpResult, type Operation } from "./client.js";
import { acknowledge, batches, redirect, toMerge } from "./journal.js";
import { removeMappings } from "./mapping.js";
import { apiFor, idGen, nowDate, type Store } from "./store.js";

/**
 * A batch the server refuses as malformed would be refused forever. Only the batch-level refusals
 * count (400 invalid_request, 413 payload_too_large): a 403 invalid_request (HTTPS required) says
 * nothing about the batch and must not drop the journal.
 */
export function isMalformed(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    ((e.status === 400 && e.code === "invalid_request") || (e.status === 413 && e.code === "payload_too_large"))
  );
}

/** Drop a refused batch from the journal and unmap its tabs so the rest proceeds. Nothing in it was applied. */
export async function dropBatch(store: Store, batch: Operation[]): Promise<number> {
  const entryIds = new Set(batch.map((op) => op.entryId));
  const tabIds = Object.entries(store.s.mappings.tabs)
    .filter(([, m]) => entryIds.has(m.entryId))
    .map(([k]) => Number(k));
  await store.set({
    pending: acknowledge(store.s.pending, batch.map((op) => op.opId)),
    mappings: removeMappings(store.s.mappings, tabIds),
  });
  return batch.length;
}

/**
 * Apply `merge` results to the journal and mappings. `forked`/`coalesced`: local tabs follow the
 * new entry and remaining pending operations for the old entry are rewritten to it. `ignored`:
 * dropped; an ignored navigate (entry closed meanwhile) keeps the local page as a fresh opening,
 * as for the owner. Entries the server may keep with another device's URL while this device no
 * longer shows them (forked source, ignored close) are added to `revive`: only a remote navigate
 * of such an entry in the following pull opens a tab for it.
 */
async function applyMergeResults(store: Store, batch: Operation[], results: OpResult[], revive: Set<string>): Promise<void> {
  const deps = store.deps;
  let mappings = applyResults(store.s.mappings, batch, results);
  let pending = acknowledge(store.s.pending, results.map((r) => r.opId));
  const byId = new Map(batch.map((op) => [op.opId, op]));
  for (const r of results) {
    const op = byId.get(r.opId);
    if (!op) continue;
    if (r.entryId && r.entryId !== op.entryId) {
      pending = redirect(pending, op.entryId, r.entryId);
      // A fork (possibly coalesced onto an open URL) leaves the source entry with another URL.
      if (op.type === "navigate") revive.add(op.entryId);
    }
    if (r.status !== "ignored") continue;
    if (op.type === "close") revive.add(op.entryId);
    if (op.type === "navigate") {
      const f = forkEntry(mappings, pending, op.entryId, idGen(deps), nowDate(deps), store.s.lastRevision);
      if (f) ({ mappings, pending } = f);
    }
  }
  await store.set({ pending, mappings });
}

/** Send the whole journal through `merge` in server-sized batches, in order, with the same opIds. */
export async function submitJournal(store: Store): Promise<{ rejected: number; revive: Set<string> }> {
  const api = apiFor(store.deps, store.s);
  const revive = new Set<string>();
  let rejected = 0;
  for (;;) {
    const batch = batches(toMerge(store.s.pending))[0];
    if (!batch) break;
    let res: BatchResponse;
    try {
      res = await api.merge(batch);
    } catch (e) {
      if (!isMalformed(e)) throw e;
      rejected += await dropBatch(store, batch);
      continue;
    }
    await applyMergeResults(store, batch, res.results, revive);
    // Safety: a server that answered without results for the batch must not loop forever.
    if (batch.every((op) => store.s.pending.some((p) => p.op.opId === op.opId))) break;
  }
  return { rejected, revive };
}
