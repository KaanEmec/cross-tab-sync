// Sync runs (PROTOCOL.md "Roles and cadence"): the owner flushes its journal through `operations`
// and applies catchUp; a follower submits its journal through `merge` (v1.0), then pulls `changes`.
// Expired history (`410` on changes, `fullResync` on operations) rebuilds from `GET session`.

import { applyRemote, applyResults, forkEntry } from "./apply.js";
import { materialize } from "./materialize.js";
import { ApiError, type Operation, type OperationsResponse, type Owner } from "./client.js";
import { acknowledge, batches, list } from "./journal.js";
import { dropBatch, isMalformed, submitJournal } from "./merge.js";
import { isPaired, type State } from "./state.js";
import { apiFor, demote, fail, idGen, isStaleOwner, nowDate, Store, succeeded, type Deps } from "./store.js";

export function rejectedMessage(rejected: number): string | null {
  return rejected > 0 ? `${rejected} change(s) were rejected by the server and dropped` : null;
}

export function createFailedMessage(failed: number): string | null {
  return failed > 0 ? `${failed} tab(s) could not be created` : null;
}

const joined = (...msgs: (string | null)[]) => msgs.filter(Boolean).join("; ") || null;

function followingText(owner: Owner | null, deviceId: string | null, revision: number): string {
  const who = !owner ? "no owner" : owner.deviceId === deviceId ? "this device" : owner.name;
  return `Following ${who}, revision ${revision}`;
}

/**
 * Send every journaled operation in server-sized batches (an empty batch when nothing is pending:
 * heartbeat plus catch-up) and apply results and catchUp after each batch. Batches are cut from the
 * live journal each time because applying catchUp may rewrite it (forkEntry). A `fullResync`
 * answer rebuilds from the session and sends the rest of the journal through `merge`, so changes
 * recorded before the expired history are checked causally.
 */
export async function flush(store: Store): Promise<{ rejected: number; failed: number }> {
  const deps = store.deps;
  const generation = store.s.generation;
  if (generation === null) throw new Error("This device is not the owner");
  const api = apiFor(deps, store.s);
  let rejected = 0;
  let failed = 0;
  for (let first = true; ; first = false) {
    const batch: Operation[] = batches(list(store.s.pending))[0] ?? [];
    if (batch.length === 0 && !first) break;
    let res: OperationsResponse;
    try {
      res = await api.operations({ generation, baseRevision: store.s.lastRevision, operations: batch });
    } catch (e) {
      if (!isMalformed(e)) throw e;
      rejected += await dropBatch(store, batch);
      continue;
    }
    let mappings = applyResults(store.s.mappings, batch, res.results);
    let pending = acknowledge(store.s.pending, res.results.map((r) => r.opId));
    const status = new Map(res.results.map((r) => [r.opId, r.status]));
    const navigated = new Set<string>();
    for (const op of batch) {
      if (op.type !== "navigate") continue;
      if (status.get(op.opId) === "applied") navigated.add(op.entryId);
      // Ignored: the entry was closed elsewhere first. The local page survives as a fresh opening.
      if (status.get(op.opId) === "ignored") {
        const f = forkEntry(mappings, pending, op.entryId, idGen(deps), nowDate(deps), store.s.lastRevision);
        if (f) ({ mappings, pending } = f);
      }
    }
    await store.set({ pending, mappings });
    if (res.fullResync) {
      failed += await resync(store);
      rejected += (await submitJournal(store)).rejected;
      break;
    }
    await applyRemote(store, res.catchUp?.operations ?? [], navigated);
    await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), ...succeeded(deps) });
    // Safety: a server that answered without results for the batch must not loop forever.
    if (batch.length > 0 && batch.every((op) => store.s.pending.some((p) => p.op.opId === op.opId))) break;
  }
  return { rejected, failed };
}

/**
 * Rebuild from `GET session`: reconcile mappings by URL, create missing tabs, detach tabs whose
 * entries are gone, never close or publish. The journal is kept. Returns failed creates.
 */
export async function resync(store: Store): Promise<number> {
  const session = await apiFor(store.deps, store.s).session();
  const { failed } = await materialize(store, session.entries, false);
  await store.set({
    lastRevision: session.revision,
    minRevision: session.minRevision ?? store.s.minRevision,
    owner: session.owner,
    ...succeeded(store.deps),
  });
  return failed;
}

/**
 * Submit the journal through `merge`, then pull and apply other devices' operations (410: full
 * resync). Operations the pull itself journaled (divergence forks) are merged in the same run.
 */
export async function followerRun(store: Store): Promise<void> {
  const sent = await submitJournal(store);
  let failed = 0;
  if (store.s.lastRevision === 0) {
    failed = await resync(store);
  } else {
    let res;
    try {
      res = await apiFor(store.deps, store.s).changes(store.s.lastRevision);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
    }
    if (res) {
      await applyRemote(store, res.operations, new Set(), sent.revive);
      await store.set({
        lastRevision: Math.max(store.s.lastRevision, res.revision),
        minRevision: res.minRevision ?? store.s.minRevision,
        owner: res.owner,
      });
    } else {
      failed = await resync(store);
    }
  }
  const again = store.s.pending.length > 0 ? await submitJournal(store) : { rejected: 0 };
  await store.set({
    ...succeeded(store.deps),
    lastError: joined(createFailedMessage(failed), rejectedMessage(sent.rejected + again.rejected)),
    statusText: followingText(store.s.owner, store.s.deviceId, store.s.lastRevision),
  });
}

/** Flush and apply catchUp. `409 stale_owner` demotes (journal kept) and continues as a follower. */
export async function ownerRun(store: Store): Promise<void> {
  const generation = store.s.generation;
  try {
    const { rejected, failed } = await flush(store);
    await store.set({
      ...succeeded(store.deps),
      lastError: joined(createFailedMessage(failed), rejectedMessage(rejected)),
      statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`,
    });
  } catch (e) {
    if (!isStaleOwner(e) || !(await demote(store, e, generation))) throw e;
    await followerRun(store);
  }
}

/** One scheduled run (alarm, local changes, Sync now, retry) in the device's current role. */
export async function syncRun(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  if (!isPaired(store.s)) return store.s;
  const generation = store.s.generation;
  try {
    if (generation !== null) await ownerRun(store);
    else await followerRun(store);
  } catch (e) {
    return fail(store, e, generation);
  }
  return store.s;
}
