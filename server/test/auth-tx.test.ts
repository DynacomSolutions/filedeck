import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../src/auth/tx.ts";

type Fake = { isTransaction: boolean; calls: string[]; exec(sql: string): void };

/** A stand-in for DatabaseSync: records each exec; BEGIN opens a transaction. */
function fake(): Fake {
  const f: Fake = {
    isTransaction: false,
    calls: [],
    exec(sql: string) {
      f.calls.push(sql);
      if (/^BEGIN/.test(sql)) f.isTransaction = true;
      if (/^(COMMIT|ROLLBACK)$/.test(sql)) f.isTransaction = false;
    },
  };
  return f;
}

test("no ROLLBACK when SQLite has already rolled back: the real error comes through", () => {
  const f = fake();
  const real = new Error("database or disk is full");
  assert.throws(
    () =>
      inTransaction(f as unknown as DatabaseSync, () => {
        f.isTransaction = false; // SQLite ended the transaction itself
        throw real;
      }),
    (e: unknown) => e === real,
  );
  assert.deepEqual(f.calls, ["BEGIN IMMEDIATE"]);
});

test("ROLLBACK when the transaction is still open", () => {
  const f = fake();
  assert.throws(() =>
    inTransaction(f as unknown as DatabaseSync, () => {
      throw new Error("x");
    }),
  );
  assert.deepEqual(f.calls, ["BEGIN IMMEDIATE", "ROLLBACK"]);
});

test("a savepoint inside an open transaction; no ROLLBACK TO once SQLite has rolled back", () => {
  const f = fake();
  f.isTransaction = true;
  assert.equal(
    inTransaction(f as unknown as DatabaseSync, () => 7),
    7,
  );
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0]!, /^SAVEPOINT \w+$/);
  assert.equal(f.calls[1], f.calls[0]!.replace("SAVEPOINT", "RELEASE"));
  f.calls.length = 0;
  assert.throws(() =>
    inTransaction(f as unknown as DatabaseSync, () => {
      throw new Error("x");
    }),
  );
  assert.match(f.calls[1]!, /^ROLLBACK TO \w+$/);
  assert.match(f.calls[2]!, /^RELEASE \w+$/);
  f.calls.length = 0;
  const real = new Error("disk I/O error");
  assert.throws(
    () =>
      inTransaction(f as unknown as DatabaseSync, () => {
        f.isTransaction = false;
        throw real;
      }),
    (e: unknown) => e === real,
  );
  assert.equal(f.calls.length, 1, "only the SAVEPOINT");
});

test("real database: nested use commits with the outer transaction only", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v INTEGER)");
  inTransaction(db, () => {
    db.prepare("INSERT INTO t VALUES (1)").run();
    assert.throws(() =>
      inTransaction(db, () => {
        db.prepare("INSERT INTO t VALUES (2)").run();
        throw new Error("inner");
      }),
    );
    inTransaction(db, () => db.prepare("INSERT INTO t VALUES (3)").run());
  });
  assert.equal(db.isTransaction, false);
  assert.deepEqual(
    (db.prepare("SELECT v FROM t ORDER BY v").all() as { v: number }[]).map((r) => r.v),
    [1, 3],
  );
});
