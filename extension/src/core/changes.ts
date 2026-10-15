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
/**
 * Closes are held this long after the last removal from the same window: a window closing or
 * browser quitting reports its tabs as removals (on Windows one by one over many seconds) before
 * the window is gone or `windows.onRemoved` arrives.
 */
export const CLOSE_HOLD_MS = 2_000;
/** A window's held closes are released at the latest this long after its first removal. */
export const CLOSE_HOLD_MAX_MS = 15_000;
/**
 * A local navigation is held this long after the tab's last URL change before it becomes one
 * `navigate` (live pages rewrite their URL every few seconds)...
 */
export const NAVIGATE_SETTLE_MS = 5_000;
/** ...but at most this long after the first change of the hold. */
export const NAVIGATE_MAX_HOLD_MS = 30_000;
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
  /** Legacy: released holds were kept to count removal bursts. Such entries are dropped unused. */
  done?: boolean;
}

/**
 * A navigation of a single-copy mapped tab waiting to settle (NAVIGATE_SETTLE_MS). The tab's mapping
 * carries the latest URL, with `base` = the entry's server URL; at release it becomes one
 * `navigate` if the two still differ.
 */
export interface HeldNavigate {
  tabId: number;
  entryId: string;
  /** First URL change of this hold (NAVIGATE_MAX_HOLD_MS cap). */
  firstAt: number;
  /** Latest URL change. */
  at: number;
}

export interface LocalState {
  mappings: Mappings;
  staleMappings: Mappings | null;
  pending: Journal;
  expected: Expectation[];
  detached: Record<string, string>;
  startupAt: number | null;
  heldCloses: HeldClose[];
  heldNavigates: HeldNavigate[];
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
 * Hold a navigation of a single-copy tab: the mapping follows the tab (the entry's server URL kept
 * as `base`), and the hold is extended up to NAVIGATE_MAX_HOLD_MS from its first change.
 */
function holdNavigate(d: Draft, tabId: number, mapped: MappedTab, url: string): void {
  const base = serverUrl(mapped);
  const tabs = { ...d.s.mappings.tabs, [String(tabId)]: url === base ? { entryId: mapped.entryId, url } : { entryId: mapped.entryId, url, base } };
  d.set("mappings", { ...d.s.mappings, tabs });
  const prev = d.s.heldNavigates.find((h) => h.tabId === tabId && h.entryId === mapped.entryId);
  const held: HeldNavigate = { tabId, entryId: mapped.entryId, firstAt: prev?.firstAt ?? d.ctx.now, at: d.ctx.now };
  d.set("heldNavigates", [...d.s.heldNavigates.filter((h) => h.tabId !== tabId), held]);
  diag(`held navigate ${prev ? "extended" : "created"} entry=${short(mapped.entryId)} tab=${tabId}${url === base ? " (back at entry URL)" : ""}`);
}

function dropHeldNavigate(d: Draft, tabId: number, reason: string): void {
  const held = d.s.heldNavigates.find((h) => h.tabId === tabId);
  if (!held) return;
  d.set("heldNavigates", d.s.heldNavigates.filter((h) => h !== held));
  diag(`held navigate dropped entry=${short(held.entryId)} tab=${tabId}: ${reason}`);
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
    dropHeldNavigate(d, tab.id, "joined another entry");
    d.map(tab.id, dest.entryId, tab.url);
    if (copies.length === 1) d.ops.push({ opId: ctx.newId(), type: "close", entryId: mapped.entryId });
  } else if (copies.length === 1) {
    holdNavigate(d, tab.id, mapped, tab.url);
  } else {
    // One of several copies left: it detaches from the entry and is a fresh opening.
    dropHeldNavigate(d, tab.id, "detached from its entry");
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
  dropHeldNavigate(d, tabId, "tab removed");
  const mapped = d.s.mappings.tabs[String(tabId)];
  if (!mapped) return d.done(false);
  d.unmap(tabId);
  if (ours || windowClosing || inStartupGrace(d.s.startupAt, ctx.now)) return d.done(false);
  const holding = d.s.heldCloses.filter((h) => !h.done);
  d.set("heldCloses", [...holding, { entryId: mapped.entryId, tabId, windowId, at: ctx.now }]);
  diag(`held close created entry=${short(mapped.entryId)} tab=${tabId} win=${windowId}`);
  return d.done(false);
}

/** `windows.onRemoved`: held closes from this window are dropped at release. */
export function recordWindowRemoved(s: LocalState, windowId: number, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  d.set("removedWindows", { ...d.s.removedWindows, [String(windowId)]: ctx.now });
  return d.done(false);
}

/** When a held navigation is due: settled, or held for NAVIGATE_MAX_HOLD_MS. */
function navigateDue(h: HeldNavigate): number {
  return Math.min(h.at + NAVIGATE_SETTLE_MS, h.firstAt + NAVIGATE_MAX_HOLD_MS);
}

/** Held closes by window, in arrival order. Legacy `done` entries are left out. */
function byWindow(held: HeldClose[]): Map<number, HeldClose[]> {
  const groups = new Map<number, HeldClose[]>();
  for (const h of held) if (!h.done) groups.set(h.windowId, [...(groups.get(h.windowId) ?? []), h]);
  return groups;
}

/** When a window's held closes are due: CLOSE_HOLD_MS after its last removal, capped from its first. */
function closesDue(group: HeldClose[]): number {
  const ats = group.map((h) => h.at);
  return Math.min(Math.max(...ats) + CLOSE_HOLD_MS, Math.min(...ats) + CLOSE_HOLD_MAX_MS);
}

/** Epoch ms when the next held close or navigation is due, or null when nothing is held. */
export function nextRelease(s: Pick<LocalState, "heldCloses" | "heldNavigates">): number | null {
  const due = [...s.heldNavigates.map(navigateDue), ...[...byWindow(s.heldCloses).values()].map(closesDue)];
  return due.length > 0 ? Math.min(...due) : null;
}

/**
 * Turn due held navigations into one `navigate` each, with the tab's latest URL. Dropped: the tab
 * is no longer mapped to the entry (closed, forked, joined another entry) or is back at the entry's
 * server URL.
 */
function releaseNavigates(d: Draft, all = false): void {
  const due = d.s.heldNavigates.filter((h) => all || navigateDue(h) <= d.ctx.now);
  if (due.length === 0) return;
  d.set("heldNavigates", d.s.heldNavigates.filter((h) => !due.includes(h)));
  for (const h of due) {
    const m = d.s.mappings.tabs[String(h.tabId)];
    const dropped = !m || m.entryId !== h.entryId ? "tab no longer mapped to the entry" : m.url === serverUrl(m) ? "back at the entry URL" : null;
    if (dropped) {
      diag(`held navigate dropped entry=${short(h.entryId)} tab=${h.tabId}: ${dropped}`);
      continue;
    }
    const opId = d.ctx.newId();
    d.ops.push({ opId, type: "navigate", entryId: h.entryId, url: m!.url });
    d.bases[opId] = serverUrl(m!);
    d.map(h.tabId, h.entryId, m!.url);
    diag(`held navigate released entry=${short(h.entryId)} tab=${h.tabId} after ${d.ctx.now - h.firstAt}ms`);
  }
}

/** Journal every held navigation now (browser startup: the previous session's tab ids are void). */
export function flushNavigates(s: LocalState, ctx: Ctx): Outcome {
  const d = new Draft(s, ctx);
  releaseNavigates(d, true);
  return d.done(false);
}

/**
 * Release held removals per window once CLOSE_HOLD_MS passed since the window's last removal (or
 * CLOSE_HOLD_MAX_MS since its first): a window torn down tab by tab keeps extending its holds.
 * A released window's removals are all dropped (unmap only) when the window no longer exists, was
 * reported removed, or has no tabs left; when the cap fires while removals are still arriving
 * (mid-teardown), also when it has fewer tabs left than removals. Otherwise each entry that still
 * has no local copy gets one `close` (copies closed together, such as a Safari pinned tab reported
 * once per window, are one closure). `windowTabs`: open window id -> tab count.
 */
function releaseCloses(d: Draft, windowTabs: Map<number, number>): void {
  const groups = [...byWindow(d.s.heldCloses)].filter(([, g]) => closesDue(g) <= d.ctx.now);
  const due = new Set(groups.flatMap(([, g]) => g));
  const kept = d.s.heldCloses.filter((h) => !h.done && !due.has(h));
  if (kept.length !== d.s.heldCloses.length) d.set("heldCloses", kept);
  const closed = new Set<string>();
  for (const [windowId, group] of groups) {
    const left = windowTabs.get(windowId);
    const arriving = d.ctx.now < Math.max(...group.map((h) => h.at)) + CLOSE_HOLD_MS;
    const gone =
      left === undefined || d.s.removedWindows[String(windowId)] !== undefined
        ? "window gone"
        : left === 0
          ? "window emptied"
          : arriving && left < group.length
            ? `mid-teardown at the cap (${left} tab(s) left)`
            : null;
    if (gone) {
      diag(`held closes dropped win=${windowId} count=${group.length}: ${gone}`);
      continue;
    }
    for (const h of group) {
      const dropped = closed.has(h.entryId)
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
      d.ops.push({ opId: d.ctx.newId(), type: "close", entryId: h.entryId });
    }
  }
}

/**
 * Release due held navigations, then due held closes (releaseNavigates, releaseCloses). `waiting`:
 * something is still held (see nextRelease). Rapid individual closes are ordinary user behavior and
 * are never dropped as a group while their window keeps enough tabs.
 */
export function releaseHeld(s: LocalState, windowTabs: Map<number, number>, ctx: Ctx): Outcome & { waiting: boolean } {
  const d = new Draft(s, ctx);
  releaseNavigates(d);
  releaseCloses(d, windowTabs);
  const recent = Object.entries(d.s.removedWindows).filter(([, at]) => ctx.now - at < EXPECT_TTL_MS);
  if (recent.length !== Object.keys(d.s.removedWindows).length) d.set("removedWindows", Object.fromEntries(recent));
  return { ...d.done(false), waiting: nextRelease(d.s) !== null };
}
