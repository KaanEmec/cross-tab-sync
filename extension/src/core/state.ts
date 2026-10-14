import type { KeyValueStorage } from "../adapter/types.js";
import type { ActivityKind } from "./activity.js";
import type { Owner } from "./client.js";
import type { Expectation, HeldClose } from "./changes.js";
import type { Journal } from "./journal.js";
import { emptyMappings, type Mappings } from "./mapping.js";

/** Everything the extension remembers. Each field is its own storage key so partial saves never clobber. */
export interface State {
  serverUrl: string;
  deviceName: string;
  deviceId: string | null;
  token: string | null;
  /** Last session revision this device applied. */
  lastRevision: number;
  /** Ownership generation while this device is the owner, otherwise null. */
  generation: number | null;
  /** Last owner reported by the server (may be another device). */
  owner: Owner | null;
  mappings: Mappings;
  /**
   * Mappings from the previous browser session (tab ids changed at startup). Re-matched to current
   * tabs by last-known URL at the next action, when restored tabs have loaded.
   */
  staleMappings: Mappings | null;
  pending: Journal;
  /** ISO timestamp of the last successful exchange with the server. */
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Class of the last error, for actionable status (null after a success). */
  errorKind: ErrorKind | null;
  /** Human-readable outcome of the last action, e.g. "Handed over at revision 12". */
  statusText: string | null;
  /** Normal window that receives tabs created by Continue here. */
  receivingWindowId: number | null;
  /**
   * Pairing form saved by the popup before it asks for host permission. In Chromium the
   * permission prompt can close the popup, so the worker finishes pairing from this record
   * (permissions.onAdded) as well as from the popup's own message, whichever comes first.
   */
  pendingPair: PendingPair | null;
  /** Persisted run flag so two sync runs never overlap, even across service worker restarts. */
  runLock: { action: string; startedAt: number } | null;

  // v0.2 automatic sync (PROTOCOL.md "Client behavior (v0.2 automatic sync)").
  /** Echo suppression: what the extension is about to create, navigate, or remove. */
  expected: Expectation[];
  /**
   * Tabs left open (they were active) when a remote `close` removed their entry, keyed by tab id
   * (`stale-N` after a browser restart), value = the URL they showed. Not republished until they
   * navigate or close.
   */
  detached: Record<string, string>;
  /** Epoch ms of the last browser startup (startup grace for removals and activity). */
  startupAt: number | null;
  /** Epoch ms of the last activity signal (stored with a few seconds of granularity). */
  lastActivityAt: number | null;
  /** Kind of the signal behind `lastActivityAt` (null: Hand over, or none yet). Diagnostics only. */
  lastActivityKind: ActivityKind | null;
  /** Epoch ms of the last takeover attempt (rate limit). */
  lastTakeoverAt: number | null;
  /** Set by manual Hand over; cleared by the next fresh interaction. */
  suppressAutoTakeover: boolean;
  /** The next activity signal counts as fresh (ownership was lost, or a takeover was deferred). */
  freshPending: boolean;
  /** Removals of mapped tabs waiting CLOSE_HOLD_MS before they may become `close` operations. */
  heldCloses: HeldClose[];
  /** Recently removed windows (windows.onRemoved), window id -> epoch ms. */
  removedWindows: Record<string, number>;

  // v1.0 offline work, status and controls.
  /** False after a network error or 5xx until the next successful exchange. */
  online: boolean;
  /** `pending.length`, written with every journal change (saveState) for status readers. */
  pendingCount: number;
  /** Epoch ms of the next automatic retry after a failure (bounded exponential backoff). */
  nextRetryAt: number | null;
  /** Consecutive failed attempts behind `nextRetryAt`. */
  retryAttempts: number;
  /** No runs and no automatic takeover; local changes are still journaled. */
  paused: boolean;
  /** Oldest revision the server still has history for (from `GET session` / `changes`). */
  minRevision: number | null;
}

/** Error classes the popup explains with an action (see status.ts). */
export type ErrorKind = "unauthorized" | "device_revoked" | "permission" | "unreachable" | "server";

export interface PendingPair {
  serverUrl: string;
  deviceName: string;
  code: string;
  createdAt: number;
}

/** Pairing codes are valid 10 minutes; an older saved form is useless. */
export const PENDING_PAIR_TTL_MS = 10 * 60 * 1000;

export function defaultState(): State {
  return {
    serverUrl: "",
    deviceName: "",
    deviceId: null,
    token: null,
    lastRevision: 0,
    generation: null,
    owner: null,
    mappings: emptyMappings(),
    staleMappings: null,
    pending: [],
    lastSuccessAt: null,
    lastError: null,
    statusText: null,
    receivingWindowId: null,
    pendingPair: null,
    runLock: null,
    expected: [],
    detached: {},
    startupAt: null,
    lastActivityAt: null,
    lastActivityKind: null,
    lastTakeoverAt: null,
    suppressAutoTakeover: false,
    freshPending: false,
    heldCloses: [],
    removedWindows: {},
    errorKind: null,
    online: true,
    pendingCount: 0,
    nextRetryAt: null,
    retryAttempts: 0,
    paused: false,
    minRevision: null,
  };
}

const PREFIX = "cts.";
const KEYS = Object.keys(defaultState()) as (keyof State)[];

export async function loadState(storage: KeyValueStorage): Promise<State> {
  const raw = await storage.get(KEYS.map((k) => PREFIX + k));
  const state = defaultState() as unknown as Record<string, unknown>;
  for (const k of KEYS) {
    const v = raw[PREFIX + k];
    if (v !== undefined) state[k] = v;
  }
  return state as unknown as State;
}

export async function saveState(storage: KeyValueStorage, patch: Partial<State>): Promise<void> {
  const items: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) items[PREFIX + k] = v;
  }
  if (patch.pending) items[PREFIX + "pendingCount"] = patch.pending.length;
  if (Object.keys(items).length > 0) await storage.set(items);
}

export function isPaired(s: State): boolean {
  return Boolean(s.token && s.deviceId && s.serverUrl);
}

/** Fields reset when credentials are dropped (disconnect or `401 device_revoked`). */
export function clearedCredentials(): Partial<State> {
  return {
    deviceId: null,
    token: null,
    lastRevision: 0,
    generation: null,
    owner: null,
    mappings: emptyMappings(),
    staleMappings: null,
    pending: [],
    expected: [],
    detached: {},
    lastTakeoverAt: null,
    suppressAutoTakeover: false,
    freshPending: false,
    heldCloses: [],
    removedWindows: {},
    online: true,
    nextRetryAt: null,
    retryAttempts: 0,
    paused: false,
    minRevision: null,
    errorKind: null,
  };
}

/** A run lock older than this is considered abandoned (the worker was killed mid-run). */
export const RUN_LOCK_TTL_MS = 2 * 60 * 1000;

export function isLocked(s: State, now: number): boolean {
  return s.runLock !== null && now - s.runLock.startedAt < RUN_LOCK_TTL_MS;
}
