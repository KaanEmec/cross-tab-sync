import { afterEach, describe, expect, it, vi } from "vitest";
import { diag, diagnosticsOn, isLoopbackUrl, refreshDiagnostics, setDiagnostics } from "../src/core/diag.js";
import { MemoryStorage } from "../src/adapter/fake.js";

afterEach(() => {
  setDiagnostics(false);
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
});
