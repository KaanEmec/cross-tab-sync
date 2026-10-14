// Materializing a full session locally (Continue here, Hand over, follower full resync).

import type { Entry } from "./client.js";
import { expectLoads, sameOrigin } from "./changes.js";
import { append, pendingChanges, pendingEntryIds } from "./journal.js";
import { remapEntry, removeMappings, serverUrl, setMapping, tabsForEntry } from "./mapping.js";
import { plan, type OpenOp } from "./plan.js";
import { idGen, nowDate, nowMs, type Store } from "./store.js";
import { captureTabs, createTabs, currentMappings, expiry, forkEntry, pendingBase, pendingClosedIds } from "./apply.js";

/**
 * Bring local tabs in line with a full session (Continue here, Hand over with `entries` null, and
 * the follower full resync with `publish` false). Reuses tabs by URL, creates missing entries in the
 * background, never closes. Entries this device closed (journaled `close`) are not recreated.
 * Mapped copies whose entry moved on the server are navigated to it, unless this device has a
 * pending change for the entry based on another URL: then both survive (forkEntry). Tabs mapped to
 * entries that left the session are detached, never republished, unless they carry an unsent
 * navigation (published as a fresh opening). With `publish`, other unmapped tabs are journaled as
 * `open`; a detached tab only once it shows a different site than when it was detached (a
 * same-site URL change just updates the detached URL).
 */
export async function materialize(
  store: Store,
  entries: Entry[] | null,
  publish: boolean,
): Promise<{ open: OpenOp[]; failed: number }> {
  const { all, eligible } = await captureTabs(store.deps.adapter);
  let before = await currentMappings(store, all, eligible);
  let pending = store.s.pending;
  const newId = idGen(store.deps);
  const now = nowDate(store.deps);
  const baseRevision = store.s.lastRevision;
  const sessionIds = entries ? new Set(entries.map((e) => e.id)) : null;

  // Entries closed elsewhere while this device navigated them: keep the local page as an opening.
  if (sessionIds) {
    for (const entryId of new Set(Object.values(before.tabs).map((m) => m.entryId))) {
      if (sessionIds.has(entryId) || !pendingChanges(pending, entryId).some((p) => p.op.type === "navigate")) continue;
      const f = forkEntry(before, pending, entryId, newId, now, baseRevision);
      if (f) ({ mappings: before, pending } = f);
    }
  }

  const pendingIds = pendingEntryIds(pending);
  const closed = pendingClosedIds(pending);
  const detached = { ...store.s.detached };
  const urlOf = new Map(eligible.map((t) => [String(t.id), t.url]));
  const orphan = (key: string) => {
    const m = before.tabs[key];
    return sessionIds !== null && m !== undefined && !sessionIds.has(m.entryId) && !pendingIds.has(m.entryId);
  };
  /** Detached and still on the same site: stays local, never republished. */
  const stays = (key: string) => {
    const was = detached[key];
    const url = urlOf.get(key);
    return was !== undefined && url !== undefined && sameOrigin(was, url);
  };
  const keep = (key: string) => !orphan(key) && !stays(key);

  const p = plan({
    entries: entries && entries.filter((e) => !closed.has(e.id)),
    tabs: eligible,
    mappings: before,
    pendingEntries: pendingIds,
    newId,
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
    for (const k of keys) if (orphan(k) || stays(k)) detached[k] = op.url;
  }
  pending = append(pending, open, now, { baseRevision });

  // Mapped copies whose entry URL differs from what this device last agreed with the server.
  const create = [...p.create];
  const navigateTo = new Map<number, string>();
  for (const entry of entries ?? []) {
    const copies = tabsForEntry(mappings, entry.id);
    const m = mappings.tabs[String(copies[0])];
    if (!m || entry.url === m.url || entry.url === serverUrl(m)) continue;
    if (pendingChanges(pending, entry.id).length === 0) {
      for (const id of copies) navigateTo.set(id, entry.url);
      mappings = remapEntry(mappings, entry.id, entry.id, entry.url);
      continue;
    }
    const base = pendingBase(pending, entry.id);
    if (base === undefined || base === entry.url) continue; // our own unsent change: the flush applies it
    const f = forkEntry(mappings, pending, entry.id, newId, now, baseRevision);
    if (!f) continue;
    ({ mappings, pending } = f);
    const local = eligible.find((t) => t.url === entry.url && !mappings.tabs[String(t.id)]);
    if (local) mappings = setMapping(mappings, local.id, entry.id, entry.url);
    else create.push({ entryId: entry.id, url: entry.url, pinned: entry.pinned });
  }

  const until = expiry(store);
  await store.set({
    mappings,
    detached,
    pending,
    expected: expectLoads(store.s.expected, navigateTo.keys(), nowMs(store.deps), until),
  });
  for (const [id, url] of navigateTo) await store.deps.adapter.updateTab(id, { url }).catch(() => undefined);
  const { failed } = await createTabs(store, create);
  return { open, failed };
}
