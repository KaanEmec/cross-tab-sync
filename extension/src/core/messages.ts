import type { Device, Owner, Snapshot } from "./client.js";
import type { ActivityKind } from "./activity.js";
import { isLocked, isPaired, type ErrorKind, type State } from "./state.js";
import { syncSummary } from "./status.js";

/** Messages from the popup to the service worker. */
export type Request =
  | { type: "getStatus"; refresh?: boolean }
  /** Pair using the form the popup saved as `pendingPair` (see State). */
  | { type: "pair" }
  | { type: "handOver" }
  | { type: "continueHere" }
  /** Run the owner or follower sync now (also the manual retry). */
  | { type: "syncNow" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "listSnapshots" }
  | { type: "restoreSnapshot"; id: number }
  | { type: "listDevices" }
  | { type: "revokeDevice"; id: string }
  | { type: "createPairingCode" }
  | { type: "disconnect" };

export interface StatusView {
  paired: boolean;
  serverUrl: string;
  deviceName: string;
  deviceId: string | null;
  owner: Owner | null;
  isOwner: boolean;
  generation: number | null;
  lastRevision: number;
  minRevision: number | null;
  lastSuccessAt: string | null;
  pendingCount: number;
  online: boolean;
  nextRetryAt: number | null;
  paused: boolean;
  /** "Saved to server", "3 changes waiting (offline, retrying at 10:05)", … (status.syncSummary). */
  summary: string;
  lastError: string | null;
  errorKind: ErrorKind | null;
  statusText: string | null;
  running: boolean;
  /** Last activity signal (diagnostics). */
  lastActivityAt: number | null;
  lastActivityKind: ActivityKind | null;
  /** False when the last status refresh could not reach the server. Not persisted. */
  reachable?: boolean;
}

export type Response =
  | {
      ok: true;
      status: StatusView;
      pairingCode?: { code: string; expiresAt: string };
      snapshots?: Snapshot[];
      devices?: Device[];
    }
  | { ok: false; error: string; status?: StatusView };

export function statusView(s: State, now = Date.now()): StatusView {
  const pendingCount = s.pending.length;
  return {
    paired: isPaired(s),
    serverUrl: s.serverUrl,
    deviceName: s.deviceName,
    deviceId: s.deviceId,
    owner: s.owner,
    isOwner: s.generation !== null,
    generation: s.generation,
    lastRevision: s.lastRevision,
    minRevision: s.minRevision,
    lastSuccessAt: s.lastSuccessAt,
    pendingCount,
    online: s.online,
    nextRetryAt: s.nextRetryAt,
    paused: s.paused,
    summary: syncSummary({ ...s, pendingCount }),
    lastError: s.lastError,
    errorKind: s.errorKind,
    statusText: s.statusText,
    running: isLocked(s, now),
    lastActivityAt: s.lastActivityAt,
    lastActivityKind: s.lastActivityKind,
  };
}
