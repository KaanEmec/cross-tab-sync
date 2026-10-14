// Manual handover (PROTOCOL.md "Client behavior (v0.1 manual handover)") plus pairing and
// lifecycle actions. Written against BrowserAdapter and a client factory so it runs unchanged
// against fakes. Hand over and Continue here reuse the v0.2 sync run (sync.ts).

import { applyRemote, captureTabs, currentMappings } from "./apply.js";
import { materialize } from "./materialize.js";
import { ApiError, normalizeServerUrl, type Owner, type Paired } from "./client.js";
import { generateKey, keyCheck } from "./crypto.js";
import { emptyMappings, type Mappings } from "./mapping.js";
import { pairingLink } from "./pairing.js";
import { clearedCredentials, isPaired, loadState, PENDING_PAIR_TTL_MS, saveState, type State } from "./state.js";
import { apiFor, dropCredentials, fail, nowIso, nowMs, ownerLabel, requireKey, Store, succeeded, type Api, type Deps } from "./store.js";
import { submitJournal } from "./merge.js";
import { classify, INVITE_KEY_MISMATCH_MESSAGE, isRemovedKind, pairingRefusal } from "./status.js";
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

/** Device name rules shared by Start syncing and joining (the server allows 1–64 characters). */
function checkDeviceName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("Device name is required");
  if (name.length > 64) throw new Error("Device name must be at most 64 characters");
  return name;
}

/** Refusals of `sessions`/`pair` (closed server, full session, rate limit, used code) in plain words. */
function explained(deps: Deps, e: unknown): unknown {
  const message = pairingRefusal(e, nowMs(deps));
  return message && e instanceof ApiError ? new ApiError(e.status, e.code, message, e.body) : e;
}

/** Credentials of a new device, written at once (the key is verified: see `startSyncing` and `pair`). */
async function storePaired(
  store: Store,
  deps: Deps,
  p: { serverUrl: string; deviceName: string; res: Paired; syncKey: string; started: boolean },
): Promise<void> {
  // The server suffixes the name when another active device uses it ("Brave on macOS 2").
  const name = p.res.name ?? p.deviceName;
  const renamed = name !== p.deviceName ? ` as "${name}" (another device is named "${p.deviceName}")` : "";
  await store.set({
    ...clearedCredentials(),
    serverUrl: p.serverUrl,
    deviceName: name,
    deviceId: p.res.deviceId,
    token: p.res.token,
    syncKey: p.syncKey,
    keyVerified: true,
    pairedAt: nowIso(deps),
    invitePending: p.started,
    mappings: emptyMappings(),
    ...succeeded(deps),
    lastError: null,
    statusText: p.started
      ? `Started syncing${renamed}. Invite your other browser.`
      : `Paired${renamed}. This browser follows the shared tabs and takes over when you use it.`,
  });
}

/**
 * Start syncing: this browser generates the root key and creates a new session on `serverUrl`
 * with the key's check (`POST /v3/sessions`), as its first device.
 */
export async function startSyncing(deps: Deps, input: { serverUrl: string; deviceName: string }): Promise<State> {
  const store = await Store.open(deps);
  // A second trigger (popup and permissions.onAdded) must not replace a session that just started.
  if (isPaired(store.s)) return store.s;
  try {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const deviceName = checkDeviceName(input.deviceName);
    // Errors name this server and check its permission (unpaired: no token, so not paired yet).
    await store.set({ serverUrl });
    const syncKey = generateKey();
    const res = await deps
      .api({ baseUrl: serverUrl, token: null })
      .createSession({ keyCheck: await keyCheck(syncKey), name: deviceName, browser: deps.browser });
    await keepOrRevoke(deps, serverUrl, res, () => storePaired(store, deps, { serverUrl, deviceName, res, syncKey, started: true }));
    return store.s;
  } catch (e) {
    return fail(store, explained(deps, e));
  }
}

/**
 * Store a new device's credentials; if that fails, revoke the device again (best effort) so no
 * session or device is left that nobody can reach (revoking the last device deletes the session).
 */
async function keepOrRevoke(deps: Deps, serverUrl: string, res: Paired, save: () => Promise<void>): Promise<void> {
  try {
    await save();
  } catch (e) {
    await deps.api({ baseUrl: serverUrl, token: res.token }).deleteDevice(res.deviceId).catch(() => undefined);
    throw e;
  }
}

/**
 * Join with an invite link (`#CODE.KEY`): pair, then compare the key's check with the session's
 * before anything else; a mismatch revokes the fresh device again (`verifyKey`).
 */
export async function pair(deps: Deps, input: { serverUrl: string; deviceName: string; code: string; key?: string }): Promise<State> {
  const store = await Store.open(deps);
  // Already paired (e.g. the other trigger finished first): keep the existing credentials.
  if (isPaired(store.s)) return store.s;
  try {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const deviceName = checkDeviceName(input.deviceName);
    const code = input.code.replace(/\s+/g, "");
    if (!code) throw new Error("Pairing code is required");
    const key = input.key;
    if (!key) throw new Error("This link has no encryption key, so it cannot be used. Copy the whole invite link again.");
    await store.set({ serverUrl });
    const res = await deps.api({ baseUrl: serverUrl, token: null }).pair({ code, name: deviceName, browser: deps.browser });
    await verifyKey(store, deps.api({ baseUrl: serverUrl, token: res.token }), res.deviceId, key);
    await keepOrRevoke(deps, serverUrl, res, () => storePaired(store, deps, { serverUrl, deviceName, res, syncKey: key, started: false }));
    return store.s;
  } catch (e) {
    return fail(store, explained(deps, e));
  }
}

/**
 * The invite key must match the session's key check (PROTOCOL.md "Encryption"). A different (or
 * missing) check, or a failed comparison, revokes the fresh device (best effort) and forgets
 * everything; a mismatch reports kind "key".
 */
async function verifyKey(store: Store, api: Api, deviceId: string, key: string): Promise<void> {
  let matches: boolean;
  try {
    const [stored, own] = await Promise.all([api.sessionKeyCheck(), keyCheck(key)]);
    matches = stored === own;
  } catch (e) {
    await api.deleteDevice(deviceId).catch(() => undefined);
    await dropCredentials(store, {});
    throw e;
  }
  if (matches) return;
  await api.deleteDevice(deviceId).catch(() => undefined);
  await dropCredentials(store, { errorKind: "key", statusText: null });
  throw new Error(INVITE_KEY_MISMATCH_MESSAGE);
}

/** A pairing form saved by the popup that can no longer be used (codes last 10 minutes) is dropped. */
export async function dropExpiredPendingPair(deps: Deps, now = Date.now()): Promise<void> {
  const s = await loadState(deps.adapter.storage);
  if (s.pendingPair && now - s.pendingPair.createdAt > PENDING_PAIR_TTL_MS) {
    await saveState(deps.adapter.storage, { pendingPair: null });
  }
}

/**
 * Complete Start syncing or a join saved by the popup (see State.pendingPair). Consumes the record
 * first so a second trigger can neither reuse the single-use code nor start a second session.
 * Returns null when there is nothing to do.
 */
export async function pairFromPending(deps: Deps, now = Date.now()): Promise<State | null> {
  const s = await loadState(deps.adapter.storage);
  const pending = s.pendingPair;
  if (!pending) return null;
  await saveState(deps.adapter.storage, { pendingPair: null });
  if (now - pending.createdAt > PENDING_PAIR_TTL_MS) return null;
  if (pending.code === undefined) return startSyncing(deps, pending);
  return pair(deps, { ...pending, code: pending.code });
}

/**
 * A single-use code for another browser, with its invite link `#CODE.KEY`, the only place the key
 * is shown. Built from the stored server URL: the link is meant to be pasted, and a page at its
 * origin could read the fragment. Clears `invitePending`.
 */
export async function createPairingCode(deps: Deps): Promise<{ code: string; expiresAt: string; link: string }> {
  const store = await Store.open(deps);
  try {
    requireKey(store.s);
    const res = await apiFor(deps, store.s).createPairingCode();
    if (store.s.invitePending) await store.set({ invitePending: false });
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
    const kind = classify(e, true);
    if (isRemovedKind(kind) || kind === "key") await fail(store, e).catch(() => undefined);
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
