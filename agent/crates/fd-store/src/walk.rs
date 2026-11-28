//! The walker: `du` of one folder through the store.
//!
//! One row per folder, never per file. A stored folder is reused while its inode, device and mtime match a fresh
//! `lstat`, it was read less than `ttl_ms` ago, and nothing marks it stale. A re-read folder replaces its row and drops the
//! stored child folders that this walk did not see. Symbolic links are counted, never followed. Another device is a mount
//! point: counted in `mounts`, not entered. The walk keeps one frame per level, so its memory follows the depth of the
//! tree, not its size. Hard links count once per link, as in the TypeScript store.

use std::collections::VecDeque;
use std::fs::{self, Metadata, ReadDir};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use rusqlite::types::Value;
use serde::Serialize;

use crate::error::StoreError;
use crate::rows::Row;
use crate::store::{Commit, Item, Last, Store, now_ms};
use crate::sums::Sums;
use crate::vpath::{base_name, is_reserved_name, parent_of, resolve_read, virtual_join};

/// Deepest folder a walk enters (one open directory per level); deeper folders count as an error.
const DU_MAX_DEPTH: usize = 256;
/// Stored child rows (with their stats) kept from the reuse check for the walk that follows it.
const CACHED: usize = 1024;
const PAGE: i64 = 256;
/// Mount points remembered per folder.
const MOUNTS_PER_DIR: usize = 256;
/// Dirty folders one walk remembers to clear when it ends.
const DIRTY_SEEN_MAX: usize = 50_000;
/// A job resumed within this time of its start keeps the rows it had written, whatever their age.
const RESUME_MAX_MS: i64 = 24 * 3_600_000;

/// What a running scan reports: bytes and entries so far, the expected totals and the folder it is in.
#[derive(Debug, Default)]
pub struct Progress {
    pub bytes: AtomicU64,
    pub total_bytes: AtomicU64,
    pub entries: AtomicU64,
    pub total_entries: AtomicU64,
    pub current: std::sync::Mutex<String>,
}

/// The handles a scan gets: a cancel flag and the progress it fills.
#[derive(Debug, Clone, Default)]
pub struct Ctl {
    pub cancel: Arc<AtomicBool>,
    pub progress: Arc<Progress>,
}

/// The totals of one folder, as the size job reports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeResult {
    pub path: String,
    pub files: i64,
    pub dirs: i64,
    pub symlinks: i64,
    pub other: i64,
    pub bytes: i64,
    pub disk_bytes: i64,
    pub truncated: bool,
    pub mounts_skipped: i64,
    pub errors: i64,
}

/// A finished scan.
#[derive(Debug, Clone)]
pub struct ScanOut {
    pub res: SizeResult,
    /// folders read from disk (0 = answered from the store, only validated)
    pub read: u64,
    /// rows were reused on their age while a watcher ran (never without one)
    pub untrusted: bool,
}

struct Node {
    row: Row,
    reused: bool,
    /// the folder had stored child rows: its commit drops the ones this walk did not see
    purge: bool,
    /// only `seen_at` is refreshed
    touch: bool,
    /// `tot` already holds `own`
    own_in: bool,
    mnts: Vec<(String, f64)>,
}

struct Child {
    virtual_path: String,
    real: PathBuf,
    md: Metadata,
    stored: Option<Row>,
}

struct FrameNode {
    node: Node,
    vpath: String,
}

enum Cursor {
    Read { dir: ReadDir, rpath: PathBuf },
    Stored(StoredCur),
    Empty,
}

struct StoredCur {
    rpath: PathBuf,
    buf: VecDeque<(Row, Option<Metadata>)>,
    after: String,
    done: bool,
    want: i64,
    handed: i64,
}

fn mtime_ms(m: &Metadata) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let v = m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6;
    v
}

#[allow(clippy::cast_precision_loss)]
fn num(v: u64) -> f64 {
    v as f64
}

fn disk_of(m: &Metadata) -> i64 {
    i64::try_from(m.blocks().saturating_mul(512)).unwrap_or(i64::MAX)
}

fn size_of(m: &Metadata) -> i64 {
    i64::try_from(m.size()).unwrap_or(i64::MAX)
}

fn result(n: &Row) -> SizeResult {
    let t = &n.tot;
    SizeResult {
        path: n.path.clone(),
        files: t.files,
        dirs: t.dirs,
        symlinks: t.symlinks,
        other: t.other,
        bytes: t.bytes,
        disk_bytes: t.disk,
        truncated: false,
        mounts_skipped: t.mounts,
        errors: t.errors,
    }
}

impl Store {
    /// `du` of one folder through the store. A single file is answered directly and not stored.
    /// `fresh` re-reads every folder; `since` is when the scan's job began (rows written since are its own).
    pub fn scan_read(
        &self,
        virtual_path: &str,
        ctl: &Ctl,
        fresh: bool,
        since: i64,
    ) -> Result<ScanOut, StoreError> {
        if !self.is_writer() {
            return Err(StoreError::status(
                503,
                "another process holds the size store writer lease",
            ));
        }
        let r = resolve_read(&self.opts.root, virtual_path)?;
        let st = fs::metadata(&r.real)?;
        if !st.is_dir() {
            return Ok(ScanOut {
                res: SizeResult {
                    path: r.virtual_path,
                    files: 1,
                    dirs: 0,
                    symlinks: 0,
                    other: 0,
                    bytes: size_of(&st),
                    disk_bytes: disk_of(&st),
                    truncated: false,
                    mounts_skipped: 0,
                    errors: 0,
                },
                read: 0,
                untrusted: false,
            });
        }
        // The previous scan is the expected total (progress and ETA).
        if let Some(prev) = self.get(&r.virtual_path)?
            && ctl.progress.total_entries.load(Ordering::Relaxed) == 0
        {
            let t = &prev.tot;
            let n = t.files + t.dirs + t.symlinks + t.other;
            ctl.progress
                .total_entries
                .store(u64::try_from(n).unwrap_or(0), Ordering::Relaxed);
            ctl.progress
                .total_bytes
                .store(u64::try_from(t.bytes).unwrap_or(0), Ordering::Relaxed);
        }
        let mut w = Walker::new(self, ctl, &r.virtual_path, &st, fresh, since);
        let root = w.run(&r.real, &st)?;
        Ok(ScanOut {
            res: result(&root),
            read: w.read,
            untrusted: false,
        })
    }
}

struct Walker<'a> {
    s: &'a Store,
    ctl: &'a Ctl,
    virtual_path: String,
    dev: f64,
    fresh: bool,
    /// when the scan began, unless it began too long ago to trust its own rows
    since: Option<i64>,
    now: i64,
    stamp: i64,
    epoch: i64,
    frames: Vec<FrameNode>,
    cursors: Vec<Cursor>,
    buf: Vec<Node>,
    root: Option<Row>,
    seen: u64,
    bytes: u64,
    read: u64,
    last_flush: Instant,
    walk_started: bool,
    walk_closed: bool,
    written: bool,
    /// a stored child could not be read: the subtree is marked stale at the end
    dirty: bool,
    seen_dirty: Vec<(String, i64)>,
    too_deep: bool,
    start_marks: Vec<(String, i64)>,
}

impl<'a> Walker<'a> {
    fn new(
        s: &'a Store,
        ctl: &'a Ctl,
        virtual_path: &str,
        st: &Metadata,
        fresh: bool,
        since: i64,
    ) -> Self {
        let real_now = now_ms();
        let since = (real_now - since < RESUME_MAX_MS).then_some(since);
        let now = s.next_at();
        let stamp = s.next_stamp(now);
        let start_marks = {
            let m = s
                .marks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            m.map.iter().map(|(k, v)| (k.clone(), *v)).collect()
        };
        Self {
            s,
            ctl,
            virtual_path: virtual_path.to_owned(),
            dev: num(st.dev()),
            fresh,
            since,
            now,
            stamp,
            epoch: s.epoch(),
            frames: Vec::new(),
            cursors: Vec::new(),
            buf: Vec::new(),
            root: None,
            seen: 0,
            bytes: 0,
            read: 0,
            last_flush: Instant::now(),
            walk_started: false,
            walk_closed: false,
            written: false,
            dirty: false,
            seen_dirty: Vec::new(),
            too_deep: false,
            start_marks,
        }
    }

    fn canceled(&self) -> Result<(), StoreError> {
        if self.ctl.cancel.load(Ordering::Relaxed) {
            return Err(StoreError::Canceled);
        }
        Ok(())
    }

    fn run(&mut self, real: &std::path::Path, st: &Metadata) -> Result<Row, StoreError> {
        match self.walk(real, st) {
            Ok(root) => {
                self.finish_walk()?;
                Ok(root)
            }
            Err(e) => {
                // A rescan keeps the folders it finished (rows stamped since it began are final); everything older is stale.
                if self.written {
                    let at = self.since.map_or_else(|| now_ms().max(self.now), |s| s - 1);
                    self.s.mark_stale(&self.virtual_path, Some(at));
                }
                let _ = self.s.cleanup_walk(&self.virtual_path);
                Err(e)
            }
        }
    }

    fn walk(&mut self, real: &std::path::Path, st: &Metadata) -> Result<Row, StoreError> {
        let root = Child {
            virtual_path: self.virtual_path.clone(),
            real: real.to_owned(),
            md: st.clone(),
            stored: None,
        };
        self.open_in(root, true)?;
        while !self.frames.is_empty() {
            self.canceled()?;
            match self.next_child()? {
                Some(c) => {
                    if self.frames.len() >= DU_MAX_DEPTH {
                        // too deep to enter: counted, not walked
                        if let Some(top) = self.frames.last_mut() {
                            if !top.node.reused {
                                top.node.row.own.errors += 1;
                            }
                            top.node.row.tot.errors += 1;
                        }
                        self.too_deep = true;
                        continue;
                    }
                    self.open_in(c, false)?;
                }
                None => {
                    if let Some(f) = self.frames.pop() {
                        self.cursors.pop();
                        self.finish(f.node)?;
                    }
                }
            }
        }
        self.root
            .clone()
            .ok_or_else(|| StoreError::status(500, "internal error"))
    }

    /// `n` has all its children: its totals are final. Store it and roll it into its parent.
    fn finish(&mut self, n: Node) -> Result<(), StoreError> {
        let tot = n.row.tot;
        let is_root = self.frames.is_empty();
        if let Some(up) = self.frames.last_mut() {
            up.node.row.tot.add(&tot, 1);
        } else {
            self.root = Some(n.row.clone());
        }
        self.buf.push(n);
        if is_root || self.due() {
            self.flush(is_root)?;
        }
        Ok(())
    }

    fn due(&self) -> bool {
        self.buf.len() >= self.s.opts.commit_chunk
            || self.last_flush.elapsed().as_millis()
                >= u128::try_from(self.s.opts.flush_ms).unwrap_or(5000)
    }

    /// The folders the walk is in, with what they have counted so far (rows of `partial`).
    fn spine(&self, root_done: bool) -> Vec<Vec<Value>> {
        if root_done {
            return Vec::new();
        }
        let at = now_ms();
        self.frames
            .iter()
            .map(|f| {
                let mut t = f.node.row.tot;
                if !f.node.own_in {
                    t.add(&f.node.row.own, 1);
                }
                let mut v = vec![
                    Value::Text(f.node.row.path.clone()),
                    Value::Text(f.node.row.parent.clone()),
                    Value::Real(f.node.row.dev),
                    Value::Text(self.virtual_path.clone()),
                    Value::Integer(at),
                ];
                v.extend(t.to_array().map(Value::Integer));
                v
            })
            .collect()
    }

    fn flush(&mut self, root_done: bool) -> Result<(), StoreError> {
        let part = std::mem::take(&mut self.buf);
        self.last_flush = Instant::now();
        let items: Vec<Item> = part
            .iter()
            .map(|n| {
                if n.touch {
                    Item {
                        path: n.row.path.clone(),
                        dev: n.row.dev,
                        touch: Some(n.row.seen_at),
                        purge: None,
                        mounts: None,
                        row: None,
                    }
                } else {
                    Item {
                        path: n.row.path.clone(),
                        dev: n.row.dev,
                        touch: None,
                        purge: n.purge.then_some(n.row.seen_at),
                        mounts: (!n.reused).then(|| n.mnts.clone()),
                        row: Some(n.row.clone()),
                    }
                }
            })
            .collect();
        let last = if root_done {
            self.root.as_ref().map(|r| Last {
                path: r.path.clone(),
                dev: r.dev,
                tot: r.tot,
            })
        } else {
            None
        };
        let first = !self.walk_started;
        self.walk_started = true;
        self.s.commit(Commit {
            items: &items,
            last: last.as_ref(),
            walk_start: first.then(|| (self.virtual_path.clone(), self.now)),
            walk_end: root_done.then(|| self.virtual_path.clone()),
            spine: self.spine(root_done),
        })?;
        self.written = true;
        if root_done {
            self.walk_closed = true;
        }
        Ok(())
    }

    /// The walk ended cleanly: what it re-read is no longer dirty, and the marks it knew about and that are older than it are spent.
    fn finish_walk(&mut self) -> Result<(), StoreError> {
        if self.dirty {
            let at = self.s.next_at().max(self.now);
            self.s.mark_stale(&self.virtual_path, Some(at));
            return Ok(());
        }
        let (lo, hi) = crate::vpath::below(&self.virtual_path);
        let mut parts: Vec<(&str, Vec<Vec<Value>>)> = Vec::new();
        if !self.seen_dirty.is_empty() {
            parts.push((
                "DELETE FROM dirty WHERE path = ? AND at = ?",
                self.seen_dirty
                    .iter()
                    .map(|(p, at)| vec![Value::Text(p.clone()), Value::Integer(*at)])
                    .collect(),
            ));
        }
        let spent: Vec<(String, i64)> = if self.too_deep {
            Vec::new()
        } else {
            let m = self
                .s
                .marks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.start_marks
                .iter()
                .filter(|(p, at)| {
                    (*p == self.virtual_path
                        || (p.as_str() > lo.as_str() && p.as_str() < hi.as_str()))
                        && *at < self.now
                        && m.map.get(p) == Some(at)
                })
                .cloned()
                .collect()
        };
        if !spent.is_empty() {
            parts.push((
                "DELETE FROM stale_trees WHERE path = ? AND at = ?",
                spent
                    .iter()
                    .map(|(p, at)| vec![Value::Text(p.clone()), Value::Integer(*at)])
                    .collect(),
            ));
        }
        parts.push((
            "DELETE FROM dirty WHERE NOT EXISTS (SELECT 1 FROM sizes WHERE sizes.path = dirty.path)",
            vec![vec![]],
        ));
        self.s.exec_all(&parts)?;
        let mut m = self
            .s
            .marks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (p, at) in &spent {
            if m.map.get(p) == Some(at) {
                m.map.remove(p);
            }
        }
        Ok(())
    }

    /// Decide reuse or re-read for one folder and push its frame.
    fn open_in(&mut self, c: Child, is_root: bool) -> Result<(), StoreError> {
        self.canceled()?;
        if let Ok(mut cur) = self.ctl.progress.current.lock() {
            cur.clone_from(&c.virtual_path);
        }
        let ino = num(c.md.ino());
        let stored = match c.stored {
            Some(s) => Some(s),
            None => self.s.get_with_kids(&c.virtual_path)?,
        };
        let stored_kids = stored.as_ref().and_then(|s| s.kids).unwrap_or(0);
        let marked = self.s.mark_at(&c.virtual_path);
        if let Some(d) = stored.as_ref().and_then(|s| s.dirty)
            && self.seen_dirty.len() < DIRTY_SEEN_MAX
        {
            self.seen_dirty.push((c.virtual_path.clone(), d));
        }
        let since = self.since.unwrap_or(i64::MAX);
        let mut reusable = stored.as_ref().is_some_and(|s| {
            (!self.fresh || s.scanned_at >= since)
                && (s.ino - ino).abs() < f64::EPSILON
                && (s.dev - self.dev).abs() < f64::EPSILON
                && (s.mtime_ms - mtime_ms(&c.md)).abs() < f64::EPSILON
                && s.scanned_at > 0
                && s.dirty.is_none()
                && s.scanned_at > marked
                && (self.now - s.scanned_at < self.s.opts.ttl_ms || s.scanned_at >= since)
                && stored_kids == s.own.dirs - s.own.mounts
        });
        let mut first: VecDeque<(Row, Option<Metadata>)> = VecDeque::new();
        let mut first_complete = false;
        if reusable && let Some(st) = &stored {
            // every stored child folder must still be a folder on this device, otherwise this folder's counts are stale
            let mut total = 0i64;
            let mut after = String::new();
            let mut more = st.own.dirs - st.own.mounts > 0;
            while reusable && more {
                self.canceled()?;
                let page = self.s.kid_page(&c.virtual_path, self.dev, &after, PAGE)?;
                more = i64::try_from(page.len()).unwrap_or(0) == PAGE;
                if let Some(l) = page.last() {
                    after.clone_from(&l.path);
                }
                let stats: Vec<Option<Metadata>> = page
                    .iter()
                    .map(|k| fs::symlink_metadata(c.real.join(base_name(&k.path))).ok())
                    .collect();
                reusable = stats.iter().all(|m| {
                    m.as_ref().is_some_and(|m| {
                        m.is_dir() && (num(m.dev()) - self.dev).abs() < f64::EPSILON
                    })
                });
                let n = i64::try_from(page.len()).unwrap_or(0);
                if first.len() < CACHED {
                    first.extend(page.into_iter().zip(stats));
                }
                first_complete = !more && i64::try_from(first.len()).unwrap_or(-1) == total + n;
                total += n;
            }
            reusable = reusable && total == stored_kids;
        }
        if reusable && let Some(st) = stored {
            let mut row = st;
            row.tot = row.own;
            row.seen_at = self.stamp;
            row.kids = None;
            row.dirty = None;
            let want = row.own.dirs - row.own.mounts;
            self.seen +=
                u64::try_from(row.own.files + row.own.symlinks + row.own.other + row.own.dirs)
                    .unwrap_or(0);
            self.bytes += u64::try_from(row.own.bytes).unwrap_or(0);
            self.progress();
            let after = first
                .back()
                .map(|(r, _)| r.path.clone())
                .unwrap_or_default();
            let node = Node {
                row,
                reused: true,
                purge: false,
                touch: false,
                own_in: true,
                mnts: Vec::new(),
            };
            self.frames.push(FrameNode {
                node,
                vpath: c.virtual_path.clone(),
            });
            self.cursors.push(Cursor::Stored(StoredCur {
                rpath: c.real,
                done: want == 0 || first_complete,
                buf: first,
                after,
                want,
                handed: 0,
            }));
            return Ok(());
        }
        // a folder that is read again
        self.read += 1;
        let mut row = Row {
            path: c.virtual_path.clone(),
            parent: parent_of(&c.virtual_path),
            ino,
            dev: self.dev,
            mtime_ms: mtime_ms(&c.md),
            scanned_at: self.now,
            seen_at: self.stamp,
            ver: self.epoch,
            own: Sums::default(),
            tot: Sums::default(),
            kids: None,
            dirty: None,
            partial: false,
        };
        let purge = stored_kids > 0
            || stored
                .as_ref()
                .is_none_or(|s| (s.dev - self.dev).abs() > f64::EPSILON);
        let dir = match fs::read_dir(&c.real) {
            Ok(d) => d,
            Err(_) => {
                row.own.errors += 1;
                row.tot = row.own;
                // the folder is finished at once: roll it into its parent
                let n = Node {
                    row,
                    reused: false,
                    purge,
                    touch: false,
                    own_in: true,
                    mnts: Vec::new(),
                };
                self.finish(n)?;
                return Ok(());
            }
        };
        let _ = is_root;
        self.frames.push(FrameNode {
            node: Node {
                row,
                reused: false,
                purge,
                touch: false,
                own_in: false,
                mnts: Vec::new(),
            },
            vpath: c.virtual_path,
        });
        self.cursors.push(Cursor::Read { dir, rpath: c.real });
        Ok(())
    }

    fn progress(&self) {
        self.ctl
            .progress
            .entries
            .store(self.seen, Ordering::Relaxed);
        self.ctl.progress.bytes.store(self.bytes, Ordering::Relaxed);
    }

    /// The next child folder of the folder on top, tallying its files on the way.
    fn next_child(&mut self) -> Result<Option<Child>, StoreError> {
        let Some(slot) = self.cursors.last_mut() else {
            return Ok(None);
        };
        let mut cur = std::mem::replace(slot, Cursor::Empty);
        let r = self.advance(&mut cur);
        if let Some(slot) = self.cursors.last_mut() {
            *slot = cur;
        }
        r
    }

    fn advance(&mut self, cur: &mut Cursor) -> Result<Option<Child>, StoreError> {
        match cur {
            Cursor::Read { dir, rpath } => loop {
                self.canceled()?;
                let Some(top) = self.frames.last_mut() else {
                    return Ok(None);
                };
                let ent = match dir.next() {
                    None => {
                        top.node.row.tot.add(&top.node.row.own, 1);
                        top.node.own_in = true;
                        return Ok(None);
                    }
                    Some(Err(_)) => {
                        top.node.row.own.errors += 1;
                        top.node.row.tot.add(&top.node.row.own, 1);
                        top.node.own_in = true;
                        return Ok(None);
                    }
                    Some(Ok(e)) => e,
                };
                let name = ent.file_name().to_string_lossy().into_owned();
                if is_reserved_name(&name) {
                    continue;
                }
                let Ok(md) = ent.metadata() else {
                    top.node.row.own.errors += 1;
                    continue;
                };
                self.seen += 1;
                let disk = disk_of(&md);
                let own = &mut top.node.row.own;
                let ft = md.file_type();
                if ft.is_dir() {
                    own.dirs += 1;
                    if (num(md.dev()) - self.dev).abs() > f64::EPSILON {
                        // another filesystem: like du -x, neither entered nor counted
                        own.mounts += 1;
                        if top.node.mnts.len() < MOUNTS_PER_DIR {
                            top.node
                                .mnts
                                .push((virtual_join(&top.vpath, &name), num(md.dev())));
                        }
                    } else {
                        own.disk += disk;
                        let v = virtual_join(&top.vpath, &name);
                        let real = rpath.join(ent.file_name());
                        self.progress();
                        return Ok(Some(Child {
                            virtual_path: v,
                            real,
                            md,
                            stored: None,
                        }));
                    }
                } else if ft.is_symlink() {
                    own.symlinks += 1;
                    own.disk += disk;
                } else if ft.is_file() {
                    own.files += 1;
                    own.link_checked += 1;
                    if md.nlink() > 1 {
                        own.links += 1;
                    }
                    own.bytes += size_of(&md);
                    self.bytes += md.size();
                    own.disk += disk;
                } else {
                    own.other += 1;
                }
                if self.seen.is_multiple_of(256) {
                    self.progress();
                }
                if self.due() && !self.buf.is_empty() {
                    self.flush(false)?;
                }
            },
            Cursor::Stored(sc) => loop {
                self.canceled()?;
                if sc.buf.is_empty() {
                    if sc.done {
                        return Ok(self.end_stored(sc));
                    }
                    let page = self.s.kid_page(
                        &self
                            .frames
                            .last()
                            .map(|f| f.node.row.path.clone())
                            .unwrap_or_default(),
                        self.dev,
                        &sc.after,
                        PAGE,
                    )?;
                    if i64::try_from(page.len()).unwrap_or(0) < PAGE {
                        sc.done = true;
                    }
                    let Some(l) = page.last() else {
                        return Ok(self.end_stored(sc));
                    };
                    sc.after.clone_from(&l.path);
                    for k in page {
                        let m = fs::symlink_metadata(sc.rpath.join(base_name(&k.path))).ok();
                        sc.buf.push_back((k, m));
                    }
                }
                let Some((k, m)) = sc.buf.pop_front() else {
                    continue;
                };
                sc.handed += 1;
                let real = sc.rpath.join(base_name(&k.path));
                if let Some(md) = m
                    && md.is_dir()
                    && (num(md.dev()) - self.dev).abs() < f64::EPSILON
                {
                    return Ok(Some(Child {
                        virtual_path: k.path.clone(),
                        real,
                        md,
                        stored: Some(k),
                    }));
                }
                // gone since the check: counted as an unreadable folder, and the next scan re-reads this one
                if let Some(top) = self.frames.last_mut() {
                    top.node.row.own.errors += 1;
                    top.node.row.tot.errors += 1;
                }
            },
            Cursor::Empty => Ok(None),
        }
    }

    /// The end of the stored children: rows the store did not give are errors, and the subtree is marked stale.
    fn end_stored(&mut self, sc: &StoredCur) -> Option<Child> {
        if sc.handed < sc.want {
            if let Some(top) = self.frames.last_mut() {
                top.node.row.tot.errors += sc.want - sc.handed;
            }
            self.dirty = true;
        }
        None
    }
}

impl Store {
    /// A walk that ended early leaves no `walking` or `partial` rows behind.
    fn cleanup_walk(&self, virtual_path: &str) -> Result<(), StoreError> {
        let (lo, hi) = crate::vpath::below(virtual_path);
        self.exec_all(&[
            (
                "DELETE FROM walking WHERE path = ?",
                vec![vec![Value::Text(virtual_path.to_owned())]],
            ),
            (
                "DELETE FROM partial WHERE path = ? OR (path > ? AND path < ?)",
                vec![vec![
                    Value::Text(virtual_path.to_owned()),
                    Value::Text(lo),
                    Value::Text(hi),
                ]],
            ),
        ])
    }
}
