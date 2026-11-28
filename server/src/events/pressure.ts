import fs from "node:fs/promises";
import path from "node:path";
import { Deadline } from "../deadline.ts";
import { networkKind, parseMounts, readMountTable } from "../mounts.ts";
import type { Matchable, NewEvent } from "./types.ts";

/**
 * Filesystem pressure events (docs/change-events.md, "Pressure"). The kernel watcher already sees every write on a machine, so the event flow is the clock:
 * while changes happen, a rate limited `statfs` of the filesystem that holds the changed path (at most one per `minGapMs`, plus one trailing sample
 * after a burst) tells the free space. No change event, no sample, no timer. A level change (`ok`, `reserve`, `critical`) and a growth breach
 * (`growthBytes` lost inside `growthWindowSec`) publish one `pressure` event each. Deletes and attribute changes count as flow too: space comes back
 * at the last close of a deleted file.
 */
export type Level = "ok" | "reserve" | "critical";

export interface Thresholds {
  /** the level is `reserve` at or below this much free space (bytes or a share of the filesystem), `critical` at or below the second pair. 0 = off */
  reserveFreeBytes: number;
  reserveFreePercent: number;
  criticalFreeBytes: number;
  criticalFreePercent: number;
  /** a growth breach: this many bytes lost inside `growthWindowSec`. 0 = off */
  growthBytes: number;
  growthWindowSec: number;
}

export interface PressureLevelsConfig {
  default: Thresholds;
  /** per filesystem (by any path on it, the longest mount point wins) */
  filesystems: ({ path: string } & Partial<Thresholds>)[];
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  reserveFreeBytes: 0,
  reserveFreePercent: 15,
  criticalFreeBytes: 0,
  criticalFreePercent: 5,
  growthBytes: 0,
  growthWindowSec: 3600,
};

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);

function thresholds(o: unknown, base: Thresholds): Thresholds {
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return {
    reserveFreeBytes: num(r.reserveFreeBytes, base.reserveFreeBytes),
    reserveFreePercent: Math.min(100, num(r.reserveFreePercent, base.reserveFreePercent)),
    criticalFreeBytes: num(r.criticalFreeBytes, base.criticalFreeBytes),
    criticalFreePercent: Math.min(100, num(r.criticalFreePercent, base.criticalFreePercent)),
    growthBytes: num(r.growthBytes, base.growthBytes),
    growthWindowSec: Math.max(60, Math.min(6 * 3600, num(r.growthWindowSec, base.growthWindowSec))),
  };
}

/** FILEDECK_PRESSURE_LEVELS: a JSON object `{"default":{...},"filesystems":[{"path":"/data","reserveFreePercent":20}]}`. Empty = off. Throws on bad JSON. */
export function parseLevels(text: string): PressureLevelsConfig | undefined {
  if (!text.trim()) return undefined;
  const o = JSON.parse(text) as { default?: unknown; filesystems?: unknown };
  const def = thresholds(o.default, DEFAULT_THRESHOLDS);
  const list = Array.isArray(o.filesystems) ? o.filesystems : [];
  const filesystems = list
    .filter((f): f is { path: string } => !!f && typeof (f as { path?: unknown }).path === "string" && (f as { path: string }).path.startsWith("/"))
    .map((f) => ({ path: f.path.length > 1 ? f.path.replace(/\/+$/, "") : f.path, ...thresholds(f, def) }));
  return { default: def, filesystems };
}

const RANK: Record<Level, number> = { ok: 0, reserve: 1, critical: 2 };

/** The level for a free space. After a level was reached, the free space must rise 1% of the size above its threshold to leave it (no flapping at a threshold). */
export function levelOf(avail: number, size: number, t: Thresholds, prev: Level = "ok"): Level {
  const hit = (bytes: number, pct: number, l: Level) => {
    const pad = RANK[prev] >= RANK[l] && prev !== "ok" ? size * 0.01 : 0;
    return (bytes > 0 && avail <= bytes + pad) || (pct > 0 && size > 0 && avail <= (size * pct) / 100 + pad);
  };
  if (hit(t.criticalFreeBytes, t.criticalFreePercent, "critical")) return "critical";
  if (hit(t.reserveFreeBytes, t.reserveFreePercent, "reserve")) return "reserve";
  return "ok";
}

export interface FsState {
  path: string;
  level: Level;
  availBytes: number;
  sizeBytes: number;
  freePercent: number;
  loss1h: number;
  loss6h: number;
  growthBreach: boolean;
  /** ms since the epoch of the sample */
  at: number;
  thresholds: Thresholds;
}

interface Fs {
  path: string;
  dev: number;
  real: string;
  t: Thresholds;
  level: Level;
  breach: boolean;
  lastAt: number;
  /** a change was seen since the last sample */
  dirty: boolean;
  sampling: boolean;
  trail: Deadline;
  /** (time, avail) points, at most one per minute, six hours back */
  ring: { at: number; avail: number }[];
  state?: FsState;
}

export interface PressureWatcherOptions {
  /** the host root and the mount table, as the other agent parts use them */
  root: string;
  procMounts: string;
  config: PressureLevelsConfig;
  /** the bus: `publish` and `listen` */
  bus: { listen(fn: (e: Matchable) => void): () => void; publish(e: NewEvent): void; ready: boolean };
  /** one `statfs` per filesystem and gap (default 10 s) */
  minGapMs?: number;
  /** the mount table is read again after this long, while changes happen (default 60 s) */
  mountsMs?: number;
  now?: () => number;
  /** called after a pressure event (level above ok or a breach): the disk pressure collector reads once, so that the attribution is current */
  onBreach?: () => void;
  log?: (s: string) => void;
  /** replaces fs.statfs and fs.stat (tests) */
  statfs?: (p: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
  devOf?: (p: string) => Promise<number>;
}

const RING_MS = 6 * 3600_000;
const RING_STEP_MS = 60_000;

export class PressureWatcher {
  private readonly o: PressureWatcherOptions & { minGapMs: number; mountsMs: number; now: () => number };
  private fsList: Fs[] = [];
  private mountsAt = 0;
  private loading?: Promise<void>;
  private off?: () => void;
  private closed = false;
  samples = 0;
  published = 0;

  constructor(o: PressureWatcherOptions) {
    this.o = { minGapMs: 10_000, mountsMs: 60_000, now: Date.now, ...o };
    // The listener is cheap: a longest-prefix lookup in a short list. It starts nothing while the list is empty.
    this.off = o.bus.listen((e) => this.event(e));
  }

  close(): void {
    this.closed = true;
    this.off?.();
    for (const f of this.fsList) f.trail.clear();
  }

  /** Read the mount table: the local filesystems, one entry for each device (the shortest mount point). Only called while changes happen or a request asks. */
  private async loadMounts(): Promise<void> {
    const now = this.o.now();
    if (this.fsList.length && now - this.mountsAt < this.o.mountsMs) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const text = await readMountTable(this.o.root, this.o.procMounts);
      const stat = this.o.devOf ?? (async (p: string) => (await fs.stat(p)).dev);
      const byDev = new Map<number, Fs>();
      const old = new Map(this.fsList.map((f) => [f.path, f]));
      for (const m of parseMounts(text).sort((a, b) => a.mountpoint.length - b.mountpoint.length)) {
        if (networkKind(m.fstype) || m.fstype === "tmpfs") continue;
        const real = path.join(this.o.root, m.mountpoint);
        let dev: number;
        try {
          dev = await stat(real);
        } catch {
          continue;
        }
        if (byDev.has(dev)) continue;
        const prev = old.get(m.mountpoint);
        byDev.set(dev, prev ? Object.assign(prev, { dev, real }) : this.newFs(m.mountpoint, dev, real));
      }
      for (const f of old.values()) if (![...byDev.values()].includes(f)) f.trail.clear();
      this.fsList = [...byDev.values()].sort((a, b) => b.path.length - a.path.length);
      // the thresholds of a filesystem: the first configured path that lies on it, else the default
      for (const f of this.fsList) {
        const c = this.o.config.filesystems.find((x) => this.find(x.path) === f);
        f.t = c ? thresholds(c, this.o.config.default) : this.o.config.default;
      }
      this.mountsAt = this.o.now();
    })().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private newFs(mount: string, dev: number, real: string): Fs {
    const f: Fs = { path: mount, dev, real, t: this.o.config.default, level: "ok", breach: false, lastAt: 0, dirty: false, sampling: false, ring: [], trail: new Deadline(() => void this.sample(f)) };
    return f;
  }

  private find(p: string): Fs | undefined {
    for (const f of this.fsList) if (f.path === "/" || p === f.path || p.startsWith(f.path + "/")) return f;
    return undefined;
  }

  private event(e: Matchable): void {
    if (this.closed || e.kind === "pressure" || e.kind === "overflow" || e.kind === "ready") return;
    if (e.kind === "reset") return void this.replay();
    if (e.path === undefined) return;
    const f = this.find(e.path);
    if (!f) {
      // no filesystem is known yet (the first event), or the table is old: read it, then place this change
      if (!this.loading && (!this.fsList.length || this.o.now() - this.mountsAt >= this.o.mountsMs)) void this.loadMounts().then(() => this.place(e.path as string)).catch(() => undefined);
      return;
    }
    this.touch(f);
    if (e.from !== undefined) {
      const g = this.find(e.from);
      if (g && g !== f) this.touch(g);
    }
  }

  /** A `reset` on the bus: readers look at everything again, so the current level of every filesystem is published once more. */
  private async replay(): Promise<void> {
    try {
      await this.loadMounts();
      for (const f of this.fsList) await this.sample(f, true);
    } catch {
      /* the next change tries again */
    }
  }

  private place(p: string): void {
    const f = this.find(p);
    if (f) this.touch(f);
  }

  /** A change on `f`: sample now when the gap allows it, else make sure that one trailing sample comes at the end of the gap. */
  private touch(f: Fs): void {
    const now = this.o.now();
    f.dirty = true;
    if (f.sampling) return;
    const due = f.lastAt + this.o.minGapMs;
    if (now >= due) void this.sample(f);
    else f.trail.arm(due);
  }

  private async sample(f: Fs, force = false): Promise<FsState | undefined> {
    if (this.closed || f.sampling) return f.state;
    f.sampling = true;
    f.trail.clear();
    f.dirty = false;
    try {
      const s = await (this.o.statfs ?? fs.statfs)(f.real);
      const now = this.o.now();
      f.lastAt = now;
      this.samples++;
      const size = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      this.record(f, now, avail);
      const loss1h = this.loss(f, now, 3600_000, avail);
      const loss6h = this.loss(f, now, RING_MS, avail);
      const winMs = f.t.growthWindowSec * 1000;
      const lossWin = this.loss(f, now, winMs, avail);
      const level = levelOf(avail, size, f.t, f.level);
      const breach = f.t.growthBytes > 0 && lossWin >= f.t.growthBytes;
      const st: FsState = { path: f.path, level, availBytes: avail, sizeBytes: size, freePercent: size ? Math.round((avail / size) * 1e4) / 100 : 0, loss1h, loss6h, growthBreach: breach, at: now, thresholds: f.t };
      const levelChanged = level !== f.level;
      const breachStarted = breach && !f.breach;
      f.level = level;
      f.breach = breach;
      f.state = st;
      if (levelChanged || breachStarted || force) {
        this.published++;
        this.o.bus.publish({
          kind: "pressure",
          dir: true,
          path: f.path,
          level,
          availBytes: avail,
          sizeBytes: size,
          loss1h,
          loss6h,
          reason: levelChanged ? `level ${level}` : force && !breachStarted ? `level ${level} (replayed)` : `growth: ${lossWin} bytes lost in ${f.t.growthWindowSec} s`,
        });
        if (level !== "ok" || breachStarted) {
          try {
            this.o.onBreach?.();
          } catch {
            /* the collector's fault is its own */
          }
        }
      }
      return st;
    } catch (e) {
      this.o.log?.(`pressure: statfs of ${f.path} failed (${(e as Error).message})`);
      return f.state;
    } finally {
      f.sampling = false;
      // a change came while the sample ran: one trailing sample at the end of the gap
      if (f.dirty && !this.closed) f.trail.arm(f.lastAt + this.o.minGapMs);
    }
  }

  private record(f: Fs, now: number, avail: number): void {
    const last = f.ring[f.ring.length - 1];
    if (last && now - last.at < RING_STEP_MS) last.avail = avail;
    else f.ring.push({ at: now, avail });
    while (f.ring.length > 1 && now - f.ring[0]!.at > RING_MS + RING_STEP_MS) f.ring.shift();
  }

  /** Bytes lost inside the last `ms` (the oldest point inside the window, less the free space now), never below 0. */
  private loss(f: Fs, now: number, ms: number, avail: number): number {
    const from = f.ring.find((p) => now - p.at <= ms);
    return from ? Math.max(0, from.avail - avail) : 0;
  }

  /** The level of every local filesystem now (one `statfs` each). This is the demand of `GET /api/v1/pressure`. */
  async current(): Promise<FsState[]> {
    await this.loadMounts();
    const out: FsState[] = [];
    for (const f of this.fsList) {
      const st = f.lastAt && this.o.now() - f.lastAt < 1000 ? f.state : await this.sample(f);
      if (st) out.push(st);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** `GET /api/v1/pressure` on the agent: the level of each local filesystem now. It is the demand: one `statfs` per filesystem. Sign-in and the token scope are the hub's. */
export function registerFsPressureRoutes(app: import("hono").Hono, node: string, watcher: PressureWatcher): void {
  app.get("/api/v1/pressure", async (c) => {
    const list = await watcher.current();
    return c.json(
      {
        node,
        at: Date.now(),
        filesystems: list.map(({ path: p, level, availBytes, sizeBytes, freePercent, loss1h, loss6h, growthBreach, at }) => ({ path: p, level, availBytes, sizeBytes, freePercent, loss1h, loss6h, growthBreach, at })),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
}
