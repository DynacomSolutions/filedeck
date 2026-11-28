import { HF_SHARED, HF_TRUNCATED, HF_VANISHED, HF_ERROR, HT, type HolderRec } from "./holders-proto.ts";

/**
 * The table "who holds what", kept from the events of `filedeck-holders` (server/native/filedeck-holders.bpf.c). It holds no policy and does no I/O.
 *
 * What is held is a file identity: the kernel device of the superblock, the inode number, and the inode numbers of the folders above it (the chain).
 * A tree (a folder, named by its own device and inode number) is held when a held file is that folder or has it in its chain. The name of the folder
 * and the mount namespace do not matter, and a bind mount of a part of the tree matches too.
 *
 * Soundness. A process that holds something is always in the table, unless a gap is known: the events are sent before the kernel acts, the table
 * only ever gets more than the kernel has when an event for a release is missed (an extra holder, never a missing one), and what cannot be told is
 * marked: `gaps()` says which pids are to be read again (dirty), whether the table was never seeded, and whether a whole class of events may be lost.
 * A hold stays after a missed release until the process execs, exits or is read again. A mapping is never released by an event: the manager reads the
 * process again before it reports a mapping.
 */

export type HoldKind = "cwd" | "root" | "exe" | "fd" | "mmap";

/** One process's hold on one file. */
export interface Hold {
  /** how many descriptors */
  fd: number;
  mmap: boolean;
  cwd: boolean;
  root: boolean;
  exe: boolean;
}

export interface FileRec {
  key: string;
  dev: number;
  ino: number;
  /** the folders above, nearest first, up to the root of the superblock */
  chain: Float64Array;
  /** the chain is not complete: this file may be inside any folder of its device */
  truncated: boolean;
  holders: Map<number, Hold>;
}

/** What one process holds. `holds` shares its Hold objects with `FileRec.holders` while the state is in the table. */
export interface ProcState {
  comm: string;
  holds: Map<string, Hold>;
  cwd?: string;
  root?: string;
  exe?: string;
  maps: Set<string>;
  /** a gap is known: read this process again */
  dirty: boolean;
  /** reading it failed and was tried again this many times */
  failures: number;
  /** the time (ms) of the last read of this process by a snapshot */
  readAt: number;
}

const fileKey = (dev: number, ino: number) => `${dev}:${ino}`;
const emptyHold = (): Hold => ({ fd: 0, mmap: false, cwd: false, root: false, exe: false });
const holdIsEmpty = (h: Hold) => h.fd <= 0 && !h.mmap && !h.cwd && !h.root && !h.exe;

export interface Gaps {
  /** no start-up pass has finished */
  unseeded: boolean;
  /** events of unknown pids were lost: the table is read again from the start */
  global: boolean;
  /** the pids that are to be read again */
  dirtyPids: number[];
  /** the pids that could not be read (the table cannot vouch for them) */
  unreadable: number[];
  /** the table reached its size limit and stopped taking events */
  full: boolean;
}

export interface Match {
  pid: number;
  comm: string;
  kinds: Set<HoldKind>;
  /** the match is a guess: the chain of a held file is not complete */
  uncertain: boolean;
}

interface Window {
  /** the events of this pid since the snapshot began, in order: they are applied again on the snapshot's result */
  events: HolderRec[];
  /** the snapshot's own records */
  fresh: ProcState;
  overflow: boolean;
}

/** A change to a state (the table's own, or a snapshot's that is not yet in the table). */
interface Target {
  pid: number;
  st: ProcState;
  indexed: boolean;
}

const WINDOW_EVENTS = 200_000;

export class HoldersTable {
  readonly files = new Map<string, FileRec>();
  readonly procs = new Map<number, ProcState>();
  holdCount = 0;
  /** inode keys that moved to another folder since the last `settleMoves` */
  readonly moved = new Set<string>();
  seeded = false;
  globalDirty = false;
  full = false;
  readonly maxHolds: number;
  /** pids with a snapshot under way */
  readonly windows = new Map<number, Window>();
  /** pids seen since the last (re)start of a seed pass, so that the pass can drop the pids that it did not meet */
  #seedTouched: Set<number> | null = null;
  /** the pids whose snapshot ended during the seed pass */
  readonly #seedDone = new Set<number>();
  /** the number of the events applied */
  events = 0;

  constructor(opts: { maxHolds?: number } = {}) {
    this.maxHolds = opts.maxHolds ?? 5_000_000;
  }

  /** a new, empty table state for a process */
  static newState(comm = ""): ProcState {
    return { comm, holds: new Map(), maps: new Set(), dirty: false, failures: 0, readAt: 0 };
  }

  // ---- changes of one state ----

  #rec(rec: HolderRec): FileRec {
    const key = fileKey(rec.dev, rec.ino);
    let f = this.files.get(key);
    if (!f) {
      f = { key, dev: rec.dev, ino: rec.ino, chain: rec.chain, truncated: (rec.flags & HF_TRUNCATED) !== 0, holders: new Map() };
      this.files.set(key, f);
    } else if (rec.chain.length > 0 || rec.flags & HF_TRUNCATED) {
      // the newest sight of the file is the best: a folder may have moved since the first
      f.chain = rec.chain;
      f.truncated = (rec.flags & HF_TRUNCATED) !== 0;
    }
    return f;
  }

  #hold(t: Target, rec: HolderRec): Hold | undefined {
    const key = fileKey(rec.dev, rec.ino);
    let h = t.st.holds.get(key);
    if (h) {
      if (t.indexed && rec.chain.length) this.#rec(rec);
      return h;
    }
    if (t.indexed) {
      if (this.holdCount >= this.maxHolds) {
        this.full = true;
        return undefined;
      }
      const f = this.#rec(rec);
      h = emptyHold();
      f.holders.set(t.pid, h);
      this.holdCount++;
    } else {
      this.#rec(rec); // (the record is shared; it is swept when the state is not installed)
      h = emptyHold();
    }
    t.st.holds.set(key, h);
    return h;
  }

  /** removes the file records that only a state that was built apart (and is not installed) made */
  #sweep(st: ProcState): void {
    for (const key of st.holds.keys()) {
      const f = this.files.get(key);
      if (f && f.holders.size === 0) this.files.delete(key);
    }
  }

  #release(t: Target, key: string): void {
    const h = t.st.holds.get(key);
    if (!h || !holdIsEmpty(h)) return;
    t.st.holds.delete(key);
    if (!t.indexed) return;
    this.holdCount--;
    const f = this.files.get(key);
    if (f) {
      f.holders.delete(t.pid);
      if (f.holders.size === 0) this.files.delete(key);
    }
  }

  #setSlot(t: Target, slot: "cwd" | "root" | "exe", rec: HolderRec): void {
    const old = t.st[slot];
    const key = fileKey(rec.dev, rec.ino);
    if (old === key) {
      this.#hold(t, rec); // (the chain may be newer)
      return;
    }
    const h = this.#hold(t, rec);
    if (!h) return;
    h[slot] = true;
    t.st[slot] = key;
    if (old) {
      const oh = t.st.holds.get(old);
      if (oh) {
        oh[slot] = false;
        this.#release(t, old);
      }
    }
  }

  #dropMaps(t: Target): void {
    for (const key of t.st.maps) {
      const h = t.st.holds.get(key);
      if (h) {
        h.mmap = false;
        this.#release(t, key);
      }
    }
    t.st.maps.clear();
  }

  /** applies one event of the process to a state */
  #apply(t: Target, rec: HolderRec): void {
    switch (rec.type) {
      case HT.FD:
      case HT.SFD: {
        const h = this.#hold(t, rec);
        if (h) h.fd++;
        return;
      }
      case HT.CLOSE: {
        const key = fileKey(rec.dev, rec.ino);
        const h = t.st.holds.get(key);
        if (!h) return;
        if (h.fd > 0) h.fd--;
        this.#release(t, key);
        return;
      }
      case HT.CWD:
      case HT.SCWD:
        this.#setSlot(t, "cwd", rec);
        return;
      case HT.ROOT:
      case HT.SROOT:
        this.#setSlot(t, "root", rec);
        return;
      case HT.EXECBEG: {
        this.#dropMaps(t);
        const old = t.st.exe;
        if (old) {
          t.st.exe = undefined;
          const h = t.st.holds.get(old);
          if (h) {
            h.exe = false;
            this.#release(t, old);
          }
        }
        return;
      }
      case HT.EXE:
      case HT.SEXE:
        if (rec.comm) t.st.comm = rec.comm;
        this.#setSlot(t, "exe", rec);
        return;
      case HT.MMAP:
      case HT.SMMAP: {
        const h = this.#hold(t, rec);
        if (!h) return;
        h.mmap = true;
        t.st.maps.add(fileKey(rec.dev, rec.ino));
        return;
      }
    }
  }

  // ---- the process list ----

  #state(pid: number, comm: string): ProcState {
    let st = this.procs.get(pid);
    if (!st) {
      st = HoldersTable.newState(comm);
      this.procs.set(pid, st);
    }
    return st;
  }

  /** removes a process and every hold of it */
  dropPid(pid: number): void {
    const st = this.procs.get(pid);
    if (!st) return;
    this.#unindex(pid, st);
    this.procs.delete(pid);
  }

  #unindex(pid: number, st: ProcState): void {
    for (const key of st.holds.keys()) {
      const f = this.files.get(key);
      if (!f) continue;
      f.holders.delete(pid);
      if (f.holders.size === 0) this.files.delete(key);
    }
    this.holdCount -= st.holds.size;
  }

  /** puts a state that was built apart in the table, in place of the process's own */
  #install(pid: number, st: ProcState): void {
    const old = this.procs.get(pid);
    for (const [key, h] of st.holds) {
      const f = this.files.get(key);
      if (f) f.holders.set(pid, h);
      else st.holds.delete(key);
    }
    if (old) {
      for (const key of old.holds.keys()) {
        if (st.holds.has(key)) continue;
        const f = this.files.get(key);
        if (!f) continue;
        f.holders.delete(pid);
        if (f.holders.size === 0) this.files.delete(key);
      }
    }
    this.holdCount += st.holds.size - (old?.holds.size ?? 0);
    this.procs.set(pid, st);
  }

  // ---- events ----

  /** Applies one record. Records that say nothing to the table (statistics, hello) are for the manager. */
  apply(rec: HolderRec): void {
    this.events++;
    this.#seedTouched?.add(rec.pid);
    const win = this.windows.get(rec.pid);
    switch (rec.type) {
      case HT.SNAPBEG: {
        this.windows.set(rec.pid, { events: [], fresh: HoldersTable.newState(), overflow: false });
        return;
      }
      case HT.SNAPEND:
        this.#endSnapshot(rec);
        return;
      case HT.SEEDEND:
        this.#endSeed();
        return;
      case HT.FORK:
        this.#fork(rec);
        return;
      case HT.EXIT:
        this.windows.delete(rec.pid);
        this.dropPid(rec.pid);
        return;
      case HT.MOVED:
        this.moved.add(fileKey(rec.dev, rec.ino));
        return;
      case HT.DIRTY:
        if (rec.pid === 0) this.globalDirty = true;
        else this.markDirty(rec.pid);
        return;
      case HT.SFD:
      case HT.SCWD:
      case HT.SROOT:
      case HT.SEXE:
      case HT.SMMAP: {
        const w = this.windows.get(rec.pid);
        if (!w) return; // a snapshot record without its start: nothing to attach it to
        if (rec.comm) w.fresh.comm = rec.comm;
        // the chain of a file in a snapshot is as new as any: the file record is updated, and the state is built apart
        this.#apply({ pid: rec.pid, st: w.fresh, indexed: false }, rec);
        return;
      }
      case HT.FD:
      case HT.CLOSE:
      case HT.CWD:
      case HT.ROOT:
      case HT.EXECBEG:
      case HT.EXE:
      case HT.MMAP: {
        if (rec.type === HT.CLOSE && !this.procs.has(rec.pid)) {
          if (win && win.events.length < WINDOW_EVENTS) win.events.push(rec);
          return;
        }
        const st = this.#state(rec.pid, rec.comm);
        if (rec.comm && rec.type !== HT.CLOSE) st.comm = rec.comm;
        if (!this.full) this.#apply({ pid: rec.pid, st, indexed: true }, rec);
        if (win) {
          if (win.events.length < WINDOW_EVENTS) win.events.push(rec);
          else win.overflow = true;
        }
        return;
      }
    }
  }

  #fork(rec: HolderRec): void {
    const parent = this.procs.get(rec.pid);
    const child = rec.aux;
    this.windows.delete(child);
    this.dropPid(child); // (a pid that is used again whose exit was lost)
    this.#seedTouched?.add(child);
    const st = HoldersTable.newState(parent?.comm ?? rec.comm);
    this.procs.set(child, st);
    if (parent) {
      for (const [key, h] of parent.holds) {
        const f = this.files.get(key);
        if (!f) continue;
        const copy: Hold = { ...h };
        st.holds.set(key, copy);
        f.holders.set(child, copy);
        this.holdCount++;
      }
      st.cwd = parent.cwd;
      st.root = parent.root;
      st.exe = parent.exe;
      st.maps = new Set(parent.maps);
      if (parent.dirty) st.dirty = true;
    }
    // (a parent that is not in the table holds nothing that is tracked, unless the start-up pass has not read it yet)
    if (this.#seedTouched && !this.#seedDone.has(rec.pid)) st.dirty = true;
    if (rec.flags & HF_SHARED) st.dirty = true; // (it shares its file table or folders with the parent: later changes of either are not copied)
  }

  /** a read of the process did not end in time or failed: it stays dirty, and after several tries it counts as unreadable */
  noteFailure(pid: number): void {
    const w = this.windows.get(pid);
    if (w) this.#sweep(w.fresh);
    this.windows.delete(pid);
    const st = this.#state(pid, "");
    st.failures++;
    st.dirty = true;
  }

  markDirty(pid: number): void {
    if (pid === 0) {
      this.globalDirty = true;
      return;
    }
    const st = this.#state(pid, "");
    st.dirty = true;
  }

  #endSnapshot(rec: HolderRec): void {
    const win = this.windows.get(rec.pid);
    this.windows.delete(rec.pid);
    if (!win) return;
    if (rec.flags & HF_VANISHED) {
      this.#sweep(win.fresh);
      this.dropPid(rec.pid); // it ended: the process is gone
      return;
    }
    if (rec.flags & HF_ERROR || win.overflow) {
      this.#sweep(win.fresh);
      const s = this.#state(rec.pid, "");
      s.failures++;
      s.dirty = true;
      return;
    }
    // the state read from the kernel, then the events that came while it was read (they may be older or newer than what the read saw: applying them is safe)
    const fresh = win.fresh;
    const t: Target = { pid: rec.pid, st: fresh, indexed: false };
    for (const ev of win.events) this.#apply(t, ev);
    fresh.dirty = false;
    fresh.failures = 0;
    fresh.readAt = Date.now();
    if (!fresh.comm) fresh.comm = this.procs.get(rec.pid)?.comm ?? "";
    this.#install(rec.pid, fresh);
    this.#seedDone.add(rec.pid);
  }

  /** The start-up pass began: pids that it does not meet and that no event named are gone. */
  beginSeed(): void {
    this.#seedTouched = new Set();
    this.#seedDone.clear();
    this.seeded = false;
    this.globalDirty = false;
  }

  #endSeed(): void {
    const touched = this.#seedTouched;
    this.#seedTouched = null;
    this.#seedDone.clear();
    if (touched) for (const pid of [...this.procs.keys()]) if (!touched.has(pid)) this.dropPid(pid);
    this.seeded = true;
  }

  // ---- questions ----

  /**
   * An inode moved to another folder: every held file that has it in its chain (or is it) may now be in another tree. The pids that hold such files are
   * marked dirty. Returns them.
   */
  settleMoves(): number[] {
    if (this.moved.size === 0) return [];
    const inos = new Map<number, Set<number>>(); // dev -> inode numbers
    for (const key of this.moved) {
      const [dev, ino] = key.split(":").map(Number) as [number, number];
      let s = inos.get(dev);
      if (!s) inos.set(dev, (s = new Set()));
      s.add(ino);
    }
    this.moved.clear();
    const pids = new Set<number>();
    for (const f of this.files.values()) {
      const s = inos.get(f.dev);
      if (!s) continue;
      let hit = s.has(f.ino);
      if (!hit) for (let i = 0; i < f.chain.length && !hit; i++) hit = s.has(f.chain[i]!);
      if (hit) for (const pid of f.holders.keys()) pids.add(pid);
    }
    for (const pid of pids) this.markDirty(pid);
    return [...pids];
  }

  gaps(): Gaps {
    const dirtyPids: number[] = [];
    const unreadable: number[] = [];
    for (const [pid, st] of this.procs) {
      if (st.dirty) (st.failures >= 3 ? unreadable : dirtyPids).push(pid);
    }
    for (const pid of this.windows.keys()) if (!dirtyPids.includes(pid) && !unreadable.includes(pid)) dirtyPids.push(pid); // (a snapshot under way is not yet in the table)
    return { unseeded: !this.seeded, global: this.globalDirty, dirtyPids, unreadable, full: this.full };
  }

  /** The processes that hold a file inside any of the roots (a root is a folder or a file, named by its device and inode number). */
  find(roots: ReadonlyArray<{ dev: number; ino: number }>): Map<number, Match> {
    const out = new Map<number, Match>();
    if (roots.length === 0) return out;
    const byDev = new Map<number, Set<number>>();
    for (const r of roots) {
      let s = byDev.get(r.dev);
      if (!s) byDev.set(r.dev, (s = new Set()));
      s.add(r.ino);
    }
    for (const f of this.files.values()) {
      const inos = byDev.get(f.dev);
      if (!inos) continue;
      let hit = inos.has(f.ino);
      let uncertain = false;
      if (!hit) {
        for (let i = 0; i < f.chain.length && !hit; i++) hit = inos.has(f.chain[i]!);
        if (!hit && f.truncated) {
          hit = true;
          uncertain = true;
        }
      }
      if (!hit) continue;
      for (const [pid, h] of f.holders) {
        let m = out.get(pid);
        if (!m) out.set(pid, (m = { pid, comm: this.procs.get(pid)?.comm ?? "", kinds: new Set(), uncertain: true }));
        if (h.cwd) m.kinds.add("cwd");
        if (h.root) m.kinds.add("root");
        if (h.exe) m.kinds.add("exe");
        if (h.fd > 0) m.kinds.add("fd");
        if (h.mmap) m.kinds.add("mmap");
        if (!uncertain) m.uncertain = false;
      }
    }
    return out;
  }

  size(): { pids: number; files: number; holds: number } {
    return { pids: this.procs.size, files: this.files.size, holds: this.holdCount };
  }

  /** forget everything (the helper restarted) */
  reset(): void {
    this.files.clear();
    this.procs.clear();
    this.windows.clear();
    this.moved.clear();
    this.holdCount = 0;
    this.seeded = false;
    this.globalDirty = false;
    this.full = false;
    this.#seedTouched = null;
  }
}
