import { storageLocal } from "../adapter/webext.js";
import { originPattern, type Device, type Snapshot } from "../core/client.js";
import type { Request, Response, StatusView } from "../core/messages.js";
import { saveState } from "../core/state.js";
import { APPLIED_ELSEWHERE_NOTE, RESTORE_NOTE } from "../core/status.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pairView = $<HTMLFormElement>("pair-view");
const mainView = $("main-view");
const errorEl = $("error");
const badge = $("badge");
const serverUrl = $<HTMLInputElement>("server-url");
const deviceName = $<HTMLInputElement>("device-name");
const pairCode = $<HTMLInputElement>("pair-code");
const recover = $<HTMLDetailsElement>("recover-section");
const devicesSection = $<HTMLDetailsElement>("devices-section");
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

function relative(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
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
  const o = s.owner;
  $("owner").textContent = !o
    ? "No owner"
    : o.deviceId === s.deviceId
      ? `This device (gen. ${o.generation})`
      : `${o.name} (gen. ${o.generation})`;
  $("last-sync").textContent = relative(s.lastSuccessAt);
  $("last-sync").title = `Revision ${s.lastRevision}` + (s.minRevision !== null ? `; server history from revision ${s.minRevision}` : "");
  $("sync-state").textContent = s.summary;
  $("status-text").textContent = s.running ? "Working…" : (s.statusText ?? "");
  $("identity").textContent = `${s.deviceName} · ${hostOf(s.serverUrl)}`;
  $("identity").title = s.serverUrl;

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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
  btn.addEventListener("click", () => {
    if (timer === null) {
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

function item(text: string, detail: string, button?: HTMLButtonElement): HTMLLIElement {
  const li = document.createElement("li");
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
  const rows = (res.devices ?? []).map((d: Device) => {
    const action = d.isSelf ? undefined : button("Revoke", "Confirm revoke", () => void revoke(d.id), true);
    return item(d.isSelf ? `${d.name} (this device)` : d.name, `${d.browser}, last seen ${relative(d.lastSeenAt)}`, action);
  });
  fill($("devices"), rows, "No devices");
}

pairView.addEventListener("submit", (ev) => {
  ev.preventDefault();
  // Save the form first (the prompt may close this popup; the worker then pairs on
  // permissions.onAdded), then request permission synchronously inside the user gesture.
  const saved = saveState(storageLocal, {
    pendingPair: { serverUrl: serverUrl.value, deviceName: deviceName.value, code: pairCode.value, createdAt: Date.now() },
    lastError: null,
  });
  const granted = requestOrigin(serverUrl.value);
  void Promise.all([saved, granted]).then(async ([, ok]) => {
    if (!ok) {
      await saveState(storageLocal, { pendingPair: null });
      showError("Permission to reach the server was denied or is not available for this address. Pairing needs access to the server.");
      return;
    }
    const res = await run({ type: "pair" });
    if (res.ok) pairCode.value = "";
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

$("create-code").addEventListener("click", async () => {
  const res = await run({ type: "createPairingCode" });
  const el = $("pairing-code");
  if (res.ok && res.pairingCode) {
    const expires = new Date(res.pairingCode.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.textContent = res.pairingCode.code;
    const small = document.createElement("small");
    small.textContent = `Enter on the other device. Valid until ${expires}, single use.`;
    el.append(small);
    el.hidden = false;
  }
});

const disconnect = $<HTMLButtonElement>("disconnect");
disconnect.title = "Your tabs stay open";
confirmTwice(disconnect, "Click again to disconnect", () => void run({ type: "disconnect" }));

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || busy) return;
  void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
});

void run({ type: "getStatus", refresh: true });
