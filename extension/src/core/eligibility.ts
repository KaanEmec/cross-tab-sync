import type { TabInfo, WindowInfo } from "../adapter/types.js";

/** Server limit on URL length, in UTF-8 bytes (PROTOCOL.md "Operations rules"). */
export const MAX_URL_BYTES = 2048;

const encoder = new TextEncoder();

export function isShareableUrl(url: string | undefined): url is string {
  if (!url) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return encoder.encode(url).length <= MAX_URL_BYTES;
}

export type EligibleTab = TabInfo & { url: string };

/**
 * Eligible tab: http/https URL, in a normal (non-private) window, not incognito.
 * Tabs whose window is unknown are excluded.
 */
export function eligibleTabs(tabs: TabInfo[], windows: WindowInfo[]): EligibleTab[] {
  const normal = new Set(windows.filter((w) => w.type === "normal" && !w.incognito).map((w) => w.id));
  return tabs
    .filter((t): t is EligibleTab => !t.incognito && normal.has(t.windowId) && isShareableUrl(t.url))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}
