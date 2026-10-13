// Manual handover (PROTOCOL.md "Client behavior (v0.1 manual handover)").
// Written against BrowserAdapter and a client factory so it runs unchanged against fakes.

import type { BrowserAdapter, TabInfo } from "../adapter/types.js";
import {
  ApiError,
  normalizeServerUrl,
  type ApiClient,
  type BrowserKind,
  type LoggedOperation,
  type OpResult,
  type Operation,
  type Owner,
} from "./client.js";
import { eligibleTabs, type EligibleTab } from "./eligibility.js";
import { acknowledge, append, batches, list, newOpId, pendingEntryIds } from "./journal.js";
import {
  emptyMappings,
  reconcileMappings,
  remapEntry,
  removeMappings,
  setMapping,
  tabsForEntry,
  type Mappings,
} from "./mapping.js";
import { plan, type TabToCreate } from "./plan.js";
import { clearedCredentials, isPaired, loadState, PENDING_PAIR_TTL_MS, saveState, type State } from "./state.js";

export type Api = Pick<
  ApiClient,
  "pair" | "createPairingCode" | "deleteDevice" | "session" | "changes" | "acquire" | "release" | "heartbeat" | "operations"
>;

export interface Deps {
  adapter: BrowserAdapter;
  api: (cfg: { baseUrl: string; token: string | null }) => Api;
  browser: BrowserKind;
  now?: () => Date;
  newId?: () => string;
}

/** Thin mutable view over persisted state: every `set` is written through immediately. */
class Store {
  constructor(
    readonly deps: Deps,
    public s: State,
  ) {}

  static async open(deps: Deps): Promise<Store> {
    return new Store(deps, await loadState(deps.adapter.storage));
  }

  async set(patch: Partial<State>): Promise<void> {
    this.s = { ...this.s, ...patch };
    await saveState(this.deps.adapter.storage, patch);
  }
}

const nowIso = (deps: Deps) => (deps.now ? deps.now() : new Date()).toISOString();
const idGen = (deps: Deps) => deps.newId ?? newOpId;

function apiFor(deps: Deps, s: State): Api {
  return deps.api({ baseUrl: s.serverUrl, token: s.token });
}

function requirePaired(s: State): void {
  if (!isPaired(s)) throw new Error("This device is not paired");
}

function ownerLabel(o: Owner | null): string {
  return o ? `${o.name} (generation ${o.generation})` : "another device";
}

/**
 * Record an error in state. `stale_owner` drops owner state; `device_revoked` clears credentials.
 * Always rethrows so the caller can report it.
 */
async function fail(store: Store, e: unknown): Promise<never> {
  if (e instanceof ApiError && e.code === "stale_owner") {
    const owner = e.owner;
    await store.set({
      generation: null,
      owner,
      statusText: `Not the owner: ${ownerLabel(owner)} took over. Use Continue here to take control.`,
      lastError: "Ownership was taken by another device; nothing was applied.",
    });
  } else if (e instanceof ApiError && e.code === "device_revoked") {
    await store.set({
      ...clearedCredentials(),
      statusText: "Disconnected",
      lastError: "This device was revoked on the server. Pair it again.",
    });
  } else {
    await store.set({ lastError: e instanceof Error ? e.message : String(e) });
  }
  throw e;
}

async function captureTabs(adapter: BrowserAdapter): Promise<{ all: TabInfo[]; eligible: EligibleTab[] }> {
  const [all, windows] = await Promise.all([adapter.queryTabs(), adapter.getWindows()]);
  return { all, eligible: eligibleTabs(all, windows) };
}

/**
 * Window that receives created tabs: the last focused normal window, else the persisted
 * `receivingWindowId`, else any normal window. Null means a window must be created.
 */
export async function resolveReceivingWindow(adapter: BrowserAdapter, persisted: number | null): Promise<number | null> {
  const windows = (await adapter.getWindows()).filter((w) => w.type === "normal" && !w.incognito);
  const ids = new Set(windows.map((w) => w.id));
  const last = await adapter.getLastFocusedWindow().catch(() => null);
  if (last && ids.has(last.id)) return last.id;
  if (persisted !== null && ids.has(persisted)) return persisted;
  return windows[0]?.id ?? null;
}

/** Create tabs in the background. Never activates a tab or focuses a window. */
async function createTabs(
  store: Store,
  items: TabToCreate[],
): Promise<{ created: number; failed: number }> {
  if (items.length === 0) return { created: 0, failed: 0 };
  const { adapter } = store.deps;
  let windowId = await resolveReceivingWindow(adapter, store.s.receivingWindowId);
  let mappings = store.s.mappings;
  let created = 0;
  let failed = 0;
  for (const item of items) {
    try {
      let tab: TabInfo;
      if (windowId === null) {
        const w = await adapter.createWindow(item.url);
        windowId = w.windowId;
        tab = w.tab;
        if (item.pinned) await adapter.updateTab(tab.id, { pinned: true });
      } else {
        tab = await adapter.createTab({ windowId, url: item.url, pinned: item.pinned });
      }
      mappings = setMapping(mappings, tab.id, item.entryId, item.url);
      created++;
    } catch {
      failed++;
    }
  }
  await store.set({ mappings, receivingWindowId: windowId });
  return { created, failed };
}

/** Acknowledge results, and follow coalesced opens/navigates to the surviving entry. */
export function applyResults(mappings: Mappings, ops: Operation[], results: OpResult[]): Mappings {
  const byId = new Map(ops.map((op) => [op.opId, op]));
  let m = mappings;
  for (const r of results) {
    const op = byId.get(r.opId);
    if (!op || r.status !== "coalesced" || !r.entryId || r.entryId === op.entryId) continue;
    m = remapEntry(m, op.entryId, r.entryId);
  }
  return m;
}

/**
 * Apply operations made by other devices. v0.1 never closes local tabs: a `close` only unmaps.
 * New entries reuse a local tab with the exact URL before a background tab is created.
 */
async function applyCatchUp(store: Store, ops: LoggedOperation[]): Promise<void> {
  const foreign = ops
    .filter((l) => l.deviceId !== store.s.deviceId && l.result.status !== "ignored")
    .sort((a, b) => a.seq - b.seq);
  if (foreign.length === 0) return;
  const { adapter } = store.deps;
  const { all, eligible } = await captureTabs(adapter);
  let mappings = reconcileMappings(store.s.mappings, all);
  const toCreate: TabToCreate[] = [];

  for (const { op, result } of foreign) {
    const target = result.entryId ?? op.entryId;
    switch (op.type) {
      case "open": {
        if (target !== op.entryId) mappings = remapEntry(mappings, op.entryId, target);
        if (tabsForEntry(mappings, target).length > 0 || toCreate.some((c) => c.entryId === target)) break;
        const reuse = eligible.filter((t) => t.url === op.url && mappings.tabs[String(t.id)] === undefined);
        if (reuse.length > 0) {
          for (const t of reuse) mappings = setMapping(mappings, t.id, target, op.url);
        } else {
          toCreate.push({ entryId: target, url: op.url, pinned: op.pinned ?? false });
        }
        break;
      }
      case "navigate": {
        const tabIds = tabsForEntry(mappings, op.entryId);
        mappings = remapEntry(mappings, op.entryId, target, op.url);
        const pendingCreate = toCreate.find((c) => c.entryId === op.entryId);
        if (pendingCreate) Object.assign(pendingCreate, { entryId: target, url: op.url });
        for (const id of tabIds) await adapter.updateTab(id, { url: op.url }).catch(() => undefined);
        break;
      }
      case "close": {
        mappings = removeMappings(mappings, tabsForEntry(mappings, op.entryId));
        const i = toCreate.findIndex((c) => c.entryId === op.entryId);
        if (i >= 0) toCreate.splice(i, 1);
        break;
      }
      case "update": {
        if (op.pinned === undefined) break;
        for (const id of tabsForEntry(mappings, op.entryId)) {
          await adapter.updateTab(id, { pinned: op.pinned }).catch(() => undefined);
        }
        break;
      }
    }
  }
  await store.set({ mappings });
  await createTabs(store, toCreate);
}

/**
 * Send every journaled operation (in server-sized batches) and apply results and catchUp.
 * With nothing to send, catch up through `changes?since=` instead of posting an empty batch.
 */
async function flush(store: Store): Promise<void> {
  const deps = store.deps;
  const generation = store.s.generation;
  if (generation === null) throw new Error("This device is not the owner");
  const api = apiFor(deps, store.s);
  const pending = batches(list(store.s.pending));
  if (pending.length === 0) {
    try {
      const res = await api.changes(store.s.lastRevision);
      await applyCatchUp(store, res.operations);
      await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), lastSync: nowIso(deps) });
    } catch (e) {
      // History older than the server keeps: the next Continue here resyncs from the full session.
      if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
    }
    return;
  }
  for (const batch of pending) {
    const res = await api.operations({ generation, baseRevision: store.s.lastRevision, operations: batch });
    await store.set({
      pending: acknowledge(store.s.pending, res.results.map((r) => r.opId)),
      mappings: applyResults(store.s.mappings, batch, res.results),
    });
    await applyCatchUp(store, res.catchUp?.operations ?? []);
    await store.set({ lastRevision: Math.max(store.s.lastRevision, res.revision), lastSync: nowIso(deps) });
  }
}

/** Hand over: publish unmapped eligible tabs, apply catchUp, release ownership. */
export async function handOver(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  try {
    requirePaired(store.s);
    const generation = store.s.generation;
    if (generation === null) throw new Error("This device is not the owner. Use Continue here to take control first.");

    const { all, eligible } = await captureTabs(deps.adapter);
    const p = plan({
      entries: null,
      tabs: eligible,
      mappings: reconcileMappings(store.s.mappings, all),
      pendingEntries: pendingEntryIds(store.s.pending),
      newId: idGen(deps),
    });
    // Journal before sending: a crash or network error leaves ops to be replayed with the same ids.
    await store.set({ mappings: p.mappings, pending: append(store.s.pending, p.open) });
    await flush(store);

    await apiFor(deps, store.s).release(generation);
    await store.set({
      generation: null,
      owner: null,
      lastSync: nowIso(deps),
      lastError: null,
      statusText: `Handed over at revision ${store.s.lastRevision}`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

/** Continue here: force-acquire, materialize the session locally, publish local extras. */
export async function continueHere(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  try {
    requirePaired(store.s);
    const { generation, session } = await apiFor(deps, store.s).acquire(true);
    // Nothing local has changed before this point, so an unreachable server leaves tabs untouched.
    await store.set({
      generation,
      owner: session.owner ?? {
        deviceId: store.s.deviceId ?? "",
        name: store.s.deviceName,
        generation,
        lastSeenAt: nowIso(deps),
      },
      lastRevision: session.revision,
      lastSync: nowIso(deps),
    });

    const { all, eligible } = await captureTabs(deps.adapter);
    const p = plan({
      entries: session.entries,
      tabs: eligible,
      mappings: reconcileMappings(store.s.mappings, all),
      pendingEntries: pendingEntryIds(store.s.pending),
      newId: idGen(deps),
    });
    await store.set({ mappings: p.mappings, pending: append(store.s.pending, p.open) });
    const { failed } = await createTabs(store, p.create);
    await flush(store);

    await store.set({
      lastSync: nowIso(deps),
      lastError: failed > 0 ? `${failed} tab(s) could not be created` : null,
      statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

export async function pair(
  deps: Deps,
  input: { serverUrl: string; deviceName: string; code: string },
): Promise<State> {
  const store = await Store.open(deps);
  try {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const deviceName = input.deviceName.trim();
    const code = input.code.replace(/\s+/g, "");
    if (!deviceName) throw new Error("Device name is required");
    if (deviceName.length > 64) throw new Error("Device name must be at most 64 characters");
    if (!code) throw new Error("Pairing code is required");
    const res = await deps.api({ baseUrl: serverUrl, token: null }).pair({ code, name: deviceName, browser: deps.browser });
    await store.set({
      ...clearedCredentials(),
      serverUrl,
      deviceName,
      deviceId: res.deviceId,
      token: res.token,
      mappings: emptyMappings(),
      lastSync: nowIso(deps),
      lastError: null,
      statusText: "Paired. Use Continue here to take control on this device.",
    });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

/**
 * Complete a pairing saved by the popup (see State.pendingPair). Consumes the record first so a
 * second trigger cannot reuse the single-use code. Returns null when there is nothing to do.
 */
export async function pairFromPending(deps: Deps, now = Date.now()): Promise<State | null> {
  const s = await loadState(deps.adapter.storage);
  const pending = s.pendingPair;
  if (!pending) return null;
  await saveState(deps.adapter.storage, { pendingPair: null });
  if (now - pending.createdAt > PENDING_PAIR_TTL_MS) return null;
  return pair(deps, pending);
}

export async function createPairingCode(deps: Deps): Promise<{ code: string; expiresAt: string }> {
  const store = await Store.open(deps);
  try {
    requirePaired(store.s);
    return await apiFor(deps, store.s).createPairingCode();
  } catch (e) {
    return fail(store, e);
  }
}

/** Best effort: release ownership and revoke this device on the server, then forget credentials. */
export async function disconnect(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  if (isPaired(store.s)) {
    const api = apiFor(deps, store.s);
    if (store.s.generation !== null) await api.release(store.s.generation).catch(() => undefined);
    if (store.s.deviceId) await api.deleteDevice(store.s.deviceId).catch(() => undefined);
  }
  await store.set({ ...clearedCredentials(), lastError: null, lastSync: null, statusText: "Disconnected" });
  return store.s;
}

/**
 * Refresh the known owner without applying changes (follower application arrives in v0.2).
 * Returns whether the server was reachable.
 */
export async function refreshOwner(deps: Deps): Promise<boolean> {
  const store = await Store.open(deps);
  if (!isPaired(store.s)) return false;
  const api = apiFor(deps, store.s);
  let owner: Owner | null;
  try {
    try {
      owner = (await api.changes(store.s.lastRevision)).owner;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
      owner = (await api.session()).owner;
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === "device_revoked") await fail(store, e).catch(() => undefined);
    return false;
  }
  const lostOwnership =
    store.s.generation !== null && (!owner || owner.deviceId !== store.s.deviceId || owner.generation !== store.s.generation);
  await store.set(
    lostOwnership
      ? { owner, generation: null, statusText: `Not the owner: ${ownerLabel(owner)} took over.` }
      : { owner },
  );
  return true;
}

/** Keep ownership alive while this device is the owner. Liveness only, never user activity. */
export async function heartbeat(deps: Deps): Promise<void> {
  const store = await Store.open(deps);
  const generation = store.s.generation;
  if (!isPaired(store.s) || generation === null) return;
  try {
    await apiFor(deps, store.s).heartbeat(generation);
    await store.set({ lastSync: nowIso(deps) });
  } catch (e) {
    await fail(store, e).catch(() => undefined);
  }
}

/** Clear tab mappings at browser startup: tab ids are only valid within one browser session. */
export async function resetForBrowserStartup(deps: Deps): Promise<void> {
  await saveState(deps.adapter.storage, { mappings: emptyMappings(), receivingWindowId: null, runLock: null });
}
