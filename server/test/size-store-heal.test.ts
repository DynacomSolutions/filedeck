// A size store damaged beyond its indexes heals itself: a new generation file (`<file>.gen<N>`), never a path used again, every process follows it.
// See docs/superpowers/specs/2026-11-18-size-store-self-heal-design.md.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";

const test = ((name: string, fn: () => unknown) => nodeTest(name, { timeout: 180_000 }, fn as never)) as (name: string, fn: () => unknown) => void;
type Any = any;
let tmp: string;
let n = 0;
const stores: SizeStore[] = [];
const kids: ChildProcessWithoutNullStreams[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-heal-")))));
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 60_000, what = "condition"): Promise<void> {
  for (const end = Date.now() + ms; !(await f()); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
async function capture<T>(fn: () => Promise<T>): Promise<{ r: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { r: await fn(), lines };
  } finally {
    console.error = orig;
  }
}
const opts = (extra: Record<string, unknown> = {}) => ({ root: tmp, ttlMs: 3_600_000, maxEntries: 100_000, leaseMs: 600, ...extra });
const mk = (file: string, extra: Record<string, unknown> = {}) => {
  const s = new SizeStore(file, opts(extra));
  stores.push(s);
  return s;
};
/** a served folder with a few subfolders, under the test root */
function tree(): string {
  const v = `/t${n++}`;
  for (const p of ["a/b/c", "a/d", "e"]) fs.mkdirSync(path.join(tmp, v, p), { recursive: true });
  fs.writeFileSync(path.join(tmp, v, "a/b/c/f.txt"), "x".repeat(1000));
  return v;
}
const filesOf = (file: string) => fs.readdirSync(path.dirname(file)).filter((f) => f === path.basename(file) || f.startsWith(path.basename(file) + ".") || f.startsWith(path.basename(file) + "-")).sort();
const rowsOf = (file: string, sql = "SELECT COUNT(*) c FROM sizes") => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((d.prepare(sql).get() as Any).c);
  } finally {
    d.close();
  }
};
const integrity = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare("PRAGMA integrity_check").all() as Any[]).map((r) => String(r.integrity_check));
  } finally {
    d.close();
  }
};
/** A store file with the real schema, then a broken table page that the open itself reads (stale_trees): damage beyond the indexes. */
async function damaged(): Promise<string> {
  const file = path.join(tmp, `s${n++}.db`);
  const s0 = new SizeStore(file, opts());
  await s0.mayScan();
  await s0.close();
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode=DELETE");
  d.exec("BEGIN");
  for (let i = 0; i < 40; i++) d.prepare("INSERT INTO stale_trees VALUES (?, ?)").run(`/s${i}`, i);
  d.exec("COMMIT");
  const root = Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = 'stale_trees'").get() as Any).r);
  const size = Number((d.prepare("PRAGMA page_size").get() as Any).page_size);
  d.close();
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(120, 0xff), 0, 120, root * size - 120);
  fs.closeSync(fd);
  return file;
}
const healthy = (s: SizeStore) => s.health().available && !s.health().damaged;

/** A second process with its own store on `file` (see size-store-heal-child.ts). */
function child(file: string, leaseMs = 600) {
  const k = spawn(process.execPath, ["--import", "tsx", path.resolve("test/size-store-heal-child.ts"), file, tmp, String(leaseMs)], { stdio: ["pipe", "pipe", "pipe"] });
  kids.push(k);
  let err = "";
  k.stderr.on("data", (d) => (err += d));
  const waiting = new Map<number, (v: Any) => void>();
  readline.createInterface({ input: k.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m.out);
    waiting.delete(m.id);
  });
  let id = 0;
  const ask = (cmd: Record<string, unknown>): Promise<Any> =>
    new Promise((res, rej) => {
      const i = ++id;
      waiting.set(i, res);
      k.once("exit", () => rej(new Error("child exited: " + err)));
      k.stdin.write(JSON.stringify({ id: i, ...cmd }) + "\n");
    });
  return { ask, stderr: () => err, k };
}

test("a store damaged beyond its indexes heals itself: a new generation, the damaged files deleted, one clear line, sizes cached again", async () => {
  const file = await damaged();
  const v = tree();
  const { lines, r: s } = await capture(async () => {
    const s = mk(file);
    await until(() => healthy(s) && s.storeFile === file + ".gen1", 60_000, "heal");
    return s;
  });
  assert.deepEqual(filesOf(file).filter((f) => !/-(wal|shm)$/.test(f)), [path.basename(file) + ".gen1"], "only the new generation is left: " + filesOf(file).join(","));
  const healed = lines.filter((l) => /was damaged/.test(l));
  assert.equal(healed.length, 1, lines.join("\n"));
  assert.ok(healed[0]!.includes(`${file} was damaged`) && healed[0]!.includes(file + ".gen1") && !healed[0]!.includes("\n"), healed[0]);
  assert.ok(!lines.some((l) => /Stop the agent|move the file/.test(l)), "no operator step: " + lines.join("\n"));
  assert.equal((await s.scanRead(v)).read > 0, true);
  assert.equal((await s.scanRead(v)).read, 0, "the second scan is answered from the new store");
  assert.deepEqual(integrity(file + ".gen1"), ["ok"]);
  const d = new DatabaseSync(file + ".gen1", { readOnly: true });
  assert.equal(Number((d.prepare("PRAGMA auto_vacuum").get() as Any).auto_vacuum), 2, "a new generation gives free pages back (incremental)");
  d.close();
});

test("a file that is not SQLite heals too", async () => {
  const file = path.join(tmp, `garbage${n++}.db`);
  fs.writeFileSync(file, "this is not a database ".repeat(200));
  const { lines } = await capture(async () => {
    const s = mk(file);
    await until(() => healthy(s) && s.storeFile === file + ".gen1", 60_000, "heal");
  });
  assert.ok(!fs.existsSync(file));
  assert.equal(lines.filter((l) => /was damaged/.test(l)).length, 1, lines.join("\n"));
});

test("two processes on one damaged file: exactly one new generation, both use it, one heal line in all", async () => {
  const file = await damaged();
  const v = tree();
  const A = child(file);
  const B = child(file);
  let last: Any[] = [];
  await until(async () => {
    const [a, b] = (last = [await A.ask({ cmd: "state" }), await B.ask({ cmd: "state" })]);
    return a.file === file + ".gen1" && b.file === file + ".gen1" && a.health.available && b.health.available;
  }, 90_000, "both on generation 1").catch((e) => {
    throw new Error(e.message + ": " + JSON.stringify(last) + " files " + filesOf(file).join(","));
  });
  assert.ok(!fs.existsSync(file + ".gen2"), "never a second generation: " + filesOf(file).join(","));
  assert.ok(!fs.existsSync(file), "the damaged file is gone");
  const all = [...(await A.ask({ cmd: "state" })).lines, ...(await B.ask({ cmd: "state" })).lines];
  assert.equal(all.filter((l: string) => /was damaged/.test(l)).length, 1, all.join("\n"));
  // the writer scans; the other process reads the same new file
  await until(async () => (await A.ask({ cmd: "state" })).writer || (await B.ask({ cmd: "state" })).writer, 30_000, "a writer");
  const W = (await A.ask({ cmd: "state" })).writer ? A : B;
  assert.ok((await W.ask({ cmd: "scan", path: v })).read > 0);
  assert.ok(rowsOf(file + ".gen1") >= 5, "rows are in the new generation");
  assert.deepEqual(integrity(file + ".gen1"), ["ok"]);
  await A.ask({ cmd: "close" });
  await B.ask({ cmd: "close" });
});

test("a process still on the old file follows the new generation within a lease tick; its writes never reach the new file", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = tree();
  const B = child(file); // a healthy store, the lease holder
  await until(async () => (await B.ask({ cmd: "state" })).writer, 30_000, "B writer");
  assert.ok((await B.ask({ cmd: "scan", path: v })).read > 0);
  // A meets damage B has not seen (it heals without the lease: the lease lives in the damaged file)
  const A = mk(file);
  await A.mayScan();
  const { lines } = await capture(async () => {
    await (A as Any).heal("test damage");
    await until(async () => (await B.ask({ cmd: "state" })).file === file + ".gen1", 10_000, "B follows");
  });
  assert.equal(lines.filter((l) => /was damaged \(test damage\)/.test(l)).length, 1, lines.join("\n"));
  assert.ok(!fs.existsSync(file) && !fs.existsSync(file + "-wal"), filesOf(file).join(","));
  // B scans again: it re-reads (nothing of the old file is believed) and writes into generation 1 only
  await until(async () => (await B.ask({ cmd: "state" })).writer || A.isWriter, 30_000, "a writer on generation 1");
  const W = A.isWriter ? null : B;
  const r = W ? await W.ask({ cmd: "scan", path: v }) : { read: (await A.scanRead(v)).read };
  assert.ok(r.read > 0, "the new generation starts empty: folders are read again");
  assert.ok(!fs.existsSync(file), "nobody made the old path again");
  assert.deepEqual(integrity(file + ".gen1"), ["ok"]);
  await B.ask({ cmd: "close" });
});

test("an older version that keeps writing (and re-creating) the old path never touches the new generation", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = tree();
  const s = mk(file);
  await s.mayScan();
  await s.scanRead(v);
  // an old agent: opens the old name with create, writes rows in WAL mode, closes and opens again (its last close deletes `<name>-wal` by name)
  const old = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const f = ${JSON.stringify(file)};
    let i = 0;
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const d = new DatabaseSync(f);
      d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS sizes (path TEXT PRIMARY KEY, parent TEXT) WITHOUT ROWID");
      try { for (let k = 0; k < 50; k++) d.prepare("INSERT OR REPLACE INTO sizes (path, parent) VALUES (?, ?)").run("/old/" + (i++), "/old"); } catch {}
      d.close();
    }
  `], { stdio: "inherit" });
  const oldGone = new Promise((r) => old.once("exit", r));
  await sleep(300);
  await capture(async () => {
    await (s as Any).heal("test damage");
  });
  assert.equal(s.storeFile, file + ".gen1");
  await oldGone;
  // generation 1 has no row of the old process, and is sound
  assert.equal(rowsOf(file + ".gen1", "SELECT COUNT(*) c FROM sizes WHERE path LIKE '/old/%'"), 0);
  assert.deepEqual(integrity(file + ".gen1"), ["ok"]);
  assert.ok((await s.scanRead(v)).read > 0);
  assert.equal((await s.scanRead(v)).read, 0);
  // the old name it made again is ignored, and deleted by the next process that opens the store
  const s2 = mk(file);
  assert.equal(s2.storeFile, file + ".gen1", "the highest generation wins");
  await until(() => !fs.existsSync(file), 10_000, "old name deleted");
});

test("a restart in the middle of a switch: the highest generation wins and the leftovers are deleted", async () => {
  const file = await damaged();
  fs.writeFileSync(file + "-wal", "");
  // a heal that died after putting generation 1 in place: an empty file, the damaged one and a temporary file still there
  fs.writeFileSync(file + ".gen1", "");
  fs.writeFileSync(`${file}.gen2.tmp-dead`, "");
  fs.utimesSync(`${file}.gen2.tmp-dead`, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  const v = tree();
  const s = mk(file);
  assert.equal(s.storeFile, file + ".gen1");
  await until(() => healthy(s), 30_000, "open");
  await until(() => !fs.existsSync(file) && !fs.existsSync(file + "-wal") && !fs.existsSync(`${file}.gen2.tmp-dead`), 10_000, "leftovers deleted: " + filesOf(file).join(","));
  assert.ok((await s.scanRead(v)).read > 0);
  assert.equal((await s.scanRead(v)).read, 0);
});

test("an existing store under the old name is used as it is: no new generation, its sizes are kept", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = tree();
  const s0 = mk(file);
  await s0.mayScan();
  assert.ok((await s0.scanRead(v)).read > 0);
  await s0.close();
  const s = mk(file);
  assert.equal(s.storeFile, file);
  await s.mayScan();
  assert.equal((await s.scanRead(v)).read, 0, "the stored sizes are reused");
  assert.deepEqual(filesOf(file).filter((f) => !/-(wal|shm)$/.test(f)), [path.basename(file)]);
});

test("a walk that began on the old file never commits into the new generation", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = `/w${n++}`;
  for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(tmp, v, `d${i}`, "x"), { recursive: true });
  const s = mk(file, { commitChunk: 1, flushMs: 0 });
  await s.mayScan();
  const fsp = (await import("node:fs/promises")).default;
  const l = fsp.lstat;
  let slow = true;
  fsp.lstat = (async (...a: Parameters<typeof l>) => (slow && (await sleep(10)), l(...a))) as typeof l;
  try {
    const walk = s.scanRead(v).then(() => "done", (e: Error) => e.message);
    await until(() => rowsOf(file) > 3, 30_000, "walk writing");
    await capture(async () => (s as Any).heal("test damage"));
    const res = await walk;
    slow = false;
    // it either fails (a commit after the move is fenced) or answers what it read; it never writes into the new generation
    assert.ok(res === "done" || /lease|moved/.test(String(res)), String(res));
    assert.equal(rowsOf(file + ".gen1", `SELECT COUNT(*) c FROM sizes WHERE path LIKE '${v}/%' OR path = '${v}'`), 0, "nothing of the old walk in generation 1");
    assert.ok((await s.scanRead(v)).read > 0, "a new scan works");
  } finally {
    fsp.lstat = l;
  }
});

test("a process lets go of the deleted file: no descriptor of it stays open after the switch", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const s = mk(file);
  await s.mayScan();
  await s.scanRead(tree());
  await capture(async () => (s as Any).heal("test damage"));
  await until(() => healthy(s), 10_000, "switch");
  const open = () =>
    fs.readdirSync("/proc/self/fd").flatMap((fd) => {
      try {
        return [fs.readlinkSync(`/proc/self/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  await until(() => !open().some((l) => l.startsWith(file + " ") || l === file + " (deleted)" || l.startsWith(file + "-")), 10_000, "old descriptors closed: " + open().filter((l) => l.includes(path.basename(file))).join(","));
});

test("a process heals at most once in its heal interval: a new generation found damaged at once waits", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const s = mk(file, { healEveryMs: 60_000 });
  await s.mayScan();
  await capture(async () => (s as Any).heal("first"));
  assert.equal(s.storeFile, file + ".gen1");
  const { lines } = await capture(async () => (s as Any).heal("second"));
  assert.equal(s.storeFile, file + ".gen1", "no second heal within the interval");
  assert.ok(lines.some((l) => /heal/.test(l) && /again/.test(l)), lines.join("\n"));
  (s as Any).healAt = 0; // the interval has passed
  await capture(async () => (s as Any).heal("third"));
  assert.equal(s.storeFile, file + ".gen2");
  assert.ok(!fs.existsSync(file + ".gen1"));
});

test("a new generation gives free pages back in steps while the writer works", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const s = mk(file, { vacuumMinFreePages: 64 });
  await s.mayScan();
  await capture(async () => (s as Any).heal("test damage"));
  await until(() => s.isWriter, 10_000, "writer");
  const post = (m: Any) => (s as Any).post(m, false);
  await post({ op: "exec", sql: "CREATE TABLE junk (x BLOB)", params: [] });
  for (let i = 0; i < 40; i++) await post({ op: "exec", sql: "INSERT INTO junk VALUES (randomblob(100000))", params: [] });
  await post({ op: "exec", sql: "DROP TABLE junk", params: [] });
  const free = () => Number(((s as Any).post({ op: "read", sql: "PRAGMA freelist_count", params: [] }, true) as Promise<Any>).then((r: Any) => r[0].freelist_count));
  const f0 = await (s as Any).post({ op: "read", sql: "PRAGMA freelist_count", params: [] }, true);
  assert.ok(Number(f0[0].freelist_count) > 500, JSON.stringify(f0));
  await until(async () => {
    await post({ op: "exec", sql: "DELETE FROM dirty WHERE path = '/none'", params: [] }); // a write: the writer looks at the free pages after it
    const r = await (s as Any).post({ op: "read", sql: "PRAGMA freelist_count", params: [] }, true);
    return Number(r[0].freelist_count) < 64;
  }, 30_000, "free pages given back");
  void free;
});

test("a store under the old name that is mostly free pages is compacted once into a new generation", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const s0 = mk(file);
  await s0.mayScan();
  await s0.close();
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE junk (x BLOB)");
  d.exec("BEGIN");
  for (let i = 0; i < 40; i++) d.prepare("INSERT INTO junk VALUES (randomblob(100000))").run();
  d.exec("COMMIT");
  d.exec("DROP TABLE junk");
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  d.close();
  const { lines } = await capture(async () => {
    const s = mk(file, { compactMinFreeBytes: 1 << 20 });
    await until(() => s.storeFile === file + ".gen1" && healthy(s), 30_000, "compacted");
  });
  assert.equal(lines.filter((l) => /compact/.test(l) && l.includes(file + ".gen1")).length, 1, lines.join("\n"));
  assert.ok(!fs.existsSync(file));
});

test("a switch while reads and marks keep coming: no worker stays on the old file, new rows go to the new generation", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = tree();
  const s = mk(file, { readDelayMs: 300 });
  await s.mayScan();
  await s.scanRead(v);
  let busy = true;
  const load = (async () => {
    while (busy) {
      s.markStale(v + "/a");
      await s.tree(v, 1, false).catch(() => undefined);
      await sleep(5);
    }
  })();
  await sleep(100);
  await capture(async () => (s as Any).heal("test damage"));
  await sleep(500);
  busy = false;
  await load;
  assert.equal(s.storeFile, file + ".gen1");
  const open = () =>
    fs.readdirSync("/proc/self/fd").flatMap((fd) => {
      try {
        return [fs.readlinkSync(`/proc/self/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  await until(() => !open().some((l) => l.includes(path.basename(file)) && l.endsWith("(deleted)")), 10_000, "no deleted file open: " + open().filter((l) => l.includes(path.basename(file))).join(","));
  await until(() => !s.health().damaged && s.health().available, 10_000, "healthy");
  assert.ok(!fs.existsSync(file + ".gen2"), "no second heal: " + filesOf(file).join(","));
  assert.ok((await s.scanRead(v)).read > 0);
  assert.ok(rowsOf(file + ".gen1") >= 5, "rows are in the new generation");
});

test("a copy an operator renamed to <name>.1 is never taken for a store", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const v = tree();
  const s0 = mk(file);
  await s0.mayScan();
  await s0.scanRead(v);
  await s0.close();
  fs.writeFileSync(file + ".1", "a damaged copy set aside by hand");
  const s = mk(file);
  assert.equal(s.storeFile, file);
  await s.mayScan();
  assert.equal((await s.scanRead(v)).read, 0, "the cache under the old name is kept");
  assert.ok(fs.existsSync(file + ".1"), "the copy is not touched");
});

test("close during a switch whose old worker is stuck in a long read does not hang", async () => {
  const file = path.join(tmp, `s${n++}.db`);
  const s = mk(file);
  await s.mayScan();
  // from here the reader naps 8 s inside each read (a new reader is started with that)
  (s as Any).o.readDelayMs = 8000;
  await (s as Any).reader?.terminate();
  (s as Any).reader = undefined;
  void s.tree("/", 1, false).catch(() => undefined); // the reader naps 8 s inside its step
  await sleep(200);
  const t0 = Date.now();
  void capture(async () => (s as Any).heal("test damage"));
  await sleep(50);
  await s.close();
  assert.ok(Date.now() - t0 < 6000, `close took ${Date.now() - t0} ms`);
});
