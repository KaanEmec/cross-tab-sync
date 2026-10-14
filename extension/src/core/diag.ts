// Diagnostics trace readable outside the browser. Off unless enabled (by default: the server is a
// loopback address, i.e. local development). When on, each line goes to the console and, in
// Safari, to the native host, which logs it with os_log ("CTS-DIAG:" prefix; read it with
// `log show --predicate 'process == "Cross-Tab-Sync Extension"'`). Never pass URLs or tokens:
// event kinds, tab ids, entry id prefixes, op types, run names, status codes and error messages
// only. Anything that looks like a URL is masked anyway.

import type { KeyValueStorage } from "../adapter/types.js";

let enabled = false;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;

/** Local development server: localhost, *.localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Whether diagnostics are on: the stored `diagnostics` flag, else the loopback rule. */
export function diagnosticsOn(s: { serverUrl: string; diagnostics?: boolean | null }): boolean {
  return s.diagnostics ?? isLoopbackUrl(s.serverUrl);
}

export function setDiagnostics(on: boolean): void {
  enabled = on;
}

/** Re-read the switch from storage (two keys; cheap enough per queued task). */
export async function refreshDiagnostics(storage: KeyValueStorage): Promise<void> {
  const raw = await storage.get(["cts.serverUrl", "cts.diagnostics"]);
  const serverUrl = typeof raw["cts.serverUrl"] === "string" ? raw["cts.serverUrl"] : "";
  const flag = raw["cts.diagnostics"];
  enabled = diagnosticsOn({ serverUrl, diagnostics: typeof flag === "boolean" ? flag : null });
}

/** First 8 characters of an entry id. */
export const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "-");

/** Error message for a trace line. */
export const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function diag(msg: string): void {
  if (!enabled) return;
  const line = msg.replace(URL_LIKE, "<url>");
  console.log("[cts] " + line);
  try {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
    if (typeof runtime?.sendNativeMessage !== "function") return;
    const sent = runtime.sendNativeMessage("application.id", { diag: line }) as unknown;
    if (sent instanceof Promise) sent.catch(() => undefined);
  } catch {
    // No native host (or not Safari): the console line is enough.
  }
}
