use std::ffi::OsString;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;

use fd_core::{Entry, EntryType, FsError, is_reserved_name, virtual_join};
use rustix::fs::{AtFlags, Dir, FileType, statat};

use crate::collate::list_order;
use crate::entry::{entry_at, kind_of, link_is_dir};
use crate::map_errno;
use crate::resolve::{Root, resolve_read};

/// The most entries one listing holds.
pub const MAX_LIST: usize = 20_000;
/// Rows in the first batch of a streamed listing: few, so the first paint is quick.
pub const FIRST_BATCH: usize = 100;

#[derive(Debug)]
struct Row {
    name: OsString,
    text: String,
    dir: bool,
}

fn sort_rows(rows: &mut [Row]) {
    rows.sort_by(|a, b| list_order((&a.text, a.dir), (&b.text, b.dir)));
}

/// A folder read and put in the default order, with the details still to read.
#[derive(Debug)]
pub struct Scan {
    root: Root,
    virtual_path: String,
    dir: OwnedFd,
    rows: Vec<Row>,
    truncated: bool,
}

/// The answer of a plain listing.
#[derive(Debug)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

/// Read the names of a folder: reserved names (and, unless `hidden`, names that start with a dot) are left out,
/// the rest is put in the default order and cut at `MAX_LIST`. A bad path fails here, with its status.
pub fn scan(root: &Root, path: &str, hidden: bool) -> Result<Scan, FsError> {
    let r = resolve_read(root, path)?;
    let dir = r.open_dir()?;
    let virtual_path = r.virtual_path.clone();
    let mut rows: Vec<Row> = Vec::new();
    let mut count = 0usize;
    let reader = Dir::read_from(&dir).map_err(map_errno)?;
    for item in reader {
        let item = item.map_err(map_errno)?;
        let bytes = item.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsString::from_vec(bytes.to_vec());
        let text = String::from_utf8_lossy(bytes).into_owned();
        if is_reserved_name(&text) || (!hidden && text.starts_with('.')) {
            continue;
        }
        count += 1;
        let dir_like = match item.file_type() {
            FileType::Directory => true,
            FileType::Symlink => {
                virtual_join(&virtual_path, &text).is_ok_and(|p| link_is_dir(root, &p))
            }
            FileType::Unknown => statat(&dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW)
                .is_ok_and(|st| match kind_of(&st) {
                    EntryType::Dir => true,
                    EntryType::Symlink => {
                        virtual_join(&virtual_path, &text).is_ok_and(|p| link_is_dir(root, &p))
                    }
                    _ => false,
                }),
            _ => false,
        };
        rows.push(Row {
            name,
            text,
            dir: dir_like,
        });
        // Keep memory at the cap however large the folder is.
        if rows.len() >= 2 * MAX_LIST {
            sort_rows(&mut rows);
            rows.truncate(MAX_LIST);
        }
    }
    sort_rows(&mut rows);
    rows.truncate(MAX_LIST);
    Ok(Scan {
        root: root.clone(),
        virtual_path,
        dir,
        rows,
        truncated: count > MAX_LIST,
    })
}

impl Scan {
    pub fn virtual_path(&self) -> &str {
        &self.virtual_path
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    fn details(&self, from: usize, to: usize) -> Vec<Entry> {
        self.rows[from..to.min(self.rows.len())]
            .iter()
            .filter_map(|row| entry_at(&self.root, &self.virtual_path, &self.dir, &row.name))
            .collect()
    }

    /// The entries in batches: `FIRST_BATCH` first (at most `batch_size`), then `batch_size` each. Empty batches are skipped.
    pub fn batches(self, batch_size: usize) -> impl Iterator<Item = Vec<Entry>> {
        let batch_size = batch_size.max(1);
        let first = FIRST_BATCH.min(batch_size).min(MAX_LIST);
        let mut next = 0usize;
        std::iter::from_fn(move || {
            while next < self.rows.len() {
                let size = if next == 0 { first } else { batch_size };
                let batch = self.details(next, next + size);
                next += size;
                if !batch.is_empty() {
                    return Some(batch);
                }
            }
            None
        })
    }
}

/// `GET /api/fs/list` without `stream`.
pub fn list(root: &Root, path: &str, hidden: bool) -> Result<Listing, FsError> {
    let s = scan(root, path, hidden)?;
    let (virtual_path, truncated) = (s.virtual_path.clone(), s.truncated);
    let entries = s.details(0, usize::MAX);
    Ok(Listing {
        path: virtual_path,
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn tree() -> (tempfile::TempDir, Root) {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        for d in ["d10", "d2", "sub"] {
            fs::create_dir(root.join(d)).unwrap();
        }
        for f in ["b.txt", "A.txt", ".hidden", "f1", "f10", "f2"] {
            fs::write(root.join(f), "x").unwrap();
        }
        for r in [".filedeck-trash", ".filedeck-work-abc"] {
            fs::create_dir(root.join(r)).unwrap();
        }
        symlink("sub", root.join("linkdir")).unwrap();
        symlink("gone", root.join("broken")).unwrap();
        (tmp, Root::new(root))
    }

    #[test]
    fn default_order_and_filters() {
        let (_t, root) = tree();
        let l = list(&root, "/", false).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "d2", "d10", "linkdir", "sub", "A.txt", "b.txt", "broken", "f1", "f2", "f10"
            ]
        );
        assert!(!l.truncated);
        let all = list(&root, "/", true).unwrap();
        assert!(all.entries.iter().any(|e| e.name == ".hidden"));
        assert!(
            all.entries
                .iter()
                .all(|e| !e.name.starts_with(".filedeck-"))
        );
    }

    #[test]
    fn links_carry_target_and_flags() {
        let (_t, root) = tree();
        let l = list(&root, "/", false).unwrap();
        let get = |n: &str| l.entries.iter().find(|e| e.name == n).unwrap();
        assert_eq!(get("linkdir").link_dir, Some(true));
        assert_eq!(get("linkdir").target.as_deref(), Some("sub"));
        assert_eq!(get("broken").broken, Some(true));
        assert_eq!(get("broken").link_dir, Some(false));
        assert_eq!(get("f1").target, None);
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let (_t, root) = tree();
        let e = list(&root, "/f1", false).unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (400, "not a directory"));
        assert_eq!(list(&root, "/nope", false).unwrap_err().status, 404);
    }

    #[test]
    fn batches_are_100_first_then_the_batch_size() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        for i in 0..1250 {
            fs::write(root.join(format!("f{i:05}")), "").unwrap();
        }
        let sizes: Vec<usize> = scan(&Root::new(root), "/", true)
            .unwrap()
            .batches(500)
            .map(|b| b.len())
            .collect();
        assert_eq!(sizes, [100, 500, 500, 150]);
    }
}
