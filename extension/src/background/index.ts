// MV3 service worker. All listeners are registered synchronously at top level; all state lives
// in chrome.storage.local (see core/state.ts). Never log URLs or tokens.

import { createWebExtAdapter } from "../adapter/webext.js";
import { ApiClient } from "../core/client.js";
import {
  continueHere,
  createPairingCode,
  disconnect,
  handOver,
  heartbeat,
  pairFromPending,
  refreshOwner,
  resetForBrowserStartup,
  type Deps,
} from "../core/handover.js";
import { BusyError, withRunLock } from "../core/lock.js";
import { statusView, type Request, type Response } from "../core/messages.js";
import { isLocked, isPaired, loadState, saveState } from "../core/state.js";

const HEARTBEAT_ALARM = "heartbeat";
const HEARTBEAT_MINUTES = 5;

const adapter = createWebExtAdapter();
const deps: Deps = {
  adapter,
  api: (cfg) => new ApiClient(cfg),
  browser: __BROWSER__,
};

// In-process guard on top of the persisted run lock: two messages can interleave at awaits
// before the persisted flag is written.
let current: Promise<unknown> | null = null;

async function exclusive<T>(action: string, fn: () => Promise<T>): Promise<T> {
  if (current) throw new BusyError(action);
  const run = withRunLock(adapter.storage, action, fn);
  current = run;
  try {
    return await run;
  } finally {
    current = null;
  }
}

/** Pairing can be triggered twice (popup message and permissions.onAdded); the later one waits. */
async function pairExclusive(): Promise<void> {
  if (current) await current.catch(() => undefined);
  const result = await exclusive("pair", () => pairFromPending(deps));
  if (!result && !isPaired(await loadState(adapter.storage))) {
    throw new Error("Pairing form expired or was already used; enter the code again");
  }
}

async function setup(): Promise<void> {
  const state = await loadState(adapter.storage);
  if (!state.deviceName) {
    const os = await chrome.runtime.getPlatformInfo().then((p) => p.os).catch(() => "");
    const osName = os === "mac" ? "macOS" : os === "win" ? "Windows" : os === "linux" ? "Linux" : "";
    const browserName = __BROWSER__ === "safari" ? "Safari" : "Brave";
    await saveState(adapter.storage, { deviceName: osName ? `${browserName} on ${osName}` : browserName });
  }
  await adapter.ensureAlarm(HEARTBEAT_ALARM, HEARTBEAT_MINUTES);
}

// Safari keeps alarms in memory only: re-create on every worker start, not just on install.
void adapter.ensureAlarm(HEARTBEAT_ALARM, HEARTBEAT_MINUTES);

// There is one worker instance per extension, so a run lock found at worker start belongs to a
// worker that was terminated mid-run. Clear it rather than waiting for the TTL.
void saveState(adapter.storage, { runLock: null });

chrome.runtime.onInstalled.addListener(() => {
  void setup();
});

chrome.runtime.onStartup.addListener(() => {
  void resetForBrowserStartup(deps).then(setup);
});

adapter.onAlarm((name) => {
  if (name !== HEARTBEAT_ALARM || current) return;
  void loadState(adapter.storage).then((s) => (isLocked(s, Date.now()) ? undefined : heartbeat(deps)));
});

// Remember the last focused normal window: it receives tabs created by Continue here.
adapter.onWindowFocusChanged((windowId) => {
  if (windowId === null) return;
  void adapter.getWindows().then((windows) => {
    const w = windows.find((x) => x.id === windowId);
    if (w && w.type === "normal" && !w.incognito) return saveState(adapter.storage, { receivingWindowId: w.id });
  });
});

// In Chromium the permission prompt may close the popup before it can send "pair"; finish the
// pairing here from the form it saved.
chrome.permissions?.onAdded?.addListener((perms) => {
  if (!perms.origins?.length) return;
  void pairExclusive().catch(() => undefined);
});

async function handle(req: Request): Promise<Response> {
  let pairingCode: { code: string; expiresAt: string } | undefined;
  let reachable: boolean | undefined;
  switch (req.type) {
    case "getStatus":
      if (req.refresh && !current && !isLocked(await loadState(adapter.storage), Date.now())) {
        reachable = await refreshOwner(deps);
      }
      break;
    case "pair":
      await pairExclusive();
      break;
    case "handOver":
      await exclusive("handOver", () => handOver(deps));
      break;
    case "continueHere":
      await exclusive("continueHere", () => continueHere(deps));
      break;
    case "createPairingCode":
      pairingCode = await createPairingCode(deps);
      break;
    case "disconnect":
      await exclusive("disconnect", () => disconnect(deps));
      break;
    default:
      throw new Error("Unknown request");
  }
  const status = statusView(await loadState(adapter.storage));
  if (reachable !== undefined) status.reachable = reachable;
  return pairingCode ? { ok: true, status, pairingCode } : { ok: true, status };
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
