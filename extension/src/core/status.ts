// Offline status and error classes (v1.0): bounded retry backoff, actionable error messages, and
// the popup's one-line summary of where local work stands. Pure.

import { ApiError } from "./client.js";
import type { ErrorKind } from "./state.js";

/** First automatic retry after a failure; doubles per attempt up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 5 * 60_000;

/** Delay before retry number `attempt` (1-based): 30 s, 60 s, 120 s, 240 s, then 5 min. */
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/** Error classes left by a retryable failure (network error, 5xx). */
export function isRetryableKind(kind: ErrorKind | null): boolean {
  return kind === "unreachable" || kind === "server" || kind === "permission";
}

/** Network errors and 5xx are retried with backoff; everything else needs a change first. */
export function isRetryable(e: unknown): boolean {
  return e instanceof ApiError && (e.code === "network_error" || e.status >= 500);
}

/** Error class, or null for errors that are not about reaching the server (e.g. not the owner). */
export function classify(e: unknown, hasPermission: boolean): ErrorKind | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "device_revoked") return "device_revoked";
  if (e.code === "key_mismatch" || e.code === "bad_wire") return "key";
  if (e.code === "unauthorized" && e.status === 401) return "unauthorized";
  if (e.code === "network_error") return hasPermission ? "unreachable" : "permission";
  if (e.status >= 500) return "server";
  return null;
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

/** What to tell the user for an error class. */
export function errorMessage(kind: ErrorKind, serverUrl: string, status = 0): string {
  switch (kind) {
    case "device_revoked":
      return "This device was revoked on the server. Pair it again.";
    case "unauthorized":
      return "The server does not accept this device's credentials. Disconnect, then pair again with a new code.";
    case "permission":
      return `Grant access to ${hostOf(serverUrl)} in the extension's site permissions.`;
    case "unreachable":
      return `Cannot reach ${hostOf(serverUrl)}. Check the connection or the server; changes are kept and retried.`;
    case "server":
      return `The server failed${status ? ` (HTTP ${status})` : ""}. Changes are kept and retried.`;
    case "key":
      return KEY_MISMATCH_MESSAGE;
  }
}

export const KEY_MISMATCH_MESSAGE = "Different encryption key. Disconnect and pair again with an invite link.";

/** Local wall-clock time as HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface SyncFacts {
  paused: boolean;
  online: boolean;
  pendingCount: number;
  nextRetryAt: number | null;
  lastSuccessAt: string | null;
}

/** "Saved to server", "3 changes waiting (offline, retrying at 10:05)", "Paused, 1 change waiting", … */
export function syncSummary(f: SyncFacts): string {
  const n = f.pendingCount;
  const waiting = `${n} change${n === 1 ? "" : "s"} waiting`;
  if (f.paused) return n > 0 ? `Paused, ${waiting}` : "Paused";
  const retry = f.nextRetryAt !== null ? `retrying at ${clock(f.nextRetryAt)}` : null;
  const why = [f.online ? null : "offline", retry].filter(Boolean).join(", ");
  if (n > 0) return why ? `${waiting} (${why})` : waiting;
  if (!f.online) return retry ? `Offline (${retry})` : "Offline";
  return f.lastSuccessAt ? "Saved to server" : "Not synced yet";
}

/** Server acknowledgment is not application on the other browsers. */
export const APPLIED_ELSEWHERE_NOTE =
  "Applied on other devices: unknown. The server confirms receipt, not that other browsers opened the tabs.";

/** Shown next to the snapshot list. */
export const RESTORE_NOTE = "Restore reopens the saved URLs as shared tabs. Unsaved form input and page state cannot be recovered.";
