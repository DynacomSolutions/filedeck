import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexCache, type DirReader, type IdxEntry } from "../src/index-cache.ts";
import { localReader } from "../src/diff-routes.ts";
import { CompareSession } from "../src/cmp-engine.ts";
import { DEFAULT_OPTIONS, localSource } from "../src/folderdiff.ts";
import { Semaphore } from "../src/walk.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-cmpcache-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (n: string): IdxEntry => ({ n, t: "file", s: 1, m: 1, i: 1 });

test("a folder removed and created again under the same name is listed anew, not from the old watch", async () => {
  // a reader whose folder can be swapped for another one (another inode) while its watch stays silent, as inotify does after a removal
  let ino = 1;
  let entries = [file("old.txt")];
  let watches = 0;
  const reader: DirReader = {
    statDir: async () => ({ ino, mtime: 5 }),
    readDir: async () => entries,
    watch: () => (watches++, () => undefined),
  };
  const ix = new IndexCache(path.join(tmp, "swap.db"), reader, { ttlMs: 60_000 });
  try {
    assert.deepEqual((await ix.list("/d")).entries.map((e) => e.n), ["old.txt"]);
    assert.equal((await ix.list("/d")).cached, true);
    ino = 2;
    entries = [file("new.txt")];
    const after = await ix.list("/d");
    assert.deepEqual(after.entries.map((e) => e.n), ["new.txt"]);
    assert.equal(after.cached, false);
    assert.equal(watches, 2, "the dead watch was replaced");
    assert.equal((await ix.list("/d")).cached, true, "and the new listing is trusted again");
  } finally {
    ix.close();
  }
});

test("the same swap on a real folder: removed, created again, listed", async () => {
  const dir = path.join(tmp, "real");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "one.txt"), "1");
  const ix = new IndexCache(path.join(tmp, "real.db"), localReader());
  try {
    assert.deepEqual((await ix.list(dir)).entries.map((e) => e.n), ["one.txt"]);
    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "two.txt"), "2");
    await wait(100);
    assert.deepEqual((await ix.list(dir)).entries.map((e) => e.n), ["two.txt"]);
    await wait(50);
    fs.writeFileSync(path.join(dir, "three.txt"), "3"); // the new folder is watched: a later change is seen
    let names: string[] = [];
    for (let i = 0; i < 50 && names.length < 2; i++) {
      await wait(20);
      names = (await ix.list(dir)).entries.map((e) => e.n).sort();
    }
    assert.deepEqual(names, ["three.txt", "two.txt"]);
  } finally {
    ix.close();
  }
});

test("a semaphore passes a free slot on when the waiter that was woken has been aborted", async () => {
  const sem = new Semaphore(1);
  let release!: () => void;
  const holder = sem.run(() => new Promise<void>((r) => (release = r)));
  const ac = new AbortController();
  const aborted = sem.run(async () => "never", ac.signal).then(() => "ran", (e: Error) => e.message);
  let third = "waiting";
  const next = sem.run(async () => (third = "ran"));
  await wait(10);
  ac.abort();
  release(); // abort and release in the same turn: the slot goes to the aborted waiter first
  await holder;
  assert.equal(await aborted, "canceled");
  await Promise.race([next, wait(1000)]);
  assert.equal(third, "ran", "the next waiter was woken");
});

test("an aborted waiter leaves the queue at once", async () => {
  const sem = new Semaphore(1);
  const holder = sem.run(() => wait(200));
  const ac = new AbortController();
  const w = sem.run(async () => 1, ac.signal).catch((e: Error) => e.message);
  await wait(5);
  const t0 = Date.now();
  ac.abort();
  assert.equal(await w, "canceled");
  assert.ok(Date.now() - t0 < 100, "no wait for the holder");
  await holder;
});

test("a compare shows top-level names with characters beyond U+FFFF in a root subtree", async () => {
  for (const side of ["L", "R"]) {
    fs.mkdirSync(path.join(tmp, "astral", side), { recursive: true });
    fs.writeFileSync(path.join(tmp, "astral", side, "plain.txt"), "x");
  }
  fs.writeFileSync(path.join(tmp, "astral/L", "😀.txt"), "smile");
  fs.writeFileSync(path.join(tmp, "astral/R", "😀.txt"), "smile");
  const sess = new CompareSession(localSource(path.join(tmp, "astral/L"), "/"), localSource(path.join(tmp, "astral/R"), "/"), { ...DEFAULT_OPTIONS, mode: "content", dirConcurrency: 1 }, path.join(tmp, "astral.db"));
  try {
    await sess.run(new AbortController().signal);
    assert.deepEqual([...sess.subtree([""])].map((r) => r.p).sort(), ["plain.txt", "😀.txt"]);
  } finally {
    sess.close();
  }
});
