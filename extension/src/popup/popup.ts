import { storageLocal } from "../adapter/webext.js";
import type { Request, Response, StatusView } from "../core/messages.js";
import { saveState } from "../core/state.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pairView = $<HTMLFormElement>("pair-view");
const mainView = $("main-view");
const errorEl = $("error");
const badge = $("badge");
const serverUrl = $<HTMLInputElement>("server-url");
const deviceName = $<HTMLInputElement>("device-name");
const pairCode = $<HTMLInputElement>("pair-code");
const buttons = Array.from(document.querySelectorAll("button"));

let busy = false;
let reachable: boolean | undefined;

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
  badge.textContent = reachable === false ? "Offline" : s.isOwner ? "Owner" : "Follower";
  badge.classList.toggle("owner", s.isOwner && reachable !== false);

  const o = s.owner;
  $("owner").textContent = !o
    ? "No owner"
    : o.deviceId === s.deviceId
      ? `This device (gen. ${o.generation})`
      : `${o.name} (gen. ${o.generation})`;
  $("last-sync").textContent = relative(s.lastSync);
  $("pending").textContent = String(s.pendingCount);
  $("status-text").textContent = s.running ? "Working…" : (s.statusText ?? "");
  $("identity").textContent = `${s.deviceName} · ${hostOf(s.serverUrl)}`;
  $("identity").title = s.serverUrl;

  const handOver = $<HTMLButtonElement>("hand-over");
  const continueHere = $<HTMLButtonElement>("continue-here");
  handOver.classList.toggle("primary", s.isOwner);
  continueHere.classList.toggle("primary", !s.isOwner);
  handOver.disabled = busy || s.running || !s.isOwner;
  handOver.title = s.isOwner ? "Publish this browser's tabs and release control" : "Only the owner can hand over";
  continueHere.disabled = busy || s.running;

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
  for (const b of buttons) b.disabled = value;
  if (value) $("status-text").textContent = "Working…";
}

async function run(req: Request): Promise<Response> {
  setBusy(true);
  const res = await send(req);
  if (res.ok && req.type !== "getStatus") reachable = true;
  busy = false;
  for (const b of buttons) b.disabled = false;
  if (res.status) render(res.status);
  if (!res.ok) showError(res.error);
  return res;
}

/** Host permission for the backend origin; must be requested from a user gesture. */
async function requestOrigin(url: string): Promise<boolean> {
  let pattern: string;
  try {
    const u = new URL(url.trim());
    pattern = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return true; // let the worker report the invalid URL
  }
  if (!chrome.permissions?.request) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    // Engines without optional host permission support rely on install-time access instead.
    return true;
  }
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
      showError("Permission to reach the server was denied. Pairing needs access to the server address.");
      return;
    }
    const res = await run({ type: "pair" });
    if (res.ok) pairCode.value = "";
  });
});

$("hand-over").addEventListener("click", () => void run({ type: "handOver" }));
$("continue-here").addEventListener("click", () => void run({ type: "continueHere" }));

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

$("disconnect").addEventListener("click", () => {
  if (confirm("Disconnect this browser from the sync server? Your tabs stay open.")) void run({ type: "disconnect" });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || busy) return;
  void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
});

void run({ type: "getStatus", refresh: true });
