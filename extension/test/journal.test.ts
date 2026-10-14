import { describe, expect, it } from "vitest";
import { createCipher, generateKey } from "../src/core/crypto.js";
import type { Operation } from "../src/core/client.js";
import { acknowledge, append, batches, list, MAX_BATCH_BYTES, newOpId, pendingEntryIds, wireSize } from "../src/core/journal.js";

const open = (n: number, url = `https://e/${n}`): Operation => ({ opId: `op${n}`, type: "open", entryId: `e${n}`, url });

describe("journal", () => {
  it("generates UUID op ids", () => {
    expect(newOpId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newOpId()).not.toBe(newOpId());
  });

  it("appends in order and acknowledges by opId", () => {
    let j = append([], [open(1), open(2), open(3)]);
    j = acknowledge(j, ["op2"]);
    expect(list(j).map((o) => o.opId)).toEqual(["op1", "op3"]);
  });

  it("is replay safe: re-appending a known opId keeps one copy with the same id", () => {
    let j = append([], [open(1)]);
    j = append(j, [open(1), open(2)]);
    expect(list(j).map((o) => o.opId)).toEqual(["op1", "op2"]);
    expect(acknowledge(j, ["unknown"])).toHaveLength(2);
  });

  it("lists entry ids with a pending open", () => {
    const j = append([], [open(1), { opId: "c", type: "close", entryId: "e9" }]);
    expect([...pendingEntryIds(j)]).toEqual(["e1"]);
  });

  it("splits batches by count and by size, preserving order", () => {
    const ops = Array.from({ length: 7 }, (_, i) => open(i));
    expect(batches(ops, 3).map((b) => b.length)).toEqual([3, 3, 1]);
    const big = Array.from({ length: 200 }, (_, i) => open(i, "https://e/" + "x".repeat(2000)));
    const out = batches(big);
    expect(out.length).toBe(3);
    expect(out.flat().map((o) => o.opId)).toEqual(big.map((o) => o.opId));
    for (const b of out) expect(b.reduce((n, op) => n + wireSize(op) + 1, 0)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    // Small operations: the 500-operation cap decides.
    expect(batches(Array.from({ length: 1200 }, (_, i) => open(i))).map((b) => b.length)).toEqual([500, 500, 200]);
  });

  it("worst case: 500 merge operations with 2048-byte URLs seal into bodies of at most 256 KiB", async () => {
    const cipher = await createCipher(generateKey());
    const url = (i: number) => {
      const prefix = `https://w.example/${i}/`;
      return prefix + "é".repeat(Math.floor((2048 - prefix.length) / 2)) + "x".repeat((2048 - prefix.length) % 2);
    };
    const ops = Array.from({ length: 500 }, (_, i) => ({
      opId: crypto.randomUUID(),
      type: "open" as const,
      entryId: crypto.randomUUID(),
      url: url(i),
      pinned: false,
      position: 99_999,
      baseRevision: 9_999_999_999,
    }));
    expect(new TextEncoder().encode(ops[0]!.url).length).toBe(2048);
    const out = batches(ops);
    expect(out.flat()).toHaveLength(500);
    for (const batch of out) {
      const sealed = await Promise.all(batch.map(async ({ url: u, ...rest }) => ({ ...rest, ...(await cipher.seal(u)) })));
      const body = JSON.stringify({ generation: 9_999_999, baseRevision: 9_999_999_999, operations: sealed });
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("estimates the sealed size of URL operations: urlKey plus base64url of 64-byte padded blocks", () => {
    expect(MAX_BATCH_BYTES).toBe(240 * 1024);
    // 62 bytes + 2-byte length = one 64-byte block.
    expect(wireSize(open(1, "https://e/" + "x".repeat(52)))).toBe(43 + (64 * 4) / 3 + 80);
    expect(wireSize(open(1, "https://e/" + "x".repeat(53)))).toBe(43 + (128 * 4) / 3 + 80);
    // UTF-8 bytes count, not characters.
    expect(wireSize({ opId: "o", type: "navigate", entryId: "e", url: "https://e/" + "é".repeat(30) })).toBe(43 + (128 * 4) / 3 + 80);
    const close: Operation = { opId: "o", type: "close", entryId: "e" };
    expect(wireSize(close)).toBe(JSON.stringify(close).length);
  });
});
