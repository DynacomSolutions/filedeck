import { test } from "node:test";
import assert from "node:assert/strict";
import { HT, HF_ERROR, HF_SHARED, HF_TRUNCATED, HF_VANISHED, type HolderRec } from "../src/holders-proto.ts";
import { HoldersTable } from "../src/holders-table.ts";

/**
 * The table's logic with hand-made events: the start-up pass, the events after it, lost events (a snapshot that replaces what a pid held), exit and
 * the proof flags. The kernel side is tested by holders-helper.test.ts where BPF can be loaded.
 */
const DEV = 100;
// a tree on one device:  / (2)  >  data (10)  >  work (20)  >  deep (30)  >  file (40)
const rec = (type: number, pid: number, ino: number, chain: number[], extra: Partial<HolderRec> = {}): HolderRec => ({ type, pid, aux: 0, dev: DEV, flags: 0, ino, comm: "p" + pid, chain: Float64Array.from(chain), ...extra });
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

test("holders table: a fork that shares the file table marks the child to be read again", () => {
  const t = seeded();
  t.apply(fd(10));
  t.apply(rec(HT.FORK, 10, 0, [], { aux: 12, flags: HF_SHARED }));
  assert.deepEqual(t.gaps().dirtyPids, [12]);
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
