import type { Owner } from "./client.js";
import { isLocked, isPaired, type State } from "./state.js";

/** Messages from the popup to the service worker. */
export type Request =
  | { type: "getStatus"; refresh?: boolean }
  /** Pair using the form the popup saved as `pendingPair` (see State). */
  | { type: "pair" }
  | { type: "handOver" }
  | { type: "continueHere" }
  /** Run the owner or follower sync now. */
  | { type: "syncNow" }
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
  lastSync: string | null;
  pendingCount: number;
  lastError: string | null;
  statusText: string | null;
  running: boolean;
  /** False when the last status refresh could not reach the server. Not persisted. */
  reachable?: boolean;
}

export type Response =
  | { ok: true; status: StatusView; pairingCode?: { code: string; expiresAt: string } }
  | { ok: false; error: string; status?: StatusView };

export function statusView(s: State, now = Date.now()): StatusView {
  return {
    paired: isPaired(s),
    serverUrl: s.serverUrl,
    deviceName: s.deviceName,
    deviceId: s.deviceId,
    owner: s.owner,
    isOwner: s.generation !== null,
    generation: s.generation,
    lastRevision: s.lastRevision,
    lastSync: s.lastSync,
    pendingCount: s.pending.length,
    lastError: s.lastError,
    statusText: s.statusText,
    running: isLocked(s, now),
  };
}
