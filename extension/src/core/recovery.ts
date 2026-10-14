// Recovery and device management (v1.0): snapshot list and restore, device list, rename and revocation.
// Restoration is ordinary `open` operations on the server, never a rewind; it reopens URLs only.

import { ApiError, type Device, type Snapshot } from "./client.js";
import { continueHere } from "./handover.js";
import { isPaired, type State } from "./state.js";
import { classify, errorMessage, isRemovedKind } from "./status.js";
import { apiFor, fail, requireKey, requirePaired, Store, succeeded, type Deps } from "./store.js";
import { createFailedMessage, flush, rejectedMessage, resync } from "./sync.js";

/** Read-only popup requests: a revoked device is cleared, other errors are explained, no backoff. */
async function read<T>(deps: Deps, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = await Store.open(deps);
  requirePaired(store.s);
  try {
    const result = await fn(store);
    await store.set(succeeded(deps));
    return result;
  } catch (e) {
    const kind = classify(e, true);
    if (isRemovedKind(kind) || kind === "key") return fail(store, e);
    throw kind ? new Error(errorMessage(kind, store.s.serverUrl, e instanceof ApiError ? e.status : 0)) : e;
  }
}

/** Server recovery snapshots, newest first. */
export function listSnapshots(deps: Deps): Promise<Snapshot[]> {
  return read(deps, (store) => apiFor(deps, store.s).snapshots());
}

/** Devices, including ones revoked in the last 7 days. Keeps this device's name and pairing time in step. */
export function listDevices(deps: Deps): Promise<Device[]> {
  return read(deps, async (store) => {
    const devices = await apiFor(deps, store.s).devices();
    const self = devices.find((d) => d.isSelf);
    if (self && (store.s.pairedAt === null || store.s.deviceName !== self.name)) {
      await store.set({ pairedAt: store.s.pairedAt ?? self.createdAt, deviceName: self.name });
    }
    return devices;
  });
}

/** Rename this device on the server; the stored name may carry a suffix when another device uses it. */
export async function renameDevice(deps: Deps, name: string): Promise<State> {
  const store = await Store.open(deps);
  requirePaired(store.s);
  const wanted = name.trim();
  if (!wanted) throw new Error("Device name is required");
  if ([...wanted].length > 64) throw new Error("Device name must be at most 64 characters");
  try {
    const d = await apiFor(deps, store.s).renameDevice(store.s.deviceId!, wanted);
    const owner = store.s.owner?.deviceId === d.id ? { ...store.s.owner, name: d.name } : store.s.owner;
    await store.set({
      deviceName: d.name,
      owner,
      ...succeeded(deps),
      lastError: null,
      statusText: d.name === wanted ? `Renamed to "${d.name}"` : `Renamed to "${d.name}" (another device is named "${wanted}")`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

/** Revoke another paired device. This device is removed with Disconnect instead. */
export async function revokeDevice(deps: Deps, deviceId: string): Promise<State> {
  const store = await Store.open(deps);
  requirePaired(store.s);
  if (deviceId === store.s.deviceId) throw new Error("Use Disconnect to remove this device");
  try {
    await apiFor(deps, store.s).deleteDevice(deviceId);
    // Revoking the owner clears ownership on the server.
    if (store.s.owner?.deviceId === deviceId) await store.set({ owner: null });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

/**
 * Restore a snapshot: become owner first (Continue here) or flush as owner, issue the restore with
 * the current generation, then rebuild from the session so the reopened entries get background tabs.
 */
export async function restoreSnapshot(deps: Deps, snapshotId: number): Promise<State> {
  let store = await Store.open(deps);
  try {
    requireKey(store.s);
  } catch (e) {
    return fail(store, e);
  }
  const tookOver = store.s.generation === null;
  if (tookOver) {
    await continueHere(deps); // records and rethrows its own failure
    store = await Store.open(deps);
  }
  const generation = store.s.generation;
  let flushed = { rejected: 0, failed: 0 };
  try {
    if (generation === null || !isPaired(store.s)) throw new Error("This device is not the owner");
    // Catch up first (Continue here just did), so the session rebuild below skips nothing unseen.
    // As in Continue here, the session must decrypt before anything is sent.
    if (!tookOver) {
      await apiFor(deps, store.s).session();
      flushed = await flush(store);
    }
    const res = await apiFor(deps, store.s).restoreSnapshot(snapshotId, generation);
    const failed = await resync(store);
    const reopened = res.results.filter((r) => r.status === "applied").length;
    await store.set({
      lastError: [createFailedMessage(failed + flushed.failed), rejectedMessage(flushed.rejected)].filter(Boolean).join("; ") || null,
      statusText: `Restored ${reopened} tab(s). Owner, generation ${generation}, revision ${store.s.lastRevision}`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e, generation);
  }
}
