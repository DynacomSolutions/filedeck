import fs from "node:fs";
import { CgroupIoSampler } from "./cgroup.ts";
import { diskRates, parentDisk, parseDiskstats, pickDisks, type DiskCounters, type DiskRates } from "./diskstats.ts";
import { helperSource, IotraceSampler, type IotraceRow, type IotraceSample } from "../iotrace.ts";
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
  /** time between samples while a live view is open (ms); also the wait of a one-shot read that has no baseline yet */
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
  /** a helper that does not answer a read within this long is stopped (default 5000) */
  iotraceTimeoutMs?: number;
  /** replaces the sampler (tests) */
  sampler?: IotraceSampler;
  bus?: EventSource;
  diskstatsFile?: string;
  psiFile?: string;
  sysBlock?: string;
  mountinfoFile?: string;
  now?: () => number;
  log?: (s: string) => void;
  /** most consumers kept per disk (default 100) */
  keep?: number;
}

const PATH_KEEP = 10;
const TOP_CGROUPS_FOR_PROCS = 20;
const TOP_CGROUPS_FOR_PSI = 10;
const FULL_SCAN_MS = 5000;
const MOUNTS_MS = 30_000;
/** a baseline older than this is dropped: the rates would be the average of a long idle time */
const MAX_GAP_MS = 120_000;
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

/** A one-shot wait. It ends early when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms); // (not unref'd: a request waits on it, and it lasts one interval at most)
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The live disk pressure of this machine (docs/disk-pressure.md). It has no timer of its own and never samples by itself. A sample is taken when somebody asks:
 *  - `read()`: one snapshot now (an API request, a `/metrics` scrape or a pressure event is the demand). The rates cover the time since the previous sample.
 *    When there is no previous sample (or it is older than two minutes), `read()` takes a baseline and waits one interval with a one-shot timer.
 *  - `subscribe()`: a live view. The `IotraceSampler` re-arms one one-shot deadline after each sample while a subscriber exists.
 * The block IO attribution comes from `IotraceSampler`: the eBPF helper, or the proc and cgroup collector below (`procRead`) when the helper is not usable.
 */
export class PressureCollector {
  private readonly o: Required<Omit<CollectorOptions, "bus" | "labels" | "iotrace" | "iotraceTimeoutMs" | "sampler" | "log">> & Pick<CollectorOptions, "bus" | "labels" | "iotrace" | "log">;
  private readonly cg: CgroupIoSampler;
  private readonly procs: ProcIoSampler;
  private readonly pods: PodIndex;
  private readonly rules: LabelRules;
  private readonly paths: PathCounter;
  readonly sampler: IotraceSampler;
  private readonly listeners = new Set<(s: Snapshot) => void>();
  private unsub?: () => void;
  private unlisten?: () => void;
  private prev?: { at: number; t: number; disks: Map<string, DiskCounters> };
  private snap?: Snapshot;
  private inflight?: Promise<Snapshot | undefined>;
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
  private inos = new Map<string, number>();
  private idsWalkAt = 0;
  private cgOk?: boolean;
  private procAt = 0;
  private lastOwn?: Map<string, Map<string, Rates>>;
  private lastProcRows: { rows: ProcRow[]; at: number } = { rows: [], at: 0 };
  private lastSource: PressureSource = "proc";
  private psiCache = new Map<string, { at: number; v: number | undefined }>();
  private formatted = new WeakMap<Snapshot, Map<string, string>>();

  constructor(opts: CollectorOptions) {
    this.o = {
      now: Date.now, keep: 100,
      diskstatsFile: "/proc/diskstats", psiFile: "/proc/pressure/io", sysBlock: "/sys/block", mountinfoFile: "",
      ...opts,
    };
    const log = opts.log;
    this.cg = new CgroupIoSampler({ root: opts.cgroupRoot, now: this.o.now, log });
    this.procs = new ProcIoSampler({ root: opts.procRoot, now: this.o.now });
    this.pods = new PodIndex({ hostRoot: opts.hostRoot, now: this.o.now });
    this.rules = new LabelRules(opts.labels, log);
    this.paths = new PathCounter(Math.max(1, Math.floor(opts.pathDepth) || 3));
    this.sampler = opts.sampler ?? new IotraceSampler(opts.iotrace ? helperSource(opts.iotrace, opts.iotraceTimeoutMs) : undefined, () => this.procRead(), opts.intervalMs, opts.log);
  }

  // ---- demand ----

  /** One snapshot now, for an API request or a scrape. Reads that overlap share one result. Undefined when no sample could be made. */
  read(signal?: AbortSignal): Promise<Snapshot | undefined> {
    return (this.inflight ??= this.doRead(signal).finally(() => (this.inflight = undefined)));
  }

  private async doRead(signal?: AbortSignal): Promise<Snapshot | undefined> {
    if (this.snap && this.o.now() - this.snap.at < 250) return this.snap;
    const first = await this.sample();
    if (first) return first;
    // no baseline yet (the first read after a long rest): it was taken now, and the answer needs one interval after it
    await wait(this.o.intervalMs, signal);
    if (signal?.aborted) return this.snap;
    return (await this.sample()) ?? this.snap;
  }

  /** One reading of the attribution and the disk counters now, without the wait for a baseline. Undefined when it was a baseline. */
  async sample(): Promise<Snapshot | undefined> {
    return this.consume(await this.sampler.read());
  }

  /** A live view: `fn` gets each new snapshot. The returned function leaves. While nobody is subscribed nothing runs. */
  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.startLive();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stopLive();
    };
  }

  private startLive(): void {
    this.paths.take(); // events before the view opened are not counted
    if (this.o.bus) {
      this.unlisten = this.o.bus.listen((e) => {
        if (e.kind === "overflow" || e.kind === "reset" || e.kind === "ready" || e.kind === "pressure" || !e.path) return;
        const t = process.hrtime.bigint();
        this.paths.add(e.path);
        this.listenNs += process.hrtime.bigint() - t;
      });
    }
    this.unsub = this.sampler.subscribe((s) => void this.consume(s));
  }

  private stopLive(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    this.paths.take();
  }

  get live(): boolean {
    return this.listeners.size > 0;
  }

  /** Stops everything (shutdown). */
  close(): void {
    this.listeners.clear();
    this.stopLive();
    this.sampler.close();
  }

  // ---- reading ----

  get latest(): Snapshot | undefined {
    return this.snap;
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

  /**
   * The proc and cgroup collector, the fallback of `IotraceSampler` when the eBPF helper cannot run. It gives the change since its previous call as
   * rows in the helper's form: one row per cgroup and device (`pid` 0). The IO of single processes comes later, in `procConsumers`, from `/proc/<pid>/io`.
   */
  private async procRead(): Promise<{ t: number; rows: IotraceRow[] }> {
    const c0 = process.cpuUsage();
    const now = this.o.now();
    const dt = this.procAt ? (now - this.procAt) / 1000 : 0;
    this.procAt = now;
    const rows: IotraceRow[] = [];
    this.lastOwn = undefined;
    if (this.cgOk !== false || this.samples % 20 === 0) {
      // (no usable cgroup tree: it is tried again now and then)
      const s = this.cg.sample();
      this.cgOk = s.reads > 0 && (s.own.size > 0 || !s.baseline || this.cg.nodes > 1);
      if (!s.baseline) {
        this.lastOwn = s.own;
        for (const [cg, devs] of s.own) {
          const id = this.inoOf(cg);
          if (id === undefined) continue;
          for (const [dev, r] of devs) rows.push({ dev, cg: id, pid: 0, comm: "", r: r.rIops * dt, w: r.wIops * dt, rb: r.rBps * dt, wb: r.wBps * dt });
        }
      }
    }
    const c1 = process.cpuUsage(c0);
    this.cpuMicros += c1.user + c1.system;
    return { t: now, rows };
  }

  /** The cgroup id (inode number) of a cgroup path, for the rows of the fallback. */
  private inoOf(cg: string): number | undefined {
    let id = this.inos.get(cg);
    if (id === undefined) {
      try {
        id = fs.statSync(cg === "/" ? this.o.cgroupRoot : this.o.cgroupRoot + cg).ino;
      } catch {
        return undefined;
      }
      this.inos.set(cg, id);
      this.ids.set(id, cg);
      if (this.inos.size > 50_000) this.inos.clear();
    }
    return id;
  }

  /** One reading of the block IO attribution becomes a snapshot. The rates cover the time since the previous reading. A baseline gives undefined. */
  private consume(sample: IotraceSample): Snapshot | undefined {
    if (this.prev && sample.t <= this.prev.t) return this.snap; // this reading was used already (a second reader of the same result)
    const c0 = process.cpuUsage();
    try {
      return this.build(sample);
    } catch (e) {
      this.o.log?.(`disk pressure: a sample failed (${(e as Error).message})`);
      return undefined;
    } finally {
      const c1 = process.cpuUsage(c0);
      this.cpuMicros += c1.user + c1.system;
    }
  }

  private build(sample: IotraceSample): Snapshot | undefined {
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
    this.prev = { at: now, t: sample.t, disks: cur };
    this.samples++;
    const pathCounts = this.paths.take();
    if (!prev || now - prev.at > MAX_GAP_MS) return undefined; // a baseline: there is nothing to compare with yet
    const dtMs = now - prev.at;
    if (dtMs < 50) return undefined;

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

    const source: PressureSource = sample.source;
    this.traceConsumers({ rows: sample.rows, ms: Math.max(1, sample.t - prev.t) }, now, diskOf, add);
    if (source === "proc") this.procConsumers(now, this.lastOwn, rates, diskOf, add);
    this.lastSource = source;

    // path consumers: change events per top folder (only while a live view is open)
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
    const snap: Snapshot = { type: "snapshot", node: this.o.node, at: now, intervalMs: Math.round(dtMs), source, psi, disks: out };
    this.snap = snap;
    this.sweepMetas(now);
    for (const fn of [...this.listeners]) {
      try {
        fn(snap);
      } catch {
        /* a listener's fault is its own */
      }
    }
    return snap;
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

  private traceConsumers(t: { rows: IotraceRow[]; ms: number }, now: number, diskOf: (dev: string) => string | undefined, add: (d: string, c: Consumer) => void): void {
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
