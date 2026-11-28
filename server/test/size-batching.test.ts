import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FanWatch, type ChangeSink } from "../src/fanwatch.ts";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";
import { DEFAULT_SIZE_EXCLUDE, parseSizeExclude, sizeExcluder } from "../src/size-exclude.ts";
import { SizeStore } from "../src/size-store.ts";
import { loadConfig } from "../src/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};
const watchers: FanWatch[] = [];
const buses: EventBus[] = [];
const stores: SizeStore[] = [];
const dirs: string[] = [];
after(async () => {
  for (const w of watchers) w.stop();
  for (const b of buses) await b.close().catch(() => {});
  for (const s of stores) await Promise.resolve(s.close()).catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** a size sink that records what the watcher asks of it */
function sink() {
  const applied: { v: string; at: number }[] = [];
  const stale: string[] = [];
  const noted: { path: string; dueAt: number; modify: boolean }[][] = [];
  const s: ChangeSink = {
    applyChanged: async (v: string) => void applied.push({ v, at: Date.now() }),
    markStale: (v: string) => void stale.push(v),
    notePending: async (items) => (noted.push(items), false), // false: kept in memory, drained from there
  };
  return { s, applied, stale, noted };
}
const watch = (k: ChangeSink, o: Partial<ConstructorParameters<typeof FanWatch>[1]> = {}) => {
  const w = new FanWatch(k, { helper: "x", root: "/", procMounts: "/proc/mounts", settleMs: 5, modifyMs: 50, ...o });
  watchers.push(w);
  return w;
};

test("sizeExcluder: names at any depth, runs of names, globs; never a part of a name", () => {
  const ex = sizeExcluder(parseSizeExclude(DEFAULT_SIZE_EXCLUDE));
  for (const p of ["/a/node_modules", "/a/node_modules/x/y", "/pg/data/pg_wal", "/r/target/debug", "/r/.git/objects/ab", "/r/.git/objects", "/c/cargo-target/wt-x"]) assert.ok(ex(p), p);
  for (const p of ["/a", "/", "/a/node_modules2", "/a/xtarget", "/r/.git", "/r/.git/refs", "/r/objects", "/r/.gitx/objects", "/a/targets/b"]) assert.ok(!ex(p), p);
  const g = sizeExcluder(parseSizeExclude("cargo-*, build{1,2}\n/tmp-x/"));
  assert.ok(g("/a/cargo-target/w") && g("/a/cargo-foo") && g("/a/build2/x") && g("/tmp-x/y"));
  assert.ok(!g("/a/cargo") && !g("/a/build3"));
  assert.ok(!sizeExcluder([])("/a/node_modules"));
  assert.deepEqual(parseSizeExclude(" a , b/c/ ,, "), ["a", "b/c"]);
});

test("config: FILEDECK_SIZE_COMMIT_MS defaults to 30000, FILEDECK_SIZE_EXCLUDE to the five folders; an empty list switches excludes off", () => {
  const c = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.sizeCommitMs, 30_000);
  assert.deepEqual(c.sizeExclude, ["pg_wal", "node_modules", "target", ".git/objects", "cargo-target"]);
  assert.equal(loadConfig({ FILEDECK_SIZE_COMMIT_MS: "5000", FILEDECK_SIZE_EXCLUDE: "" } as NodeJS.ProcessEnv).sizeCommitMs, 5000);
  assert.deepEqual(loadConfig({ FILEDECK_SIZE_EXCLUDE: "" } as NodeJS.ProcessEnv).sizeExclude, []);
});

test("commit interval: many events of one folder are one re-read, and nothing is applied before the interval ends", async () => {
  const k = sink();
  const w = watch(k.s, { commitMs: 1500 });
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) w.line(`C f /data/busy/f${i}`);
  for (let i = 0; i < 1000; i++) w.line(`W f /data/busy/f${i}`);
  await sleep(200);
  if (Date.now() - t0 < 1000) assert.equal(k.applied.length, 0, "inside the interval nothing is written or re-read");
  await until(() => k.applied.length >= 1);
  await sleep(150);
  assert.deepEqual(k.applied.map((a) => a.v), ["/data/busy"], "one re-read for 2000 events");
  assert.ok(k.applied[0]!.at - t0 >= 1200, `applied after ${k.applied[0]!.at - t0} ms`);
  const st = w.status().size;
  assert.equal(st.commits, 1);
  assert.equal(st.dirtyPaths, 1);
});

test("without a commit interval the watcher works as before (every tick)", async () => {
  const k = sink();
  const w = watch(k.s);
  w.line("C f /data/busy/a");
  await until(() => k.applied.length >= 1, 3000);
  assert.deepEqual(k.applied.map((a) => a.v), ["/data/busy"]);
});

test("the cap: too many changed folders in one interval become one stale mark per subtree, and memory stays bounded", async () => {
  const k = sink();
  const w = watch(k.s, { commitMs: 60_000, dirtyMax: 64 });
  for (let i = 0; i < 5000; i++) w.line(`C f /data/proj/mod${i % 400}/sub${i % 7}/f${i}`);
  assert.ok(w.status().backlog <= 64, `backlog ${w.status().backlog}`);
  await w.handover(10); // the marks of the open interval are written when it ends
  assert.ok(k.stale.length > 0 && k.stale.every((p) => p === "/data/proj" || p.startsWith("/data/proj/") || p === "/data" || p === "/"), `marks ${k.stale}`);
  assert.ok(w.status().size.collapsed > 0);
});

test("flush at shutdown: the folders of the open interval are handed to the store by handover", async () => {
  const k = sink();
  const w = watch(k.s, { commitMs: 60_000 });
  w.line("C f /data/a/x");
  w.line("D f /data/b/y");
  assert.equal(k.noted.length, 0);
  await w.handover(10);
  assert.deepEqual(k.noted.flat().map((i) => i.path).sort(), ["/data/a", "/data/b"]);
});

test("excludes: no size write for an excluded folder, but the event stream, journal bus and counters still get every event", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-excl-")));
  dirs.push(root);
  const bus = new EventBus({ node: "n1", journal: { dir: null } });
  buses.push(bus);
  const k = sink();
  const w = watch(k.s, { root, bus, commitMs: 0, exclude: parseSizeExclude(DEFAULT_SIZE_EXCLUDE) });
  const h = (p: string) => root + p;
  const lines = [
    `C f ${h("/r/node_modules/a/index.js")}`,
    `M f ${h("/r/target/debug/x.o")}`,
    `W f ${h("/r/.git/objects/ab/cdef")}`,
    `C d ${h("/r/cargo-target/wt-1")}`,
    `M f ${h("/pg/pg_wal/0001")}`,
    `C d ${h("/r/node_modules")}`, // the folder itself: its parent changed, the folder is excluded
    `C f ${h("/r/src/main.rs")}`, // not excluded
  ];
  for (const l of lines) w.line(l);
  await until(() => k.applied.length >= 2, 5000);
  await sleep(100);
  assert.deepEqual([...new Set(k.applied.map((a) => a.v))].sort(), ["/r", "/r/src"], "only the folders outside the excluded ones are re-read");
  assert.equal(w.status().size.excludedEvents, 5);
  // the stream has all seven events
  await bus.whenServing();
  const sub = await bus.subscribe(new Filter(), bus.cursorOf(0), "internal");
  const seen: string[] = [];
  while (seen.length < lines.length) {
    const batch = await Promise.race([sub.next(), sleep(500).then(() => null)]);
    if (!batch) break;
    for (const b of batch) {
      const e = JSON.parse(b.toString("utf8")) as { kind: string; path?: string; cursor: string };
      if (e.kind === "ready" && String(e.cursor).endsWith(":0")) continue;
      if (e.path) seen.push(e.path);
    }
  }
  sub.close();
  assert.deepEqual(seen.sort(), lines.map((l) => l.slice(4).replace(root, "")).sort());
  assert.equal((bus.events.create ?? 0) + (bus.events.modify ?? 0) + (bus.events.close_write ?? 0), lines.length);
});

test("an older helper's folder lines are excluded the same way", async () => {
  const k = sink();
  const w = watch(k.s, { exclude: ["node_modules"] });
  w.line("x /a/node_modules/b");
  w.line("x /a/src");
  await until(() => k.applied.length >= 1, 3000);
  await sleep(100);
  assert.deepEqual(k.applied.map((a) => a.v), ["/a/src"]);
  assert.equal(w.status().size.excludedEvents, 1);
});

test("the size store has an index for the watcher's 'is a newer run there' question", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-idx-")));
  dirs.push(dir);
  const file = path.join(dir, "sizes.db");
  const st = new SizeStore(file, { root: dir, ttlMs: 60_000, maxEntries: 100 });
  stores.push(st);
  await st.mayScan();
  await until(() => {
    const d = new DatabaseSync(file, { readOnly: true });
    try { return d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'watch_sessions_mounts'").all().length > 0; } finally { d.close(); }
  }, 5000); // the index is made in the background after the lease
  const db = new DatabaseSync(file, { readOnly: true });
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM watch_sessions WHERE id > ? AND mounts_hash = ? LIMIT 1").all(1, "h").map((r) => String(r.detail)).join(" ");
  db.close();
  assert.match(plan, /watch_sessions_mounts/);
});

test("the cap: merged subtrees get their stale marks in one write at the end of the interval, later events inside them add nothing, and settled() says not settled", async () => {
  const k = sink();
  const many: string[][] = [];
  (k.s as ChangeSink).markStaleMany = (v: string[]) => void many.push(v);
  const w = watch(k.s, { commitMs: 400, dirtyMax: 64 });
  for (let i = 0; i < 3000; i++) w.line(`C f /data/proj/mod${i % 400}/sub${i % 7}/f${i}`);
  assert.equal(k.stale.length, 0, "no mark is written while the interval is open");
  assert.equal(many.length, 0);
  assert.equal(w.settled("/data/proj/mod5"), false, "a merged subtree is not settled");
  const before = w.status().backlog;
  for (let i = 0; i < 500; i++) w.line(`C f /data/proj/mod${i % 400}/other${i}/f`);
  assert.ok(w.status().backlog <= before + 1, "events inside a merged subtree are absorbed");
  await until(() => many.length >= 1, 5000);
  assert.equal(many.length, 1, "one call, one write transaction, for all the marks of the interval");
  assert.ok(many[0]!.length >= 1 && many[0]!.length <= 32);
  assert.ok(many[0]!.every((p) => p === "/" || p === "/data" || p === "/data/proj" || p.startsWith("/data/proj/")), `marks ${many[0]}`);
});

test("the cap: the marks of one interval stay few (the deepest are merged into their parents)", async () => {
  const k = sink();
  const many: string[][] = [];
  (k.s as ChangeSink).markStaleMany = (v: string[]) => void many.push(v);
  const w = watch(k.s, { commitMs: 300, dirtyMax: 40 });
  for (let i = 0; i < 4000; i++) w.line(`C f /data/a${i % 300}/b${i % 11}/c${i % 5}/f${i}`);
  await until(() => many.length >= 1, 5000);
  assert.ok(many.flat().length <= 32, `${many.flat().length} marks`);
});

test("markStaleMany is one write transaction for any number of folders", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-mark-")));
  dirs.push(dir);
  const st = new SizeStore(path.join(dir, "sizes.db"), { root: dir, ttlMs: 60_000, maxEntries: 100 });
  stores.push(st);
  await st.mayScan();
  await sleep(300);
  const tx0 = st.writeTransactions;
  const m0 = st.writeTransactionsBySite.mark ?? 0;
  st.markStaleMany(["/a", "/b/c", "/d/e/f", "/g"]);
  await st.close();
  assert.equal(st.writeTransactions - tx0, 1);
  assert.equal((st.writeTransactionsBySite.mark ?? 0) - m0, 1);
  const db = new DatabaseSync(path.join(dir, "sizes.db"), { readOnly: true });
  const n = Number((db.prepare("SELECT count(*) c FROM stale_trees WHERE path IN ('/a', '/b/c', '/d/e/f', '/g')").get() as { c: number }).c);
  db.close();
  assert.equal(n, 4);
});

test("needsApply: only folders that are stored, under a stored folder, or that have stored folders below", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-need-")));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "a/b/c"), { recursive: true });
  const st = new SizeStore(path.join(dir, "sizes.db"), { root: dir, ttlMs: 60_000, maxEntries: 100 });
  stores.push(st);
  await st.mayScan();
  await st.scan("/");
  const need = await st.needsApply(["/a", "/a/b/c", "/a/b/c/new", "/a/zz", "/x", "/x/y/z", "/"]);
  assert.ok(need);
  assert.deepEqual([...need!].sort(), ["/", "/a", "/a/b/c", "/a/b/c/new", "/a/zz", "/x"]);
});

test("the watch_sessions index is made in the background on a store that lacks it, and its query uses it", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-idx2-")));
  dirs.push(dir);
  const file = path.join(dir, "sizes.db");
  const first = new SizeStore(file, { root: dir, ttlMs: 60_000, maxEntries: 100 });
  await first.mayScan();
  await first.close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX watch_sessions_mounts");
  raw.close();
  const st = new SizeStore(file, { root: dir, ttlMs: 60_000, maxEntries: 100 });
  stores.push(st);
  await st.mayScan();
  const has = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'watch_sessions_mounts'").all().length > 0;
    } finally {
      db.close();
    }
  };
  await until(has, 5000);
  assert.ok(has());
  const db = new DatabaseSync(file, { readOnly: true });
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM watch_sessions WHERE id > ? AND mounts_hash = ? LIMIT 1").all(1, "h").map((r) => String(r.detail)).join(" ");
  db.close();
  assert.match(plan, /USING COVERING INDEX watch_sessions_mounts \(mounts_hash=\? AND id>\?\)/);
});

test("sessionTick: the earlier run and the own row are read once, and the heartbeat is written every 10 s, not every call", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "size-sess-")));
  dirs.push(dir);
  const st = new SizeStore(path.join(dir, "sizes.db"), { root: dir, ttlMs: 60_000, maxEntries: 100 });
  stores.push(st);
  await st.mayScan();
  await sleep(300);
  const ready = Date.now() - 1000;
  const id = await st.sessionStart("h", ready);
  assert.ok(id);
  const s0 = st.writeTransactionsBySite.session ?? 0;
  for (let i = 0; i < 20; i++) assert.ok(await st.sessionTick(id!, "h", ready, 0));
  assert.ok((st.writeTransactionsBySite.session ?? 0) - s0 <= 2, `${(st.writeTransactionsBySite.session ?? 0) - s0} session writes for 20 ticks`);
});
