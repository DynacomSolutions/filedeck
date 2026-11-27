import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FanWatch as RealFanWatch, mapPath, unescapeLine, type HelperProc } from "../src/fanwatch.ts";
import { DatabaseSync } from "node:sqlite";
import { SizeStore as RealSizeStore } from "../src/size-store.ts";

// Everything a test opens is released at the end of the file even when an assertion threw first: a leaked watcher timer or store worker would keep the process alive.
const openWatchers: { stop(): void }[] = [];
const openStores: { close(): Promise<void> | void }[] = [];
const cleanups: (() => void)[] = [];
class FanWatch extends RealFanWatch {
  constructor(...a: ConstructorParameters<typeof RealFanWatch>) {
    super(...a);
    openWatchers.push(this);
  }
}
class SizeStore extends RealSizeStore {
  constructor(...a: ConstructorParameters<typeof RealSizeStore>) {
    super(...a);
    openStores.push(this);
  }
}
after(async () => {
  for (const w of openWatchers) w.stop();
  for (const st of openStores) await Promise.resolve(st.close()).catch(() => {});
  for (const c of cleanups) c();
});


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mapPath: strips the root, refuses outside paths and trash stores", () => {
  assert.equal(mapPath("/host", "/host/data/a"), "/data/a");
  assert.equal(mapPath("/host", "/host"), "/");
  assert.equal(mapPath("/host", "/hostile/a"), null);
  assert.equal(mapPath("/host", "/elsewhere"), null);
  assert.equal(mapPath("/", "/data/a"), "/data/a");
  assert.equal(mapPath("/host", "/host/data/.filedeck-trash/x"), null);
  assert.equal(unescapeLine("/a\\x0ab\\\\c\\x0d"), "/a\nb\\c\r");
  assert.equal(unescapeLine("/a\\\\x0d"), "/a\\x0d");
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

/** in-memory equivalent of the SizeStore pending table (same rules as SizeStore.notePending/takeDue) */
function pendingFake() {
  const rows = new Map<string, { due: number; last: number }>();
  return {
    rows,
    notePending: async (items: { path: string; dueAt: number; modify: boolean }[], modifyMs: number) => {
      for (const i of items) {
        const r = rows.get(i.path);
        const at = i.modify ? Math.max(i.dueAt, (r?.last ?? 0) + modifyMs) : i.dueAt;
        rows.set(i.path, { due: !r || r.due === Infinity ? at : Math.min(r.due, at), last: r?.last ?? 0 });
      }
      return true;
    },
    takeDue: async (now: number, limit: number) => {
      const out = [...rows].filter(([, r]) => r.due <= now).sort((a, b) => a[1].due - b[1].due).slice(0, limit).map(([p]) => p);
      for (const p of out) rows.set(p, { due: Infinity, last: now });
      return out;
    },
    clearPending: async () => void rows.clear(),
  };
}

function setup(extra: Partial<ConstructorParameters<typeof FanWatch>[1]> & { plain?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-root-")));
  fs.mkdirSync(path.join(root, "data"));
  const calls: string[] = [];
  const stale: string[] = [];
  const store = { ...(extra.plain ? {} : pendingFake()), applyChanged: async (v: string) => void calls.push(v), markStale: (v: string) => void stale.push(v) };
  const proc = new Fake();
  const args: string[][] = [];
  const mounts = path.join(os.tmpdir(), `fanwatch-mounts-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(mounts, "/dev/a / ext4 rw 0 0\n/dev/b /data xfs rw 0 0\nsrv:/x /net nfs4 rw 0 0\n");
  const w = new FanWatch(store, { helper: "fake", root, procMounts: mounts, settleMs: 40, modifyMs: 300, ...extra, spawn: (_c, a) => (args.push(a), proc) });
  cleanups.push(() => (fs.rmSync(mounts, { force: true }), fs.rmSync(root, { recursive: true, force: true })));
  return { w, proc, calls, stale, args, root, mounts, done: () => (fs.rmSync(mounts, { force: true }), fs.rmSync(root, { recursive: true, force: true })) };
}

test("fanwatch: watches local filesystems only, with host paths", async () => {
  const s = setup();
  await s.w.start();
  assert.deepEqual(s.args, [[s.root, path.join(s.root, "data")]]);
  s.w.stop();
  assert.ok(s.proc.killed);
  s.done();
});

test("fanwatch: passes every mount of a filesystem, bind aliases too, so the helper can name an entry under each of them (it marks the filesystem once)", async () => {
  const s = setup();
  for (const d of ["alias", "data/bound"]) fs.mkdirSync(path.join(s.root, d), { recursive: true });
  fs.writeFileSync(s.mounts, "/dev/a / ext4 rw 0 0\n/dev/a /alias ext4 rw 0 0\n/dev/b /data xfs rw 0 0\n/dev/a /data/bound ext4 rw 0 0\nsrv:/x /net nfs4 rw 0 0\n");
  await s.w.start();
  assert.deepEqual(s.args, [[s.root, path.join(s.root, "alias"), path.join(s.root, "data"), path.join(s.root, "data/bound")]]);
  s.w.line("#ready 2");
  // every one of them is covered, and a network mount still is not
  assert.equal(s.w.covers("/alias/x"), true);
  assert.equal(s.w.covers("/data/bound/x"), true);
  s.w.stop();
  s.done();
});

test("fanwatch: a mount of a single file (a file bind mount) is not given to the helper, not reported as unwatched, and does not make the root uncovered", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.root, "hosts"), "127.0.0.1 localhost\n");
  fs.writeFileSync(s.mounts, "/dev/a / ext4 rw 0 0\n/dev/a /hosts ext4 rw 0 0\n/dev/b /data xfs rw 0 0\n");
  await s.w.start();
  assert.deepEqual(s.args, [[s.root, path.join(s.root, "data")]], "the file is not an argument");
  s.w.line("#ready 2");
  const st = s.w.status();
  assert.equal(st.unwatched, 0, "a file mount is not an unwatched filesystem");
  assert.equal(s.w.covers("/"), true);
  s.w.stop();
  s.done();
});

test("fanwatch: a mount table with more mounts than the helper takes keeps one mount of every filesystem first, and reports the rest as unwatched", async () => {
  const s = setup();
  const lines = ["/dev/a / ext4 rw 0 0", "/dev/b /data xfs rw 0 0"];
  for (let i = 0; i < 4100; i++) {
    const n = `/alias${String(i).padStart(4, "0")}`;
    fs.mkdirSync(path.join(s.root, n));
    lines.push(`/dev/a ${n} ext4 rw 0 0`);
  }
  fs.writeFileSync(s.mounts, lines.join("\n") + "\n");
  await s.w.start();
  const argv = s.args[0]!;
  assert.equal(argv.length, 4096);
  assert.ok(argv.includes(s.root) && argv.includes(path.join(s.root, "data")), "both filesystems stay in");
  assert.equal(s.w.status().unwatched, 4102 - 4096);
  s.w.stop();
  s.done();
});

test("fanwatch: the folder that a bind mount shows is part of the mount signature: a bind that is replaced by one of another folder restarts the helper, an unchanged table does not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-info-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mounts = path.join(dir, "mounts");
  const info = path.join(dir, "mountinfo");
  const s = setup({ procMounts: mounts, reconcileMs: 20 });
  fs.mkdirSync(path.join(s.root, "alias"));
  fs.writeFileSync(mounts, "/dev/a / ext4 rw 0 0\n/dev/a /alias ext4 rw 0 0\n");
  const table = (fsroot: string) => `10 1 8:1 / / rw - ext4 /dev/a rw\n11 10 8:1 ${fsroot} /alias rw - ext4 /dev/a rw\n`;
  fs.writeFileSync(info, table("/one"));
  await s.w.start();
  s.w.line("#ready 1");
  await sleep(120);
  assert.equal(s.proc.killed, false, "nothing changed");
  fs.writeFileSync(info, table("/two"));
  await until(() => s.proc.killed, 5000);
  assert.equal(s.proc.killed, true, "the bind shows another folder now");
  s.w.stop();
  s.done();
});

test("fanwatch: events of one folder coalesce, other folders stay separate, paths are mapped", async () => {
  const s = setup();
  await s.w.start();
  for (const l of ["x /data/a", "w /data/a", "x /data/a", "x /data/b", "junk", "#ready 2"].map((x) => x.replace("/data", s.root + "/data"))) s.proc.stdout.write(l + "\n");
  await until(() => s.calls.length >= 2, 30_000);
  await sleep(50); // (a stray extra call would show here)
  assert.deepEqual([...s.calls].sort(), ["/data/a", "/data/b"]);
  s.w.stop();
  s.done();
});

test("fanwatch: ongoing modify re-reads a folder at most every modifyMs", async () => {
  // a long interval: a loaded host that stretches the sleeps below by seconds must not reach the end of it
  const s = setup({ modifyMs: 5000 });
  await s.w.start();
  s.w.line(`m ${s.root}/data/a`);
  await until(() => s.calls.length === 1);
  for (let i = 0; i < 5; i++) {
    s.w.line(`m ${s.root}/data/a`);
    await sleep(30);
  }
  assert.equal(s.calls.length, 1, "held back inside the interval");
  await until(() => s.calls.length === 2);
  assert.equal(s.calls.length, 2);
  s.w.line(`w ${s.root}/data/a`); // a finished write is not held back by the modify interval
  await until(() => s.calls.length === 3);
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

test("fanwatch: a path with CR/LF cannot inject a protocol line", async () => {
  const s = setup();
  await s.w.start();
  s.proc.stdout.write(`x ${s.root}/data/a\\x0d!overflow\n`);
  s.proc.stdout.write(`x ${s.root}/data/b\r!overflow\n`); // a raw CR (never sent by the helper) is still no line break
  await until(() => s.calls.length >= 2, 30_000);
  await sleep(50);
  assert.deepEqual(s.stale, []);
  assert.deepEqual([...s.calls].sort(), ["/data/a\r!overflow", "/data/b\r!overflow"]);
  s.w.stop();
  s.done();
});

test("fanwatch: 50k distinct folders drain quickly", async () => {
  const calls: number[] = [];
  const w = new FanWatch({ applyChanged: async () => void calls.push(1), markStale: () => {} }, { helper: "x", root: "/", procMounts: "/proc/mounts", settleMs: 1, modifyMs: 10 });
  const t0 = Date.now();
  for (let i = 0; i < 50_000; i++) w.line(`x /d/${i}`);
  // throughput, not latency: the deadline restarts while the count is growing (a loaded host is slow but moving)
  await untilCount(() => calls.length, 50_000);
  w.stop();
  assert.equal(calls.length, 50_000);
});

test("fanwatch: an unexpected helper exit marks stale and restarts with backoff; a refusal does not", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    const procs: Fake[] = [];
    const stale: string[] = [];
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-root-")));
    const mounts = path.join(root, "m");
    fs.writeFileSync(mounts, "/dev/a / ext4 rw 0 0\n");
    const w = new FanWatch({ applyChanged: async () => {}, markStale: (v) => void stale.push(v) }, { helper: "fake", root, procMounts: mounts, restartMinMs: 20, restartMaxMs: 40, spawn: () => (procs.push(new Fake()), procs.at(-1)!) });
    await w.start();
    procs[0]!.emit("exit", 1, null);
    assert.deepEqual(stale, ["/"]);
    await until(() => procs.length >= 2, 30_000);
    assert.equal(procs.length, 2);
    procs[1]!.emit("exit", null, "SIGKILL");
    await until(() => procs.length >= 3, 30_000);
    assert.equal(procs.length, 3);
    procs[2]!.emit("exit", 2, null); // not permitted: final
    await sleep(100);
    assert.equal(procs.length, 3);
    assert.equal(errs.length, 2); // one rate-limited restart note, one refusal
    w.stop();
    fs.rmSync(root, { recursive: true });
  } finally {
    console.error = orig;
  }
});

test("fanwatch: a 'c' line is logged at startup", async () => {
  const s = setup();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    await s.w.start();
    s.w.line("c /data/btrfs\\x0asub");
  } finally {
    console.error = orig;
  }
  assert.match(errs[0]!, /cannot watch \/data\/btrfs\nsub/);
  s.w.stop();
  s.done();
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
    await until(() => calls.includes(path.join(dir, "sub")), 30_000);
    assert.ok(calls.includes(path.join(dir, "sub")), `got ${JSON.stringify(calls)}`);
    fs.renameSync(path.join(dir, "sub", "f.txt"), path.join(dir, "g.txt"));
    await until(() => calls.includes(dir), 30_000);
    assert.ok(calls.includes(dir), `got ${JSON.stringify(calls)}`);
  } finally {
    w.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("fanwatch.covers: true on a watched filesystem while the helper runs; false when disabled, after exit, outside watched mounts", async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.root, "net"));
  await s.w.start();
  assert.equal(s.w.covers("/data/a/b"), false, "not before the helper is ready");
  s.w.line("#ready 2");
  assert.ok(Number.isFinite(s.w.watchedSince()));
  assert.equal(s.w.covers("/data/a/b"), true);
  assert.equal(s.w.covers("/other"), true);
  assert.equal(s.w.covers("/net"), false);
  assert.equal(s.w.covers("/net/x"), false);
  assert.equal(s.w.covers("/"), false); // an unwatched filesystem sits below
  s.w.line("!overflow");
  assert.equal(s.w.covers("/data"), true); // rows are marked stale, the next read re-scans and is current again
  s.proc.emit("exit", 1, null);
  assert.equal(s.w.covers("/data"), false);
  s.w.stop();
  s.done();
  const off = new FanWatch({ applyChanged: async () => {}, markStale: () => {} }, { helper: "", root: "/", procMounts: "/proc/mounts" });
  await off.start();
  assert.equal(off.covers("/"), false);
});

test("fanwatch.covers: a path the helper could not mark is never covered", async () => {
  const s = setup();
  await s.w.start();
  s.w.line("#ready 2");
  s.w.line(`c ${s.root}/data/x`);
  assert.equal(s.w.covers("/data/x"), false);
  assert.equal(s.w.covers("/data/x/y"), false);
  assert.equal(s.w.covers("/data/a/b"), true);
  s.w.stop();
  s.done();
});

test("fanwatch: without a usable store, past maxPending the burst acts like an overflow and later events schedule normally", async () => {
  const s = setup({ maxPending: 5, plain: true });
  await s.w.start();
  for (let i = 0; i < 12; i++) s.w.line(`x ${s.root}/data/d${i}`);
  await until(() => s.stale.length > 0, 30_000);
  assert.ok(s.stale.length > 0, "watched trees marked stale");
  await sleep(150);
  assert.ok(s.calls.length <= 5, `pending stayed bounded, got ${s.calls.length}`);
  s.calls.length = 0;
  s.w.line(`x ${s.root}/data/late`);
  await until(() => s.calls.length >= 1, 30_000);
  await sleep(50);
  assert.deepEqual(s.calls, ["/data/late"]);
  s.w.stop();
  s.done();
});

test("fanwatch: a folder whose lock is busy is tried again later, never waited for or marked, and the others are still applied", async () => {
  const s = setup({ plain: true });
  const calls: [string, unknown][] = [];
  const dirty: string[][] = [];
  const stale: string[] = [];
  let free = false;
  const store = {
    applyChanged: async (v: string, _c?: undefined, o?: { wait?: boolean }) => (calls.push([v, o]), v.endsWith("/a") && !free ? false : true),
    markStale: (v: string) => void stale.push(v),
    markDirty: async (ps: string[]) => (dirty.push(ps), true),
  };
  const w = new FanWatch(store, { helper: "fake", root: s.root, procMounts: path.join(s.root, "none"), settleMs: 5, modifyMs: 300, spawn: () => new Fake() });
  w.line(`x ${s.root}/data/a`);
  w.line(`x ${s.root}/data/b`);
  await until(() => calls.some(([v]) => v.endsWith("/b")) && calls.some(([v]) => v.endsWith("/a")), 30_000);
  assert.ok(calls.every(([, o]) => (o as { wait?: boolean }).wait === false), "the watcher never queues for a lock");
  free = true; // the walk ended: the retry applies it
  await until(() => calls.filter(([v]) => v.endsWith("/a")).length >= 2, 30_000);
  assert.deepEqual(dirty, [], "no dirty mark");
  assert.deepEqual(stale, []);
  w.stop();
  s.done();
});

test("fanwatch: a busy folder is noted as pending again with a due time in the future, then applied once the lock is free", async () => {
  const f = fileStore();
  const noted: { path: string; dueAt: number; modify: boolean }[] = [];
  const dirty: unknown[][] = [];
  let free = false;
  const sink = {
    ...f.sink,
    applyChanged: async (v: string) => (f.calls.push(v), free ? true : false),
    notePending: async (items: { path: string; dueAt: number; modify: boolean }[], ms: number) => (noted.push(...items.map((i) => ({ ...i }))), f.st.notePending(items, ms)),
    // stop() may interrupt a drain batch, and the drain then marks taken but unapplied folders dirty on purpose; only calls while the watcher runs count
    markDirty: async (...a: unknown[]) => (dirty.push(a), true),
  };
  const w = new FanWatch(sink, { ...opts, helper: "fake", spawn: () => new Fake() });
  const t0 = Date.now();
  w.line("x /data/a");
  await until(() => f.calls.length >= 1, 30_000);
  await until(() => noted.length >= 2, 30_000); // the event, then the retry
  assert.equal(noted.at(-1)!.path, "/data/a");
  assert.equal(noted.at(-1)!.modify, false);
  assert.ok(noted.at(-1)!.dueAt >= t0 + 500, "due later, not at once");
  free = true;
  await until(() => f.calls.length >= 2, 30_000);
  assert.deepEqual(dirty, [], "a busy folder is never marked dirty while the watcher runs");
  w.stop();
  f.done();
});

function fileStore() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-store-")));
  const st = new SizeStore(path.join(dir, "sizes.db"), { root: dir, ttlMs: 60_000, maxEntries: 1000 });
  const calls: string[] = [];
  const stale: string[] = [];
  const sink = {
    applyChanged: async (v: string) => void calls.push(v),
    markStale: (v: string) => void stale.push(v),
    notePending: st.notePending.bind(st),
    takeDue: st.takeDue.bind(st),
    noteRan: st.noteRan.bind(st),
    markDirty: st.markDirty.bind(st),
    isWriter: true, // the only store on its file: it gets the lease at once (a sink that is spread into another keeps the value)
    clearPending: st.clearPending.bind(st),
  };
  const count = () => (st as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) n FROM pending").get().n;
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { st, sink, calls, stale, count, done: () => (st.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const opts = { helper: "x", root: "/", procMounts: "/proc/mounts", settleMs: 5, modifyMs: 300 };
const until = async (f: () => boolean, ms = 20_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(20);
};
/** Wait until `n()` reaches `target`. The deadline is for a stall, not for the whole run: it restarts whenever `n()` has grown, so a loaded host that is slow but moving does not fail. */
const untilCount = async (n: () => number, target: number, stallMs = 20_000) => {
  let best = -1;
  for (let t0 = Date.now(); n() < target && Date.now() - t0 < stallMs; ) {
    if (n() > best) [best, t0] = [n(), Date.now()];
    await sleep(20);
  }
};

test("fanwatch + SizeStore file: many events of one folder become one row, applied once", async () => {
  const f = fileStore();
  const w = new FanWatch(f.sink, opts);
  for (let i = 0; i < 5000; i++) w.line(i % 2 ? "x /d/a" : "w /d/a");
  await until(() => f.calls.length > 0);
  await until(() => f.count() === 1, 30_000);
  assert.deepEqual(f.calls, ["/d/a"]);
  assert.equal(f.count(), 1, "the applied folder stays as one idle row");
  w.stop();
  f.done();
});

test("fanwatch + SizeStore file: 100k distinct folders keep the heap structures bounded and all get applied", async () => {
  const f = fileStore();
  // modifyMs 600_000 puts the 10*modifyMs overflow limit (about 100 min) out of reach on slow runners.
  const w = new FanWatch(f.sink, { ...opts, modifyMs: 600_000 });
  const priv = w as unknown as { buf: Map<string, unknown>; mem: Map<string, unknown>; timer: unknown };
  let maxBuf = 0;
  for (let i = 0; i < 100_000; i++) {
    w.line(`x /d/${i}`);
    maxBuf = Math.max(maxBuf, priv.buf.size);
  }
  assert.ok(maxBuf <= 2000, `buffer reached ${maxBuf}`);
  assert.ok(priv.timer, "one shared timer");
  await untilCount(() => f.calls.length, 100_000); // (throughput, not latency, is what a loaded host changes)
  assert.equal(f.calls.length, 100_000);
  assert.equal(new Set(f.calls).size, 100_000);
  assert.equal(priv.mem.size, 0);
  assert.deepEqual(f.stale, [], "a burst never forces staleness");
  w.stop();
  f.done();
});

test("fanwatch + SizeStore file: modify events wait modifyMs after the last run, settle events do not", async () => {
  const f = fileStore();
  const w = new FanWatch(f.sink, opts);
  w.line("m /d/a");
  await until(() => f.calls.length === 1);
  const t0 = Date.now();
  w.line("m /d/a");
  await until(() => f.calls.length === 2);
  assert.ok(Date.now() - t0 >= 250, `second run after ${Date.now() - t0} ms`);
  w.line("w /d/a");
  await until(() => f.calls.length === 3, 200);
  assert.equal(f.calls.length, 3, "settle event not held back");
  w.stop();
  f.done();
});

test("SizeStore.takeDue stamps the run after its reads, so a modify row waits modifyMs from the run, not from before the reads", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanwatch-store-")));
  const file = path.join(dir, "sizes.db");
  const st = new SizeStore(file, { root: dir, ttlMs: 60_000, maxEntries: 1000, readDelayMs: 100 }); // every read takes 100 ms
  const t = { modifyMs: 300, settleMs: 5 };
  await st.notePending([{ path: "/a", dueAt: Date.now(), modify: false }], 300);
  const t0 = Date.now();
  assert.deepEqual(await st.takeDue(t0, 10, t), ["/a"]);
  // takeDue makes at least two reads of 100 ms (the oldest row, then the due rows) before it stamps the run. Stamped from the `now` it was given, last_run would be t0.
  // Only a lower bound is asserted: a slow runner can make the stamp later, never earlier.
  const d = new DatabaseSync(file, { readOnly: true });
  const lastRun = (d.prepare("SELECT last_run r FROM pending WHERE path = '/a'").get() as { r: number }).r;
  d.close();
  assert.ok(lastRun >= t0 + 150, `stamped ${lastRun - t0} ms after the call began`);
  await st.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fanwatch + SizeStore file: after a re-read slower than modifyMs the next modify run waits modifyMs from its end", async () => {
  const f = fileStore();
  const starts: number[] = [];
  let ended = 0;
  let finish!: () => void;
  const slowRun = new Promise<void>((r) => (finish = r));
  const sink = {
    ...f.sink,
    applyChanged: async () => {
      starts.push(Date.now());
      if (starts.length === 1) {
        await slowRun; // the first run lasts until the test has sent its second event, however long that takes
        await sleep(350); // and is then longer than modifyMs in total
        ended = Date.now();
      }
    },
  };
  const w = new FanWatch(sink, opts);
  w.line("m /d/a");
  await until(() => starts.length === 1, 30_000);
  w.line("m /d/a"); // during the slow run
  const stored = () => (f.st as unknown as { db: { prepare(s: string): { get(a: number): { n: number } } } }).db.prepare("SELECT COUNT(*) n FROM pending WHERE due_at < ?").get(Number.MAX_SAFE_INTEGER).n > 0;
  await until(stored, 30_000);
  finish();
  await until(() => starts.length === 2, 60_000);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - ended >= 290, `second run ${starts[1]! - ended} ms after the first ended`);
  w.stop();
  f.done();
});

test("SizeStore workers do not keep the process alive once idle (the image build hung after the tests)", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve(import.meta.dirname, "idle-exit.ts")], { timeout: 20_000, encoding: "utf8" });
  assert.equal(r.error, undefined, "the process exits by itself: " + r.error);
  assert.equal(r.status, 0, r.stderr);
});

test("fanwatch + SizeStore file: a modify row that fell due after the active window is still applied", async () => {
  const f = fileStore();
  const w = new FanWatch(f.sink, opts);
  w.line("m /d/a");
  await until(() => f.calls.length === 1);
  w.line("m /d/a");
  // wait for the row to be stored (due at last run + modifyMs), not for a fixed time: a loaded host can be slow to store it
  const live = () => (f.st as unknown as { db: { prepare(s: string): { get(a: number): { n: number } } } }).db.prepare("SELECT COUNT(*) n FROM pending WHERE due_at < ?").get(Number.MAX_SAFE_INTEGER).n;
  await until(() => f.calls.length === 2 || live() > 0, 60_000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450); // a stalled event loop skips the whole window
  await until(() => f.calls.length === 2, 60_000);
  assert.equal(f.calls.length, 2, "row not stranded");
  w.stop();
  f.done();
});

test("fanwatch + SizeStore file: overflow clears pending rows and marks stale", async () => {
  const f = fileStore();
  const w = new FanWatch(f.sink, { ...opts, settleMs: 60_000 });
  for (let i = 0; i < 3000; i++) w.line(`x /d/${i}`);
  // every flush must have landed: a flush still in flight at the overflow would insert rows after the clear (harmless, the marks cover them, but not what is asserted here)
  await until(() => f.count() >= 3000);
  assert.equal(f.count(), 3000);
  w.line("!overflow");
  await until(() => f.count() === 0);
  assert.equal(f.count(), 0);
  assert.equal(f.calls.length, 0);
  w.stop();
  f.done();
});

test("fanwatch + SizeStore file: a backlog older than 10 x modifyMs becomes an overflow", async () => {
  const f = fileStore();
  const slow = { ...f.sink, applyChanged: async (v: string) => (f.calls.push(v), void (await sleep(5))) };
  const w = new FanWatch(slow, { ...opts, settleMs: 1, modifyMs: 20 });
  (w as unknown as { marks: string[] }).marks = ["/"];
  for (let i = 0; i < 600; i++) w.line(`x /d/${i}`);
  await until(() => f.calls.length > 0 && !(w as unknown as { draining: boolean }).draining, 10_000);
  await sleep(100);
  assert.deepEqual(f.stale, [], "no watched tree is marked stale: the store marks only the pending folders");
  const waiting = (f.st as unknown as { db: { prepare(s: string): { get(a: number): { n: number } } } }).db.prepare("SELECT COUNT(*) n FROM pending WHERE due_at < ?").get(Number.MAX_SAFE_INTEGER).n;
  assert.equal(waiting, 0, "no pending row left waiting");
  assert.ok(f.calls.length < 600);
  w.stop();
  f.done();
});

test("fanwatch + SizeStore file: a due time far in the future (the clock stepped back) still drains", async () => {
  const f = fileStore();
  const now = Date.now(); // (taken once: a slow write must not age the row past takeDue's "too far behind" limit)
  await f.st.notePending([{ path: "/r", dueAt: now - 1000, modify: false }], 300);
  assert.deepEqual(await f.st.takeDue(now, 10, { modifyMs: 300, settleMs: 5 }), ["/r"]);
  await f.st.notePending([{ path: "/future", dueAt: Date.now() + 3_600_000, modify: false }], 300);
  assert.deepEqual(await f.st.takeDue(Date.now(), 10, { modifyMs: 300, settleMs: 5 }), ["/future"]);
  f.done();
});

test("SizeStore pending writes do not extend the walk tail", async () => {
  const f = fileStore();
  const st = f.st as unknown as { tail: Promise<void> };
  const before = st.tail;
  await f.st.notePending([{ path: "/a", dueAt: 0, modify: false }], 300);
  await f.st.takeDue(Date.now(), 10, { modifyMs: 300, settleMs: 5 });
  await f.st.clearPending();
  assert.equal(st.tail, before);
  f.done();
});
