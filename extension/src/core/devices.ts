// Device identity for the popup: short ids, the owner line and the device list rows. Pure.

import type { Device, Owner } from "./client.js";
import { browserLabel } from "./pairing.js";

/** First 8 characters of a device id: enough to tell devices apart, shown next to names. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** "just now", "5 min ago", "3 h ago", else a local date and time. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const secs = Math.round((now - Date.parse(iso)) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

/** "Brave on macOS (1a2b3c4d)", with ", this device" for the local device. */
export function ownerLine(owner: Owner | null, selfId: string | null): string {
  if (!owner) return "No owner";
  const label = `${owner.name} (${shortId(owner.deviceId)})`;
  return owner.deviceId === selfId ? `${label}, this device` : label;
}

export interface DeviceRow {
  id: string;
  title: string;
  detail: string;
  isSelf: boolean;
  revoked: boolean;
  /** Revoke is offered for other active devices; this device uses Disconnect. */
  canRevoke: boolean;
}

/** Rows for the Devices list, in server order (active devices, then recently revoked ones). */
export function deviceRows(devices: Device[], now: number): DeviceRow[] {
  return devices.map((d) => {
    const revoked = Boolean(d.revokedAt);
    const seen = revoked ? `revoked ${relativeTime(d.revokedAt, now)}` : `last seen ${relativeTime(d.lastSeenAt, now)}`;
    return {
      id: d.id,
      title: d.isSelf ? `${d.name} (this device)` : d.name,
      detail: `${browserLabel(d.browser)} · ${shortId(d.id)} · ${seen}`,
      isSelf: d.isSelf,
      revoked,
      canRevoke: !d.isSelf && !revoked,
    };
  });
}
