// Invite links (PROTOCOL.md "Sessions and pairing"): the server URL with the code and the
// encryption key as the fragment, https://tabs.example.com#ABCD2345.<key>. A link without the key
// is invalid. Parsing of what the user pastes into the pairing form, and the server Start syncing
// uses. Pure.

import { normalizeServerUrl, type BrowserKind } from "./client.js";
import { DEFAULT_SERVER_URL } from "./config.js";
import { decodeKey } from "./crypto.js";

export const CODE_LENGTH = 8;

const SHAPE = "It ends with #CODE.KEY.";
const COPY_AGAIN = "Copy the whole invite link from your other browser again.";

export interface PairingTarget {
  serverUrl: string;
  code: string;
  /** Encryption key carried by the invite link. */
  key: string;
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
    throw new Error(`This invite link is incomplete. ${COPY_AGAIN}`);
  }
  return code;
}

/** The invite link for a code on a server: `https://tabs.example.com#ABCD2345.<key>`. */
export function pairingLink(serverUrl: string, code: string, key: string): string {
  return `${serverUrl}#${code}.${key}`;
}

/** Parse a pasted invite link. Throws an Error with a message for the user. */
export function parsePairingInput(input: string): PairingTarget {
  const text = input.trim();
  if (!text) throw new Error(`Paste the invite link from your other browser. ${SHAPE}`);
  const hash = text.indexOf("#");
  if (hash < 0) throw new Error(`This is not a whole invite link. ${SHAPE} ${COPY_AGAIN}`);
  const fragment = text.slice(hash + 1).trim();
  const dot = fragment.indexOf(".");
  if (dot < 0) {
    throw new Error(`This link has no encryption key, so it cannot be used. ${COPY_AGAIN}`);
  }
  const base = text.slice(0, hash).trim();
  if (!base) throw new Error(`This invite link has no server address. ${COPY_AGAIN}`);
  const serverUrl = normalizeServerUrl(withScheme(base));
  const code = checkCode(fragment.slice(0, dot));
  const key = fragment.slice(dot + 1).trim();
  if (!isKey(key)) throw new Error(`The encryption key in this link is incomplete or damaged. ${COPY_AGAIN}`);
  return { serverUrl, code, key };
}

/** A bare host (`tabs.example.com`) means https. */
function withScheme(address: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`;
}

/** The server Start syncing uses: Advanced › Server URL (a bare host means https), else the default server. */
export function startServerUrl(advanced: string): string {
  return normalizeServerUrl(withScheme(advanced.trim() || DEFAULT_SERVER_URL));
}

/** Which form action a pairing submit runs: an explicit button wins; otherwise Join once the invite field is shown. */
export function pairSubmitAction(joinOpen: boolean, clicked: "start" | "join" | null): "start" | "join" {
  return clicked ?? (joinOpen ? "join" : "start");
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
