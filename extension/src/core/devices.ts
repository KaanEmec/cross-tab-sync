// View model for the popup: device identity, the hero (relay, status line, detail line), the
// primary action, device and snapshot rows. Pure: no DOM, no chrome.* calls.

import type { ActivityKind } from "./activity.js";
import type { Device, Owner, Snapshot } from "./client.js";
import type { Request, StatusView } from "./messages.js";
import { browserLabel } from "./pairing.js";
import { clock } from "./status.js";

/** First 8 characters of a device id: enough to tell devices apart, shown next to names. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a local date. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const secs = Math.round((now - Date.parse(iso)) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  const days = Math.round(secs / 86400);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}

/** Finer than relativeTime, for the hero line that ticks every second: "just now", "12 s ago", "5 min ago", "3 h ago". */
export function secondsAgo(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs} s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}

/** "Brave on macOS (1a2b3c4d)", with ", this device" for the local device. */
export function ownerLine(owner: Owner | null, selfId: string | null): string {
  if (!owner) return "No owner";
  const label = `${owner.name} (${shortId(owner.deviceId)})`;
  return owner.deviceId === selfId ? `${label}, this device` : label;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------------------------
// Hero

/** State color of the hero: driving, following (or nobody), paused, error, not connected. */
export type Tone = "ok" | "neutral" | "warn" | "bad" | "off";
/** Which relay dot is filled: this browser (left), the other side (right), or neither. */
export type Driver = "self" | "other" | "none";

export interface HeroContext {
  now: number;
  /** The browser is offline or the last refresh could not reach the server. */
  offline: boolean;
  /** A popup action or a worker sync is in progress. */
  working: boolean;
  /** The device list when it has been loaded, for the right-hand relay label. */
  devices: Device[] | null;
}

export interface HeroView {
  tone: Tone;
  driver: Driver;
  /** Status line: "This browser is driving", "Following Safari on macOS", … */
  title: string;
  /** Muted line under it: "Saved 12 s ago", "3 changes waiting, retrying at 10:42", … */
  detail: string;
  selfLabel: string;
  otherLabel: string;
}

function driverOf(s: StatusView): Driver {
  if (!s.paired) return "none";
  if (s.isOwner) return "self";
  return s.owner ? "other" : "none";
}

function toneOf(s: StatusView): Tone {
  if (s.lastError) return "bad";
  if (!s.paired) return "off";
  if (s.paused) return "warn";
  return s.isOwner ? "ok" : "neutral";
}

export function heroTitle(s: StatusView): string {
  if (!s.paired) return "Not connected";
  if (s.paused) return "Paused";
  if (s.isOwner) return "This browser is driving";
  return s.owner ? `Following ${s.owner.name}` : "Nobody is driving";
}

/** Where local work stands, in one short line. */
export function heroDetail(s: StatusView, ctx: Pick<HeroContext, "now" | "offline" | "working">): string {
  if (!s.paired) return "Paste a pairing link from another browser or your server.";
  if (ctx.working) return "Syncing now";
  const n = s.pendingCount;
  const waiting = plural(n, "change") + " waiting";
  const retry = s.nextRetryAt !== null ? `retrying at ${clock(s.nextRetryAt)}` : null;
  if (s.paused) return n > 0 ? `${waiting}, kept until you resume` : "Tabs are not shared until you resume";
  if (ctx.offline || !s.online) {
    if (n > 0) return `Offline, ${waiting}`;
    return retry ? `Offline, ${retry}` : "Offline";
  }
  if (n > 0) return retry ? `${waiting}, ${retry}` : waiting;
  if (!s.lastSuccessAt) return "Not synced yet";
  return `${s.isOwner ? "Saved" : "Synced"} ${secondsAgo(s.lastSuccessAt, ctx.now)}`;
}

/** Right-hand relay label: the driver's name when following, else the other browsers. */
function otherLabel(s: StatusView, devices: Device[] | null): string {
  if (s.paired && !s.isOwner && s.owner) return s.owner.name;
  if (!s.paired || !devices) return "Other browsers";
  const others = devices.filter((d) => !d.isSelf && !d.revokedAt);
  if (others.length === 0) return "No other browsers";
  if (others.length === 1) return others[0]!.name;
  return `${others.length} other browsers`;
}

export function heroView(s: StatusView, ctx: HeroContext): HeroView {
  return {
    tone: toneOf(s),
    driver: driverOf(s),
    title: heroTitle(s),
    detail: heroDetail(s, ctx),
    selfLabel: s.paired && s.deviceName ? s.deviceName : "This browser",
    otherLabel: otherLabel(s, ctx.devices),
  };
}

// ---------------------------------------------------------------------------------------------
// Actions and errors

export interface PrimaryAction {
  label: "Hand over" | "Continue here" | "Resume sync";
  request: Extract<Request["type"], "handOver" | "continueHere" | "resume">;
  title: string;
}

/** The one primary button: Hand over when driving, Continue here otherwise, Resume sync while paused. */
export function primaryAction(s: StatusView): PrimaryAction {
  if (s.paused) return { label: "Resume sync", request: "resume", title: "Start syncing this browser again" };
  if (s.isOwner) return { label: "Hand over", request: "handOver", title: "Save this browser's tabs and let another browser drive" };
  return { label: "Continue here", request: "continueHere", title: "Open the shared tabs here and drive from this browser" };
}

/** The single fix offered next to an error: grant host access, or retry a retryable failure. */
export function errorFix(s: Pick<StatusView, "lastError" | "errorKind">): "grant" | "retry" | null {
  if (!s.lastError) return null;
  if (s.errorKind === "permission") return "grant";
  if (s.errorKind === "unreachable" || s.errorKind === "server") return "retry";
  return null;
}

const ACTIVITY_WORDS: Record<ActivityKind, string> = { activated: "Tab switch", focus: "Window focus", created: "New tab" };

/** "Tab switch, 10:22" (diagnostics for automatic ownership), or "None yet". */
export function activityLine(s: Pick<StatusView, "lastActivityAt" | "lastActivityKind">): string {
  if (s.lastActivityAt === null) return "None yet";
  const time = clock(s.lastActivityAt);
  return s.lastActivityKind ? `${ACTIVITY_WORDS[s.lastActivityKind] ?? s.lastActivityKind}, ${time}` : time;
}

// ---------------------------------------------------------------------------------------------
// Devices

export interface DeviceRow {
  id: string;
  name: string;
  /** "Brave", "Safari". */
  browser: string;
  shortId: string;
  /** "Seen 5 min ago". */
  seen: string;
  /** "Revoked 2 h ago", or null for active devices. */
  revokedNote: string | null;
  isSelf: boolean;
  revoked: boolean;
  /** Revoke is offered for other active devices; this device uses Disconnect. */
  canRevoke: boolean;
}

/** Rows for the Devices list, in server order (active devices, then recently revoked ones). */
export function deviceRows(devices: Device[], now: number): DeviceRow[] {
  return devices.map((d) => {
    const revoked = Boolean(d.revokedAt);
    const seen = relativeTime(d.lastSeenAt, now);
    return {
      id: d.id,
      name: d.name,
      browser: browserLabel(d.browser),
      shortId: shortId(d.id),
      seen: `Seen ${seen}`,
      revokedNote: revoked ? `Revoked ${relativeTime(d.revokedAt, now)}` : null,
      isSelf: d.isSelf,
      revoked,
      canRevoke: !d.isSelf && !revoked,
    };
  });
}

/** Devices summary: active browsers including this one, "2 browsers". */
export function devicesSummary(devices: Device[]): string {
  return plural(devices.filter((d) => !d.revokedAt).length, "browser");
}

// ---------------------------------------------------------------------------------------------
// Recovery

export interface SnapshotRow {
  id: number;
  /** Local date and time the snapshot was taken. */
  when: string;
  /** "This browser", a device name, or "A removed browser". */
  device: string;
  /** "12 tabs". */
  tabs: string;
  /** "Taken before a change", for the row's tooltip. */
  why: string;
}

export function snapshotRows(snaps: Snapshot[], selfId: string | null, devices: Device[]): SnapshotRow[] {
  const names = new Map(devices.map((d) => [d.id, d.name]));
  return snaps.map((s) => ({
    id: s.id,
    when: new Date(s.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    device: s.deviceId === selfId ? "This browser" : (names.get(s.deviceId) ?? "A removed browser"),
    tabs: plural(s.entryCount, "tab"),
    why: s.reason === "restore" ? "Taken before a restore" : "Taken before a change",
  }));
}

/** Snapshots shown before "Show all", so the popup stays within the screen. */
export const SNAPSHOT_LIMIT = 6;

/** The visible rows and, when some are hidden, the label of the button that shows them: "Show all 20". */
export function snapshotList<T>(rows: T[], expanded: boolean): { rows: T[]; more: string | null } {
  if (expanded || rows.length <= SNAPSHOT_LIMIT) return { rows, more: null };
  return { rows: rows.slice(0, SNAPSHOT_LIMIT), more: `Show all ${rows.length}` };
}

export function snapshotsSummary(count: number): string {
  return count === 0 ? "None yet" : plural(count, "snapshot");
}
