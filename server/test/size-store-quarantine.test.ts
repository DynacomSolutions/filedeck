// A damaged size store is moved aside by exactly one process, under a cross-process mutex; every other process follows the path to the new file.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";

const test = ((name: string, fn: (t: never) => unknown) => nodeTest(name, { timeout: 120_000 }, fn as never)) as typeof nodeTest;
type Any = any;
let tmp: string;
let n = 0;
const stores: SizeStore[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-quarantine-")))));
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = (file: string, leaseMs = 5000) => {
  const s = new SizeStore(file, { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs });
  stores.push(s);
  return s;
};
const aside = (f: string) => fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + ".corrupt-") && !/-(wal|shm)$/.test(x)).sort().map((x) => path.join(path.dirname(f), x));
const isSqlite = (f: string) => fs.readFileSync(f).subarray(0, 15).toString() === "SQLite format 3";
const ino = (f: string) => { const s = fs.statSync(f); return `${s.dev}:${s.ino}`; };
const snapshot = (f: string) => [f, f + "-wal", f + "-shm"].map((x) => (fs.existsSync(x) ? fs.readFileSync(x).toString("hex") : null));
async function capture<T>(fn: () => Promise<T>): Promise<{ r: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { r: await fn(), lines };
  } finally {
    console.error = orig;
  }
}
const ic = (f: string) => {
  const d = new DatabaseSync(f, { readOnly: true });
  try {
    return (d.prepare("PRAGMA integrity_check").all() as Any[]).map((r) => String(r.integrity_check));
  } finally {
    d.close();
  }
};

test("the holder moves its file aside while a second process has it open: the second follows the path, nobody writes into the moved copy, no second move", async () => {
  const dir = path.join(tmp, `d${n++}`);
  fs.mkdirSync(path.join(dir, "root/a/b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "root/a/b/f"), "x".repeat(5000));
  const f = path.join(dir, "sizes.db");
  const o = { root: path.join(dir, "root"), ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 300 };
  const A = new SizeStore(f, o);
  stores.push(A);
  await A.mayScan();
  const B = new SizeStore(f, o);
  stores.push(B);
  await B.mayScan();
  assert.ok((A as Any).isWriter && !(B as Any).isWriter);
  const replaced = { A: 0, B: 0 };
  (A as Any).onReplaced = () => replaced.A++;
  (B as Any).onReplaced = () => replaced.B++;
  const before = ino(f);
  const { lines } = await capture(async () => {
    await (A as Any).quarantine(); // (the trigger is tested elsewhere: the step itself, with B holding the old file open)
    const q = aside(f);
    assert.equal(q.length, 1);
    const kept = snapshot(q[0]!);
    await sleep(1200); // B's view of A's lease (in the old file) would lapse by now
    await sleep(300);
    assert.notEqual(ino(f), before, "the path holds a new file");
    assert.deepEqual(snapshot(q[0]!), kept, "the moved copy is byte-unchanged by the processes that had it open");
    assert.equal(replaced.B, 1, "B followed the path");
    assert.equal(replaced.A, 1);
    // A starts again on the new file; exactly one of the two writes there
    await A.tree("/", 1, false).catch(() => undefined);
    await sleep(500);
    await Promise.all([A, B].map((x) => x.scan("/a/b").catch(() => undefined)));
    await sleep(500);
    assert.equal([A, B].filter((s) => (s as Any).isWriter).length, 1, "one writer");
    assert.deepEqual(ic(f), ["ok"]);
    assert.deepEqual(snapshot(q[0]!), kept, "still unchanged");
    const d = new DatabaseSync(f, { readOnly: true });
    assert.ok(Number((d.prepare("SELECT COUNT(*) c FROM sizes").get() as Any).c) > 0, "the new file received the scans");
    d.close();
    // B finds the old damage again and wants to move "its" file aside: the path holds a file it did not check, so it moves nothing
    await (B as Any).quarantine({ ino: ino(q[0]!) });
    assert.equal(aside(f).length, 1, "exactly one copy");
    assert.ok(isSqlite(f));
  });
  assert.equal(lines.filter((l) => /moved to/.test(l)).length, 1, lines.join("\n"));
});

test("two processes starting on a file that is not SQLite: one moves it, nobody moves the other's new store (10 rounds)", async () => {
  for (let round = 0; round < 10; round++) {
    const f = path.join(tmp, `g${n++}.db`);
    const bytes = Buffer.from("this is not a database ".repeat(200));
    fs.writeFileSync(f, bytes);
    const { r } = await capture(async () => {
      const A = mk(f);
      const B = mk(f);
      for (let i = 0; i < 100 && !aside(f).length; i++) await sleep(50);
      await sleep(400);
      await A.tree("/", 1, false).catch(() => undefined);
      await B.tree("/", 1, false).catch(() => undefined);
      await sleep(300);
      return [A, B];
    });
    const a = aside(f);
    assert.equal(a.length, 1, `round ${round}: ${a.length} copies`);
    assert.ok(!isSqlite(a[0]!), `round ${round}: a healthy SQLite file was moved aside`);
    assert.equal(fs.readFileSync(a[0]!).compare(bytes), 0, "byte-identical");
    assert.ok(isSqlite(f), "a SQLite store at the path");
    assert.ok(r.every((s) => !!(s as Any).db), `round ${round}: both stores are cached`);
    for (const s of r) await s.close();
  }
});

test("an error that is not damage (disk I/O error) in the check keeps the file and the attempt: nothing is moved aside", async () => {
  const f = path.join(tmp, `io${n++}.db`);
  const s0 = mk(f);
  await s0.mayScan();
  await s0.close();
  const bytes = fs.readFileSync(f);
  const s = mk(f);
  await s.mayScan();
  const post = (s as Any).post.bind(s);
  (s as Any).post = async (m: Any, read: boolean) => {
    if (m.op === "check") throw new Error("disk I/O error");
    return post(m, read);
  };
  const { lines } = await capture(async () => {
    (s as Any).giveUp(Object.assign(new Error("database disk image is malformed"), { errcode: 11 }));
    await (s as Any).repairing;
  });
  assert.deepEqual(aside(f), []);
  assert.equal((s as Any).repaired, false, "tried again later");
  assert.ok(lines.some((l) => /disk I\/O error/.test(l)), lines.join("\n"));
  assert.equal(fs.readFileSync(f).compare(bytes), 0, "the file is as it was");
});

test("a process moves a damaged store aside once per 6 hours: the second time it stays uncached, the file is kept, the backoff grows", async () => {
  const f = path.join(tmp, `six${n++}.db`);
  const s0 = mk(f);
  await s0.mayScan();
  await s0.close();
  const s = mk(f);
  await s.mayScan();
  (s as Any).lastQuarantine = Date.now() - 60_000;
  const before = ino(f);
  const delay = (s as Any).retryDelay;
  const { lines } = await capture(async () => {
    await (s as Any).quarantine();
  });
  assert.deepEqual(aside(f), []);
  assert.equal(ino(f), before);
  assert.ok(lines.some((l) => /one move per 6 hours/.test(l)), lines.join("\n"));
  assert.equal((s as Any).retryDelay, delay * 2);
  // and after the window it moves again
  (s as Any).lastQuarantine = Date.now() - 7 * 3600_000;
  await (s as Any).quarantine({ ino: before }).catch(() => undefined);
  assert.equal(aside(f).length, 1);
});

test("a long integrity check does not lose the lease: the writer keeps beating and the repair is not fenced", async () => {
  const f = path.join(tmp, `beat${n++}.db`);
  const s0 = mk(f, 800);
  await s0.mayScan();
  await sleep(200);
  await s0.close();
  const d = new DatabaseSync(f);
  d.exec("PRAGMA journal_mode=DELETE");
  for (let i = 0; i < 50; i++) d.prepare("INSERT OR REPLACE INTO pending (path, due_at, last_run) VALUES (?, ?, ?)").run(`/p${i}`, 1000 - i, i);
  const root = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [a, b] = [root("pending_due"), root("pending_idle_run")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${b} WHERE name='pending_due'; UPDATE sqlite_master SET rootpage=${a} WHERE name='pending_idle_run'; PRAGMA writable_schema=OFF;`);
  d.close();
  const A = mk(f, 800);
  await A.mayScan();
  const B = mk(f, 800); // would take the lease the moment A's beats stop
  await B.mayScan();
  const post = (A as Any).post.bind(A);
  (A as Any).post = async (m: Any, read: boolean) => {
    const r = await post(m, read);
    if (m.op === "check" && !(A as Any).slowed) {
      (A as Any).slowed = true;
      await sleep(3000); // a check several leases long
    }
    return r;
  };
  const { lines } = await capture(async () => {
    (A as Any).giveUp(Object.assign(new Error("database disk image is malformed"), { errcode: 11 }));
    await (A as Any).repairing;
  });
  assert.deepEqual(ic(f), ["ok"], lines.join("\n"));
  assert.ok(!(B as Any).isWriter, "the partner never took the lease");
  assert.ok(!lines.some((l) => /repair not done/.test(l)), lines.join("\n"));
});
