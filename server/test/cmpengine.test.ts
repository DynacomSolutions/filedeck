import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexCache } from "../src/index-cache.ts";
import { localReader } from "../src/diff-routes.ts";
import { CompareSession, type DirSource } from "../src/cmp-engine.ts";
import { DEFAULT_OPTIONS } from "../src/folderdiff.ts";
import { localSource } from "../src/folderdiff.ts";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-cmp-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (rel: string, data: string) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("index: a watched listing is served from SQLite until the directory changes; hashes survive a relist", async () => {
  write("ix/a.txt", "a");
  write("ix/b.txt", "bb");
  const db = path.join(tmp, "cache", "index.db");
  const ix = new IndexCache(db, localReader());
  const dir = path.join(tmp, "ix");
  const first = await ix.list(dir);
  assert.equal(first.cached, false);
  assert.deepEqual(first.entries.map((e) => e.n).sort(), ["a.txt", "b.txt"]);
  const second = await ix.list(dir);
  assert.equal(second.cached, true);
  const st = fs.statSync(path.join(dir, "a.txt"));
  let computed = 0;
  const h1 = await ix.hash(path.join(dir, "a.txt"), { size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino }, async () => (computed++, "h-a"));
  const h2 = await ix.hash(path.join(dir, "a.txt"), { size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino }, async () => (computed++, "other"));
  assert.equal(h1.cached, false);
  assert.equal(h2.cached, true);
  assert.equal(h2.sha256, "h-a");
  assert.equal(computed, 1);
  // A change in the directory marks it dirty: the next listing is read again, and appears in the change feed.
  write("ix/c.txt", "ccc");
  for (let i = 0; i < 50 && ix.changes(0).dirs.length === 0; i++) await wait(20);
  assert.deepEqual(ix.changes(0).dirs, [dir]);
  const third = await ix.list(dir);
  assert.equal(third.cached, false);
  assert.deepEqual(third.entries.map((e) => e.n).sort(), ["a.txt", "b.txt", "c.txt"]);
  // a.txt did not change, so its hash is still there; a changed size invalidates it
  assert.equal((await ix.hash(path.join(dir, "a.txt"), { size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino }, async () => "x")).cached, true);
  assert.equal((await ix.hash(path.join(dir, "a.txt"), { size: st.size + 1, mtime: Math.floor(st.mtimeMs), ino: st.ino }, async () => "x")).cached, false);
  ix.close();
  // After a restart nothing is watched, so the listing is revalidated once, but hashes persist on disk.
  const again = new IndexCache(db, localReader());
  assert.equal((await again.list(dir)).cached, false);
  const st2 = fs.statSync(path.join(dir, "b.txt"));
  assert.equal((await again.hash(path.join(dir, "b.txt"), { size: st2.size, mtime: Math.floor(st2.mtimeMs), ino: st2.ino }, async () => "hb")).cached, false);
  assert.equal((await again.hash(path.join(dir, "b.txt"), { size: st2.size, mtime: Math.floor(st2.mtimeMs), ino: st2.ino }, async () => "zz")).sha256, "hb");
  again.close();
});

test("index: the watch budget is bounded (least recently used directories lose their watch)", async () => {
  for (let i = 0; i < 4; i++) write(`wb/d${i}/f`, "x");
  const ix = new IndexCache(":memory:", localReader(), { maxWatches: 2 });
  for (let i = 0; i < 4; i++) await ix.list(path.join(tmp, `wb/d${i}`));
  assert.equal(ix.stats.watches, 2);
  assert.equal((await ix.list(path.join(tmp, "wb/d0"))).cached, false); // evicted: revalidated
  assert.equal((await ix.list(path.join(tmp, "wb/d0"))).cached, true);
  ix.close();
});

test("agent: lsdir lists one folder (cached on repeat) and hash reports a cache hit the second time", async () => {
  write("ag/x/one.txt", "1");
  write("ag/two.txt", "22");
  const agent = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_INDEX_DIR: path.join(tmp, "agent-index") } as never));
  const a = (await (await agent.request("/api/fs/lsdir?path=/ag")).json()) as { cached: boolean; entries: { n: string; t: string }[] };
  assert.equal(a.cached, false);
  assert.deepEqual(a.entries.map((e) => `${e.t}:${e.n}`).sort(), ["dir:x", "file:two.txt"]);
  const b = (await (await agent.request("/api/fs/lsdir?path=/ag")).json()) as { cached: boolean };
  assert.equal(b.cached, true);
  assert.equal((await agent.request("/api/fs/lsdir?path=/../etc")).status, 400);
  assert.equal((await agent.request("/api/fs/lsdir?path=/ag/two.txt")).status, 400);
  const h1 = (await (await agent.request("/api/fs/hash?path=/ag/two.txt")).json()) as { cached: boolean; sha256: string };
  const h2 = (await (await agent.request("/api/fs/hash?path=/ag/two.txt")).json()) as { cached: boolean; sha256: string };
  assert.equal(h1.cached, false);
  assert.equal(h2.cached, true);
  assert.equal(h1.sha256, h2.sha256);
  assert.ok(fs.existsSync(path.join(tmp, "agent-index", "index-t.db")));
  await (agent as unknown as { close: () => Promise<void> }).close();
});

test("session: folders in focus are listed first, rows are pending until final, then everything resolves", async () => {
  for (const side of ["L", "R"]) {
    for (let i = 0; i < 20; i++) write(`ses/${side}/bulk${i}/f.txt`, "same");
    write(`ses/${side}/zz-focus/deep/f.txt`, side === "L" ? "aaaa" : "bbbb");
  }
  const order: string[] = [];
  const spy = (s: DirSource, tag: string): DirSource => ({
    list: (rel, sig) => (tag === "L" && order.push(rel), s.list(rel, sig)),
    hash: (rel, sig) => s.hash(rel, sig),
  });
  const L = spy(localSource(path.join(tmp, "ses/L"), "/"), "L");
  const R = spy(localSource(path.join(tmp, "ses/R"), "/"), "R");
  const sess = new CompareSession(L, R, { ...DEFAULT_OPTIONS, mode: "content", dirConcurrency: 1 }, path.join(tmp, "spill", "s.db"));
  const ac = new AbortController();
  // Before running: the root folder exists but is not listed yet.
  assert.equal(sess.folder("")?.listed, false);
  sess.setFocus(["zz-focus", "zz-focus/deep"]);
  await sess.run(ac.signal);
  assert.equal(order[0], "");
  // zz-focus sorts last alphabetically and breadth first, but focus pulled it right after the root.
  assert.equal(order[1], "zz-focus");
  assert.equal(order[2], "zz-focus/deep");
  const root = sess.folder("")!;
  assert.equal(root.listed, true);
  assert.equal(root.status, "different");
  const zz = root.rows.find((r) => r.p === "zz-focus")!;
  assert.equal(zz.status, "different");
  assert.equal(zz.mask! & 2, 2);
  assert.equal(root.rows.find((r) => r.p === "bulk3")!.status, "identical");
  assert.deepEqual([...sess.withStatus(["different"])], ["zz-focus", "zz-focus/deep", "zz-focus/deep/f.txt"]);
  assert.deepEqual([...sess.subtree(["zz-focus"])].map((r) => r.p), ["zz-focus", "zz-focus/deep", "zz-focus/deep/f.txt"]);
  assert.equal(sess.stats.dirsScanned, 23);
  assert.equal(sess.counts().files.identical, 20);
  sess.close();
  assert.ok(!fs.existsSync(path.join(tmp, "spill", "s.db")));
});

test("session: rows stay pending while their subtree is still open", async () => {
  write("pend/L/a/b/f.txt", "1");
  write("pend/R/a/b/f.txt", "1");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = localSource(path.join(tmp, "pend/L"), "/");
  const L: DirSource = { list: async (rel, s) => (rel === "a/b" ? (await gate, base.list(rel, s)) : base.list(rel, s)), hash: base.hash };
  const sess = new CompareSession(L, localSource(path.join(tmp, "pend/R"), "/"), { ...DEFAULT_OPTIONS, mode: "name" });
  const done = sess.run(new AbortController().signal);
  for (let i = 0; i < 100 && !sess.folder("a")?.listed; i++) await wait(5);
  assert.equal(sess.folder("")!.rows[0]!.status, "pending");
  assert.equal(sess.folder("a")!.rows[0]!.status, "pending");
  release();
  await done;
  assert.equal(sess.folder("")!.rows[0]!.status, "identical");
  sess.close();
});
