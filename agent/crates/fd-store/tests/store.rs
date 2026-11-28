#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};

use fd_store::{Ctl, DuEntry, EntryType, Options, Store, now_ms};

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Self {
        let d = std::env::temp_dir().join(format!("fd-store-it-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Self(fs::canonicalize(d).unwrap())
    }
    fn root(&self) -> PathBuf {
        let r = self.0.join("root");
        fs::create_dir_all(&r).unwrap();
        r
    }
    fn db(&self) -> PathBuf {
        self.0.join("state/sizes-t.db")
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(p: &Path, n: usize) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, vec![b'x'; n]).unwrap();
}

fn store(t: &Tmp, ttl: i64) -> Store {
    let mut o = Options::new(t.root().to_str().unwrap());
    o.ttl_ms = ttl;
    Store::open(Some(&t.db()), o).unwrap()
}

fn tree(s: &Store, p: &str, depth: u32, all: bool) -> Vec<DuEntry> {
    let mut v = Vec::new();
    s.tree_each(p, depth, all, &mut |e| {
        v.push(e);
        Ok(())
    })
    .unwrap();
    v
}

#[test]
fn scan_counts_files_folders_links_and_skips_the_trash() {
    let t = Tmp::new("count");
    let r = t.root();
    write(&r.join("tree/a.txt"), 5);
    write(&r.join("tree/sub/b.txt"), 10);
    write(&r.join("tree/sub/deep/c.txt"), 1);
    write(&r.join("tree/.filedeck-trash/x/data"), 1000);
    fs::hard_link(r.join("tree/a.txt"), r.join("tree/sub/a-link.txt")).unwrap();
    std::os::unix::fs::symlink("/etc/hostname", r.join("tree/link")).unwrap();
    let s = store(&t, 60_000);
    let out = s
        .scan_read("/tree", &Ctl::default(), false, now_ms())
        .unwrap();
    assert_eq!(out.res.files, 4, "a hard link counts once per link");
    assert_eq!(out.res.dirs, 2);
    assert_eq!(out.res.symlinks, 1);
    assert_eq!(out.res.bytes, 5 + 10 + 1 + 5);
    assert_eq!(out.read, 3);
    let row = s.get("/tree").unwrap().unwrap();
    assert_eq!(
        row.tot.links, 2,
        "both names of the hard linked file have nlink 2"
    );
    assert_eq!(row.tot.link_checked, 4);
    // nothing changed: nothing is read again
    let again = s
        .scan_read("/tree", &Ctl::default(), false, now_ms())
        .unwrap();
    assert_eq!(again.read, 0);
    assert_eq!(again.res, out.res);
    // fresh reads everything
    let fresh = s
        .scan_read("/tree", &Ctl::default(), true, now_ms())
        .unwrap();
    assert_eq!(fresh.read, 3);
    assert_eq!(fresh.res, out.res);
}

#[test]
fn a_change_is_seen_after_the_ttl_and_a_removed_folder_is_dropped() {
    let t = Tmp::new("ttl");
    let r = t.root();
    write(&r.join("d/one/f"), 3);
    write(&r.join("d/two/f"), 4);
    let s = store(&t, 0);
    let a = s.scan_read("/d", &Ctl::default(), false, now_ms()).unwrap();
    assert_eq!((a.res.files, a.res.dirs, a.res.bytes), (2, 2, 7));
    fs::remove_dir_all(r.join("d/two")).unwrap();
    let b = s.scan_read("/d", &Ctl::default(), false, now_ms()).unwrap();
    assert_eq!((b.res.files, b.res.dirs, b.res.bytes), (1, 1, 3));
    assert!(
        s.get("/d/two").unwrap().is_none(),
        "the vanished folder is dropped with its row"
    );
}

#[test]
fn a_scan_of_a_subfolder_rolls_its_change_into_the_stored_folders_above() {
    let t = Tmp::new("roll");
    let r = t.root();
    write(&r.join("top/a/f"), 2);
    write(&r.join("top/b/f"), 3);
    let s = store(&t, 60_000);
    s.scan_read("/top", &Ctl::default(), false, now_ms())
        .unwrap();
    write(&r.join("top/a/g"), 7);
    s.scan_read("/top/a", &Ctl::default(), true, now_ms())
        .unwrap();
    let top = s.get("/top").unwrap().unwrap();
    assert_eq!((top.tot.files, top.tot.bytes), (3, 12));
}

#[test]
fn the_tree_lists_folders_in_path_order_with_depth_and_files() {
    let t = Tmp::new("tree");
    let r = t.root();
    write(&r.join("t/a.txt"), 1);
    write(&r.join("t/x/y/z.txt"), 2);
    write(&r.join("t/x-1/q.txt"), 3);
    let s = store(&t, 60_000);
    s.scan_read("/t", &Ctl::default(), false, now_ms()).unwrap();
    let paths = |d, all| {
        tree(&s, "/t", d, all)
            .into_iter()
            .map(|e| e.path)
            .collect::<Vec<_>>()
    };
    assert_eq!(paths(0, false), ["/t"]);
    assert_eq!(paths(1, false), ["/t", "/t/x", "/t/x-1"]);
    // path order: "-" sorts before "/", so x-1 comes between x and x/y
    assert_eq!(paths(2, false), ["/t", "/t/x", "/t/x-1", "/t/x/y"]);
    let mut all = paths(1, true);
    all.sort();
    assert_eq!(all, ["/t", "/t/a.txt", "/t/x", "/t/x-1"]);
    let top = &tree(&s, "/t", 0, false)[0];
    assert_eq!(
        (top.kind, top.files, top.dirs, top.bytes),
        (EntryType::Dir, 3, 3, 6)
    );
}

#[test]
fn the_entry_cap_truncates_the_answer() {
    let t = Tmp::new("cap");
    let r = t.root();
    for i in 0..10 {
        write(&r.join(format!("c/d{i}/f")), 1);
    }
    let mut o = Options::new(r.to_str().unwrap());
    o.max_entries = 4;
    let s = Store::open(Some(&t.db()), o).unwrap();
    s.scan_read("/c", &Ctl::default(), false, now_ms()).unwrap();
    let mut n = 0;
    let end = s
        .tree_each("/c", 1, false, &mut |_| {
            n += 1;
            Ok(())
        })
        .unwrap();
    assert!(end.truncated && end.found);
    assert_eq!(n, 4);
}

#[test]
fn a_cancelled_scan_marks_the_subtree_stale_and_keeps_nothing_half_done() {
    let t = Tmp::new("cancel");
    let r = t.root();
    write(&r.join("k/a/f"), 1);
    let s = store(&t, 60_000);
    let ctl = Ctl::default();
    ctl.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(s.scan_read("/k", &ctl, false, now_ms()).is_err());
    assert_eq!(s.partial_rows().unwrap(), 0);
    assert!(s.get("/k").unwrap().is_none());
}

#[test]
fn a_file_is_answered_directly_and_not_stored() {
    let t = Tmp::new("file");
    let r = t.root();
    write(&r.join("only.txt"), 9);
    let s = store(&t, 60_000);
    let out = s
        .scan_read("/only.txt", &Ctl::default(), false, now_ms())
        .unwrap();
    assert_eq!((out.res.files, out.res.bytes), (1, 9));
    assert!(s.get("/only.txt").unwrap().is_none());
}

#[test]
fn a_second_store_object_sees_the_rows_the_first_wrote() {
    let t = Tmp::new("reopen");
    let r = t.root();
    write(&r.join("m/a/f"), 6);
    {
        let s = store(&t, 60_000);
        s.scan_read("/m", &Ctl::default(), false, now_ms()).unwrap();
    }
    let s2 = store(&t, 60_000);
    let row = s2.get("/m").unwrap().unwrap();
    assert_eq!((row.tot.files, row.tot.bytes, row.ver), (1, 6, 1));
    let again = s2
        .scan_read("/m", &Ctl::default(), false, now_ms())
        .unwrap();
    assert_eq!(
        again.read, 0,
        "the second process reuses the first one's rows"
    );
}
