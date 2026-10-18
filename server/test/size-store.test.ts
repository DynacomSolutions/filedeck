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
const mk = (ttlMs = 60_000, maxEntries = 100_000) => new SizeStore(":memory:", { root: tmp, ttlMs, maxEntries });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sizes-")));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
  assert.equal(await s.isFresh("/a"), true);
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
  assert.equal(await s.isFresh("/a"), false);
  assert.equal(await countReaddir(() => s.scan("/a")), 3);
  s.close();
});

test("scan: a truncated scan is reported and never stored", async () => {
  const s = mk(60_000, 3);
  const r = await s.scan("/a");
  assert.equal(r.truncated, true);
  assert.equal((await s.tree("/a", 64, false)).entries.length, 0);
  assert.equal(await s.isFresh("/a"), false);
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

  // a capped scan answers truncated and stores nothing
  const small = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_WALK_MAX_ENTRIES: "3" } as never));
  const t = (await (await small.request("/api/du?path=/a")).json()) as Du;
  assert.equal(t.truncated, true);
  assert.equal(t.cached, false);
  assert.equal(((await (await small.request("/api/du?path=/a")).json()) as Du).cached, false);
});
