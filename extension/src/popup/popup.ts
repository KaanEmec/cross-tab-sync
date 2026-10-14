import { storageLocal } from "../adapter/webext.js";
import { originPattern, type Snapshot } from "../core/client.js";
import { deviceRows, ownerLine, relativeTime, shortId } from "../core/devices.js";
import type { Request, Response, StatusView } from "../core/messages.js";
import { browserLabel, resolvePairingForm, type PairingTarget } from "../core/pairing.js";
import { saveState } from "../core/state.js";
import { APPLIED_ELSEWHERE_NOTE, clock, RESTORE_NOTE } from "../core/status.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pairView = $<HTMLFormElement>("pair-view");
const mainView = $("main-view");
const errorEl = $("error");
const badge = $("badge");
const pairLink = $<HTMLInputElement>("pair-link");
const pairTarget = $("pair-target");
const pairHint = pairTarget.innerHTML;
const serverUrl = $<HTMLInputElement>("server-url");
const deviceName = $<HTMLInputElement>("device-name");
const pairCode = $<HTMLInputElement>("pair-code");
const recover = $<HTMLDetailsElement>("recover-section");
const deviceSection = $<HTMLDetailsElement>("device-section");
const devicesSection = $<HTMLDetailsElement>("devices-section");
const renameForm = $<HTMLFormElement>("rename-form");
const renameInput = $<HTMLInputElement>("rename-input");
const buttons = () => Array.from(document.querySelectorAll("button"));

let busy = false;
let reachable: boolean | undefined;
let last: StatusView | null = null;

$("applied-note").textContent = APPLIED_ELSEWHERE_NOTE;
$("restore-note").textContent = RESTORE_NOTE;

async function send(req: Request): Promise<Response> {
  try {
    return (await chrome.runtime.sendMessage(req)) as Response;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const relative = (iso: string | null | undefined) => relativeTime(iso, Date.now());

const ACTIVITY_WORDS: Record<string, string> = { activated: "tab switch", focus: "window focus", created: "new tab" };

/** "Last activity: tab switch, 09:22:38" (diagnostics for automatic ownership). */
function lastActivity(s: StatusView): string {
  if (s.lastActivityAt === null) return "";
  const kind = s.lastActivityKind ? `${ACTIVITY_WORDS[s.lastActivityKind] ?? s.lastActivityKind}, ` : "";
  return `Last activity: ${kind}${new Date(s.lastActivityAt).toLocaleTimeString()}`;
}

function showError(message: string | null): void {
  errorEl.textContent = message ?? "";
  errorEl.hidden = !message;
}

function render(s: StatusView): void {
  last = s;
  pairView.hidden = s.paired;
  mainView.hidden = !s.paired;
  badge.hidden = !s.paired;
  if (!s.paired) {
    // Known from a previous pairing: a bare code is then enough.
    if (!serverUrl.value) serverUrl.value = s.serverUrl;
    if (!deviceName.value) deviceName.value = s.deviceName;
    showError(s.lastError);
    return;
  }

  if (s.reachable !== undefined) reachable = s.reachable;
  const offline = reachable === false || !s.online;
  badge.textContent = s.paused ? "Paused" : offline ? "Offline" : s.isOwner ? "Owner" : "Follower";
  badge.classList.toggle("owner", s.isOwner && !offline && !s.paused);

  $("role").textContent = s.isOwner ? "Owner (publishes changes)" : "Follower (applies changes)";
  $("owner").textContent = ownerLine(s.owner, s.deviceId);
  $("owner").title = s.owner ? `Generation ${s.owner.generation}` : "";
  $("last-sync").textContent = relative(s.lastSuccessAt);
  $("last-sync").title = `Revision ${s.lastRevision}` + (s.minRevision !== null ? `; server history from revision ${s.minRevision}` : "");
  $("sync-state").textContent = s.summary;
  $("status-text").textContent = s.running ? "Working…" : (s.statusText ?? "");
  $("last-activity").textContent = lastActivity(s);
  $("last-activity").hidden = s.lastActivityAt === null;
  renderIdentity(s);

  const handOver = $<HTMLButtonElement>("hand-over");
  const continueHere = $<HTMLButtonElement>("continue-here");
  const syncNow = $<HTMLButtonElement>("sync-now");
  const blocked = busy || s.running;
  handOver.classList.toggle("primary", s.isOwner);
  continueHere.classList.toggle("primary", !s.isOwner);
  handOver.disabled = blocked || s.paused || !s.isOwner;
  handOver.title = s.isOwner ? "Publish this browser's tabs and release control" : "Only the owner can hand over";
  continueHere.disabled = blocked || s.paused;
  syncNow.disabled = blocked || s.paused;
  syncNow.textContent = s.nextRetryAt !== null ? "Retry now" : "Sync now";
  $("pause").textContent = s.paused ? "Resume sync" : "Pause sync";
  $<HTMLButtonElement>("pause").disabled = blocked;
  $("grant").hidden = s.errorKind !== "permission";

  showError(s.lastError);
}

/** The "This device" block: name (rename), browser, short id (copy), server, paired since. */
function renderIdentity(s: StatusView): void {
  const id = s.deviceId ?? "";
  $("self-summary").textContent = `· ${s.deviceName} (${shortId(id)})`;
  $("self-name").textContent = s.deviceName;
  $("self-browser").textContent = browserLabel(__BROWSER__);
  $("self-id").textContent = shortId(id);
  $("self-id").title = id;
  $("self-server").textContent = s.serverUrl;
  $("self-since").textContent = s.pairedAt ? new Date(s.pairedAt).toLocaleString() : "unknown";
}

/** Copy inside the click handler (user gesture); if the clipboard is unavailable, select the text instead. */
function copyText(text: string, source: HTMLElement, btn: HTMLButtonElement): void {
  const label = btn.textContent;
  const flash = (msg: string) => {
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = label), 2000);
  };
  const select = () => {
    if (source instanceof HTMLInputElement) {
      source.focus();
      source.select();
    } else {
      window.getSelection()?.selectAllChildren(source);
    }
    flash(navigator.userAgent.includes("Mac") ? "Press ⌘C" : "Press Ctrl+C");
  };
  if (!navigator.clipboard?.writeText) return select();
  navigator.clipboard.writeText(text).then(() => flash("Copied"), select);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const b of buttons()) b.disabled = value;
  if (value) $("status-text").textContent = "Working…";
}

async function run(req: Request): Promise<Response> {
  setBusy(true);
  const res = await send(req);
  if (res.ok && req.type !== "getStatus") reachable = true;
  busy = false;
  for (const b of buttons()) b.disabled = false;
  if (res.status) render(res.status);
  if (!res.ok) showError(res.error);
  return res;
}

/** Two-step confirm inside the popup: confirm() may always return false in Safari popovers. */
function confirmTwice(btn: HTMLButtonElement, armedLabel: string, action: () => void): void {
  const label = btn.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedAt = 0;
  btn.addEventListener("click", () => {
    if (timer !== null && Date.now() - armedAt < 400) return; // a double click is not a confirmation
    if (timer === null) {
      armedAt = Date.now();
      btn.textContent = armedLabel;
      timer = setTimeout(() => {
        timer = null;
        btn.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.textContent = label;
    action();
  });
}

/** Host permission for the backend origin; must be requested from a user gesture. */
async function requestOrigin(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern || !chrome.permissions?.request) return true; // let the worker report an invalid URL
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false; // e.g. origin not covered by optional_host_permissions
  }
}

function item(text: string, detail: string, button?: HTMLButtonElement, className = ""): HTMLLIElement {
  const li = document.createElement("li");
  if (className) li.className = className;
  const span = document.createElement("span");
  span.textContent = text;
  const small = document.createElement("small");
  small.textContent = detail;
  span.append(small);
  li.append(span);
  if (button) li.append(button);
  return li;
}

function fill(list: HTMLElement, items: HTMLLIElement[], empty: string): void {
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = empty;
    items = [li];
  }
  list.replaceChildren(...items);
}

function button(label: string, armedLabel: string, action: () => void, danger = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (danger) b.className = "danger";
  confirmTwice(b, armedLabel, action);
  return b;
}

async function loadSnapshots(): Promise<void> {
  const [snaps, devs] = await Promise.all([send({ type: "listSnapshots" }), send({ type: "listDevices" })]);
  if (!snaps.ok) return showError(snaps.error);
  const names = new Map((devs.ok ? (devs.devices ?? []) : []).map((d) => [d.id, d.name]));
  const rows = (snaps.snapshots ?? []).map((s: Snapshot) => {
    const who = s.deviceId === last?.deviceId ? "this device" : (names.get(s.deviceId) ?? "a removed device");
    const why = s.reason === "restore" ? "before a restore" : "before a change";
    const restore = button("Restore", "Confirm restore", () => {
      void run({ type: "restoreSnapshot", id: s.id }).then(async (r) => {
        if (r.ok) await loadSnapshots();
      });
    });
    return item(`${new Date(s.createdAt).toLocaleString()} · ${s.entryCount} tab(s)`, `${who}, ${why}`, restore);
  });
  fill($("snapshots"), rows, "No snapshots yet");
}

async function revoke(id: string): Promise<void> {
  if ((await run({ type: "revokeDevice", id })).ok) await loadDevices();
}

async function loadDevices(): Promise<void> {
  const res = await send({ type: "listDevices" });
  if (!res.ok) return showError(res.error);
  const rows = deviceRows(res.devices ?? [], Date.now()).map((d) => {
    const action = d.canRevoke ? button("Revoke", "Confirm revoke", () => void revoke(d.id), true) : undefined;
    return item(d.title, d.detail, action, d.revoked ? "revoked" : "");
  });
  fill($("devices"), rows, "No devices");
}

function pairingTarget(): PairingTarget {
  return resolvePairingForm({ link: pairLink.value, serverUrl: serverUrl.value, code: pairCode.value }, last?.serverUrl ?? "");
}

pairLink.addEventListener("input", () => {
  let host = "";
  try {
    host = new URL(pairingTarget().serverUrl).host;
  } catch {
    /* not a complete link yet */
  }
  if (host) pairTarget.textContent = `Pairs with ${host}.`;
  else pairTarget.innerHTML = pairHint;
});

pairView.addEventListener("submit", (ev) => {
  ev.preventDefault();
  let target: PairingTarget;
  try {
    target = pairingTarget();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (!deviceName.value.trim()) return showError("Enter a device name");
  showError(null);
  // Save the form first (the prompt may close this popup; the worker then pairs on
  // permissions.onAdded), then request permission synchronously inside the user gesture.
  const saved = saveState(storageLocal, {
    pendingPair: { serverUrl: target.serverUrl, deviceName: deviceName.value, code: target.code, createdAt: Date.now() },
    lastError: null,
  });
  const granted = requestOrigin(target.serverUrl);
  void Promise.all([saved, granted]).then(async ([, ok]) => {
    if (!ok) {
      await saveState(storageLocal, { pendingPair: null });
      showError("Permission to reach the server was denied or is not available for this address. Pairing needs access to the server.");
      return;
    }
    const res = await run({ type: "pair" });
    if (res.ok) pairLink.value = pairCode.value = "";
  });
});

$("hand-over").addEventListener("click", () => void run({ type: "handOver" }));
$("continue-here").addEventListener("click", () => void run({ type: "continueHere" }));
$("sync-now").addEventListener("click", () => void run({ type: "syncNow" }));
$("pause").addEventListener("click", () => void run({ type: last?.paused ? "resume" : "pause" }));
$("grant").addEventListener("click", () => {
  void requestOrigin(last?.serverUrl ?? "").then(async (ok) => {
    if (ok) await run({ type: "syncNow" });
  });
});
recover.addEventListener("toggle", () => void (recover.open && loadSnapshots()));
devicesSection.addEventListener("toggle", () => void (devicesSection.open && loadDevices()));
// Devices paired before pairedAt was kept: the device list backfills it (storage change re-renders).
deviceSection.addEventListener("toggle", () => void (deviceSection.open && last?.paired && !last.pairedAt && send({ type: "listDevices" })));

$("copy-id").addEventListener("click", (ev) => copyText(last?.deviceId ?? "", $("self-id"), ev.currentTarget as HTMLButtonElement));

function showRename(open: boolean): void {
  renameForm.hidden = !open;
  $("rename").hidden = open;
  if (open) {
    renameInput.value = last?.deviceName ?? "";
    renameInput.focus();
    renameInput.select();
  }
}
$("rename").addEventListener("click", () => showRename(true));
$("rename-cancel").addEventListener("click", () => showRename(false));
renameForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = renameInput.value.trim();
  if (!name) return showError("Enter a device name");
  void run({ type: "renameDevice", name }).then(async (res) => {
    if (!res.ok) return;
    showRename(false);
    if (devicesSection.open) await loadDevices();
  });
});

const inviteLink = $<HTMLInputElement>("invite-link");
$("invite").addEventListener("click", async () => {
  const res = await run({ type: "createPairingCode" });
  if (!res.ok || !res.pairingCode) return;
  const { link, expiresAt } = res.pairingCode;
  const expires = clock(Date.parse(expiresAt));
  inviteLink.value = link;
  $("invite-note").textContent = `Valid until ${expires}, single use. In the other browser, open Cross-Tab-Sync and paste this link.`;
  $("invite-box").hidden = false;
  $("invite").textContent = "New invitation link";
});
$("copy-link").addEventListener("click", (ev) => copyText(inviteLink.value, inviteLink, ev.currentTarget as HTMLButtonElement));

const disconnect = $<HTMLButtonElement>("disconnect");
disconnect.title = "Releases ownership and revokes this device on the server. Your tabs stay open.";
confirmTwice(disconnect, "Click again to disconnect. Pairing again gives this browser a new identity.", () => void run({ type: "disconnect" }));

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || busy) return;
  void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
});

void run({ type: "getStatus", refresh: true });
