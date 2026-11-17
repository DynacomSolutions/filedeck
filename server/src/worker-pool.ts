import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { LocalAccount } from "./local-accounts.ts";
import { MAX_GROUPS, launcherAvailable, sandboxInfo, spawnSandboxed, type Root } from "./sandbox.ts";
import { JOBS_HEADER, type WorkerInit } from "./worker.ts";
import { Mux, WorkerGone } from "./worker-proto.ts";

/**
 * The agent's worker processes, one per signed-in account (sign-in on). A worker is started on the first request for its key, reused
 * while it runs, and stopped when it has had nothing to do for `idleMs`, when room is needed for another key, or when its account
 * changes (`stopKey`, `stopAccount`).
 *
 * Each key is in one of these states:
 *   none       no process. A request starts one, unless the key's last start failed less than `BACKOFF_MS` ago (the same 503 then).
 *   starting   a slot in `starting`: the start rules, the process, HELLO, then READY within `READY_MS`. Every request for the key that
 *              comes meanwhile waits for this same start. It counts towards `max`.
 *   live       in `workers`: requests go to its `Mux`. Busy while a request or stream is open on the mux (either way), while the worker
 *              says it has live jobs (`x-filedeck-jobs`), or while a request that waited for its start has not been sent yet.
 *   stopping   out of `workers` first (so no new request reaches it), then BYE, then SIGKILL if it has not exited within `STOP_MS`.
 * A worker whose process exits, or whose connection closes, goes to stopping at once; its open requests fail with `WorkerGone` and the
 * next request starts a new one. There is no liveness check: a worker that is stuck but connected is stopped only by these rules.
 */

/** What the pool needs to start and identify one account's worker. */
export interface WorkerSpec {
  /** the pool key (`sys:<name>`, or `virt:<name>:<grants hash>`): one worker per key */
  key: string;
  kind: "sys" | "virt";
  name: string;
  epoch: number;
  account: LocalAccount;
  /** Landlock roots (virtual accounts); without, the worker gets no Landlock ruleset */
  landlock?: { readOnly: Root[]; readWrite: Root[]; readExec: Root[] };
  /** the worker's start-up message (`cfg` from `workerConfig`, so no secret) */
  init: WorkerInit;
  /** the account's own temporary folder (`TMPDIR` and `HOME` of the worker); unset = this process's temporary folder */
  tmp?: string;
  /** closes descriptor roots once the start is over, whether it worked or not */
  release?: () => void;
}

export type StartWorker = (spec: WorkerSpec) => Promise<ChildProcess>;

/** Every worker is busy and the pool holds `max`: no room for another key. */
export class PoolFull extends Error {
  constructor() {
    super("every worker is busy");
    this.name = "PoolFull";
  }
}

/** how long a worker has to say READY */
const READY_MS = 10_000;
/** how long a stopped worker has to exit after BYE before it is killed */
const STOP_MS = 5_000;
/** how long a key whose worker failed to start gets the same answer before the next try */
export const BACKOFF_MS = 5_000;
/** how long the idle check waits for a worker's job count */
const PROBE_MS = 5_000;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The worker's program and its arguments for `node`: the built `worker.js`, or the source through tsx when this module runs from source. */
export function workerEntry(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [path.join(here, "worker.js")];
  // tsx by its full path: a worker's working folder is `/`, from where the name alone would not resolve
  return ["--import", import.meta.resolve("tsx"), path.join(here, "worker.ts")];
}

/** The worker's whole environment: nothing of the agent's beyond these names (the agent's settings may hold secrets). */
export function workerEnv(spec: WorkerSpec): NodeJS.ProcessEnv {
  const tmp = spec.tmp ?? os.tmpdir();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    TMPDIR: tmp,
    HOME: tmp,
    UV_THREADPOOL_SIZE: "16",
  };
  for (const name of ["TZ", "FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

/** Starts a worker process as the spec's account, through the sandbox launcher, with its socket on descriptor 3. */
export const startWorkerProcess: StartWorker = (spec) =>
  spawnSandboxed(process.execPath, ["--max-old-space-size=96", ...workerEntry()], {
    uid: spec.account.uid,
    gid: spec.account.gid,
    groups: spec.account.groups.length ? spec.account.groups : undefined,
    allowMetadata: true,
    allowSocketpair: true,
    landlock: spec.landlock ? undefined : false,
    readOnly: spec.landlock?.readOnly,
    readWrite: spec.landlock?.readWrite,
    readExec: spec.landlock?.readExec,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    keepStdio: [3],
    cwd: "/",
    env: workerEnv(spec),
  });

/**
 * Logs what a worker writes, one log line per line it wrote, as `worker <key>: <line>`. A worker is not trusted, so a line is cut at
 * `maxLine` characters (a line with no end is held only that far), control characters become `?`, and at most `perSecond` lines are
 * logged each second; the number of lines left out is said once the next second starts.
 */
export function lineLogger(key: string, log: (s: string) => void, o: { maxLine?: number; perSecond?: number; now?: () => number } = {}) {
  const maxLine = o.maxLine ?? 1000;
  const perSecond = o.perSecond ?? 50;
  const now = o.now ?? Date.now;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  /** the start of a line too long to hold was logged: drop the rest of it */
  let skipping = false;
  let second = -1;
  let count = 0;
  let dropped = 0;
  const cut = (s: string) => (s.length > maxLine ? s.slice(0, maxLine) + "…" : s);
  const emit = (line: string) => {
    const sec = Math.floor(now() / 1000);
    if (sec !== second) {
      if (dropped) log(`worker ${key}: (${dropped} lines left out)`);
      second = sec;
      count = 0;
      dropped = 0;
    }
    if (count >= perSecond) {
      dropped++;
      return;
    }
    count++;
    log(`worker ${key}: ${cut(line.replace(/\r$/, "").replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "?"))}`);
  };
  const take = (s: string) => {
    while (s.length) {
      const i = s.indexOf("\n");
      if (i < 0) {
        if (skipping) return;
        buf += s;
        if (buf.length > maxLine) {
          emit(buf);
          buf = "";
          skipping = true;
        }
        return;
      }
      const part = s.slice(0, i);
      s = s.slice(i + 1);
      if (skipping) skipping = false;
      else emit(buf + part);
      buf = "";
    }
  };
  return {
    write: (chunk: Buffer | string) => take(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    end: () => {
      take(decoder.end());
      if (buf && !skipping) emit(buf);
      buf = "";
    },
  };
}

interface Live {
  key: string;
  spec: WorkerSpec;
  child: ChildProcess;
  pid: number;
  mux: Mux;
  lastUsed: number;
  /** live jobs, as the worker said on its last answer */
  jobs: number;
  /** requests that waited for this worker's start and have not been sent to it yet */
  reserved: number;
  exited: Promise<void>;
  stopping: Promise<void> | null;
  probing: boolean;
}

/** an answer of the pool itself, before the request reaches a worker */
interface Refusal {
  status: 403 | 503;
  error: string;
}

interface Starting {
  spec: WorkerSpec;
  promise: Promise<Live | Refusal | null>;
  /** requests waiting for this start */
  waiters: number;
  /** `stopKey`, `stopAccount` or `close` came during the start: the worker is stopped as soon as it is up, and the waiters get `WorkerGone` */
  cancelled: boolean;
}

const START_FAILED: Refusal = { status: 503, error: "worker failed to start" };
const noop = () => {};

function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    t.unref();
    void p.then(() => (clearTimeout(t), res(true)));
  });
}

/** the job count a worker reports; anything that is not a small whole number counts as none */
function jobsOf(h: string | null): number {
  return h !== null && /^\d{1,6}$/.test(h) ? Number(h) : 0;
}

/** what the account itself rules out (checked before room is made for it) */
function accountRefusal(a: LocalAccount): Refusal | null {
  // (the resolvers refuse root too; and a root agent would pass uid 0 to the sandbox as "no change")
  if (a.uid === 0 || a.gid === 0 || a.groups.includes(0)) return { status: 403, error: "no account on this machine" };
  // never cut the list: a left-out group could be one that denies access
  if (a.groups.length > MAX_GROUPS) return { status: 503, error: "account has too many groups" };
  return null;
}

export class WorkerPool {
  private readonly max: number;
  private readonly idleMs: number;
  private readonly startFn: StartWorker;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly rootHandler: ((spec: WorkerSpec, req: Request) => Promise<Response>) | undefined;
  private readonly workers = new Map<string, Live>();
  private readonly starting = new Map<string, Starting>();
  /** keys whose last start failed, until when they get the same answer */
  private readonly failed = new Map<string, number>();
  /** every process not yet stopped, also those out of `workers` */
  private readonly procs = new Set<Live>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(o: {
    max: number;
    idleMs: number;
    start?: StartWorker;
    now?: () => number;
    log?: (s: string) => void;
    /** serves the requests a worker sends to the root process, with that worker's own spec; without it they get 404 */
    rootHandler?: (spec: WorkerSpec, req: Request) => Promise<Response>;
  }) {
    if (!Number.isInteger(o.max) || o.max < 1) throw new Error(`the worker limit must be a whole number of at least 1, not ${o.max}`);
    if (!Number.isFinite(o.idleMs) || o.idleMs <= 0) throw new Error(`the worker idle time must be more than 0, not ${o.idleMs}`);
    this.max = o.max;
    this.idleMs = o.idleMs;
    this.startFn = o.start ?? startWorkerProcess;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((s) => console.error(s));
    this.rootHandler = o.rootHandler;
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.min(o.idleMs, 30_000)));
    this.timer.unref();
  }

  /**
   * Sends `req` to the worker for `spec.key`, started first when none runs. A start the rules refuse, or one that fails, is answered
   * here (403 or 503, JSON `{error}`). Throws `PoolFull` when there is no room, and `WorkerGone` when the worker stops before its answer
   * has started (after that, the answer's body errors).
   */
  async fetch(spec: WorkerSpec, req: Request): Promise<Response> {
    if (this.closed) throw new WorkerGone();
    // a running worker gets the request at once (no await before `mux.fetch`, so nothing can stop it in between)
    let w = this.workers.get(spec.key);
    if (!w) {
      const got = await this.join(spec);
      if (!("mux" in got)) return Response.json({ error: got.error }, { status: got.status });
      w = got;
      w.reserved--; // from here on the open request keeps it busy
    }
    w.lastUsed = this.now();
    const res = await w.mux.fetch(req);
    w.lastUsed = this.now();
    w.jobs = jobsOf(res.headers.get(JOBS_HEADER));
    try {
      res.headers.delete(JOBS_HEADER); // the pool's business, not the client's
    } catch {
      /* headers that cannot change: the caller filters them */
    }
    return res;
  }

  /** Stops the worker for `key` (and a start of it), and waits until its process has exited. */
  async stopKey(key: string): Promise<void> {
    await this.stopWhere((s) => s.key === key);
  }

  /** Stops every worker of one account, whatever its key (a virtual account has a key per set of grants). */
  async stopAccount(kind: "sys" | "virt", name: string): Promise<void> {
    await this.stopWhere((s) => s.kind === kind && s.name === name);
  }

  list(): { key: string; pid: number; busy: boolean; lastUsed: number }[] {
    return [...this.workers.values()].map((w) => ({ key: w.key, pid: w.pid, busy: this.busy(w), lastUsed: w.lastUsed }));
  }

  /** Stops every worker and refuses new requests. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.stopWhere(() => true);
    await Promise.all([...this.procs].map((w) => this.stop(w)));
  }

  // ---- inside ----

  private async stopWhere(match: (s: WorkerSpec) => boolean): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const st of this.starting.values()) {
      if (!match(st.spec)) continue;
      st.cancelled = true;
      waits.push(st.promise);
    }
    for (const w of [...this.workers.values()]) if (match(w.spec)) waits.push(this.stop(w));
    await Promise.all(waits);
  }

  private busy(w: Live): boolean {
    return w.mux.inFlight() > 0 || w.jobs > 0 || w.reserved > 0;
  }

  /** the live worker for the key, the start in progress, or a new start (which may first stop the least recently used idle worker) */
  private join(spec: WorkerSpec): Promise<Live | Refusal> {
    const key = spec.key;
    let st = this.starting.get(key);
    if (!st) {
      const no = accountRefusal(spec.account);
      if (no) {
        this.log(`worker ${key}: not started: ${no.error}`);
        return Promise.resolve(no);
      }
      const until = this.failed.get(key);
      if (until !== undefined && this.now() < until) return Promise.resolve(START_FAILED);
      this.failed.delete(key);
      if (this.workers.size + this.starting.size >= this.max) {
        let lru: Live | undefined;
        for (const w of this.workers.values()) if (!this.busy(w) && (!lru || w.lastUsed < lru.lastUsed)) lru = w;
        if (!lru) return Promise.reject(new PoolFull());
        void this.stop(lru);
      }
      st = { spec, promise: null!, waiters: 0, cancelled: false };
      // in the map before the start runs, so that a start which ends at once still finds (and removes) its own slot
      this.starting.set(key, st);
      st.promise = this.start(st);
    }
    st.waiters++;
    return st.promise.then((r) => {
      if (r === null) throw new WorkerGone();
      return r;
    });
  }

  /** what the sandbox rules refuse before anything is started, or null */
  private async refusal(spec: WorkerSpec): Promise<Refusal | null> {
    const a = spec.account;
    if (a.uid !== process.getuid?.() && !(await launcherAvailable())) return { status: 503, error: "workers need filedeck-sandbox" };
    if (spec.landlock && (await sandboxInfo()).state !== "landlock") return { status: 503, error: "virtual accounts need Landlock on this machine" };
    return null;
  }

  /** runs one start; never rejects. Null: the start was cancelled (the worker, if it came up, is stopped). */
  private async start(st: Starting): Promise<Live | Refusal | null> {
    const { spec } = st;
    const key = spec.key;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        spec.release?.();
      } catch {
        /* closing descriptors does not fail in a way that matters here */
      }
    };
    let child: ChildProcess | undefined;
    let w: Live | undefined;
    try {
      const no = await this.refusal(spec);
      if (no) {
        this.log(`worker ${key}: not started: ${no.error}`);
        return no;
      }
      if (st.cancelled || this.closed) return null;
      try {
        child = await this.startFn(spec);
      } finally {
        release();
      }
      w = this.attach(spec, child);
      w.mux.hello(spec.init); // (throws when the message is too large)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`no READY within ${READY_MS / 1000} s`)), READY_MS);
      });
      try {
        await Promise.race([w.mux.whenReady(), late]);
      } finally {
        clearTimeout(timer);
      }
      if (st.cancelled || this.closed) {
        await this.stop(w);
        return null;
      }
      w.lastUsed = this.now();
      w.reserved = st.waiters;
      this.workers.set(key, w);
      return w;
    } catch (e) {
      // the process (if any) goes at once; a worker that failed prints its own `worker: ...` line, which its logger passes on
      this.log(`worker ${key}: start failed: ${e instanceof WorkerGone ? "the worker exited" : e instanceof Error ? e.message : String(e)}`);
      if (w) {
        w.mux.close();
        w.child.kill("SIGKILL");
      } else child?.kill("SIGKILL");
      if (st.cancelled || this.closed) return null;
      this.failed.set(key, this.now() + BACKOFF_MS);
      if (this.failed.size > 4096) {
        const now = this.now();
        for (const [k, until] of this.failed) if (until <= now) this.failed.delete(k);
      }
      return START_FAILED;
    } finally {
      release();
      if (this.starting.get(key) === st) this.starting.delete(key);
    }
  }

  /** wraps a started process: its logs, its mux, and what happens when either ends */
  private attach(spec: WorkerSpec, child: ChildProcess): Live {
    const key = spec.key;
    child.on("error", (e) => this.log(`worker ${key}: ${e.message}`));
    const exited = new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) res();
      else child.once("exit", () => res());
    });
    // stdout is read only so the worker never blocks on it; both go through the same limits
    for (const s of [child.stderr, child.stdout]) {
      if (!s) continue;
      const l = lineLogger(key, this.log);
      s.on("data", (d: Buffer) => l.write(d));
      s.on("end", () => l.end());
      s.on("error", noop);
    }
    const sock = child.stdio[3] as Duplex | null | undefined;
    if (!child.pid || !sock) {
      child.kill("SIGKILL");
      throw new Error("the worker process did not start");
    }
    const handler = this.rootHandler;
    const mux = new Mux(sock, "root", {
      onRequest: handler ? (req) => handler(spec, req) : async () => Response.json({ error: "not found" }, { status: 404 }),
    });
    const w: Live = { key, spec, child, pid: child.pid, mux, lastUsed: this.now(), jobs: 0, reserved: 0, exited, stopping: null, probing: false };
    this.procs.add(w);
    // the process exits, or its connection ends: the worker is gone either way
    void exited.then(() => {
      this.procs.delete(w);
      void this.stop(w);
    });
    void mux.closed.then(() => void this.stop(w));
    return w;
  }

  /** out of the map first (so nothing new reaches it), then BYE, then SIGKILL after `STOP_MS`; resolves once the process has exited */
  private stop(w: Live): Promise<void> {
    if (this.workers.get(w.key) === w) this.workers.delete(w.key);
    w.stopping ??= (async () => {
      w.mux.close();
      if (await within(w.exited, STOP_MS)) return;
      this.log(`worker ${w.key}: did not stop within ${STOP_MS / 1000} s; killed`);
      w.child.kill("SIGKILL");
      await within(w.exited, STOP_MS);
    })();
    return w.stopping;
  }

  /** the idle check: stops workers idle for `idleMs`, and asks those that said they have jobs whether they still do */
  private tick(): void {
    const now = this.now();
    for (const w of [...this.workers.values()]) {
      if (this.busy(w)) {
        w.lastUsed = now; // the idle time counts from when it was last seen busy
        if (w.jobs > 0 && w.mux.inFlight() === 0) void this.probe(w);
        continue;
      }
      if (now - w.lastUsed >= this.idleMs) void this.stop(w);
    }
  }

  /** asks the worker for its job list, only to read the job count on the answer */
  private async probe(w: Live): Promise<void> {
    if (w.probing) return;
    w.probing = true;
    try {
      const res = await w.mux.fetch(new Request("http://worker/api/jobs", { signal: AbortSignal.timeout(PROBE_MS) }));
      w.jobs = jobsOf(res.headers.get(JOBS_HEADER));
      await res.body?.cancel().catch(noop);
    } catch {
      /* a worker that is gone, or does not answer, keeps what it said last; it is stopped by the other rules */
    } finally {
      w.probing = false;
    }
  }
}
