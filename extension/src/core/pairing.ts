// Pairing links (PROTOCOL.md "Pairing"): the server URL with the code and the encryption key as
// the fragment, https://tabs.example.com#ABCD2345.<key>; server-made links carry only the code.
// Parsing of what the user pastes into the pairing form. Pure.

import { normalizeServerUrl, type BrowserKind } from "./client.js";
import { decodeKey } from "./crypto.js";

export const CODE_LENGTH = 8;

const EXAMPLE = "https://tabs.example.com#ABCD2345";
const SHAPE = "#CODE.KEY (or #CODE for the first browser)";

export interface PairingTarget {
  serverUrl: string;
  code: string;
  /** Encryption key carried by an invite link; absent for a keyless link or a bare code. */
  key?: string;
}

/** Uppercase and drop spaces and dashes, as the server does. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

/** A canonical 43-character base64url key (32 bytes). */
function isKey(text: string): boolean {
  try {
    decodeKey(text);
    return true;
  } catch {
    return false;
  }
}

/** Shape check only (8 letters or digits); the server decides whether the code is valid. */
function checkCode(raw: string): string {
  const code = normalizeCode(raw);
  if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(code)) {
    throw new Error(`A pairing code has ${CODE_LENGTH} letters and digits, e.g. ABCD2345`);
  }
  return code;
}

/** The link for a code on a server: `https://tabs.example.com#ABCD2345`, plus `.<key>` when given. */
export function pairingLink(serverUrl: string, code: string, key?: string): string {
  return key ? `${serverUrl}#${code}.${key}` : `${serverUrl}#${code}`;
}

/**
 * Parse a pasted pairing link, or a bare code when the server is already known (`knownServerUrl`,
 * e.g. from a previous pairing or the Advanced field). Throws an Error with a message for the user.
 */
export function parsePairingInput(input: string, knownServerUrl = ""): PairingTarget {
  const text = input.trim();
  if (!text) throw new Error(`Paste the pairing link, e.g. ${EXAMPLE}`);
  if (/^[A-Za-z0-9\s-]+$/.test(text)) {
    // A bare code: no scheme, host or fragment.
    const code = checkCode(text);
    if (!knownServerUrl.trim()) {
      throw new Error(`Paste the whole pairing link (server address and code, e.g. ${EXAMPLE}) or enter the server URL under Advanced`);
    }
    return { serverUrl: normalizeServerUrl(knownServerUrl), code };
  }
  const hash = text.indexOf("#");
  const fragment = hash < 0 ? "" : text.slice(hash + 1);
  if (!fragment.trim()) throw new Error(`This link has no pairing code. A pairing link ends with ${SHAPE}, e.g. ${EXAMPLE}`);
  let base = hash < 0 ? text : text.slice(0, hash);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base.trim())) base = `https://${base.trim()}`;
  const dot = fragment.indexOf(".");
  const serverUrl = normalizeServerUrl(base);
  const code = checkCode(dot < 0 ? fragment : fragment.slice(0, dot));
  if (dot < 0) return { serverUrl, code };
  const key = fragment.slice(dot + 1).trim();
  if (!isKey(key)) {
    throw new Error(`The encryption key in this link is incomplete or damaged. A pairing link ends with ${SHAPE}; copy the whole link again.`);
  }
  return { serverUrl, code, key };
}

/** The popup form: the link field wins; otherwise the Advanced code with the Advanced or known server URL. */
export function resolvePairingForm(form: { link: string; serverUrl: string; code: string }, knownServerUrl = ""): PairingTarget {
  return parsePairingInput(form.link.trim() ? form.link : form.code, form.serverUrl.trim() || knownServerUrl);
}

export function browserLabel(browser: string): string {
  if (browser === "safari") return "Safari";
  if (browser === "brave") return "Brave";
  return browser ? browser[0]!.toUpperCase() + browser.slice(1) : "Browser";
}

/** Prefilled device name, "<Browser> on <OS>"; `os` is `runtime.getPlatformInfo().os`. */
export function defaultDeviceName(browser: BrowserKind, os: string): string {
  const osName = { mac: "macOS", win: "Windows", linux: "Linux", cros: "ChromeOS" }[os] ?? "";
  return osName ? `${browserLabel(browser)} on ${osName}` : browserLabel(browser);
}
