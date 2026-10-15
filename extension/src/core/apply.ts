// Local side of synchronization: capturing tabs, creating tabs in the background, applying remote
// operations (PROTOCOL.md "Applying remote operations"), and materializing a full session.
// The active tab and the focused window never change here.

import type { BrowserAdapter, TabInfo } from "../adapter/types.js";
import type { LoggedOperation, OpResult, Operation } from "./client.js";
import {
  expectLoads,
  EXPECT_TTL_MS,
  inStartupGrace,
  pruneExpected,
  STALE_MAPPINGS_TTL_MS,
  type Expectation,
  type HeldClose,
  type HeldNavigate,
} from "./changes.js";
import { diag } from "./diag.js";
import { eligibleTabs, type EligibleTab } from "./eligibility.js";
import { append, pendingChanges, type Journal } from "./journal.js";
import {
  claimByUrl,
  reconcileMappings,
  remapEntry,
  removeMappings,
  setMapping,
  tabsForEntry,
  type Mappings,
} from "./mapping.js";
import type { TabToCreate } from "./plan.js";
import { idGen, nowDate, nowMs, type Store } from "./store.js";

/** Tabs the extension is removing (live `remove` expectation). */
export function removingTabIds(expected: Expectation[], now: number): Set<number> {
  return new Set(expected.flatMap((e) => (e.kind === "remove" && e.until > now ? [e.tabId] : [])));
}

/**
 * Current tabs and the eligible ones among them. Tabs the extension is removing are left out:
 * browsers remove asynchronously, and a tab still listed after its removal was requested must not
 * be matched, adopted or published (it would become an entry with no tab anywhere).
 */
export async function captureTabs(
  adapter: BrowserAdapter,
  serverUrl: string,
  removing: Set<number> = new Set(),
): Promise<{ all: TabInfo[]; eligible: EligibleTab[] }> {
  const [tabs, windows] = await Promise.all([adapter.queryTabs(), adapter.getWindows()]);
  const all = removing.size > 0 ? tabs.filter((t) => !removing.has(t.id)) : tabs;
  return { all, eligible: eligibleTabs(all, windows, serverUrl) };
}

/** `captureTabs` without the tabs this store's expectations say are being removed. */
export function captureLive(store: Store): Promise<{ all: TabInfo[]; eligible: EligibleTab[] }> {
  return captureTabs(store.deps.adapter, store.s.serverUrl, removingTabIds(store.s.expected, nowMs(store.deps)));
}

/**
 * Entries this device closed, so they are never recreated locally: a journaled `close`, or a held
 * removal of the last local copy that is not released yet (it may still become a `close`; if the
 * hold is dropped later, nothing else changes).
 */
export function pendingClosedIds(journal: Journal, held: HeldClose[] = [], mappings?: Mappings): Set<string> {
  const ids = new Set(journal.filter((p) => p.op.type === "close").map((p) => p.op.entryId));
  for (const h of held) if (!h.done && (!mappings || tabsForEntry(mappings, h.entryId).length === 0)) ids.add(h.entryId);
  return ids;
}

/**
 * Entries this device changed and has not sent: a pending navigate/open, or a navigation still held
 * (NAVIGATE_SETTLE_MS). A remote navigate or close of such an entry forks instead of overwriting.
 */
export function locallyChanged(journal: Journal, held: HeldNavigate[], entryId: string): boolean {
  return pendingChanges(journal, entryId).length > 0 || held.some((h) => h.entryId === entryId);
}

/**
 * Detached tabs that still exist. After a browser restart (`stale-N` keys) each detached URL claims
 * one unmapped tab showing it; unmatched ones are kept while `live`.
 */
function reconcileDetached(
  detached: Record<string, string>,
  all: TabInfo[],
  eligible: EligibleTab[],
  mappings: Mappings,
  live: boolean,
): Record<string, string> {
  const present = new Set(all.map((t) => String(t.id)));
  const out: Record<string, string> = {};
  const stale: string[] = [];
  for (const [k, url] of Object.entries(detached)) {
    if (k.startsWith("stale-")) stale.push(url);
    else if (present.has(k)) out[k] = url;
  }
  stale.forEach((url, i) => {
    const tab = eligible.find((t) => t.url === url && !mappings.tabs[String(t.id)] && out[String(t.id)] === undefined);
    if (tab) out[String(tab.id)] = url;
    else if (live) out[`stale-${i}`] = url;
  });
  return out;
}

/**
 * Current mappings: drop tabs that are gone, then (after a browser restart) re-match the previous
 * session's mappings to current tabs by last-known URL. Unmatched ones are kept for restored tabs
 * that load later, until STALE_MAPPINGS_TTL_MS after startup. Persists the result.
 */
export async function currentMappings(store: Store, all: TabInfo[], eligible: EligibleTab[]): Promise<Mappings> {
  const live = inStartupGrace(store.s.startupAt, nowMs(store.deps), STALE_MAPPINGS_TTL_MS);
  let mappings = reconcileMappings(store.s.mappings, all);
  let staleMappings: Mappings | null = null;
  if (store.s.staleMappings) {
    const r = claimByUrl(store.s.staleMappings, eligible, mappings);
    mappings = r.mappings;
    staleMappings = live ? r.rest : null;
  }
  const detached = reconcileDetached(store.s.detached, all, eligible, mappings, live);
  await store.set({ mappings, staleMappings, detached });
  return mappings;
}

/**
 * Window that receives created tabs, read from the browser at creation time: the focused normal
 * window, else the last focused one (`getLastFocusedWindow`), else the persisted
 * `receivingWindowId` (last focus event, possibly stale), else any normal window. Null means a
 * window must be created.
 */
export async function resolveReceivingWindow(adapter: BrowserAdapter, persisted: number | null): Promise<number | null> {
  const windows = (await adapter.getWindows()).filter((w) => w.type === "normal" && !w.incognito);
  const ids = new Set(windows.map((w) => w.id));
  const last = await adapter.getLastFocusedWindow().catch(() => null);
  const focused = windows.find((w) => w.focused)?.id;
  const [id, source] =
    focused !== undefined
      ? [focused, "focused"]
      : last && ids.has(last.id)
        ? [last.id, "last focused"]
        : persisted !== null && ids.has(persisted)
          ? [persisted, "persisted"]
          : [windows[0]?.id ?? null, "any"];
  diag(`receiving window ${id ?? "new"} (${source}; last focused ${last?.id ?? "-"}, persisted ${persisted ?? "-"})`);
  return id;
}

export const expiry = (store: Store) => nowMs(store.deps) + EXPECT_TTL_MS;

/**
 * Divergence: this device changed an entry (pending navigate/open) that another device navigated or
 * closed. The local copies become a fresh entry: their pending navigate/open for the entry is
 * replaced by one `open` of the local URL, so both pages survive. Null when there is no local copy.
 */
export function forkEntry(
  mappings: Mappings,
  pending: Journal,
  entryId: string,
  newId: () => string,
  now: Date,
  baseRevision = 0,
): { mappings: Mappings; pending: Journal } | null {
  const copies = tabsForEntry(mappings, entryId);
  const first = mappings.tabs[String(copies[0])];
  if (!first) return null;
  const changes = new Set(pendingChanges(pending, entryId));
  const fresh = newId();
  return {
    mappings: remapEntry(mappings, entryId, fresh, first.url),
    pending: append(
      pending.filter((p) => !changes.has(p)),
      [{ opId: newId(), type: "open", entryId: fresh, url: first.url }],
      now,
      { baseRevision },
    ),
  };
}

/** The entry URL this device's pending change was based on, if it has one. */
export function pendingBase(pending: Journal, entryId: string): string | undefined {
  const p = pendingChanges(pending, entryId)[0];
  if (!p) return undefined;
  return p.op.type === "open" ? p.op.url : p.base;
}

/**
 * Create tabs in the background. Never activates a tab or focuses a window. Right before each
 * create the tabs are re-read: a tab that shows the URL by now (the user opened it meanwhile) is
 * mapped instead. Creates are announced as expectations so their events are not recorded.
 */
export async function createTabs(store: Store, items: TabToCreate[]): Promise<{ created: number; failed: number }> {
  if (items.length === 0) return { created: 0, failed: 0 };
  const { adapter } = store.deps;
  const until = expiry(store);
  await store.set({
    expected: [
      ...pruneExpected(store.s.expected, nowMs(store.deps)),
      ...items.map((i): Expectation => ({ kind: "create", url: i.url, entryId: i.entryId, until })),
    ],
  });
  let windowId = await resolveReceivingWindow(adapter, store.s.receivingWindowId);
  let created = 0;
  let failed = 0;
  for (const item of items) {
    const others = (e: Expectation) => !(e.kind === "create" && e.entryId === item.entryId);
    const { eligible } = await captureLive(store);
    const same = eligible.filter((t) => t.url === item.url);
    if (same.length > 0) {
      let mappings = store.s.mappings;
      const detached = { ...store.s.detached };
      for (const t of same) {
        if (mappings.tabs[String(t.id)]) continue;
        mappings = setMapping(mappings, t.id, item.entryId, item.url);
        delete detached[String(t.id)];
      }
      await store.set({ mappings, detached, expected: store.s.expected.filter(others) });
      continue;
    }
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
      // Persist per tab: a worker killed mid-loop must not leave created tabs unmapped.
      await store.set({
        mappings: setMapping(store.s.mappings, tab.id, item.entryId, item.url),
        receivingWindowId: windowId,
        expected: [...store.s.expected.filter(others), { kind: "load", tabId: tab.id, until: expiry(store), created: true }],
      });
      created++;
    } catch {
      failed++;
      await store.set({ expected: store.s.expected.filter(others) });
    }
  }
  return { created, failed };
}

/** Follow coalesced opens/navigates (and, from `merge`, forked navigates) to the surviving entry. */
export function applyResults(mappings: Mappings, ops: Operation[], results: OpResult[]): Mappings {
  const byId = new Map(ops.map((op) => [op.opId, op]));
  let m = mappings;
  for (const r of results) {
    const op = byId.get(r.opId);
    if (!op || (r.status !== "coalesced" && r.status !== "forked") || !r.entryId || r.entryId === op.entryId) continue;
    m = remapEntry(m, op.entryId, r.entryId);
  }
  return m;
}

/**
 * Apply operations made by other devices (catchUp or changes), in sequence order. Own operations
 * and `ignored` results are skipped. Tabs are closed only for `close` and for navigate coalescing,
 * and never the active tab of a window: an active tab whose entry closed stays open, unmapped and
 * detached. Every change the browser will report back is recorded as an expectation first.
 *
 * Divergence: when this device has a pending navigate/open for the entry, a remote navigate or
 * close never touches the local copies; they fork into a fresh entry (forkEntry) and a remote
 * navigate's destination gets its own background tab. `sentNavigated` lists entries this device
 * navigated in the batch whose catchUp this is: the server applied ours last, so the remote URL is
 * kept as a fresh entry instead. `revive` lists entries whose local copies `merge` moved away
 * (forked navigate, ignored close): a remote navigate of such an entry gets a background tab.
 */
export async function applyRemote(
  store: Store,
  ops: LoggedOperation[],
  sentNavigated = new Set<string>(),
  revive = new Set<string>(),
): Promise<void> {
  const foreign = ops
    .filter((l) => l.deviceId !== store.s.deviceId && l.result.status !== "ignored")
    .sort((a, b) => a.seq - b.seq);
  if (foreign.length === 0) return;
  const { adapter } = store.deps;
  const { all, eligible } = await captureLive(store);
  let mappings = await currentMappings(store, all, eligible);
  let pending = store.s.pending;
  const newId = idGen(store.deps);
  const base = store.s.lastRevision;
  const detached = { ...store.s.detached };
  const byId = new Map(all.map((t) => [t.id, t]));
  const loading = (id: number) => store.s.expected.some((e) => e.kind === "load" && e.tabId === id);
  const toCreate: TabToCreate[] = [];
  const navigateTo = new Map<number, string>();
  const remove = new Set<number>();
  const pin = new Map<number, boolean>();

  const urlOf = (id: number) => navigateTo.get(id) ?? byId.get(id)?.url ?? mappings.tabs[String(id)]?.url;
  const localWithUrl = (url: string, except: number[] = []) =>
    eligible.filter((t) => !remove.has(t.id) && !except.includes(t.id) && urlOf(t.id) === url);
  const adopt = (tabs: EligibleTab[], entryId: string, url: string) => {
    for (const t of tabs) {
      if (mappings.tabs[String(t.id)]) continue;
      mappings = setMapping(mappings, t.id, entryId, url);
      delete detached[String(t.id)];
    }
  };
  const fork = (entryId: string) => {
    const f = forkEntry(mappings, pending, entryId, newId, nowDate(store.deps), base);
    if (!f) return false;
    ({ mappings, pending } = f);
    return true;
  };
  /** A local tab for `url` belonging to `entryId`: reuse one showing it, else create one. */
  const ensureTab = (entryId: string, url: string) => {
    const dest = localWithUrl(url);
    if (dest.length > 0) adopt(dest, entryId, url);
    else if (!toCreate.some((c) => c.entryId === entryId)) toCreate.push({ entryId, url, pinned: false });
  };
  const dropTab = (id: number) => {
    const url = urlOf(id);
    mappings = removeMappings(mappings, [id]);
    navigateTo.delete(id);
    if (byId.get(id)?.active) {
      if (url) detached[String(id)] = url;
    } else {
      remove.add(id);
    }
  };

  for (const { op, result } of foreign) {
    const target = result.entryId ?? op.entryId;
    switch (op.type) {
      case "open": {
        if (target !== op.entryId) mappings = remapEntry(mappings, op.entryId, target);
        if (tabsForEntry(mappings, target).length > 0 || toCreate.some((c) => c.entryId === target)) break;
        // Coalesced into an entry this device closed (journaled or still held): not recreated.
        if (pendingClosedIds(pending, store.s.heldCloses, mappings).has(target)) break;
        const local = localWithUrl(op.url);
        // Already open locally (possibly under a not yet published local entry): never duplicate.
        if (local.length > 0) adopt(local, target, op.url);
        else toCreate.push({ entryId: target, url: op.url, pinned: op.pinned ?? false });
        break;
      }
      case "navigate": {
        const copies = tabsForEntry(mappings, op.entryId).filter((id) => !remove.has(id));
        const localUrl = mappings.tabs[String(copies[0])]?.url;
        if (copies.length === 0 && revive.has(op.entryId) && !toCreate.some((c) => c.entryId === op.entryId)) {
          ensureTab(target, op.url);
          break;
        }
        if (copies.length > 0 && localUrl !== op.url && sentNavigated.has(op.entryId)) {
          const fresh = newId();
          pending = append(pending, [{ opId: newId(), type: "open", entryId: fresh, url: op.url }], nowDate(store.deps), { baseRevision: base });
          ensureTab(fresh, op.url);
          break;
        }
        if (localUrl !== op.url && locallyChanged(pending, store.s.heldNavigates, op.entryId) && fork(op.entryId)) {
          ensureTab(target, op.url);
          break;
        }
        const planned = toCreate.find((c) => c.entryId === op.entryId);
        if (planned) Object.assign(planned, { entryId: target, url: op.url });
        const dest = localWithUrl(op.url, copies);
        mappings = remapEntry(mappings, op.entryId, target, op.url);
        if (dest.length > 0) {
          // Destination already open locally: background copies close, the entry maps to it.
          for (const id of copies) {
            if (byId.get(id)?.active) navigateTo.set(id, op.url);
            else dropTab(id);
          }
          adopt(dest, target, op.url);
          if (planned) toCreate.splice(toCreate.indexOf(planned), 1);
        } else {
          for (const id of copies) if (urlOf(id) !== op.url) navigateTo.set(id, op.url);
        }
        break;
      }
      case "close": {
        const i = toCreate.findIndex((c) => c.entryId === op.entryId);
        if (i >= 0) toCreate.splice(i, 1);
        // An unsent local change on the entry survives as a fresh opening.
        if (locallyChanged(pending, store.s.heldNavigates, op.entryId) && fork(op.entryId)) break;
        for (const id of tabsForEntry(mappings, op.entryId)) {
          const live = byId.get(id)?.url;
          const m = mappings.tabs[String(id)]!;
          if (live !== undefined && live !== m.url && !loading(id)) {
            // Navigated by the user, event not recorded yet: keep it detached at the mapped URL; the
            // event publishes it if it moved to another site (changes.recordUpdated).
            mappings = removeMappings(mappings, [id]);
            detached[String(id)] = m.url;
          } else {
            dropTab(id);
          }
        }
        break;
      }
      case "update": {
        if (op.pinned === undefined) break;
        for (const id of tabsForEntry(mappings, op.entryId)) pin.set(id, op.pinned);
        const planned = toCreate.find((c) => c.entryId === op.entryId);
        if (planned) planned.pinned = op.pinned;
        break;
      }
    }
  }

  // Re-read before acting: a tab that became active meanwhile is detached instead of closed.
  const now = await adapter.queryTabs();
  const current = new Map(now.map((t) => [t.id, t]));
  for (const id of [...remove]) {
    const t = current.get(id);
    if (!t) remove.delete(id);
    else if (t.active) {
      remove.delete(id);
      if (t.url) detached[String(id)] = t.url;
    }
  }
  for (const id of [...navigateTo.keys()]) if (!current.has(id) || remove.has(id)) navigateTo.delete(id);
  const until = expiry(store);
  const expected: Expectation[] = [
    ...expectLoads(store.s.expected, navigateTo.keys(), nowMs(store.deps), until),
    ...[...remove].map((tabId): Expectation => ({ kind: "remove", tabId, until })),
  ];
  await store.set({ mappings, detached, expected, pending });

  for (const [id, url] of navigateTo) await adapter.updateTab(id, { url }).catch(() => undefined);
  for (const id of remove) await adapter.removeTab(id).catch(() => undefined);
  for (const [id, pinned] of pin) {
    const t = current.get(id);
    if (t && !remove.has(id) && t.pinned !== pinned) await adapter.updateTab(id, { pinned }).catch(() => undefined);
  }
  await createTabs(store, toCreate);
}
