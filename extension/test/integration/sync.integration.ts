// @ts-nocheck -- uses Node built-ins; @types/node is not installed and tsconfig.json (which includes test/) is out of scope here.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeBrowser } from "../../src/adapter/fake.js";
import { ApiClient, type BrowserKind, type ChangesResponse, type Session } from "../../src/core/client.js";
import { continueHere, handOver, pair, type Deps } from "../../src/core/handover.js";
import { loadState } from "../../src/core/state.js";

const SERVER_DIR = resolve(import.meta.dirname, "../../../server");
const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn("[integration] SKIPPED: `go` is not on PATH, cannot build the Cross-Tab-Sync server");
    return false;
  }
})();

let scratch = "";
let binary = "";
let proc: ChildProcess | null = null;
let baseUrl = "";
let dbDir = "";

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

const serverEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  CTS_ALLOW_INSECURE: "1",
  CTS_DB_PATH: join(dbDir, "cts.db"),
  ...extra,
});

/** Fresh server and database per test: the session is a singleton, scenarios must not leak into each other. */
async function startServer(): Promise<void> {
  dbDir = mkdtempSync(join(scratch, "db-"));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn(binary, ["serve"], { env: serverEnv({ CTS_ADDR: `127.0.0.1:${port}` }), stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with ${proc.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not become healthy");
}

async function stopServer(): Promise<void> {
  const p = proc;
  proc = null;
  if (!p || p.exitCode !== null) return;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  setTimeout(() => p.kill("SIGKILL"), 3000).unref();
  await exited;
}

interface Dev {
  b: FakeBrowser;
  deps: Deps;
  state: () => ReturnType<typeof loadState>;
}

async function device(name: string, browser: BrowserKind, urls: string[]): Promise<Dev> {
  const b = new FakeBrowser();
  b.addWindow({ focused: true, tabs: urls.map((url, i) => ({ url, active: i === 0 })) });
  const deps: Deps = { adapter: b, browser, api: (cfg) => new ApiClient({ baseUrl: cfg.baseUrl, token: cfg.token, timeoutMs: 10_000 }) };
  const code = execFileSync(binary, ["pair-code"], { env: serverEnv(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  await pair(deps, { serverUrl: baseUrl, deviceName: name, code });
  return { b, deps, state: () => loadState(b.storage) };
}

const api = async (d: Dev) => {
  const s = await d.state();
  return new ApiClient({ baseUrl, token: s.token });
};
const urlsOf = (b: FakeBrowser) => b.tabs.map((t) => t.url).sort();
const entryUrls = (s: Session) => s.entries.map((e) => e.url).sort();

describe.skipIf(!hasGo)("real server + real client", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "cts-it-"));
    mkdirSync(scratch, { recursive: true });
    binary = join(scratch, "cross-tab-sync");
    execFileSync("go", ["build", "-o", binary, "./cmd/cross-tab-sync"], { cwd: SERVER_DIR, stdio: "inherit" });
  });
  afterEach(stopServer);
  afterAll(async () => {
    await stopServer();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("A: two devices converge without duplicating open URLs", async () => {
    await startServer();
    const safari = await device("Safari", "safari", ["https://a.example/", "https://b.example/"]);
    const brave = await device("Brave", "brave", ["https://b.example/", "https://c.example/"]);

    const s1 = await continueHere(safari.deps);
    expect(s1.lastError).toBeNull();
    expect(entryUrls(await (await api(safari)).session())).toEqual(["https://a.example/", "https://b.example/"]);

    const braveActive = brave.b.activeTabs();
    const s2 = await continueHere(brave.deps);
    expect(s2.lastError).toBeNull();
    expect(urlsOf(brave.b)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    const created = brave.b.calls.filter((c) => c.method === "createTab");
    expect(created).toHaveLength(1); // only A: B is reused, C is published
    expect(brave.b.activeTabs()).toEqual({ ...braveActive }); // nothing stole focus
    const aTab = brave.b.tabs.find((t) => t.url === "https://a.example/")!;
    expect(aTab.active).toBe(false);

    await continueHere(safari.deps);
    expect(urlsOf(safari.b)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    expect(safari.b.calls.filter((c) => c.method === "createTab")).toHaveLength(1); // only C

    const session = await (await api(brave)).session();
    expect(entryUrls(session)).toEqual(urlsOf(safari.b));
    expect(entryUrls(session)).toEqual(urlsOf(brave.b));
    expect(new Set(session.entries.map((e) => e.url)).size).toBe(session.entries.length);
    expect(session.owner?.name).toBe("Safari");
  });

  it("B: hand over releases, second device acquires, stale hand over is refused", async () => {
    await startServer();
    const safari = await device("Safari", "safari", ["https://a.example/"]);
    const brave = await device("Brave", "brave", ["https://b.example/"]);

    await continueHere(safari.deps);
    const oldGeneration = (await safari.state()).generation!;
    const handed = await handOver(safari.deps);
    expect(handed.generation).toBeNull();
    expect(handed.statusText).toMatch(/^Handed over at revision \d+/);
    expect((await (await api(safari)).session()).owner).toBeNull();

    const taken = await continueHere(brave.deps);
    expect(taken.generation).toBe(oldGeneration + 1);
    expect((await (await api(brave)).session()).owner).toMatchObject({ name: "Brave", generation: taken.generation });

    const before = await (await api(brave)).session();
    const tabsBefore = urlsOf(safari.b);
    await expect(handOver(safari.deps)).rejects.toThrow(/not the owner/i);
    expect(urlsOf(safari.b)).toEqual(tabsBefore);
    expect((await safari.state()).generation).toBeNull();
    expect(await (await api(brave)).session()).toEqual(before);

    // The server itself also rejects a write that carries the stale generation.
    await expect(
      (await api(safari)).operations({ generation: oldGeneration, baseRevision: before.revision, operations: [] }),
    ).rejects.toMatchObject({ status: 409, code: "stale_owner" });
  });

  it("C: a URL with an invalid percent-escape is never sent and does not block the batch", async () => {
    await startServer();
    const bad = "https://example.com/%zz";
    const safari = await device("Safari", "safari", [bad, "https://ok.example/"]);
    const state = await continueHere(safari.deps);
    expect(state.lastError).toBeNull();
    expect(state.pending).toEqual([]);
    const client = await api(safari);
    expect(entryUrls(await client.session())).toEqual(["https://ok.example/"]);
    const ops = (await client.changes(0)).operations;
    expect(JSON.stringify(ops)).not.toContain("%zz");
    expect(ops).toHaveLength(1);
    expect(urlsOf(safari.b)).toContain(bad); // local tab untouched
    // Confirms the client-side filter matters: the server refuses the URL outright.
    const raw = { generation: state.generation, baseRevision: 0, operations: [{ opId: crypto.randomUUID(), type: "open", entryId: crypto.randomUUID(), url: bad }] };
    const res = await fetch(`${baseUrl}/v1/session/operations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(raw),
    });
    expect(res.status).toBe(400);
  });

  it("D: changes?since= returns ordered operations and millisecond timestamps", async () => {
    await startServer();
    const urls = ["https://one.example/", "https://two.example/", "https://three.example/"];
    const safari = await device("Safari", "safari", urls);
    await continueHere(safari.deps);
    const token = (await safari.state()).token!;
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };

    const all = await get<ChangesResponse>("/v1/session/changes?since=0");
    expect(all.operations.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(all.operations.map((o) => (o.op.type === "open" ? o.op.url : ""))).toEqual(urls);
    expect(all.revision).toBe(3);
    const tail = await get<ChangesResponse>("/v1/session/changes?since=2");
    expect(tail.operations.map((o) => o.seq)).toEqual([3]);
    expect((await get<ChangesResponse>("/v1/session/changes?since=3")).operations).toEqual([]);

    expect(all.owner?.lastSeenAt).toMatch(/\d{3}Z$/);
    const { devices } = await get<{ devices: { createdAt: string; lastSeenAt: string }[] }>("/v1/devices");
    for (const d of devices) {
      expect(d.createdAt).toMatch(/\d{3}Z$/);
      expect(d.lastSeenAt).toMatch(/\d{3}Z$/);
    }
  });
});
