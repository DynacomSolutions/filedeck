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
  const db = new DatabaseSync(file, { readOnly: true });
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM watch_sessions WHERE id > ? AND mounts_hash = ? LIMIT 1").all(1, "h").map((r) => String(r.detail)).join(" ");
  db.close();
  assert.match(plan, /watch_sessions_mounts/);
});
