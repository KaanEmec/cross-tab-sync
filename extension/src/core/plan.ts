import type { Entry, Operation } from "./client.js";
import type { EligibleTab } from "./eligibility.js";
import { countUrls, removeMappings, setMapping, type Mappings } from "./mapping.js";

export type OpenOp = Extract<Operation, { type: "open" }>;

export interface PlanInput {
  /** Session entries when known (Continue here); null when only publishing (Hand over). */
  entries: Entry[] | null;
  /** Local eligible tabs in window/index order. */
  tabs: EligibleTab[];
  /** Mappings already reconciled against the current tab list. */
  mappings: Mappings;
  /** Entry ids with an unacknowledged `open` in the journal. */
  pendingEntries: Set<string>;
  newId: () => string;
}

export interface TabToCreate {
  entryId: string;
  url: string;
  pinned: boolean;
}

export interface Plan {
  /** Mappings including reused tabs and tentative mappings for tabs published by `open`. */
  mappings: Mappings;
  /** Entries without any local tab: create in the background in the receiving window. */
  create: TabToCreate[];
  /** `open` operations for local eligible tabs that are not mapped to any entry. */
  open: OpenOp[];
}

/**
 * Pure planner for both manual actions. Reuse before create: a session entry is satisfied by a
 * tab already mapped to it, otherwise by every unmapped local tab with the exact same URL (local
 * duplicates are kept and all map to the entry). Only entries with no local tab are created.
 * Remaining unmapped tabs are published, one `open` per distinct URL. Never plans closures.
 */
export function plan(input: PlanInput): Plan {
  const { entries, tabs, pendingEntries, newId } = input;
  let mappings = input.mappings;
  const eligibleById = new Map(tabs.map((t) => [t.id, t]));

  if (entries) {
    const byId = new Set(entries.map((e) => e.id));
    const sessionUrls = new Set(entries.map((e) => e.url));
    const drop: number[] = [];
    for (const [key, m] of Object.entries(mappings.tabs)) {
      const tab = eligibleById.get(Number(key));
      if (!tab || byId.has(m.entryId)) continue;
      // Entry is not in the session. Pending opens stay mapped (the op is resent) unless the
      // session already holds the URL, in which case the tab is reused and the op coalesces.
      if (!pendingEntries.has(m.entryId) || sessionUrls.has(tab.url)) drop.push(tab.id);
    }
    mappings = removeMappings(mappings, drop);
  }

  const isMapped = (tabId: number) => mappings.tabs[String(tabId)] !== undefined;
  const create: TabToCreate[] = [];
  const urlToEntry = new Map<string, string>();

  if (entries) {
    const mappedEntries = new Set(Object.values(mappings.tabs).map((m) => m.entryId));
    for (const entry of entries) {
      if (!urlToEntry.has(entry.url)) urlToEntry.set(entry.url, entry.id);
      if (mappedEntries.has(entry.id)) continue;
      const reuse = tabs.filter((t) => t.url === entry.url && !isMapped(t.id));
      if (reuse.length === 0) {
        create.push({ entryId: entry.id, url: entry.url, pinned: entry.pinned });
      } else {
        for (const t of reuse) mappings = setMapping(mappings, t.id, entry.id, entry.url);
      }
      mappedEntries.add(entry.id);
    }
  }

  // Local duplicates of an already mapped tab join its entry instead of publishing a new one.
  for (const m of Object.values(mappings.tabs)) if (!urlToEntry.has(m.url)) urlToEntry.set(m.url, m.entryId);

  const open: OpenOp[] = [];
  tabs.forEach((tab, position) => {
    if (isMapped(tab.id)) return;
    let entryId = urlToEntry.get(tab.url);
    if (!entryId) {
      entryId = newId();
      urlToEntry.set(tab.url, entryId);
      open.push({ opId: newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned, position });
    }
    mappings = setMapping(mappings, tab.id, entryId, tab.url);
  });

  return { mappings: { ...mappings, urlCounts: countUrls(tabs) }, create, open };
}
