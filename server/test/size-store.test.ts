import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { limiter } from "../src/size-store.ts";
import { createAgent as makeAgent } from "../src/agent.ts";
// a file-backed size store starts a writer thread: close every agent so the test process can exit
const agents: { close(): Promise<void> }[] = [];
const createAgent = (cfg: Parameters<typeof makeAgent>[0]) => {
  const a = makeAgent(cfg);
  agents.push(a as unknown as { close(): Promise<void> });
  return a;
};
import { loadConfig } from "../src/config.ts";
import { SizeStore } from "../src/size-store.ts";

let tmp: string;
const at = (p: string) => path.join(tmp, p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = (ttlMs = 60_000, maxEntries = 100_000, commitChunk?: number) => new SizeStore(":memory:", { root: tmp, ttlMs, maxEntries, commitChunk });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sizes-")));
});
after(async () => {
  for (const a of agents) await a.close().catch(() => {}); // some tests close their agent already
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** readdir calls made while `fn` runs */
async function countReaddir(fn: () => Promise<unknown>): Promise<number> {
  const orig = fsp.readdir;
  let n = 0;
  (fsp as { readdir: unknown }).readdir = (...a: unknown[]) => (n++, (orig as (...x: unknown[]) => unknown)(...a));
  try {
    await fn();
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
  }
  return n;
}

const rows = async (s: SizeStore, p: string) => (await s.tree(p, 64, false)).entries.map(({ scannedAt: _s, ...e }) => e);
/** the store must agree with a from-scratch scan of the same tree */
async function agrees(s: SizeStore, p: string) {
  const ref = mk();
  await ref.scan(p, undefined, true);
  assert.deepEqual(await rows(s, p), await rows(ref, p));
  ref.close();
}

test("scan: totals, links, trash store, and an unchanged tree is not read again", async () => {
  fs.mkdirSync(at("a/sub/deep"), { recursive: true });
  fs.writeFileSync(at("a/f.txt"), "12345");
  fs.writeFileSync(at("a/sub/g.txt"), "1234567890");
  fs.writeFileSync(at("a/sub/deep/h.txt"), "x");
  fs.symlinkSync("/etc/passwd", at("a/link"));
  fs.mkdirSync(at("a/.filedeck-trash"));
  fs.writeFileSync(at("a/.filedeck-trash/t"), "T".repeat(1000));
  const s = mk();
  const r = await s.scan("/a");
  assert.equal(r.files, 3);
  assert.equal(r.dirs, 2);
  assert.equal(r.symlinks, 1);
  assert.equal(r.bytes, 16);
  assert.equal(r.truncated, false);
  assert.equal(await countReaddir(async () => assert.deepEqual(await s.scan("/a"), r)), 0);
  assert.equal((await s.scanRead("/a")).read, 0);
  // fresh forces a full re-read
  assert.equal(await countReaddir(() => s.scan("/a", undefined, true)), 3);
  // a changed folder is re-read, unchanged siblings are not
  await sleep(30);
  fs.writeFileSync(at("a/sub/deep/new.txt"), "yy");
  assert.equal(await countReaddir(() => s.scan("/a")), 1);
  assert.equal((await s.scan("/a")).bytes, 18);
  await agrees(s, "/a");
  s.close();
});

test("scan: an expired row is re-read even when unchanged", async () => {
  const s = mk(10);
  await s.scan("/a");
  await sleep(30);
  assert.equal((await s.scanRead("/a")).read, 3);
  s.close();
});

test("scan: a vanished child folder is dropped with its subtree", async () => {
  fs.mkdirSync(at("v/x/y"), { recursive: true });
  fs.writeFileSync(at("v/x/y/f"), "1234");
  fs.writeFileSync(at("v/k"), "12");
  const s = mk();
  await s.scan("/v");
  await sleep(30);
  fs.rmSync(at("v/x"), { recursive: true });
  const r = await s.scan("/v");
  assert.equal(r.bytes, 2);
  assert.deepEqual((await rows(s, "/v")).map((e) => e.path), ["/v"]);
  s.close();
});

test("applyChanged: add, grow and delete a file; add, remove and rename a folder tree", async () => {
  fs.mkdirSync(at("w/one"), { recursive: true });
  fs.writeFileSync(at("w/one/f"), "123");
  fs.writeFileSync(at("w/top"), "12");
  const s = mk();
  await s.scan("/w");
  const total = async () => (await s.tree("/w", 0, false)).entries[0]!;

  fs.writeFileSync(at("w/one/added"), "12345");
  await s.applyChanged("/w/one");
  assert.equal((await total()).bytes, 10);
  assert.equal((await total()).files, 3);
  await agrees(s, "/w");

  fs.appendFileSync(at("w/one/f"), "4567"); // in place: the folder mtime does not change
  await s.applyChanged("/w/one");
  assert.equal((await total()).bytes, 14);
  await agrees(s, "/w");

  fs.rmSync(at("w/one/added"));
  await s.applyChanged("/w/one");
  assert.equal((await total()).bytes, 9);
  await agrees(s, "/w");

  fs.mkdirSync(at("w/new/a/b"), { recursive: true });
  fs.writeFileSync(at("w/new/a/b/f"), "123456");
  await s.applyChanged("/w");
  assert.equal((await total()).bytes, 15);
  assert.equal((await total()).dirs, 4);
  await agrees(s, "/w");

  // an event for a folder the store has not seen re-reads its stored parent
  fs.mkdirSync(at("w/new/c"));
  fs.writeFileSync(at("w/new/c/f"), "1");
  await s.applyChanged("/w/new/c");
  assert.equal((await total()).bytes, 16);
  await agrees(s, "/w");

  fs.renameSync(at("w/new"), at("w/renamed"));
  await s.applyChanged("/w");
  assert.equal((await total()).bytes, 16);
  assert.deepEqual((await rows(s, "/w")).map((e) => e.path).filter((p) => p.includes("new")), []);
  await agrees(s, "/w");

  fs.rmSync(at("w/renamed"), { recursive: true });
  await s.applyChanged("/w/renamed"); // already gone: dropped by its parent's event or its own
  await s.applyChanged("/w");
  assert.equal((await total()).bytes, 9);
  assert.equal((await total()).dirs, 1);
  await agrees(s, "/w");
  s.close();
});

test("applyChanged: a removed folder takes its totals off the ancestors", async () => {
  fs.mkdirSync(at("r/p/q"), { recursive: true });
  fs.writeFileSync(at("r/p/q/f"), "1234");
  const s = mk();
  await s.scan("/r");
  fs.rmSync(at("r/p/q"), { recursive: true });
  await s.applyChanged("/r/p/q");
  assert.equal((await s.tree("/r", 0, false)).entries[0]!.bytes, 0);
  assert.equal((await s.tree("/r", 0, false)).entries[0]!.dirs, 1);
  s.close();
});

// ---- route ----

test("GET /api/du: shape, depth, files with all=1, cached flag, validation", async () => {
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx } as never));
  const get = async (q: string) => app.request("/api/du?" + q);
  type Du = { path: string; entries: { path: string; type: string; bytes: number; files: number; dirs: number; diskBytes: number; scannedAt?: number }[]; cached: boolean; truncated: boolean; watched: boolean };

  const first = (await (await get("path=/a&depth=1")).json()) as Du;
  assert.equal(first.cached, false);
  assert.equal(first.truncated, false);
  assert.equal(first.watched, false);
  assert.equal(first.path, "/a");
  assert.deepEqual(first.entries.map((e) => e.path), ["/a", "/a/sub"]);
  assert.equal(first.entries[0]!.type, "dir");
  assert.equal(first.entries[0]!.bytes, 18);
  assert.equal(first.entries[0]!.files, 4);
  assert.equal(first.entries[0]!.dirs, 2);
  assert.equal(typeof first.entries[0]!.scannedAt, "number");

  const again = (await (await get("path=/a&depth=1")).json()) as Du;
  assert.equal(again.cached, true);
  assert.equal(again.entries[0]!.scannedAt, first.entries[0]!.scannedAt);
  assert.equal(((await (await get("path=/a&depth=1&fresh=1")).json()) as Du).cached, false);
  assert.equal(((await (await get("path=/a&depth=0")).json()) as Du).entries.length, 1);
  assert.equal(((await (await get("path=/a&depth=5")).json()) as Du).entries.length, 3);

  const all = (await (await get("path=/a&depth=1&all=1")).json()) as Du;
  assert.deepEqual(all.entries.map((e) => `${e.type}:${e.path}`).sort(), ["dir:/a", "dir:/a/sub", "file:/a/f.txt", "symlink:/a/link"]);

  assert.equal((await get("path=/a&depth=-1")).status, 400);
  assert.equal((await get("path=/a&depth=x")).status, 400);
  assert.equal((await get("path=/a&all=2")).status, 400);
  assert.equal((await get("path=/../x")).status, 400);
  assert.equal((await get("path=/nope")).status, 404);
  assert.equal((await get("path=/a/f.txt")).status, 400);

  // the store survives the agent: a new agent on the same index dir serves it as cached
  await (app as unknown as { close(): Promise<void> }).close();
  const app2 = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx } as never));
  assert.equal(((await (await app2.request("/api/du?path=/a")).json()) as Du).cached, true);
  await (app2 as unknown as { close(): Promise<void> }).close();
});

test("GET /api/du?cachedOnly=1 answers from the store and never scans", async () => {
  fs.mkdirSync(at("co/sub"), { recursive: true });
  fs.writeFileSync(at("co/sub/f"), "abc");
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx } as never));
  const get = (q: string) => app.request("/api/du?cachedOnly=1&" + q);
  assert.equal((await get("path=/co&depth=1")).status, 204); // unknown: nothing is scanned
  assert.equal((await get("path=/co&depth=1")).status, 204); // still unknown, so the first call stored nothing
  await app.request("/api/du?path=/co&depth=1");
  const r = await get("path=/co&depth=1");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { entries: { path: string; bytes: number }[]; cached: boolean };
  assert.deepEqual(j.entries.map((e) => e.path), ["/co", "/co/sub"]);
  assert.equal(j.entries[1]!.bytes, 3);
  assert.equal(j.cached, true);
  assert.equal((await app.request("/api/du?path=/co&cachedOnly=2")).status, 400);
  await (app as unknown as { close(): Promise<void> }).close();
});

test("unusable database: scans still work uncached and the agent stays up", async () => {
  fs.writeFileSync(at("notadir"), "x");
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);
  try {
    // the database cannot be created below a regular file
    const s = new SizeStore(at("notadir/sizes.db"), { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
    const r = await s.scan("/a");
    assert.equal(r.bytes, 18);
    assert.equal(await countReaddir(() => s.scan("/a")), 3); // nothing is reused
    assert.equal((await s.tree("/a", 1, false)).entries.length, 2);
    await s.applyChanged("/a");
    s.close();

    // a directory where the database file should be: SQLite cannot open it and it cannot be cleared
    const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
    fs.mkdirSync(path.join(idx, "sizes-t.db"));
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx } as never));
    for (let i = 0; i < 2; i++) {
      const j = (await (await app.request("/api/du?path=/a&depth=1")).json()) as { cached: boolean; entries: unknown[] };
      assert.equal(j.cached, false);
      assert.equal(j.entries.length, 2);
    }
    await (app as unknown as { close(): Promise<void> }).close();
    assert.equal(errs.filter((e) => String(e[0]).startsWith("size store unavailable")).length, 2); // once per store
  } finally {
    console.error = orig;
  }
});

// ---- review fixes ----

test("du sees a change deep in the tree at once (no stale shortcut)", async () => {
  fs.mkdirSync(at("d1/sub/deep"), { recursive: true });
  fs.writeFileSync(at("d1/sub/deep/f"), "1");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never));
  type Du = { cached: boolean; entries: { bytes: number }[] };
  const du = async (q = "") => (await (await app.request("/api/du?path=/d1&depth=0" + q)).json()) as Du;
  assert.equal((await du()).entries[0]!.bytes, 1);
  assert.equal((await du()).cached, true);
  await sleep(30);
  fs.writeFileSync(at("d1/sub/deep/big"), "x".repeat(100_000));
  const after = await du();
  assert.equal(after.entries[0]!.bytes, 100_001);
  assert.equal(after.cached, false);
  // in place edit: no folder mtime changes, so only the exact size job sees it
  fs.appendFileSync(at("d1/sub/deep/f"), "22");
  const size = async () => {
    let j = (await (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d1", fresh: true }) })).json()) as { id: string; state: string; result?: { bytes: number } };
    for (let i = 0; i < 200 && (j.state === "queued" || j.state === "running"); i++) {
      await sleep(20);
      j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as typeof j;
    }
    return j.result!.bytes;
  };
  assert.equal(await size(), 100_003);
});

test("a long scan answers 202 with a job id, which keeps running; repeating the request answers from the store", async () => {
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "0" } as never));
  const r = await app.request("/api/du?path=/d1&depth=0");
  assert.equal(r.status, 202);
  const { jobId } = (await r.json()) as { jobId: string };
  let j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
  for (let i = 0; i < 200 && j.state !== "done"; i++) {
    await sleep(20);
    j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
  }
  assert.equal(j.state, "done");
  const again = await app.request("/api/du?path=/d1&depth=0");
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { cached: boolean }).cached, true);
});

test("a mount point scanned on its own does not leak into its parent's totals or get deleted by a parent scan", async () => {
  fs.mkdirSync(at("m/mnt/d/x"), { recursive: true });
  fs.writeFileSync(at("m/mnt/top"), "12");
  fs.writeFileSync(at("m/mnt/d/x/f"), "1".repeat(100));
  const mroot = at("m");
  const [l, st] = [fsp.lstat, fsp.stat];
  const fake = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(mroot + "/mnt/d")) Object.defineProperty(s, "dev", { value: s.dev + 1 });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = fake(l as never);
  (fsp as { stat: unknown }).stat = fake(st as never);
  try {
    const s = new SizeStore(":memory:", { root: mroot, ttlMs: 60_000, maxEntries: 100_000 });
    await s.scan("/mnt");
    await s.scan("/mnt/d");
    await sleep(30);
    fs.writeFileSync(at("m/mnt/d/x/g"), "1".repeat(5000));
    await s.scan("/mnt/d", undefined, true);
    const top = (await s.tree("/mnt", 1, false)).entries;
    assert.deepEqual(top.map((e) => `${e.path}=${e.bytes}`), ["/mnt=2"]);
    assert.equal((await s.tree("/mnt/d", 0, false)).entries[0]!.bytes, 5100);
    await s.scan("/mnt", undefined, true);
    assert.equal((await s.tree("/mnt/d", 0, false)).entries.length, 1);
    assert.equal((await s.tree("/mnt", 0, false)).entries[0]!.bytes, 2);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("inode numbers above 2^53 are stored and a second scan works", async () => {
  fs.mkdirSync(at("ino/s"), { recursive: true });
  const [l, st] = [fsp.lstat, fsp.stat];
  const big = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(at("ino"))) Object.defineProperty(s, "ino", { value: Number(2n ** 62n) });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = big(l as never);
  (fsp as { stat: unknown }).stat = big(st as never);
  try {
    const s = mk();
    await s.scan("/ino");
    assert.equal((await s.scanRead("/ino")).read, 0);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("a folder with 150k stored children can be listed", async () => {
  const s = mk(60_000, 1_000_000);
  const db = s as unknown as { put(r: unknown): void; db: { exec(q: string): void } };
  const own = { bytes: 0, disk: 0, files: 0, symlinks: 0, other: 0, dirs: 0, mounts: 0, errors: 0 };
  const row = (p: string, parent: string) => ({ path: p, parent, ino: 1, dev: 1, mtime_ms: 1, scanned_at: 1, seen_at: 1, own, tot: own });
  db.db.exec("BEGIN");
  db.put(row("/big", "/"));
  for (let i = 0; i < 150_000; i++) db.put(row(`/big/${i}`, "/big"));
  db.db.exec("COMMIT");
  assert.equal((await s.tree("/big", 1, false)).entries.length, 150_001);
  s.close();
});

test("scans of unrelated folders do not wait for each other, overlapping ones do", async () => {
  const s = mk();
  const rel = await s.lock("/x/a");
  const order: string[] = [];
  const other = s.lock("/x/b").then((r) => (order.push("b"), r()));
  const inner = s.lock("/x/a/c").then((r) => (order.push("c"), r()));
  const whole = s.lock("/").then((r) => (order.push("root"), r()));
  await other;
  assert.deepEqual(order, ["b"]);
  rel();
  await Promise.all([inner, whole]);
  assert.deepEqual(order.slice(0, 2).sort(), ["b", "c"].sort());
  assert.equal(order[2], "root");
  s.close();
});

test("overlapping locks are granted in arrival order, so repeated child locks cannot starve a parent", async () => {
  const s = mk();
  let rel = await s.lock("/x/a");
  let got = false;
  const parent = s.lock("/x").then((r) => ((got = true), r()));
  rel();
  let n = 0;
  for (; n < 20 && !got; n++) {
    rel = await s.lock("/x/a"); // the watcher takes the child lock again right away
    rel();
  }
  assert.ok(got && n <= 1, `parent granted only after ${n} child locks`);
  await parent;
  s.close();
});

test("aborting a waiting lock lets later waiters proceed", async () => {
  const s = mk();
  const rel = await s.lock("/x/a");
  const ac = new AbortController();
  const mid = s.lock("/x", ac.signal);
  const last = s.lock("/x/a/b");
  ac.abort();
  await assert.rejects(mid, /canceled/);
  rel();
  (await last)();
  assert.equal((s as any).held.length, 0);
  s.close();
});

test("a job canceled while queued runs its onDrop", async () => {
  const { Jobs } = await import("../src/jobs.ts");
  const jobs = new Jobs(1);
  let gate!: () => void;
  jobs.create("t", "blocker", () => new Promise<void>((r) => (gate = r)));
  let dropped = 0;
  const q = jobs.create("t", "queued", async () => undefined, () => dropped++);
  jobs.cancel(q.id);
  assert.equal(dropped, 1);
  gate();
});

test("applyChanged: a folder deleted and recreated under the same name is not trusted", async () => {
  fs.mkdirSync(at("rc/x/y"), { recursive: true });
  fs.writeFileSync(at("rc/x/y/f"), "1".repeat(1000));
  const s = mk();
  await s.scan("/rc");
  // built beside the old one so it gets another inode (a freed inode number may be handed out again)
  fs.mkdirSync(at("rc/x2"));
  fs.writeFileSync(at("rc/x2/g"), "2");
  fs.rmSync(at("rc/x"), { recursive: true });
  fs.renameSync(at("rc/x2"), at("rc/x"));
  await s.applyChanged("/rc");
  assert.equal((await s.tree("/rc", 0, false)).entries[0]!.bytes, 1);
  await agrees(s, "/rc");
  s.close();
});

test("scan of a folder that was removed trims its rows and its parent", async () => {
  fs.mkdirSync(at("gone/p/q"), { recursive: true });
  fs.writeFileSync(at("gone/p/q/f"), "1234");
  const s = mk();
  await s.scan("/gone");
  await s.scan("/gone/p/q", undefined, true);
  fs.rmSync(at("gone/p/q"), { recursive: true });
  await assert.rejects(() => s.scan("/gone/p/q"));
  // the trim runs after the scan ended, climbing one locked level at a time; wait for it
  for (let i = 0; i < 100 && (await s.tree("/gone", 0, false)).entries[0]!.dirs !== 1; i++) {
    (await s.lock("/"))();
    await sleep(10);
  }
  assert.equal((await s.tree("/gone/p/q", 0, false)).entries.length, 0);
  assert.equal((await s.tree("/gone", 0, false)).entries[0]!.bytes, 0);
  assert.equal((await s.tree("/gone", 0, false)).entries[0]!.dirs, 1);
  await agrees(s, "/gone");
  s.close();
});

test("a scan stored in small chunks gives the same totals, and reports live progress", async () => {
  const s = mk(60_000, 100_000, 2);
  const ctl = { signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const r = await s.scan("/a", ctl, true);
  assert.equal(ctl.progress.bytes, r.bytes);
  assert.ok(ctl.progress.entries > 0);
  await agrees(s, "/a");
  fs.writeFileSync(at("a/sub/chunk"), "abc");
  await s.applyChanged("/a/sub");
  await agrees(s, "/a");
  s.close();
});

// ---- second review round ----

test("applyChanged: a recreated folder is not trusted even when it gets the old inode number", async () => {
  fs.mkdirSync(at("rc2/x/y"), { recursive: true });
  fs.writeFileSync(at("rc2/x/y/f"), "1".repeat(1000));
  const [l, st] = [fsp.lstat, fsp.stat];
  const same = (fn: (...a: never[]) => Promise<fs.Stats>) => async (p: string, ...a: never[]) => {
    const s = await fn(p as never, ...a);
    if (String(p).startsWith(at("rc2/"))) Object.defineProperty(s, "ino", { value: 7 });
    return s;
  };
  (fsp as { lstat: unknown }).lstat = same(l as never);
  (fsp as { stat: unknown }).stat = same(st as never);
  try {
    const s = mk();
    await s.scan("/rc2");
    await sleep(30);
    fs.rmSync(at("rc2/x"), { recursive: true });
    fs.mkdirSync(at("rc2/x"));
    fs.writeFileSync(at("rc2/x/g"), "2");
    await s.applyChanged("/rc2");
    assert.equal((await s.tree("/rc2", 0, false)).entries[0]!.bytes, 1);
    s.close();
  } finally {
    (fsp as { lstat: unknown }).lstat = l;
    (fsp as { stat: unknown }).stat = st;
  }
});

test("uncached store keeps answering for earlier scans, not only the latest", async () => {
  fs.mkdirSync(at("u/a/x"), { recursive: true });
  fs.mkdirSync(at("u/b"), { recursive: true });
  fs.writeFileSync(at("u/file"), "");
  const orig = console.error;
  console.error = () => {};
  try {
    const s = new SizeStore(at("u/file/sizes.db"), { root: at("u"), ttlMs: 60_000, maxEntries: 100_000 });
    assert.equal(s.persistent, false);
    await s.scan("/a");
    await s.scan("/b");
    assert.equal((await s.tree("/a", 1, false)).entries.length, 2);
    assert.equal((await s.tree("/b", 1, false)).entries.length, 1);
    s.close();
  } finally {
    console.error = orig;
  }
});

test("the tree for an answer is built under the scan's lock", async () => {
  const s = mk();
  let got = false;
  let late!: Promise<() => void>;
  await s.scanRead("/a", undefined, true, undefined, async () => {
    late = s.lock("/a").then((r) => ((got = true), r));
    await sleep(30);
    assert.equal(got, false);
  });
  (await late)();
  assert.equal(got, true);
  s.close();
});

test("scans: requests do not wait for overlapping scans, a vanished start folder cannot deadlock, cancel works while waiting", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "dl-"));
  for (const d of ["big/sub", "big/sub2", "q1", "q2", "p/x", "p/w", "p/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const slow = new Set([path.join(root, "big"), path.join(root, "q1"), path.join(root, "q2")]);
  const orig = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (slow.has(String(p))) await sleep(500);
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "100" } as never));
    const post = async (p: string) => (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p }) })).json() as Promise<{ id: string; state: string }>;
    const job = async (id: string) => (await (await app.request(`/api/jobs/${id}`)).json()) as { state: string };
    const settle = async (id: string) => {
      let j = await job(id);
      for (let i = 0; i < 300 && (j.state === "queued" || j.state === "running"); i++) {
        await sleep(20);
        j = await job(id);
      }
      return j.state;
    };

    // the handlers answer at once while an overlapping scan holds the subtree
    const big = await post("/big");
    let t = Date.now();
    const sub = await post("/big/sub");
    assert.ok(Date.now() - t < 200, "POST waited for the lock");
    t = Date.now();
    const r = await app.request("/api/du?path=/big/sub&depth=0");
    assert.equal(r.status, 202);
    assert.ok(Date.now() - t < 400, "GET du waited for the lock");
    // a waiting job can be canceled, and it does not block the one after it
    const doomed = await post("/big/sub2");
    await app.request(`/api/jobs/${doomed.id}/cancel`, { method: "POST" });
    assert.equal(await settle(doomed.id), "canceled");
    assert.equal(await settle(big.id), "done");
    assert.equal(await settle(sub.id), "done");

    // two slow jobs fill the slots; the folders of the queued ones vanish before they start
    const q1 = await post("/q1");
    const q2 = await post("/q2");
    const x = await post("/p/x");
    const w = await post("/p/w");
    const z = await post("/p/z");
    fs.rmSync(path.join(root, "p/x"), { recursive: true });
    fs.rmSync(path.join(root, "p/w"), { recursive: true });
    assert.equal(await settle(q1.id), "done");
    assert.equal(await settle(q2.id), "done");
    assert.equal(await settle(x.id), "failed");
    assert.equal(await settle(w.id), "failed");
    assert.equal(await settle(z.id), "done");
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

// ---- round 4 ----

test("a detached du scan running past a minute is still joined by the repeat request, which then gets the result", async (t) => {
  const root = fs.mkdtempSync(path.join(tmp, "det-"));
  fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const orig = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await gate;
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "0" } as never));
    const du = async () => app.request("/api/du?path=/big&fresh=1");
    const first = await du();
    assert.equal(first.status, 202);
    const { jobId } = (await first.json()) as { jobId: string };
    t.mock.timers.tick(61_000);
    const again = await du();
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { jobId: string }).jobId, jobId);
    t.mock.timers.reset();
    open();
    for (let i = 0; i < 200; i++) {
      const j = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { state: string };
      if (j.state === "done") break;
      await sleep(20);
    }
    const last = await du();
    assert.equal(last.status, 200);
    assert.equal(((await last.json()) as { entries: unknown[] }).entries.length, 2);
  } finally {
    t.mock.timers.reset();
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

test("uncached store keeps at most maxEntries rows across remembered walks", async () => {
  fs.mkdirSync(at("cap/a/x"), { recursive: true });
  fs.mkdirSync(at("cap/b/y"), { recursive: true });
  fs.writeFileSync(at("cap/file"), "");
  const orig = console.error;
  console.error = () => {};
  try {
    const s = new SizeStore(at("cap/file/sizes.db"), { root: at("cap"), ttlMs: 60_000, maxEntries: 3 });
    await s.scan("/a");
    await s.scan("/b");
    assert.equal((await s.tree("/a", 1, false)).entries.length, 0); // evicted: 2 + 2 rows > 3
    assert.equal((await s.tree("/b", 1, false)).entries.length, 2);
    s.close();
  } finally {
    console.error = orig;
  }
});

/** `dirs` folders with `files` one-byte files each, under tmp/<name> (plus the folders a0..a(n/50) that hold them) */
function bigTree(name: string, dirs: number, files: number) {
  for (let i = 0; i < dirs; i++) {
    const d = at(`${name}/a${i % 50}/b${i}`);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < files; j++) fs.writeFileSync(path.join(d, `f${j}`), "x");
  }
  return { files: dirs * files, dirs: dirs + Math.min(dirs, 50), bytes: dirs * files };
}

test("du totals are exact for a tree far above the entry cap, per subtree and cached", async () => {
  const want = bigTree("over", 300, 4); // 1200 files + 350 folders, cap below is 100
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_WALK_MAX_ENTRIES: "100", FILEDECK_DU_WAIT_MS: "60000" } as never));
  type Du = { entries: { path: string; bytes: number; files: number; dirs: number }[]; truncated: boolean; cached: boolean };
  const du = async (q: string) => (await (await app.request("/api/du?" + q)).json()) as Du;
  const top = await du("path=/over&depth=1");
  assert.equal(top.truncated, false);
  assert.deepEqual({ files: top.entries[0]!.files, dirs: top.entries[0]!.dirs, bytes: top.entries[0]!.bytes }, { files: want.files, dirs: want.dirs, bytes: want.bytes });
  // every subtree is exact too: a0 holds the folders b0, b50, b100, ...
  const sub = (await du("path=/over/a0&depth=0")).entries[0]!;
  assert.equal(sub.files, 6 * 4);
  assert.equal(sub.dirs, 6);
  await (app as unknown as { close(): Promise<void> }).close();
  // the totals were stored by the writer worker: a new agent answers them from the file
  const again = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_WALK_MAX_ENTRIES: "100" } as never));
  const c = (await (await again.request("/api/du?path=/over&depth=0")).json()) as Du;
  assert.equal(c.cached, true);
  assert.equal(c.entries[0]!.files, want.files);
  await (again as unknown as { close(): Promise<void> }).close();
});

test("/healthz answers within 1s while a large scan runs", async () => {
  const want = bigTree("health", 1500, 5);
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx } as never));
  const r = await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/health" }) });
  let j = (await r.json()) as { id: string; state: string; result?: { files: number; truncated: boolean } };
  let probes = 0;
  let worst = 0;
  while (j.state === "queued" || j.state === "running") {
    const t0 = performance.now();
    assert.equal(await (await app.request("/healthz")).text(), "ok");
    worst = Math.max(worst, performance.now() - t0);
    probes++;
    await sleep(2);
    j = (await (await app.request(`/api/jobs/${j.id}`)).json()) as typeof j;
  }
  assert.ok(probes > 5, `scan finished after ${probes} probes, too short to prove anything`);
  assert.ok(worst < 1000, `/healthz took ${worst} ms during the scan`);
  assert.equal(j.result!.files, want.files);
  assert.equal(j.result!.truncated, false);
  await (app as unknown as { close(): Promise<void> }).close();
});

// ---- memory follows depth ----

const fileStore = () => new SizeStore(path.join(fs.mkdtempSync(path.join(tmp, "db-")), "sizes.db"), { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 });

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
  const ctl = { signal: ac.signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const timer = setInterval(() => ctl.progress.entries > 100 && ac.abort(), 1);
  await assert.rejects(s.scan("/abort", ctl), /canceled/);
  clearInterval(timer);
  // read-ahead listings (readdir/lstat started before the abort) may still hold a descriptor for a moment; a leaked Dir never goes away
  for (let i = 0; i < 100 && fds() !== before; i++) await new Promise((r) => setTimeout(r, 10));
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

// ---- a busy database is a cache miss ----

type Priv = { q: { get: { get(p: string): unknown } }; send(m: unknown): Promise<void>; walks: Map<string, unknown>[]; db: { close(): void } | null; giveUp(e: unknown): void; retryAt: number; persistent: boolean };

test("a locked database is a cache miss on read and on write: the store is not given up and the next call works", async () => {
  fs.mkdirSync(at("bz/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const real = p.q.get;
    p.q.get = { get: () => { throw Object.assign(new Error("database is locked"), { errcode: 5 }); } };
    assert.equal((await s.scan("/bz")).dirs, 1); // every lookup misses: the walk reads from disk
    p.q.get = real;
    const send = p.send;
    p.send = () => Promise.reject(Object.assign(new Error("database is locked"), { busy: true }));
    assert.equal((await s.scan("/bz", undefined, true)).dirs, 1); // the commit is lost, not the store
    p.send = send;
    assert.equal(s.persistent, true);
    assert.equal((await s.scan("/bz", undefined, true)).dirs, 1);
    assert.equal((await s.scanRead("/bz")).read, 0); // stored by the last scan
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("with the database unusable the in-memory fallback holds at most 20 000 rows", async () => {
  const dir = at("fb");
  for (let i = 0; i < 30_000; i++) fs.mkdirSync(path.join(dir, `d${i}`), { recursive: true });
  const s = new SizeStore(path.join(tmp, "no-such-dir", "x", "sizes.db"), { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 });
  const p = s as unknown as Priv;
  // force the store unusable
  const quiet = console.error;
  console.error = () => undefined;
  try {
    if (s.persistent) p.giveUp(new Error("forced"));
    const r = await s.scan("/fb");
    assert.equal(r.dirs, 30_000);
    assert.equal(s.persistent, false);
    assert.ok(p.walks.reduce((n, w) => n + w.size, 0) <= 20_001);
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("after a real failure the store is opened again once the backoff has passed", async () => {
  fs.mkdirSync(at("ro/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.scan("/ro");
    p.giveUp(new Error("disk I/O error"));
    assert.equal(s.persistent, false);
    assert.equal((await s.scan("/ro")).dirs, 1); // uncached, before the backoff has passed
    assert.equal(s.persistent, false);
    p.retryAt = Date.now() - 1;
    assert.equal((await s.scan("/ro")).dirs, 1);
    assert.equal(s.persistent, true);
    assert.equal((await s.scanRead("/ro")).read, 0);
  } finally {
    console.error = quiet;
  }
  s.close();
});

// ---- review fixes: busy reads never give wrong totals ----

const failOnce = (obj: { all?: (...a: unknown[]) => unknown; get?: (...a: unknown[]) => unknown }, fn: "all" | "get", nth: number) => {
  const orig = obj[fn]!;
  let n = 0;
  obj[fn] = (...a: unknown[]) => {
    if (n++ === nth) throw Object.assign(new Error("database is locked"), { errcode: 5 });
    return orig.call(obj, ...a);
  };
  return () => (obj[fn] = orig);
};

test("a busy read of the stored children never gives a folder without its children", async () => {
  for (const [n, nth] of [[3, 0], [1300, 6]] as const) {
    const dir = at(`bk${n}`);
    for (let i = 0; i < n; i++) {
      fs.mkdirSync(path.join(dir, `k${String(i).padStart(4, "0")}`), { recursive: true });
      fs.writeFileSync(path.join(dir, `k${String(i).padStart(4, "0")}`, "f"), "x".repeat(10));
    }
    const s = mk();
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const first = await s.scan(`/bk${n}`);
      const restore = failOnce((s as unknown as { q: { kidPage: never } }).q.kidPage, "all", nth);
      const second = await s.scan(`/bk${n}`);
      restore();
      if (nth === 0) assert.equal(second.bytes, first.bytes); // the reuse check failed: the folder was read again
      else assert.ok(second.errors >= 1); // the walk ran short of children and says so
      // either way the next scan re-reads the stale subtree and is exact
      assert.deepEqual(await s.scan(`/bk${n}`), first);
    } finally {
      console.error = quiet;
    }
    s.close();
  }
});

test("a scan of a child alone does not leave a ghost: the parent scan purges rows it has no stored row for", async () => {
  fs.mkdirSync(at("gh/a/b"), { recursive: true });
  fs.mkdirSync(at("gh/a/c"));
  const s = mk();
  await s.scan("/gh/a/b");
  await s.scan("/gh/a/c");
  fs.rmSync(at("gh/a/c"), { recursive: true });
  await s.scan("/gh/a");
  assert.deepEqual((await rows(s, "/gh/a")).map((e) => e.path), ["/gh/a", "/gh/a/b"]);
  s.close();
});

test("a folder that reports size 0 is streamed with opendir, not trusted to be small", async () => {
  fs.mkdirSync(at("z0/a"), { recursive: true });
  const olst = fsp.lstat;
  const oopen = fsp.opendir;
  let opened = 0;
  (fsp as { lstat: unknown }).lstat = async (p: string, ...a: unknown[]) => {
    const st = (await (olst as (...x: unknown[]) => Promise<object>)(p, ...a)) as { isDirectory(): boolean };
    return String(p) === at("z0/a") ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 0 }) : st;
  };
  (fsp as { opendir: unknown }).opendir = (...a: unknown[]) => (opened++, (oopen as (...x: unknown[]) => unknown)(...a));
  const s = mk();
  try {
    assert.equal((await s.scan("/z0")).dirs, 1);
  } finally {
    (fsp as { lstat: unknown }).lstat = olst;
    (fsp as { opendir: unknown }).opendir = oopen;
  }
  assert.equal(opened, 1);
  s.close();
});

test("a busy read in applyChanged marks the folder stale instead of dropping the event", async () => {
  fs.mkdirSync(at("ac/a"), { recursive: true });
  const s = mk();
  await s.scan("/ac");
  const restore = failOnce((s as unknown as { q: { get: never } }).q.get, "get", 0);
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.applyChanged("/ac/a");
  } finally {
    restore();
    console.error = quiet;
  }
  await (s as unknown as { tail: Promise<void> }).tail;
  assert.equal((await s.scanRead("/ac")).read, 2); // stale: read again
  s.close();
});

test("reopening the store never lowers the walk stamp", async () => {
  fs.mkdirSync(at("st/a"), { recursive: true });
  const s = fileStore();
  const p = s as unknown as Priv & { stamp: number };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await s.scan("/st");
    p.stamp += 1_000_000; // as if an uncached walk handed out later stamps
    const before = p.stamp;
    p.giveUp(new Error("disk I/O error"));
    p.retryAt = Date.now() - 1;
    await s.scan("/st");
    assert.ok(p.stamp >= before);
  } finally {
    console.error = quiet;
  }
  s.close();
});

test("opening a store with many rows runs no statement that scans the sizes table", () => {
  const file = at("big.db");
  new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close(); // creates the schema
  const db = new DatabaseSync(file);
  const names = (db.prepare("PRAGMA table_info(sizes)").all() as { name: string }[]).map((c) => c.name);
  const ins = db.prepare(`INSERT INTO sizes (${names.join(",")}) VALUES (?${",0".repeat(names.length - 1)})`);
  db.exec("BEGIN");
  for (let i = 0; i < 200_000; i++) ins.run("/p" + i);
  db.exec("COMMIT");
  db.close();
  const seen: string[] = [];
  const orig = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    seen.push(sql);
    return orig.call(this, sql);
  } as typeof orig;
  try {
    new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close();
  } finally {
    DatabaseSync.prototype.prepare = orig;
  }
  assert.deepEqual(seen.filter((q) => /FROM sizes\b/i.test(q) && !/WHERE/i.test(q)), []);
});

function seedPending(file: string, n: number, due = 1, lastRun: number | null = null) {
  new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 100_000 }).close(); // creates the schema
  const db = new DatabaseSync(file);
  const ins = db.prepare("INSERT INTO pending (path, due_at, last_run) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) ins.run("/p" + i, due, lastRun);
  db.exec("COMMIT");
  db.close();
}
const spyPrepare = (seen: string[]) => {
  const orig = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    seen.push(sql);
    return orig.call(this, sql);
  } as typeof orig;
  return () => void (DatabaseSync.prototype.prepare = orig);
};

test("starting an agent and its watcher runs no statement over a large pending table except bounded reads", () => {
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  seedPending(path.join(idx, "sizes-t.db"), 200_000);
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_FANWATCH: "/nonexistent-helper" } as never));
    (app as unknown as { startWatcher: () => void }).startWatcher();
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /\bpending\b/i.test(q) && !/LIMIT/i.test(q)), []);
});

test("200k idle pending rows: start and first drain read them only by index, the prune is an indexed batch", async () => {
  const idx = fs.mkdtempSync(path.join(tmp, "idx-"));
  const file = path.join(idx, "sizes-t.db");
  seedPending(file, 200_000, Number.MAX_SAFE_INTEGER, Date.now());
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: idx, FILEDECK_FANWATCH: "/nonexistent-helper" } as never));
    (app as unknown as { startWatcher: () => void }).startWatcher();
    await sleep(800); // past the first drain tick
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /\bpending\b/i.test(q) && !/LIMIT|MIN\(due_at\)/i.test(q)), []);
  // the writer's statements cannot be spied on: check their plans instead
  const db = new DatabaseSync(file);
  const plan = (q: string, ...a: number[]) => (db.prepare("EXPLAIN QUERY PLAN " + q).all(...a) as { detail: string }[]).map((r) => r.detail).join(" | ");
  const prune = plan("DELETE FROM pending WHERE path IN (SELECT path FROM pending WHERE due_at = ? AND taker IS NULL AND (last_run < ? OR last_run > ?) LIMIT ?)", 1, 2, 3, 4);
  const recent = plan("SELECT path FROM pending WHERE due_at = ? AND last_run >= ? LIMIT ?", 1, 2, 3);
  db.close();
  assert.doesNotMatch(prune, /SCAN pending(?! USING)/);
  assert.match(recent, /USING (COVERING )?INDEX pending_idle_run/);
});

test("clearPending deletes in bounded batches", async () => {
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  await s.notePending(Array.from({ length: 25_000 }, (_, i) => ({ path: "/p" + i, dueAt: 1, modify: false })), 1000);
  const seen: string[] = [];
  const restore = spyPrepare(seen);
  try {
    await s.clearPending();
  } finally {
    restore();
  }
  assert.deepEqual(seen.filter((q) => /DELETE/i.test(q) && !/LIMIT/i.test(q)), []);
  assert.equal(seen.filter((q) => /DELETE/i.test(q)).length, 3);
  assert.equal(((s as unknown as { db: DatabaseSync }).db.prepare("SELECT COUNT(*) n FROM pending").get() as { n: number }).n, 0);
  s.close();
});

test("limiter runs at most n tasks at once and runs them all", async () => {
  const lim = limiter(3);
  let now = 0;
  let peak = 0;
  const out = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      lim(async () => {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 5));
        now--;
        return i;
      }),
    ),
  );
  assert.equal(peak, 3);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(lim.queued, 0);
});

test("a folder under the change watcher is trusted past the TTL until it is marked stale", async () => {
  const d = at("ttl-watched");
  fs.mkdirSync(path.join(d, "a/b"), { recursive: true });
  fs.writeFileSync(path.join(d, "a/b/f"), "x");
  const s = mk(1);
  await s.scan("/ttl-watched");
  await sleep(20);
  assert.ok((await countReaddir(() => s.scan("/ttl-watched"))) > 0, "unwatched: the TTL forces a re-read");
  s.covers = () => true;
  await sleep(20);
  assert.ok((await countReaddir(() => s.scan("/ttl-watched"))) > 0, "rows older than the watcher keep the TTL rule");
  s.watchedSince = () => 0;
  await s.scan("/ttl-watched");
  await sleep(20);
  assert.equal(await countReaddir(() => s.scan("/ttl-watched")), 0, "watched: no re-read");
  s.markStale("/ttl-watched");
  await sleep(20);
  assert.ok((await countReaddir(() => s.scan("/ttl-watched"))) > 0, "marked stale: re-read");
});

test("an interrupted rescan keeps the folders it read: the resumed one reads fewer and ends with the same totals", async () => {
  const d = at("resume");
  for (let i = 0; i < 12; i++) {
    fs.mkdirSync(path.join(d, `d${String(i).padStart(2, "0")}`), { recursive: true });
    fs.writeFileSync(path.join(d, `d${String(i).padStart(2, "0")}/f`), "x".repeat(i + 1));
  }
  const s = mk(60_000, 100_000, 1);
  const full = await s.scanRead("/resume", undefined, true);
  await sleep(5);
  const since = Date.now();
  // abort the rescan after 10 directory reads
  const ac = new AbortController();
  const orig = fsp.readdir;
  let n = 0;
  (fsp as { readdir: unknown }).readdir = (...a: unknown[]) => (++n === 8 && ac.abort(), (orig as (...x: unknown[]) => unknown)(...a));
  try {
    await assert.rejects(s.scanRead("/resume", { signal: ac.signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } }, since));
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
  }
  const resumed = await s.scanRead("/resume", undefined, since);
  assert.ok(resumed.read < full.read, `resumed read ${resumed.read} of ${full.read}`);
  assert.deepEqual(resumed.res, full.res);
});

test("a slow writer does not stop the walk while a chunk commits", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "slowwriter-"));
  for (let i = 0; i < 30; i++) {
    fs.mkdirSync(path.join(root, `d${i}`));
    for (let j = 0; j < 3; j++) fs.writeFileSync(path.join(root, `d${i}`, `f${j}`), "x");
  }
  const st = new SizeStore(path.join(root, "..", `slow-${path.basename(root)}.db`), { root: tmp, ttlMs: 60_000, maxEntries: 100_000, commitChunk: 5 });
  const ctl = { signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const orig = (st as unknown as { send(m: unknown): Promise<void> }).send.bind(st);
  let first: { before: number; after: number } | undefined;
  (st as unknown as { send(m: unknown): Promise<void> }).send = async (m) => {
    const mine = !first && (first = { before: ctl.progress.entries, after: 0 });
    await sleep(500);
    if (mine) first!.after = ctl.progress.entries;
    return orig(m);
  };
  try {
    const r = await st.scan("/" + path.basename(root), ctl, true);
    assert.equal(r.dirs, 30);
    assert.ok(first!.after > first!.before, `entries stood at ${first!.before} during the first commit`);
  } finally {
    st.close();
  }
});

test("a joined du request does not wait for a later walk that holds the lock", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "dujoin-"));
  fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "big/sub/f"), "x");
  const orig = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await sleep(600);
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "150" } as never));
    const post = (p: string, fresh = false) => app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p, fresh }) });
    await post("/big/sub");
    await post("/big", true); // queued behind the first, holds the lock next
    const t = Date.now();
    const r = await app.request("/api/du?path=/big/sub&depth=0");
    assert.ok(Date.now() - t < 450, "GET du waited for the lock");
    assert.ok(r.status === 200 || r.status === 202);
  } finally {
    (fsp as { readdir: unknown }).readdir = orig;
  }
});

test("a rescan does not join a cached size job", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "rescan-join-"));
  fs.mkdirSync(path.join(root, "d"), { recursive: true });
  const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never));
  const post = async (fresh: boolean) => ((await (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d", fresh }) })).json()) as { id: string }).id;
  const a = await post(false);
  assert.equal(await post(false), a, "a cached request joins");
  const b = await post(true);
  assert.notEqual(b, a, "a rescan queues its own job");
  assert.equal(await post(true), b, "a second rescan joins the rescan");
});

test("a slow store read does not block the event loop", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "slow-read-"));
  fs.mkdirSync(path.join(root, "d"), { recursive: true });
  fs.writeFileSync(path.join(root, "d", "f"), "x");
  const file = path.join(root, "sizes.db");
  const o = { root, ttlMs: 60_000, maxEntries: 1000 };
  const a = new SizeStore(file, o);
  await a.scan("/d");
  a.close();
  const s = new SizeStore(file, { ...o, readDelayMs: 500 });
  let last = performance.now();
  let lag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
  }, 10);
  try {
    const t0 = performance.now();
    const t = await s.tree("/d", 0, false);
    assert.ok(performance.now() - t0 >= 450, "the read took its delay");
    assert.equal(t.entries.length, 1);
    assert.ok(lag < 50, `event loop lagged ${Math.round(lag)} ms`);
  } finally {
    clearInterval(timer);
    s.close();
  }
});

test("tree of a folder with 300k children is cut at the budget and the read worker survives", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "oom-"));
  const file = path.join(root, "sizes.db");
  const o = { root, ttlMs: 1, maxEntries: 1000 };
  await new SizeStore(file, o).close();
  const db = new DatabaseSync(file);
  const cols = (db.prepare("PRAGMA table_info(sizes)").all() as { name: string }[]).map((c) => c.name);
  const ins = db.prepare(`INSERT INTO sizes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  const row = (p: string, par: string) => cols.map((c) => (c === "path" ? p : c === "parent" ? par : 1));
  db.exec("BEGIN");
  ins.run(...row("/p", "/"));
  for (let i = 0; i < 300_000; i++) ins.run(...row(`/p/some-longish-folder-name-${i}`, "/p"));
  db.exec("COMMIT");
  db.close();
  const s = new SizeStore(file, o);
  const quiet = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const t = await s.tree("/p", 1, false);
    assert.equal(t.entries.length, 1000);
    assert.equal(t.truncated, true);
    assert.equal((await s.tree("/p", 0, false)).entries.length, 1, "the store is still up");
    assert.deepEqual(logged, []);
  } finally {
    console.error = quiet;
    await s.close();
  }
});

test("a reused rescan and a tree take about one read round trip per folder, or fewer", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "trips-"));
  for (let i = 0; i < 40; i++) for (const j of ["a", "b"]) fs.mkdirSync(path.join(root, `d${i}`, j), { recursive: true });
  const s = new SizeStore(path.join(root, "..", `trips-${path.basename(root)}.db`), { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  const v = "/" + path.basename(root);
  let reads = 0;
  const post = (s as unknown as { post(m: { op: string }, r: boolean): unknown }).post.bind(s);
  (s as unknown as { post(m: { op: string }, r: boolean): unknown }).post = (m, r) => (m.op === "read" && reads++, post(m, r));
  try {
    await s.scan(v);
    reads = 0;
    const r = await s.scan(v);
    assert.equal(r.dirs, 120);
    assert.ok(reads <= 121 * 1.5, `${reads} reads for 121 folders`);
    reads = 0;
    assert.equal((await s.tree(v, 3, false)).entries.length, 121);
    assert.ok(reads <= 4, `${reads} reads for a tree of 3 levels`);
  } finally {
    await s.close();
  }
});

test("the pending table and a reopen are served by the workers, never by the main connection", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "pend-"));
  fs.mkdirSync(path.join(root, "d"));
  const s = new SizeStore(path.join(root, "sizes.db"), { root, ttlMs: 60_000, maxEntries: 1000 });
  const p = s as unknown as { db: unknown; retryAt: number };
  const real = p.db as { close(): void };
  const boom = () => {
    throw new Error("main thread touched the database");
  };
  p.db = { prepare: boom, exec: boom, close: () => undefined };
  try {
    const t = { modifyMs: 10, settleMs: 1 };
    assert.equal(await s.notePending([{ path: "/d", dueAt: Date.now() - 1, modify: false }], 10), true);
    assert.deepEqual(await s.takeDue(Date.now(), 10, t), ["/d"]);
    assert.deepEqual(await s.recentRuns(Date.now(), 60_000, 10), ["/d"]);
    await s.clearPending();
    assert.deepEqual(await s.recentRuns(Date.now(), 60_000, 10), []);
    // after a failure the store reopens through the writer thread
    p.db = null;
    p.retryAt = 1;
    assert.equal((await s.scan("/d")).dirs, 0);
    assert.ok(p.db, "reopened");
    assert.equal((await s.tree("/d", 0, false)).entries.length, 1);
  } finally {
    real.close();
    await s.close();
  }
});

test("after close(), a read starts no worker and logs nothing; a read pending at close() is not a fault", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "closed-"));
  fs.mkdirSync(path.join(root, "d"));
  const s = new SizeStore(path.join(root, "sizes.db"), { root, ttlMs: 60_000, maxEntries: 1000, readDelayMs: 200 });
  await s.scan("/d");
  const logged: unknown[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const pending = s.tree("/d", 0, false);
    await sleep(50);
    await s.close();
    await pending;
    const w = (s as unknown as { writer?: unknown; reader?: unknown });
    assert.equal((await s.tree("/d", 0, false)).entries.length, 0);
    assert.equal(w.writer ?? w.reader, undefined, "no worker after close");
    assert.deepEqual(logged, []);
  } finally {
    console.error = quiet;
  }
});
