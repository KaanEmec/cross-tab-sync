import type { TabInfo } from "../adapter/types.js";

/** A local tab bound to a shared entry. `url` is the URL the tab had when it was mapped. */
export interface MappedTab {
  entryId: string;
  url: string;
  /** The entry's URL on the server, when the tab shows another one (a redirect the extension caused). */
  base?: string;
}

/** The entry URL this device last agreed on with the server for a mapped tab. */
export function serverUrl(m: MappedTab): string {
  return m.base ?? m.url;
}

export interface Mappings {
  /** Keyed by tab id as a string (storage keys are strings). Several tabs may share one entry. */
  tabs: Record<string, MappedTab>;
  /** Number of local eligible tabs per URL at the last run. Local duplicates are preserved. */
  urlCounts: Record<string, number>;
}

export function emptyMappings(): Mappings {
  return { tabs: {}, urlCounts: {} };
}

export function countUrls(tabs: { url: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tabs) counts[t.url] = (counts[t.url] ?? 0) + 1;
  return counts;
}

export function entryForTab(m: Mappings, tabId: number): string | undefined {
  return m.tabs[String(tabId)]?.entryId;
}

export function tabsForEntry(m: Mappings, entryId: string): number[] {
  return Object.entries(m.tabs)
    .filter(([, v]) => v.entryId === entryId)
    .map(([k]) => Number(k));
}

export function setMapping(m: Mappings, tabId: number, entryId: string, url: string): Mappings {
  return { ...m, tabs: { ...m.tabs, [String(tabId)]: { entryId, url } } };
}

export function removeMappings(m: Mappings, tabIds: Iterable<number>): Mappings {
  const tabs = { ...m.tabs };
  for (const id of tabIds) delete tabs[String(id)];
  return { ...m, tabs };
}

/** Point every tab mapped to `from` at `to` (server coalesced the entry). */
export function remapEntry(m: Mappings, from: string, to: string, url?: string): Mappings {
  if (from === to && url === undefined) return m;
  const tabs: Record<string, MappedTab> = {};
  for (const [k, v] of Object.entries(m.tabs)) {
    tabs[k] = v.entryId === from ? { entryId: to, url: url ?? v.url } : v;
  }
  return { ...m, tabs };
}

/**
 * Rebuild mappings after a browser restart, when tab ids changed: each stored mapping claims one
 * current eligible tab whose URL equals the mapping's last-known URL (exact match). Mappings
 * without a match are dropped.
 */
export function rematchByUrl(stored: Mappings, tabs: { id: number; url: string }[], base: Mappings = emptyMappings()): Mappings {
  return claimByUrl(stored, tabs, base).mappings;
}

/** Like rematchByUrl, also returning the stored mappings that found no tab (null when none). */
export function claimByUrl(
  stored: Mappings,
  tabs: { id: number; url: string }[],
  base: Mappings = emptyMappings(),
): { mappings: Mappings; rest: Mappings | null } {
  const claimed = new Set(Object.keys(base.tabs).map(Number));
  let m = base;
  const rest: Record<string, MappedTab> = {};
  for (const [key, old] of Object.entries(stored.tabs)) {
    const tab = tabs.find((t) => t.url === old.url && !claimed.has(t.id));
    if (!tab) {
      rest[key] = old;
      continue;
    }
    claimed.add(tab.id);
    m = { ...m, tabs: { ...m.tabs, [String(tab.id)]: old } };
  }
  return { mappings: m, rest: Object.keys(rest).length > 0 ? { ...stored, tabs: rest } : null };
}

/**
 * Drop mappings for tabs that no longer exist. A tab whose URL changed keeps its mapping (its
 * last-known URL is kept current by change recording).
 */
export function reconcileMappings(m: Mappings, allTabs: TabInfo[]): Mappings {
  const present = new Set(allTabs.map((t) => String(t.id)));
  const tabs: Record<string, MappedTab> = {};
  for (const [k, v] of Object.entries(m.tabs)) if (present.has(k)) tabs[k] = v;
  return { ...m, tabs };
}
