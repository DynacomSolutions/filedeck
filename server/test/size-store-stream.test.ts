// Streamed du answers (SizeStore.treeEach), partial sizes of a running scan, a scan resumed after its process was killed, and mount points listed on their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SizeStore, tmp, at, sleep } from "./size-store-support.ts";
import type { DuEntry } from "../src/size-store.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const t0 = Date.now(); !(await f()) && Date.now() - t0 < ms; ) await sleep(20);
};
const METRICS = ["bytes", "disk", "files", "symlinks", "other", "dirs", "mounts", "errors"];

/** The answer as the level-by-level reader gave it before: a child is listed when its parent is, on the same device, down to `depth`. */
function reference(db: DatabaseSync, top: string, depth: number): string[] {
  const all = db.prepare("SELECT path, parent, dev FROM sizes").all() as { path: string; parent: string; dev: number }[];
  const t = all.find((r) => r.path === top);
  if (!t) return [];
  const out = [top];
  let level = [t];
  for (let d = 0; d < depth && level.length; d++) {
    const next = all.filter((k) => level.some((p) => p.path === k.parent && p.dev === k.dev));
    out.push(...next.map((k) => k.path));
    level = next;
  }
  return out.sort();
}

test("a streamed tree lists exactly what the level-by-level reader listed, across pages, odd names, other devices and orphans", async () => {
  // names that sort between a folder and its own children ("x-1", "x.d" come after "x" but before "x/..."), and a folder of 300 children (more than a page)
  for (const d of ["s/x/y/z", "s/x/y-2", "s/x-1/q", "s/x.d", "s/a/b/c/d/e", "s/x/y/z/w"]) fs.mkdirSync(at(d), { recursive: true });
  for (let i = 0; i < 300; i++) fs.mkdirSync(at(`s/p/n${String(i).padStart(3, "0")}/k`), { recursive: true });
  fs.writeFileSync(at("s/x/f"), "12345");
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
  await s.scan("/s");
  const db = (s as Any).db as DatabaseSync;
  const dev = (db.prepare("SELECT dev FROM sizes WHERE path = '/s'").get() as { dev: number }).dev;
  const put = db.prepare(`INSERT INTO sizes (path, parent, ino, dev, mtime_ms, scanned_at, seen_at, ver, ${METRICS.map((m) => `own_${m}`).join(",")}, ${METRICS.map((m) => `tot_${m}`).join(",")}) VALUES (?, ?, 1, ?, 1, 1, 1, 1, ${METRICS.map(() => "0").join(",")}, ${METRICS.map(() => "1").join(",")})`);
  put.run("/s/x/mnt", "/s/x", dev + 1); // a mount point scanned on its own
  put.run("/s/x/mnt/k", "/s/x/mnt", dev + 1);
  put.run("/s/x/mnt/k/same", "/s/x/mnt/k", dev); // the first device again, below the other one
  put.run("/s/ghost/k", "/s/ghost", dev); // its parent is not stored
  put.run("/s/x-1/q/deep", "/s/x-1/q", dev);
  for (const top of ["/s", "/s/x", "/s/p"])
    for (let depth = 0; depth <= 6; depth++) {
      const got = (await s.tree(top, depth, false)).entries.filter((e) => e.type === "dir").map((e) => e.path).sort();
      assert.deepEqual(got, reference(db, top, depth), `${top} depth ${depth}`);
    }
  s.close();
});

test("a streamed answer holds one page at a time: 200,000 entries in about one read per page, with flat memory", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "big-"));
  const file = path.join(dir, "sizes.db");
  new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 }).close(); // the schema
  await until(() => fs.existsSync(file));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  const put = db.prepare(`INSERT OR REPLACE INTO sizes (path, parent, ino, dev, mtime_ms, scanned_at, seen_at, ver, ${METRICS.map((m) => `own_${m}`).join(",")}, ${METRICS.map((m) => `tot_${m}`).join(",")}) VALUES (?, ?, 1, 7, 1, 1, 1, 1, ${METRICS.map(() => "0").join(",")}, ${METRICS.map(() => "1").join(",")})`);
  db.exec("BEGIN");
  put.run("/big", "/");
  let n = 1;
  for (let i = 0; i < 400; i++) {
    const a = `/big/d${String(i).padStart(3, "0")}`;
    put.run(a, "/big");
    n++;
    for (let j = 0; j < 500; j++, n++) put.run(`${a}/e${String(j).padStart(3, "0")}`, a);
  }
  db.exec("COMMIT");
  db.close();
  const s = new SizeStore(file, { root: tmp, ttlMs: 60_000, maxEntries: 1_000_000 });
  let reads = 0;
  const post = (s as Any).post.bind(s);
  (s as Any).post = (m: { op: string }, r: boolean) => (m.op === "read" && reads++, post(m, r));
  try {
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    let count = 0;
    let bytes = 0;
    const r = await s.treeEach("/big", 64, false, async (e: DuEntry) => {
      count++;
      bytes += e.bytes;
      if (count % 2000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
    });
    assert.equal(count, n);
    assert.equal(bytes, n);
    assert.equal(r.truncated, false);
    assert.ok(reads <= n / 256 + 10, `${reads} reads for ${n} entries`);
    // the reader it replaces held every row at once: about 4 KB per entry (52,000 entries raised RSS by 220 MB), so 800 MB here
    assert.ok(peak - rss0 < 100 << 20, `RSS grew by ${Math.round((peak - rss0) / 1048576)} MB`);
    // a shallow answer jumps over the subtrees below its depth instead of reading them
    reads = 0;
    assert.equal((await s.tree("/big", 1, false)).entries.length, 401);
    assert.ok(reads <= 420, `${reads} reads for a depth-1 answer`);
  } finally {
    await s.close();
  }
});

test("while a scan runs, the folders it has not finished answer with what it counted so far, flagged partial", async () => {
  fs.mkdirSync(at("pt/a"), { recursive: true });
  fs.mkdirSync(at("pt/z"), { recursive: true });
  fs.writeFileSync(at("pt/f"), "12345");
  fs.writeFileSync(at("pt/a/g"), "1234567890");
  fs.writeFileSync(at("pt/z/h"), "x".repeat(20));
  const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000, flushMs: 0 });
  const orig = fsp.readdir;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let held = false;
  (fsp as Any).readdir = async (...a: Any[]) => {
    if (String(a[0]) === at("pt/z")) {
      held = true;
      await gate;
    }
    return (orig as Any)(...a);
  };
  try {
    assert.equal((await s.tree("/pt", 1, false)).entries.length, 0, "nothing stored yet");
    const scan = s.scan("/pt");
    await until(() => held);
    await until(async () => (await s.tree("/pt", 1, false)).entries.length > 0);
    const t = await s.tree("/pt", 1, false);
    assert.equal(t.partial, true);
    const top = t.entries[0]!;
    assert.equal(top.path, "/pt");
    assert.equal(top.partial, true);
    // its own file is counted; "a" when it was read before "z" (directory order); never "z", which is being read
    assert.ok(top.bytes === 5 || top.bytes === 15, `partial bytes ${top.bytes}`);
    const a = t.entries.find((e) => e.path === "/pt/a");
    if (top.bytes === 15) assert.deepEqual([a?.bytes, a?.partial], [10, undefined]);
    open();
    assert.equal((await scan).bytes, 35);
    const done = await s.tree("/pt", 1, false);
    assert.equal(done.partial, undefined);
    assert.equal(done.entries[0]!.bytes, 35);
    assert.equal(((s as Any).db as DatabaseSync).prepare("SELECT COUNT(*) n FROM partial").get()!.n, 0, "the partial rows go when the walk ends");
  } finally {
    (fsp as Any).readdir = orig;
    open();
    s.close();
  }
});

test("a scan whose process was killed is resumed from the folders it had finished, not from zero", async () => {
  const root = fs.mkdtempSync(path.join(tmp, "resume-"));
  for (let i = 0; i < 30; i++) for (let j = 0; j < 4; j++) {
    fs.mkdirSync(path.join(root, "r", `d${i}`, `e${j}`), { recursive: true });
    fs.writeFileSync(path.join(root, "r", `d${i}`, `e${j}`, "f"), "123");
  }
  const file = path.join(root, "sizes.db");
  const since = Date.now();
  // the first process: every lstat is slow, it writes after each folder, and it is killed half way
  const child = spawn(process.execPath, ["--import", "tsx", "-e", `
    import fsp from "node:fs/promises";
    import { SizeStore } from ${JSON.stringify(path.resolve("src/size-store.ts"))};
    const l = fsp.lstat;
    fsp.lstat = async (...a) => (await new Promise((r) => setTimeout(r, 15)), l(...a));
    const s = new SizeStore(${JSON.stringify(file)}, { root: ${JSON.stringify(root)}, ttlMs: 1, maxEntries: 100000, flushMs: 0, commitChunk: 1, leaseMs: 300 });
    await s.scanRead("/r", undefined, false, undefined, undefined, ${since});
    console.log("finished");
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const committed = () => {
    if (!fs.existsSync(file)) return 0;
    try {
      const d = new DatabaseSync(file, { readOnly: true });
      try {
        return (d.prepare("SELECT COUNT(*) n FROM sizes WHERE parent LIKE '/r/%'").get() as { n: number }).n;
      } finally {
        d.close();
      }
    } catch {
      return 0;
    }
  };
  await until(() => committed() >= 40, 60_000);
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await gone;
  }
  assert.equal(out, "", "killed before it finished");
  const done = committed();
  assert.ok(done >= 40 && done < 120, `${done} folders committed`);
  // the next process takes the lease over (the dead one's lapses), and the job runs again with its start time: what was finished is kept,
  // although the rows are older than the store's age limit (1 ms here)
  const s = new SizeStore(file, { root, ttlMs: 1, maxEntries: 100_000, leaseMs: 300 });
  try {
    await s.whenWriter();
    const r = await s.scanRead("/r", undefined, false, undefined, undefined, since);
    assert.equal(r.res.files, 120);
    assert.equal(r.res.bytes, 360);
    assert.ok(r.read <= 151 - done + 31, `${r.read} folders read again, ${done} were finished`);
    assert.ok(r.read < 151, "not from zero");
  } finally {
    await s.close();
  }
});

test("mount points below a folder are listed on their own, never counted in it, also when they were never scanned", async () => {
  fs.mkdirSync(at("mp/mnt/inner"), { recursive: true });
  fs.writeFileSync(at("mp/own"), "12");
  fs.writeFileSync(at("mp/mnt/inner/big"), "x".repeat(1000));
  const [l, st] = [fsp.lstat, fsp.stat];
  const fake = (fn: Any) => async (p: string, ...a: Any[]) => {
    const s = await fn(p, ...a);
    if (String(p).startsWith(at("mp/mnt"))) Object.defineProperty(s, "dev", { value: s.dev + 1 });
    return s;
  };
  (fsp as Any).lstat = fake(l);
  (fsp as Any).stat = fake(st);
  try {
    const s = new SizeStore(":memory:", { root: tmp, ttlMs: 60_000, maxEntries: 100_000 });
    const r = await s.scan("/mp");
    assert.equal(r.bytes, 2);
    assert.equal(r.mountsSkipped, 1);
    const t = (await s.tree("/mp", 1, false)).entries;
    assert.deepEqual(t.map((e) => [e.path, e.type, e.scannedAt === undefined]), [["/mp", "dir", false], ["/mp/mnt", "mount", true]]);
    assert.equal(t[0]!.diskBytes, r.diskBytes, "the mount point's own folder is not in the disk total either");
    await s.scan("/mp/mnt");
    const m = (await s.tree("/mp", 1, false)).entries.find((e) => e.type === "mount")!;
    assert.deepEqual([m.bytes, m.scannedAt !== undefined], [1000, true], "with the size of its own scan once there is one");
    assert.equal((await s.tree("/mp", 0, false)).entries.length, 1, "depth 0: the folder alone");
    s.close();
  } finally {
    (fsp as Any).lstat = l;
    (fsp as Any).stat = st;
  }
});
