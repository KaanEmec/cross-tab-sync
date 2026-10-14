import { storageLocal } from "../adapter/webext.js";
import { originPattern, type Device, type Snapshot } from "../core/client.js";
import {
  activityLine,
  deviceRows,
  devicesSummary,
  errorFix,
  heroView,
  primaryAction,
  shortId,
  snapshotList,
  snapshotRows,
  snapshotsSummary,
} from "../core/devices.js";
import type { Request, Response, StatusView } from "../core/messages.js";
import { browserLabel, resolvePairingForm, type PairingTarget } from "../core/pairing.js";
import { saveState } from "../core/state.js";
import { APPLIED_ELSEWHERE_NOTE, clock } from "../core/status.js";

// ---------------------------------------------------------------------------------------------
// Elements

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const hero = $("hero");
const pairView = $<HTMLFormElement>("pair-view");
const mainView = $("main-view");
const errorBox = $("error");
const errorFixBtn = $<HTMLButtonElement>("error-fix");
const idChip = $<HTMLButtonElement>("id-chip");
const primaryBtn = $<HTMLButtonElement>("primary");
const syncNowBtn = $<HTMLButtonElement>("sync-now");
const pauseSwitch = $<HTMLButtonElement>("pause");
const pairLink = $<HTMLInputElement>("pair-link");
const pairTarget = $("pair-target");
const pairHint = Array.from(pairTarget.childNodes, (n) => n.cloneNode(true));
const serverUrl = $<HTMLInputElement>("server-url");
const deviceName = $<HTMLInputElement>("device-name");
const pairCode = $<HTMLInputElement>("pair-code");
const devicesSection = $<HTMLDetailsElement>("devices-section");
const recoverSection = $<HTMLDetailsElement>("recover-section");
const renameForm = $<HTMLFormElement>("rename-form");
const renameInput = $<HTMLInputElement>("rename-input");
const inviteLink = $<HTMLInputElement>("invite-link");
const buttons = () => Array.from(document.querySelectorAll("button"));

// ---------------------------------------------------------------------------------------------
// State

let busy = false;
/** Last known server reachability (only refreshes report it). */
let reachable: boolean | undefined;
let last: StatusView | null = null;
/** Device list, fetched once when paired and again when Devices opens. */
let devices: Device[] | null = null;
let devicesRequested = false;
/** Snapshot list, fetched when Recovery opens; the first SNAPSHOT_LIMIT are shown until "Show all". */
let snapshots: Snapshot[] | null = null;
let showAllSnapshots = false;
let errorKindShown: "grant" | "retry" | null = null;

async function send(req: Request): Promise<Response> {
  try {
    return (await chrome.runtime.sendMessage(req)) as Response;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Render

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(message: string | null, fix: "grant" | "retry" | null = null): void {
  $("error-text").textContent = message ?? "";
  errorBox.hidden = !message;
  errorKindShown = message ? fix : null;
  errorFixBtn.hidden = !errorKindShown;
  errorFixBtn.textContent = fix === "grant" ? "Grant access" : fix === "retry" ? "Retry now" : "";
}

function renderHero(s: StatusView): void {
  const working = busy || s.running;
  const offline = s.paired && (reachable === false || !s.online);
  const v = heroView(s, { now: Date.now(), offline, working, devices });
  hero.dataset.tone = v.tone;
  hero.dataset.driver = v.driver;
  hero.dataset.working = String(working);
  $("relay-self").textContent = v.selfLabel;
  $("relay-other").textContent = v.otherLabel;
  $("hero-title").textContent = v.title;
  const detail = $("hero-detail");
  detail.textContent = v.detail;
  // "Saved" is server receipt, not proof the other browsers opened the tabs.
  detail.title = s.paired && s.isOwner ? APPLIED_ELSEWHERE_NOTE : "";
  syncNowBtn.dataset.working = String(working);
}

function render(s: StatusView): void {
  last = s;
  if (s.reachable !== undefined) reachable = s.reachable;
  pairView.hidden = s.paired;
  mainView.hidden = !s.paired;
  idChip.hidden = !s.paired;
  renderHero(s);
  showError(s.lastError, errorFix(s));

  if (!s.paired) {
    devices = null;
    devicesRequested = false;
    snapshots = null;
    showAllSnapshots = false;
    // Known from a previous pairing: a bare code is then enough.
    if (!serverUrl.value) serverUrl.value = s.serverUrl;
    if (!deviceName.value) deviceName.value = s.deviceName;
    return;
  }

  const id = s.deviceId ?? "";
  $("id-chip-text").textContent = shortId(id);

  const blocked = busy || s.running;
  const action = primaryAction(s);
  primaryBtn.textContent = action.label;
  primaryBtn.title = action.title;
  primaryBtn.disabled = blocked;
  syncNowBtn.disabled = blocked || s.paused;
  const syncLabel = s.nextRetryAt !== null ? "Retry now" : "Sync now";
  syncNowBtn.title = syncLabel;
  syncNowBtn.setAttribute("aria-label", syncLabel);

  renderIdentity(s);
  renderSettings(s, blocked);
  if (!devicesRequested) {
    devicesRequested = true;
    void loadDevices(false);
  }
}

/** "This browser" block in Devices. */
function renderIdentity(s: StatusView): void {
  const id = s.deviceId ?? "";
  $("self-name").textContent = s.deviceName;
  $("self-browser").textContent = browserLabel(__BROWSER__);
  $("self-browser").title = s.pairedAt ? `Paired ${new Date(s.pairedAt).toLocaleString()}` : "";
  $("self-id").textContent = shortId(id);
  $("self-id").title = id;
}

function renderSettings(s: StatusView, blocked: boolean): void {
  pauseSwitch.setAttribute("aria-checked", String(!s.paused));
  pauseSwitch.title = s.paused ? "Resume sync" : "Pause sync";
  pauseSwitch.disabled = blocked;
  let host = s.serverUrl;
  try {
    host = new URL(s.serverUrl).host;
  } catch {
    /* keep the raw value */
  }
  $("settings-summary").textContent = s.paused ? "Paused" : host;
  const server = $("self-server");
  server.textContent = s.serverUrl;
  server.title = `${s.serverUrl}\nRevision ${s.lastRevision}` + (s.minRevision !== null ? `, server history from revision ${s.minRevision}` : "");
  $("last-activity").textContent = activityLine(s);
  $("last-result-row").hidden = !s.statusText;
  $("last-result").textContent = s.statusText ?? "";
}

function fill(list: HTMLElement, items: HTMLLIElement[], empty: string): void {
  if (items.length === 0) items = [el("li", "empty", empty)];
  list.replaceChildren(...items);
}

/** One list row: a title, a muted meta line of separate parts, and an optional trailing control. */
function row(title: string, meta: (string | HTMLElement)[], trailing?: HTMLElement, className = ""): HTMLLIElement {
  const li = el("li", className);
  const main = el("div", "row-main");
  const metaLine = el("span", "row-meta");
  for (const part of meta) metaLine.append(typeof part === "string" ? el("span", "", part) : part);
  main.append(el("span", "row-title", title), metaLine);
  li.append(main);
  if (trailing) li.append(trailing);
  return li;
}

function renderDevices(): void {
  if (!devices) return;
  $("devices-summary").textContent = devicesSummary(devices);
  const rows = deviceRows(devices, Date.now())
    .filter((d) => !d.isSelf)
    .map((d) => {
      const trailing = d.canRevoke ? confirmButton("Revoke", "Confirm revoke", () => void revoke(d.id), "text-btn danger") : el("span", "tag", "revoked");
      if (d.revokedNote) trailing.title = d.revokedNote;
      return row(d.name, [el("code", "", d.shortId), d.seen], trailing, d.revoked ? "revoked" : "");
    });
  fill($("devices"), rows, "No other browsers yet.");
  if (last) renderHero(last);
}

// ---------------------------------------------------------------------------------------------
// Behavior

/** Copy inside the click handler (user gesture); if the clipboard is unavailable, select the text instead. */
function copyText(text: string, source: HTMLElement, label: HTMLElement): void {
  const original = label.textContent;
  // A button with a glyph shows a check mark while it reads "Copied".
  const glyph = label.parentElement?.querySelector("use") ?? null;
  const glyphHref = glyph?.getAttribute("href") ?? "";
  const flash = (msg: string, done = false) => {
    label.textContent = msg;
    if (done) glyph?.setAttribute("href", "#i-check");
    setTimeout(() => {
      label.textContent = original;
      glyph?.setAttribute("href", glyphHref);
    }, 1500);
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
  navigator.clipboard.writeText(text).then(() => flash("Copied", true), select);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const b of buttons()) b.disabled = value;
  if (last) renderHero(last);
}

async function run(req: Request): Promise<Response> {
  setBusy(true);
  const res = await send(req);
  if (res.ok && req.type !== "getStatus") reachable = true;
  busy = false;
  for (const b of buttons()) b.disabled = false;
  if (res.status) render(res.status);
  else if (last) renderHero(last);
  if (!res.ok) showError(res.error);
  return res;
}

/** Two-step confirm inside the popup: confirm() may always return false in Safari popovers. */
function confirmTwice(btn: HTMLButtonElement, armedLabel: string, action: () => void): void {
  const label = btn.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedAt = 0;
  const disarm = () => {
    timer = null;
    btn.textContent = label;
    delete btn.dataset.armed;
  };
  btn.addEventListener("click", () => {
    if (timer !== null && Date.now() - armedAt < 400) return; // a double click is not a confirmation
    if (timer === null) {
      armedAt = Date.now();
      btn.textContent = armedLabel;
      btn.dataset.armed = "";
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    disarm();
    action();
  });
}

function confirmButton(label: string, armedLabel: string, action: () => void, className: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  confirmTwice(b, armedLabel, action);
  return b;
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

async function loadDevices(reportErrors = true): Promise<void> {
  const res = await send({ type: "listDevices" });
  if (!res.ok) {
    if (reportErrors) showError(res.error);
    return;
  }
  devices = res.devices ?? [];
  renderDevices();
}

async function loadSnapshots(): Promise<void> {
  const [snaps, devs] = await Promise.all([send({ type: "listSnapshots" }), send({ type: "listDevices" })]);
  if (!snaps.ok) return showError(snaps.error);
  if (devs.ok) {
    devices = devs.devices ?? [];
    renderDevices();
  }
  snapshots = snaps.snapshots ?? [];
  renderSnapshots();
}

function renderSnapshots(): void {
  if (!snapshots) return;
  $("snapshots-summary").textContent = snapshotsSummary(snapshots.length);
  const view = snapshotList(snapshotRows(snapshots, last?.deviceId ?? null, devices ?? []), showAllSnapshots);
  const items = view.rows.map((r) => {
    let li: HTMLLIElement;
    const restore = confirmButton(
      "Restore",
      "Confirm restore",
      () => {
        li.classList.add("restoring"); // only the restore in flight dims its row
        void run({ type: "restoreSnapshot", id: r.id }).then(async (res) => {
          li.classList.remove("restoring");
          if (res.ok) await loadSnapshots();
        });
      },
      "btn small secondary",
    );
    li = row(r.when, [r.device, r.tabs], restore);
    li.title = r.why;
    return li;
  });
  if (view.more) {
    const more = el("button", "text-btn", view.more);
    more.type = "button";
    more.addEventListener("click", () => {
      showAllSnapshots = true;
      renderSnapshots();
    });
    const li = el("li", "more");
    li.append(more);
    items.push(li);
  }
  fill($("snapshots"), items, "No snapshots yet.");
}

async function revoke(id: string): Promise<void> {
  if ((await run({ type: "revokeDevice", id })).ok) await loadDevices();
}

function pairingTarget(): PairingTarget {
  return resolvePairingForm({ link: pairLink.value, serverUrl: serverUrl.value, code: pairCode.value }, last?.serverUrl ?? "");
}

function showRename(open: boolean): void {
  renameForm.hidden = !open;
  $("self-name-line").hidden = open;
  if (open) {
    renameInput.value = last?.deviceName ?? "";
    renameInput.focus();
    renameInput.select();
  } else {
    $("rename").focus();
  }
}

// ---------------------------------------------------------------------------------------------
// Events

pairLink.addEventListener("input", () => {
  let host = "";
  try {
    host = new URL(pairingTarget().serverUrl).host;
  } catch {
    /* not a complete link yet */
  }
  if (host) pairTarget.textContent = `Pairs with ${host}`;
  else pairTarget.replaceChildren(...pairHint.map((n) => n.cloneNode(true)));
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
  if (!deviceName.value.trim()) return showError("Enter a name for this browser.");
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
      showError("Pairing needs access to the server, and access was not granted for this address.");
      return;
    }
    const res = await run({ type: "pair" });
    if (res.ok) pairLink.value = pairCode.value = "";
  });
});

primaryBtn.addEventListener("click", () => {
  if (last) void run({ type: primaryAction(last).request });
});
syncNowBtn.addEventListener("click", () => void run({ type: "syncNow" }));
pauseSwitch.addEventListener("click", () => void run({ type: last?.paused ? "resume" : "pause" }));

errorFixBtn.addEventListener("click", () => {
  if (errorKindShown === "retry") return void run({ type: "syncNow" });
  void requestOrigin(last?.serverUrl ?? "").then(async (ok) => {
    if (ok) await run({ type: "syncNow" });
  });
});

// Opening Devices refreshes the list (and backfills pairedAt for devices paired before it was kept).
devicesSection.addEventListener("toggle", () => void (devicesSection.open && loadDevices()));
recoverSection.addEventListener("toggle", () => void (recoverSection.open && loadSnapshots()));

idChip.addEventListener("click", () => copyText(last?.deviceId ?? "", $("id-chip-text"), $("id-chip-text")));
$("copy-id").addEventListener("click", () => copyText(last?.deviceId ?? "", $("self-id"), $("copy-id")));
$("copy-link").addEventListener("click", () => copyText(inviteLink.value, inviteLink, $("copy-link").querySelector("span")!));

$("rename").addEventListener("click", () => showRename(true));
$("rename-cancel").addEventListener("click", () => showRename(false));
renameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    showRename(false);
  }
});
renameForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = renameInput.value.trim();
  if (!name) return showError("Enter a name for this browser.");
  void run({ type: "renameDevice", name }).then(async (res) => {
    if (!res.ok) return;
    showRename(false);
    await loadDevices();
  });
});

$("invite").addEventListener("click", async () => {
  const res = await run({ type: "createPairingCode" });
  if (!res.ok || !res.pairingCode) return;
  const { link, expiresAt } = res.pairingCode;
  inviteLink.value = link;
  $("invite-note").textContent = `Valid until ${clock(Date.parse(expiresAt))}, single use. Paste it into Cross-Tab-Sync in the other browser.`;
  $("invite-box").hidden = false;
  inviteLink.focus();
  inviteLink.select();
});

confirmTwice(
  $<HTMLButtonElement>("disconnect"),
  "Click again to disconnect. Pairing again gives this browser a new identity.",
  () => void run({ type: "disconnect" }),
);

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || busy) return;
  void send({ type: "getStatus" }).then((res) => res.status && render(res.status));
});

// Keep "Saved 12 s ago" current while the popup is open.
setInterval(() => {
  if (last && !busy) renderHero(last);
}, 1000);

void run({ type: "getStatus", refresh: true });
