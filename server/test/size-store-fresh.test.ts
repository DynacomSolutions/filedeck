import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string;
const stores: SizeStore[] = [];
const agents: { close(): Promise<void> }[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fresh-")))));
after(async () => {
  for (const s of stores) await s.close();
  for (const a of agents) await a.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const t0 = Date.now(); !(await f()) && Date.now() - t0 < ms; ) await sleep(20);
};
function fixture(name: string) {
  const root = path.join(tmp, name);
  for (const d of ["a/x", "a/y", "b/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x/f", "a/y/f", "b/z/f"]) fs.writeFileSync(path.join(root, f), "12345");
  const db = path.join(tmp, `${name}.db`); // beside the tree, not in it
  const s = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 100_000 });
  stores.push(s);
  return { root, s, db };
}
const scannedAt = (db: string, p: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare("SELECT scanned_at s FROM sizes WHERE path = ?").get(p) as { s: number } | undefined)?.s;
  } finally {
    d.close();
  }
};

test("overflow: only the pending folders are marked stale, the watched tree stays reusable, and an in-place change in a pending folder is seen", async () => {
  const { root, s, db } = fixture("overflow");
  await s.scan("/");
  await sleep(20);
  // an in-place edit changes no folder mtime: only the pending/stale mark can make the store notice it
  fs.writeFileSync(path.join(root, "a/x/f"), "1234567890");
  await s.notePending([{ path: "/a/x", dueAt: Date.now() - 10_000, modify: false }], 100);
  assert.equal(await s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 }), null, "backlog too old");
  await until(() => scannedAt(db, "/a/x") === 0);
  assert.equal(scannedAt(db, "/a/x"), 0, "the pending folder is stale");
  for (const p of ["/", "/a", "/a/y", "/b", "/b/z"]) assert.ok((scannedAt(db, p) ?? 0) > 0, `${p} untouched`);
  assert.equal((s as unknown as { marks: Map<string, number> }).marks.size, 0, "no tree mark");
  const r = await s.scanRead("/");
  assert.equal(r.read, 1, "only the stale folder is re-read");
  assert.equal(r.res.bytes, 10 + 5 + 5, "the unseen in-place change is now counted");
  assert.equal((await s.scanRead("/")).read, 0);
});

test("overflow: a pending folder that is not stored marks its stored parent", async () => {
  const { s, db } = fixture("overflow-parent");
  await s.scan("/");
  await s.notePending([{ path: "/a/new", dueAt: Date.now() - 10_000, modify: false }], 100);
  assert.equal(await s.takeDue(Date.now(), 10, { modifyMs: 100, settleMs: 1 }), null);
  await until(() => scannedAt(db, "/a") === 0);
  assert.equal(scannedAt(db, "/a"), 0);
  assert.ok((scannedAt(db, "/b") ?? 0) > 0);
});

test("a stale tree mark is O(1), is honoured by the next walk and is spent by it", async () => {
  const { s, db: file } = fixture("mark");
  await s.scan("/");
  assert.equal((await s.scanRead("/")).read, 0);
  s.markStale("/a");
  const db = new DatabaseSync(file, { readOnly: true });
  await until(() => (db.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n === 1);
  assert.equal((await s.scanRead("/")).read, 3, "/a, /a/x and /a/y re-read; /b reused");
  assert.equal((await s.scanRead("/")).read, 0, "the mark is spent");
  await until(() => (db.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n === 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n, 0);
  db.close();
});

test("a mark survives a restart", async () => {
  const { root, s, db } = fixture("mark-restart");
  await s.scan("/");
  s.markStale("/b");
  await s.close();
  const s2 = new SizeStore(db, { root, ttlMs: 3_600_000, maxEntries: 1000 });
  stores.push(s2);
  assert.equal((await s2.scanRead("/")).read, 2, "/b and /b/z");
});

test("freshTree answers only when covered, quiet, and every row fresh", async () => {
  const { s } = fixture("fresh");
  await s.scan("/");
  await until(() => (s as unknown as { scanIdx: boolean }).scanIdx);
  let covered = false;
  let quiet = true;
  s.covers = () => covered;
  s.quiet = () => quiet;
  assert.equal(await s.freshTree("/", 1, false), null, "not watched");
  covered = true;
  const t = await s.freshTree("/", 1, false);
  assert.equal(t?.entries[0]?.bytes, 15);
  quiet = false;
  assert.equal(await s.freshTree("/", 1, false), null, "a change is waiting in the watcher");
  quiet = true;
  // a pending row (not yet applied) of a folder below
  await s.notePending([{ path: "/b/z", dueAt: Date.now() + 60_000, modify: false }], 100);
  assert.equal(await s.freshTree("/", 1, false), null, "pending change below");
  assert.ok(await s.freshTree("/a", 1, false), "an unrelated folder is still fresh");
  await s.clearPending();
  assert.ok(await s.freshTree("/", 1, false));
  s.markStale("/b");
  assert.equal(await s.freshTree("/", 1, false), null, "a mark above part of the tree");
  assert.ok(await s.freshTree("/a", 1, false), "marks elsewhere do not matter");
  await s.scan("/");
  assert.ok(await s.freshTree("/", 1, false), "fresh again after a walk");
  assert.equal(await s.freshTree("/missing", 1, false), null);
});

/** a helper that is ready at once and reports nothing: the watcher covers the whole root without a kernel */
function readyHelper(dir: string) {
  const f = path.join(dir, "helper.sh");
  fs.writeFileSync(f, "#!/bin/sh\necho '#ready 1'\nexec sleep 3600\n", { mode: 0o755 });
  const mounts = path.join(dir, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  return { f, mounts };
}

test("GET /api/du: a watched tree whose rows are fresh is answered without a job", async () => {
  const root = path.join(tmp, "api");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "api-aux");
  fs.mkdirSync(aux);
  const h = readyHelper(aux);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h.f, FILEDECK_PROC_MOUNTS: h.mounts } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  (app as unknown as { startWatcher(): void }).startWatcher();
  const jobs = async () => ((await (await app.request("/api/jobs")).json()) as { jobs: { kind: string }[] }).jobs.length;
  // no stored rows yet and not covered yet: a job runs
  const first = await app.request("/api/du?path=/t&depth=1");
  assert.equal(first.status, 200);
  assert.equal(await jobs(), 1);
  let ans: { cached: boolean; watched: boolean } = { cached: false, watched: false };
  for (let i = 0; i < 100; i++) {
    ans = (await (await app.request("/api/du?path=/t&depth=1")).json()) as typeof ans;
    if (ans.watched) break;
    await sleep(50);
  }
  assert.equal(ans.watched, true, "watcher ready");
  const before = await jobs();
  for (let i = 0; i < 3; i++) {
    const r = await app.request("/api/du?path=/t&depth=1");
    const b = (await r.json()) as { cached: boolean; watched: boolean; entries: { path: string; bytes: number }[]; stale?: boolean };
    assert.equal(r.status, 200);
    assert.deepEqual([b.cached, b.watched, b.stale], [true, true, undefined]);
    assert.equal(b.entries[0]!.bytes, 3);
  }
  assert.equal(await jobs(), before, "no job for fresh watched data");
});

test("GET /api/du: with something stale, a live scan of an overlapping folder is not waited for: stored rows answer with stale:true", async () => {
  const root = path.join(tmp, "api2");
  fs.mkdirSync(path.join(root, "p/child"), { recursive: true });
  fs.writeFileSync(path.join(root, "p/child/f"), "abc");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "300" } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  assert.equal((await app.request("/api/du?path=/p&depth=1")).status, 200); // stores /p
  // a child rescan that waits for a gate: hold the child's lock with a job created through the API, then hold it by a long-running fresh scan
  const big = path.join(root, "p/child");
  for (let i = 0; i < 15000; i++) fs.mkdirSync(path.join(big, `d${i}`));
  const post = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/p/child", fresh: true }) });
  assert.equal(post.status, 202);
  const job = (await post.json()) as { id: string };
  const t0 = Date.now();
  const r = await app.request("/api/du?path=/p&depth=1");
  const body = (await r.json()) as { stale?: boolean; jobId?: string; entries?: unknown[] };
  const j = (await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string };
  if (j.state === "running" || j.state === "queued") {
    assert.equal(r.status, 200, "answered at once");
    assert.equal(body.stale, true);
    assert.ok(Date.now() - t0 < 250);
  } else {
    assert.ok(r.status === 200 || r.status === 202); // the scan was too quick to overlap on this machine
  }
});

test("commit stall regression: stale marks on a huge store do not rewrite rows or hold the writer; a scan queued behind them is not delayed", async () => {
  // Before: markStale was `UPDATE sizes SET scanned_at = 0 WHERE path = ? OR (path > ? AND path < ?)` over the whole subtree, on the one writer
  // thread: ~1.9 s per mark at 1M rows, ~28 s for 6 marks at 3M, and every scan commit queued behind them (size-commit stalls). Now one mark row each.
  const { root, s, db } = fixture("stall");
  await s.scan("/");
  await sleep(50);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA synchronous=OFF; BEGIN");
  const ins = d.prepare("INSERT INTO sizes (path,parent,ino,dev,mtime_ms,scanned_at,seen_at,own_bytes,own_disk,own_files,own_symlinks,own_other,own_dirs,own_mounts,own_errors,tot_bytes,tot_disk,tot_files,tot_symlinks,tot_other,tot_dirs,tot_mounts,tot_errors) VALUES (?,?,1,1,1,?,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0)");
  const N = 500_000;
  for (let i = 0; i < N; i++) ins.run(`/w/t${i % 50}/d${i}`, `/w/t${i % 50}`, Date.now());
  d.exec("COMMIT");
  d.close();
  const t0 = performance.now();
  for (let i = 0; i < 6; i++) s.markStale(i % 2 ? "/" : "/w");
  fs.writeFileSync(path.join(root, "a/x/g"), "z");
  const r = await s.scan("/a/x", undefined, true);
  const ms = performance.now() - t0;
  assert.equal(r.files, 2);
  console.log(`# stall bench: ${N} rows, 6 marks + small scan: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `took ${ms} ms`);
  const q = new DatabaseSync(db, { readOnly: true });
  assert.equal((q.prepare("SELECT COUNT(*) n FROM sizes WHERE scanned_at = 0").get() as { n: number }).n, 0, "rows were not rewritten");
  assert.ok((q.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n <= 2);
  q.close();
});
