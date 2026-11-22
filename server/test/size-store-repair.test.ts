// A malformed size store whose quick_check names only indexes is repaired by the writer (REINDEX); real table damage is healed into a new generation (size-store-heal.test.ts).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SizeStore as RealSizeStore } from "../src/size-store.ts";
// every store a test opens is closed at the end of the file, even when an assertion threw first (an open file-backed store keeps a writer thread, and with it the process, alive)
const openStores: { close(): Promise<void> | void }[] = [];
class SizeStore extends RealSizeStore {
  constructor(...a: ConstructorParameters<typeof RealSizeStore>) {
    super(...a);
    openStores.push(this);
  }
}

const test = ((name: string, fn: (t: never) => unknown) => nodeTest(name, { timeout: 120_000 }, fn as never)) as typeof nodeTest;
type Any = any;
let tmp: string;
let n = 0;
const stores: SizeStore[] = [];
before(() => void (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-repair-")))));
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const s of openStores) await Promise.resolve(s.close()).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Setup rows in one transaction: each autocommitted insert is a disk sync, and on a host with a busy disk dozens of them add up to minutes. */
const inTxn = (db: DatabaseSync, fn: () => void) => {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};

/** A store file whose `pending` table has rows but whose index `pending_due` is an empty b-tree: quick_check says only "wrong # of entries in index pending_due". */
function corruptIndex(extra?: (db: DatabaseSync, file: string) => void): string {
  const file = path.join(tmp, `s${n++}.db`);
  let db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("CREATE TABLE pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER, taker INTEGER) WITHOUT ROWID; CREATE TABLE donor(x); CREATE INDEX pending_due ON donor(x);");
  inTxn(db, () => {
    for (let i = 0; i < 50; i++) db.prepare("INSERT INTO pending VALUES (?, ?, NULL, NULL)").run(`/p${i}`, i + 1);
  });
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
    for (let i = 0; i < 1500 && check(file).join() !== "ok"; i++) await sleep(50);
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

test("real table damage is healed: a new generation replaces the file (no operator step), the damaged page is never rewritten in place", async () => {
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
  // a process that still has the damaged file open sees it unchanged: the heal never writes into it, it only deletes its name
  const held = fs.openSync(file, "r");
  const bytes = fs.readFileSync(file);
  const { lines } = await capture(async () => {
    const s = mk(file);
    await s.mayScan();
    await s.clearPending().catch(() => undefined);
    for (let i = 0; i < 600 && (s.storeFile !== file + ".gen1" || !s.health().available); i++) await sleep(50);
  });
  const s = stores.at(-1) as Any;
  assert.ok(!lines.some((l) => /rebuilt/.test(l)), lines.join("\n"));
  assert.equal(lines.filter((l) => /was damaged/.test(l) && l.includes(file) && l.includes(file + ".gen1")).length, 1, lines.join("|"));
  assert.ok(!lines.some((l) => /Stop the agent|move the file/.test(l)), lines.join("|"));
  assert.ok(!fs.existsSync(file), "the damaged file's name is gone");
  assert.deepEqual(s.health(), { available: true, damaged: false });
  const kept = Buffer.alloc(bytes.length);
  fs.readSync(held, kept, 0, bytes.length, 0);
  fs.closeSync(held);
  assert.equal(kept.subarray((root - 1) * size, root * size).compare(bytes.subarray((root - 1) * size, root * size)), 0, "the damaged table page is untouched");
  assert.deepEqual(check(file + ".gen1"), ["ok"]);
  await s.clearPending();
});


const malformed = () => Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
/** a store file with the real schema (the store creates it), closed again */
async function schemaFile(rows = 50): Promise<string> {
  const file = path.join(tmp, `s${n++}.db`);
  const s0 = new SizeStore(file, { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 5000 });
  await s0.mayScan();
  await s0.close();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=DELETE");
  inTxn(db, () => {
    for (let i = 0; i < rows; i++) db.prepare("INSERT OR REPLACE INTO pending (path, due_at, last_run) VALUES (?, ?, ?)").run(`/p${i}`, 1000 - i, i);
  });
  db.close();
  return file;
}
const integrity = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("PRAGMA integrity_check(20)").all() as Any[]).map((r) => String(r.integrity_check));
  } finally {
    db.close();
  }
};

test("two indexes whose contents are swapped (equal counts: quick_check says ok) are found by integrity_check and rebuilt", async () => {
  const file = await schemaFile();
  const d = new DatabaseSync(file);
  const root = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [a, b] = [root("pending_due"), root("pending_idle_run")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${b} WHERE name='pending_due'; UPDATE sqlite_master SET rootpage=${a} WHERE name='pending_idle_run'; PRAGMA writable_schema=OFF;`);
  d.close();
  assert.deepEqual(check(file), ["ok"], "quick_check does not compare index contents");
  assert.notDeepEqual(integrity(file), ["ok"]);
  const { lines } = await capture(async () => {
    const s = mk(file);
    await s.mayScan();
    (s as Any).giveUp(malformed());
    await (s as Any).repairing;
  });
  assert.deepEqual(integrity(file), ["ok"]);
  assert.equal(lines.filter((l) => /rebuilt indexes pending_due, pending_idle_run|rebuilt indexes pending_idle_run, pending_due/.test(l)).length, 1, lines.join("\n"));
});

test("a table that lost rows (its indexes hold more entries) is not 'repaired' with REINDEX (that would hide the loss): it is healed into a new generation", async () => {
  const file = await schemaFile(50);
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE donor (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER, taker INTEGER) WITHOUT ROWID");
  inTxn(d, () => {
    for (let i = 0; i < 40; i++) d.prepare("INSERT INTO donor VALUES (?, ?, ?, NULL)").run(`/p${i}`, 1000 - i, i);
  });
  const rootOf = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [donor, own] = [rootOf("donor"), rootOf("pending")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${donor} WHERE name='pending'; UPDATE sqlite_master SET rootpage=${own} WHERE name='donor'; PRAGMA writable_schema=OFF;`);
  d.close();
  const msgs = integrity(file);
  assert.ok(msgs.every((m) => /^wrong # of entries in index/.test(m)), msgs.join("\n")); // the report alone looks like index-only damage
  const { lines } = await capture(async () => {
    const s = mk(file);
    await s.mayScan();
    (s as Any).giveUp(malformed());
    await (s as Any).repairing;
    await (s as Any).healing;
  });
  assert.ok(!lines.some((l) => /rebuilt/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /more entries than its table/.test(l)), lines.join("\n"));
  const s = stores.at(-1)!;
  for (let i = 0; i < 600 && s.storeFile !== file + ".gen1"; i++) await sleep(50);
  assert.equal(s.storeFile, file + ".gen1");
  assert.ok(!fs.existsSync(file));
});

test("the one repair attempt is not spent by a process that is not the writer", async () => {
  const file = await schemaFile();
  const d = new DatabaseSync(file);
  const root = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [a, b] = [root("pending_due"), root("pending_idle_run")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${b} WHERE name='pending_due'; UPDATE sqlite_master SET rootpage=${a} WHERE name='pending_idle_run'; PRAGMA writable_schema=OFF;`);
  d.close();
  const o = { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 60_000 };
  const A = new SizeStore(file, o);
  stores.push(A);
  await A.mayScan();
  const B = new SizeStore(file, o);
  stores.push(B);
  await B.mayScan();
  assert.ok((A as Any).isWriter && !(B as Any).isWriter);
  (B as Any).giveUp(malformed()); // B meets the damage while A holds the lease
  await (B as Any).repairing;
  assert.notDeepEqual(integrity(file), ["ok"], "a non-holder repairs nothing");
  assert.equal((B as Any).repaired, false);
  await A.close(); // the holder leaves and releases the lease
  await sleep(100);
  const { lines } = await capture(async () => {
    (B as Any).giveUp(malformed()); // B, now able to take the lease, meets it again
    await (B as Any).repairing;
  });
  assert.deepEqual(integrity(file), ["ok"], lines.join("\n"));
});

test("a corrupt file at open heals: not SQLite, or table damage the open itself trips over, is replaced by a new generation", async () => {
  const garbage = path.join(tmp, `garbage${n++}.db`);
  fs.writeFileSync(garbage, "this is not a database ".repeat(200));
  const { lines } = await capture(async () => {
    const s = mk(garbage);
    assert.equal(s.persistent, false);
    for (let i = 0; i < 600 && (s.storeFile !== garbage + ".gen1" || !s.persistent); i++) await sleep(50);
  });
  assert.ok(lines.some((l) => /size store unavailable/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /was damaged/.test(l) && l.includes(garbage)), lines.join("\n"));
  assert.ok(!fs.existsSync(garbage));
  assert.equal(stores.at(-1)!.persistent, true);
  // damage the open itself trips over (it reads stale_trees)
  const file = await schemaFile();
  const d = new DatabaseSync(file);
  inTxn(d, () => {
    for (let i = 0; i < 40; i++) d.prepare("INSERT INTO stale_trees VALUES (?, ?)").run(`/s${i}`, i);
  });
  const root = Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = 'stale_trees'").get() as Any).r);
  const size = Number((d.prepare("PRAGMA page_size").get() as Any).page_size);
  d.close();
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(120, 0xff), 0, 120, root * size - 120);
  fs.closeSync(fd);
  const { lines: l2 } = await capture(async () => {
    const s = mk(file);
    assert.equal(s.persistent, false);
    for (let i = 0; i < 600 && (s.storeFile !== file + ".gen1" || !s.persistent); i++) await sleep(50);
  });
  assert.ok(l2.some((l) => /was damaged/.test(l)), l2.join("\n"));
  assert.equal(stores.at(-1)!.storeFile, file + ".gen1");
});


test("a repair fenced because the lease lapsed during the first check does not spend the one attempt: a later try repairs", async () => {
  const file = await schemaFile();
  const d = new DatabaseSync(file);
  const root = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [a, b] = [root("pending_due"), root("pending_idle_run")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${b} WHERE name='pending_due'; UPDATE sqlite_master SET rootpage=${a} WHERE name='pending_idle_run'; PRAGMA writable_schema=OFF;`);
  d.close();
  const A = new SizeStore(file, { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 60_000 });
  stores.push(A);
  await A.mayScan();
  // another process takes the lease just before the repair's write transaction (what a check longer than the lease lets happen)
  const post = (A as Any).post.bind(A);
  let steal = true;
  (A as Any).post = async (m: Any, read: boolean) => {
    if (m.op === "repair" && steal) {
      steal = false;
      const x = new DatabaseSync(file);
      x.exec("UPDATE writer SET epoch = epoch + 1, owner = 'other', beat = " + Date.now() + ", released = 0 WHERE id = 1");
      x.close();
    }
    return post(m, read);
  };
  // a busy moment ("database is locked") can end an attempt before the fence is reached: try again, stealing the lease again, until one attempt is fenced
  const first = { lines: [] as string[] };
  for (const end = Date.now() + 15_000; !first.lines.some((l) => /repair not done/.test(l)) && Date.now() < end; ) {
    steal = true;
    const one = await capture(async () => {
      (A as Any).giveUp(malformed());
      await (A as Any).repairing;
    });
    first.lines.push(...one.lines);
    if (!first.lines.some((l) => /repair not done/.test(l))) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((A as Any).repaired, false, "a fenced repair is not counted");
  assert.notDeepEqual(integrity(file), ["ok"]);
  assert.ok(first.lines.some((l) => /repair not done/.test(l)), first.lines.join("\n"));
  // the other process leaves; the next failure of the store repairs it
  const x = new DatabaseSync(file);
  x.exec("UPDATE writer SET released = 1 WHERE id = 1");
  x.close();
  // a busy database ("database is locked", a loaded host holding a connection longer) is not a repair either: the next failure of the store tries again
  const second = await capture(async () => {
    // tries spread over up to 15 s: back to back, all of them can fall in one busy moment of a loaded build host (seen in the image build)
    for (const end = Date.now() + 15_000; !(A as Any).repaired && Date.now() < end; ) {
      (A as Any).giveUp(malformed());
      await (A as Any).repairing;
      if (!(A as Any).repaired) await new Promise((r) => setTimeout(r, 100));
    }
  });
  assert.deepEqual(integrity(file), ["ok"], second.lines.join("\n"));
  assert.equal((A as Any).repaired, true);
});

test("an error that is not damage (disk I/O error) in the check keeps the file and the attempt: nothing is marked damaged", async () => {
  const file = await schemaFile();
  const s = mk(file);
  await s.mayScan();
  const post = (s as Any).post.bind(s);
  (s as Any).post = async (m: Any, read: boolean) => {
    if (m.op === "check") throw new Error("disk I/O error");
    return post(m, read);
  };
  const { lines } = await capture(async () => {
    (s as Any).giveUp(malformed());
    await (s as Any).repairing;
  });
  assert.equal((s as Any).repaired, false, "tried again later");
  assert.equal((s as Any).damaged, false);
  assert.ok(lines.some((l) => /disk I\/O error/.test(l) && /file is kept as it is/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /is damaged/.test(l)));
  assert.equal(fs.readdirSync(tmp).filter((f) => /corrupt/.test(f)).length, 0);
});

test("a healthy store reports itself available and not damaged", async () => {
  const file = await schemaFile();
  const s = mk(file);
  await s.mayScan();
  assert.deepEqual(s.health(), { available: true, damaged: false });
});

test("a long integrity check does not lose the lease: the writer keeps beating and the repair is not fenced", async () => {
  const file = await schemaFile();
  const d = new DatabaseSync(file);
  const root = (name: string) => Number((d.prepare("SELECT rootpage r FROM sqlite_master WHERE name = ?").get(name) as Any).r);
  const [a, b] = [root("pending_due"), root("pending_idle_run")];
  d.exec(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${b} WHERE name='pending_due'; UPDATE sqlite_master SET rootpage=${a} WHERE name='pending_idle_run'; PRAGMA writable_schema=OFF;`);
  d.close();
  const o = { root: tmp, ttlMs: 3_600_000, maxEntries: 1000, leaseMs: 3000 };
  const A = new SizeStore(file, o);
  stores.push(A);
  await A.mayScan();
  assert.ok((A as Any).isWriter, "A holds the lease");
  const B = new SizeStore(file, o); // would take the lease the moment A's beats stop
  stores.push(B);
  await B.mayScan();
  const post = (A as Any).post.bind(A);
  (A as Any).post = async (m: Any, read: boolean) => {
    const r = await post(m, read);
    if (m.op === "check" && !(A as Any).slowed) {
      (A as Any).slowed = true;
      await sleep(7000); // a check longer than two leases
    }
    return r;
  };
  const { lines } = await capture(async () => {
    (A as Any).giveUp(malformed());
    await (A as Any).repairing;
  });
  assert.deepEqual(integrity(file), ["ok"], lines.join("\n"));
  assert.ok(!(B as Any).isWriter, "the partner never took the lease");
  assert.ok(!lines.some((l) => /repair not done/.test(l)), lines.join("\n"));
});

test("the heal line is one line even when the check reports many problems", async () => {
  const file = path.join(tmp, "oneline.db");
  const s = mk(file);
  await s.mayScan();
  const why = ["*** in database main ***", "On tree page 2 cell 49: Extends off end of page", "On tree page 2 cell 48: Extends off end of page", "On tree page 2 cell 47: Extends off end of page", "On tree page 2 cell 46: Extends off end of page"].join("\n");
  const { lines } = await capture(async () => {
    (s as Any).markDamaged(why);
    await (s as Any).healing;
  });
  const hit = lines.filter((l) => /was damaged/.test(l));
  assert.equal(hit.length, 1, lines.join("|"));
  assert.ok(!hit[0]!.includes("\n"), hit[0]);
  assert.ok(hit[0]!.includes("oneline.db was damaged"), hit[0]);
  assert.match(hit[0]!, /cell 48: Extends off end of page; and 2 more\); it is deleted and a new store .*oneline\.db\.gen1 is used\. Folder sizes are measured again\./);
});
