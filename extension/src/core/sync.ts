// Sync runs (PROTOCOL.md "Roles and cadence"): the owner flushes its journal and applies catchUp,
// a follower pulls `changes` and applies them; `410 history_expired` falls back to a full resync.

import { applyRemote, applyResults, forkEntry } from "./apply.js";
import { materialize } from "./materialize.js";
import { ApiError, type Operation, type OperationsResponse, type Owner } from "./client.js";
import { acknowledge, batches, list } from "./journal.js";
import { removeMappings } from "./mapping.js";
import { isPaired, type State } from "./state.js";
import { apiFor, demote, fail, idGen, isStaleOwner, nowDate, nowIso, Store, type Deps } from "./store.js";

export function rejectedMessage(rejected: number): string | null {
  return rejected > 0 ? `${rejected} change(s) were rejected by the server and dropped` : null;
}

function createFailedMessage(failed: number): string | null {
  return failed > 0 ? `${failed} tab(s) could not be created` : null;
}

function followingText(owner: Owner | null, deviceId: string | null, revision: number): string {
  const who = !owner ? "no owner" : owner.deviceId === deviceId ? "this device" : owner.name;
  return `Following ${who}, revision ${revision}`;
}

/**
 * Send every journaled operation in server-sized batches (an empty batch when nothing is pending:
 * heartbeat plus catch-up) and apply results and catchUp after each batch. Batches are cut from the
 * live journal each time because applying catchUp may rewrite it (forkEntry).
 */
export async function flush(store: Store): Promise<{ rejected: number }> {
  const deps = store.deps;
  const generation = store.s.generation;
  if (generation === null) throw new Error("This device is not the owner");
  const api = apiFor(deps, store.s);
  let rejected = 0;
  for (let first = true; ; first = false) {
    const batch: Operation[] = batches(list(store.s.pending))[0] ?? [];
    if (batch.length === 0 && !first) break;
    let res: OperationsResponse;
    try {
      res = await api.operations({ generation, baseRevision: store.s.lastRevision, operations: batch });
    } catch (e) {
      // A batch the server refuses as malformed would be refused forever: drop it from the journal
      // and unmap its tabs so the rest proceeds. Nothing in the batch was applied.
      if (!(e instanceof ApiError && (e.code === "invalid_request" || e.code === "payload_too_large"))) throw e;
      const entryIds = new Set(batch.map((op) => op.entryId));
      const tabIds = Object.entries(store.s.mappings.tabs)
        .filter(([, m]) => entryIds.has(m.entryId))
        .map(([k]) => Number(k));
      await store.set({
        pending: acknowledge(store.s.pending, batch.map((op) => op.opId)),
        mappings: removeMappings(store.s.mappings, tabIds),
      });
      rejected += batch.length;
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
        const f = forkEntry(mappings, pending, op.entryId, idGen(deps), nowDate(deps));
        if (f) ({ mappings, pending } = f);
      }
    }
    await store.set({ pending, mappings });
    await applyRemote(store, res.catchUp?.operations ?? [], navigated);
    await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), lastSync: nowIso(deps) });
    // Safety: a server that answered without results for the batch must not loop forever.
    if (batch.length > 0 && batch.every((op) => store.s.pending.some((p) => p.op.opId === op.opId))) break;
  }
  return { rejected };
}

/** Rebuild from `GET session`: reconcile mappings by URL, create missing tabs, never close or publish. */
export async function fullResync(store: Store): Promise<void> {
  const session = await apiFor(store.deps, store.s).session();
  const { failed } = await materialize(store, session.entries, false);
  await store.set({
    lastRevision: session.revision,
    owner: session.owner,
    lastSync: nowIso(store.deps),
    lastError: createFailedMessage(failed),
    statusText: followingText(session.owner, store.s.deviceId, session.revision),
  });
}

/** Pull and apply other devices' operations. The journal is held until this device is owner. */
export async function followerRun(store: Store): Promise<void> {
  if (store.s.lastRevision === 0) return fullResync(store);
  let res;
  try {
    res = await apiFor(store.deps, store.s).changes(store.s.lastRevision);
  } catch (e) {
    if (e instanceof ApiError && e.code === "history_expired") return fullResync(store);
    throw e;
  }
  await applyRemote(store, res.operations);
  const revision = Math.max(store.s.lastRevision, res.revision);
  await store.set({
    lastRevision: revision,
    owner: res.owner,
    lastSync: nowIso(store.deps),
    lastError: null,
    statusText: followingText(res.owner, store.s.deviceId, revision),
  });
}

/** Flush and apply catchUp. `409 stale_owner` demotes (journal kept) and continues as a follower. */
export async function ownerRun(store: Store): Promise<void> {
  const generation = store.s.generation;
  try {
    const { rejected } = await flush(store);
    await store.set({
      lastError: rejectedMessage(rejected),
      statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`,
    });
  } catch (e) {
    if (!isStaleOwner(e) || !(await demote(store, e, generation))) throw e;
    await followerRun(store);
  }
}

/** One scheduled run (alarm, local changes, Sync now) in the device's current role. */
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
