import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createAgent, SizeStore, tmp, at, sleep, mk, countReaddir, rows, agrees, makeTreeA } from "./size-store-support.ts";

before(() => makeTreeA());

test("scan: totals, links, trash store, and an unchanged tree is not read again", async () => {
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
    const read: string[] = [];
    assert.equal(await countReaddir(() => s.scan("/a"), read), 3, `folders read: ${read.join(", ")}`); // nothing is reused
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
