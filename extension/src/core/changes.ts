// Recording local tab changes (PROTOCOL.md "Recording local changes"). Pure: every function takes
// the persisted slice plus one browser event and returns the changed fields, the operations it
// journaled, and whether the event counts as local activity (only a user-created tab does here;
// navigation never does, see activity.ts).

import type { Operation } from "./client.js";
import { diag, short } from "./diag.js";
import { append, type Journal } from "./journal.js";
import { removeMappings, serverUrl, setMapping, tabsForEntry, type MappedTab, type Mappings } from "./mapping.js";

/** How long an expectation (echo suppression) waits for its event. */
export const EXPECT_TTL_MS = 30_000;
/**
 * A load the extension started stays "ours" until this long after its first committed event, so
 * post-load URL rewrites (replaceState, hash changes, script redirects) are not published.
 */
export const LOAD_GRACE_MS = 10_000;
/** Closes are held this long: a window closing or browser quitting shows up as a burst first. */
export const CLOSE_HOLD_MS = 2_000;
/**
 * This many removals from one window within CLOSE_HOLD_MS are treated as the window going away,
 * unless they are all copies of one entry (Safari reports a pinned tab once per window).
 */
export const BURST_REMOVALS = 3;
/** Removals right after browser startup are restore/shutdown noise: unmap only. */
export const STARTUP_GRACE_MS = 10_000;
/** Mappings from the previous browser session that found no tab by then are forgotten. */
export const STALE_MAPPINGS_TTL_MS = 60_000;

export type Expectation =
  /** About to create a tab for `entryId` (tab id not known yet). */
  | { kind: "create"; url: string; entryId: string; until: number }
  /**
   * The extension created or navigated this tab: URL changes are ours until `until`, which is cut to
   * LOAD_GRACE_MS after the first committed event (`completed`).
   */
  | { kind: "load"; tabId: number; until: number; completed?: boolean; created?: boolean }
  /** The extension is removing this tab. */
  | { kind: "remove"; tabId: number; until: number };

/** A removal of a mapped tab waiting CLOSE_HOLD_MS before it may become a `close`. */
export interface HeldClose {
  entryId: string;
  tabId: number;
  windowId: number;
  at: number;
  /** Already released; kept until 2 x CLOSE_HOLD_MS old to count bursts. */
  done?: boolean;
}

export interface LocalState {
  mappings: Mappings;
  staleMappings: Mappings | null;
  pending: Journal;
  expected: Expectation[];
  detached: Record<string, string>;
  startupAt: number | null;
  heldCloses: HeldClose[];
  /** windows.onRemoved seen recently: window id -> epoch ms. */
  removedWindows: Record<string, number>;
  /** Read only: the causal base recorded with each journaled operation. */
  lastRevision?: number;
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
  /** The event is a local activity signal: a tab the user created with an eligible URL. */
  activity: boolean;
}

export function inStartupGrace(startupAt: number | null, now: number, windowMs = STARTUP_GRACE_MS): boolean {
  return startupAt !== null && now >= startupAt && now - startupAt < windowMs;
}

/** Same scheme, host and port. Unparsable URLs are never the same origin. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function pruneExpected(expected: Expectation[], now: number): Expectation[] {
  const kept = expected.filter((e) => e.until > now);
  return kept.length === expected.length ? expected : kept;
}

/** Announce loads the extension is about to start; each replaces an earlier one for the same tab. */
export function expectLoads(expected: Expectation[], tabIds: Iterable<number>, now: number, until: number): Expectation[] {
  const ids = new Set(tabIds);
  const others = pruneExpected(expected, now).filter((e) => !(e.kind === "load" && ids.has(e.tabId)));
  return [...others, ...[...ids].map((tabId): Expectation => ({ kind: "load", tabId, until }))];
}

class Draft {
  private readonly changed = new Set<keyof LocalState>();
  readonly ops: Operation[] = [];
  /** Server URL before each journaled `navigate`, by opId. */
  readonly bases: Record<string, string> = {};

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
    if (this.ops.length > 0) {
      const meta = { bases: this.bases, baseRevision: this.s.lastRevision ?? 0 };
      this.set("pending", append(this.s.pending, this.ops, new Date(this.ctx.now), meta));
    }
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
 * Returns whether it was a restored tab.
 */
function addition(d: Draft, tab: TabEvent & { url: string }): boolean {
  const stale = d.s.staleMappings;
  const old = stale && Object.entries(stale.tabs).find(([, v]) => v.url === tab.url);
  if (stale && old) {
    const tabs = { ...stale.tabs };
    delete tabs[old[0]];
    d.set("staleMappings", Object.keys(tabs).length > 0 ? { ...stale, tabs } : null);
    d.map(tab.id, old[1].entryId, tab.url);
    return true;
  }
  const staleDetached = Object.entries(d.s.detached).find(([k, url]) => k.startsWith("stale-") && url === tab.url);
  if (staleDetached) {
    const detached = { ...d.s.detached, [String(tab.id)]: tab.url };
    delete detached[staleDetached[0]];
    d.set("detached", detached);
    return true;
  }
  const existing = mappedTabWithUrl(d.s.mappings, tab.url);
  if (existing) {
    d.map(tab.id, existing.entryId, tab.url);
    return false;
  }
  const entryId = d.ctx.newId();
  d.ops.push({ opId: d.ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
  d.map(tab.id, entryId, tab.url);
  return false;
}

/** The extension asked the browser to remove this tab; it may still report events meanwhile. */
function removing(d: Draft, tabId: number): boolean {
  return d.s.expected.some((e) => e.kind === "remove" && e.tabId === tabId);
}

/**
 * `tabs.onCreated`. Activity only for a tab the user created with an eligible URL: not one the
 * extension created, not a restored tab, not a blank or browser page (new tab page, extension page).
 */
export function recordCreated(s: LocalState, tab: TabEvent, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  // Created by a sync run: the run mapped it before this event was processed.
  if (d.s.mappings.tabs[String(tab.id)] || removing(d, tab.id)) return d.done(false);
  if (!tab.eligible || !tab.url) return d.done(false); // URL arrives with tabs.onUpdated
  const withUrl = { ...tab, url: tab.url };
  if (takeCreate(d, withUrl)) return d.done(false);
  return d.done(!addition(d, withUrl));
}

/**
 * `tabs.onUpdated` with a committed URL (load complete). Never activity: restored tabs finish
 * loading long after startup, and pages rewrite their own URLs.
 */
export function recordUpdated(s: LocalState, tab: TabEvent, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  const key = String(tab.id);
  const mapped = d.s.mappings.tabs[key];
  // Being removed by the extension (removal is asynchronous): never an addition or navigation.
  if (removing(d, tab.id)) return d.done(false);

  // Loads started by the extension, including redirects and post-load URL rewrites, are not user
  // navigation. The expectation only expires by time.
  const load = d.s.expected.find((e) => e.kind === "load" && e.tabId === tab.id);
  if (load) {
    if (load.kind === "load" && !load.completed) {
      const settled: Expectation = { ...load, completed: true, until: ctx.now + LOAD_GRACE_MS };
      d.set("expected", d.s.expected.map((e) => (e === load ? settled : e)));
    }
    if (mapped && tab.eligible && tab.url && tab.url !== mapped.url) {
      const base = serverUrl(mapped);
      const tabs = { ...d.s.mappings.tabs, [key]: tab.url === base ? { entryId: mapped.entryId, url: base } : { entryId: mapped.entryId, url: tab.url, base } };
      d.set("mappings", { ...d.s.mappings, tabs });
    }
    return d.done(false);
  }
  // Non-shareable destinations (browser pages, bad URLs) keep the mapping and publish nothing.
  if (!tab.eligible || !tab.url) return d.done(false);
  const withUrl = { ...tab, url: tab.url };

  // A detached tab stays local until it moves to a different site (feeds rewrite their URL constantly).
  const detachedUrl = d.s.detached[key];
  if (detachedUrl !== undefined) {
    if (sameOrigin(detachedUrl, tab.url)) {
      if (detachedUrl !== tab.url) d.set("detached", { ...d.s.detached, [key]: tab.url });
      return d.done(false);
    }
    d.undetach(key);
    addition(d, withUrl);
    return d.done(false);
  }

  if (!mapped) {
    if (!takeCreate(d, withUrl)) addition(d, withUrl);
    return d.done(false);
  }
  if (mapped.url === tab.url) return d.done(false);

  const copies = tabsForEntry(d.s.mappings, mapped.entryId);
  const dest = mappedTabWithUrl(d.s.mappings, tab.url, tab.id);
  if (dest && dest.entryId !== mapped.entryId) {
    // Navigated onto a URL already shared locally: join that entry; close ours if this was its last copy.
    d.map(tab.id, dest.entryId, tab.url);
    if (copies.length === 1) d.ops.push({ opId: ctx.newId(), type: "close", entryId: mapped.entryId });
  } else if (copies.length === 1) {
    const opId = ctx.newId();
    d.ops.push({ opId, type: "navigate", entryId: mapped.entryId, url: tab.url });
    d.bases[opId] = serverUrl(mapped);
    d.map(tab.id, mapped.entryId, tab.url);
  } else {
    // One of several copies left: it detaches from the entry and is a fresh opening.
    const entryId = ctx.newId();
    d.ops.push({ opId: ctx.newId(), type: "open", entryId, url: tab.url, pinned: tab.pinned });
    d.map(tab.id, entryId, tab.url);
  }
  return d.done(false);
}

/**
 * `tabs.onRemoved`. Only an individual close of the last local copy deletes the shared entry, and
 * only after CLOSE_HOLD_MS (see releaseHeld): `isWindowClosing` is a hint, not proof.
 */
export function recordRemoved(s: LocalState, tabId: number, windowClosing: boolean, windowId: number, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  const ours = d.take((e) => e.kind === "remove" && e.tabId === tabId) !== undefined;
  d.take((e) => e.kind === "load" && e.tabId === tabId);
  d.undetach(String(tabId));
  const mapped = d.s.mappings.tabs[String(tabId)];
  if (!mapped) return d.done(false);
  d.unmap(tabId);
  if (ours || windowClosing || inStartupGrace(d.s.startupAt, ctx.now)) return d.done(false);
  const recent = d.s.heldCloses.filter((h) => !h.done || ctx.now - h.at < 2 * CLOSE_HOLD_MS);
  d.set("heldCloses", [...recent, { entryId: mapped.entryId, tabId, windowId, at: ctx.now }]);
  diag(`held close created entry=${short(mapped.entryId)} tab=${tabId} win=${windowId}`);
  return d.done(false);
}

/** `windows.onRemoved`: held closes from this window are dropped at release. */
export function recordWindowRemoved(s: LocalState, windowId: number, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  d.set("removedWindows", { ...d.s.removedWindows, [String(windowId)]: ctx.now });
  return d.done(false);
}

/**
 * Turn held removals older than CLOSE_HOLD_MS into `close` operations, one per entry that still has
 * no local copy. Dropped (unmap only): the tab's window no longer exists or was reported removed,
 * or BURST_REMOVALS or more removals came from that window within CLOSE_HOLD_MS. A burst made only
 * of copies of one entry is one closure (Safari reports a pinned tab once per window).
 */
export function releaseHeld(s: LocalState, aliveWindows: Set<number>, ctx: Ctx): Outcome & { waiting: boolean } {
  const d = new Draft(s, ctx);
  const held = d.s.heldCloses;
  const due = held.filter((h) => !h.done && ctx.now - h.at >= CLOSE_HOLD_MS);
  const waiting = held.some((h) => !h.done && ctx.now - h.at < CLOSE_HOLD_MS);
  const kept = held
    .filter((h) => ctx.now - h.at < 2 * CLOSE_HOLD_MS || (!h.done && !due.includes(h)))
    .map((h) => (due.includes(h) ? { ...h, done: true } : h));
  if (due.length > 0 || kept.length !== held.length) d.set("heldCloses", kept);
  const closed = new Set<string>();
  for (const h of due) {
    const burst = held.filter((o) => o.windowId === h.windowId && Math.abs(o.at - h.at) < CLOSE_HOLD_MS);
    const windowClosing = burst.length >= BURST_REMOVALS && burst.some((o) => o.entryId !== h.entryId);
    const windowGone = !aliveWindows.has(h.windowId) || d.s.removedWindows[String(h.windowId)] !== undefined;
    const dropped = windowGone
      ? "window gone"
      : windowClosing
        ? `burst of ${burst.length} removals`
        : closed.has(h.entryId)
          ? "entry already closed in this release"
          : tabsForEntry(d.s.mappings, h.entryId).length > 0
            ? "entry still has a local copy"
            : null;
    if (dropped) {
      diag(`held close dropped entry=${short(h.entryId)} tab=${h.tabId}: ${dropped}`);
      continue;
    }
    diag(`held close released entry=${short(h.entryId)} tab=${h.tabId}`);
    closed.add(h.entryId);
    d.ops.push({ opId: ctx.newId(), type: "close", entryId: h.entryId });
  }
  const recent = Object.entries(d.s.removedWindows).filter(([, at]) => ctx.now - at < EXPECT_TTL_MS);
  if (recent.length !== Object.keys(d.s.removedWindows).length) d.set("removedWindows", Object.fromEntries(recent));
  return { ...d.done(false), waiting };
}
