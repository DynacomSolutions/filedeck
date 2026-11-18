import type { DatabaseSync } from "node:sqlite";

let seq = 0;

/**
 * Runs `fn` in a transaction: its own (`BEGIN IMMEDIATE`) when none is open, or a savepoint inside the caller's, so the caller's
 * commit or rollback decides. When `fn` throws, only what `fn` wrote is undone, and the error is thrown on. If SQLite has already
 * ended the transaction itself (an I/O or full-disk error can do that), nothing more is run, so the real error is not hidden.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (!db.isTransaction) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  const sp = `filedeck_sp_${++seq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    }
    throw e;
  }
}
