// Diagnostics trace readable outside the browser. Off unless enabled (by default: the server is a
// loopback address, i.e. local development). When on, each line goes to the console, in Safari to
// the native host (os_log, "CTS-DIAG:" prefix), and to the server's `POST /v1/diag` (logged only
// with CTS_DEBUG=1; batched about every second and after each queued task). Never pass URLs or tokens:
// event kinds, tab ids, entry id prefixes, op types, run names, status codes and error messages
// only. Anything that looks like a URL is masked anyway.

import type { KeyValueStorage } from "../adapter/types.js";

let enabled = false;

/** Lines per `POST /v1/diag` (the server accepts 200 of 300 characters, bodies up to 64 KiB). */
const POST_LINES = 100;
const LINE_CHARS = 300;
/** Lines kept while the server cannot be reached; the oldest are dropped. */
const MAX_BUFFER = 500;
export const DIAG_FLUSH_MS = 1_000;

/** Sends lines to the server (set by the engine); null: no server trace. */
type Sink = (lines: string[]) => Promise<void>;
let sink: Sink | null = null;
let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let posting = false;
/** The server answered 404 (no CTS_DEBUG): stop posting until the worker restarts. */
let rejected = false;

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
  remember(line);
  try {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
    if (typeof runtime?.sendNativeMessage !== "function") return;
    const sent = runtime.sendNativeMessage("application.id", { diag: line }) as unknown;
    if (sent instanceof Promise) sent.catch(() => undefined);
  } catch {
    // No native host (or not Safari): the console line is enough.
  }
}

/** Where `flushDiag` posts; tests and the engine set it. Resets the 404 stop and the buffer. */
export function setDiagSink(fn: Sink | null): void {
  sink = fn;
  buffer = [];
  rejected = false;
}

function remember(line: string): void {
  if (!sink || rejected) return;
  buffer.push(line.slice(0, LINE_CHARS));
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushDiag();
  }, DIAG_FLUSH_MS);
}

/** Post buffered lines now (fire-and-forget). Errors are swallowed; a 404 stops posting. */
export function flushDiag(): void {
  if (!sink || rejected || posting || buffer.length === 0) return;
  const lines = buffer.splice(0, POST_LINES);
  posting = true;
  sink(lines)
    .catch((e: unknown) => {
      if ((e as { status?: unknown } | null)?.status === 404) {
        rejected = true;
        buffer = [];
      }
    })
    .finally(() => {
      posting = false;
      if (buffer.length > 0) schedule();
    });
}
