// @ts-nocheck -- uses Node built-ins; @types/node is not installed and tsconfig.json (which includes test/) is out of scope here.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeBrowser } from "../../src/adapter/fake.js";
import { ApiClient, type BrowserKind, type Session } from "../../src/core/client.js";
import { cipherFor } from "../../src/core/crypto.js";
import { SyncEngine } from "../../src/core/engine.js";
import { continueHere, createPairingCode, disconnect, handOver, KEY_REQUIRED_MESSAGE, pair, type Deps } from "../../src/core/handover.js";
import { parsePairingInput } from "../../src/core/pairing.js";
import { listDevices, renameDevice } from "../../src/core/recovery.js";
import { loadState } from "../../src/core/state.js";

const SERVER_DIR = resolve(import.meta.dirname, "../../../server");
const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn("[integration] `sqlite3` is not on PATH: the database plaintext check is skipped");
    return false;
  }
})();
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

/** The background wiring: a cipher from the stored key. */
const clientFactory: Deps["api"] = ({ key, ...cfg }) =>
  new ApiClient({ ...cfg, timeoutMs: 10_000, cipher: key ? cipherFor(key) : undefined });

const cliCode = (env: Record<string, string> = {}) =>
  execFileSync(binary, ["pair-code"], { env: serverEnv(env), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/**
 * The first device pairs with a keyless CLI code (empty session: it generates the key); later
 * devices pair from an invite link of `inviter` (`#CODE.KEY`), as users do.
 */
async function device(name: string, browser: BrowserKind, urls: string[], inviter?: Dev): Promise<Dev> {
  const b = new FakeBrowser();
  b.addWindow({ focused: true, tabs: urls.map((url, i) => ({ url, active: i === 0 })) });
  const deps: Deps = { adapter: b, browser, api: clientFactory };
  const target = inviter ? parsePairingInput((await createPairingCode(inviter.deps)).link) : { serverUrl: baseUrl, code: cliCode() };
  const s = await pair(deps, { ...target, deviceName: name });
  expect(s.syncKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { b, deps, state: () => loadState(b.storage) };
}

const api = async (d: Dev) => {
  const s = await d.state();
  return new ApiClient({ baseUrl, token: s.token, cipher: s.syncKey ? cipherFor(s.syncKey) : undefined });
};

/** Everything the database keeps about tabs: entries, operation payloads, snapshot entries. */
function dumpTabData(): string {
  const db = join(dbDir, "cts.db");
  const query = (sql: string) => execFileSync("sqlite3", [db, sql]).toString();
  return [
    query("SELECT * FROM entries"),
    query("SELECT payload FROM operations"),
    query("SELECT entries FROM snapshots"),
  ].join("\n");
}
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
    const brave = await device("Brave", "brave", ["https://b.example/", "https://c.example/"], safari);
    expect((await brave.state()).syncKey).toBe((await safari.state()).syncKey);

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
    const brave = await device("Brave", "brave", ["https://b.example/"], safari);

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
    // The server cannot judge URLs any more; it only checks the sealed fields' shape.
    const post = (op: Record<string, unknown>) =>
      fetch(`${baseUrl}/v2/session/operations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ generation: state.generation, baseRevision: 0, operations: [{ opId: crypto.randomUUID(), type: "open", entryId: crypto.randomUUID(), ...op }] }),
      });
    expect((await post({ urlKey: "short", urlEnc: "AQ" })).status).toBe(400);
    expect((await post({ urlKey: "x".repeat(43), urlEnc: "x".repeat(4097) })).status).toBe(400);
    expect((await post({ urlKey: "x".repeat(43), urlEnc: "not base64url!" })).status).toBe(400);
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

    type RawChanges = { revision: number; owner: { lastSeenAt: string } | null; operations: { seq: number; op: Record<string, unknown> }[] };
    const all = await get<RawChanges>("/v2/session/changes?since=0");
    expect(all.operations.map((o) => o.seq)).toEqual([1, 2, 3]);
    // The wire carries only the sealed fields, never the URL.
    for (const { op } of all.operations) {
      expect(op).not.toHaveProperty("url");
      expect(op["urlKey"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(op["urlEnc"]).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(JSON.stringify(all)).not.toContain("example");
    const opened = (await (await api(safari)).changes(0)).operations;
    expect(opened.map((o) => (o.op.type === "open" ? o.op.url : ""))).toEqual(urls);
    expect(all.revision).toBe(3);
    const tail = await get<RawChanges>("/v2/session/changes?since=2");
    expect(tail.operations.map((o) => o.seq)).toEqual([3]);
    expect((await get<RawChanges>("/v2/session/changes?since=3")).operations).toEqual([]);
    expect((await fetch(`${baseUrl}/v1/session`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);

    expect(all.owner?.lastSeenAt).toMatch(/\d{3}Z$/);
    const { devices } = await get<{ devices: { createdAt: string; lastSeenAt: string }[] }>("/v2/devices");
    for (const d of devices) {
      expect(d.createdAt).toMatch(/\d{3}Z$/);
      expect(d.lastSeenAt).toMatch(/\d{3}Z$/);
    }
  });

  it("E: a follower's journal merges without ownership and a divergent navigate forks", async () => {
    await startServer();
    const safari = await device("Safari", "safari", ["https://a.example/"]);
    const brave = await device("Brave", "brave", [], safari);
    await continueHere(safari.deps);
    const engine = new SyncEngine(brave.deps, () => () => undefined);
    engine.attach();
    await engine.runNow("syncNow"); // first follower run: full resync creates the tab
    const tab = brave.b.tabs.find((t) => t.url === "https://a.example/")!;
    brave.deps.now = () => new Date(Date.now() + 60_000); // past the post-load grace
    brave.b.userNavigate(tab.id, "https://a.example/brave");
    await engine.idle();
    expect((await brave.state()).pending.map((p) => p.op.type)).toEqual(["navigate"]);

    const s = await safari.state();
    const entry = (await (await api(safari)).session()).entries[0]!;
    await (await api(safari)).operations({
      generation: s.generation,
      baseRevision: s.lastRevision,
      operations: [{ opId: crypto.randomUUID(), type: "navigate", entryId: entry.id, url: "https://a.example/safari" }],
    });

    const after = await engine.runNow("syncNow");
    expect(after.lastError).toBeNull();
    expect(after.pending).toEqual([]);
    expect(after.generation).toBeNull();
    const session = await (await api(brave)).session();
    expect(entryUrls(session)).toEqual(["https://a.example/brave", "https://a.example/safari"]);
    expect(session.owner?.name).toBe("Safari");
    expect(urlsOf(brave.b)).toEqual(["https://a.example/brave", "https://a.example/safari"]);
  });

  it("pairing link: invite, duplicate names, rename, revoked devices listed", async () => {
    await startServer();
    const mac = await device("Brave on macOS", "brave", []);

    // CLI: a link with CTS_PUBLIC_URL, a bare code without it.
    const cli = execFileSync(binary, ["pair-code"], { env: serverEnv({ CTS_PUBLIC_URL: baseUrl }), stdio: ["ignore", "pipe", "ignore"] });
    expect(cli.toString().trim()).toMatch(new RegExp(`^${baseUrl.replace(/\./g, "\\.")}#[A-Z2-9]{8}$`));

    // Invite: the server derives the link from the request (no CTS_PUBLIC_URL on the server); the
    // popup appends the key.
    const invite = await createPairingCode(mac.deps);
    const key = (await mac.state()).syncKey;
    expect(invite.link).toBe(`${baseUrl}#${invite.code}.${key}`);
    const b = new FakeBrowser();
    const deps: Deps = { adapter: b, browser: "brave", api: clientFactory };
    const target = parsePairingInput(invite.link);
    expect(target).toEqual({ serverUrl: baseUrl, code: invite.code, key });
    const second = await pair(deps, { ...target, deviceName: "Brave on macOS" });
    expect(second.deviceName).toBe("Brave on macOS 2");
    expect(second.syncKey).toBe(key);

    const renamed = await renameDevice(deps, "Work Brave");
    expect(renamed.deviceName).toBe("Work Brave");
    expect((await listDevices(mac.deps)).map((d) => d.name)).toEqual(["Brave on macOS", "Work Brave"]);
    await expect((await api(mac)).renameDevice(second.deviceId!, "Mine")).rejects.toMatchObject({ status: 403, code: "forbidden" });

    await disconnect(deps);
    const devices = await listDevices(mac.deps);
    expect(devices.map((d) => [d.name, Boolean(d.revokedAt)])).toEqual([
      ["Brave on macOS", false],
      ["Work Brave", true],
    ]);
  });

  it("keyless pairing: refused once the session has history, the new device revoked", async () => {
    await startServer();
    const safari = await device("Safari", "safari", ["https://a.example/"]);
    await continueHere(safari.deps);
    const b = new FakeBrowser();
    const deps: Deps = { adapter: b, browser: "brave", api: clientFactory };
    await expect(pair(deps, { serverUrl: baseUrl, deviceName: "Late", code: cliCode() })).rejects.toThrow(KEY_REQUIRED_MESSAGE);
    const s = await loadState(b.storage);
    expect(s).toMatchObject({ token: null, syncKey: null, errorKind: "key" });
    const devices = await listDevices(safari.deps);
    expect(devices.find((d) => d.name === "Late")?.revokedAt).toEqual(expect.any(String));

    // An invite link with another key fails the key check (409 key_set) and revokes itself too.
    const invite = parsePairingInput((await createPairingCode(safari.deps)).link);
    const wrong: Deps = { adapter: new FakeBrowser(), browser: "brave", api: clientFactory };
    const owner = (await (await api(safari)).session()).owner;
    await expect(pair(wrong, { ...invite, key: "A".repeat(43), deviceName: "Wrong" })).rejects.toThrow(KEY_REQUIRED_MESSAGE);
    expect(await loadState(wrong.adapter.storage)).toMatchObject({ token: null, syncKey: null, errorKind: "key" });
    expect((await listDevices(safari.deps)).find((d) => d.name === "Wrong")?.revokedAt).toEqual(expect.any(String));
    expect((await (await api(safari)).session()).owner).toEqual(owner);
  });

  it.skipIf(!hasSqlite)("the database holds no readable URLs", async () => {
    await startServer();
    const safari = await device("Safari", "safari", ["https://a.example/one", "http://b.example/two?q=1"]);
    const brave = await device("Brave", "brave", ["https://c.example/three"], safari);
    await continueHere(safari.deps);
    await continueHere(brave.deps);
    // A navigate and a close create snapshots; their entries must be sealed too.
    const s = await brave.state();
    const session = await (await api(brave)).session();
    const [first, second] = session.entries;
    await (await api(brave)).operations({
      generation: s.generation!,
      baseRevision: s.lastRevision,
      operations: [
        { opId: crypto.randomUUID(), type: "navigate", entryId: first!.id, url: "https://a.example/moved" },
        { opId: crypto.randomUUID(), type: "close", entryId: second!.id },
      ],
    });
    const dump = dumpTabData();
    expect(dump.length).toBeGreaterThan(0);
    expect(dump).toMatch(/url_?[Kk]ey|[A-Za-z0-9_-]{43}/);
    expect(dump).not.toContain("http");
    expect(dump).not.toContain("example");
    expect(Number(execFileSync("sqlite3", [join(dbDir, "cts.db"), "SELECT COUNT(*) FROM snapshots"]).toString())).toBeGreaterThan(0);
  });
});
