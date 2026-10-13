// Recording local tab changes (PROTOCOL.md "Recording local changes"). Pure: every function takes
// the persisted slice plus one browser event and returns the changed fields, the operations it
// journaled, and whether the event counts as local activity.

import type { Operation } from "./client.js";
import { append, type Journal } from "./journal.js";
import { removeMappings, setMapping, tabsForEntry, type MappedTab, type Mappings } from "./mapping.js";

/** How long an expectation (echo suppression) waits for its event. */
export const EXPECT_TTL_MS = 30_000;
/** Removals right after browser startup are restore/shutdown noise: unmap only. */
export const STARTUP_GRACE_MS = 10_000;
/** Mappings from the previous browser session that found no tab by then are forgotten. */
export const STALE_MAPPINGS_TTL_MS = 60_000;

export type Expectation =
  /** About to create a tab for `entryId` (tab id not known yet). */
  | { kind: "create"; url: string; entryId: string; until: number }
  /** The extension created or navigated this tab: URL changes until the load completes are ours. */
  | { kind: "load"; tabId: number; until: number }
  /** The extension is removing this tab. */
  | { kind: "remove"; tabId: number; until: number };

export interface LocalState {
  mappings: Mappings;
  staleMappings: Mappings | null;
  pending: Journal;
  expected: Expectation[];
  detached: Record<string, string>;
  startupAt: number | null;
}

/** A tab as seen in an event. `eligible`: shareable URL in a normal, non-private window. */
export interface TabEvent {
  id: number;
  url?: string;
  pinned: boolean;
  active: boolean;
  eligible: boolean;
}

export interface Ctx {
  now: number;
  newId: () => string;
}

export interface Outcome {
  /** Changed fields only; empty when nothing changed. */
  patch: Partial<LocalState>;
  /** Operations appended to the journal. */
  ops: Operation[];
  /** The event is a local activity signal (not caused by the extension). */
  activity: boolean;
}

export function inStartupGrace(startupAt: number | null, now: number, windowMs = STARTUP_GRACE_MS): boolean {
  return startupAt !== null && now >= startupAt && now - startupAt < windowMs;
}

export function pruneExpected(expected: Expectation[], now: number): Expectation[] {
  const kept = expected.filter((e) => e.until > now);
  return kept.length === expected.length ? expected : kept;
}

class Draft {
  private readonly changed = new Set<keyof LocalState>();
  readonly ops: Operation[] = [];

  constructor(
    public s: LocalState,
    readonly ctx: Ctx,
  ) {
    const expected = pruneExpected(s.expected, ctx.now);
    if (expected !== s.expected) this.set("expected", expected);
    if (s.staleMappings && !inStartupGrace(s.startupAt, ctx.now, STALE_MAPPINGS_TTL_MS)) this.set("staleMappings", null);
    const staleDetached = Object.keys(s.detached).filter((k) => k.startsWith("stale-"));
    if (staleDetached.length > 0 && !inStartupGrace(s.startupAt, ctx.now, STALE_MAPPINGS_TTL_MS)) {
      const detached = { ...s.detached };
      for (const k of staleDetached) delete detached[k];
      this.set("detached", detached);
    }
  }

  set<K extends keyof LocalState>(key: K, value: LocalState[K]): void {
    this.s = { ...this.s, [key]: value };
    this.changed.add(key);
  }

  map(tabId: number, entryId: string, url: string): void {
    this.set("mappings", setMapping(this.s.mappings, tabId, entryId, url));
  }

  unmap(tabId: number): void {
    this.set("mappings", removeMappings(this.s.mappings, [tabId]));
  }

  undetach(key: string): void {
    if (this.s.detached[key] === undefined) return;
    const detached = { ...this.s.detached };
    delete detached[key];
    this.set("detached", detached);
  }

  /** Remove and return the first expectation matching `pred`. */
  take(pred: (e: Expectation) => boolean): Expectation | undefined {
    const i = this.s.expected.findIndex(pred);
    if (i < 0) return undefined;
    const e = this.s.expected[i];
    this.set("expected", this.s.expected.filter((_, j) => j !== i));
    return e;
  }

  expect(e: Expectation): void {
    this.set("expected", [...this.s.expected, e]);
  }

  done(activity: boolean): Outcome {
    if (this.ops.length > 0) this.set("pending", append(this.s.pending, this.ops, new Date(this.ctx.now)));
    const patch: Partial<LocalState> = {};
    for (const k of this.changed) (patch as Record<string, unknown>)[k] = this.s[k];
    return { patch, ops: this.ops, activity };
  }
}

function mappedTabWithUrl(m: Mappings, url: string, exceptTabId?: number): MappedTab | undefined {
  for (const [k, v] of Object.entries(m.tabs)) if (v.url === url && Number(k) !== exceptTabId) return v;
  return undefined;
}

/** A create the extension itself started for this URL (only matters if the worker died mid-create). */
function takeCreate(d: Draft, tab: TabEvent & { url: string }): boolean {
  const exp = d.take((e) => e.kind === "create" && e.url === tab.url);
  if (!exp || exp.kind !== "create") return false;
  d.map(tab.id, exp.entryId, tab.url);
  d.expect({ kind: "load", tabId: tab.id, until: d.ctx.now + EXPECT_TTL_MS });
  return true;
}

/**
 * A tab with a new eligible URL that is not mapped: re-match a restored tab from the previous
 * browser session, join an entry already mapped locally (another copy, no operation), or `open`.
 */
function addition(d: Draft, tab: TabEvent & { url: string }): void {
  const stale = d.s.staleMappings;
  const old = stale && Object.entries(stale.tabs).find(([, v]) => v.url === tab.url);
  if (stale && old) {
    const tabs = { ...stale.tabs };
    delete tabs[old[0]];
    d.set("staleMappings", Object.keys(tabs).length > 0 ? { ...stale, tabs } : null);
    d.map(tab.id, old[1].entryId, tab.url);
    return;
  }
  const staleDetached = Object.entries(d.s.detached).find(([k, url]) => k.startsWith("stale-") && url === tab.url);
  if (staleDetached) {
    const detached = { ...d.s.detached, [String(tab.id)]: tab.url };
    delete detached[staleDetached[0]];
    d.set("detached", detached);
    return;
  }
  const existing = mappedTabWithUrl(d.s.mappings, tab.url);
  if (existing) {
    d.map(tab.id, existing.entryId, tab.url);
    return;
  }
  const entryId = d.ctx.newId();
  d.ops.push({ opId: d.ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
  d.map(tab.id, entryId, tab.url);
}

/** `tabs.onCreated`. */
export function recordCreated(s: LocalState, tab: TabEvent, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  // Created by a sync run: the run mapped it before this event was processed.
  if (d.s.mappings.tabs[String(tab.id)]) return d.done(false);
  if (!tab.eligible || !tab.url) return d.done(true); // URL arrives with tabs.onUpdated
  const withUrl = { ...tab, url: tab.url };
  if (takeCreate(d, withUrl)) return d.done(false);
  addition(d, withUrl);
  return d.done(true);
}

/** `tabs.onUpdated` with a committed URL (load complete). */
export function recordUpdated(s: LocalState, tab: TabEvent, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  const key = String(tab.id);
  const mapped = d.s.mappings.tabs[key];

  // Loads started by the extension, including redirects, are not user navigation.
  if (d.take((e) => e.kind === "load" && e.tabId === tab.id)) {
    if (mapped && tab.eligible && tab.url && tab.url !== mapped.url) d.map(tab.id, mapped.entryId, tab.url);
    return d.done(false);
  }
  // Non-shareable destinations (browser pages, bad URLs) keep the mapping and publish nothing.
  if (!tab.eligible || !tab.url) return d.done(false);
  const withUrl = { ...tab, url: tab.url };

  const detachedUrl = d.s.detached[key];
  if (detachedUrl !== undefined) {
    if (detachedUrl === tab.url) return d.done(false);
    d.undetach(key);
    addition(d, withUrl);
    return d.done(tab.active);
  }

  if (!mapped) {
    if (takeCreate(d, withUrl)) return d.done(false);
    addition(d, withUrl);
    return d.done(tab.active);
  }
  if (mapped.url === tab.url) return d.done(false);

  const copies = tabsForEntry(d.s.mappings, mapped.entryId);
  const dest = mappedTabWithUrl(d.s.mappings, tab.url, tab.id);
  if (dest && dest.entryId !== mapped.entryId) {
    // Navigated onto a URL already shared locally: join that entry; close ours if this was its last copy.
    d.map(tab.id, dest.entryId, tab.url);
    if (copies.length === 1) d.ops.push({ opId: ctx.newId(), type: "close", entryId: mapped.entryId });
  } else if (copies.length === 1) {
    d.ops.push({ opId: ctx.newId(), type: "navigate", entryId: mapped.entryId, url: tab.url });
    d.map(tab.id, mapped.entryId, tab.url);
  } else {
    // One of several copies left: it detaches from the entry and is a fresh opening.
    const entryId = ctx.newId();
    d.ops.push({ opId: ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
    d.map(tab.id, entryId, tab.url);
  }
  return d.done(tab.active);
}

/** `tabs.onRemoved`. Only an individual close of the last local copy deletes the shared entry. */
export function recordRemoved(s: LocalState, tabId: number, windowClosing: boolean, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  const ours = d.take((e) => e.kind === "remove" && e.tabId === tabId) !== undefined;
  d.take((e) => e.kind === "load" && e.tabId === tabId);
  d.undetach(String(tabId));
  const mapped = d.s.mappings.tabs[String(tabId)];
  if (!mapped) return d.done(false);
  d.unmap(tabId);
  if (ours || windowClosing || inStartupGrace(d.s.startupAt, ctx.now)) return d.done(false);
  if (tabsForEntry(d.s.mappings, mapped.entryId).length === 0) {
    d.ops.push({ opId: ctx.newId(), type: "close", entryId: mapped.entryId });
  }
  return d.done(false);
}
