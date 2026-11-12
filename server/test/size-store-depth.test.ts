import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore, tmp, at, sleep, mk, rows, agrees, fileStore } from "./size-store-support.ts";

// ---- memory follows depth ----


for (const kind of ["memory", "file"] as const) {
  test(`wide folder (${kind} store): 20k files and 2k subfolders, totals, removed subfolders dropped, unchanged rescan reads nothing`, async () => {
    const dir = at(`wide-${kind}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < 20_000; i++) fs.writeFileSync(path.join(dir, `f${i}`), "x");
    for (let i = 0; i < 2_000; i++) {
      fs.mkdirSync(path.join(dir, `d${i}`));
      if (i % 4 === 0) fs.writeFileSync(path.join(dir, `d${i}`, "g"), "yy");
    }
    const s = kind === "memory" ? mk() : fileStore();
    const v = `/wide-${kind}`;
    const r = await s.scan(v);
    assert.deepEqual({ files: r.files, dirs: r.dirs, bytes: r.bytes }, { files: 20_500, dirs: 2_000, bytes: 21_000 });
    assert.ok(s.lastWalkFrames <= 2);
    // unchanged: all 2k stored children are validated in pages and nothing is read
    assert.equal((await s.scanRead(v)).read, 0);
    // remove subfolders (with files in some), then re-read the folder
    for (let i = 0; i < 2_000; i += 3) fs.rmSync(path.join(dir, `d${i}`), { recursive: true });
    const gone = Math.ceil(2_000 / 3);
    const r2 = await s.scan(v, undefined, false);
    assert.equal(r2.dirs, 2_000 - gone);
    assert.equal(r2.files, 20_500 - 167); // 167 removed folders held a file (multiples of 12 below 2000)
    const rows2 = await rows(s, v);
    assert.equal(rows2.length, 1 + 2_000 - gone);
    await agrees(s, v);
    s.close();
  });
}

test("abort mid-walk closes every directory and leaves the subtree stale", async () => {
  const dir = at("abort");
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(dir, `a${i}`, "b"), { recursive: true });
  const fds = () => (process.platform === "linux" ? fs.readdirSync("/proc/self/fd").length : 0);
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000, commitChunk: 5, streamAbove: 0 });
  const before = fds();
  const ac = new AbortController();
  // the walk aborts itself from its own progress report, so it cannot finish before the abort
  let entries = 0;
  const progress = {
    bytes: 0,
    totalBytes: 0,
    totalEntries: 0,
    current: "",
    get entries() {
      return entries;
    },
    set entries(n: number) {
      entries = n;
      if (n > 100) ac.abort();
    },
  };
  const ctl = { signal: ac.signal, progress };
  await assert.rejects(s.scan("/abort", ctl), /canceled/);
  // read-ahead listings (readdir/lstat started before the abort) may still hold a descriptor for a moment; a leaked Dir never goes away
  for (let i = 0; i < 1500 && fds() !== before; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fds() <= before, `${fds()} descriptors open, ${before} before`); // fewer is fine: unrelated handles of earlier tests may close meanwhile
  // rows written before the abort are marked stale, so the next scan re-reads them
  // (a stale mark on the subtree, not a rewrite of its rows)
  const left = (s as unknown as { db: { prepare(q: string): { get(): { n: number; m: number } } } }).db.prepare("SELECT COUNT(*) AS n, MAX(scanned_at) AS m FROM sizes").get();
  const markAt = (s as unknown as { markAt(p: string): number }).markAt("/abort");
  assert.ok(left.n > 0 && left.m <= markAt, `rows ${left.m} not older than the mark ${markAt}`);
  s.close();
});

test("writer WAL stays bounded: a reader's snapshot delays the checkpoint, the file shrinks once it lets go", async () => {
  const dir = at("walcap");
  for (let i = 0; i < 1500; i++) fs.mkdirSync(path.join(dir, `a${i}`, "b"), { recursive: true });
  const file = path.join(fs.mkdtempSync(path.join(tmp, "db-")), "sizes.db");
  const s = new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000, commitChunk: 20, walLimitBytes: 64 << 10 });
  const reader = new DatabaseSync(file);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM sizes").get(); // pins a snapshot
  await s.scan("/walcap", undefined, true);
  const wal = () => fs.statSync(file + "-wal").size;
  assert.ok(wal() > 64 << 10, "the pinned snapshot keeps the WAL from restarting");
  reader.exec("COMMIT");
  reader.close();
  await sleep(2100);
  await s.scan("/walcap", undefined, true);
  await sleep(2100); // trims are at least 2 s apart: the next write after the pause truncates what the scan grew
  await s.scan("/walcap/a1/b", undefined, true);
  assert.ok(wal() <= 64 << 10, `WAL ${wal()} bytes after the reader let go`);
  s.close();
});

test("walk keeps one frame per level: 20k empty subfolders in one folder", async () => {
  const dir = at("many");
  fs.mkdirSync(dir);
  for (let i = 0; i < 20_000; i++) fs.mkdirSync(path.join(dir, `d${i}`));
  const s = mk(60_000, 1_000_000);
  const r = await s.scan("/many");
  assert.equal(r.dirs, 20_000);
  assert.equal(s.lastWalkFrames, 2); // the folder and one child at a time
  s.close();
});

test("depth limit: folders past it are an error in the totals, and the count is stable across rescans", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "deep-"));
  let p = root;
  for (let i = 0; i < 260; i++) p = path.join(p, "d");
  fs.mkdirSync(p, { recursive: true });
  const s = new SizeStore(":memory:", { root, ttlMs: 60_000, maxEntries: 100_000 });
  const r = await s.scan("/");
  assert.equal(r.dirs, 256);
  assert.ok(r.errors >= 1);
  // a deeper scan first stores rows below the limit of a scan from the top: those folders are reused, not re-read
  const s2 = new SizeStore(":memory:", { root, ttlMs: 60_000, maxEntries: 100_000 });
  await s2.scan("/d/d/d/d/d/d/d/d/d/d");
  const errs = [];
  for (let k = 0; k < 3; k++) errs.push((await s2.scan("/")).errors);
  assert.ok(errs[0]! >= 1);
  assert.deepEqual(new Set(errs).size, 1);
  const own = (s2 as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db.prepare("SELECT MAX(own_errors) AS n FROM sizes").get().n;
  assert.ok(own <= 1);
  s.close();
  s2.close();
});

test("a clock stepped back does not keep removed folders: the purge uses a strictly increasing stamp", async () => {
  fs.mkdirSync(at("ck/a"), { recursive: true });
  fs.mkdirSync(at("ck/b"));
  const s = mk();
  await s.scan("/ck");
  fs.rmdirSync(at("ck/b"));
  const orig = Date.now;
  Date.now = () => orig() - 3_600_000;
  try {
    const r = await s.scan("/ck", undefined, true);
    assert.equal(r.dirs, 1);
  } finally {
    Date.now = orig;
  }
  assert.deepEqual((await rows(s, "/ck")).map((e) => e.path), ["/ck", "/ck/a"]);
  s.close();
});

test("applyChanged climbs through gone folders taking each level's lock", async () => {
  fs.mkdirSync(at("ap/g/p/x"), { recursive: true });
  fs.mkdirSync(at("ap/z"));
  const s = mk();
  await s.scan("/ap");
  fs.rmSync(at("ap/g/p"), { recursive: true });
  const other = await s.lock("/ap/z");
  let done = false;
  const run = s.applyChanged("/ap/g/p/x").then(() => (done = true));
  await sleep(100);
  assert.equal(done, false); // the climb to /ap/g needs the lock of /ap
  other();
  await run;
  assert.deepEqual((await rows(s, "/ap")).map((e) => e.path), ["/ap", "/ap/g", "/ap/z"]);
  assert.equal((await s.tree("/ap", 0, false)).entries[0]!.dirs, 2);
  s.close();
});

test("a stored child that vanishes between the reuse check and the walk is an error", async () => {
  // 1300 children: the vanishing one is past the 1024 rows the reuse check keeps (later pages are lstat-ed again as they are handed out)
  for (let i = 0; i < 1300; i++) fs.mkdirSync(at(`rc/k${String(i).padStart(4, "0")}`), { recursive: true });
  const s = mk();
  await s.scan("/rc");
  const orig = fsp.lstat;
  let n = 0;
  (fsp as { lstat: unknown }).lstat = async (p: string, ...a: unknown[]) => {
    if (String(p) === at("rc/k1299") && ++n === 2) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  try {
    assert.equal((await s.scan("/rc")).errors, 1);
  } finally {
    (fsp as { lstat: unknown }).lstat = orig;
  }
  s.close();
});

test("a store from before seen_at opens, and the first rescan drops removed folders", async () => {
  fs.mkdirSync(at("mg/a"), { recursive: true });
  fs.mkdirSync(at("mg/b"));
  const f = path.join(fs.mkdtempSync(path.join(tmp, "mig-")), "sizes.db");
  const s1 = new SizeStore(f, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  await s1.scan("/mg");
  await s1.close();
  const raw = new DatabaseSync(f);
  raw.exec("ALTER TABLE sizes DROP COLUMN seen_at");
  raw.close();
  fs.rmdirSync(at("mg/b"));
  const s2 = new SizeStore(f, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  assert.ok(s2.persistent);
  assert.equal((await s2.scan("/mg")).dirs, 1);
  assert.deepEqual((await rows(s2, "/mg")).map((e) => e.path), ["/mg", "/mg/a"]);
  s2.close();
});

for (const [kind, streamAbove] of [["opendir (streamed)", 0], ["readdir (small folders)", 1e12]] as const) {
  test(`folder read through ${kind} gives the same totals`, async () => {
    const dir = at(`rd-${streamAbove}`);
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(dir, `d${i}`, "e"), { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `f${i}`), "x");
    const calls = { opendir: 0, readdir: 0 };
    const o1 = fsp.opendir;
    const o2 = fsp.readdir;
    (fsp as { opendir: unknown }).opendir = (...a: unknown[]) => (calls.opendir++, (o1 as (...x: unknown[]) => unknown)(...a));
    (fsp as { readdir: unknown }).readdir = (...a: unknown[]) => (calls.readdir++, (o2 as (...x: unknown[]) => unknown)(...a));
    const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000, streamAbove });
    try {
      const r = await s.scan(`/rd-${streamAbove}`);
      assert.deepEqual({ files: r.files, dirs: r.dirs, bytes: r.bytes }, { files: 100, dirs: 80, bytes: 100 });
    } finally {
      (fsp as { opendir: unknown }).opendir = o1;
      (fsp as { readdir: unknown }).readdir = o2;
    }
    if (streamAbove === 0) assert.ok(calls.opendir === 81 && calls.readdir === 0);
    else assert.ok(calls.readdir === 81 && calls.opendir === 0);
    await agrees(s, `/rd-${streamAbove}`);
    s.close();
  });
}
