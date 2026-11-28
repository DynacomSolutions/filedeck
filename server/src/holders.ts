import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import type { HelperProc, SpawnHelper } from "./fanwatch.ts";
import { HT, HolderDecoder, kernelDev, type HolderRec } from "./holders-proto.ts";
import { HoldersTable, type HoldKind } from "./holders-table.ts";

/**
 * "Who holds what" on this machine, live. The native helper `filedeck-holders` (server/native, eBPF) sends an event for every way a process comes to
 * hold a file or a folder; `HoldersTable` keeps the table; this class runs the helper, asks it to read a process again when its events may be lost
 * (never on a timer), and answers `GET /api/v1/holders?path=` (holders-routes.ts). See docs/holders.md.
 *
 * Where the helper cannot run (no BPF, no BTF, not allowed, not Linux) the feature says `unavailable` with the reason, and every answer says
 * `proven: false`. It never makes the agent fail.
 */

export type HoldersState = "disabled" | "starting" | "ready" | "unavailable";

export interface HoldersOptions {
  /** the helper program; "" = off */
  helper: string;
  /** the folder that is the machine's root (FILEDECK_ROOT): /proc of the machine is below it */
  root: string;
  ringMb?: number;
  spawn?: SpawnHelper;
  restartMinMs?: number;
  restartMaxMs?: number;
  /** the longest that a question waits for the table to settle (ms, default 8000) */
  settleMs?: number;
  /** a read of one process that gets no answer in this time counts as failed (ms, default 15000) */
  readMs?: number;
  /** mappings are read again for a process whose last read is older than this (ms, default 2000) */
  mapsFreshMs?: number;
  platform?: NodeJS.Platform;
  /** the filesystems that are not tracked, by `statfs` type (default: the list of the kernel side; a test on an overlay folder sets its own) */
  untrackedFs?: ReadonlyMap<number, string>;
  log?: (s: string) => void;
}

export interface Holder {
  pid: number;
  comm: string;
  kinds: HoldKind[];
  container?: string;
  pod?: string;
  /** the table guesses: a held file's folders are not all known */
  uncertain?: boolean;
}

export interface HolderMount {
  mountpoint: string;
  fstype: string;
  reason: "mount inside" | "overlay layer";
}

export interface HoldersAnswer {
  path: string;
  /** true only when the table has no gap that matters: then "no holder" is a proof */
  proven: boolean;
  /** why it is not proven */
  reasons: string[];
  /** anything holds the path: a process, or a mount */
  held: boolean;
  holders: Holder[];
  holdersTruncated?: boolean;
  mounts: HolderMount[];
  feature: { state: HoldersState; reason?: string };
  table: { pids: number; files: number; holds: number };
  at: string;
}

/** The soft hooks of the helper, in the bit order of HELLO.aux (server/native/filedeck-holders.c) */
const SOFT_HOOKS = ["__x64_sys_dup3 (dup3)", "dup2", "security_inode_rename (moves)", "chroot_fs_refs"] as const;
/** Without these the table can miss a hold: a missing one makes every answer unproven */
const UNSOUND_WHEN_MISSING = new Set([0, 1, 2]);

/** The filesystems that the kernel side does not track (the same list as filedeck-holders.bpf.c `untracked_magic`), by `statfs` type and name */
const UNTRACKED_FS = new Map<number, string>([
  [0x9fa0, "proc"], [0x62656572, "sysfs"], [0x27e0eb, "cgroup"], [0x63677270, "cgroup2"], [0x1cd1, "devpts"], [0x794c7630, "overlay"],
  [0x09041934, "anon_inodefs"], [0x534f434b, "sockfs"], [0x50495045, "pipefs"], [0x64626720, "debugfs"], [0x74726163, "tracefs"], [0xcafe4a11, "bpf"],
  [0x6e736673, "nsfs"], [0x19800202, "mqueue"], [0x42494e4d, "binfmt_misc"], [0x73636673, "securityfs"], [0x62656570, "configfs"], [0x6165676c, "pstore"],
  [0xde5e81e4, "efivarfs"],
]);

const MAX_HOLDERS = 500;
const MAX_INFLIGHT = 16;
const MAX_TRIES = 3;

export class Holders extends EventEmitter {
  readonly table = new HoldersTable();
  state: HoldersState;
  reason: string | undefined;
  /** bits of the hooks that the helper could not load */
  softMissing = 0;
  ringBytes = 0;
  /** counters from the helper */
  drops = 0;
  helperEvents = 0;
  restarts = 0;
  snapshots = 0;
  snapshotFailures = 0;
  rate = 0;
  #proc: HelperProc | undefined;
  #decoder = new HolderDecoder();
  #closed = false;
  #backoff = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #seeding = false;
  #inflight = new Map<number, { timer: NodeJS.Timeout; done: Array<() => void> }>();
  #rateAt = 0;
  #rateEvents = 0;
  readonly o: HoldersOptions;

  constructor(o: HoldersOptions) {
    super();
    this.o = o;
    const platform = o.platform ?? process.platform;
    if (!o.helper) {
      this.state = "disabled";
      this.reason = "not enabled (FILEDECK_HOLDERS is not set)";
    } else if (platform !== "linux") {
      this.state = "unavailable";
      this.reason = `needs Linux (this is ${platform})`;
    } else {
      this.state = "starting";
    }
  }

  get #log(): (s: string) => void {
    return this.o.log ?? ((s) => console.error(s));
  }

  /** starts the helper (no-op where the feature is off or unavailable) */
  start(): void {
    if (this.state !== "starting" || this.#proc || this.#closed) return;
    this.#spawn();
  }

  #spawn(): void {
    if (this.#closed) return;
    this.table.reset();
    this.#decoder = new HolderDecoder();
    this.#seeding = false;
    this.softMissing = 0;
    const args = ["--ring-mb", String(this.o.ringMb ?? 16), "--ignore", String(process.pid)];
    let p: HelperProc;
    try {
      p = (this.o.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperProc))(this.o.helper, args);
    } catch (e) {
      this.#unavailable(`the helper did not start: ${(e as Error).message}`);
      return;
    }
    this.#proc = p;
    let startedAt = Date.now();
    p.stdout?.on("data", (chunk: Buffer) => {
      if (this.#proc === p) this.#onData(chunk);
    });
    p.stderr?.on("data", (d: Buffer) => this.#log(`holders helper: ${d.toString().trim().slice(0, 300)}`));
    p.stdin?.on?.("error", () => {});
    let ended = false;
    const gone = (why: string) => {
      if (ended) return;
      ended = true;
      if (this.#proc !== p) return;
      this.#proc = undefined;
      this.#failInflight();
      if (this.#closed || this.state === "unavailable") return;
      // an unexpected end: start again from nothing (the table cannot be trusted over a gap)
      this.restarts++;
      this.state = "starting";
      this.reason = `the helper ended (${why}); restarting`;
      this.table.reset();
      const stable = Date.now() - startedAt > 60_000;
      this.#backoff = stable ? 0 : Math.min(this.o.restartMaxMs ?? 300_000, this.#backoff ? this.#backoff * 2 : (this.o.restartMinMs ?? 1000));
      this.#log(`holders helper ended (${why}); restarting in ${this.#backoff} ms`);
      this.#restartTimer = setTimeout(() => this.#spawn(), this.#backoff);
      this.#restartTimer.unref?.();
      this.emit("progress");
    };
    p.on("error", (e: Error) => {
      if (this.#proc === p && this.state !== "unavailable") this.#unavailable(`the helper did not start: ${e.message}`);
      ended = true;
    });
    p.on("exit", (code: number | null, sig: string | null) => {
      if (code === 3 && this.state !== "unavailable") this.#unavailable("the helper refused to start (status 3)");
      else gone(code === null ? `signal ${sig}` : `status ${code}`);
    });
    startedAt = Date.now();
  }

  #unavailable(reason: string): void {
    this.state = "unavailable";
    this.reason = reason;
    this.table.reset();
    this.#failInflight();
    this.#log(`holders: unavailable: ${reason}`);
    this.emit("progress");
  }

  #onData(chunk: Buffer): void {
    const d = this.#decoder.push(chunk);
    if ("failure" in d) {
      this.#unavailable(d.failure);
      this.#proc?.kill();
      return;
    }
    for (const rec of d.recs) this.#record(rec);
    if (d.recs.length) {
      this.#pump();
      this.emit("progress");
    }
  }

  #record(rec: HolderRec): void {
    switch (rec.type) {
      case HT.HELLO:
        this.softMissing = rec.aux;
        this.ringBytes = rec.chain[0] ?? 0;
        this.table.beginSeed();
        this.#seeding = true;
        return;
      case HT.STATS:
        this.helperEvents = rec.chain[0] ?? 0;
        this.drops = rec.chain[1] ?? 0;
        this.#sampleRate();
        return;
      case HT.SEEDEND:
        this.table.apply(rec);
        this.#seeding = false;
        this.state = "ready";
        this.reason = undefined;
        this.#backoffReset();
        return;
      case HT.SNAPEND: {
        this.table.apply(rec);
        const w = this.#inflight.get(rec.pid);
        if (w) {
          clearTimeout(w.timer);
          this.#inflight.delete(rec.pid);
          this.snapshots++;
          for (const f of w.done) f();
        }
        return;
      }
      default:
        this.table.apply(rec);
    }
  }

  #backoffReset(): void {
    this.#backoff = 0;
  }

  #sampleRate(): void {
    const now = Date.now();
    if (this.#rateAt && now > this.#rateAt) this.rate = Math.max(0, ((this.helperEvents - this.#rateEvents) * 1000) / (now - this.#rateAt));
    this.#rateAt = now;
    this.#rateEvents = this.helperEvents;
  }

  /** asks the helper to read the processes whose events may be lost, a few at a time (nothing runs on a timer: this runs after events arrive) */
  #pump(): void {
    if (this.state === "unavailable" || !this.#proc) return;
    const t = this.table;
    if (this.#seeding) return;
    if (t.globalDirty) {
      // events of unknown pids were lost: read everything again, once
      t.beginSeed();
      this.#seeding = true;
      this.#send("seed\n");
      return;
    }
    for (const pid of t.gaps().dirtyPids) {
      if (this.#inflight.size >= MAX_INFLIGHT) break;
      if (this.#inflight.has(pid) || t.windows.has(pid)) continue;
      const st = t.procs.get(pid);
      if (st && st.failures >= MAX_TRIES) continue;
      this.#request(pid);
    }
  }

  #send(s: string): boolean {
    try {
      this.#proc?.stdin?.write(s);
      return true;
    } catch {
      return false;
    }
  }

  /** reads one process again; resolves when the helper has answered (or the answer did not come) */
  #request(pid: number): Promise<void> {
    const have = this.#inflight.get(pid);
    if (have) return new Promise((r) => have.done.push(r));
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#inflight.delete(pid);
        this.snapshotFailures++;
        this.table.noteFailure(pid);
        resolve();
        this.emit("progress");
      }, this.o.readMs ?? 15_000);
      timer.unref?.();
      this.#inflight.set(pid, { timer, done: [resolve] });
      if (!this.#send(`snap ${pid}\n`)) {
        clearTimeout(timer);
        this.#inflight.delete(pid);
        resolve();
      }
    });
  }

  #failInflight(): void {
    for (const [, w] of this.#inflight) {
      clearTimeout(w.timer);
      for (const f of w.done) f();
    }
    this.#inflight.clear();
  }

  #waitProgress(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.off("progress", done);
        resolve();
      };
      const t = setTimeout(done, ms); // (not unref'd: a question that waits must keep the process alive for this short time)
      this.once("progress", done);
    });
  }

  /** Waits (bounded) until the start-up pass is over and no process is waiting to be read again. */
  async #settle(): Promise<void> {
    const until = Date.now() + (this.o.settleMs ?? 8000);
    for (;;) {
      this.table.settleMoves();
      this.#pump();
      const g = this.table.gaps();
      const waiting = !this.table.seeded || this.table.globalDirty || this.#inflight.size > 0 || g.dirtyPids.length > 0;
      if (!waiting || this.state === "unavailable" || this.state === "disabled" || Date.now() >= until) return;
      await this.#waitProgress(Math.min(250, until - Date.now()));
    }
  }

  // ---- the question ----

  async query(real: string, virtual: string): Promise<HoldersAnswer> {
    const base = (): HoldersAnswer => ({
      path: virtual,
      proven: false,
      reasons: [],
      held: false,
      holders: [],
      mounts: [],
      feature: { state: this.state, ...(this.reason ? { reason: this.reason } : {}) },
      table: this.table.size(),
      at: new Date().toISOString(),
    });
    if (this.state === "disabled" || this.state === "unavailable") return { ...base(), reasons: [this.reason ?? "the holder table is not available"] };
    const reasons: string[] = [];
    const st = await fs.stat(real, { bigint: true });
    const roots: Array<{ dev: number; ino: number }> = [];
    if (st.ino >= 1n << 53n) reasons.push("the inode number of the path is too large to compare");
    roots.push({ dev: kernelDev(st.dev), ino: Number(st.ino) });
    const fsType = (await fs.statfs(real).catch(() => undefined))?.type;
    const untracked = fsType !== undefined ? (this.o.untrackedFs ?? UNTRACKED_FS).get(Number(fsType)) : undefined;
    if (untracked) reasons.push(`the filesystem of the path (${untracked}) is not tracked`);

    // mounts inside the path hold files of other filesystems that belong to it; overlay layers are held by the kernel
    const mounts: HolderMount[] = [];
    for (const m of await this.#mountsUnder(virtual)) {
      mounts.push(m.mount);
      if (m.mount.reason === "mount inside") {
        const ms = await fs.stat(`${this.o.root === "/" ? "" : this.o.root}${m.mount.mountpoint}`, { bigint: true }).catch(() => undefined);
        if (ms && ms.ino < 1n << 53n) roots.push({ dev: kernelDev(ms.dev), ino: Number(ms.ino) });
        else reasons.push(`the mount ${m.mount.mountpoint} could not be read`);
      }
    }

    await this.#settle();
    let found = this.table.find(roots);
    // mappings are never released by an event: the processes that match by a mapping are read again unless that was done just now
    const fresh = this.o.mapsFreshMs ?? 2000;
    const stale = [...found.values()].filter((m) => m.kinds.has("mmap") && Date.now() - (this.table.procs.get(m.pid)?.readAt ?? 0) > fresh).map((m) => m.pid);
    if (stale.length && this.state === "ready") {
      for (const pid of stale) this.table.markDirty(pid);
      await this.#settle();
      found = this.table.find(roots);
    }

    const gaps = this.table.gaps();
    if (this.state !== "ready" || gaps.unseeded) reasons.push("the table is still being filled by the start-up pass");
    if (gaps.global) reasons.push("events of unknown processes were lost: the table is read again");
    if (gaps.dirtyPids.length) reasons.push(`${gaps.dirtyPids.length} processes are being read again after lost events`);
    if (gaps.unreadable.length) reasons.push(`${gaps.unreadable.length} processes could not be read`);
    if (gaps.full) reasons.push("the table is full and stopped taking events");
    for (let i = 0; i < SOFT_HOOKS.length; i++) if (this.softMissing & (1 << i) && UNSOUND_WHEN_MISSING.has(i)) reasons.push(`a hook is missing in this kernel: ${SOFT_HOOKS[i]}`);

    const all = [...found.values()].sort((a, b) => a.pid - b.pid);
    const kindOrder: HoldKind[] = ["cwd", "root", "exe", "fd", "mmap"];
    const holders: Holder[] = [];
    for (const m of all.slice(0, MAX_HOLDERS)) {
      const h: Holder = { pid: m.pid, comm: m.comm, kinds: kindOrder.filter((k) => m.kinds.has(k)) };
      if (m.uncertain) h.uncertain = true;
      Object.assign(h, await this.#where(m.pid));
      holders.push(h);
    }
    const ans = base();
    ans.reasons = reasons;
    ans.proven = reasons.length === 0;
    ans.holders = holders;
    if (all.length > MAX_HOLDERS) ans.holdersTruncated = true;
    ans.mounts = mounts;
    ans.held = holders.length > 0 || mounts.length > 0;
    return ans;
  }

  /** the container and pod of a process, from its cgroup */
  async #where(pid: number): Promise<{ container?: string; pod?: string }> {
    try {
      const text = await fs.readFile(`${this.o.root === "/" ? "" : this.o.root}/proc/${pid}/cgroup`, "utf8");
      return parseCgroup(text);
    } catch {
      return {};
    }
  }

  async #mountsUnder(virtual: string): Promise<Array<{ mount: HolderMount }>> {
    let text: string;
    try {
      text = await fs.readFile(`${this.o.root === "/" ? "" : this.o.root}/proc/1/mountinfo`, "utf8");
    } catch {
      return [];
    }
    return mountsUnder(text, virtual).map((mount) => ({ mount }));
  }

  // ---- metrics ----

  metrics(): string[] {
    const sz = this.table.size();
    const g = this.table.gaps();
    return [
      "# HELP filedeck_holders_available 1 when the holder table is live (the eBPF helper runs and the start-up pass is done)",
      "# TYPE filedeck_holders_available gauge",
      `filedeck_holders_available ${this.state === "ready" ? 1 : 0}`,
      "# HELP filedeck_holders_state The state of the holder table: disabled, starting, ready or unavailable",
      "# TYPE filedeck_holders_state gauge",
      ...(["disabled", "starting", "ready", "unavailable"] as const).map((s) => `filedeck_holders_state{state="${s}"} ${this.state === s ? 1 : 0}`),
      "# HELP filedeck_holders_table_pids Processes in the holder table",
      "# TYPE filedeck_holders_table_pids gauge",
      `filedeck_holders_table_pids ${sz.pids}`,
      "# HELP filedeck_holders_table_files Distinct held files in the holder table",
      "# TYPE filedeck_holders_table_files gauge",
      `filedeck_holders_table_files ${sz.files}`,
      "# HELP filedeck_holders_table_holds Holds (process and file pairs) in the holder table",
      "# TYPE filedeck_holders_table_holds gauge",
      `filedeck_holders_table_holds ${sz.holds}`,
      "# HELP filedeck_holders_events_total Events that the kernel side sent",
      "# TYPE filedeck_holders_events_total counter",
      `filedeck_holders_events_total ${this.helperEvents}`,
      "# HELP filedeck_holders_events_per_second Events per second between the last two reports of the helper",
      "# TYPE filedeck_holders_events_per_second gauge",
      `filedeck_holders_events_per_second ${this.rate.toFixed(1)}`,
      "# HELP filedeck_holders_ring_drops_total Events that did not fit in the ring buffer (the processes are read again)",
      "# TYPE filedeck_holders_ring_drops_total counter",
      `filedeck_holders_ring_drops_total ${this.drops}`,
      "# HELP filedeck_holders_unproven_pids Processes that are waiting to be read again or could not be read",
      "# TYPE filedeck_holders_unproven_pids gauge",
      `filedeck_holders_unproven_pids ${g.dirtyPids.length + g.unreadable.length}`,
      "# HELP filedeck_holders_unreadable_pids Processes that could not be read after several tries",
      "# TYPE filedeck_holders_unreadable_pids gauge",
      `filedeck_holders_unreadable_pids ${g.unreadable.length}`,
      "# HELP filedeck_holders_snapshots_total Processes that were read again",
      "# TYPE filedeck_holders_snapshots_total counter",
      `filedeck_holders_snapshots_total ${this.snapshots}`,
      "# HELP filedeck_holders_snapshot_failures_total Reads of one process that got no answer in time",
      "# TYPE filedeck_holders_snapshot_failures_total counter",
      `filedeck_holders_snapshot_failures_total ${this.snapshotFailures}`,
      "# HELP filedeck_holders_helper_restarts_total Unexpected ends of the helper",
      "# TYPE filedeck_holders_helper_restarts_total counter",
      `filedeck_holders_helper_restarts_total ${this.restarts}`,
    ];
  }

  status(): { state: HoldersState; reason?: string; pids: number; files: number; holds: number } {
    return { state: this.state, ...(this.reason ? { reason: this.reason } : {}), ...this.table.size() };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#restartTimer);
    this.#failInflight();
    const p = this.#proc;
    this.#proc = undefined;
    try {
      p?.stdin?.write("quit\n");
    } catch {
      // the helper ends when its input closes
    }
    p?.kill();
  }
}

/** The container id (12 characters) and the pod uid of a cgroup file (cgroup v1 and v2, containerd, CRI-O, Docker). */
export function parseCgroup(text: string): { container?: string; pod?: string } {
  const out: { container?: string; pod?: string } = {};
  const c = /(?:cri-containerd-|crio-|docker-|containerd-|libpod-)([0-9a-f]{64})(?:\.scope)?/.exec(text) ?? /\/(?:docker|kubepods[^\n]*)\/([0-9a-f]{64})\b/.exec(text);
  if (c) out.container = c[1]!.slice(0, 12);
  const p = /pod([0-9a-f]{8}[_-][0-9a-f]{4}[_-][0-9a-f]{4}[_-][0-9a-f]{4}[_-][0-9a-f]{12})/.exec(text);
  if (p) out.pod = p[1]!.replaceAll("_", "-");
  return out;
}

const octal = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
const under = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);

/**
 * The mounts of the machine (the text of /proc/1/mountinfo) that belong to a folder: a mount whose mount point is inside it, and an overlay that uses
 * a folder inside it (or it) as a layer, which the kernel holds.
 */
export function mountsUnder(mountinfo: string, dir: string): HolderMount[] {
  const out: HolderMount[] = [];
  for (const line of mountinfo.split("\n")) {
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const pre = line.slice(0, dash).split(" ");
    const post = line.slice(dash + 3).split(" ");
    const mountpoint = octal(pre[4] ?? "");
    const fstype = post[0] ?? "";
    const superOpts = post.slice(2).join(" ");
    if (mountpoint && mountpoint !== dir && under(mountpoint, dir) && fstype !== "overlay") out.push({ mountpoint, fstype, reason: "mount inside" });
    if (fstype === "overlay") {
      const layers = /(?:^|,)(?:lowerdir\+?|upperdir|workdir|datadir\+?)=([^,]*)/g;
      let hit = false;
      for (let m = layers.exec(superOpts); m; m = layers.exec(superOpts)) {
        for (const d of octal(m[1]!).split(":")) if (d && under(d, dir)) hit = true;
      }
      if (hit) out.push({ mountpoint, fstype, reason: "overlay layer" });
    }
  }
  return out;
}
