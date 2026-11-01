import type { KeyValueStorage } from "../adapter/types.js";
import { isLocked, loadState, saveState } from "./state.js";

export class BusyError extends Error {
  constructor(action: string) {
    super(`Another sync run is in progress (${action})`);
    this.name = "BusyError";
  }
}

/**
 * Run `fn` while holding the persisted run lock. A lock older than RUN_LOCK_TTL_MS is treated as
 * abandoned (the service worker was terminated mid-run) and taken over.
 */
export async function withRunLock<T>(
  storage: KeyValueStorage,
  action: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const s = await loadState(storage);
  if (isLocked(s, now())) throw new BusyError(s.runLock?.action ?? action);
  await saveState(storage, { runLock: { action, startedAt: now() } });
  try {
    return await fn();
  } finally {
    await storage.set({ "cts.runLock": null });
  }
}
