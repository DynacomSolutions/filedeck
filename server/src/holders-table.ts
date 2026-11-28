import { HF_AGENT, HF_MT, HF_SHARED, HF_TRUNCATED, HF_VANISHED, HF_ERROR, HT, type HolderRec } from "./holders-proto.ts";

/**
 * The table "who holds what", kept from the events of `filedeck-holders` (server/native/filedeck-holders.bpf.c). It holds no policy and does no I/O.
 *
 * What is held is a file identity: the kernel device of the superblock, the inode number, and the inode numbers of the folders above it (the chain).
 * A tree (a folder, named by its own device and inode number) is held when a held file is that folder or has it in its chain. The name of the folder
 * and the mount namespace do not matter, and a bind mount of a part of the tree matches too.
 *
 * Soundness. A process that holds something is always in the table, unless a gap is known: the events are sent before the kernel acts, the table
 * only ever gets more than the kernel has when an event for a release is missed (an extra holder, never a missing one), and what cannot be told is
 * marked: `gaps()` says which pids are to be read again (dirty), whether the table was never seeded, whether a whole class of events may be lost, and which
 * processes share their file table or folders with another one (their events are not the sharer's) or hold an io_uring (its fixed files are not seen).
 * Descriptors that a process sent in a message are in flight, held by no process: the holds of the sender at that moment are pinned (they stay until
 * the sender ends, and then go to the holder with the pid 0, which stays until the table is reset).
 * A hold stays after a missed release until the process execs, exits or is read again. A mapping is never released by an event: the manager reads the
 * process again before it reports a mapping.
 */

export type HoldKind = "cwd" | "root" | "exe" | "fd" | "mmap" | "inflight";

/** The pid of the holder of the files that were in flight when their sender ended */
export const GHOST_PID = 0;

/** One process's hold on one file. */
export interface Hold {
  /** how many descriptors */
  fd: number;
  mmap: boolean;
  /** how many fs_structs of the process have the file as their working folder, or their root */
  cwd: number;
  root: number;
  exe: boolean;
  /** the process sent descriptors in a message: the file may be in flight, so the hold stays */
  pin: boolean;
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
  /** the working folder and the root folder of each fs_struct of the process (a thread may have its own), by the fs_struct's key. "?" = the one that the kernel
   *  copied at the fork and whose key is not known yet. */
  cwds: Map<string, string>;
  roots: Map<string, string>;
  exe?: string;
  maps: Set<string>;
  /** a gap is known: read this process again */
  dirty: boolean;
  /** reading it failed and was tried again this many times */
  failures: number;
  /** the time (ms) of the last read of this process by a snapshot */
  readAt: number;
  /** the process holds an io_uring: files in its fixed table are held by the ring, and no hook sees them */
  uring: boolean;
  /** the process sent descriptors in a message */
  scm: boolean;
  /** the pids that share a file table or folders with this one (this one included), while they all live */
  group?: Set<number>;
}

const fileKey = (dev: number, ino: number) => `${dev}:${ino}`;
const emptyHold = (): Hold => ({ fd: 0, mmap: false, cwd: 0, root: 0, exe: false, pin: false });
const holdIsEmpty = (h: Hold) => h.fd <= 0 && !h.mmap && h.cwd <= 0 && h.root <= 0 && !h.exe && !h.pin;

export interface Gaps {
  /** no start-up pass has finished */
  unseeded: boolean;
  /** events of unknown pids were lost: the table is read again from the start */
  global: boolean;
  /** the pids that are to be read again */
  dirtyPids: number[];
  /** the pids that could not be read (the table cannot vouch for them) */
  unreadable: number[];
  /** the pids that share their file table or folders with another process: the events of one are not the other's */
  shared: number[];
  /** the pids that hold an io_uring */
  uring: number[];
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
    return { comm, holds: new Map(), cwds: new Map(), roots: new Map(), maps: new Set(), dirty: false, failures: 0, readAt: 0, uring: false, scm: false };
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

  #setSlot(t: Target, slot: "exe", rec: HolderRec): void {
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

  /**
   * The working folder or the root of one fs_struct. A process has one table per fs_struct, and two threads may have two: the slot is the fs_struct's, not the
   * process's, so that a thread that changes its folder does not release the folder of another thread.
   */
  #setFs(t: Target, kind: "cwd" | "root", rec: HolderRec): void {
    const slots = kind === "cwd" ? t.st.cwds : t.st.roots;
    const k = String(rec.key);
    const name = slots.has(k) ? k : slots.has("?") ? "?" : k; // (the fs_struct that the kernel copied at the fork has the first key that is seen)
    const old = slots.get(name);
    const key = fileKey(rec.dev, rec.ino);
    if (old === key) {
      this.#hold(t, rec); // (the chain may be newer)
      if (name !== k) {
        slots.delete(name);
        slots.set(k, key);
      }
      return;
    }
    const h = this.#hold(t, rec);
    if (!h) return;
    h[kind]++;
    slots.delete(name);
    slots.set(k, key);
    if (old) {
      const oh = t.st.holds.get(old);
      if (oh) {
        oh[kind] = Math.max(0, oh[kind] - 1);
        this.#release(t, old);
      }
    }
  }

  /** the process sent descriptors in a message: what it holds now may be in flight, and stays held */
  #pin(t: Target): void {
    t.st.scm = true;
    for (const h of t.st.holds.values()) h.pin = true;
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
        this.#setFs(t, "cwd", rec);
        return;
      case HT.ROOT:
      case HT.SROOT:
        this.#setFs(t, "root", rec);
        return;
      case HT.URING:
      case HT.SURING:
        if (rec.aux === 1) t.st.uring = true; // (a ring without registered files holds nothing)
        return;
      case HT.SCM:
        this.#pin(t);
        return;
      case HT.EXECBEG: {
        // exec ends every thread but one: which fs_struct is left is not known, so a process with several is read again
        if (t.st.cwds.size > 1 || t.st.roots.size > 1) t.st.dirty = true;
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

  /**
   * Removes a process and the holds of it. What it holds through a table that it shares with another process is that process's too (its own copy of the
   * hold stays): the processes that were left are read again, and are unproven while they still share. The holds that the process pinned (descriptors that it
   * sent in a message) go to the ghost holder.
   */
  dropPid(pid: number): void {
    const st = this.procs.get(pid);
    if (!st) return;
    if (pid !== GHOST_PID) this.#toGhost(st);
    this.#unindex(pid, st);
    this.procs.delete(pid);
    const g = st.group;
    if (g) {
      g.delete(pid);
      for (const m of g) {
        const ms = this.procs.get(m);
        if (!ms) continue;
        ms.dirty = true;
        if (g.size < 2) ms.group = undefined;
      }
    }
  }

  /** the files that a process pinned stay held after it ends (a descriptor in flight is held by no process) */
  #toGhost(st: ProcState): void {
    for (const [key, h] of st.holds) {
      if (!h.pin) continue;
      const f = this.files.get(key);
      if (!f) continue;
      let ghost = this.procs.get(GHOST_PID);
      if (!ghost) {
        ghost = HoldersTable.newState("in flight");
        this.procs.set(GHOST_PID, ghost);
      }
      if (ghost.holds.has(key)) continue;
      const gh = emptyHold();
      gh.pin = true;
      ghost.holds.set(key, gh);
      f.holders.set(GHOST_PID, gh);
      this.holdCount++;
    }
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
      case HT.SURING:
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
      case HT.URING:
      case HT.SCM:
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
        const copy: Hold = { ...h, pin: false }; // (the child sent nothing)
        if (holdIsEmpty(copy)) continue; // (a hold that only the pin kept)
        st.holds.set(key, copy);
        f.holders.set(child, copy);
        this.holdCount++;
      }
      // the folder table of the child is a new one that the kernel filled; its key is not known until the child sets a folder
      st.cwds = parent.cwds.size === 1 ? new Map([["?", [...parent.cwds.values()][0]!]]) : new Map(parent.cwds);
      st.roots = parent.roots.size === 1 ? new Map([["?", [...parent.roots.values()][0]!]]) : new Map(parent.roots);
      st.exe = parent.exe;
      st.maps = new Set(parent.maps);
      st.uring = parent.uring; // (it has the ring's descriptor too)
      if (parent.dirty) st.dirty = true;
    }
    // (a parent that is not in the table holds nothing that is tracked, unless the start-up pass has not read it yet)
    if (this.#seedTouched && !this.#seedDone.has(rec.pid)) st.dirty = true;
    // It shares its file table or folders with the parent: what either does to them is not seen as the other's. They are unproven while both live.
    if (rec.flags & HF_SHARED) {
      const ps = this.#state(rec.pid, rec.comm);
      const g = ps.group ?? (ps.group = new Set([rec.pid]));
      g.add(child);
      st.group = g;
    }
    // The kernel copied the file table before this event, and a thread of the parent may have opened or closed a file since (MT); the agent's children
    // may hold what the agent held, and the table has nothing of the agent (AGENT). The child is read: it is unproven until that read ends.
    if (rec.flags & (HF_MT | HF_AGENT)) st.dirty = true;
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
    const old = this.procs.get(rec.pid);
    if (old) {
      // what a read of the kernel cannot show: the sharing, the descriptors that were sent (the pins), and that a message was sent
      fresh.group = old.group;
      fresh.scm = old.scm;
      for (const [key, h] of old.holds) {
        if (!h.pin) continue;
        let nh = fresh.holds.get(key);
        if (!nh) fresh.holds.set(key, (nh = emptyHold()));
        nh.pin = true;
      }
    }
    const t: Target = { pid: rec.pid, st: fresh, indexed: false };
    for (const ev of win.events) this.#apply(t, ev); // (an event can mark the state: an exec of a process with several folder tables)
    fresh.failures = 0;
    fresh.readAt = Date.now();
    if (!fresh.comm) fresh.comm = old?.comm ?? "";
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
    if (touched) for (const pid of [...this.procs.keys()]) if (pid !== GHOST_PID && !touched.has(pid)) this.dropPid(pid);
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
    const shared: number[] = [];
    const uring: number[] = [];
    for (const [pid, st] of this.procs) {
      if (st.dirty) (st.failures >= 3 ? unreadable : dirtyPids).push(pid);
      if (st.group && st.group.size > 1) shared.push(pid);
      if (st.uring) uring.push(pid);
    }
    for (const pid of this.windows.keys()) if (!dirtyPids.includes(pid) && !unreadable.includes(pid)) dirtyPids.push(pid); // (a snapshot under way is not yet in the table)
    return { unseeded: !this.seeded, global: this.globalDirty, dirtyPids, unreadable, shared: shared.sort((x, y) => x - y), uring: uring.sort((x, y) => x - y), full: this.full };
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
        if (h.cwd > 0) m.kinds.add("cwd");
        if (h.root > 0) m.kinds.add("root");
        if (h.exe) m.kinds.add("exe");
        if (h.fd > 0) m.kinds.add("fd");
        if (h.mmap) m.kinds.add("mmap");
        if (h.pin) m.kinds.add("inflight");
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
