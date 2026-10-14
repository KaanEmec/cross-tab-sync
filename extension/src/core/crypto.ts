// End-to-end URL encryption (PROTOCOL.md "Encryption"). WebCrypto only. The root key travels only
// in pairing-link fragments; never log keys, URLs or ciphertexts.

/** A sealed URL as the server stores it. */
export interface UrlFields {
  urlKey: string;
  urlEnc: string;
}

export interface Cipher {
  seal(url: string): Promise<UrlFields>;
  /** Throws KeyMismatchError when the fields were not sealed with this key (or were tampered with). */
  open(fields: UrlFields): Promise<string>;
}

/** Decryption failed: the data was sealed with a different key, or altered. */
export class KeyMismatchError extends Error {
  constructor(message = "This URL was encrypted with a different key") {
    super(message);
    this.name = "KeyMismatchError";
  }
}

/** A root key: 32 bytes as 43 base64url characters without padding. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BLOCK = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("Invalid base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A fresh random root key (the first browser of an empty session generates it). */
export function generateKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The 32 key bytes. Throws for anything but a canonical 43-character base64url key. */
export function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const bytes = KEY_PATTERN.test(key) ? fromBase64url(key) : null;
  if (!bytes || bytes.length !== 32 || base64url(bytes) !== key) throw new Error("Invalid encryption key");
  return bytes;
}

/** 2-byte big-endian length, UTF-8 URL, zeros up to a multiple of 64 bytes. */
function pad(url: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(url);
  if (bytes.length > 0xffff) throw new Error("URL too long");
  const out = new Uint8Array(Math.ceil((bytes.length + 2) / BLOCK) * BLOCK);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

/** HMAC and AES-GCM keys derived from the root key (HKDF-SHA256, empty salt). */
async function deriveKeys(key: string): Promise<{ mac: CryptoKey; enc: CryptoKey }> {
  const root = await crypto.subtle.importKey("raw", decodeKey(key), "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) });
  const mac = await crypto.subtle.deriveKey(hkdf("cts-url-mac"), root, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const enc = await crypto.subtle.deriveKey(hkdf("cts-url-enc"), root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { mac, enc };
}

const hmac = async (mac: CryptoKey, text: string) => base64url(new Uint8Array(await crypto.subtle.sign("HMAC", mac, encoder.encode(text))));

/** The session's key check: proves a browser holds the same key without revealing it. */
export async function keyCheck(key: string): Promise<string> {
  return hmac((await deriveKeys(key)).mac, "cts-key-check");
}

export async function createCipher(key: string): Promise<Cipher> {
  const { mac, enc } = await deriveKeys(key);
  return {
    async seal(url) {
      const urlKey = await hmac(mac, url);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const params = { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(urlKey) };
      const sealed = new Uint8Array(await crypto.subtle.encrypt(params, enc, pad(url)));
      const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
      out[0] = VERSION;
      out.set(nonce, 1);
      out.set(sealed, 1 + NONCE_BYTES);
      return { urlKey, urlEnc: base64url(out) };
    },
    /** Authenticated decryption, then the URL must hash to `urlKey` (the AAD alone binds only the pair). */
    async open({ urlKey, urlEnc }) {
      try {
        const raw = fromBase64url(urlEnc);
        if (raw.length < 1 + NONCE_BYTES + TAG_BYTES || raw[0] !== VERSION) throw new Error("format");
        const params = { name: "AES-GCM", iv: raw.slice(1, 1 + NONCE_BYTES), additionalData: encoder.encode(urlKey) };
        const plain = new Uint8Array(await crypto.subtle.decrypt(params, enc, raw.slice(1 + NONCE_BYTES)));
        const length = (plain[0]! << 8) | plain[1]!;
        if (plain.length % BLOCK !== 0 || length + 2 > plain.length) throw new Error("length");
        const url = decoder.decode(plain.subarray(2, 2 + length));
        if ((await hmac(mac, url)) !== urlKey) throw new Error("urlKey");
        return url;
      } catch {
        throw new KeyMismatchError();
      }
    },
  };
}

const ciphers = new Map<string, Cipher>();

/**
 * A cipher usable synchronously (keys are derived once per key string, on first use). For the
 * client factory, which is called per request batch.
 */
export function cipherFor(key: string): Cipher {
  let c = ciphers.get(key);
  if (!c) {
    const ready = createCipher(key);
    ready.catch(() => undefined); // reported by the first seal/open
    c = { seal: async (url) => (await ready).seal(url), open: async (f) => (await ready).open(f) };
    ciphers.set(key, c);
  }
  return c;
}

/** Drop derived keys from memory (disconnect, revocation, refused pairing). */
export function forgetCiphers(): void {
  ciphers.clear();
}
