// Shared plumbing for the sync orchestration modules: dependencies, write-through state view,
// and error recording.

import type { BrowserAdapter } from "../adapter/types.js";
import { ApiError, originPattern, type ApiClient, type BrowserKind, type Owner } from "./client.js";
import { forgetCiphers } from "./crypto.js";
import { newOpId } from "./journal.js";
import { clearedCredentials, isPaired, loadState, saveState, type State } from "./state.js";
import { classify, errorMessage, isRetryable, KEY_MISMATCH_MESSAGE, retryDelay } from "./status.js";

export type Api = Pick<
  ApiClient,
  | "pair"
  | "createPairingCode"
  | "devices"
  | "renameDevice"
  | "deleteDevice"
  | "session"
  | "sessionKeyCheck"
  | "putKeyCheck"
  | "changes"
  | "acquire"
  | "release"
  | "heartbeat"
  | "operations"
  | "merge"
  | "snapshots"
  | "restoreSnapshot"
  | "postDiag"
>;

export interface Deps {
  adapter: BrowserAdapter;
  /** `key`: the encryption root key; without it only calls that carry no URLs work (pairing). */
  api: (cfg: { baseUrl: string; token: string | null; key?: string | null }) => Api;
  browser: BrowserKind;
  now?: () => Date;
  newId?: () => string;
}

/** Thin mutable view over persisted state: every `set` is written through immediately. */
export class Store {
  constructor(
    readonly deps: Deps,
    public s: State,
  ) {}

  static async open(deps: Deps): Promise<Store> {
    return new Store(deps, await loadState(deps.adapter.storage));
  }

  async set(patch: Partial<State>): Promise<void> {
    this.s = { ...this.s, ...patch };
    await saveState(this.deps.adapter.storage, patch);
  }
}

export const nowDate = (deps: Deps) => (deps.now ? deps.now() : new Date());
export const nowIso = (deps: Deps) => nowDate(deps).toISOString();
export const nowMs = (deps: Deps) => nowDate(deps).getTime();
export const idGen = (deps: Deps) => deps.newId ?? newOpId;

export function apiFor(deps: Deps, s: State): Api {
  return deps.api({ baseUrl: s.serverUrl, token: s.token, key: s.syncKey });
}

export function requirePaired(s: State): void {
  if (!isPaired(s)) throw new Error("This device is not paired");
}

/** Paired with a verified key: nothing is sent or applied otherwise (fail() records kind "key"). */
export function requireKey(s: State): void {
  requirePaired(s);
  if (!s.syncKey || !s.keyVerified) throw new ApiError(0, "key_mismatch", KEY_MISMATCH_MESSAGE);
}

/** Paired, but the key failed: automatic runs and takeovers stop until the browser pairs again. */
export function keyBlocked(s: State): boolean {
  return isPaired(s) && (s.errorKind === "key" || !s.keyVerified);
}

/** Forget credentials, key and derived keys in memory; `patch` is written with them. */
export async function dropCredentials(store: Store, patch: Partial<State>): Promise<void> {
  forgetCiphers();
  await store.set({ ...clearedCredentials(), ...patch });
}

export function ownerLabel(o: Owner | null): string {
  return o ? `${o.name} (generation ${o.generation})` : "another device";
}

export function isStaleOwner(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "stale_owner";
}

/**
 * `409 stale_owner`: drop owner state and keep the journal, but only if the persisted generation
 * is still the one the failed request sent (a late reply must not wipe a newer acquisition).
 * The next activity signal counts as fresh. Returns whether owner state was dropped.
 */
export async function demote(store: Store, e: ApiError, sentGeneration?: number | null): Promise<boolean> {
  const persisted = (await loadState(store.deps.adapter.storage)).generation;
  if (sentGeneration !== undefined && persisted !== sentGeneration) return false;
  const owner = e.owner;
  await store.set({
    generation: null,
    owner,
    freshPending: true,
    statusText: `Not the owner: ${ownerLabel(owner)} took over. Use Continue here to take control.`,
    // Routine in automatic mode: not an error. A manual action that failed reports it itself.
    lastError: null,
  });
  return true;
}

/** Fields after any successful exchange with the server: online, backoff reset. */
export function succeeded(deps: Deps): Partial<State> {
  return { lastSuccessAt: nowIso(deps), online: true, nextRetryAt: null, retryAttempts: 0, errorKind: null };
}

/** Whether the extension may reach the server origin (true where the browser cannot tell). */
async function hasPermission(deps: Deps, serverUrl: string): Promise<boolean> {
  const pattern = originPattern(serverUrl);
  if (!pattern || !deps.adapter.hasHostPermission) return true;
  return deps.adapter.hasHostPermission(pattern).catch(() => true);
}

/**
 * Record an error in state: `stale_owner` demotes, `device_revoked` clears credentials, network
 * errors and 5xx mark the device offline and schedule the next retry with bounded exponential
 * backoff (RETRY_BASE_MS doubling to RETRY_MAX_MS). Always rethrows so the caller can report it.
 */
export async function fail(store: Store, e: unknown, sentGeneration?: number | null): Promise<never> {
  if (isStaleOwner(e)) {
    await demote(store, e, sentGeneration);
    throw e;
  }
  const kind = classify(e, e instanceof ApiError && e.code === "network_error" ? await hasPermission(store.deps, store.s.serverUrl) : true);
  const message = kind ? errorMessage(kind, store.s.serverUrl, e instanceof ApiError ? e.status : 0) : null;
  if (kind === "device_revoked") {
    await dropCredentials(store, { statusText: "Disconnected", lastError: message, errorKind: kind });
  } else if (isRetryable(e)) {
    const retryAttempts = store.s.retryAttempts + 1;
    await store.set({
      online: false,
      retryAttempts,
      nextRetryAt: nowMs(store.deps) + retryDelay(retryAttempts),
      errorKind: kind,
      lastError: message,
    });
  } else if (kind === "key") {
    // Another key, a forged or plaintext URL, or no verified key: nothing was applied, and nothing
    // runs automatically until the browser pairs again.
    await store.set({ online: true, nextRetryAt: null, retryAttempts: 0, errorKind: kind, lastError: message, keyVerified: false });
  } else if (e instanceof ApiError && e.status > 0) {
    // The server answered: reachable, and retrying the same request would fail the same way.
    await store.set({ online: true, nextRetryAt: null, retryAttempts: 0, errorKind: kind, lastError: message ?? e.message });
  } else {
    // A local precondition (e.g. not the owner): the backoff state is left as it is.
    await store.set({ lastError: message ?? (e instanceof Error ? e.message : String(e)) });
  }
  throw e;
}
