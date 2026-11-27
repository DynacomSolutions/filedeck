import fs from "node:fs";
import { parsePsi } from "./psi.ts";
import type { Psi, Rates } from "./types.ts";

/** The counters of one device in a cgroup's io.stat. */
export interface IoCounters {
  rios: number;
  wios: number;
  rbytes: number;
  wbytes: number;
}

/**
 * io.stat: one line per device, `8:16 rbytes=1 wbytes=2 rios=3 wios=4 dbytes=0 dios=0`. Written as one scan over the characters: it runs for
 * every cgroup that is read, every sample.
 */
export function parseIoStat(text: string): Map<string, IoCounters> {
  const out = new Map<string, IoCounters>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    let eol = text.indexOf("\n", i);
    if (eol < 0) eol = n;
    const sp = text.indexOf(" ", i);
    if (sp > i && sp < eol) {
      const colon = text.indexOf(":", i);
      if (colon > i && colon < sp) {
        const c: IoCounters = { rios: 0, wios: 0, rbytes: 0, wbytes: 0 };
        let j = sp + 1;
        while (j < eol) {
          const eq = text.indexOf("=", j);
          if (eq < 0 || eq >= eol) break;
          let end = text.indexOf(" ", eq);
          if (end < 0 || end > eol) end = eol;
          const k0 = text.charCodeAt(j);
          // keys that count: rbytes, wbytes, rios, wios (not dbytes, dios, which no one reads)
          if (k0 === 114 /* r */ || k0 === 119 /* w */) {
            let v = 0;
            for (let q = eq + 1; q < end; q++) v = v * 10 + (text.charCodeAt(q) - 48);
            const len = eq - j;
            if (k0 === 114) {
              if (len === 6) c.rbytes = v;
              else if (len === 4) c.rios = v;
            } else if (len === 6) c.wbytes = v;
            else if (len === 4) c.wios = v;
          }
          j = end + 1;
        }
        out.set(text.slice(i, sp), c);
      }
    }
    i = eol + 1;
  }
  return out;
}

type Delta = Map<string, IoCounters>;

/** Reads a small cgroup or proc file. undefined when it cannot be read. */
export function readSmall(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "latin1");
  } catch {
    return undefined;
  }
}

const ZERO = (): IoCounters => ({ rios: 0, wios: 0, rbytes: 0, wbytes: 0 });
const FIELDS = ["rios", "wios", "rbytes", "wbytes"] as const;
const isZero = (c: IoCounters) => c.rios === 0 && c.wios === 0 && c.rbytes === 0 && c.wbytes === 0;

function diff(cur: Map<string, IoCounters>, prev: Map<string, IoCounters>): Delta {
  const out: Delta = new Map();
  for (const [dev, c] of cur) {
    const p = prev.get(dev) ?? ZERO();
    const d = ZERO();
    // a counter that went down (a device that came back) counts as zero for that interval
    for (const k of FIELDS) d[k] = c[k] >= p[k] ? c[k] - p[k] : 0;
    if (!isZero(d)) out.set(dev, d);
  }
  return out;
}

interface CgNode {
  path: string; // relative to the root, "/" for the root itself
  parent?: CgNode;
  kids?: CgNode[];
  kidsAt: number;
  /** when the folder was last read in full */
  fullAt: number;
  last?: Map<string, IoCounters>;
  lastAt: number;
  hotTick: number;
  /** the node has no readable io.stat (the io controller is off for it): looked at again every 20th sample */
  noIo: boolean;
  /** the IO its children did not explain in the last sample (a cgroup with processes of its own has some all the time) */
  prevRes: number;
  /** where the search for the child that explains the unexplained IO goes on */
  scanPos: number;
  /** no search for unexplained IO before this sample */
  quietUntil: number;
  dead: boolean;
}

export interface CgroupSampleOptions {
  /** the cgroup v2 mount, for example /sys/fs/cgroup */
  root: string;
  /** clock in ms (tests) */
  now?: () => number;
  /** a folder's child list is read again after this long, while the folder is active (default 10 s) */
  relistMs?: number;
  /** a child without recent activity is read on every Nth sample (default 60); IO that its parent's other children do not explain makes it read at once */
  coldEvery?: number;
  /** samples a cgroup stays "hot" (read every time) after its last IO (default 5) */
  hotTicks?: number;
  /** most cgroups kept (default 20000); beyond it, new ones are not followed */
  maxNodes?: number;
  log?: (s: string) => void;
}

/** What one sample says about the cgroups: the IO of each cgroup's own processes (not its children's) per device, per second. */
export interface CgroupSample {
  at: number;
  /** cgroup path -> device ("major:minor") -> rates. Only cgroups with IO in the interval. */
  own: Map<string, Map<string, Rates>>;
  /** cgroups read in this sample (the cost) */
  reads: number;
  /** false for the first sample: it only sets the baseline */
  baseline: boolean;
}

/**
 * Follows the io.stat of a cgroup v2 tree cheaply. io.stat of a cgroup counts its children too, so a cgroup whose counters did not move has
 * idle children and they are not read. For an active cgroup the children are read (the ones with recent IO every time, the rest on every Nth
 * sample); IO that its children do not explain is read from the others at once. A cgroup's own IO is its counters minus its children's.
 * The numbers are approximate when children come and go inside one interval: the IO of a cgroup that vanished is not attributed to its parent.
 */
export class CgroupIoSampler {
  private readonly o: Required<Omit<CgroupSampleOptions, "log">> & { log?: (s: string) => void };
  private rootNode: CgNode;
  private tick = 0;
  private count = 0;
  private warned = false;
  private reads = 0;
  private rescueBudget = 0;
  /** reads by cause in the latest sample: hot, cold (scheduled), rescue (unexplained IO), fresh (new or first read) */
  causes = { hot: 0, cold: 0, rescue: 0, fresh: 0 };
  private now_: number = 0;
  private out = new Map<string, Map<string, Rates>>();

  constructor(opts: CgroupSampleOptions) {
    this.o = { now: opts.now ?? Date.now, relistMs: opts.relistMs ?? 10_000, coldEvery: opts.coldEvery ?? 60, hotTicks: opts.hotTicks ?? 5, maxNodes: opts.maxNodes ?? 20_000, log: opts.log, root: opts.root };
    this.rootNode = this.makeNode("/", undefined);
  }

  /** Number of cgroups followed (for metrics and tests). */
  get nodes(): number {
    return this.count;
  }

  private makeNode(p: string, parent: CgNode | undefined): CgNode {
    this.count++;
    return { path: p, parent, kidsAt: 0, fullAt: 0, lastAt: 0, hotTick: -1e9, noIo: false, prevRes: 0, scanPos: 0, quietUntil: 0, dead: false };
  }

  private dir(n: CgNode): string {
    return n.path === "/" ? this.o.root : this.o.root + n.path;
  }

  private readIo(n: CgNode): Map<string, IoCounters> | "gone" | undefined {
    this.reads++;
    const text = readSmall(this.dir(n) + "/io.stat");
    if (text !== undefined) return parseIoStat(text);
    return fs.existsSync(this.dir(n)) ? undefined : "gone";
  }

  private list(n: CgNode, now: number, force = false): CgNode[] {
    if (n.kids && !force && now - n.kidsAt < this.o.relistMs) return n.kids;
    // The link count of a cgroup folder is 2 plus its sub-folders: one cheap call says whether the list can have changed (a folder is read in full every minute)
    if (n.kids && now - n.fullAt < 60_000) {
      try {
        if (fs.statSync(this.dir(n)).nlink - 2 === n.kids.length) {
          n.kidsAt = now;
          return n.kids;
        }
      } catch {
        /* read it in full */
      }
    }
    n.fullAt = now;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir(n), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      /* unreadable: no children */
    }
    const old = new Map((n.kids ?? []).map((k) => [k.path, k]));
    const kids: CgNode[] = [];
    for (const name of names.sort()) {
      const p = n.path === "/" ? "/" + name : n.path + "/" + name;
      let k = old.get(p);
      if (!k) {
        if (this.count >= this.o.maxNodes) {
          if (!this.warned) {
            this.warned = true;
            this.o.log?.(`disk pressure: more than ${this.o.maxNodes} cgroups, the rest are not followed`);
          }
          continue;
        }
        k = this.makeNode(p, n);
      }
      kids.push(k);
    }
    for (const [p, k] of old) if (!kids.some((x) => x.path === p)) this.drop(k);
    n.kids = kids;
    n.kidsAt = now;
    return kids;
  }

  private drop(n: CgNode): void {
    if (n.dead) return;
    n.dead = true;
    this.count--;
    for (const k of n.kids ?? []) this.drop(k);
  }

  /** Reads one cgroup and what is below it that needs reading. Returns the cgroup's own counters delta (absolute counts) or undefined without one. */
  private visit(n: CgNode, now: number, fresh = false): { delta: Delta; vanished: boolean } | "gone" | undefined {
    const cur = this.readIo(n);
    if (cur === "gone") return "gone";
    if (!cur) {
      n.noIo = true;
      // without io.stat here the children may still have one (the controller is on below): follow them without a delta of this one
      return undefined;
    }
    n.noIo = false;
    // a cgroup seen for the first time below an active one: its counters since its creation are its delta
    const prev = n.last ?? (fresh ? new Map<string, IoCounters>() : undefined);
    const prevAt = n.last ? n.lastAt : now - this.o.relistMs;
    n.last = cur;
    n.lastAt = now;
    if (!prev) {
      // a first read: nothing to compare. The children get their baseline now (their counters are read, not used).
      for (const k of this.list(n, now)) if (!k.dead) this.visit(k, now);
      return undefined;
    }
    const delta = diff(cur, prev);
    if (delta.size === 0) {
      n.prevRes = 0;
      return { delta, vanished: false };
    }
    n.hotTick = this.tick;
    const dt = Math.max(0.001, (now - prevAt) / 1000);
    const kidSum: Delta = new Map();
    let vanished = false;
    const readKid = (k: CgNode): void => {
      const r = this.visit(k, now, true);
      if (r === "gone") {
        vanished = true;
        k.dead = true;
        return;
      }
      if (r) for (const [dev, c] of r.delta) {
        const t = kidSum.get(dev) ?? ZERO();
        for (const f of FIELDS) t[f] += c[f];
        kidSum.set(dev, t);
      }
      if (r?.vanished) vanished = true;
    };
    const kids = this.list(n, now);
    let i = 0;
    const unread: CgNode[] = [];
    for (const k of kids) {
      const hot = this.tick - k.hotTick <= this.o.hotTicks;
      if (k.noIo && (i + this.tick) % 20 !== 0) continue;
      if (!k.last) { this.causes.fresh++; readKid(k); }
      else if (hot) { this.causes.hot++; readKid(k); }
      else if ((i + this.tick) % this.o.coldEvery === 0) { this.causes.cold++; readKid(k); }
      else unread.push(k);
      i++;
    }
    const residual = (): Delta => {
      const res: Delta = new Map();
      for (const [dev, d] of delta) {
        const r = { ...d };
        const c = kidSum.get(dev);
        if (c) for (const f of FIELDS) r[f] -= c[f];
        for (const f of FIELDS) if (r[f] < 0) r[f] = 0;
        res.set(dev, r);
      }
      return res;
    };
    const hasResidual = (r: Delta) => [...r.values()].some((c) => c.rios + c.wios > 0 || c.rbytes + c.wbytes > 0);
    let res = residual();
    const total = (r: Delta) => [...r.values()].reduce((a, c) => a + c.rios + c.wios + c.rbytes / 4096 + c.wbytes / 4096, 0);
    const resNow = total(res);
    // a cgroup with processes of its own has IO that no child explains, tick after tick: only a jump looks for the cause
    const jumped = () => total(res) > n.prevRes * 1.5 + 4;
    const looking = jumped() && hasResidual(res) && this.tick >= n.quietUntil;
    let searched = false;
    if (looking && unread.length && this.rescueBudget > 0) {
      // IO that no read child explains: the other children are read, from where the last search stopped, until it is explained.
      // The search is cut at 64 reads for one cgroup and at the sample's budget, and goes on in the next sample.
      searched = true;
      const start = n.scanPos % unread.length;
      let scanned = 0;
      for (; scanned < unread.length && scanned < 64 && this.rescueBudget > 0; scanned++) {
        this.rescueBudget--;
        this.causes.rescue++;
        readKid(unread[(start + scanned) % unread.length] as CgNode);
        res = residual();
        if (!jumped()) break;
      }
      n.scanPos = start + scanned;
      // done: it was explained, or every child was looked at once (the rest is the cgroup's own IO, or a child that is not in the list yet)
      if (!jumped() || scanned >= unread.length) n.prevRes = total(res);
      if (scanned >= unread.length && jumped()) n.quietUntil = this.tick + 15;
    }
    if (looking && (!unread.length || n.scanPos >= unread.length) && jumped() && hasResidual(res) && now - n.kidsAt >= this.o.relistMs / 2) {
      // not explained by a child that is known: a new child, since the list is old. A cgroup with no new child rests for 30 samples.
      searched = true;
      const known = new Set(kids);
      for (const k of this.list(n, now, true)) {
        if (known.has(k) || k.dead) continue;
        readKid(k);
      }
      res = residual();
      n.prevRes = total(res);
      n.quietUntil = this.tick + 30;
    }
    if (!searched) n.prevRes = Math.max(resNow, n.prevRes * 0.9);
    // attribute: the children's own numbers are produced by their own visit; this cgroup keeps the residual
    if (!vanished) {
      const rates = new Map<string, Rates>();
      for (const [dev, r] of res) {
        if (r.rios + r.wios + r.rbytes + r.wbytes === 0) continue;
        rates.set(dev, { rIops: r.rios / dt, wIops: r.wios / dt, rBps: r.rbytes / dt, wBps: r.wbytes / dt });
      }
      if (rates.size) this.out.set(n.path, rates);
    }
    return { delta, vanished };
  }

  sample(): CgroupSample {
    const now = this.o.now();
    this.tick++;
    this.reads = 0;
    this.rescueBudget = 160;
    this.causes = { hot: 0, cold: 0, rescue: 0, fresh: 0 };
    this.out = new Map();
    this.now_ = now;
    const baseline = !this.rootNode.last;
    this.visit(this.rootNode, now);
    return { at: now, own: this.out, reads: this.reads, baseline };
  }

  /** io.pressure of one cgroup, or undefined. */
  pressure(cg: string): Psi | undefined {
    try {
      return parsePsi(fs.readFileSync((cg === "/" ? this.o.root : this.o.root + cg) + "/io.pressure", "utf8"));
    } catch {
      return undefined;
    }
  }

  /** The cgroup ids (inode numbers) of every folder below the root, for the eBPF rows. A full walk: call it rarely. */
  walkIds(): Map<number, string> {
    const ids = new Map<number, string>();
    const rec = (rel: string, depth: number): void => {
      if (depth > 24 || ids.size >= this.o.maxNodes) return;
      const dir = rel === "/" ? this.o.root : this.o.root + rel;
      try {
        ids.set(fs.statSync(dir).ino, rel);
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) rec(rel === "/" ? "/" + e.name : rel + "/" + e.name, depth + 1);
      } catch {
        /* gone or unreadable */
      }
    };
    rec("/", 0);
    return ids;
  }

  /** ids of the processes of one cgroup (cgroup.procs), at most `max`. */
  pids(cg: string, max = 200): number[] {
    try {
      const text = fs.readFileSync((cg === "/" ? this.o.root : this.o.root + cg) + "/cgroup.procs", "utf8");
      const out: number[] = [];
      for (const l of text.split("\n")) {
        const n = Number(l);
        if (n > 0) out.push(n);
        if (out.length >= max) break;
      }
      return out;
    } catch {
      return [];
    }
  }
}

