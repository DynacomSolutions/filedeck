import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { limiter } from "../src/size-store.ts";
import { loadConfig } from "../src/config.ts";
import { createAgent, SizeStore, tmp, at, sleep, mk, countReaddir, rows } from "./size-store-support.ts";

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
  let letBigGo!: () => void;
  const bigGate = new Promise<void>((r) => (letBigGo = r)); // the walk of "big" holds the lock until the answer has arrived
  (fsp as { readdir: unknown }).readdir = async (p: string, ...a: unknown[]) => {
    if (String(p) === path.join(root, "big")) await bigGate;
    return (orig as (...x: unknown[]) => Promise<unknown>)(p, ...a);
  };
  try {
    const app = createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_DU_WAIT_MS: "150" } as never));
    const post = (p: string, fresh = false) => app.request("/api/jobs/size", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p, fresh }) });
    await post("/big/sub");
    await post("/big", true); // queued behind the first, holds the lock next
    let guard!: NodeJS.Timeout;
    const stuck = new Promise<never>((_, rej) => (guard = setTimeout(() => rej(new Error("GET du waited for the lock")), 30_000)));
    // the answer must arrive while the walk that holds the lock is still blocked
    const r = await Promise.race([Promise.resolve(app.request("/api/du?path=/big/sub&depth=0")), stuck]).finally(() => clearTimeout(guard));
    assert.ok(r.status === 200 || r.status === 202);
  } finally {
    letBigGo();
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
  const s = new SizeStore(file, { ...o, readDelayMs: 2000 });
  // The read runs on a worker: the call returns at once and the event loop turns while the read is still pending. A read on the main thread would be finished (and the
  // promise settled) by the time the call returned. Nothing here depends on how fast the host is; counting timer ticks would, as a starved process runs its timers late.
  let settled = false;
  const read = s.tree("/d", 0, false).finally(() => (settled = true));
  try {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "the read is still pending after the event loop has turned: it is not done on the main thread");
    const t = await read;
    assert.equal(t.entries.length, 1);
  } finally {
    await read.catch(() => undefined);
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
    // (a "slow read" line is only a timing note and appears on a loaded machine; any other line is a worker fault)
    assert.deepEqual(logged.filter((l) => !/^\{"slow":"size-read-[a-z]+","ms":\d+,"path":"[^"]*"\}$/.test(String((l as unknown[])[0]))), []);
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
    const t = { modifyMs: 10_000, settleMs: 1 }; // (the first write waits for the writer lease: a short modifyMs would make the backlog look too old)
    assert.equal(await s.notePending([{ path: "/d", dueAt: Date.now() - 1, modify: false }], 10_000), true);
    assert.deepEqual(await s.takeDue(Date.now(), 10, t), ["/d"]);
    await s.noteRan([{ path: "/d", endedAt: Date.now(), hold: false }], 10_000);
    await s.clearPending();
    assert.deepEqual(await s.takeDue(Date.now(), 10, t), []);
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
    // (agents of earlier tests are still running their watchers: only this store's own lines count)
    assert.deepEqual(logged.filter((l) => !String((l as unknown[])[0]).startsWith("fanotify watcher")), []);
  } finally {
    console.error = quiet;
  }
});
