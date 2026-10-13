import { describe, expect, it } from "vitest";
import type { Operation } from "../src/core/client.js";
import { acknowledge, append, batches, list, newOpId, pendingEntryIds } from "../src/core/journal.js";

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
    const big = Array.from({ length: 40 }, (_, i) => open(i, "https://e/" + "x".repeat(2000)));
    const out = batches(big);
    expect(out.length).toBeGreaterThan(1);
    expect(out.flat().map((o) => o.opId)).toEqual(big.map((o) => o.opId));
    for (const b of out) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(64 * 1024);
  });
});
