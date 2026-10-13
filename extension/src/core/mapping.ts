import type { TabInfo } from "../adapter/types.js";

/** A local tab bound to a shared entry. `url` is the URL the tab had when it was mapped. */
export interface MappedTab {
  entryId: string;
  url: string;
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
 * Drop mappings for tabs that no longer exist. A tab whose URL changed keeps its mapping:
 * navigation is propagated in v0.2, not by re-opening. Mappings are cleared on browser
 * startup because tab ids are only stable within one browser session.
 */
export function reconcileMappings(m: Mappings, allTabs: TabInfo[]): Mappings {
  const present = new Set(allTabs.map((t) => String(t.id)));
  const tabs: Record<string, MappedTab> = {};
  for (const [k, v] of Object.entries(m.tabs)) if (present.has(k)) tabs[k] = v;
  return { ...m, tabs };
}
