import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { countMountExclusions, listMounts, readMountRoots, type Mount } from "./mounts.ts";
import { isReservedName } from "./paths.ts";
import type { EventBus } from "./events/bus.ts";
import type { NewEvent } from "./events/types.ts";

/**
 * Keeps the size store current from kernel change notifications (fanotify, via the small native helper
 * `filedeck-fanwatch`, see server/native) and feeds every change to the event bus (events/bus.ts). The helper prints one line per changed entry:
 *   KIND DIR PATH | R DIR NEW<TAB>OLD | #caps ... | #ready N | #stats ... | c PATH | !overflow | #sync
 *   (KIND: C created, D deleted, M modified, W closed after writing, A attributes; DIR: d folder, f other)
 * An older helper printed one line per changed folder (`x|w|m PATH`); those lines still feed the size store.
 * Each changed folder (the entry's parent, and for a folder entry the folder itself) goes to `SizeStore.applyChanged`, debounced per folder (pending folders live in the size store's SQLite file, see SizeStore.notePending): structure changes and closed writes
 * settle for `settleMs`, an ongoing write (modify) re-reads a folder at most every `modifyMs`.
 * Without the helper, the capabilities or kernel support the agent logs once and keeps the TTL/mtime behaviour.
 */

export interface HelperProc extends EventEmitter {
  /** a line written here is answered with `#sync` once the helper has read every event the kernel had queued (see `FanWatch.sync`) */
  stdin?: { write(s: string): unknown; on?(ev: "error", f: () => void): unknown; removeListener?(ev: "error", f: () => void): unknown } | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(): boolean;
}
export type SpawnHelper = (cmd: string, args: string[]) => HelperProc;

export interface FanWatchOptions {
  /** helper binary; empty = disabled */
  helper: string;
  root: string;
  procMounts: string;
  settleMs?: number;
  modifyMs?: number;
  spawn?: SpawnHelper;
  /** restart backoff after an unexpected helper exit */
  restartMinMs?: number;
  restartMaxMs?: number;
  /** pending changed folders held in memory (only while the store is unusable) before the burst is treated like a kernel overflow */
  maxPending?: number;
  /** on `handover`, how long the helper keeps running for a newer process to take over (default 6000) */
  handoverMs?: number;
  /** how often the watcher's run reports to the store and asks for the `since` it may use (default 1000) */
  sessionMs?: number;
  /** reconcile the host mount table, so new and removed mounts receive watcher coverage */
  reconcileMs?: number;
  /** the event bus every change is published to (default: none) */
  bus?: EventBus;
  /**
   * The agent's own state files (the event journal, the stores): a change there is not published, else every write of the journal would be an event that
   * is written to the journal. Gets an agent path; true = leave the entry out (see events/own-state.ts: it must be the agent's own folder, not a name alike).
   */
  ignorePath?: (virtual: string) => boolean;
}

const KIND_OF = { C: "create", D: "delete", M: "modify", W: "close_write", A: "attrib" } as const;

/** a changed folder whose lock was busy is tried again after this long (ms) */
const RETRY_MS = 1000;

export interface ChangeSink {
  /** false when `wait` is false and an overlapping walk holds or waits for the lock: nothing was applied, the caller tries the folder again later */
  applyChanged(virtual: string, ctl?: undefined, opts?: { wait?: boolean }): Promise<boolean | void>;
  markStale(virtual: string): void;
  /** keep changed folders on disk: false when that is not possible (the watcher then keeps them in memory) */
  notePending?(items: { path: string; dueAt: number; modify: boolean }[], modifyMs: number): Promise<boolean>;
  /** folders due at `now` (oldest first, at most `limit`), marked as run; null = the backlog was too old to drain: the store marked the pending folders stale itself and dropped the rows */
  takeDue?(now: number, limit: number, t: { modifyMs: number; settleMs: number }): Promise<string[] | null>;
  /** re-reads ended at `endedAt`: modifyMs counts from there. `hold` = push a waiting row to endedAt + modifyMs (false when a settle event arrived since the folder was taken) */
  noteRan?(runs: { path: string; endedAt: number; hold: boolean }[], modifyMs: number): Promise<void>;
  clearPending?(): Promise<void>;
  /** durable dirty marks for folders whose last run may not have finished (see SizeStore.markDirty); false when not possible */
  markDirty?(paths: string[]): Promise<boolean>;
  /** false while another process holds the store's writer lease: this one only reads, so events wait in memory and nothing is applied */
  readonly isWriter?: boolean;
  /** watcher sessions: see SizeStore.sessionStart / sessionTick / sessionEnd */
  sessionStart?(mountsHash: string, readyAt: number): Promise<number | null>;
  sessionTick?(id: number, mountsHash: string, readyAt: number, lostAt: number): Promise<{ since: number; newer: boolean; minEpoch: number | null } | null>;
  sessionEnd?(id: number, clean: boolean, lostAt: number): Promise<void>;
}

// Linux hosts in this fleet can have more than 256 bind and loop mounts.
// Keep the limit above the supported host inventory and report any remainder as unwatched.
const MAXFS = 4096;
const FLUSH_MS = 250;
const FLUSH_MAX = 2000;
const DRAIN_BATCH = 256;
const SESSION_MS = 1000;
const RECONCILE_MS = 30_000;

/** Agent virtual path of a helper path (as the helper's mount namespace sees it, i.e. under the agent root), or null outside the root or inside a trash store. */
export function mapPath(root: string, hostPath: string): string | null {
  if (!hostPath.startsWith("/")) return null;
  let v: string;
  if (root === "/") v = hostPath;
  else if (hostPath === root) v = "/";
  else if (hostPath.startsWith(root + "/")) v = hostPath.slice(root.length);
  else return null;
  return v.split("/").some(isReservedName) ? null : v;
}

/** Inverse of the helper's escaping: `\\` and `\xHH`. Lines are split on "\n" only, which the helper never leaves unescaped inside a path. */
export const unescapeLine = (s: string) => (s.includes("\\") ? unescapeText(s) : s);
const unescapeText = (s: string) => s.replace(/\\(?:(\\)|x([0-9a-f]{2}))/g, (_, b?: string, h?: string) => (b ? "\\" : String.fromCharCode(parseInt(h!, 16))));

export class FanWatch {
  private proc: HelperProc | null = null;
  /** events not yet handed to the store: the only per-folder state in memory, at most FLUSH_MAX entries */
  private buf = new Map<string, { at: number; modify: boolean }>();
  private inflight = 0;
  /** events handed to the store and not yet stored (count per folder) */
  private flushing = new Map<string, number>();
  /** the store is read for due folders only until this time (events were noted lately) or after a take that found some; the first drain always reads */
  private activeUntil = 0;
  private firstTake = true;
  private lastTake = 0;
  private resume: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** fallback while the store is unusable: due time per folder (capped by maxPending), and last runs for the modify interval */
  private mem = new Map<string, number>();
  private lastRun = new Map<string, number>();
  /** folders taken but not yet re-read to the end: true once a settle event for it was handed to the store meanwhile */
  private taken = new Map<string, boolean>();
  private draining = false;
  /** the watcher's run in the store (see SizeStore.sessionStart), the time from which every change was seen without a gap, and whether it saw every change so far */
  private session: { id: number; hash: string; readyAt: number } | null = null;
  private since = Infinity;
  /** when events were last lost (a kernel overflow, too many held in memory): nothing from before it is vouched for, the run goes on */
  private lostAt = 0;
  /** the run continues a predecessor that ended clean (see `SizeStore.sessionTick`): its validations count */
  private chain: number | null = null;
  private syncing: (() => void)[] = [];
  private lastSession = 0;
  private handingOver = false;
  private stopped = false;
  private warned = false;
  private marks: string[] = [];
  private unwatched: string[] = [];
  /** when the helper reported #ready (every mark is in place); Infinity while it is not running or not ready */
  private readyAt = Infinity;
  private settleMs: number;
  private modifyMs: number;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private mountSignature = "";
  private mountCount = 0;
  private watchedCount = 0;
  private reconcileError = "";
  private lostEvents = 0;
  private excludedMounts = 0;
  /** what the helper said about itself (`#caps`) and its counters (`#stats`) */
  private caps = "";
  private helperStats: Record<string, number> = {};
  /** when the watcher last stopped seeing events (0 = it has not stopped since it last was ready) */
  private gapFrom = 0;

  constructor(
    private store: ChangeSink,
    private o: FanWatchOptions,
  ) {
    this.settleMs = o.settleMs ?? 1000;
    this.modifyMs = o.modifyMs ?? 30_000;
  }

  private warn(msg: string) {
    if (this.warned) return;
    this.warned = true;
    console.error(`fanotify watcher off, folder sizes refresh by age and folder mtime only: ${msg}`);
  }

  private lastLog = 0;
  private backoff = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private note(msg: string) {
    if (Date.now() - this.lastLog < 60_000) return;
    this.lastLog = Date.now();
    console.error(`fanotify watcher: ${msg}`);
  }

  /** Spawn the helper for every local filesystem under the root. Never throws. */
  async start(): Promise<void> {
    if (!this.o.helper || this.proc || this.stopped) return;
    this.ensureTimer(); // also drains folders a previous run left pending
    try {
      const all = await listMounts(this.o.root, this.o.procMounts);
      this.excludedMounts = await countMountExclusions(this.o.root, this.o.procMounts);
      const mounts = all.filter((m) => !m.network && !m.unreachable);
      this.unwatched = all.filter((m) => m.network || m.unreachable).map((m) => m.mountpoint);
      // Fanotify marks a whole filesystem, and the helper marks each one once. It still needs every mount of it: a filesystem is often shown at more
      // than one place (bind mounts of some of its folders), and the helper reports an entry under each mount that shows it. So every local mount
      // is passed, aliases too (an absolute path each, nothing else). When there are more than the helper takes, one mount of every
      // filesystem comes first, and the rest of the aliases are reported as unwatched.
      const unique = this.limit(mounts);
      const hostPaths = unique.map((m) => (this.o.root === "/" ? m.mountpoint : this.o.root + (m.mountpoint === "/" ? "" : m.mountpoint)));
      this.marks = unique.map((m) => m.mountpoint);
      const kept = new Set(this.marks);
      this.unwatched.push(...mounts.filter((m) => !kept.has(m.mountpoint)).map((m) => m.mountpoint));
      this.mountCount = all.length;
      this.watchedCount = unique.length;
      this.mountSignature = await this.signature(mounts);
      if (!hostPaths.length) return this.warn("no local filesystem under the root");
      if (this.stopped) return;
      const p = (this.o.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperProc))(this.o.helper, hostPaths);
      this.proc = p;
      this.readyAt = Infinity;
      let err = "";
      p.stderr?.on("data", (d: Buffer) => (err = (err + d).slice(-500)));
      p.stdin?.on?.("error", () => {}); // a helper that is gone: writing to it must not be an unhandled error (a sync then simply does not happen)
      p.on("error", (e: Error) => this.warn(e.message));
      p.on("exit", (code: number | null, sig: string | null) => {
        if (this.proc !== p) return;
        this.proc = null;
        this.readyAt = Infinity;
        this.endSession(false);
        if (this.stopped) return;
        this.announceStopped(`the helper exited (${code ?? sig})`);
        // 2 = not permitted, 3 = not supported: retrying cannot help. Anything else may have lost events.
        if (code === 2 || code === 3 || !this.o.helper) return this.warn(err.trim() || `helper exited (${code})`);
        for (const m of this.marks) this.store.markStale(m);
        this.backoff = Math.min(this.o.restartMaxMs ?? 300_000, this.backoff ? this.backoff * 2 : (this.o.restartMinMs ?? 1000));
        this.note(`helper exited (${code ?? sig}${err.trim() ? ": " + err.trim() : ""}), restarting in ${this.backoff} ms`);
        this.restartTimer = setTimeout(() => void this.start(), this.backoff);
        this.restartTimer.unref();
      });
      let buf = "";
      p.stdout?.setEncoding?.("utf8");
      p.stdout?.on("data", (d: string | Buffer) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > 65_536) buf = ""; // no helper line is this long
        // the store is behind: stop reading until it has taken what is in flight
        if (this.inflight >= 4 && p.stdout?.pause) {
          p.stdout.pause();
          this.resume = () => {
            if (this.inflight >= 4) return;
            this.resume = null;
            p.stdout?.resume();
          };
        }
      });
      this.ensureReconcileTimer();
    } catch (e) {
      this.warn((e as Error).message);
    }
  }

  /** The mounts the helper is given: all of them, or the first MAXFS when there are more (one mount of every filesystem first, so none is left out for an alias). */
  private limit(mounts: Mount[]): Mount[] {
    if (mounts.length <= MAXFS) return mounts;
    const first = new Map<string, Mount>();
    for (const m of mounts) first.set(`${m.device}\0${m.fstype}`, first.get(`${m.device}\0${m.fstype}`) ?? m);
    const lead = new Set(first.values());
    return [...lead, ...mounts.filter((m) => !lead.has(m))].slice(0, MAXFS);
  }

  /**
   * What the helper's view depends on: each mount, its filesystem and the folder of it that the mount shows (mountinfo "root"). The helper reads the
   * roots itself when it starts, so a change of any of them (a bind mount that is replaced by one of another folder) restarts it, and its table is made again.
   */
  private async signature(mounts: Mount[]): Promise<string> {
    const roots = await readMountRoots(this.o.root, this.o.procMounts);
    return mounts.map((m) => `${m.mountpoint}\0${m.device}\0${m.fstype}\0${roots.get(m.mountpoint) ?? ""}`).sort().join("\n");
  }

  /** Rebuild helper marks after a mount or bind alias changes. This marks affected trees stale. */
  private ensureReconcileTimer() {
    if (this.reconcileTimer || this.stopped) return;
    this.reconcileTimer = setInterval(() => void this.reconcileMounts(), this.o.reconcileMs ?? RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  private async reconcileMounts() {
    if (this.stopped || this.handingOver || !this.proc) return;
    try {
      const all = await listMounts(this.o.root, this.o.procMounts);
      this.excludedMounts = await countMountExclusions(this.o.root, this.o.procMounts);
      const mounts = all.filter((m) => !m.network && !m.unreachable);
      const signature = await this.signature(mounts);
      this.mountCount = all.length;
      if (signature === this.mountSignature) return;
      const affected = new Set([...this.marks, ...mounts.map((m) => m.mountpoint)]);
      for (const m of affected) this.store.markStale(m);
      this.note(`mount table changed, restarting coverage for ${affected.size} mount roots`);
      this.mountSignature = signature;
      this.proc.kill();
    } catch (e) {
      this.reconcileError = String((e as Error)?.message ?? e);
      this.note(`mount reconciliation failed: ${this.reconcileError}`);
    }
  }

  status() {
    return {
      running: !!this.proc,
      ready: this.readyAt !== Infinity,
      mounts: this.mountCount,
      watched: this.watchedCount,
      unwatched: this.unwatched.length,
      excluded: this.excludedMounts,
      backlog: this.buf.size + this.flushing.size + this.mem.size + this.taken.size,
      lostEvents: this.lostEvents,
      reconcileError: this.reconcileError,
      caps: this.caps,
      helper: { ...this.helperStats },
    };
  }

  /**
   * True when the helper is running and `virtual` lies on a watched filesystem with no unwatched one below it, so stored sizes are kept current.
   * Overflow and exit mark the rows stale, so the next read re-scans them and is current again.
   */
  covers(virtual: string): boolean {
    if (!this.proc || this.readyAt === Infinity) return false; // marks are not all in place yet
    const under = (dir: string, v: string) => dir === "/" || v === dir || v.startsWith(dir + "/");
    const home = (v: string, dirs: string[]) => dirs.filter((d) => under(d, v)).reduce((a, d) => Math.max(a, d.length), -1);
    if (home(virtual, this.marks) <= home(virtual, this.unwatched)) return false;
    return !this.unwatched.some((d) => d !== virtual && under(virtual, d));
  }

  /**
   * True when no change of `virtual`, of any folder above it or of anything below it is waiting in this watcher: still in the helper's pipe (reading is
   * paused), buffered, being handed to the store, held in memory, or taken and not yet applied. Changes in the store's pending table, and the ones
   * the store handed out, are the store's to check (SizeStore.freshTree).
   */
  settled(virtual: string): boolean {
    if (this.resume) return false; // output is not being read: events may be waiting in the pipe
    const pre = virtual === "/" ? "/" : virtual + "/";
    const hit = (p: string) => p === "/" || p === virtual || p.startsWith(pre) || virtual.startsWith(p + "/");
    for (const p of this.buf.keys()) if (hit(p)) return false;
    for (const p of this.flushing.keys()) if (hit(p)) return false;
    for (const p of this.mem.keys()) if (hit(p)) return false;
    for (const p of this.taken.keys()) if (hit(p)) return false;
    return true;
  }

  /** Rows written before this time were not watched while they aged (the restart gap): the size store gives them the TTL rule, not the watcher's trust. */
  chainMin(): number | null {
    return this.chain;
  }

  watchedSince(): number {
    return this.readyAt === Infinity ? Infinity : this.since;
  }

  private endSession(clean: boolean) {
    const s = this.session;
    this.session = null;
    if (s) void this.store.sessionEnd?.(s.id, clean, this.lostAt);
  }

  /**
   * Stop for a rolling deploy: take no more work, hand every event noted so far to the store, keep the helper running until a newer process over the same
   * mounts reports ready (at most `handoverMs`), and only then end the run as clean. The newer process continues the watched time from this run's `since`, so
   * nothing it stored has to be read again. Without a newer process the run ends clean anyway: its events are all in the store.
   */
  async handover(waitMs = this.o.handoverMs ?? 6000): Promise<void> {
    this.handingOver = true;
    try {
      if (this.proc && this.readyAt !== Infinity && this.session) {
        const sess = this.session;
        for (let i = 0; this.draining && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
        await this.flush();
        const until = Date.now() + waitMs;
        while (Date.now() < until && this.session === sess) {
          const t = await this.store.sessionTick?.(sess.id, sess.hash, sess.readyAt, this.lostAt);
          if (!t || t.newer) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // A newer run is watching now, so only what this one has not yet read from its helper can be missing: ask the helper to read what the kernel has queued
        // and wait for its answer. Without that (an old helper, a stuck pipe) the run is not reported clean.
        const synced = await this.sync(1500);
        await this.flush();
        const clean = synced && !this.resume && !this.buf.size && !this.mem.size && !this.inflight && !this.draining && !this.taken.size;
        this.session = null;
        await this.store.sessionEnd?.(sess.id, clean, this.lostAt);
      }
    } finally {
      this.stop();
    }
  }

  /** True when the helper has written every event the kernel had queued when this was called and `line` has seen them all. */
  private sync(timeoutMs: number): Promise<boolean> {
    const stdin = this.proc?.stdin;
    if (!stdin) return Promise.resolve(false);
    return new Promise((res) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        stdin.removeListener?.("error", broken);
        this.syncing = this.syncing.filter((f) => f !== fire);
        res(ok);
      };
      const fire = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.syncing.push(fire);
      const broken = () => done(false);
      stdin.on?.("error", broken);
      try {
        stdin.write("sync\n");
      } catch {
        done(false);
      }
    });
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    this.buf.clear();
    this.mem.clear();
    this.proc?.kill();
    this.proc = null;
    this.readyAt = Infinity;
    if (this.o.bus) this.o.bus.ready = false;
  }

  /** One helper output line. */
  line(l: string) {
    if (l === "!overflow") return this.overflow();
    if (l === "#sync") return void this.syncing.slice().forEach((f) => f());
    if (l.startsWith("#stats ")) return void this.stats(l);
    if (l.startsWith("#caps ")) return void (this.caps = l.slice(6));
    if (l.startsWith("#ready")) {
      this.backoff = 0;
      this.readyAt = Date.now();
      this.since = this.readyAt;
      this.lostAt = 0;
      this.chain = null;
      void this.beginSession(this.readyAt);
      this.announceReady();
    }
    if (l.startsWith("c ")) {
      const host = unescapeLine(l.slice(2));
      const v = mapPath(this.o.root, host);
      if (v) {
        this.unwatched.push(v); // the mark failed: stored sizes there are never trusted past the TTL
        this.publish({ kind: "reset", scope: "filesystem", path: v, reason: "no event covers this filesystem" });
      }
      return void this.note(`cannot watch ${host}, changes there are seen only by age and folder mtime`);
    }
    const kind = l[0] as string;
    // an entry event: KIND DIR PATH (a move: NEW<TAB>OLD)
    if (l[1] === " " && l[3] === " " && (l[2] === "d" || l[2] === "f") && "CDMWAR".includes(kind)) return void this.entry(kind, l[2] === "d", l.slice(4));
    // an older helper: one line per folder
    if ((kind !== "x" && kind !== "w" && kind !== "m") || l[1] !== " ") return;
    const v = mapPath(this.o.root, unescapeLine(l.slice(2)));
    if (v) this.schedule(v, kind === "m");
  }

  /** One changed entry: it goes to the bus, and its folders (the one that holds it, and a folder entry itself) to the size store. */
  private entry(kind: string, dir: boolean, rest: string) {
    const tab = kind === "R" ? rest.indexOf("\t") : -1;
    const host = unescapeLine(tab >= 0 ? rest.slice(0, tab) : rest);
    const old = tab >= 0 ? mapPath(this.o.root, unescapeLine(rest.slice(tab + 1))) : null;
    const v = mapPath(this.o.root, host);
    const own = (p: string | null) => !!p && !!this.o.ignorePath && this.o.ignorePath(p);
    if (kind === "R") {
      // a move from or to a place outside what is served (or a trash store) is a create or a delete as far as this agent shows
      if (own(v) || own(old)) return void [v, old].forEach((p) => p && this.touch(p, dir, false));
      if (v && old) this.publish({ kind: "move", dir, path: v, from: old });
      else if (v) this.publish({ kind: "create", dir, path: v });
      else if (old) this.publish({ kind: "delete", dir, path: old });
      for (const p of [v, old]) if (p) this.touch(p, dir, false);
      return;
    }
    if (!v) return;
    if (!own(v)) this.publish({ kind: KIND_OF[kind as keyof typeof KIND_OF], dir, path: v });
    this.touch(v, dir, kind === "M");
  }

  private touch(v: string, dir: boolean, modify: boolean) {
    const i = v.lastIndexOf("/");
    this.schedule(i <= 0 ? "/" : v.slice(0, i), modify);
    if (dir && !modify) this.schedule(v, false);
  }

  private publish(ev: NewEvent) {
    this.o.bus?.publish(ev);
  }

  /** The helper is ready: subscribers learn it, and, after a time without a watcher, which window may hold missed events. */
  private announceReady() {
    const bus = this.o.bus;
    if (!bus) return;
    bus.ready = true;
    bus.setUnwatched(this.unwatched);
    const now = Date.now();
    if (this.gapFrom) this.publish({ kind: "reset", scope: "node", window: { from: this.gapFrom, to: now }, reason: "the watcher was not running" });
    this.gapFrom = 0;
    this.publish({ kind: "ready", scope: "node", ...(this.unwatched.length ? { unwatched: [...this.unwatched] } : {}) });
  }

  /** The helper went away: what is held in memory about folders (the compare index, live feeds) is told at once. */
  private announceStopped(why: string) {
    const bus = this.o.bus;
    if (!bus) return;
    bus.ready = false;
    if (!this.gapFrom) this.gapFrom = Date.now();
    this.publish({ kind: "reset", scope: "node", window: { from: this.gapFrom }, reason: why });
  }

  /** `#stats events=1 hits=2 ...` */
  private stats(l: string) {
    for (const kv of l.slice(7).split(" ")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined && Number.isFinite(Number(v))) this.helperStats[k] = Number(v);
    }
  }

  /**
   * The store answers from a file again (back after an outage, or a new generation after a heal): the session of this run, if any, was in the old file
   * and its chain of epochs means nothing in the new one. A new session starts there; nothing from before now is vouched for.
   */
  storeReplaced() {
    if (this.stopped || this.readyAt === Infinity || this.handingOver) return;
    this.session = null;
    this.chain = null;
    this.lostAt = Date.now();
    this.since = Math.max(this.since, this.lostAt);
    void this.beginSession(this.readyAt);
  }

  private async beginSession(readyAt: number) {
    if (!this.store.sessionStart) return;
    const hash = createHash("sha1").update([...this.marks].sort().join("\0")).digest("hex");
    const id = await this.store.sessionStart(hash, readyAt);
    if (id !== null && !this.stopped && this.readyAt === readyAt) this.session = { id, hash, readyAt };
  }

  /** Once a second: the run's heartbeat, and the `since` the store lets it use now that the run before it may have ended. */
  private async sessionTick() {
    const s = this.session;
    if (!s || Date.now() - this.lastSession < (this.o.sessionMs ?? SESSION_MS) || this.handingOver) return;
    this.lastSession = Date.now();
    const t = await this.store.sessionTick?.(s.id, s.hash, s.readyAt, this.lostAt);
    if (t && this.session === s) {
      this.since = Math.max(t.since, this.lostAt);
      this.chain = t.minEpoch;
    }
  }

  /** Events were lost: forget the pending folders and let the next read re-scan the watched trees. */
  private overflow() {
    this.lostEvents++;
    const now = Date.now();
    this.publish({ kind: "overflow", scope: "node", window: { from: this.o.bus?.lastEventAt || now, to: now }, reason: "the kernel dropped events" });
    this.since = this.lostAt = Math.max(this.since, Date.now());
    this.buf.clear();
    this.mem.clear();
    void this.store.clearPending?.();
    for (const m of this.marks) this.store.markStale(m);
  }

  private ensureTimer() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), Math.max(10, Math.min(FLUSH_MS, this.settleMs)));
    this.timer.unref();
  }

  private schedule(v: string, modify: boolean) {
    this.ensureTimer();
    const cur = this.buf.get(v);
    // a settle event wins over a modify event: it is not held back by the modify interval
    this.buf.set(v, { at: cur ? Math.min(cur.at, Date.now() + this.settleMs) : Date.now() + this.settleMs, modify: (cur?.modify ?? true) && modify });
    if (this.buf.size >= FLUSH_MAX) void this.flush();
  }

  /** Hand the buffered events to the store (disk). With no usable store they wait in memory, capped like the old behaviour. */
  private async flush(): Promise<void> {
    if (!this.buf.size) return;
    const items = [...this.buf].map(([path, e]) => ({ path, dueAt: e.at, modify: e.modify }));
    this.buf = new Map();
    for (const i of items) if (!i.modify && this.taken.has(i.path)) this.taken.set(i.path, true);
    this.inflight++;
    for (const i of items) this.flushing.set(i.path, (this.flushing.get(i.path) ?? 0) + 1);
    try {
      if (this.store.notePending && (await this.store.notePending(items, this.modifyMs))) return void (this.activeUntil = Date.now() + this.modifyMs + this.settleMs);
      this.keepInMemory(items);
    } finally {
      for (const i of items) {
        const n = (this.flushing.get(i.path) ?? 1) - 1;
        if (n > 0) this.flushing.set(i.path, n);
        else this.flushing.delete(i.path);
      }
      this.inflight--;
      this.resume?.();
    }
  }

  private keepInMemory(items: { path: string; dueAt: number; modify: boolean }[]) {
    for (const i of items) {
      const at = i.modify ? Math.max(i.dueAt, (this.lastRun.get(i.path) ?? 0) + this.modifyMs) : i.dueAt;
      const cur = this.mem.get(i.path);
      if (cur !== undefined && cur <= at) continue;
      if (cur === undefined && this.mem.size >= (this.o.maxPending ?? 50_000)) {
        this.note("too many changed folders pending, treating it as an overflow");
        this.since = this.lostAt = Math.max(this.since, Date.now());
        this.mem.clear();
        for (const m of this.marks) this.store.markStale(m);
        return;
      }
      this.mem.set(i.path, at);
    }
  }

  private async tick() {
    await this.flush();
    await this.drain();
    await this.sessionTick();
  }

  /** The re-reads ended (or failed): modifyMs counts from their end, not from when the folders were taken. One write per batch. */
  private async ran(ends: [string, number][]) {
    const runs = ends.map(([path, endedAt]) => ({ path, endedAt, hold: !this.taken.get(path) }));
    for (const [v] of ends) this.taken.delete(v);
    for (const { path, endedAt, hold } of runs) {
      if (this.lastRun.has(path)) {
        this.lastRun.delete(path);
        this.lastRun.set(path, endedAt);
      }
      const at = this.mem.get(path);
      if (at !== undefined && hold) this.mem.set(path, Math.max(at, endedAt + this.modifyMs));
    }
    try {
      if (runs.length) await this.store.noteRan?.(runs, this.modifyMs);
    } catch {
      /* the rows keep the take time */
    }
  }

  /** Folders that were busy (an overlapping walk holds the lock): due again after RETRY_MS, on disk when possible, else in memory. */
  private async retryLater(paths: string[]) {
    const dueAt = Date.now() + RETRY_MS;
    const items = paths.map((path) => ({ path, dueAt, modify: false }));
    try {
      if (this.store.notePending && (await this.store.notePending(items, this.modifyMs))) return void (this.activeUntil = Math.max(this.activeUntil, dueAt + this.modifyMs + this.settleMs));
    } catch {
      /* in memory below */
    }
    this.keepInMemory(items);
  }

  /** Apply the folders whose time has come, one after the other, taking them from the store a batch at a time. */
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && !this.handingOver && this.store.isWriter !== false) {
        const now = Date.now();
        let batch: string[] | null = [];
        if (this.store.takeDue && (this.firstTake || now <= this.activeUntil || now - this.lastTake >= this.modifyMs)) {
          // the periodic read catches a row that fell due after activeUntil (a modify row waits for last_run + modifyMs, an event loop stall can skip its window)
          this.firstTake = false;
          this.lastTake = now;
          batch = await this.store.takeDue(now, DRAIN_BATCH, { modifyMs: this.modifyMs, settleMs: this.settleMs });
          if (batch === null) {
            // the store marked just those folders stale (nothing was lost, only not applied): the watched trees stay trusted
            this.note("changed folders are too far behind, marking them stale to be re-read on access");
            break;
          }
        }
        if (!batch.length && this.mem.size) {
          batch = [...this.mem].filter(([, at]) => at <= now).slice(0, DRAIN_BATCH).map(([p]) => p);
          for (const p of batch) {
            this.mem.delete(p);
            this.lastRun.delete(p);
            this.lastRun.set(p, now);
          }
          // insertion order = age order: drop the old ones from the front, stop at the first young one
          for (const [k, t] of this.lastRun) {
            if (now - t <= this.modifyMs) break;
            this.lastRun.delete(k);
          }
        }
        if (!batch.length) break;
        for (const v of batch) this.taken.set(v, false);
        const ends: [string, number][] = [];
        // folders whose lock was busy: never queue behind a long walk (that would block every walk asked after it), try them again soon.
        // (Not a dirty mark: a folder that is not stored yet has no row to mark, and a stale mark would collapse on a long busy spell.)
        const busy: string[] = [];
        for (const v of batch) {
          if (this.stopped || this.handingOver) break;
          try {
            if ((await this.store.applyChanged(v, undefined, { wait: false })) === false) busy.push(v);
          } catch {
            /* a folder that vanished or cannot be read: the next scan deals with it */
          }
          ends.push([v, Date.now()]);
        }
        // taken and not applied (the process is stopping): dirty, so the next process re-reads them
        const rest = batch.filter((v) => !ends.some(([e]) => e === v));
        if (rest.length) {
          if (!(await this.store.markDirty?.(rest))) for (const v of rest) this.store.markStale(v);
          for (const v of rest) this.taken.delete(v);
        }
        await this.ran(ends); // before the next take, so a row noted during the batch is held until modifyMs after its folder's end
        if (busy.length) await this.retryLater(busy); // after `ran`: that makes the rows idle, this gives them their new due time
        if (this.store.takeDue) this.activeUntil = Math.max(this.activeUntil, Date.now() + this.modifyMs + this.settleMs); // rows may remain after a slow batch
      }
    } finally {
      this.draining = false;
    }
  }
}
