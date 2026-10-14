import type { TabInfo, WindowInfo } from "../adapter/types.js";

/** Server limit on URL length, in UTF-8 bytes (PROTOCOL.md "Operations rules"). */
export const MAX_URL_BYTES = 2048;

const encoder = new TextEncoder();

/** A '%' not followed by two hex digits: Go's url.Parse (the server) rejects these. */
const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * A URL that may be shared. Pages on the sync server's own origin (`serverUrl`) never are: an
 * invite link opened as a page there would leak its key fragment into the shared tabs.
 */
export function isShareableUrl(url: string | undefined, serverUrl = ""): url is string {
  if (!url) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (BAD_ESCAPE.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;
    if (serverUrl && parsed.origin === originOf(serverUrl)) return false;
  } catch {
    return false;
  }
  return encoder.encode(url).length <= MAX_URL_BYTES;
}

export type EligibleTab = TabInfo & { url: string };

/**
 * Eligible tab: http/https URL (not on the server's origin), in a normal (non-private) window, not incognito.
 * Tabs whose window is unknown are excluded.
 */
export function eligibleTabs(tabs: TabInfo[], windows: WindowInfo[], serverUrl = ""): EligibleTab[] {
  const normal = new Set(windows.filter((w) => w.type === "normal" && !w.incognito).map((w) => w.id));
  return tabs
    .filter((t): t is EligibleTab => !t.incognito && normal.has(t.windowId) && isShareableUrl(t.url, serverUrl))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}
