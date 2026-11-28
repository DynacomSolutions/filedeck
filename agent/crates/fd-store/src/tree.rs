//! The answer of `du`: the folder, then depth first each folder followed by its files (with `all`), its mount points and its
//! child folders, down to `depth`. Rows are read a page at a time, so memory is one page whatever the size of the answer.

use std::collections::HashMap;
use std::fs;

use rusqlite::params;
use serde::Serialize;

use crate::error::StoreError;
use crate::rows::{
    Row, SQL_MOUNTS_OF, SQL_PARTIAL_BELOW, SQL_TREE_AFTER, SQL_TREE_FROM, from_sql,
    partial_from_sql,
};
use crate::store::Store;
use crate::vpath::{base_name, below, is_reserved_name, virtual_join};

const PAGE: i64 = 256;
/// Mount points remembered per folder.
const MOUNTS_PER_DIR: i64 = 256;

/// The kind of an entry of a `du` answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    Dir,
    File,
    Symlink,
    Other,
    /// a mount point below the folder: another file system, listed and never counted
    Mount,
}

/// One entry of a `du` answer. The field order is the one of the TypeScript agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: EntryType,
    pub bytes: i64,
    pub disk_bytes: i64,
    pub files: i64,
    pub dirs: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_at: Option<i64>,
    /// a folder a scan has entered and not finished: its sizes are what it counted so far
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
}

/// How a tree read ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeEnd {
    pub found: bool,
    pub truncated: bool,
    pub partial: bool,
}

enum Stop {
    /// the entry cap is reached
    Full,
    Err(StoreError),
}

impl From<StoreError> for Stop {
    fn from(e: StoreError) -> Self {
        Self::Err(e)
    }
}

impl From<rusqlite::Error> for Stop {
    fn from(e: rusqlite::Error) -> Self {
        Self::Err(e.into())
    }
}

fn as_entry(r: &Row) -> DuEntry {
    DuEntry {
        path: r.path.clone(),
        kind: EntryType::Dir,
        bytes: r.tot.bytes,
        disk_bytes: r.tot.disk,
        files: r.tot.files,
        dirs: r.tot.dirs,
        scanned_at: Some(r.scanned_at),
        partial: r.partial,
    }
}

type Emit<'a> = dyn FnMut(DuEntry) -> Result<(), StoreError> + 'a;

struct Reader<'a> {
    s: &'a Store,
    emit: &'a mut Emit<'a>,
    budget: usize,
    partial: bool,
    all: bool,
    depth: i64,
    base: i64,
    top: Row,
    open: HashMap<String, Row>,
    swept: String,
    skips: Vec<String>,
    jump: Option<String>,
}

impl Reader<'_> {
    fn out(&mut self, e: DuEntry) -> Result<(), Stop> {
        if self.budget == 0 {
            return Err(Stop::Full);
        }
        self.budget -= 1;
        if e.partial {
            self.partial = true;
        }
        (self.emit)(e).map_err(Stop::Err)
    }

    fn levels(&self, p: &str) -> i64 {
        i64::try_from(p.split('/').count()).unwrap_or(0) - 1 - self.base
    }

    /// The entries of `virtual` that are not folders, one at a time (a folder can hold millions).
    fn files_each(&mut self, virtual_path: &str) -> Result<(), Stop> {
        let mut real = std::path::PathBuf::from(&self.s.opts.root);
        real.extend(virtual_path.split('/').filter(|x| !x.is_empty()));
        let Ok(rd) = fs::read_dir(&real) else {
            return Ok(());
        };
        for ent in rd {
            let Ok(ent) = ent else { break };
            let name = ent.file_name().to_string_lossy().into_owned();
            if is_reserved_name(&name) {
                continue;
            }
            let Ok(md) = ent.metadata() else { continue };
            let ft = md.file_type();
            if ft.is_dir() {
                continue;
            }
            use std::os::unix::fs::MetadataExt;
            let (kind, bytes, files) = if ft.is_symlink() {
                (EntryType::Symlink, 0, 0)
            } else if ft.is_file() {
                (
                    EntryType::File,
                    i64::try_from(md.size()).unwrap_or(i64::MAX),
                    1,
                )
            } else {
                (EntryType::Other, 0, 0)
            };
            self.out(DuEntry {
                path: virtual_join(virtual_path, &name),
                kind,
                bytes,
                disk_bytes: i64::try_from(md.blocks().saturating_mul(512)).unwrap_or(i64::MAX),
                files,
                dirs: 0,
                scanned_at: None,
                partial: false,
            })?;
        }
        Ok(())
    }

    fn extras(&mut self, r: &Row) -> Result<(), Stop> {
        if self.all {
            self.files_each(&r.path)?;
        }
        if r.partial || r.own.mounts > 0 {
            let ms: Vec<(String, Option<i64>, i64, i64, i64, i64)> = self.s.read(|c| {
                let mut st = c.prepare_cached(SQL_MOUNTS_OF)?;
                let rows = st.query_map(params![r.path, MOUNTS_PER_DIR], |x| {
                    Ok((
                        x.get::<_, String>(0)?,
                        x.get::<_, Option<i64>>(1)?,
                        x.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        x.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        x.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        x.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    ))
                })?;
                rows.collect()
            })?;
            for (path, scanned_at, bytes, disk, files, dirs) in ms {
                self.out(DuEntry {
                    path,
                    kind: EntryType::Mount,
                    bytes,
                    disk_bytes: disk,
                    files,
                    dirs,
                    scanned_at,
                    partial: false,
                })?;
            }
        }
        Ok(())
    }

    fn take(&mut self, r: Row) -> Result<(), Stop> {
        // folders whose subtree the scan has passed can have no more children
        if self.open.len() > 8 && r.path > self.swept {
            let top = self.top.path.clone();
            self.open
                .retain(|k, _| *k == top || r.path < format!("{k}0"));
            self.swept.clone_from(&r.path);
        }
        let d = self.levels(&r.path);
        if d > self.depth {
            let take = usize::try_from(self.base + self.depth + 1).unwrap_or(0);
            let a = r.path.split('/').take(take).collect::<Vec<_>>().join("/");
            if self.open.contains_key(&a) {
                self.jump = Some(format!("{a}0"));
            }
            return Ok(());
        }
        let up_dev = self.open.get(&r.parent).map(|u| u.dev);
        if up_dev.is_none_or(|d| (d - r.dev).abs() > f64::EPSILON) {
            if self.skips.len() < 64 {
                self.skips.push(r.path.clone());
            }
            return Ok(());
        }
        self.open.insert(r.path.clone(), r.clone());
        self.out(as_entry(&r))?;
        if d < self.depth {
            self.extras(&r)?;
        }
        Ok(())
    }
}

impl Store {
    /// The tree under `virtual_path`, streamed to `emit` (a failure of `emit` ends the read). At most `max_entries`
    /// entries go out (then `truncated`). Folders that a running walk has entered and not finished stand in with what
    /// it counted so far (`partial`).
    pub fn tree_each(
        &self,
        virtual_path: &str,
        depth: u32,
        all: bool,
        emit: &mut Emit<'_>,
    ) -> Result<TreeEnd, StoreError> {
        let Some(top) = self.tree_top(virtual_path)? else {
            return Ok(TreeEnd {
                found: false,
                truncated: false,
                partial: false,
            });
        };
        let base = if virtual_path == "/" {
            0
        } else {
            i64::try_from(virtual_path.split('/').count()).unwrap_or(1) - 1
        };
        let mut open = HashMap::new();
        open.insert(top.path.clone(), top.clone());
        let mut rd = Reader {
            s: self,
            emit,
            budget: self.opts.max_entries,
            partial: false,
            all,
            depth: i64::from(depth),
            base,
            top,
            open,
            swept: String::new(),
            skips: Vec::new(),
            jump: None,
        };
        match run(&mut rd, virtual_path) {
            Ok(()) => Ok(TreeEnd {
                found: true,
                truncated: false,
                partial: rd.partial,
            }),
            Err(Stop::Full) => Ok(TreeEnd {
                found: true,
                truncated: true,
                partial: rd.partial,
            }),
            Err(Stop::Err(e)) => Err(e),
        }
    }
}

fn run(rd: &mut Reader<'_>, virtual_path: &str) -> Result<(), Stop> {
    let top = rd.top.clone();
    rd.out(as_entry(&top))?;
    if rd.depth > 0 {
        rd.extras(&top)?;
    }
    let (lo, hi) = below(virtual_path);
    // unfinished folders of running walks (at most one per level of each walk) take part in the same order; a stored row of the same path wins
    let unfinished: Vec<Row> = rd.s.read(|c| {
        let mut st = c.prepare_cached(SQL_PARTIAL_BELOW)?;
        let rows = st.query_map(params![lo, hi], partial_from_sql)?;
        rows.collect()
    })?;
    let mut u = 0usize;
    let mut after = lo.clone();
    let mut from: Option<String> = None;
    let mut more = rd.depth > 0;
    while more {
        let rows: Vec<Row> = rd.s.read(|c| {
            let sql = if from.is_some() {
                &*SQL_TREE_FROM
            } else {
                &*SQL_TREE_AFTER
            };
            let mut st = c.prepare_cached(sql)?;
            let lower = from.clone().unwrap_or_else(|| after.clone());
            let rows = st.query_map(params![lower, hi, PAGE], from_sql)?;
            rows.collect()
        })?;
        more = i64::try_from(rows.len()).unwrap_or(0) == PAGE;
        from = None;
        for x in rows {
            let p = x.path.clone();
            while u < unfinished.len() && unfinished[u].path <= p {
                if unfinished[u].path < p {
                    rd.take(unfinished[u].clone())?;
                }
                u += 1;
            }
            while rd.skips.last().is_some_and(|s| p >= format!("{s}0")) {
                rd.skips.pop();
            }
            let in_skip = rd
                .skips
                .last()
                .is_some_and(|s| p.starts_with(&format!("{s}/")));
            if rd.jump.is_none() && in_skip {
                if let Some(s) = rd.skips.pop() {
                    rd.jump = Some(format!("{s}0"));
                }
            } else if rd
                .jump
                .as_ref()
                .is_none_or(|j| !p.starts_with(&format!("{}/", &j[..j.len() - 1])))
            {
                rd.take(x)?;
            }
            after.clone_from(&p);
            if let Some(j) = rd.jump.take()
                && j > after
            {
                // everything up to the target is inside the subtree jumped over: the unfinished folders there too
                while u < unfinished.len() && unfinished[u].path < j {
                    u += 1;
                }
                from = Some(j);
                more = true;
                break;
            }
        }
    }
    while u < unfinished.len() {
        rd.take(unfinished[u].clone())?;
        u += 1;
    }
    let _ = base_name;
    Ok(())
}
