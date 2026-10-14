import { afterEach, describe, expect, it, vi } from "vitest";
import { diag, diagnosticsOn, flushDiag, isLoopbackUrl, refreshDiagnostics, setDiagnostics, setDiagSink } from "../src/core/diag.js";
import { MemoryStorage } from "../src/adapter/fake.js";

afterEach(() => {
  setDiagnostics(false);
  setDiagSink(null);
  vi.restoreAllMocks();
});

describe("diagnostics", () => {
  it("is a no-op when off and logs to the console when on, masking URLs", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    diag("off");
    expect(log).not.toHaveBeenCalled();
    setDiagnostics(true);
    diag("run alarm start https://secret.example/path?x=1");
    expect(log).toHaveBeenCalledWith("[cts] run alarm start <url>");
  });

  it("is on by default only for a loopback server; the stored flag overrides", async () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8080")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackUrl("https://sync.example")).toBe(false);
    expect(diagnosticsOn({ serverUrl: "https://sync.example", diagnostics: true })).toBe(true);
    expect(diagnosticsOn({ serverUrl: "http://127.0.0.1:8080", diagnostics: false })).toBe(false);

    const storage = new MemoryStorage();
    await storage.set({ "cts.serverUrl": "http://127.0.0.1:8080" });
    await refreshDiagnostics(storage);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    diag("on");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("posts buffered lines to the server; a 404 stops posting until the worker restarts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const posted: string[][] = [];
    let status = 204;
    setDiagSink(async (lines) => {
      posted.push(lines);
      if (status === 404) throw Object.assign(new Error("not found"), { status: 404 });
    });
    setDiagnostics(true);
    diag("a");
    diag("b " + "x".repeat(400));
    flushDiag();
    await Promise.resolve();
    expect(posted).toEqual([["a", "b " + "x".repeat(298)]]);

    status = 404;
    diag("c");
    await new Promise((r) => setTimeout(r, 0)); // previous post settled
    flushDiag();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toHaveLength(2);
    diag("d");
    flushDiag();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toHaveLength(2); // stopped
  });
});
