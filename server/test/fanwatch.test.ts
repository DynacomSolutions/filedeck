import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FanWatch, mapPath, unescapeLine, type HelperProc } from "../src/fanwatch.ts";
import { SizeStore } from "../src/size-store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mapPath: strips the root, refuses outside paths and trash stores", () => {
  assert.equal(mapPath("/host", "/host/data/a"), "/data/a");
  assert.equal(mapPath("/host", "/host"), "/");
  assert.equal(mapPath("/host", "/hostile/a"), null);
  assert.equal(mapPath("/host", "/elsewhere"), null);
  assert.equal(mapPath("/", "/data/a"), "/data/a");
  assert.equal(mapPath("/host", "/host/data/.filedeck-trash/x"), null);
  assert.equal(unescapeLine("/a\\nb\\\\c"), "/a\nb\\c");
});

class Fake extends EventEmitter implements HelperProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-root-")));
  fs.mkdirSync(path.join(root, "data"));
  const calls: string[] = [];
  const stale: string[] = [];
  const store = { applyChanged: async (v: string) => void calls.push(v), markStale: (v: string) => void stale.push(v) };
  const proc = new Fake();
  const args: string[][] = [];
  const mounts = path.join(os.tmpdir(), `fanwatch-mounts-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(mounts, "/dev/a / ext4 rw 0 0\n/dev/b /data xfs rw 0 0\nsrv:/x /net nfs4 rw 0 0\n");
  const w = new FanWatch(store, { helper: "fake", root, procMounts: mounts, settleMs: 40, modifyMs: 300, spawn: (_c, a) => (args.push(a), proc) });
  return { w, proc, calls, stale, args, root, done: () => (fs.rmSync(mounts), fs.rmSync(root, { recursive: true })) };
}

test("fanwatch: watches local filesystems only, with host paths", async () => {
  const s = setup();
  await s.w.start();
  assert.deepEqual(s.args, [[s.root, path.join(s.root, "data")]]);
  s.w.stop();
  assert.ok(s.proc.killed);
  s.done();
});

test("fanwatch: events of one folder coalesce, other folders stay separate, paths are mapped", async () => {
  const s = setup();
  await s.w.start();
  for (const l of ["x /data/a", "w /data/a", "x /data/a", "x /data/b", "junk", "#ready 2"].map((x) => x.replace("/data", s.root + "/data"))) s.proc.stdout.write(l + "\n");
  await sleep(150);
  assert.deepEqual([...s.calls].sort(), ["/data/a", "/data/b"]);
  s.w.stop();
  s.done();
});

test("fanwatch: ongoing modify re-reads a folder at most every modifyMs", async () => {
  const s = setup();
  await s.w.start();
  s.w.line(`m ${s.root}/data/a`);
  await sleep(100);
  assert.equal(s.calls.length, 1);
  for (let i = 0; i < 5; i++) {
    s.w.line(`m ${s.root}/data/a`);
    await sleep(30);
  }
  assert.equal(s.calls.length, 1, "held back inside the interval");
  await sleep(300);
  assert.equal(s.calls.length, 2);
  s.w.line(`w ${s.root}/data/a`); // a finished write is not held back by the modify interval
  await sleep(100);
  assert.equal(s.calls.length, 3);
  s.w.stop();
  s.done();
});

test("fanwatch: overflow marks every watched filesystem stale; a failing helper is logged once and never throws", async () => {
  const s = setup();
  await s.w.start();
  s.w.line("!overflow");
  assert.deepEqual(s.stale, ["/", "/data"]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    s.proc.stderr.write("filedeck-fanwatch: not permitted\n");
    await sleep(10);
    s.proc.emit("exit", 2, null);
    s.proc.emit("error", new Error("again"));
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /not permitted/);
  s.w.stop();
  s.done();
});

test("fanwatch: a missing helper binary is logged once", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    const w = new FanWatch({ applyChanged: async () => {}, markStale: () => {} }, { helper: "/nonexistent/filedeck-fanwatch", root: "/", procMounts: "/proc/mounts" });
    await w.start();
    await sleep(100);
    w.stop();
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
});

test("SizeStore.markStale: next scan re-reads the folders", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-stale-")));
  try {
    fs.mkdirSync(path.join(tmp, "a/b"), { recursive: true });
    const st = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 1000 });
    await st.scan("/");
    assert.equal((await st.scanRead("/")).read, 0);
    st.markStale("/a");
    assert.equal((await st.scanRead("/")).read, 2);
    st.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Real helper, real kernel: needs a C compiler and CAP_SYS_ADMIN + CAP_DAC_READ_SEARCH (root). CI runs this file once
// as root with FILEDECK_REQUIRE_FANWATCH=1, where a skip is a failure.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fanlive-"));
const bin = path.join(work, "filedeck-fanwatch");
const cc = spawnSync("cc", ["-O2", "-o", bin, path.resolve(import.meta.dirname, "../native/filedeck-fanwatch.c")], { encoding: "utf8" });
const probe = cc.status === 0 ? spawnSync(bin, [work], { timeout: 1000, encoding: "utf8" }) : null;
const cannot = cc.status !== 0 ? "no C compiler" : probe!.status === 2 || probe!.status === 3 ? probe!.stderr.trim() : "";
if (cannot && process.env.FILEDECK_REQUIRE_FANWATCH) throw new Error("fanwatch live test required but helper cannot run: " + cannot);

test("fanwatch live: skipped (needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH)", { skip: cannot ? `helper cannot run here: ${cannot}` : false }, async () => {
  const dir = path.join(work, "watched");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  const calls: string[] = [];
  const mounts = path.join(work, "mounts");
  fs.writeFileSync(mounts, `/dev/x ${dir} ext4 rw 0 0\n`);
  const w = new FanWatch({ applyChanged: async (v) => void calls.push(v), markStale: () => {} }, { helper: bin, root: "/", procMounts: mounts, settleMs: 50 });
  try {
    await w.start();
    await sleep(500);
    fs.writeFileSync(path.join(dir, "sub", "f.txt"), "hello");
    await sleep(1000);
    assert.ok(calls.includes(path.join(dir, "sub")), `got ${JSON.stringify(calls)}`);
    fs.renameSync(path.join(dir, "sub", "f.txt"), path.join(dir, "g.txt"));
    await sleep(1000);
    assert.ok(calls.includes(dir), `got ${JSON.stringify(calls)}`);
  } finally {
    w.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
