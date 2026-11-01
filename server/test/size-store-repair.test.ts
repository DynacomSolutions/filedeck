// A malformed size store whose quick_check names only indexes is repaired by the writer (REINDEX); real table damage leaves the file alone.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore } from "../src/size-store.ts";

const test = ((name: string, fn: (t: never) => unknown) => nodeTest(name, { timeout: 60_000 }, fn as never)) as typeof nodeTest;
type Any = any;
let tmp: string;
let n = 0;
const stores: SizeStore[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-repair-")))));
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store file whose `pending` table has rows but whose index `pending_due` is an empty b-tree: quick_check says only "wrong # of entries in index pending_due". */
function corruptIndex(extra?: (db: DatabaseSync, file: string) => void): string {
  const file = path.join(tmp, `s${n++}.db`);
  let db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("CREATE TABLE pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER, taker INTEGER) WITHOUT ROWID; CREATE TABLE donor(x); CREATE INDEX pending_due ON donor(x);");
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO pending VALUES (?, ?, NULL, NULL)").run(`/p${i}`, i + 1);
  db.exec("CREATE INDEX pending_idle_run ON pending(due_at, last_run)"); // (the store creates a missing index when it opens, which reads the table)
  db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET tbl_name='pending', sql='CREATE INDEX pending_due ON pending(due_at)' WHERE name='pending_due'; PRAGMA writable_schema=OFF;");
  db.close();
  if (extra) {
    db = new DatabaseSync(file);
    extra(db, file);
    db.close();
  }
  return file;
}
const check = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("PRAGMA quick_check").all() as Any[]).map((r) => String(r.quick_check));
  } catch (e) {
    return [`error: ${(e as Error).message}`]; // (a damaged page can make the check itself fail)
  } finally {
    db.close();
  }
};
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
const mk = (file: string) => {
  const s = new SizeStore(file, { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 5000 });
  stores.push(s);
  return s;
};

test("a store whose only damage is an index is repaired by the writer: one log line, the data kept, the store usable again", async () => {
  const file = corruptIndex();
  assert.deepEqual(check(file), ["wrong # of entries in index pending_due"]);
  const { lines } = await capture(async () => {
    const s = mk(file);
    await s.mayScan(); // takes the lease
    await s.clearPending(); // a DELETE on pending: malformed on the broken index, which sends the store to the repair
    for (let i = 0; i < 100 && check(file).length; i++) await sleep(50);
    await sleep(100);
  });
  assert.deepEqual(check(file), ["ok"]);
  assert.equal(lines.filter((l) => /rebuilt index pending_due/.test(l)).length, 1, lines.join("\n"));
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(Number((db.prepare("SELECT COUNT(*) c FROM pending").get() as Any).c), 50);
  db.close();
  // and the store works again at its next use
  const s = stores.at(-1)!;
  (s as Any).retryAt = Date.now();
  await (s as Any).reopen();
  assert.ok((s as Any).db, "store reopened");
  await s.clearPending();
});

test("real table damage is left alone: the file is kept as it is and the store stays unavailable", async () => {
  const file = corruptIndex();
  // as well as the index, break a leaf page of the table: its last cells are overwritten
  const d = new DatabaseSync(file, { readOnly: true });
  const root = Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = 'pending'").get() as Any).r);
  const size = Number((d.prepare("PRAGMA page_size").get() as Any).page_size);
  d.close();
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(120, 0xff), 0, 120, root * size - 120);
  fs.closeSync(fd);
  const before = check(file);
  assert.ok(before.length > 1 || !/index pending_due$/.test(before[0]!), before.join("\n"));
  const bytes = fs.readFileSync(file);
  const { lines } = await capture(async () => {
    const s = mk(file);
    await s.mayScan();
    await s.clearPending().catch(() => undefined);
    await sleep(500);
  });
  assert.ok(fs.existsSync(file), "the file is never deleted");
  assert.ok(!lines.some((l) => /rebuilt/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /size store unavailable/.test(l)), "[" + lines.join("|") + "]");
  assert.ok(!(stores.at(-1) as Any).db, "still unavailable");
  const after = fs.readFileSync(file);
  assert.equal(after.subarray((root - 1) * size, root * size).compare(bytes.subarray((root - 1) * size, root * size)), 0, "the damaged table page is untouched");
  assert.notDeepEqual(check(file), ["ok"]);
});
