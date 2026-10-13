// Shared plumbing for the sync orchestration modules: dependencies, write-through state view,
// and error recording.

import type { BrowserAdapter } from "../adapter/types.js";
import { ApiError, type ApiClient, type BrowserKind, type Owner } from "./client.js";
import { newOpId } from "./journal.js";
import { clearedCredentials, isPaired, loadState, saveState, type State } from "./state.js";

export type Api = Pick<
  ApiClient,
  "pair" | "createPairingCode" | "deleteDevice" | "session" | "changes" | "acquire" | "release" | "heartbeat" | "operations"
>;

export interface Deps {
  adapter: BrowserAdapter;
  api: (cfg: { baseUrl: string; token: string | null }) => Api;
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
  return deps.api({ baseUrl: s.serverUrl, token: s.token });
}

export function requirePaired(s: State): void {
  if (!isPaired(s)) throw new Error("This device is not paired");
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

/**
 * Record an error in state: `stale_owner` demotes, `device_revoked` clears credentials. Always
 * rethrows so the caller can report it.
 */
export async function fail(store: Store, e: unknown, sentGeneration?: number | null): Promise<never> {
  if (isStaleOwner(e)) {
    await demote(store, e, sentGeneration);
  } else if (e instanceof ApiError && e.code === "device_revoked") {
    await store.set({
      ...clearedCredentials(),
      statusText: "Disconnected",
      lastError: "This device was revoked on the server. Pair it again.",
    });
  } else {
    await store.set({ lastError: e instanceof Error ? e.message : String(e) });
  }
  throw e;
}
