import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathError, resolveRead, resolveWrite, virtualJoin, assertNotTrash } from "../src/paths.ts";
import * as ops from "../src/fsops.ts";

let tmp: string;
let root: string;
let outside: string;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-")));
  root = path.join(tmp, "root");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(root, "a/b"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret"), "top secret");
  fs.writeFileSync(path.join(root, "a/file.txt"), "hello world");
  fs.symlinkSync(outside, path.join(root, "abs-out")); // absolute link to a dir outside
  fs.symlinkSync("../../../outside", path.join(root, "a/b/rel-out")); // climbs above root
  fs.symlinkSync("../../../../../outside", path.join(root, "a/b/deep-out"));
  fs.symlinkSync("file.txt", path.join(root, "a/inner"));
  fs.symlinkSync("loop2", path.join(root, "loop1"));
  fs.symlinkSync("loop1", path.join(root, "loop2"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const inRoot = (p: string) => p === root || p.startsWith(root + path.sep);

test("plain paths resolve under root", () => {
  assert.equal(resolveRead(root, "/a/file.txt").real, path.join(root, "a/file.txt"));
  assert.equal(resolveRead(root, "a//./file.txt").virtual, "/a/file.txt");
  assert.equal(resolveRead(root, "/").real, root);
  assert.equal(resolveRead(root, "").real, root);
});

test("'..' segments are rejected, not clamped", () => {
  for (const p of ["/..", "/a/../../etc/passwd", "../x", "/a/b/../..", "/a/.."]) {
    assert.throws(() => resolveRead(root, p), PathError, p);
    assert.throws(() => resolveWrite(root, p), PathError, p);
  }
});

test("NUL bytes and oversized paths are rejected", () => {
  assert.throws(() => resolveRead(root, "/a\0b"), PathError);
  assert.throws(() => resolveRead(root, "/" + "a".repeat(5000)), PathError);
});

test("absolute symlink to the outside is re-based under root (cannot read outside)", () => {
  const r = resolveRead(root, "/abs-out/secret");
  assert.ok(inRoot(r.real), r.real);
  assert.equal(r.real, path.join(root, outside, "secret"));
  assert.equal(fs.existsSync(r.real), false);
});

test("relative symlink climbing above root is clamped for read and refused for write", () => {
  for (const link of ["/a/b/rel-out/secret", "/a/b/deep-out/secret"]) {
    const r = resolveRead(root, link);
    assert.ok(inRoot(r.real), r.real);
    assert.equal(r.escaped, true);
    assert.equal(fs.existsSync(r.real) && fs.readFileSync(r.real, "utf8") === "top secret", false);
    assert.throws(() => resolveWrite(root, link), /escapes root/);
  }
});

test("write resolution does not follow the final symlink", () => {
  const r = resolveWrite(root, "/abs-out");
  assert.equal(r.real, path.join(root, "abs-out"));
  const rel = resolveWrite(root, "/a/inner");
  assert.equal(rel.real, path.join(root, "a/inner"));
});

test("symlink loops are rejected", () => {
  assert.throws(() => resolveRead(root, "/loop1/x"), /too many symbolic links/);
});

test("virtualJoin rejects separators and dot names", () => {
  for (const n of ["", ".", "..", "a/b", "a\0"]) assert.throws(() => virtualJoin("/a", n), PathError);
  assert.equal(virtualJoin("/", "x"), "/x");
});

test("trash store is protected from direct mutation", () => {
  assert.throws(() => assertNotTrash("/x/.filedeck-trash/id/data"), PathError);
});

test("ops: write through an escaping symlink is refused and leaves outside untouched", async () => {
  await assert.rejects(ops.mkdir(root, "/a/b/rel-out/pwn"), /escapes root/);
  await assert.rejects(ops.permanentDelete(root, "/a/b/rel-out/secret"), /escapes root/);
  await assert.rejects(ops.rename(root, "/a/file.txt", "/a/b/rel-out/stolen"), /escapes root/);
  await assert.rejects(ops.upload(root, "/a/b/rel-out", "x", (await import("node:stream")).Readable.from([Buffer.from("x")]), false, 10), /.*/);
  assert.deepEqual(fs.readdirSync(outside), ["secret"]);
});

test("ops: upload name traversal is rejected", async () => {
  const { Readable } = await import("node:stream");
  await assert.rejects(ops.upload(root, "/a", "../evil", Readable.from([Buffer.from("x")]), false, 10), PathError);
  await assert.rejects(ops.upload(root, "/a", "x/y", Readable.from([Buffer.from("x")]), false, 10), PathError);
  assert.equal(fs.existsSync(path.join(root, "evil")), false);
});

test("ops: deleting a symlink removes the link, not the target", async () => {
  fs.symlinkSync(outside, path.join(root, "tmp-link"));
  await ops.permanentDelete(root, "/tmp-link");
  assert.equal(fs.existsSync(path.join(root, "tmp-link")), false);
  assert.ok(fs.existsSync(path.join(outside, "secret")));
});

test("ops: trash moves to per-volume store with metadata, mkdir/list/copy/move work", async () => {
  await ops.mkdir(root, "/work");
  const { Readable } = await import("node:stream");
  await ops.upload(root, "/work", "n.txt", Readable.from([Buffer.from("data")]), false, 100);
  await assert.rejects(ops.upload(root, "/work", "n.txt", Readable.from([Buffer.from("d")]), false, 100), /exists/);
  const c = await ops.copy(root, "/work/n.txt", "/work");
  assert.equal(c, "/work/n (copy).txt");
  await ops.mkdir(root, "/dest");
  await ops.move(root, "/work/n.txt", "/dest");
  const l = await ops.list(root, "/dest", false);
  assert.deepEqual(l.entries.map((e) => e.name), ["n.txt"]);
  const meta = await ops.trash(root, "/dest/n.txt");
  assert.equal(meta.originalPath, "/dest/n.txt");
  assert.equal(fs.existsSync(path.join(root, "dest/n.txt")), false);
  const stored = fs.readdirSync(path.join(root, ".filedeck-trash", meta.id)).sort();
  assert.deepEqual(stored, ["data", "meta.json"]);
  assert.equal((await ops.list(root, "/", true)).entries.some((e) => e.name === ".filedeck-trash"), false);
  await assert.rejects(ops.mkdir(root, `/.filedeck-trash/x`), PathError);
});

test("parseRange", () => {
  assert.deepEqual(ops.parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(ops.parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(ops.parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(ops.parseRange("bytes=0-999", 100), { start: 0, end: 99 });
  assert.equal(ops.parseRange("bytes=100-", 100), "invalid");
  assert.equal(ops.parseRange("nonsense", 100), "invalid");
  assert.equal(ops.parseRange(undefined, 100), null);
});
