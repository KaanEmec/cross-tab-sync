// End-to-end URL encryption (PROTOCOL.md "Encryption").
import { describe, expect, it } from "vitest";
import {
  base64url,
  cipherFor,
  createCipher,
  decodeKey,
  fromBase64url,
  generateKey,
  KeyMismatchError,
} from "../src/core/crypto.js";

const URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

/** Plaintext bytes inside a sealed URL: version, nonce and the 16-byte tag removed. */
const paddedLength = (urlEnc: string) => fromBase64url(urlEnc).length - 1 - 12 - 16;

describe("keys", () => {
  it("generates 32 random bytes as 43 base64url characters", () => {
    const k = generateKey();
    expect(k).toMatch(URL_KEY);
    expect(decodeKey(k)).toHaveLength(32);
    expect(generateKey()).not.toBe(k);
  });

  it("round-trips base64url without padding", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 250) & 0xff);
      const text = base64url(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(fromBase64url(text)).toEqual(bytes);
    }
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
    expect(() => fromBase64url("a+b")).toThrow();
    expect(() => fromBase64url("abcde")).toThrow();
  });

  it.each([[""], ["x".repeat(42)], ["x".repeat(44)], ["+".repeat(43)], ["AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9"]])(
    "rejects the key %j",
    (key) => {
      expect(() => decodeKey(key)).toThrow(/Invalid encryption key/);
    },
  );

  it("decodes a known key", () => {
    const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    expect([...decodeKey(key)]).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });
});

describe("cipher", () => {
  const url = "https://example.com/ä/path?q=1&r=%20#frag";

  it("round-trips a URL", async () => {
    const c = await createCipher(generateKey());
    const sealed = await c.seal(url);
    expect(sealed.urlKey).toMatch(URL_KEY);
    expect(sealed.urlEnc).toMatch(B64URL);
    expect(sealed.urlEnc).not.toContain("example");
    expect(fromBase64url(sealed.urlEnc)[0]).toBe(0x01);
    expect(await c.open(sealed)).toBe(url);
  });

  it("derives a deterministic urlKey per key, with distinct nonces per seal", async () => {
    const key = generateKey();
    const [a, b] = [await createCipher(key), await createCipher(key)];
    const [s1, s2] = [await a.seal(url), await b.seal(url)];
    expect(s1.urlKey).toBe(s2.urlKey);
    expect(s1.urlEnc).not.toBe(s2.urlEnc);
    expect(fromBase64url(s1.urlEnc).slice(1, 13)).not.toEqual(fromBase64url(s2.urlEnc).slice(1, 13));
    expect(await b.open(s1)).toBe(url);
    expect((await a.seal(url + "x")).urlKey).not.toBe(s1.urlKey);
    const other = await createCipher(generateKey());
    expect((await other.seal(url)).urlKey).not.toBe(s1.urlKey);
  });

  it("matches HMAC-SHA256 under the HKDF-derived key (cross-implementation check)", async () => {
    const key = generateKey();
    const root = await crypto.subtle.importKey("raw", decodeKey(key), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("cts-url-mac") },
      root,
      256,
    );
    const mac = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", mac, encoder.encode(url))));
    expect((await (await createCipher(key)).seal(url)).urlKey).toBe(expected);
  });

  it("throws KeyMismatchError for a different key or a tampered ciphertext", async () => {
    const c = await createCipher(generateKey());
    const sealed = await c.seal(url);
    const other = await createCipher(generateKey());
    await expect(other.open(sealed)).rejects.toBeInstanceOf(KeyMismatchError);

    const raw = fromBase64url(sealed.urlEnc);
    for (const i of [0, 5, 20, raw.length - 1]) {
      const bad = raw.slice();
      bad[i] = bad[i]! ^ 0x01;
      await expect(c.open({ ...sealed, urlEnc: base64url(bad) })).rejects.toBeInstanceOf(KeyMismatchError);
    }
    await expect(c.open({ ...sealed, urlEnc: base64url(raw.slice(0, 20)) })).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(c.open({ ...sealed, urlEnc: "not base64!" })).rejects.toBeInstanceOf(KeyMismatchError);
  });

  it("binds the ciphertext to its urlKey (AAD): swapping urlKeys fails", async () => {
    const c = await createCipher(generateKey());
    const a = await c.seal("https://a.example/");
    const b = await c.seal("https://b.example/");
    await expect(c.open({ urlKey: b.urlKey, urlEnc: a.urlEnc })).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(c.open({ urlKey: a.urlKey, urlEnc: b.urlEnc })).rejects.toBeInstanceOf(KeyMismatchError);
  });

  it("pads to multiples of 64 bytes so lengths are hidden", async () => {
    const c = await createCipher(generateKey());
    const lengthOf = async (n: number) => paddedLength((await c.seal("https://e/" + "x".repeat(n - 10))).urlEnc);
    expect(await lengthOf(10)).toBe(64);
    expect(await lengthOf(62)).toBe(64); // 2-byte length prefix + 62 bytes
    expect(await lengthOf(63)).toBe(128);
    expect(await lengthOf(100)).toBe(128);
    // Same block, same ciphertext length.
    const [s1, s2] = [await c.seal("https://e/a"), await c.seal("https://e/" + "b".repeat(40))];
    expect(s1.urlEnc.length).toBe(s2.urlEnc.length);
  });

  it("keeps a 2048-byte URL within 2856 characters and round-trips it", async () => {
    const c = await createCipher(generateKey());
    const prefix = "https://long.example/";
    const long = prefix + "x" + "é".repeat(1013);
    expect(encoder.encode(long).length).toBe(2048);
    const sealed = await c.seal(long);
    expect(sealed.urlEnc.length).toBeLessThanOrEqual(2856);
    expect(paddedLength(sealed.urlEnc) % 64).toBe(0);
    expect(await c.open(sealed)).toBe(long);
  });

  it("cipherFor derives once per key and reports a bad key on use", async () => {
    const key = generateKey();
    expect(cipherFor(key)).toBe(cipherFor(key));
    const sealed = await cipherFor(key).seal(url);
    expect(await (await createCipher(key)).open(sealed)).toBe(url);
    await expect(cipherFor("nope").seal(url)).rejects.toThrow(/Invalid encryption key/);
  });
});
