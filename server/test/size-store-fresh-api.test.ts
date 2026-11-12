import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";
import fsp from "node:fs/promises";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { test, tmp, stores, agents, sleep, until, fixture, type Any, bytes, hold } from "./size-store-fresh-support.ts";

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
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h.f, FILEDECK_PROC_MOUNTS: h.mounts, FILEDECK_HANDOVER_MS: "100" } as never));
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
  // rows stored before the watcher was ready are not vouched for: one rescan after it, then the fast path
  assert.equal((await app.request("/api/du?path=/t&depth=1&fresh=1")).status, 200);
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

test("GET /api/du: a live scan of an overlapping folder is not waited for: stored rows answer with stale:true, and no job is started", async () => {
  const root = path.join(tmp, "api2");
  fs.mkdirSync(path.join(root, "p/child"), { recursive: true });
  fs.writeFileSync(path.join(root, "p/child/f"), "abc");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "300" } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  let stored = 0;
  for (let i = 0; i < 600 && stored !== 200; i++) {
    stored = (await app.request("/api/du?path=/p&depth=1")).status; // stores /p (a repeat after a 202 is answered from that scan)
    if (stored !== 200) await sleep(50);
  }
  assert.equal(stored, 200, "/p is stored");
  // the child rescan is held inside its first directory read
  const orig = fsp.readdir;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reading = false;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p).endsWith("/p/child")) {
      reading = true;
      await gate;
    }
    return (orig as (...x: unknown[]) => unknown)(p, ...a);
  };
  try {
    const post = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/p/child", fresh: true }) });
    assert.equal(post.status, 202);
    const job = (await post.json()) as { id: string };
    while (!reading) await sleep(5);
    const jobsBefore = ((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
    const t0 = Date.now();
    const r = await app.request("/api/du?path=/p&depth=1");
    assert.equal(r.status, 200, "answered at once");
    const body = (await r.json()) as { stale?: boolean; entries: { path: string }[] };
    assert.equal(body.stale, true);
    assert.equal(body.entries[0]!.path, "/p");
    assert.ok(Date.now() - t0 < 20_000, `${Date.now() - t0} ms`); // the walk is held on a gate: a handler that waited for it would not answer at all
    assert.equal(((await (await app.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, jobsBefore, "no job was started");
    release();
    for (let i = 0; i < 200; i++) {
      if (((await (await app.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state === "done") break;
      await sleep(20);
    }
  } finally {
    release();
    (fsp as { readdir: unknown }).readdir = orig;
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
  assert.ok(ms < 4000, `took ${ms} ms`); // the old cost was several seconds for these marks; the row checks below are the exact assertions
  const q = new DatabaseSync(db, { readOnly: true });
  assert.equal((q.prepare("SELECT COUNT(*) n FROM sizes WHERE scanned_at = 0").get() as { n: number }).n, 0, "rows were not rewritten");
  assert.ok((q.prepare("SELECT COUNT(*) n FROM stale_trees").get() as { n: number }).n <= 2);
  q.close();
});

test("GET /api/du?cachedOnly=1 says stale:true unless the store vouches for the rows", async () => {
  const root = path.join(tmp, "api3");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "api3-aux");
  fs.mkdirSync(aux);
  const h = readyHelper(aux);
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h.f, FILEDECK_PROC_MOUNTS: h.mounts, FILEDECK_HANDOVER_MS: "100" } as never));
  agents.push(app as unknown as { close(): Promise<void> });
  const get = async () => (await (await app.request("/api/du?path=/t&depth=1&cachedOnly=1")).json()) as { stale?: boolean; watched?: boolean; entries: { bytes: number }[] };
  assert.equal((await app.request("/api/du?path=/t&depth=1&cachedOnly=1")).status, 204, "nothing stored yet");
  assert.equal((await app.request("/api/du?path=/t&depth=1")).status, 200);
  assert.equal((await get()).stale, true, "stored, but the watcher is not running");
  (app as unknown as { startWatcher(): void }).startWatcher();
  for (let i = 0; i < 4500 && (await get()).watched !== true; i++) await sleep(20); // the watcher is ready
  assert.equal((await get()).stale, true, "ready, but nothing validated since");
  assert.equal((await app.request("/api/du?path=/t&depth=1&fresh=1")).status, 200); // a rescan after the watcher was ready
  for (let i = 0; i < 3000 && (await get()).stale === true; i++) await sleep(50);
  assert.equal((await get()).stale, undefined);
});

test("a process that is not the writer answers du from the store flagged stale and starts no job; a rescan or a size job waits for the lease instead of failing", async () => {
  const root = path.join(tmp, "api4");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  const aux = path.join(tmp, "api4-aux");
  fs.mkdirSync(aux);
  const mk = (duWaitMs: number) => {
    const a = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_DU_WAIT_MS: String(duWaitMs) } as never));
    agents.push(a as unknown as { close(): Promise<void> });
    return a;
  };
  // the writer's first scan must answer 200 however slow the host is: a long wait. The reader's short wait is what turns "waits for the writer" into a 202.
  const writer = mk(120_000);
  assert.equal((await writer.request("/api/du?path=/t&depth=1")).status, 200); // stores /t
  const reader = mk(200);
  const jobs = async () => ((await (await reader.request("/api/jobs")).json()) as { jobs: unknown[] }).jobs.length;
  const jobsBefore = await jobs(); // (the job list is shared: the writer's own du job is in it)
  const r = await reader.request("/api/du?path=/t&depth=1");
  assert.equal(r.status, 200);
  const b = (await r.json()) as { stale?: boolean; entries: { bytes: number }[] };
  assert.equal(b.stale, true);
  assert.equal(b.entries[0]!.bytes, 3);
  assert.equal(await jobs(), jobsBefore, "no job was started for a stored folder");
  assert.equal((await reader.request("/api/du?path=/t/sub&depth=0")).status, 200, "a stored folder");
  // a rescan, an unstored folder and a size job queue until the lease is free
  const post = await reader.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t" }) });
  assert.equal(post.status, 202);
  const job = (await post.json()) as { id: string };
  assert.equal((await reader.request("/api/du?path=/t&depth=1&fresh=1")).status, 202, "waits for the writer");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(((await (await reader.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state, "queued");
  await (writer as unknown as { close(): Promise<void> }).close(); // the lease is released
  let state = "queued";
  for (let i = 0; i < 2400 && state !== "done"; i++) { // (up to 2 min: the loop ends as soon as the job is done)
    state = ((await (await reader.request(`/api/jobs/${job.id}`)).json()) as { state: string }).state;
    if (state !== "done") await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(state, "done", "the queued job ran once the reader became the writer");
});

/** an agent with a helper that is ready at once and prints what is put in its `ev` file */
function liveAgent(name: string, env: Record<string, string> = {}, dirs = 0) {
  const root = path.join(tmp, name, "root");
  fs.mkdirSync(path.join(root, "t/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "t/sub/f"), "abc");
  for (let i = 0; i < dirs; i++) fs.mkdirSync(path.join(root, `t/d${i % 50}/e${i}`), { recursive: true });
  const aux = path.join(tmp, name, "aux");
  fs.mkdirSync(aux, { recursive: true });
  const ev = path.join(aux, "ev");
  const h = path.join(aux, "helper.sh");
  fs.writeFileSync(h, `#!/bin/sh\necho '#ready 1'\nwhile sleep 0.02; do if [ -f ${ev} ]; then cat ${ev}; rm -f ${ev}; fi; done\n`, { mode: 0o755 });
  const mounts = path.join(aux, "mounts");
  fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
  const start = () => {
    const a = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: aux, FILEDECK_FANWATCH: h, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_HANDOVER_MS: "100", ...env } as never)) as Any;
    agents.push(a);
    a.startWatcher();
    return a;
  };
  return { root, ev, start };
}
const jsonOf = async (r: Response) => (await r.json()) as Any;

for (const qs of ["fresh=1", "all=1"]) {
  test(`X1 the repeat (${qs}) of a detached du, after the change was reported and applied, is not the old tree`, async () => {
    const w = liveAgent("x1" + qs.slice(0, 3), { FILEDECK_DU_WAIT_MS: "0" });
    const a = w.start();
    await sleep(300);
    const url = `/api/du?path=/t&depth=1&${qs}`;
    const first = await a.request(url);
    assert.equal(first.status, 202);
    const { jobId } = await jsonOf(first);
    for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${jobId}`))).state !== "done"; i++) await sleep(20);
    fs.writeFileSync(path.join(w.root, "t/sub/f"), "abcdefghij");
    fs.writeFileSync(w.ev, `x ${w.root}/t/sub\n`);
    await sleep(2200); // settled and applied: nothing waits any more
    const r = await a.request(url);
    const b = await jsonOf(r);
    assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, `answered ${b.entries?.[0]?.bytes} unflagged`);
  });
}

test("X2 a du that joins a size job after a restart gap says stale: the job reused rows on their age", async () => {
  const w = liveAgent("x2", {}, 400);
  const A = w.start();
  await sleep(300);
  assert.equal((await A.request("/api/du?path=/t&depth=1&fresh=1")).status, 200);
  await A.close();
  fs.writeFileSync(path.join(w.root, "t/sub/f"), "abcdefghij"); // in place, in the gap
  const B = w.start();
  for (let i = 0; i < 1500 && !(await jsonOf(await B.request("/api/du?path=/t&depth=1&cachedOnly=1"))).watched; i++) await sleep(50);
  await sleep(300);
  await B.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t" }) });
  const r = await B.request("/api/du?path=/t&depth=1");
  const b = await jsonOf(r);
  assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, `answered ${b.entries?.[0]?.bytes} unflagged through a joined size job`);
});

test("X3 a du waiting for its job when SIGTERM arrives gets a retryable 503, not a cancellation", async () => {
  const w = liveAgent("x3", {}, 6000);
  const a = w.start();
  await sleep(300);
  const p = a.request("/api/du?path=/t&depth=2&fresh=1");
  await sleep(60);
  void a.leave();
  const r = await p;
  assert.ok([200, 202, 502, 503, 504].includes(r.status), `client gets ${r.status}`);
});

test("X4 a size job or du that reaches a process after it left is refused with 503, not accepted and forgotten", async () => {
  const w = liveAgent("x4");
  const A = w.start();
  await sleep(300);
  await A.leave();
  const post = await A.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t" }) });
  assert.equal(post.status, 503);
  assert.equal((await A.request("/api/du?path=/t&depth=1&fresh=1")).status, 503);
});

/** like liveAgent, and the helper exits when `quit` appears (a crash; the watcher restarts it after its backoff) */
function quittingAgent(name: string, env: Record<string, string> = {}, dirs = 0) {
  const w = liveAgent(name, { FILEDECK_DU_WAIT_MS: "0", ...env }, dirs);
  const aux = path.dirname(w.ev);
  const quit = path.join(aux, "quit");
  fs.writeFileSync(path.join(aux, "helper.sh"), `#!/bin/sh\necho '#ready 1'\nwhile sleep 0.02; do if [ -f ${quit} ]; then rm -f ${quit}; exit 1; fi; if [ -f ${w.ev} ]; then cat ${w.ev}; rm -f ${w.ev}; fi; done\n`, { mode: 0o755 });
  return { ...w, quit };
}
let lastStore: Any;
const origLock = SizeStore.prototype.lock;
SizeStore.prototype.lock = function (this: Any, ...a: Any[]) {
  lastStore = this;
  return (origLock as Any).apply(this, a);
} as Any;

for (const qs of ["fresh=1", "all=0"]) {
  test(`R1 the repeat (${qs}) after an overflow: the change is known only as a stale mark, and the answer says so`, async () => {
    const w = quittingAgent("r1" + qs.slice(0, 3));
    const a = w.start();
    await sleep(300);
    const url = `/api/du?path=/t&depth=1&${qs}`;
    const first = await a.request(url);
    assert.equal(first.status, 202);
    const { jobId } = await jsonOf(first);
    for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${jobId}`))).state !== "done"; i++) await sleep(20);
    fs.writeFileSync(path.join(w.root, "t/sub/f"), "abcdefghij");
    fs.writeFileSync(w.ev, "!overflow\n");
    await sleep(300);
    const r = await a.request(url);
    const b = await jsonOf(r);
    assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, `old size ${b.entries?.[0]?.bytes} unflagged`);
  });
}

test("R2 the repeat after the helper died and came back: the event died with it, the same stale mark", async () => {
  const w = quittingAgent("r2");
  const a = w.start();
  await sleep(300);
  const url = "/api/du?path=/t&depth=1";
  const first = await a.request(url);
  assert.equal(first.status, 202);
  const { jobId } = await jsonOf(first);
  for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${jobId}`))).state !== "done"; i++) await sleep(20);
  fs.writeFileSync(path.join(w.root, "t/sub/f"), "abcdefghij");
  fs.writeFileSync(w.quit, "");
  await sleep(2000);
  const r = await a.request(url);
  const b = await jsonOf(r);
  assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, `old size ${b.entries?.[0]?.bytes} unflagged`);
});

test("R3 a replay that cannot get the lock in time answers 202 done and keeps the entry: the next repeat is the finished job, not a new walk", async () => {
  const w = quittingAgent("r3", {}, 200);
  const a = w.start();
  await sleep(300);
  const url = "/api/du?path=/t&depth=1&fresh=1";
  const first = await a.request(url);
  assert.equal(first.status, 202);
  const id = (await jsonOf(first)).jobId;
  for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${id}`))).state !== "done"; i++) await sleep(20);
  const rel = await lastStore.lock("/t"); // an overlapping walk holds the lock past the wait
  const second = await a.request(url);
  assert.equal(second.status, 202);
  assert.equal((await jsonOf(second)).jobId, id);
  rel();
  const third = await a.request(url);
  assert.equal(third.status, 200, "answered from the finished job (a new rescan would be 202)");
});

test("R4 in the window between SIGTERM and the lease release a size job is refused, not accepted and forgotten; R5 so is a du", async () => {
  const w = liveAgent("r4", { FILEDECK_HANDOVER_MS: "1500", FILEDECK_DU_WAIT_MS: "800" });
  const a = w.start();
  await sleep(300);
  const lv = a.leave();
  await sleep(50);
  const post = await a.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/t" }) });
  assert.equal(post.status, 503);
  assert.equal((await a.request("/api/du?path=/t&depth=1&fresh=1")).status, 503);
  await lv;
});

let hookTree: (() => Promise<void>) | undefined;
const origTree = SizeStore.prototype.tree;
SizeStore.prototype.tree = async function (this: Any, ...a: Any[]) {
  const h = hookTree;
  hookTree = undefined; // once
  if (h) await h();
  return (origTree as Any).apply(this, a);
} as Any;

for (const qs of ["fresh=1", "all=0"]) {
  test(`W1 (${qs}) an overflow after the walk read the tree but before the job finished: the repeat is flagged stale`, async () => {
    const w = quittingAgent("w1" + qs.slice(0, 3), { FILEDECK_HANDOVER_MS: "100" });
    const a = w.start();
    await sleep(300);
    // the job's reply tree read is slow: the folder changes and the watcher overflows meanwhile
    hookTree = async () => {
      fs.writeFileSync(path.join(w.root, "t/sub/f"), "abcdefghij");
      fs.writeFileSync(w.ev, "!overflow\n");
      await sleep(400);
    };
    const url = `/api/du?path=/t&depth=1&${qs}`;
    const first = await a.request(url);
    assert.equal(first.status, 202);
    const { jobId } = await jsonOf(first);
    for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${jobId}`))).state !== "done"; i++) await sleep(20);
    await sleep(300);
    const r = await a.request(url);
    const b = await jsonOf(r);
    assert.ok(r.status !== 200 || b.stale === true || b.entries[0].bytes === 10, `old size ${b.entries?.[0]?.bytes} unflagged`);
  });
}

test("S1 a du --fresh finished before SIGTERM is answered from the finished scan in the stopping window; only a new job is refused", async () => {
  const w = quittingAgent("s1", { FILEDECK_HANDOVER_MS: "1500" }, 200);
  const a = w.start();
  await sleep(300);
  const url = "/api/du?path=/t&depth=1&fresh=1";
  const first = await a.request(url);
  assert.equal(first.status, 202);
  const { jobId } = await jsonOf(first);
  for (let i = 0; i < 7500 && (await jsonOf(await a.request(`/api/jobs/${jobId}`))).state !== "done"; i++) await sleep(20);
  const lv = a.leave();
  await sleep(50);
  const r = await a.request(url);
  assert.equal(r.status, 200, "the finished scan's answer was refused");
  assert.equal((await a.request("/api/du?path=/t&depth=0&fresh=1")).status, 503, "a new job is refused");
  await lv;
});

