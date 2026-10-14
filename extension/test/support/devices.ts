// Test devices: a fake browser, a SyncEngine attached to its events, a manual debounce timer and a
// shared clock, all against one FakeServer.
import { FakeBrowser, type FakeTabInit } from "../../src/adapter/fake.js";
import type { Operation } from "../../src/core/client.js";
import { eligibleTabs } from "../../src/core/eligibility.js";
import { SESSION_MARKER, SyncEngine, type Scheduler } from "../../src/core/engine.js";
import { pair, type Deps } from "../../src/core/handover.js";
import { loadState, saveState, type State } from "../../src/core/state.js";
import { TEST_KEY, type FakeServer } from "./fakeServer.js";

export class Clock {
  t = Date.parse("2026-10-13T10:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Timers fired by hand; firing moves the shared clock to the latest due time (never backwards). */
export class ManualTimers {
  private readonly tasks = new Map<() => void, number>();
  constructor(private readonly clock: Clock) {}
  schedule: Scheduler = (fn, ms) => {
    const task = () => fn();
    this.tasks.set(task, this.clock.t + ms);
    return () => this.tasks.delete(task);
  };
  get size(): number {
    return this.tasks.size;
  }
  fire(): void {
    const due = [...this.tasks];
    this.tasks.clear();
    const latest = Math.max(...due.map(([, at]) => at));
    if (latest > this.clock.t) this.clock.t = latest;
    for (const [t] of due) t();
  }
}

export interface Dev {
  b: FakeBrowser;
  deps: Deps;
  engine: SyncEngine;
  timers: ManualTimers;
  /** Backoff retry timers; `settle` never fires them. */
  retries: ManualTimers;
  /** Delayed re-matches after a startup reset; `settle` never fires them. */
  rematches: ManualTimers;
  /** The normal window created for the device (unless `noWindow`). */
  win: number;
  id: string;
  state(): Promise<State>;
  /** Drain the queue, firing debounce timers, until nothing is left. */
  settle(): Promise<void>;
  /** Sorted URLs of eligible local tabs. */
  urls(): Promise<string[]>;
  /** Mark recent activity so the next signal is not a fresh interaction. */
  quiet(): Promise<void>;
  acquires(): number;
  /** Operations this device sent through `operations`, in order. */
  sent(): Operation[];
  /** Operations this device sent through `merge`, in order (with their baseRevision). */
  merged(): (Operation & { baseRevision: number })[];
  tab(url: string): number;
}

let codeSeq = 0;

export async function device(
  server: FakeServer,
  clock: Clock,
  name: string,
  opts: { tabs?: FakeTabInit[]; noWindow?: boolean; setup?: (b: FakeBrowser) => void } = {},
): Promise<Dev> {
  const b = new FakeBrowser();
  const win = opts.noWindow ? -1 : b.addWindow({ focused: true, tabs: opts.tabs ?? [] });
  opts.setup?.(b);
  const deps: Deps = { adapter: b, api: server.api, browser: name.includes("Safari") ? "safari" : "brave", now: clock.now };
  const code = `DEV${++codeSeq}`.padEnd(8, "0");
  server.codes.add(code);
  // Every device shares one encryption key, as if paired from invite links.
  const s = await pair(deps, { serverUrl: "https://sync.example", deviceName: name, code, key: TEST_KEY });
  const id = s.deviceId!;
  // The browser session is already running (a restart() clears this marker).
  await b.sessionStorage?.set({ [SESSION_MARKER]: clock.t });
  const timers = new ManualTimers(clock);
  const retries = new ManualTimers(clock);
  const rematches = new ManualTimers(clock);
  const engine = new SyncEngine(deps, timers.schedule, retries.schedule, rematches.schedule);
  engine.attach();
  return {
    b,
    deps,
    engine,
    timers,
    retries,
    rematches,
    win,
    id,
    state: () => loadState(b.storage),
    async settle() {
      for (let i = 0; i < 100; i++) {
        await engine.idle();
        if (timers.size === 0) return;
        timers.fire();
      }
      throw new Error("engine did not settle");
    },
    async urls() {
      return eligibleTabs(b.tabs, b.windows)
        .map((t) => t.url)
        .sort();
    },
    async quiet() {
      await saveState(b.storage, { lastActivityAt: clock.t });
    },
    acquires: () => server.requests.filter((r) => r.path === "acquire" && r.device === id).length,
    sent: () =>
      server.requests
        .filter((r) => r.path === "operations" && r.device === id)
        .flatMap((r) => (r.body as { operations: Operation[] }).operations),
    merged: () =>
      server.requests
        .filter((r) => r.path === "merge" && r.device === id)
        .flatMap((r) => (r.body as { operations: (Operation & { baseRevision: number })[] }).operations),
    tab(url: string) {
      const t = b.tabs.find((x) => x.url === url);
      if (!t) throw new Error(`no tab ${url}`);
      return t.id;
    },
  };
}
