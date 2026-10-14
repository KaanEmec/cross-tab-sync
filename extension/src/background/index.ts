// MV3 service worker. All listeners are registered synchronously at top level; all state lives
// in chrome.storage.local (see core/state.ts). Never log URLs or tokens.

import { createWebExtAdapter } from "../adapter/webext.js";
import { ApiClient } from "../core/client.js";
import { cipherFor } from "../core/crypto.js";
import { diag, refreshDiagnostics } from "../core/diag.js";
import { SyncEngine } from "../core/engine.js";
import { createPairingCode, disconnect, pairFromPending, refreshOwner, type Deps } from "../core/handover.js";
import type { Device, Snapshot } from "../core/client.js";
import { statusView, type Request, type Response } from "../core/messages.js";
import { defaultDeviceName } from "../core/pairing.js";
import { listDevices, listSnapshots, renameDevice, revokeDevice } from "../core/recovery.js";
import { isPaired, loadState, saveState } from "../core/state.js";

/** The 5-minute cycle (named "heartbeat" since v0.1 so existing alarms keep working). */
const SYNC_ALARM = "heartbeat";
const SYNC_MINUTES = 5;

const adapter = createWebExtAdapter();
const deps: Deps = {
  adapter,
  // The cipher is derived once per key (cipherFor memoizes); unpaired calls carry no URLs.
  api: ({ key, ...cfg }) => new ApiClient({ ...cfg, cipher: key ? cipherFor(key) : undefined }),
  browser: __BROWSER__,
};

// Events, runs and popup actions go through one queue (see core/engine.ts); nothing else in this
// worker keeps state between events.
const engine = new SyncEngine(deps);

// Diagnostics trace (core/diag.ts): on for a loopback server unless toggled in state.
void refreshDiagnostics(adapter.storage)
  .then(() => diag(`worker start (${__BROWSER__})`))
  .catch(() => undefined);

/** Pairing can be triggered twice (popup message and permissions.onAdded); the later one finds nothing. */
async function pairQueued(): Promise<void> {
  const result = await engine.locked("pair", () => pairFromPending(deps));
  if (result) {
    engine.requestSync();
    return;
  }
  const s = await loadState(adapter.storage);
  // The other trigger may already have failed (e.g. invalid_code): report its error.
  if (!isPaired(s)) throw new Error(s.lastError ?? "Pairing form expired or was already used; enter the code again");
}

async function setup(): Promise<void> {
  const state = await loadState(adapter.storage);
  if (!state.deviceName) {
    const os = await chrome.runtime.getPlatformInfo().then((p) => p.os as string).catch(() => "");
    await saveState(adapter.storage, { deviceName: defaultDeviceName(__BROWSER__, os) });
  }
  await adapter.ensureAlarm(SYNC_ALARM, SYNC_MINUTES);
}

// Safari keeps alarms in memory only: re-create on every worker start, not just on install.
void adapter.ensureAlarm(SYNC_ALARM, SYNC_MINUTES);

// There is one worker instance per extension, so a run lock found at worker start belongs to a
// worker that was terminated mid-run. Clear it rather than waiting for the TTL, then send what
// that worker journaled.
void engine.enqueue(() => saveState(adapter.storage, { runLock: null })).then(() => engine.resume());

chrome.runtime.onInstalled.addListener((details) => {
  diag(`onInstalled ${details.reason}`);
  void setup();
  // Same reset as a new browser session: an update may leave state from another code version.
  if (details.reason === "update") void engine.startup("update").catch(() => undefined);
});

// Tab, window and startup listeners, registered synchronously.
engine.attach();
adapter.onStartup(() => void setup());

adapter.onAlarm((name) => {
  if (name !== SYNC_ALARM) return;
  // Owner: flush plus heartbeat (empty batch). Follower: pull changes.
  void engine.runNow("alarm").catch(() => undefined);
});

// In Chromium the permission prompt may close the popup before it can send "pair"; finish the
// pairing here from the form it saved.
chrome.permissions?.onAdded?.addListener((perms) => {
  if (!perms.origins?.length) return;
  void pairQueued().catch(() => undefined);
});

async function handle(req: Request): Promise<Response> {
  let pairingCode: { code: string; expiresAt: string; link: string } | undefined;
  let reachable: boolean | undefined;
  let snapshots: Snapshot[] | undefined;
  let devices: Device[] | undefined;
  switch (req.type) {
    case "getStatus":
      if (req.refresh && !engine.busy) reachable = await engine.enqueue(() => refreshOwner(deps));
      break;
    case "pair":
      await pairQueued();
      break;
    case "handOver":
      await engine.handOver();
      break;
    case "continueHere":
      await engine.takeover("continueHere");
      break;
    case "syncNow":
      await engine.runNow("syncNow");
      break;
    case "pause":
      await engine.pause();
      break;
    case "resume":
      await engine.unpause();
      break;
    case "listSnapshots":
      snapshots = await listSnapshots(deps);
      break;
    case "restoreSnapshot":
      await engine.restore(req.id);
      break;
    case "listDevices":
      devices = await listDevices(deps);
      break;
    case "renameDevice":
      await engine.enqueue(() => renameDevice(deps, req.name));
      break;
    case "revokeDevice":
      await engine.enqueue(() => revokeDevice(deps, req.id));
      break;
    case "createPairingCode":
      pairingCode = await createPairingCode(deps);
      break;
    case "disconnect":
      await engine.locked("disconnect", () => disconnect(deps));
      break;
    default:
      throw new Error("Unknown request");
  }
  const status = statusView(await loadState(adapter.storage));
  if (reachable !== undefined) status.reachable = reachable;
  return { ok: true, status, pairingCode, snapshots, devices };
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse: (r: Response) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg)
    .then(sendResponse)
    .catch(async (e: unknown) => {
      const status = await loadState(adapter.storage).then((s) => statusView(s)).catch(() => undefined);
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), status });
    });
  return true;
});
