//! A stored folder row and the SQL that reads it.

use std::sync::LazyLock;

use rusqlite::Row as SqlRow;
use rusqlite::types::Value;

use crate::schema::row_columns;
use crate::sums::{METRICS, Sums};

/// One folder: its identity on disk, when it was read, its own counters and the totals of its subtree.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub path: String,
    pub parent: String,
    pub ino: f64,
    pub dev: f64,
    pub mtime_ms: f64,
    pub scanned_at: i64,
    /// start of the latest walk that wrote or confirmed this row (0 = unknown)
    pub seen_at: i64,
    /// epoch of the writer lease that wrote the row (0 = never vouched for)
    pub ver: i64,
    pub own: Sums,
    pub tot: Sums,
    /// number of stored child folders on its own device, when the read that gave this row counted them
    pub kids: Option<i64>,
    /// when the folder was marked dirty, when the read that gave this row looked
    pub dirty: Option<i64>,
    /// what a running walk had counted of an unfinished folder
    pub partial: bool,
}

pub(crate) static COLS: LazyLock<String> = LazyLock::new(|| {
    row_columns()
        .iter()
        .map(|c| format!("s.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
});

const KIDS: &str =
    "(SELECT COUNT(*) FROM sizes k WHERE k.parent = s.path AND k.dev = s.dev) AS kids";
const DIRTY: &str = "(SELECT d.at FROM dirty d WHERE d.path = s.path) AS dirty_at";

pub(crate) static SQL_GET: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, NULL, {DIRTY} FROM sizes s WHERE s.path = ?",
        *COLS
    )
});
pub(crate) static SQL_GET_KIDS: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, {KIDS}, {DIRTY} FROM sizes s WHERE s.path = ?",
        *COLS
    )
});
pub(crate) static SQL_KID_PAGE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, {KIDS}, {DIRTY} FROM sizes s WHERE s.parent = ? AND s.dev = ? AND s.path > ? ORDER BY s.path LIMIT ?",
        *COLS
    )
});
pub(crate) static SQL_TREE_AFTER: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, NULL, NULL FROM sizes s WHERE s.path > ? AND s.path < ? ORDER BY s.path LIMIT ?",
        *COLS
    )
});
pub(crate) static SQL_TREE_FROM: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, NULL, NULL FROM sizes s WHERE s.path >= ? AND s.path < ? ORDER BY s.path LIMIT ?",
        *COLS
    )
});
pub(crate) static SQL_PUT: LazyLock<String> = LazyLock::new(|| {
    let cols = row_columns();
    format!(
        "INSERT OR REPLACE INTO sizes ({}) VALUES ({})",
        cols.join(","),
        vec!["?"; cols.len()].join(",")
    )
});
pub(crate) static SQL_PARTIAL_PUT: LazyLock<String> = LazyLock::new(|| {
    let mut cols = vec!["path", "parent", "dev", "walk", "at"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    cols.extend(METRICS.iter().map(|m| format!("tot_{m}")));
    format!(
        "INSERT OR REPLACE INTO partial ({}) VALUES ({})",
        cols.join(","),
        vec!["?"; cols.len()].join(",")
    )
});
pub(crate) static SQL_PARTIAL_BELOW: &str = "SELECT path, parent, dev, at, tot_bytes, tot_disk, tot_files, tot_symlinks, tot_other, tot_dirs, tot_mounts, tot_errors, tot_links, tot_link_checked FROM partial WHERE path > ? AND path < ? ORDER BY path LIMIT 4096";
pub(crate) static SQL_PARTIAL_ONE: &str = "SELECT path, parent, dev, at, tot_bytes, tot_disk, tot_files, tot_symlinks, tot_other, tot_dirs, tot_mounts, tot_errors, tot_links, tot_link_checked FROM partial WHERE path = ?";
pub(crate) static SQL_MOUNTS_OF: &str = "SELECT m.path, s.scanned_at, s.tot_bytes, s.tot_disk, s.tot_files, s.tot_dirs FROM mountpoints m LEFT JOIN sizes s ON s.path = m.path AND s.dev = m.dev WHERE m.parent = ? ORDER BY m.path LIMIT ?";

fn sums_at(r: &SqlRow<'_>, from: usize) -> rusqlite::Result<Sums> {
    let mut a = [0i64; 10];
    for (i, x) in a.iter_mut().enumerate() {
        *x = r.get::<_, Option<i64>>(from + i)?.unwrap_or(0);
    }
    Ok(Sums::from_array(a))
}

/// A row of `COLS` followed by the child count and the dirty mark.
pub(crate) fn from_sql(r: &SqlRow<'_>) -> rusqlite::Result<Row> {
    let f = |i: usize| -> rusqlite::Result<f64> { Ok(r.get::<_, Option<f64>>(i)?.unwrap_or(0.0)) };
    Ok(Row {
        path: r.get(0)?,
        parent: r.get(1)?,
        ino: f(2)?,
        dev: f(3)?,
        mtime_ms: f(4)?,
        scanned_at: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
        seen_at: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
        ver: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
        own: sums_at(r, 8)?,
        tot: sums_at(r, 18)?,
        kids: r.get::<_, Option<i64>>(28)?,
        dirty: r.get::<_, Option<i64>>(29)?,
        partial: false,
    })
}

/// A row of the `partial` table (the fields `SQL_PARTIAL_*` select).
pub(crate) fn partial_from_sql(r: &SqlRow<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        path: r.get(0)?,
        parent: r.get(1)?,
        ino: 0.0,
        dev: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
        mtime_ms: 0.0,
        scanned_at: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        seen_at: 0,
        ver: 0,
        own: Sums::default(),
        tot: sums_at(r, 4)?,
        kids: None,
        dirty: None,
        partial: true,
    })
}

/// The values of `SQL_PUT`, in order.
pub(crate) fn put_values(n: &Row) -> Vec<Value> {
    let mut v = vec![
        Value::Text(n.path.clone()),
        Value::Text(n.parent.clone()),
        Value::Real(n.ino),
        Value::Real(n.dev),
        Value::Real(n.mtime_ms),
        Value::Integer(n.scanned_at),
        Value::Integer(n.seen_at),
        Value::Integer(n.ver),
    ];
    v.extend(n.own.to_array().map(Value::Integer));
    v.extend(n.tot.to_array().map(Value::Integer));
    v
}
