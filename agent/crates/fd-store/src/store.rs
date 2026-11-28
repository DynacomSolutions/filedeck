//! The size store: one SQLite file, one writer.
//!
//! The file has the schema and the meaning of the TypeScript store, so either agent can read what the other wrote.
//! Only one process writes it. The writer holds an OS file lock (`flock`) on `<file>.lock`; the lock goes with the
//! process, so no heartbeat and no timer is needed. The `writer` table still gets an epoch for a reader of the other
//! agent, and every commit checks it (a fenced writer stops).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, params, params_from_iter};
use rustix::fs::{FlockOperation, flock};

use crate::error::StoreError;
use crate::rows::{
    Row, SQL_GET, SQL_GET_KIDS, SQL_KID_PAGE, SQL_PARTIAL_ONE, SQL_PARTIAL_PUT, SQL_PUT, from_sql,
    partial_from_sql, put_values,
};
use crate::schema;
use crate::sums::{METRICS, Sums};
use crate::vpath::{below, parent_of};

/// Settings of a store.
#[derive(Debug, Clone)]
pub struct Options {
    /// the folder served as `/`
    pub root: String,
    /// a stored folder is reused while its inode and mtime match and it was read less than this long ago
    pub ttl_ms: i64,
    /// cap on the entries of one answer
    pub max_entries: usize,
    /// rows per commit of a walk
    pub commit_chunk: usize,
    /// a running walk writes what it has finished at least this often
    pub flush_ms: i64,
}

impl Options {
    pub fn new(root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            ttl_ms: 30 * 60_000,
            max_entries: 500_000,
            commit_chunk: 5000,
            flush_ms: 5000,
        }
    }
}

/// Stale marks and the clock that keeps every row and mark in order.
#[derive(Debug, Default)]
pub(crate) struct Marks {
    pub map: HashMap<String, i64>,
    pub max_validated: i64,
    pub stamp: i64,
}

/// Subtree stale marks kept; past this they collapse into one mark on `/`.
const MARKS_MAX: usize = 256;
/// The writer truncates its WAL file once it is bigger than this.
const WAL_LIMIT: i64 = 64 << 20;

struct Lease {
    epoch: i64,
    owner: String,
    /// the file lock: it goes with the process
    _lock: Option<File>,
}

/// The store of folder sizes of one node.
pub struct Store {
    pub(crate) opts: Options,
    file: PathBuf,
    spill: bool,
    persistent: bool,
    damaged: bool,
    pub(crate) reader: Arc<Mutex<Connection>>,
    pub(crate) writer: Arc<Mutex<Connection>>,
    lease: Option<Lease>,
    pub(crate) marks: Mutex<Marks>,
    commits: AtomicU64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A random version 4 UUID text, from the system's random source.
pub fn random_uuid() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    let ok = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    if ok.is_err() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        b.copy_from_slice(&n.to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The store file in use: the highest generation (`<base>.gen<N>`) whose main file exists, else `<base>`.
fn current_generation(base: &Path) -> PathBuf {
    let Some(dir) = base.parent() else {
        return base.to_owned();
    };
    let stem = base.file_name().map(|n| n.to_string_lossy().into_owned());
    let Some(stem) = stem else {
        return base.to_owned();
    };
    let mut best: Option<(u64, PathBuf)> = None;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(&stem) else {
                continue;
            };
            let Some(n) = rest.strip_prefix(".gen") else {
                continue;
            };
            if n.is_empty() || !n.bytes().all(|c| c.is_ascii_digit()) || n.starts_with('0') {
                continue;
            }
            if let Ok(g) = n.parse::<u64>()
                && best.as_ref().is_none_or(|(b, _)| g > *b)
            {
                best = Some((g, e.path()));
            }
        }
    }
    best.map_or_else(|| base.to_owned(), |(_, p)| p)
}

fn open_connection(file: &Path, read_only: bool) -> rusqlite::Result<Connection> {
    let c = Connection::open_with_flags(
        file,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(std::time::Duration::from_secs(10))?;
    if read_only {
        c.execute_batch("PRAGMA cache_size=-8192; PRAGMA query_only=1")?;
    } else {
        c.execute_batch(&format!(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=4000; PRAGMA journal_size_limit={WAL_LIMIT}"
        ))?;
    }
    Ok(c)
}

impl Store {
    /// Open the store in `file` (generation 0 is made when there is none). Without a file the store lives in a private
    /// temporary file that goes with the process. A file that cannot be used leaves an in-memory store that says so
    /// (`persistent() == false`, `damaged() == true`): scans still work, nothing is kept.
    pub fn open(file: Option<&Path>, opts: Options) -> Result<Self, StoreError> {
        let spill = file.is_none();
        let base = file.map_or_else(spill_path, Path::to_path_buf);
        match Self::open_file(&base, spill, &opts) {
            Ok(s) => Ok(s),
            Err(_) => Self::in_memory(opts, true),
        }
    }

    fn open_file(base: &Path, spill: bool, opts: &Options) -> Result<Self, StoreError> {
        if let Some(dir) = base.parent() {
            fs::create_dir_all(dir).map_err(StoreError::from)?;
        }
        let cur = current_generation(base);
        if cur == base && !base.exists() {
            // O_EXCL: never take over a file another process made a moment ago
            let _ = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(base)
                .map(drop);
        }
        let fresh = fs::metadata(&cur).map_or(true, |m| m.len() == 0);
        let writer = open_connection(&cur, false)?;
        if fresh {
            // before the first table: a new file gives its free pages back
            writer.execute_batch("PRAGMA auto_vacuum=INCREMENTAL")?;
        }
        // the writer connection above set WAL, so `auto_vacuum` must come first on a new file
        schema::apply(&writer)?;
        let reader = open_connection(&cur, true)?;
        let lease = Self::take_lease(&cur, &writer)?;
        let mut s = Self {
            opts: opts.clone(),
            file: cur,
            spill,
            persistent: true,
            damaged: false,
            reader: Arc::new(Mutex::new(reader)),
            writer: Arc::new(Mutex::new(writer)),
            lease,
            marks: Mutex::new(Marks::default()),
            commits: AtomicU64::new(0),
        };
        s.load_marks()?;
        s.damaged = false;
        Ok(s)
    }

    fn in_memory(opts: Options, damaged: bool) -> Result<Self, StoreError> {
        let c = Connection::open_in_memory()?;
        schema::apply(&c)?;
        let shared = Arc::new(Mutex::new(c));
        Ok(Self {
            opts,
            file: PathBuf::from(":memory:"),
            spill: false,
            persistent: false,
            damaged,
            reader: Arc::clone(&shared),
            writer: shared,
            lease: Some(Lease {
                epoch: 1,
                owner: random_uuid(),
                _lock: None,
            }),
            marks: Mutex::new(Marks::default()),
            commits: AtomicU64::new(0),
        })
    }

    /// Take the writer lease: the file lock first, then the `writer` row with a new epoch.
    fn take_lease(file: &Path, w: &Connection) -> Result<Option<Lease>, StoreError> {
        let lock_path = PathBuf::from(format!("{}.lock", file.display()));
        let f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(StoreError::from)?;
        if flock(&f, FlockOperation::NonBlockingLockExclusive).is_err() {
            return Ok(None);
        }
        let owner = random_uuid();
        w.execute_batch("BEGIN IMMEDIATE")?;
        let now = now_ms();
        let res: rusqlite::Result<i64> = (|| {
            let prev: Option<i64> = w
                .query_row("SELECT epoch FROM writer WHERE id = 1", [], |r| r.get(0))
                .ok();
            let epoch = prev.map_or(1, |e| e + 1);
            w.execute(
                "INSERT INTO writer (id, epoch, owner, beat, released) VALUES (1, ?1, ?2, ?3, 0)
                 ON CONFLICT(id) DO UPDATE SET epoch = ?1, owner = ?2, beat = ?3, released = 0",
                params![epoch, owner, now],
            )?;
            Ok(epoch)
        })();
        match res {
            Ok(epoch) => {
                w.execute_batch("COMMIT")?;
                Ok(Some(Lease {
                    epoch,
                    owner,
                    _lock: Some(f),
                }))
            }
            Err(e) => {
                let _ = w.execute_batch("ROLLBACK");
                Err(e.into())
            }
        }
    }

    fn load_marks(&self) -> Result<(), StoreError> {
        let r = lock(&self.reader);
        let mut m = lock(&self.marks);
        let mut st = r.prepare("SELECT path, at FROM stale_trees")?;
        let rows = st.query_map([], |x| Ok((x.get::<_, String>(0)?, x.get::<_, i64>(1)?)))?;
        for row in rows {
            let (p, at) = row?;
            m.map.insert(p, at);
        }
        let mv: Option<i64> =
            r.query_row("SELECT MAX(started) FROM validated", [], |x| x.get(0))?;
        m.max_validated = mv.unwrap_or(0);
        Ok(())
    }

    /// The database file in use (`:memory:` for an in-memory store).
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// False when the store has no file: nothing is kept between scans.
    pub fn persistent(&self) -> bool {
        self.persistent
    }

    /// True when the file could not be used.
    pub fn damaged(&self) -> bool {
        self.damaged
    }

    /// This process holds the writer lease and may walk.
    pub fn is_writer(&self) -> bool {
        self.lease.is_some()
    }

    /// The writer epoch of this process (0 when it is not the writer).
    pub fn epoch(&self) -> i64 {
        self.lease.as_ref().map_or(0, |l| l.epoch)
    }

    /// Commits written since the start.
    pub fn commits(&self) -> u64 {
        self.commits.load(Ordering::Relaxed)
    }

    /// Run a read.
    pub(crate) fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let c = lock(&self.reader);
        Ok(f(&c)?)
    }

    pub fn get(&self, p: &str) -> Result<Option<Row>, StoreError> {
        self.read(|c| {
            let mut st = c.prepare_cached(&SQL_GET)?;
            let mut rows = st.query_map([p], from_sql)?;
            rows.next().transpose()
        })
    }

    /// A stored folder with the number of its stored child folders on its own device.
    pub(crate) fn get_with_kids(&self, p: &str) -> Result<Option<Row>, StoreError> {
        self.read(|c| {
            let mut st = c.prepare_cached(&SQL_GET_KIDS)?;
            let mut rows = st.query_map([p], from_sql)?;
            rows.next().transpose()
        })
    }

    /// Up to `limit` stored child folders on device `dev` after path `after` (keyset paging).
    pub(crate) fn kid_page(
        &self,
        p: &str,
        dev: f64,
        after: &str,
        limit: i64,
    ) -> Result<Vec<Row>, StoreError> {
        self.read(|c| {
            let mut st = c.prepare_cached(&SQL_KID_PAGE)?;
            let rows = st.query_map(params![p, dev, after, limit], from_sql)?;
            rows.collect()
        })
    }

    /// The stored row of `virtual`, else what a running or killed walk had counted of it (`partial`).
    pub fn tree_top(&self, virtual_path: &str) -> Result<Option<Row>, StoreError> {
        if let Some(r) = self.get(virtual_path)? {
            return Ok(Some(r));
        }
        self.read(|c| {
            let mut st = c.prepare_cached(SQL_PARTIAL_ONE)?;
            let mut rows = st.query_map([virtual_path], partial_from_sql)?;
            rows.next().transpose()
        })
    }

    // ---- stale marks ----

    /// A time later than every mark, validation and stamp so far: rows and marks written after it order correctly.
    pub(crate) fn next_at(&self) -> i64 {
        let m = lock(&self.marks);
        let top = m.map.values().copied().max().unwrap_or(0);
        now_ms()
            .max(top + 1)
            .max(m.max_validated + 1)
            .max(m.stamp + 1)
    }

    /// The next walk stamp: strictly increasing, so a clock step back never gives two walks one stamp.
    pub(crate) fn next_stamp(&self, now: i64) -> i64 {
        let mut m = lock(&self.marks);
        m.stamp = now.max(m.stamp + 1);
        m.stamp
    }

    /// Newest mark on `p` or a folder above it (0 = none).
    pub(crate) fn mark_at(&self, p: &str) -> i64 {
        let m = lock(&self.marks);
        if m.map.is_empty() {
            return 0;
        }
        let mut top = 0;
        let mut a = p.to_owned();
        while !a.is_empty() {
            top = top.max(m.map.get(&a).copied().unwrap_or(0));
            a = parent_of(&a);
        }
        top
    }

    /// Has a stale mark been made on `p`, above it or below it, at or after `t`?
    pub fn marked_since(&self, p: &str, t: i64) -> bool {
        let (lo, hi) = below(p);
        let m = lock(&self.marks);
        m.map.iter().any(|(path, at)| {
            *at >= t
                && (path == p
                    || p.starts_with(&if path == "/" {
                        "/".to_owned()
                    } else {
                        format!("{path}/")
                    })
                    || (path.as_str() > lo.as_str() && path.as_str() < hi.as_str()))
        })
    }

    /// Mark the subtree of `p` as not current since `at`: the next walk that reaches it reads it again.
    pub fn mark_stale(&self, p: &str, at: Option<i64>) {
        if self.lease.is_none() {
            return;
        }
        let at = at.unwrap_or_else(|| self.next_at());
        if self.mark_at(p) >= at {
            return;
        }
        let (stored, collapse): (i64, bool);
        {
            let mut m = lock(&self.marks);
            let at = at.max(m.map.get(p).copied().unwrap_or(-1) + 1);
            m.map.insert(p.to_owned(), at);
            stored = at;
            collapse = m.map.len() > MARKS_MAX;
            if collapse {
                let top = m.map.values().copied().max().unwrap_or(at);
                m.map.clear();
                m.map.insert("/".to_owned(), top);
            }
        }
        let w = lock(&self.writer);
        let r: rusqlite::Result<()> = (|| {
            if collapse {
                let top = lock(&self.marks).map.get("/").copied().unwrap_or(stored);
                w.execute_batch("BEGIN IMMEDIATE")?;
                w.execute("DELETE FROM stale_trees WHERE path <> '/'", [])?;
                w.execute(MARK_SQL, params!["/", top])?;
                w.execute_batch("COMMIT")?;
            } else {
                w.execute(MARK_SQL, params![p, stored])?;
            }
            Ok(())
        })();
        if r.is_err() {
            let _ = w.execute_batch("ROLLBACK");
        }
    }

    /// Run `sql` for each parameter set, in one transaction.
    pub(crate) fn exec_all(
        &self,
        parts: &[(&str, Vec<Vec<rusqlite::types::Value>>)],
    ) -> Result<(), StoreError> {
        let w = lock(&self.writer);
        w.execute_batch("BEGIN IMMEDIATE")?;
        let r: rusqlite::Result<()> = (|| {
            for (sql, rows) in parts {
                let mut st = w.prepare_cached(sql)?;
                for row in rows {
                    st.execute(params_from_iter(row.iter()))?;
                }
            }
            Ok(())
        })();
        match r {
            Ok(()) => Ok(w.execute_batch("COMMIT")?),
            Err(e) => {
                let _ = w.execute_batch("ROLLBACK");
                Err(e.into())
            }
        }
    }

    /// Write what a walk has finished, in one transaction. The commit checks the writer lease first.
    pub(crate) fn commit(&self, c: Commit<'_>) -> Result<(), StoreError> {
        let Some(lease) = &self.lease else {
            return Err(StoreError::status(
                503,
                "another process holds the size store writer lease",
            ));
        };
        let w = lock(&self.writer);
        w.execute_batch("BEGIN IMMEDIATE")?;
        let r = self.commit_in(&w, lease, &c);
        match r {
            Ok(()) => {
                w.execute_batch("COMMIT")?;
                self.commits.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                let _ = w.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    fn commit_in(&self, w: &Connection, lease: &Lease, c: &Commit<'_>) -> Result<(), StoreError> {
        let beat = w.execute(
            "UPDATE writer SET beat = ? WHERE id = 1 AND epoch = ? AND owner = ?",
            params![now_ms(), lease.epoch, lease.owner],
        )?;
        if beat == 0 {
            return Err(StoreError::status(503, "lost the size store writer lease"));
        }
        if let Some((path, started)) = &c.walk_start {
            w.execute(
                "INSERT OR REPLACE INTO walking (path, epoch, started) VALUES (?, ?, ?)",
                params![path, lease.epoch, started],
            )?;
        }
        let old: Option<Row> = match c.last {
            Some(l) => {
                let mut st = w.prepare_cached(&SQL_GET)?;
                let mut rows = st.query_map([&l.path], from_sql)?;
                rows.next().transpose()?
            }
            None => None,
        };
        for it in c.items {
            if let Some(seen) = it.touch {
                w.prepare_cached("UPDATE sizes SET seen_at = ? WHERE path = ?")?
                    .execute(params![seen, it.path])?;
                continue;
            }
            if let Some(stamp) = it.purge {
                purge_stale_kids(w, &it.path, it.dev, stamp)?;
            }
            if let Some(row) = &it.row {
                w.prepare_cached(&SQL_PUT)?
                    .execute(params_from_iter(put_values(row).iter()))?;
            }
            if let Some(mounts) = &it.mounts {
                w.prepare_cached("DELETE FROM mountpoints WHERE parent = ?")?
                    .execute([&it.path])?;
                for (p, d) in mounts {
                    w.prepare_cached(
                        "INSERT OR REPLACE INTO mountpoints (path, parent, dev) VALUES (?, ?, ?)",
                    )?
                    .execute(params![p, it.path, d])?;
                }
            }
            w.prepare_cached("DELETE FROM partial WHERE path = ?")?
                .execute([&it.path])?;
        }
        for row in &c.spine {
            w.prepare_cached(&SQL_PARTIAL_PUT)?
                .execute(params_from_iter(row.iter()))?;
        }
        if let (Some(last), Some(old)) = (c.last, &old) {
            self.roll_into_ancestors(w, last, old)?;
        }
        if let Some(end) = &c.walk_end {
            w.execute("DELETE FROM walking WHERE path = ?", [end])?;
            let (lo, hi) = below(end);
            w.execute(
                "DELETE FROM partial WHERE path = ? OR (path > ? AND path < ?)",
                params![end, lo, hi],
            )?;
        }
        Ok(())
    }

    /// Add the change the walk made to its start folder to the stored folders above it, up to the first other device.
    fn roll_into_ancestors(
        &self,
        w: &Connection,
        last: &Last,
        old: &Row,
    ) -> Result<(), StoreError> {
        let mut anc: Vec<String> = Vec::new();
        let mut a = parent_of(&last.path);
        while !a.is_empty() {
            let row: Option<f64> = w
                .prepare_cached("SELECT dev FROM sizes WHERE path = ?")?
                .query_row([&a], |r| r.get::<_, Option<f64>>(0))
                .ok()
                .flatten();
            if let Some(dev) = row {
                if (dev - last.dev).abs() > f64::EPSILON {
                    break;
                }
                anc.push(a.clone());
            }
            a = parent_of(&a);
        }
        if anc.is_empty() {
            return Ok(());
        }
        let mut delta = last.tot;
        delta.add(&old.tot, -1);
        let set = METRICS
            .iter()
            .zip(delta.to_array())
            .map(|(m, d)| format!("tot_{m} = tot_{m} + {d}"))
            .collect::<Vec<_>>()
            .join(", ");
        let marks = vec!["?"; anc.len()].join(",");
        w.execute(
            &format!("UPDATE sizes SET {set} WHERE path IN ({marks})"),
            params_from_iter(anc.iter()),
        )?;
        Ok(())
    }

    /// Remove the stored rows of a folder that is gone, with its subtree.
    pub fn delete_tree(&self, p: &str) -> Result<(), StoreError> {
        let w = lock(&self.writer);
        w.execute_batch("BEGIN IMMEDIATE")?;
        let r = delete_tree_in(&w, p);
        match r {
            Ok(()) => Ok(w.execute_batch("COMMIT")?),
            Err(e) => {
                let _ = w.execute_batch("ROLLBACK");
                Err(e.into())
            }
        }
    }

    /// Release the writer lease: the next process takes a new epoch at once.
    pub fn release(&self) {
        if let Some(l) = &self.lease {
            let w = lock(&self.writer);
            let _ = w.execute(
                "UPDATE writer SET released = 1 WHERE id = 1 AND owner = ?",
                [&l.owner],
            );
        }
    }

    /// Read the partial row of a path, for tests.
    #[doc(hidden)]
    pub fn partial_rows(&self) -> Result<i64, StoreError> {
        self.read(|c| c.query_row("SELECT COUNT(*) FROM partial", [], |r| r.get(0)))
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.release();
        if self.spill {
            for suffix in ["", "-wal", "-shm", ".lock"] {
                let _ = fs::remove_file(format!("{}{suffix}", self.file.display()));
            }
        }
    }
}

/// A later mark is always newer than the one before it.
const MARK_SQL: &str = "INSERT INTO stale_trees (path, at) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET at = MAX(at + 1, ?2)";

fn spill_path() -> PathBuf {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    std::env::temp_dir().join(format!("filedeck-sizes-{}-{n}.db", std::process::id()))
}

fn delete_tree_in(w: &Connection, p: &str) -> rusqlite::Result<()> {
    let (lo, hi) = below(p);
    for table in ["sizes", "dirty", "mountpoints", "partial"] {
        w.execute(
            &format!("DELETE FROM {table} WHERE path = ? OR (path > ? AND path < ?)"),
            params![p, lo, hi],
        )?;
    }
    Ok(())
}

/// Drop the stored child folders of `p` (on device `dev`) that the walk with `stamp` did not see.
fn purge_stale_kids(w: &Connection, p: &str, dev: f64, stamp: i64) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let kids: Vec<String> = {
            let mut st = w.prepare_cached(
                "SELECT path FROM sizes WHERE parent = ? AND dev = ? AND seen_at <> ? AND path > ? ORDER BY path LIMIT 256",
            )?;
            let rows = st.query_map(params![p, dev, stamp, after], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let Some(last) = kids.last().cloned() else {
            return Ok(());
        };
        for k in &kids {
            delete_tree_in(w, k)?;
        }
        after = last;
    }
}

/// One item of a commit.
#[derive(Debug)]
pub(crate) struct Item {
    pub path: String,
    pub dev: f64,
    /// only `seen_at` is refreshed (a stored child taken as it is)
    pub touch: Option<i64>,
    /// drop the stored child folders whose `seen_at` is not this stamp
    pub purge: Option<i64>,
    /// the mount points of a folder that was read (`None`: not changed)
    pub mounts: Option<Vec<(String, f64)>>,
    pub row: Option<Row>,
}

/// The start folder of a walk: its change goes to the folders above it.
#[derive(Debug)]
pub(crate) struct Last {
    pub path: String,
    pub dev: f64,
    pub tot: Sums,
}

pub(crate) struct Commit<'a> {
    pub items: &'a [Item],
    pub last: Option<&'a Last>,
    pub walk_start: Option<(String, i64)>,
    pub walk_end: Option<String>,
    pub spine: Vec<Vec<rusqlite::types::Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_second_process_is_not_the_writer_and_the_epoch_grows() {
        let d = dir("lease");
        let f = d.join("sizes-t.db");
        let a = Store::open(Some(&f), Options::new("/")).unwrap();
        assert!(a.is_writer() && a.persistent());
        assert_eq!(a.epoch(), 1);
        // the file lock is held by `a`, so a second store of the same file reads only
        let b = Store::open(Some(&f), Options::new("/")).unwrap();
        assert!(!b.is_writer());
        drop(b);
        drop(a);
        let c = Store::open(Some(&f), Options::new("/")).unwrap();
        assert_eq!(c.epoch(), 2, "the epoch grows with every change of holder");
        drop(c);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_unusable_file_leaves_an_uncached_store() {
        let d = dir("bad");
        let f = d.join("sizes-t.db");
        fs::write(&f, b"this is not a database at all, just some text").unwrap();
        let s = Store::open(Some(&f), Options::new("/")).unwrap();
        assert!(!s.persistent() && s.damaged());
        drop(s);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn uuids_look_like_uuids() {
        let u = random_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes()[14], b'4');
    }
}
