import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as ops from "../src/fsops.ts";
import { uploadChunk } from "../src/chunked.ts";

let root: string;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mcn-")));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
const at = (...p: string[]) => path.join(root, ...p);
const OLD = new Date("2001-02-03T04:05:06Z");

function forceExdevOnce() {
  const real = fsp.rename.bind(fsp);
  let first = true;
  return mock.method(fsp, "rename", async (from: string, to: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    }
    return real(from, to);
  });
}

test("a cross-device move keeps the times of files and folders and asks for the owner to be kept", async () => {
  fs.mkdirSync(at("m1/tree/sub"), { recursive: true });
  fs.mkdirSync(at("m1/dst"));
  fs.writeFileSync(at("m1/tree/sub/b.txt"), "b");
  for (const p of ["m1/tree/sub/b.txt", "m1/tree/sub", "m1/tree"]) fs.utimesSync(at(p), OLD, OLD);
  const src = fs.lstatSync(at("m1/tree/sub/b.txt"));
  const owners: string[] = [];
  const realChown = fsp.lchown.bind(fsp);
  const c = mock.method(fsp, "lchown", async (p: string, u: number, g: number) => {
    owners.push(`${path.basename(p)}:${u}:${g}`);
    return realChown(p, u, g);
  });
  const m = forceExdevOnce();
  try {
    await ops.rename(root, "/m1/tree", "/m1/dst/tree");
  } finally {
    m.mock.restore();
    c.mock.restore();
  }
  for (const p of ["m1/dst/tree/sub/b.txt", "m1/dst/tree/sub", "m1/dst/tree"]) assert.equal(fs.lstatSync(at(p)).mtimeMs, OLD.getTime(), p);
  assert.ok(owners.includes(`b.txt:${src.uid}:${src.gid}`) && owners.some((o) => o.startsWith("sub:")) && owners.some((o) => o.startsWith(".tree.filedeck-part-")), owners.join(","));
  assert.equal(fs.existsSync(at("m1/tree")), false);
});

test("a failed copy never leaves anything under the final name", async () => {
  fs.mkdirSync(at("c1/dst"), { recursive: true });
  fs.writeFileSync(at("c1/a.bin"), "payload");
  const real = fsp.cp.bind(fsp);
  const c = mock.method(fsp, "cp", async (from: string, to: string, o: never) => {
    await real(from, to, o);
    throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
  });
  try {
    await assert.rejects(ops.copy(root, "/c1/a.bin", "/c1/dst"));
  } finally {
    c.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(at("c1/dst")), []);
  assert.equal(await ops.copy(root, "/c1/a.bin", "/c1/dst"), "/c1/dst/a.bin");
  assert.equal(await ops.copy(root, "/c1/a.bin", "/c1/dst"), "/c1/dst/a (copy).bin");
  assert.deepEqual(fs.readdirSync(at("c1/dst")).sort(), ["a (copy).bin", "a.bin"]);
});

test("names near the file-name limit work for upload, edit, copy, move and chunked upload", async () => {
  fs.mkdirSync(at("n1/dst"), { recursive: true });
  const name = "x".repeat(250) + ".txt"; // 254 bytes
  const wide = "é".repeat(120) + ".md"; // 243 bytes, multi-byte
  for (const n of [name, wide]) {
    const up = await ops.upload(root, "/n1", n, Readable.from([Buffer.from("one")]), false, 100);
    assert.equal(up.size, 3);
    await ops.writeText(root, `/n1/${n}`, Buffer.from("two"), (await ops.readText(root, `/n1/${n}`)).etag);
    const first = await ops.copy(root, `/n1/${n}`, "/n1/dst");
    const second = await ops.copy(root, `/n1/${n}`, "/n1/dst"); // " (copy)" would push the name over the limit
    assert.notEqual(first, second);
    for (const f of fs.readdirSync(at("n1/dst"))) assert.ok(Buffer.byteLength(f) <= 255, f);
    await ops.copy(root, `/n1/${n}`, "/n1/dst", { overwrite: true });
    const m = forceExdevOnce();
    try {
      await ops.rename(root, `/n1/${n}`, `/n1/moved-${n.slice(0, 5)}`.slice(0, 20));
    } finally {
      m.mock.restore();
    }
    fs.rmSync(at("n1/dst"), { recursive: true, force: true });
    fs.mkdirSync(at("n1/dst"));
  }
  const r = await uploadChunk(root, "/n1", name, "a".repeat(64), 0, Readable.from([Buffer.from("abc")]), { total: 3, overwrite: true, maxBytes: 100 });
  assert.equal(r.done, true);
  assert.equal(fs.readFileSync(at("n1", name), "utf8"), "abc");
});

test("changing only the case of a name is a rename where the volume folds case, a clash where it does not", async () => {
  fs.mkdirSync(at("k1"), { recursive: true });
  fs.writeFileSync(at("k1/Report.txt"), "r");
  // Emulate a case-insensitive volume: a lookup that misses retries with any spelling that differs only in case.
  const real = fsp.lstat.bind(fsp);
  const l = mock.method(fsp, "lstat", async (p: string, o?: never) => {
    try {
      return await real(p, o);
    } catch (e) {
      const dir = fs.readdirSync(path.dirname(p)).find((n) => n.toLowerCase() === path.basename(p).toLowerCase());
      if (!dir) throw e;
      return real(path.join(path.dirname(p), dir), o);
    }
  });
  try {
    assert.equal(await ops.rename(root, "/k1/Report.txt", "/k1/report.txt"), "/k1/report.txt");
  } finally {
    l.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(at("k1")), ["report.txt"]);
  // two real, different names in a case-sensitive folder still clash
  fs.writeFileSync(at("k1/Other.txt"), "o");
  await assert.rejects(ops.rename(root, "/k1/report.txt", "/k1/Other.txt"), /destination exists/);
  // a second hard link spelled differently is another entry, not the same name: refused and left as it was
  fs.linkSync(at("k1/report.txt"), at("k1/REPORT.txt"));
  await assert.rejects(ops.rename(root, "/k1/report.txt", "/k1/REPORT.txt"), /destination exists/);
  assert.deepEqual(fs.readdirSync(at("k1")).sort(), ["Other.txt", "REPORT.txt", "report.txt"]);
});
