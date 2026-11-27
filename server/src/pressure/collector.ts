import fs from "node:fs";
import { CgroupIoSampler } from "./cgroup.ts";
import { diskRates, parentDisk, parseDiskstats, pickDisks, type DiskCounters, type DiskRates } from "./diskstats.ts";
import { IoTrace, type TraceRow } from "./iotrace.ts";
import { LabelRules, PodIndex, parseKubeCgroup, parseUnit } from "./labels.ts";
import { blockMounts, parseMountInfoFull, remoteMounts, type MountEntry } from "./mountinfo.ts";
import { PathCounter } from "./pathcount.ts";
import { parsePsi } from "./psi.ts";
import { ProcIoSampler, type ProcRow } from "./procio.ts";
import type { Consumer, DiskSnapshot, Pod, Psi, PressureSource, Rates, Snapshot } from "./types.ts";
import { ZERO_PSI } from "./types.ts";

/** The part of the event bus the collector needs: a listener that sees every change event. */
export interface EventSource {
  listen(fn: (e: { kind: string; path?: string }) => void): () => void;
}

export interface CollectorOptions {
  node: string;
  /** sample interval while a stream is open (ms) */
  intervalMs: number;
  /** the host's root as this process sees it (FILEDECK_ROOT): /var/log/pods and the mount table are read below it */
  hostRoot: string;
  cgroupRoot: string;
  procRoot: string;
  /** FILEDECK_PRESSURE_LABELS */
  labels?: string;
  /** folder parts under a mount that make a path consumer */
  pathDepth: number;
  /** path of filedeck-iotrace; empty = no eBPF */
  iotrace?: string;
  bus?: EventSource;
  diskstatsFile?: string;
  psiFile?: string;
  sysBlock?: string;
  mountinfoFile?: string;
  /** cadence while only the metrics scrape reads (default 15 s) */
  scrapeMs?: number;
  now?: () => number;
  log?: (s: string) => void;
  /** replaces child_process.spawn for the helper (tests) */
  spawn?: ConstructorParameters<typeof IoTrace>[0]["spawn"];
  /** most consumers kept per disk (default 100) */
  keep?: number;
}

const PATH_KEEP = 10;
const TOP_CGROUPS_FOR_PROCS = 20;
const TOP_CGROUPS_FOR_PSI = 10;
const FULL_SCAN_MS = 5000;
const MOUNTS_MS = 30_000;
const RUNTIME_MOUNT = /^\/(var\/lib\/(kubelet|containerd|docker|rancher|k0s|cni|snapd)|run|proc|sys|dev|snap|var\/run)(\/|$)/;

interface Meta {
  label: string;
  pod?: Pod;
  unit?: string;
  link?: string;
  at: number;
  seen: number;
}

const sumRates = (r: Rates) => r.rIops + r.wIops;

/**
 * The live disk pressure of this machine (docs/disk-pressure.md). It samples only while somebody reads it: a stream or a one-shot request
 * (every `intervalMs`) or the metrics scrape (every `scrapeMs`, for a few minutes after the last scrape). Everything is kept in memory.
 */
export class PressureCollector {
  private readonly o: Required<Omit<CollectorOptions, "bus" | "labels" | "iotrace" | "spawn" | "log">> & Pick<CollectorOptions, "bus" | "labels" | "iotrace" | "spawn" | "log">;
  private readonly cg: CgroupIoSampler;
  private readonly procs: ProcIoSampler;
  private readonly pods: PodIndex;
  private readonly rules: LabelRules;
  private readonly paths: PathCounter;
  private readonly trace?: IoTrace;
  private streams = 0;
  private scrapeUntil = 0;
  private timer?: NodeJS.Timeout;
  private cadence = 0;
  private active = false;
  private unlisten?: () => void;
  private prev?: { at: number; disks: Map<string, DiskCounters> };
  private snap?: Snapshot;
  private seq = 0;
  private waiters: ((s: Snapshot) => void)[] = [];
  private formatted = new WeakMap<Snapshot, Map<string, string>>();
  private cpuMicros = 0;
  private listenNs = 0n;
  private samples = 0;
  private metas = new Map<string, Meta>();
  private metaSweep = 0;
  private mountsAt = 0;
  private wholeDisks?: Set<string>;
  private mountList: MountEntry[] = [];
  private diskMounts = new Map<string, string[]>();
  private mountToDisk = new Map<string, string>();
  private mountedDevs = new Set<string>();
  private devToDisk = new Map<string, string>();
  private ids = new Map<number, string>();
  private idsWalkAt = 0;
  private cgOk?: boolean;
  private lastProcRows: { rows: ProcRow[]; at: number } = { rows: [], at: 0 };
  private lastSource: PressureSource = "proc";
  /** cgroup and process attribution runs every `cgStride`th sample, so that the sampling stays under 1% of a CPU on a machine with many busy cgroups */
  private cgStride = 1;
  private cgSkip = 0;
  private cpuEma = 0;
  private lastCons?: Map<string, Consumer[]>;
  private psiCache = new Map<string, { at: number; v: number | undefined }>();

  constructor(opts: CollectorOptions) {
    this.o = {
      scrapeMs: 15_000, now: Date.now, keep: 100,
      diskstatsFile: "/proc/diskstats", psiFile: "/proc/pressure/io", sysBlock: "/sys/block", mountinfoFile: "",
      ...opts,
    };
    const log = opts.log;
    this.cg = new CgroupIoSampler({ root: opts.cgroupRoot, now: this.o.now, log });
    this.procs = new ProcIoSampler({ root: opts.procRoot, now: this.o.now });
    this.pods = new PodIndex({ hostRoot: opts.hostRoot, now: this.o.now });
    this.rules = new LabelRules(opts.labels, log);
    this.paths = new PathCounter(Math.max(1, Math.floor(opts.pathDepth) || 3));
    if (opts.iotrace) this.trace = new IoTrace({ helper: opts.iotrace, intervalMs: opts.intervalMs, now: this.o.now, log, spawn: opts.spawn });
  }

  // ---- lifecycle ----

  /** A reader that needs fresh snapshots (a stream, a one-shot request). Call the returned function when it is done. */
  acquire(): () => void {
    this.streams++;
    this.reconcile();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.streams--;
      this.reconcile();
    };
  }

  /** The metrics scrape asks for the numbers: sampling goes on at the slow cadence for a few scrape intervals. */
  touchScrape(): void {
    this.scrapeUntil = this.o.now() + 3 * this.o.scrapeMs;
    this.reconcile();
  }

  get running(): boolean {
    return this.active;
  }
  get readers(): number {
    return this.streams;
  }

  private want(): number {
    if (this.streams > 0) return this.o.intervalMs;
    if (this.o.now() < this.scrapeUntil) return this.o.scrapeMs;
    return 0;
  }

  private reconcile(): void {
    const want = this.want();
    if (!want) return this.stop();
    if (this.active && this.cadence === want) return;
    const faster = this.active && want < this.cadence;
    this.cadence = want;
    if (!this.active) this.start();
    else if (faster) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.tick(); // a baseline at once: the slow samples cover too long a time
    }
  }

  private start(): void {
    this.active = true;
    if (this.o.bus) {
      this.unlisten = this.o.bus.listen((e) => {
        if (e.kind === "overflow" || e.kind === "reset" || e.kind === "ready" || !e.path) return;
        const t = process.hrtime.bigint();
        this.paths.add(e.path);
        this.listenNs += process.hrtime.bigint() - t;
      });
    }
    this.trace?.start();
    this.tick();
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    this.cadence = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    this.trace?.stop();
    this.prev = undefined; // the next start sets a new baseline: the old one would span the idle time
    this.lastCons = undefined;
    this.cgSkip = 0;
    this.paths.take();
  }

  /** Stops everything (shutdown). */
  close(): void {
    this.streams = 0;
    this.scrapeUntil = 0;
    this.stop();
    for (const w of this.waiters.splice(0)) w(this.snap as Snapshot);
  }

  private tick(): void {
    if (!this.active) return;
    const c0 = process.cpuUsage();
    try {
      this.sampleOnce();
    } catch (e) {
      this.o.log?.(`disk pressure: a sample failed (${(e as Error).message})`);
    }
    const c1 = process.cpuUsage(c0);
    this.cpuMicros += c1.user + c1.system;
    const want = this.want();
    this.govern((c1.user + c1.system) / 1000, want);
    if (!want) return this.stop();
    this.cadence = want;
    clearTimeout(this.timer);
    // (not unref'd: it exists only while somebody reads, and `close` clears it at shutdown)
    this.timer = setTimeout(() => this.tick(), want);
  }

  /**
   * The budget: the sampling uses at most about 0.8% of one CPU. When a sample costs more (a machine with many busy cgroups), the cgroup and
   * process attribution runs less often (every 2nd to 8th sample); the disk numbers stay at every sample. It goes back when the cost falls.
   */
  private govern(cpuMs: number, cadenceMs: number): void {
    if (!cadenceMs || this.samples <= 2) return; // (the first samples set baselines: they cost more and say nothing)
    this.cpuEma = this.cpuEma === 0 ? cpuMs : 0.8 * this.cpuEma + 0.2 * cpuMs;
    const share = this.cpuEma / cadenceMs;
    if (share > 0.008 && this.cgStride < 8) {
      this.cgStride++;
      this.cpuEma *= (this.cgStride - 1) / this.cgStride;
    } else if (share < 0.003 && this.cgStride > 1) {
      this.cgStride--;
      this.cpuEma *= (this.cgStride + 1) / this.cgStride;
    }
  }

  /** every how many samples the cgroup and process attribution is read (1 = every sample) */
  get stride(): number {
    return this.cgStride;
  }

  // ---- reading ----

  get latest(): Snapshot | undefined {
    return this.snap;
  }
  get sequence(): number {
    return this.seq;
  }
  /** CPU seconds spent by the sampling code (and the event counting) */
  get probeSeconds(): number {
    return this.cpuMicros / 1e6 + Number(this.listenNs) / 1e9;
  }
  get sampleCount(): number {
    return this.samples;
  }
  get source(): PressureSource {
    return this.lastSource;
  }
  get intervalMs(): number {
    return this.o.intervalMs;
  }

  /** The next snapshot after sequence number `after`. Resolves with the latest one at once when it is newer. */
  next(after: number, signal?: AbortSignal): Promise<Snapshot | undefined> {
    if (this.snap && this.seq > after) return Promise.resolve(this.snap);
    return new Promise((resolve) => {
      const done = (s: Snapshot | undefined) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(s);
      };
      const w = (s: Snapshot) => done(s);
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        done(undefined);
      };
      if (signal?.aborted) return done(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  /** One snapshot for a one-shot request: the latest when it is fresh, else the next one (the sampling starts and stops for it). */
  async once(signal?: AbortSignal): Promise<Snapshot | undefined> {
    const release = this.acquire();
    try {
      if (this.snap && this.o.now() - this.snap.at < this.o.intervalMs * 2 && this.cadence === this.o.intervalMs) return this.snap;
      const after = this.seq;
      const timeout = AbortSignal.timeout(Math.max(5000, this.o.intervalMs * 5));
      return await this.next(after, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } finally {
      release();
    }
  }

  /** The JSON line (no line feed) of a snapshot for one client's filter; the lines are made once for clients with the same filter. */
  format(s: Snapshot, disk: string | undefined, top: number): string {
    let m = this.formatted.get(s);
    if (!m) this.formatted.set(s, (m = new Map()));
    const key = `${disk ?? ""}|${top}`;
    let line = m.get(key);
    if (line === undefined) {
      line = JSON.stringify(trim(s, disk, top));
      m.set(key, line);
    }
    return line;
  }

  // ---- sampling ----

  private join(p: string): string {
    return this.o.hostRoot === "/" ? p : this.o.hostRoot + p;
  }

  private refreshMounts(now: number, all: DiskCounters[]): void {
    if (this.wholeDisks && now - this.mountsAt < MOUNTS_MS) return;
    this.mountsAt = now;
    try {
      this.wholeDisks = new Set(fs.readdirSync(this.o.sysBlock));
    } catch {
      this.wholeDisks = undefined;
    }
    let text = "";
    for (const f of [this.o.mountinfoFile, this.join("/proc/1/mountinfo"), "/proc/self/mountinfo"]) {
      if (!f) continue;
      try {
        text = fs.readFileSync(f, "utf8");
        break;
      } catch {
        /* try the next */
      }
    }
    const entries = parseMountInfoFull(text);
    this.mountList = blockMounts(entries);
    this.mountedDevs = new Set(this.mountList.map((m) => m.dev));
    // device numbers to whole disk names: partitions belong to their disk
    this.devToDisk = new Map(all.map((d) => [`${d.major}:${d.minor}`, parentDisk(d.name)]));
    const names = new Set(all.map((d) => d.name));
    this.mountToDisk = new Map();
    const perDisk = new Map<string, Set<string>>();
    for (const m of this.mountList) {
      let disk = this.devToDisk.get(m.dev);
      if (!disk && m.source.startsWith("/dev/")) {
        const base = parentDisk(m.source.slice(5));
        if (names.has(base)) disk = base;
      }
      if (!disk) continue;
      this.mountToDisk.set(m.mountpoint, disk);
      const set = perDisk.get(disk) ?? new Set<string>();
      set.add(m.mountpoint);
      perDisk.set(disk, set);
    }
    // the mounts shown for a disk: the ones a person would name. Container runtime mounts (per pod volumes and the like) are left out, the shortest paths come first.
    this.diskMounts = new Map([...perDisk].map(([d, s]) => [d, [...s].filter((p) => !RUNTIME_MOUNT.test(p)).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 8)]));
    // folders count under the longest mount that holds them; network mounts are in the list so that they are not counted under "/"
    // (when there are too many, the deepest mounts are dropped: their changes then count under the mount above, on the same disk)
    const points = [...new Set([...this.mountList, ...remoteMounts(entries)].map((m) => m.mountpoint))].sort((a, b) => a.length - b.length).slice(0, 512);
    this.paths.setMounts(points);
  }

  private meta(cg: string, now: number): Meta {
    let m = this.metas.get(cg);
    const kube = parseKubeCgroup(cg);
    if (m && !(kube && !m.pod && now - m.at > 30_000)) {
      m.seen = now;
      return m;
    }
    const pod = kube ? this.pods.lookup(kube.uid, kube.containerId) : undefined;
    const unit = kube ? undefined : parseUnit(cg);
    let label: string;
    if (kube) label = pod ? `${pod.namespace}/${pod.name}${pod.container ? "/" + pod.container : ""}` : `pod ${kube.uid.slice(0, 8)}${kube.containerId ? " " + kube.containerId.slice(0, 8) : ""}`;
    else label = unit ?? (cg.split("/").filter(Boolean).pop() || "/");
    const rule = this.rules.apply(cg);
    m = { label: rule?.label || label, ...(pod ? { pod } : {}), ...(unit ? { unit } : {}), ...(rule?.link ? { link: rule.link } : {}), at: now, seen: now };
    this.metas.set(cg, m);
    return m;
  }

  private sweepMetas(now: number): void {
    if (now - this.metaSweep < 60_000) return;
    this.metaSweep = now;
    for (const [k, m] of this.metas) if (now - m.seen > 600_000) this.metas.delete(k);
  }

  /** One sample now (the timer calls it; tests too). Publishes a snapshot from the second sample on. */
  sampleOnce(): void {
    const now = this.o.now();
    let all: DiskCounters[];
    try {
      all = parseDiskstats(fs.readFileSync(this.o.diskstatsFile, "utf8"));
    } catch {
      all = [];
    }
    this.refreshMounts(now, all);
    const disks = pickDisks(all, this.mountedDevs, { wholeDisks: this.wholeDisks });
    const cur = new Map(disks.map((d) => [d.name, d]));
    const prev = this.prev;
    this.prev = { at: now, disks: cur };
    this.samples++;
    // the cgroup and helper deltas are taken in every sample, so a baseline sample still resets them
    const dtMs = prev ? now - prev.at : 0;
    const trace = this.trace?.state === "running" ? this.trace.take() : undefined;
    const skipCg = !trace && this.cgStride > 1 && this.lastCons !== undefined && ++this.cgSkip % this.cgStride !== 0;
    const cgSample = skipCg ? undefined : this.cgSampleOrNothing();
    const pathCounts = this.paths.take();
    if (!prev || dtMs < 50) return; // a baseline: there is nothing to compare yet
    if (this.cadence && dtMs > this.cadence * 2 + 500 && this.cadence <= this.o.intervalMs) return; // the first sample after a slower cadence spans too long
    const want = this.cadence || this.o.intervalMs;

    let psi: Psi = structuredClone(ZERO_PSI);
    try {
      psi = parsePsi(fs.readFileSync(this.o.psiFile, "utf8"));
    } catch {
      /* no pressure accounting */
    }

    const rates = new Map<string, DiskRates>();
    for (const d of disks) {
      const p = prev.disks.get(d.name);
      if (p) rates.set(d.name, diskRates(p, d, dtMs));
    }
    const perDisk = new Map<string, Consumer[]>();
    const add = (disk: string, c: Consumer) => {
      let l = perDisk.get(disk);
      if (!l) perDisk.set(disk, (l = []));
      l.push(c);
    };
    const diskOf = (dev: string): string | undefined => {
      const n = this.devToDisk.get(dev);
      return n && rates.has(n) ? n : undefined;
    };

    let source: PressureSource = "proc";
    if (trace) {
      source = "ebpf";
      this.traceConsumers(trace, now, diskOf, add);
    } else if (skipCg && this.lastCons) {
      for (const [disk, list] of this.lastCons) for (const c of list) add(disk, c); // the last attribution stands for this sample
    } else {
      if (cgSample) {
        for (const [cg, devs] of cgSample.own) {
          const m = this.meta(cg, now);
          for (const [dev, r] of devs) {
            const disk = diskOf(dev);
            if (disk) add(disk, this.cgConsumer(cg, m, r));
          }
        }
      }
      // processes: in the proc source, from the busiest cgroups (or all processes now and then without a cgroup tree)
      this.procConsumers(now, cgSample?.own, rates, diskOf, add);
      this.lastCons = new Map([...perDisk].map(([d, l]) => [d, [...l]]));
    }
    this.lastSource = source;

    // path consumers: change events per top folder
    const dts = Math.max(0.001, dtMs / 1000);
    const pathRows = new Map<string, Consumer[]>();
    for (const [folder, v] of pathCounts.folders) {
      const disk = this.mountToDisk.get(v.mount);
      if (!disk || !rates.has(disk)) continue;
      const l = pathRows.get(disk) ?? [];
      l.push({ kind: "path", id: `path:${folder}`, label: folder, path: folder, rIops: 0, wIops: 0, rBps: 0, wBps: 0, eventsPerSec: round(v.count / dts, 2) });
      pathRows.set(disk, l);
    }

    // io.pressure of the cgroups that are listed
    // (a cgroup's pressure is read at most every 5 s: the kernel does real work for each read, and avg10 moves slowly)
    const fullOf = (cg: string): number | undefined => {
      const hit = this.psiCache.get(cg);
      if (hit && now - hit.at < 5000) return hit.v;
      const v = this.cg.pressure(cg)?.full.avg10;
      this.psiCache.set(cg, { at: now, v });
      return v;
    };
    if (this.psiCache.size > 500) for (const [k, h] of this.psiCache) if (now - h.at > 60_000) this.psiCache.delete(k);

    const out: DiskSnapshot[] = [];
    for (const d of disks) {
      const r = rates.get(d.name);
      if (!r) continue;
      const list = (perDisk.get(d.name) ?? []).sort((a, b) => sumRates(b) - sumRates(a) || b.rBps + b.wBps - (a.rBps + a.wBps)).slice(0, this.o.keep);
      let n = 0;
      for (const c of list) if (c.kind === "cgroup" && c.cgroup && n++ < TOP_CGROUPS_FOR_PSI) {
        const v = fullOf(c.cgroup);
        if (v !== undefined) c.psiFull10 = v;
      }
      const paths = (pathRows.get(d.name) ?? []).sort((a, b) => (b.eventsPerSec ?? 0) - (a.eventsPerSec ?? 0)).slice(0, PATH_KEEP);
      out.push({
        name: d.name, dev: `${d.major}:${d.minor}`, mounts: this.diskMounts.get(d.name) ?? [],
        util: round(r.util, 4), rIops: round(r.rIops, 1), wIops: round(r.wIops, 1), rBps: Math.round(r.rBps), wBps: Math.round(r.wBps),
        queueDepth: round(r.queueDepth, 2), rAwaitMs: round(r.rAwaitMs, 2), wAwaitMs: round(r.wAwaitMs, 2), inflight: r.inflight,
        consumers: [...list.map(roundConsumer), ...paths],
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    const snap: Snapshot = { type: "snapshot", node: this.o.node, at: now, intervalMs: want, source, psi, disks: out };
    this.snap = snap;
    this.seq++;
    for (const w of this.waiters.splice(0)) w(snap);
    this.sweepMetas(now);
  }

  private cgSampleOrNothing(): ReturnType<CgroupIoSampler["sample"]> | undefined {
    if (this.trace?.state === "running") return undefined; // the helper's rows replace the io.stat reading
    if (this.cgOk === false && this.samples % 20 !== 1) return undefined; // no usable cgroup tree: tried again now and then
    const s = this.cg.sample();
    this.cgOk = s.reads > 0 && (s.own.size > 0 || !s.baseline || this.cg.nodes > 1);
    return s.baseline ? undefined : s;
  }

  private cgConsumer(cg: string, m: Meta, r: Rates): Consumer {
    return {
      kind: "cgroup", id: cg, label: m.label, cgroup: cg,
      ...(m.pod ? { pod: m.pod } : {}), ...(m.unit ? { unit: m.unit } : {}), ...(m.link ? { link: m.link } : {}),
      rIops: r.rIops, wIops: r.wIops, rBps: r.rBps, wBps: r.wBps,
    };
  }

  private cgPath(id: number, now: number): string | undefined {
    let p = this.ids.get(id);
    if (!p && now - this.idsWalkAt >= 30_000) {
      this.idsWalkAt = now;
      this.ids = this.cg.walkIds();
      p = this.ids.get(id);
    }
    return p;
  }

  private traceConsumers(t: { rows: TraceRow[]; ms: number }, now: number, diskOf: (dev: string) => string | undefined, add: (d: string, c: Consumer) => void): void {
    const dt = Math.max(0.001, t.ms / 1000);
    const byCg = new Map<string, Consumer>();
    const byPid = new Map<string, Consumer>();
    for (const r of t.rows) {
      const disk = diskOf(r.dev);
      if (!disk) continue;
      const path = this.cgPath(r.cg, now);
      const ck = `${disk}|${r.cg}`;
      let c = byCg.get(ck);
      if (!c) {
        const m = path ? this.meta(path, now) : undefined;
        c = path && m ? this.cgConsumer(path, m, { rIops: 0, wIops: 0, rBps: 0, wBps: 0 }) : { kind: "cgroup", id: `cgid:${r.cg}`, label: `cgroup ${r.cg}`, rIops: 0, wIops: 0, rBps: 0, wBps: 0 };
        byCg.set(ck, c);
        add(disk, c);
      }
      c.rIops += r.r / dt; c.wIops += r.w / dt; c.rBps += r.rb / dt; c.wBps += r.wb / dt;
      if (r.pid > 0) {
        const pk = `${disk}|${r.pid}`;
        let p = byPid.get(pk);
        if (!p) {
          p = { kind: "process", id: `pid:${r.pid}`, label: r.comm || String(r.pid), pid: r.pid, comm: r.comm, ...(path ? { cgroup: path } : {}), rIops: 0, wIops: 0, rBps: 0, wBps: 0 };
          byPid.set(pk, p);
          add(disk, p);
        }
        p.rIops += r.r / dt; p.wIops += r.w / dt; p.rBps += r.rb / dt; p.wBps += r.wb / dt;
      }
    }
  }

  private procConsumers(now: number, own: Map<string, Map<string, Rates>> | undefined, rates: Map<string, DiskRates>, diskOf: (dev: string) => string | undefined, add: (d: string, c: Consumer) => void): void {
    let rows: { row: ProcRow; shares: Map<string, number> }[] = [];
    const globalShares = (): Map<string, number> => {
      let tot = 0;
      for (const r of rates.values()) tot += r.rBps + r.wBps;
      return new Map([...rates].map(([n, r]) => [n, tot > 0 ? (r.rBps + r.wBps) / tot : 1 / rates.size]));
    };
    if (own && own.size) {
      // the busiest cgroups by their own IO: the processes they hold directly
      const ranked = [...own].map(([cg, devs]) => [cg, [...devs.values()].reduce((a, r) => a + sumRates(r), 0)] as const).sort((a, b) => b[1] - a[1]).slice(0, TOP_CGROUPS_FOR_PROCS);
      for (const [cg] of ranked) {
        const devs = own.get(cg) as Map<string, Rates>;
        const shares = new Map<string, number>();
        let tot = 0;
        for (const [dev, r] of devs) {
          const disk = diskOf(dev);
          if (!disk) continue;
          const b = r.rBps + r.wBps || sumRates(r);
          shares.set(disk, (shares.get(disk) ?? 0) + b);
          tot += b;
        }
        if (!tot) continue;
        for (const [k, v] of shares) shares.set(k, v / tot);
        for (const row of this.procs.sample(this.cg.pids(cg), false)) rows.push({ row: { ...row, cgroup: cg }, shares });
      }
    } else if (this.cgOk === false) {
      // no cgroup tree: every process, at most every FULL_SCAN_MS, with its cgroup when it moved bytes
      if (now - this.lastProcRows.at >= FULL_SCAN_MS) this.lastProcRows = { rows: this.procs.sample(this.procs.listPids(), true), at: now };
      const gs = globalShares();
      rows = this.lastProcRows.rows.map((row) => ({ row, shares: gs }));
    }
    for (const { row, shares } of rows) {
      const m = row.cgroup ? this.meta(row.cgroup, now) : undefined;
      for (const [disk, share] of shares) {
        const r = rates.get(disk);
        if (!r || share <= 0) continue;
        const io = r.avgIoBytes > 0 ? r.avgIoBytes : 4096;
        const rb = row.rBps * share;
        const wb = row.wBps * share;
        add(disk, {
          kind: "process", id: row.id, label: row.comm, pid: row.pid, comm: row.comm,
          ...(row.cgroup ? { cgroup: row.cgroup } : {}), ...(m?.pod ? { pod: m.pod } : {}), ...(m?.unit ? { unit: m.unit } : {}),
          rIops: rb / io, wIops: wb / io, rBps: rb, wBps: wb,
        });
      }
    }
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundConsumer(c: Consumer): Consumer {
  c.rIops = round(c.rIops, 1);
  c.wIops = round(c.wIops, 1);
  c.rBps = Math.round(c.rBps);
  c.wBps = Math.round(c.wBps);
  return c;
}

/** A snapshot cut to one disk and the top `top` consumers of each disk (IO consumers first, then at most 5 path consumers). */
export function trim(s: Snapshot, disk: string | undefined, top: number): Snapshot {
  const t = Math.max(0, Math.min(100, Math.floor(top)));
  return {
    ...s,
    disks: s.disks.filter((d) => disk === undefined || d.name === disk).map((d) => {
      const io = d.consumers.filter((c) => c.kind !== "path");
      const paths = d.consumers.filter((c) => c.kind === "path");
      const pathSlots = Math.min(5, paths.length, t);
      return { ...d, consumers: [...io.slice(0, t - pathSlots), ...paths.slice(0, pathSlots)] };
    }),
  };
}
