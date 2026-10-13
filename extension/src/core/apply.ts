// Local side of synchronization: capturing tabs, creating tabs in the background, applying remote
// operations (PROTOCOL.md "Applying remote operations"), and materializing a full session.
// The active tab and the focused window never change here.

import type { BrowserAdapter, TabInfo } from "../adapter/types.js";
import type { Entry, LoggedOperation, OpResult, Operation } from "./client.js";
import { EXPECT_TTL_MS, inStartupGrace, pruneExpected, STALE_MAPPINGS_TTL_MS, type Expectation } from "./changes.js";
import { eligibleTabs, type EligibleTab } from "./eligibility.js";
import { append, pendingEntryIds, type Journal } from "./journal.js";
import { claimByUrl, reconcileMappings, remapEntry, removeMappings, setMapping, tabsForEntry, type Mappings } from "./mapping.js";
import { plan, type OpenOp, type TabToCreate } from "./plan.js";
import { idGen, nowMs, type Store } from "./store.js";

export async function captureTabs(adapter: BrowserAdapter): Promise<{ all: TabInfo[]; eligible: EligibleTab[] }> {
  const [all, windows] = await Promise.all([adapter.queryTabs(), adapter.getWindows()]);
  return { all, eligible: eligibleTabs(all, windows) };
}

/** Entries with a journaled `close`: this device closed them, so they are never recreated locally. */
export function pendingClosedIds(journal: Journal): Set<string> {
  return new Set(journal.filter((p) => p.op.type === "close").map((p) => p.op.entryId));
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

const expiry = (store: Store) => nowMs(store.deps) + EXPECT_TTL_MS;

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
    const { eligible } = await captureTabs(adapter);
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
        expected: [...store.s.expected.filter(others), { kind: "load", tabId: tab.id, until: expiry(store) }],
      });
      created++;
    } catch {
      failed++;
    }
  }
  return { created, failed };
}

/** Follow coalesced opens/navigates to the surviving entry. */
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
 * Apply operations made by other devices (catchUp or changes), in sequence order. Own operations
 * and `ignored` results are skipped. Tabs are closed only for `close` and for navigate coalescing,
 * and never the active tab of a window: an active tab whose entry closed stays open, unmapped and
 * detached. Every change the browser will report back is recorded as an expectation first.
 */
export async function applyRemote(store: Store, ops: LoggedOperation[]): Promise<void> {
  const foreign = ops
    .filter((l) => l.deviceId !== store.s.deviceId && l.result.status !== "ignored")
    .sort((a, b) => a.seq - b.seq);
  if (foreign.length === 0) return;
  const { adapter } = store.deps;
  const { all, eligible } = await captureTabs(adapter);
  let mappings = await currentMappings(store, all, eligible);
  const detached = { ...store.s.detached };
  const byId = new Map(all.map((t) => [t.id, t]));
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
        const local = localWithUrl(op.url);
        // Already open locally (possibly under a not yet published local entry): never duplicate.
        if (local.length > 0) adopt(local, target, op.url);
        else toCreate.push({ entryId: target, url: op.url, pinned: op.pinned ?? false });
        break;
      }
      case "navigate": {
        const copies = tabsForEntry(mappings, op.entryId).filter((id) => !remove.has(id));
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
        for (const id of tabsForEntry(mappings, op.entryId)) dropTab(id);
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
    ...pruneExpected(store.s.expected, nowMs(store.deps)),
    ...[...navigateTo.keys()].map((tabId): Expectation => ({ kind: "load", tabId, until })),
    ...[...remove].map((tabId): Expectation => ({ kind: "remove", tabId, until })),
  ];
  await store.set({ mappings, detached, expected });

  for (const [id, url] of navigateTo) await adapter.updateTab(id, { url }).catch(() => undefined);
  for (const id of remove) await adapter.removeTab(id).catch(() => undefined);
  for (const [id, pinned] of pin) {
    const t = current.get(id);
    if (t && !remove.has(id) && t.pinned !== pinned) await adapter.updateTab(id, { pinned }).catch(() => undefined);
  }
  await createTabs(store, toCreate);
}

/**
 * Bring local tabs in line with a full session (Continue here, Hand over with `entries` null, and
 * the follower full resync with `publish` false). Reuses tabs by URL, creates missing entries in the
 * background, never closes. Entries this device closed (journaled `close`) are not recreated.
 * Tabs mapped to entries that left the session, and detached tabs, are never republished: they are
 * detached. With `publish`, other unmapped tabs are journaled as `open`.
 */
export async function materialize(
  store: Store,
  entries: Entry[] | null,
  publish: boolean,
): Promise<{ open: OpenOp[]; failed: number }> {
  const { all, eligible } = await captureTabs(store.deps.adapter);
  const before = await currentMappings(store, all, eligible);
  const pendingIds = pendingEntryIds(store.s.pending);
  const closed = pendingClosedIds(store.s.pending);
  const sessionIds = entries ? new Set(entries.map((e) => e.id)) : null;
  const detached = { ...store.s.detached };
  const urlOf = new Map(eligible.map((t) => [String(t.id), t.url]));
  const orphan = (key: string) => {
    const m = before.tabs[key];
    return sessionIds !== null && m !== undefined && !sessionIds.has(m.entryId) && !pendingIds.has(m.entryId);
  };
  const keep = (key: string) => !orphan(key) && detached[key] !== urlOf.get(key);

  const p = plan({
    entries: entries && entries.filter((e) => !closed.has(e.id)),
    tabs: eligible,
    mappings: before,
    pendingEntries: pendingIds,
    newId: idGen(store.deps),
  });
  let mappings = p.mappings;
  const open: OpenOp[] = [];
  const fresh = new Set(p.open.map((o) => o.entryId));
  for (const key of Object.keys(mappings.tabs)) {
    // Reused for a session entry (or joined a mapped duplicate): no longer detached.
    if (!fresh.has(mappings.tabs[key]!.entryId)) delete detached[key];
  }
  for (const op of p.open) {
    const keys = Object.keys(mappings.tabs).filter((k) => mappings.tabs[k]!.entryId === op.entryId);
    if (publish && keys.some(keep)) {
      open.push(op);
      for (const k of keys) delete detached[k];
      continue;
    }
    mappings = removeMappings(mappings, keys.map(Number));
    for (const k of keys) if (orphan(k)) detached[k] = op.url;
  }
  await store.set({ mappings, detached, pending: append(store.s.pending, open) });
  const { failed } = await createTabs(store, p.create);
  return { open, failed };
}
