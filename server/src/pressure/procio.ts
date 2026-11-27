import fs from "node:fs";

export interface ProcRow {
  id: string;
  pid: number;
  comm: string;
  /** bytes per second read from and written to storage (read_bytes and write_bytes of /proc/<pid>/io) */
  rBps: number;
  wBps: number;
  cgroup?: string;
}

/** /proc/<pid>/io: the storage bytes of a process. Other fields are ignored. */
export function parseProcIo(text: string): { read: number; write: number } | undefined {
  const r = /^read_bytes:\s*(\d+)/m.exec(text);
  const w = /^write_bytes:\s*(\d+)/m.exec(text);
  return r && w ? { read: Number(r[1]), write: Number(w[1]) } : undefined;
}

/** The start time (field 22 of /proc/<pid>/stat, in clock ticks since boot): it tells a process from a later one with the same pid. */
export function parseStartTime(text: string): string | undefined {
  const i = text.lastIndexOf(")");
  if (i < 0) return undefined;
  const f = text.slice(i + 2).split(" ");
  return f[19];
}

/** The cgroup v2 path in /proc/<pid>/cgroup (`0::/path`). */
export function parseProcCgroup(text: string): string | undefined {
  const m = /^0::(.*)$/m.exec(text);
  return m ? (m[1] as string) : undefined;
}

interface Seen {
  read: number;
  write: number;
  at: number;
  seenAt: number;
  comm: string;
}

export interface ProcSamplerOptions {
  /** where the process folders are (default /proc; with hostPID that is the host's) */
  root: string;
  now?: () => number;
  /** a process that was not asked for during this long is forgotten (default 60 s) */
  forgetMs?: number;
  /** most processes tracked (default 4096) */
  max?: number;
}

/** Per-process storage bytes from /proc/<pid>/io: a rate needs two reads, so the first read of a process gives no row. */
export class ProcIoSampler {
  private seen = new Map<string, Seen>();
  private blockedUntil = 0;
  /** set when /proc/<pid>/io was refused for every process of a sample (no CAP_SYS_PTRACE, or a process list that is not the host's): said once */
  denied = false;
  private readonly o: Required<ProcSamplerOptions>;

  constructor(opts: ProcSamplerOptions) {
    this.o = { now: Date.now, forgetMs: 60_000, max: 4096, ...opts };
  }

  get tracked(): number {
    return this.seen.size;
  }

  /** All process ids under the root, at most `limit`. */
  listPids(limit = 8192): number[] {
    try {
      const out: number[] = [];
      for (const n of fs.readdirSync(this.o.root)) {
        if (!/^\d+$/.test(n)) continue;
        out.push(Number(n));
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Reads the given processes; returns the rows of those that moved bytes since they were last read here. */
  sample(pids: Iterable<number>, wantCgroup = false): ProcRow[] {
    const now = this.o.now();
    const rows: ProcRow[] = [];
    if (now < this.blockedUntil) return rows;
    let tried = 0;
    let refused = 0;
    let readable = 0;
    for (const pid of pids) {
      const dir = `${this.o.root}/${pid}`;
      let io: { read: number; write: number } | undefined;
      tried++;
      try {
        io = parseProcIo(fs.readFileSync(dir + "/io", "utf8"));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") refused++;
        // (a process that is gone, or a folder that is not a process: not counted as refused)
        if (refused >= 8 && readable === 0) break;
        continue;
      }
      readable++;
      if (!io) continue;
      let start: string | undefined;
      try {
        start = parseStartTime(fs.readFileSync(dir + "/stat", "utf8"));
      } catch {
        continue;
      }
      if (!start) continue;
      const id = `pid:${pid}:${start}`;
      const prev = this.seen.get(id);
      if (!prev && this.seen.size >= this.o.max) continue;
      const entry: Seen = { read: io.read, write: io.write, at: now, seenAt: now, comm: prev?.comm ?? "" };
      this.seen.set(id, entry);
      if (!prev) continue;
      const dt = Math.max(0.001, (now - prev.at) / 1000);
      const r = io.read >= prev.read ? (io.read - prev.read) / dt : 0;
      const w = io.write >= prev.write ? (io.write - prev.write) / dt : 0;
      if (r === 0 && w === 0) continue;
      if (!entry.comm) {
        try {
          entry.comm = fs.readFileSync(dir + "/comm", "utf8").trim().slice(0, 32);
        } catch {
          entry.comm = String(pid);
        }
      }
      let cgroup: string | undefined;
      if (wantCgroup) {
        try {
          cgroup = parseProcCgroup(fs.readFileSync(dir + "/cgroup", "utf8"));
        } catch {
          /* gone */
        }
      }
      rows.push({ id, pid, comm: entry.comm, rBps: r, wBps: w, ...(cgroup ? { cgroup } : {}) });
    }
    for (const [id, s] of this.seen) if (now - s.seenAt > this.o.forgetMs) this.seen.delete(id);
    // every process refused: it will be refused again, so it is not tried for a minute
    if (tried >= 8 && readable === 0 && refused >= 8) {
      this.blockedUntil = now + 60_000;
      this.denied = true;
    } else if (readable > 0) this.denied = false;
    return rows;
  }
}
