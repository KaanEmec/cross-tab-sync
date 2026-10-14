// Manual handover (PROTOCOL.md "Client behavior (v0.1 manual handover)") plus pairing and
// lifecycle actions. Written against BrowserAdapter and a client factory so it runs unchanged
// against fakes. Hand over and Continue here reuse the v0.2 sync run (sync.ts).

import { applyRemote, captureTabs, currentMappings } from "./apply.js";
import { materialize } from "./materialize.js";
import { ApiError, normalizeServerUrl, type Owner } from "./client.js";
import { generateKey, keyCheck } from "./crypto.js";
import { emptyMappings, type Mappings } from "./mapping.js";
import { pairingLink } from "./pairing.js";
import { clearedCredentials, isPaired, loadState, PENDING_PAIR_TTL_MS, saveState, type State } from "./state.js";
import { apiFor, dropCredentials, fail, nowIso, nowMs, ownerLabel, requireKey, Store, succeeded, type Api, type Deps } from "./store.js";
import { submitJournal } from "./merge.js";
import { classify } from "./status.js";
import { createFailedMessage, flush, rejectedMessage } from "./sync.js";

export type { Api, Deps } from "./store.js";
export { applyResults, resolveReceivingWindow } from "./apply.js";

/**
 * Hand over: publish unmapped eligible tabs, flush, apply catchUp, release ownership. Automatic
 * takeover is suppressed until the next fresh interaction (the hand over counts as the latest one).
 */
export async function handOver(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  try {
    requireKey(store.s);
    const generation = store.s.generation;
    if (generation === null) throw new Error("This device is not the owner. Use Continue here to take control first.");

    // Journal before sending: a crash or network error leaves ops to be replayed with the same ids.
    await materialize(store, null, true);
    const { rejected, failed } = await flush(store);

    await apiFor(deps, store.s).release(generation);
    await store.set({
      generation: null,
      owner: null,
      ...succeeded(deps),
      lastError: [createFailedMessage(failed), rejectedMessage(rejected)].filter(Boolean).join("; ") || null,
      statusText: `Handed over at revision ${store.s.lastRevision}`,
      suppressAutoTakeover: true,
      lastActivityAt: nowMs(deps),
      lastActivityKind: null,
      freshPending: false,
    });
    return store.s;
  } catch (e) {
    return fail(store, e, store.s.generation);
  }
}

/**
 * Continue here (manual, and automatic takeover): force-acquire, materialize the session locally,
 * publish local extras, flush the journal kept while following.
 */
export async function continueHere(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  try {
    requireKey(store.s);
    await store.set({ lastTakeoverAt: nowMs(deps), suppressAutoTakeover: false, freshPending: false });
    const api = apiFor(deps, store.s);
    // Decrypt the session first: with another key nothing is sent and ownership never moves.
    await api.session();
    // Changes journaled while following go through merge (causal checks), never `operations`.
    const merged = await submitJournal(store);
    // Catch up first: remote navigations and closures since the last applied revision reach this
    // device as operations (closing and navigating exactly), not only as a snapshot difference.
    if (store.s.lastRevision > 0) {
      try {
        const res = await api.changes(store.s.lastRevision);
        await applyRemote(store, res.operations, new Set(), merged.revive);
        await store.set({
          lastRevision: Math.max(store.s.lastRevision, res.revision),
          minRevision: res.minRevision ?? store.s.minRevision,
          owner: res.owner,
        });
      } catch (e) {
        // History expired: the session snapshot below is the full-resync path.
        if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
      }
    }
    const { generation, session } = await api.acquire(true);
    // Nothing local changed before reaching the server, so an unreachable server leaves tabs untouched.
    await store.set({
      generation,
      owner: session.owner ?? {
        deviceId: store.s.deviceId ?? "",
        name: store.s.deviceName,
        generation,
        lastSeenAt: nowIso(deps),
      },
      lastRevision: session.revision,
      minRevision: session.minRevision ?? store.s.minRevision,
    });

    const { failed } = await materialize(store, session.entries, true);
    const flushed = await flush(store);

    const errors = [createFailedMessage(failed + flushed.failed), rejectedMessage(merged.rejected + flushed.rejected)];
    await store.set({
      ...succeeded(deps),
      lastError: errors.filter(Boolean).join("; ") || null,
      statusText: `Owner, generation ${generation}, revision ${store.s.lastRevision}`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e, store.s.generation);
  }
}

/** A keyless link was used against a session that already has (encrypted) history. */
export const KEY_REQUIRED_MESSAGE =
  "This server already holds encrypted tabs. Pair with an invite link from a browser that is already paired.";

/**
 * Pair with a code. `key` comes from an invite link (`#CODE.KEY`). Without one, this browser may
 * only start an empty session (revision 0), for which it generates the key; otherwise it revokes
 * itself again and asks for an invite link.
 */
export async function pair(
  deps: Deps,
  input: { serverUrl: string; deviceName: string; code: string; key?: string },
): Promise<State> {
  const store = await Store.open(deps);
  try {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const deviceName = input.deviceName.trim();
    const code = input.code.replace(/\s+/g, "");
    if (!deviceName) throw new Error("Device name is required");
    if (deviceName.length > 64) throw new Error("Device name must be at most 64 characters");
    if (!code) throw new Error("Pairing code is required");
    const res = await deps.api({ baseUrl: serverUrl, token: null }).pair({ code, name: deviceName, browser: deps.browser });
    const syncKey = await verifyKey(store, deps.api({ baseUrl: serverUrl, token: res.token }), res.deviceId, input.key);
    // The server suffixes the name when another active device uses it ("Brave on macOS 2").
    const name = res.name ?? deviceName;
    const renamed = name !== deviceName ? ` as "${name}" (another device is named "${deviceName}")` : "";
    await store.set({
      ...clearedCredentials(),
      serverUrl,
      deviceName: name,
      deviceId: res.deviceId,
      token: res.token,
      syncKey,
      keyVerified: true,
      pairedAt: nowIso(deps),
      mappings: emptyMappings(),
      ...succeeded(deps),
      lastError: null,
      statusText: `Paired${renamed}. This browser follows the shared tabs and takes over when you use it.`,
    });
    return store.s;
  } catch (e) {
    return fail(store, e);
  }
}

/**
 * The key this new device uses, verified against the session's key check (PROTOCOL.md
 * "Encryption"). An invite key must match the stored check (`PUT` 204; it stores the check if none
 * is set yet). Without a key, this browser may only start a session that has no check and no older
 * active device (of two keyless browsers racing, the older one wins; a `409 key_set` settles the
 * rest). A refused or failed check revokes the fresh device (best effort) and forgets everything.
 */
async function verifyKey(store: Store, api: Api, deviceId: string, linkKey: string | undefined): Promise<string> {
  const refuse = async (message: string): Promise<never> => {
    await api.deleteDevice(deviceId).catch(() => undefined);
    await dropCredentials(store, { errorKind: "key", statusText: null });
    throw new Error(message);
  };
  try {
    let key = linkKey;
    if (!key) {
      const [check, devices] = await Promise.all([api.sessionKeyCheck(), api.devices()]);
      const self = devices.findIndex((d) => d.isSelf);
      const older = devices.slice(0, self < 0 ? devices.length : self).some((d) => !d.revokedAt);
      if (check !== null || older) return await refuse(KEY_REQUIRED_MESSAGE);
      key = generateKey();
    }
    await api.putKeyCheck(await keyCheck(key));
    return key;
  } catch (e) {
    if (e instanceof ApiError && e.code === "key_set") return refuse(KEY_REQUIRED_MESSAGE);
    if (!(e instanceof ApiError)) throw e; // already refused (or a local failure)
    await api.deleteDevice(deviceId).catch(() => undefined);
    await dropCredentials(store, {});
    throw e;
  }
}

/** A pairing form saved by the popup that can no longer be used (codes last 10 minutes) is dropped. */
export async function dropExpiredPendingPair(deps: Deps, now = Date.now()): Promise<void> {
  const s = await loadState(deps.adapter.storage);
  if (s.pendingPair && now - s.pendingPair.createdAt > PENDING_PAIR_TTL_MS) {
    await saveState(deps.adapter.storage, { pendingPair: null });
  }
}

/**
 * Complete a pairing saved by the popup (see State.pendingPair). Consumes the record first so a
 * second trigger cannot reuse the single-use code. Returns null when there is nothing to do.
 */
export async function pairFromPending(deps: Deps, now = Date.now()): Promise<State | null> {
  const s = await loadState(deps.adapter.storage);
  const pending = s.pendingPair;
  if (!pending) return null;
  await saveState(deps.adapter.storage, { pendingPair: null });
  if (now - pending.createdAt > PENDING_PAIR_TTL_MS) return null;
  return pair(deps, pending);
}

/**
 * A single-use code for another browser, with its invite link `#CODE.KEY`, the only place the key
 * is shown. Built from the stored server URL, never from the server's `link`: a page at the link's
 * origin could read the fragment.
 */
export async function createPairingCode(deps: Deps): Promise<{ code: string; expiresAt: string; link: string }> {
  const store = await Store.open(deps);
  try {
    requireKey(store.s);
    const res = await apiFor(deps, store.s).createPairingCode();
    return { code: res.code, expiresAt: res.expiresAt, link: pairingLink(store.s.serverUrl, res.code, store.s.syncKey!) };
  } catch (e) {
    return fail(store, e);
  }
}

/** Best effort: release ownership and revoke this device on the server, then forget credentials. */
export async function disconnect(deps: Deps): Promise<State> {
  const store = await Store.open(deps);
  if (isPaired(store.s)) {
    const api = apiFor(deps, store.s);
    if (store.s.generation !== null) await api.release(store.s.generation).catch(() => undefined);
    if (store.s.deviceId) await api.deleteDevice(store.s.deviceId).catch(() => undefined);
  }
  await dropCredentials(store, { lastError: null, lastSuccessAt: null, statusText: "Disconnected" });
  return store.s;
}

/** Refresh the known owner without applying changes (popup). Returns whether the server was reachable. */
export async function refreshOwner(deps: Deps): Promise<boolean> {
  const store = await Store.open(deps);
  if (!isPaired(store.s) || !store.s.keyVerified) return false;
  const api = apiFor(deps, store.s);
  let owner: Owner | null;
  let minRevision: number | undefined;
  try {
    try {
      ({ owner, minRevision } = await api.changes(store.s.lastRevision));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "history_expired")) throw e;
      ({ owner, minRevision } = await api.session());
    }
  } catch (e) {
    if (e instanceof ApiError && (e.code === "device_revoked" || classify(e, true) === "key")) await fail(store, e).catch(() => undefined);
    return false;
  }
  const lostOwnership =
    store.s.generation !== null && (!owner || owner.deviceId !== store.s.deviceId || owner.generation !== store.s.generation);
  // Reachable again: clears the offline state; an armed retry timer still sends pending work.
  const known = { owner, minRevision: minRevision ?? store.s.minRevision, ...succeeded(deps) };
  await store.set(
    lostOwnership
      ? { ...known, generation: null, freshPending: true, statusText: `Not the owner: ${ownerLabel(owner)} took over.` }
      : known,
  );
  return true;
}

/**
 * Browser startup: tab ids from the previous session are meaningless, so set the mappings and
 * detached tabs aside (`stale`); they are re-matched by last-known URL as restored tabs load.
 * Starts the startup grace for removals and activity.
 */
export async function resetForBrowserStartup(deps: Deps): Promise<void> {
  const s = await loadState(deps.adapter.storage);
  const previous = [...Object.values(s.staleMappings?.tabs ?? {}), ...Object.values(s.mappings.tabs)];
  const staleMappings: Mappings = {
    tabs: Object.fromEntries(previous.map((m, i) => [`stale-${i}`, m])),
    urlCounts: s.mappings.urlCounts,
  };
  const detached = Object.fromEntries(Object.values(s.detached).map((url, i) => [`stale-${i}`, url]));
  await saveState(deps.adapter.storage, {
    mappings: emptyMappings(),
    staleMappings: previous.length > 0 ? staleMappings : null,
    detached,
    expected: [],
    // Removals still held belong to the shutdown of the previous session: unmap only.
    heldCloses: [],
    removedWindows: {},
    receivingWindowId: null,
    runLock: null,
    startupAt: nowMs(deps),
  });
}

/** Re-match mappings set aside by the startup reset to the current tabs by URL. */
export async function rematchTabs(deps: Deps): Promise<void> {
  const store = await Store.open(deps);
  if (!isPaired(store.s)) return;
  const { all, eligible } = await captureTabs(deps.adapter, store.s.serverUrl);
  await currentMappings(store, all, eligible);
}
