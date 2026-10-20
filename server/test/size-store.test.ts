import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { SizeStore } from "../src/size-store.ts";

let tmp: string;
const at = (p: string) => path.join(tmp, p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = (ttlMs = 60_000, maxEntries = 100_000, commitChunk?: number) => new SizeStore(":memory:", { root: tmp, ttlMs, maxEntries, commitChunk });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sizes-")));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** readdir calls made while `fn` runs */
async function countReaddir(fn: () => Promise<unknown>): Promise<number> {
  const orig = fsp.opendir;
  let n = 0;
  (fsp as { opendir: unknown }).opendir = (...a: unknown[]) => (n++, (orig as (...x: unknown[]) => unknown)(...a));
  try {
    await fn();
  } finally {
    (fsp as { opendir: unknown }).opendir = orig;
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
    let j = (await (await app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/d1" }) })).json()) as { id: string; state: string; result?: { bytes: number } };
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
  (await s.lock("/"))(); // the trim runs after the scan ended; wait for it
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
  for (const d of ["big/sub", "q1", "q2", "p/x", "p/w", "p/z"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const slow = new Set([path.join(root, "big"), path.join(root, "q1"), path.join(root, "q2")]);
  const orig = fsp.opendir;
  (fsp as { opendir: unknown }).opendir = async (p: string, ...a: unknown[]) => {
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
    const doomed = await post("/big/sub");
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
    (fsp as { opendir: unknown }).opendir = orig;
  }
});

// ---- round 4 ----

test("a detached du scan running past a minute is still joined by the repeat request, which then gets the result", async (t) => {
  const root = fs.mkdtempSync(path.join(tmp, "det-"));
  fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const orig = fsp.opendir;
  (fsp as { opendir: unknown }).opendir = async (p: string, ...a: unknown[]) => {
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
    (fsp as { opendir: unknown }).opendir = orig;
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
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000, commitChunk: 5 });
  const before = fds();
  const ac = new AbortController();
  const ctl = { signal: ac.signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } };
  const timer = setInterval(() => ctl.progress.entries > 100 && ac.abort(), 1);
  await assert.rejects(s.scan("/abort", ctl), /canceled/);
  clearInterval(timer);
  assert.equal(fds(), before);
  // rows written before the abort are marked stale, so the next scan re-reads them
  const left = (s as unknown as { db: { prepare(q: string): { get(): { n: number; m: number } } } }).db.prepare("SELECT COUNT(*) AS n, MAX(scanned_at) AS m FROM sizes").get();
  assert.ok(left.n > 0 && left.m === 0);
  s.close();
});

test("walk keeps one frame per level: 200k empty subfolders in one folder", async () => {
  const dir = at("many");
  fs.mkdirSync(dir);
  for (let i = 0; i < 200_000; i++) fs.mkdirSync(path.join(dir, `d${i}`));
  const s = mk(60_000, 1_000_000);
  const r = await s.scan("/many");
  assert.equal(r.dirs, 200_000);
  assert.equal(s.lastWalkFrames, 2); // the folder and one child at a time
  s.close();
});
