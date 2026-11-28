import { test } from "node:test";
import assert from "node:assert/strict";
import { HT, HF_AGENT, HF_CUT, HF_ERROR, HF_MT, HF_SHARED, HF_TRUNCATED, HF_VANISHED, type HolderRec } from "../src/holders-proto.ts";
import { GHOST_PID, HoldersTable } from "../src/holders-table.ts";

/**
 * The table's logic with hand-made events: the start-up pass, the events after it, lost events (a snapshot that replaces what a pid held), exit and
 * the proof flags. The kernel side is tested by holders-helper.test.ts where BPF can be loaded.
 */
const DEV = 100;
// a tree on one device:  / (2)  >  data (10)  >  work (20)  >  deep (30)  >  file (40)
const rec = (type: number, pid: number, ino: number, chain: number[], extra: Partial<HolderRec> = {}): HolderRec => ({ type, pid, aux: 0, dev: DEV, flags: 0, ino, comm: "p" + pid, key: 0n, chain: Float64Array.from(chain), ...extra });
const fd = (pid: number, ino = 40, chain = [30, 20, 10, 2]) => rec(HT.FD, pid, ino, chain);
const close = (pid: number, ino = 40) => rec(HT.CLOSE, pid, ino, []);
const root = (ino: number) => ({ dev: DEV, ino });
const pids = (t: HoldersTable, ino: number) => [...t.find([root(ino)]).keys()].sort((a, b) => a - b);

function seeded(): HoldersTable {
  const t = new HoldersTable();
  t.beginSeed();
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  return t;
}

test("holders table: a descriptor matches the folders above the file and the file itself", () => {
  const t = seeded();
  t.apply(fd(7));
  for (const ino of [40, 30, 20, 10, 2]) assert.deepEqual(pids(t, ino), [7], `inode ${ino}`);
  assert.deepEqual(pids(t, 99), [], "another folder");
  assert.deepEqual([...t.find([{ dev: 999, ino: 20 }]).keys()], [], "the same number on another device is another folder");
  assert.deepEqual([...t.find([root(20)]).get(7)!.kinds], ["fd"]);
});

test("holders table: descriptors are counted, one close does not release two", () => {
  const t = seeded();
  t.apply(fd(7));
  t.apply(fd(7)); // dup
  t.apply(close(7));
  assert.deepEqual(pids(t, 20), [7], "one descriptor is left");
  t.apply(close(7));
  assert.deepEqual(pids(t, 20), []);
  assert.equal(t.size().holds, 0);
  assert.equal(t.files.size, 0, "a file nobody holds leaves the table");
});

test("holders table: a close of a file nobody holds, and of an unknown pid, changes nothing", () => {
  const t = seeded();
  t.apply(close(5));
  t.apply(fd(7));
  t.apply(close(7, 41));
  assert.deepEqual(pids(t, 20), [7]);
});

test("holders table: chdir replaces the working folder; the old folder is released", () => {
  const t = seeded();
  t.apply(rec(HT.CWD, 8, 20, [10, 2]));
  assert.deepEqual(pids(t, 10), [8]);
  t.apply(rec(HT.CWD, 8, 30, [20, 10, 2]));
  assert.deepEqual([...t.find([root(30)]).get(8)!.kinds], ["cwd"]);
  t.apply(rec(HT.CWD, 8, 50, [11, 2])); // another branch
  assert.deepEqual(pids(t, 20), []);
  assert.deepEqual(pids(t, 11), [8]);
  assert.equal(t.size().holds, 1);
});

test("holders table: exec drops the mappings and the old executable, and keeps the descriptors and the folders", () => {
  const t = seeded();
  t.apply(fd(9));
  t.apply(rec(HT.CWD, 9, 20, [10, 2]));
  t.apply(rec(HT.MMAP, 9, 60, [30, 20, 10, 2]));
  t.apply(rec(HT.EXE, 9, 61, [30, 20, 10, 2], { comm: "old" }));
  assert.deepEqual([...t.find([root(30)]).get(9)!.kinds].sort(), ["exe", "fd", "mmap"], "the working folder is 20, above 30");
  t.apply(rec(HT.EXECBEG, 9, 0, []));
  const k = [...t.find([root(30)]).get(9)!.kinds].sort();
  assert.deepEqual(k, ["fd"], "only the descriptor is under 30; the working folder is 20");
  assert.deepEqual([...t.find([root(20)]).get(9)!.kinds].sort(), ["cwd", "fd"]);
  t.apply(rec(HT.EXE, 9, 70, [30, 20, 10, 2], { comm: "new" }));
  assert.equal(t.procs.get(9)!.comm, "new");
  assert.deepEqual([...t.find([root(70)]).get(9)!.kinds], ["exe"]);
});

test("holders table: a child holds what the parent held at the fork; later changes of one are not the other's", () => {
  const t = seeded();
  t.apply(fd(10));
  t.apply(rec(HT.CWD, 10, 20, [10, 2]));
  t.apply(rec(HT.FORK, 10, 0, [], { aux: 11 }));
  assert.deepEqual(pids(t, 20), [10, 11]);
  t.apply(close(11));
  assert.deepEqual(pids(t, 40), [10], "the child closed its copy");
  t.apply(rec(HT.CWD, 10, 50, [11, 2]));
  assert.deepEqual([...t.find([root(10)]).get(11)!.kinds].sort(), ["cwd"], "the child keeps the old working folder");
  assert.deepEqual(pids(t, 11), [10]);
});

test("holders table: a fork that shares the file table or folders makes both unproven while they share, and neither loses its copy when the other ends", () => {
  const t = seeded();
  t.apply(fd(10));
  t.apply(rec(HT.FORK, 10, 0, [], { aux: 12, flags: HF_SHARED }));
  assert.deepEqual(t.gaps().shared, [10, 12], "the events of one are not the other's: both are unproven");
  assert.deepEqual(pids(t, 40), [10, 12]);
  // the child opens a file that the parent holds through the shared table as well: the table has it only for the child
  t.apply(fd(12, 41, [30, 20, 10, 2]));
  assert.deepEqual(pids(t, 41), [12]);
  // the child ends: the parent keeps what it had, and is read again (the shared table changed under it); nothing is shared any more
  t.apply(rec(HT.EXIT, 12, 0, []));
  assert.deepEqual(pids(t, 40), [10], "the hold of the parent stays");
  assert.deepEqual(t.gaps().shared, []);
  assert.deepEqual(t.gaps().dirtyPids, [10]);
  // a third process in the group: the group stays while two live
  const u = seeded();
  u.apply(rec(HT.FORK, 10, 0, [], { aux: 12, flags: HF_SHARED }));
  u.apply(rec(HT.FORK, 12, 0, [], { aux: 13, flags: HF_SHARED }));
  assert.deepEqual(u.gaps().shared, [10, 12, 13]);
  u.apply(rec(HT.EXIT, 13, 0, []));
  assert.deepEqual(u.gaps().shared, [10, 12]);
  // a read of one of them does not end the sharing
  u.apply(rec(HT.SNAPBEG, 12, 0, []));
  u.apply(rec(HT.SNAPEND, 12, 0, []));
  assert.deepEqual(u.gaps().shared, [10, 12]);
});

test("holders table: a fork of a multi-threaded parent, or of the agent, is read again, and is unproven until then", () => {
  const t = seeded();
  t.apply(fd(10));
  t.apply(rec(HT.FORK, 10, 0, [], { aux: 14, flags: HF_MT }));
  t.apply(rec(HT.FORK, 99, 0, [], { aux: 15, flags: HF_AGENT }));
  assert.deepEqual(t.gaps().dirtyPids, [14, 15]);
  // a thread of the parent closed the file after the kernel copied the table: the child still has it, and the read finds it
  t.apply(close(10));
  t.apply(rec(HT.SNAPBEG, 14, 0, []));
  t.apply(rec(HT.SFD, 14, 40, [30, 20, 10, 2]));
  t.apply(rec(HT.SNAPEND, 14, 0, []));
  assert.deepEqual(t.gaps().dirtyPids, [15]);
  assert.deepEqual(pids(t, 40), [14]);
});

test("holders table: a lost fork or move record (pid 0) makes the table unproven until a full read ends", () => {
  const t = seeded();
  t.apply(rec(HT.DIRTY, 0, 0, []));
  assert.equal(t.gaps().global, true);
  t.beginSeed();
  assert.equal(t.gaps().unseeded, true);
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  assert.equal(t.gaps().global, false);
  assert.equal(t.gaps().unseeded, false);
  // a record lost while the pass ran leaves the table unproven after it
  t.beginSeed();
  t.apply(rec(HT.DIRTY, 0, 0, []));
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  assert.equal(t.gaps().global, true);
});

test("holders table: a process keeps one working folder per fs_struct; a thread with a table of its own does not release the folder of another", () => {
  const t = seeded();
  t.apply(rec(HT.CWD, 8, 20, [10, 2], { key: 100n }));
  t.apply(rec(HT.CWD, 8, 30, [20, 10, 2], { key: 200n })); // another thread, with its own fs_struct
  assert.deepEqual(pids(t, 20), [8], "the first folder is still held (it is the first fs_struct's)");
  assert.deepEqual(pids(t, 30), [8]);
  t.apply(rec(HT.CWD, 8, 50, [11, 2], { key: 200n })); // the thread moves on
  assert.deepEqual(pids(t, 30), [], "its old folder is released");
  assert.deepEqual(pids(t, 20), [8], "the other table keeps its folder");
  assert.deepEqual(pids(t, 11), [8]);
  t.apply(rec(HT.CWD, 8, 51, [11, 2], { key: 100n }));
  assert.deepEqual(pids(t, 20), []);
  // the same folder in two tables is released only when both left it
  t.apply(rec(HT.ROOT, 8, 2, [], { key: 100n }));
  t.apply(rec(HT.ROOT, 8, 2, [], { key: 200n }));
  t.apply(rec(HT.ROOT, 8, 3, [], { key: 100n }));
  assert.deepEqual([...t.find([root(2)]).get(8)!.kinds].includes("root"), true);
  // exec ends every thread but one: which table is left is not known
  t.apply(rec(HT.EXECBEG, 8, 0, []));
  assert.deepEqual(t.gaps().dirtyPids, [8]);
});

test("holders table: a snapshot records the folder of every fs_struct of the process", () => {
  const t = seeded();
  t.apply(rec(HT.SNAPBEG, 9, 0, []));
  t.apply(rec(HT.SCWD, 9, 20, [10, 2], { key: 100n }));
  t.apply(rec(HT.SCWD, 9, 30, [20, 10, 2], { key: 200n }));
  t.apply(rec(HT.SNAPEND, 9, 0, []));
  assert.deepEqual(pids(t, 20), [9]);
  assert.deepEqual([...t.find([root(30)]).get(9)!.kinds], ["cwd"]);
  assert.equal(t.procs.get(9)!.cwds.size, 2);
});

test("holders table: a child's folder table has a key of its own; its first folder replaces the one that it copied, and the parent's stays", () => {
  const t = seeded();
  t.apply(rec(HT.CWD, 10, 20, [10, 2], { key: 100n }));
  t.apply(rec(HT.FORK, 10, 0, [], { aux: 11 }));
  assert.deepEqual(pids(t, 20), [10, 11]);
  t.apply(rec(HT.CWD, 11, 30, [20, 10, 2], { key: 300n }));
  assert.deepEqual(pids(t, 20), [10, 11], "the folder 20 is above 30");
  assert.deepEqual([...t.find([root(20)]).get(11)!.kinds], ["cwd"]);
  assert.deepEqual([...t.find([root(30)]).keys()], [11]);
  t.apply(rec(HT.CWD, 11, 50, [11, 2], { key: 300n }));
  assert.deepEqual([...t.find([root(20)]).keys()], [10], "the child left; the parent holds 20 still");
});

test("holders table: a chain that was read while a rename ran matches every path on its device, and a later complete sight replaces it", () => {
  const t = seeded();
  t.apply(rec(HT.FD, 70, 40, [30], { flags: HF_TRUNCATED | HF_CUT }));
  assert.equal(t.find([root(99)]).get(70)?.uncertain, true);
  t.apply(rec(HT.SNAPBEG, 70, 0, []));
  t.apply(rec(HT.SFD, 70, 40, [30, 20, 10, 2]));
  t.apply(rec(HT.SNAPEND, 70, 0, []));
  assert.deepEqual([...t.find([root(99)]).keys()], []);
  assert.equal(t.find([root(10)]).get(70)?.uncertain, false);
});

test("holders table: a process with an io_uring is a gap; a read that shows no ring clears it; a child has the ring's descriptor too", () => {
  const t = seeded();
  t.apply(rec(HT.URING, 71, 0, []));
  assert.deepEqual(t.gaps().uring, [71]);
  t.apply(rec(HT.FORK, 71, 0, [], { aux: 72 }));
  assert.deepEqual(t.gaps().uring, [71, 72]);
  t.apply(rec(HT.SNAPBEG, 71, 0, []));
  t.apply(rec(HT.SNAPEND, 71, 0, []));
  assert.deepEqual(t.gaps().uring, [72], "the read found no ring in 71");
  t.apply(rec(HT.SNAPBEG, 72, 0, []));
  t.apply(rec(HT.SURING, 72, 0, []));
  t.apply(rec(HT.SNAPEND, 72, 0, []));
  assert.deepEqual(t.gaps().uring, [72], "the read found it");
  t.apply(rec(HT.EXIT, 72, 0, []));
  assert.deepEqual(t.gaps().uring, []);
});

test("holders table: descriptors that a process sent in a message stay held after it closed them and after it ended (they may be in flight)", () => {
  const t = seeded();
  t.apply(fd(73));
  t.apply(rec(HT.SCM, 73, 0, []));
  t.apply(close(73));
  assert.deepEqual([...t.find([root(40)]).get(73)!.kinds], ["inflight"], "closed, but it may be in flight");
  // a read of the process keeps the pin; a fork does not copy it
  t.apply(rec(HT.SNAPBEG, 73, 0, []));
  t.apply(rec(HT.SNAPEND, 73, 0, []));
  assert.deepEqual(pids(t, 40), [73]);
  t.apply(rec(HT.FORK, 73, 0, [], { aux: 74 }));
  assert.deepEqual(pids(t, 40), [73], "the child has no copy of a hold that its parent only pinned");
  t.apply(rec(HT.EXIT, 73, 0, []));
  assert.deepEqual(pids(t, 40), [GHOST_PID], "the files go to the holder of the descriptors in flight");
  assert.equal(t.procs.get(GHOST_PID)!.comm, "in flight");
  // the pass over all processes does not drop it
  t.beginSeed();
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  assert.deepEqual(pids(t, 40), [GHOST_PID]);
  // a file that was open but never sent is not pinned
  t.apply(fd(75, 41, [30, 20, 10, 2]));
  t.apply(rec(HT.SCM, 75, 0, []));
  t.apply(fd(75, 42, [30, 20, 10, 2]));
  t.apply(close(75, 42));
  t.apply(rec(HT.EXIT, 75, 0, []));
  assert.deepEqual(pids(t, 41), [GHOST_PID]);
  assert.deepEqual(pids(t, 42), []);
});

test("holders table: a fork of a parent that holds nothing tracked gives a clean child", () => {
  const t = seeded();
  t.apply(rec(HT.FORK, 1, 0, [], { aux: 13 }));
  assert.deepEqual(t.gaps().dirtyPids, []);
  assert.equal(t.procs.has(13), true);
});

test("holders table: a fork during the start-up pass, before the parent is read, is read again", () => {
  const t = new HoldersTable();
  t.beginSeed();
  t.apply(rec(HT.FORK, 1, 0, [], { aux: 13 }));
  assert.deepEqual(t.gaps().dirtyPids, [13]);
  // the parent's snapshot ends: a later fork is not affected
  t.apply(rec(HT.SNAPBEG, 2, 0, []));
  t.apply(rec(HT.SNAPEND, 2, 0, []));
  t.apply(rec(HT.FORK, 2, 0, [], { aux: 14 }));
  assert.deepEqual(t.gaps().dirtyPids, [13]);
});

test("holders table: exit removes the process and every hold; a reused pid starts empty", () => {
  const t = seeded();
  t.apply(fd(20));
  t.apply(rec(HT.MMAP, 20, 60, [30, 20, 10, 2]));
  t.apply(rec(HT.EXIT, 20, 0, []));
  assert.deepEqual(pids(t, 2), []);
  assert.equal(t.size().holds, 0);
  assert.equal(t.files.size, 0);
  t.apply(rec(HT.FORK, 1, 0, [], { aux: 20 }));
  assert.deepEqual(pids(t, 2), [], "a new process with the number of the old one");
});

test("holders table: a fork onto a pid whose exit was lost drops what the old process held", () => {
  const t = seeded();
  t.apply(fd(20));
  t.apply(rec(HT.FORK, 1, 0, [], { aux: 20 }));
  assert.deepEqual(pids(t, 2), []);
});

test("holders table: a snapshot replaces what the pid held and keeps the events that came during it", () => {
  const t = seeded();
  t.apply(fd(30, 40));
  t.apply(fd(30, 41, [30, 20, 10, 2])); // an event that the snapshot will not see (it is gone: the close was lost)
  t.markDirty(30);
  assert.deepEqual(t.gaps().dirtyPids, [30]);
  t.apply(rec(HT.SNAPBEG, 30, 0, []));
  t.apply(rec(HT.SFD, 30, 40, [30, 20, 10, 2]));
  t.apply(rec(HT.SCWD, 30, 20, [10, 2]));
  t.apply(fd(30, 42, [30, 20, 10, 2])); // an open that happens while the snapshot runs
  assert.deepEqual(t.gaps().dirtyPids, [30], "a snapshot under way is a gap");
  t.apply(rec(HT.SNAPEND, 30, 0, []));
  assert.deepEqual(t.gaps().dirtyPids, []);
  assert.deepEqual([...t.find([root(41)]).keys()], [], "the stale open is gone");
  assert.deepEqual([...t.find([root(40)]).keys()], [30]);
  assert.deepEqual([...t.find([root(42)]).keys()], [30], "the open during the snapshot is kept");
  assert.deepEqual([...t.find([root(20)]).get(30)!.kinds].sort(), ["cwd", "fd"]);
  assert.equal(t.size().holds, 3, "the files 40 and 42, and the working folder 20");
});

test("holders table: a snapshot of a pid that vanished removes it; one that failed counts as unreadable after three tries", () => {
  const t = seeded();
  t.apply(fd(31));
  t.apply(rec(HT.SNAPBEG, 31, 0, []));
  t.apply(rec(HT.SNAPEND, 31, 0, [], { flags: HF_VANISHED }));
  assert.equal(t.procs.has(31), false);
  assert.equal(t.files.size, 0);

  t.apply(fd(32));
  for (let i = 0; i < 3; i++) {
    t.apply(rec(HT.SNAPBEG, 32, 0, []));
    t.apply(rec(HT.SFD, 32, 40, [30, 20, 10, 2]));
    t.apply(rec(HT.SNAPEND, 32, 0, [], { flags: HF_ERROR }));
  }
  assert.deepEqual(t.gaps().unreadable, [32]);
  assert.deepEqual(t.gaps().dirtyPids, []);
  assert.equal(t.files.size, 1, "the file of the failed snapshots does not pile up: only the old hold is left");
  assert.deepEqual([...t.find([root(40)]).keys()], [32], "what the table knew stays (a failed read changes nothing)");
});

test("holders table: a lost-events record marks a pid, or all of them", () => {
  const t = seeded();
  t.apply(rec(HT.DIRTY, 40, 0, []));
  assert.deepEqual(t.gaps().dirtyPids, [40]);
  t.apply(rec(HT.DIRTY, 0, 0, []));
  assert.equal(t.gaps().global, true);
});

test("holders table: the table is unseeded until the pass ends, and the pass drops pids that nobody met", () => {
  const t = new HoldersTable();
  assert.equal(t.gaps().unseeded, true);
  t.apply(fd(50)); // an event of a pid that the pass does not meet
  t.beginSeed();
  t.apply(rec(HT.SNAPBEG, 51, 0, []));
  t.apply(rec(HT.SFD, 51, 40, [30, 20, 10, 2]));
  t.apply(rec(HT.SNAPEND, 51, 0, []));
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  assert.equal(t.gaps().unseeded, false);
  assert.deepEqual(pids(t, 20), [51], "pid 50 is not in the pass and sent no event after it began: it is gone");
});

test("holders table: a moved inode marks the pids that hold files below it", () => {
  const t = seeded();
  t.apply(fd(60));
  t.apply(fd(61, 99, [98, 2]));
  t.apply(rec(HT.MOVED, 1, 20, []));
  assert.deepEqual(t.settleMoves(), [60]);
  assert.deepEqual(t.gaps().dirtyPids, [60]);
  assert.deepEqual(t.settleMoves(), [], "settled once");
});

test("holders table: a file whose chain is not complete may be anywhere on its device", () => {
  const t = seeded();
  t.apply(rec(HT.FD, 70, 40, [30], { flags: HF_TRUNCATED }));
  const m = t.find([root(10)]).get(70)!;
  assert.equal(m.uncertain, true);
  assert.deepEqual([...t.find([{ dev: 5, ino: 10 }]).keys()], [], "another device");
  t.apply(fd(71));
  assert.equal(t.find([root(10)]).get(71)!.uncertain, false);
});

test("holders table: it stops taking events at its size limit and says so", () => {
  const t = new HoldersTable({ maxHolds: 3 });
  t.beginSeed();
  t.apply(rec(HT.SEEDEND, 0, 0, []));
  for (let i = 0; i < 6; i++) t.apply(fd(80, 100 + i, [20, 10, 2]));
  assert.equal(t.size().holds, 3);
  assert.equal(t.gaps().full, true);
});

test("holders table: reset forgets everything", () => {
  const t = seeded();
  t.apply(fd(90));
  t.reset();
  assert.deepEqual(t.size(), { pids: 0, files: 0, holds: 0 });
  assert.equal(t.gaps().unseeded, true);
});
