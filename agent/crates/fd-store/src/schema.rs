//! The SQLite schema. It is the schema of the TypeScript store (`size-store.ts`, `SCHEMA`), table for table,
//! so one store file can be read by either agent.

use rusqlite::Connection;

use crate::sums::METRICS;

/// Counters added after the first version: they carry `DEFAULT 0` so an older file can be upgraded in place.
const LINK_METRICS: [&str; 2] = ["links", "link_checked"];

fn metric_column(prefix: &str, metric: &str) -> String {
    let default = if LINK_METRICS.contains(&metric) {
        " DEFAULT 0"
    } else {
        ""
    };
    format!("{prefix}_{metric} INTEGER NOT NULL{default}")
}

fn columns(prefix: &str) -> String {
    METRICS
        .iter()
        .map(|m| metric_column(prefix, m))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every column of `sizes`, in the order `Row` reads them.
pub(crate) fn row_columns() -> Vec<String> {
    let mut v: Vec<String> = [
        "path",
        "parent",
        "ino",
        "dev",
        "mtime_ms",
        "scanned_at",
        "seen_at",
        "ver",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    v.extend(METRICS.iter().map(|m| format!("own_{m}")));
    v.extend(METRICS.iter().map(|m| format!("tot_{m}")));
    v
}

fn ddl() -> String {
    format!(
        "
  CREATE TABLE IF NOT EXISTS sizes (
    path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER, seen_at INTEGER NOT NULL DEFAULT 0,
    ver INTEGER NOT NULL DEFAULT 0,
    {own}, {tot}
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS sizes_parent ON sizes(parent);
  CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY, due_at INTEGER NOT NULL, last_run INTEGER, taker INTEGER) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS pending_due ON pending(due_at);
  CREATE INDEX IF NOT EXISTS pending_idle_run ON pending(due_at, last_run);
  CREATE TABLE IF NOT EXISTS stale_trees (path TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS dirty (path TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS validated (path TEXT PRIMARY KEY, started INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, owner TEXT NOT NULL, beat INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS walking (path TEXT PRIMARY KEY, epoch INTEGER NOT NULL, started INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS watch_sessions (id INTEGER PRIMARY KEY, mounts_hash TEXT NOT NULL, ready_at INTEGER NOT NULL, since INTEGER NOT NULL, beat INTEGER NOT NULL, ended_at INTEGER, clean INTEGER NOT NULL DEFAULT 0, min_epoch INTEGER);
  CREATE INDEX IF NOT EXISTS watch_sessions_mounts ON watch_sessions(mounts_hash, id);
  CREATE TABLE IF NOT EXISTS partial (path TEXT PRIMARY KEY, parent TEXT NOT NULL, dev REAL, walk TEXT NOT NULL, at INTEGER NOT NULL, {tot}) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS mountpoints (path TEXT PRIMARY KEY, parent TEXT NOT NULL, dev REAL) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS mountpoints_parent ON mountpoints(parent);
",
        own = columns("own"),
        tot = columns("tot")
    )
}

/// The clock of the writer, in milliseconds, as SQLite reads it (the unit of `Date.now()` in the TypeScript store).
const NOW_MS: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/// A process of an older TypeScript version that does not know dirty marks must not lose a change unseen: these
/// triggers leave a dirty mark when it drops or takes a pending row. They are part of the shared file, so they stay.
fn triggers() -> String {
    format!(
        "
  CREATE TRIGGER IF NOT EXISTS pending_dropped AFTER DELETE ON pending WHEN old.due_at < 9007199254740991 OR old.taker IS NOT NULL
  BEGIN INSERT INTO dirty (path, at) VALUES (old.path, {NOW_MS}) ON CONFLICT(path) DO UPDATE SET at = MAX(at + 1, excluded.at); END;
  CREATE TRIGGER IF NOT EXISTS pending_taken AFTER UPDATE OF due_at ON pending WHEN new.due_at = 9007199254740991 AND old.due_at < 9007199254740991 AND new.taker IS NOT new.last_run
  BEGIN INSERT INTO dirty (path, at) VALUES (new.path, {NOW_MS}) ON CONFLICT(path) DO UPDATE SET at = MAX(at + 1, excluded.at); END;
"
    )
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        if r.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column(conn: &Connection, table: &str, column: &str, def: &str) -> rusqlite::Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {def}"))?;
    }
    Ok(())
}

/// Create the tables, and bring a file of an older version up to this one.
pub(crate) fn apply(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&ddl())?;
    add_column(conn, "sizes", "ver", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "sizes", "seen_at", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "validated", "epoch", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "pending", "taker", "INTEGER")?;
    for m in LINK_METRICS {
        for (table, prefix) in [("sizes", "own"), ("sizes", "tot"), ("partial", "tot")] {
            add_column(
                conn,
                table,
                &format!("{prefix}_{m}"),
                "INTEGER NOT NULL DEFAULT 0",
            )?;
        }
    }
    conn.execute_batch(&triggers())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_applies_twice_and_upgrades_a_file_without_link_columns() {
        let c = Connection::open_in_memory().unwrap();
        apply(&c).unwrap();
        apply(&c).unwrap();
        assert!(has_column(&c, "sizes", "own_link_checked").unwrap());
        // an older file: no ver, no link columns
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(
            "CREATE TABLE sizes (path TEXT PRIMARY KEY, parent TEXT NOT NULL, ino REAL, dev REAL, mtime_ms REAL, scanned_at INTEGER,
               own_bytes INTEGER NOT NULL, tot_bytes INTEGER NOT NULL) WITHOUT ROWID;",
        )
        .unwrap();
        add_column(&old, "sizes", "ver", "INTEGER NOT NULL DEFAULT 0").unwrap();
        assert!(has_column(&old, "sizes", "ver").unwrap());
    }

    #[test]
    fn row_columns_follow_the_metric_order() {
        let c = row_columns();
        assert_eq!(c.len(), 28);
        assert_eq!(c[8], "own_bytes");
        assert_eq!(c[18], "tot_bytes");
    }
}
