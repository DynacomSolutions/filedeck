//! Hard links and APFS clones on a real macOS volume (the macOS runner). The totals follow what the kernel reports for each name:
//! a hard link counts once per link, and a clone (`clonefile`) counts its own blocks like any other file.
#![cfg(target_os = "macos")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

use fd_store::{Ctl, Options, Store, now_ms};

fn setup(name: &str) -> (std::path::PathBuf, Store) {
    let base = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("fd-store-mac-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("root")).unwrap();
    let store = Store::open(
        Some(&base.join("state/sizes-t.db")),
        Options::new(base.join("root").to_str().unwrap()),
    )
    .unwrap();
    (base, store)
}

#[test]
fn a_hard_link_counts_once_per_link() {
    let (base, store) = setup("hard");
    let root = base.join("root");
    fs::create_dir_all(root.join("t/sub")).unwrap();
    fs::write(root.join("t/a"), vec![b'x'; 100_000]).unwrap();
    fs::hard_link(root.join("t/a"), root.join("t/b")).unwrap();
    fs::hard_link(root.join("t/a"), root.join("t/sub/c")).unwrap();
    let out = store
        .scan_read("/t", &Ctl::default(), false, now_ms())
        .unwrap();
    assert_eq!(out.res.files, 3);
    assert_eq!(out.res.bytes, 300_000);
    let row = store.get("/t").unwrap().unwrap();
    assert_eq!((row.tot.links, row.tot.link_checked), (3, 3));
    let blocks = i64::try_from(fs::metadata(root.join("t/a")).unwrap().blocks() * 512).unwrap();
    let dir_blocks =
        i64::try_from(fs::metadata(root.join("t/sub")).unwrap().blocks() * 512).unwrap();
    assert_eq!(
        out.res.disk_bytes,
        3 * blocks + dir_blocks,
        "the disk use of each link is counted"
    );
    drop(store);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn an_apfs_clone_counts_the_blocks_the_kernel_reports_for_it() {
    let (base, store) = setup("clone");
    let root = base.join("root");
    fs::create_dir_all(root.join("t")).unwrap();
    fs::write(root.join("t/orig"), vec![b'z'; 4 << 20]).unwrap();
    let cloned = Command::new("/bin/cp")
        .args(["-c"])
        .arg(root.join("t/orig"))
        .arg(root.join("t/clone"))
        .status()
        .unwrap();
    assert!(cloned.success(), "cp -c makes a clone on APFS");
    let out = store
        .scan_read("/t", &Ctl::default(), true, now_ms())
        .unwrap();
    assert_eq!((out.res.files, out.res.bytes), (2, 8 << 20));
    let disk = |p: &str| i64::try_from(fs::metadata(root.join(p)).unwrap().blocks() * 512).unwrap();
    assert_eq!(out.res.disk_bytes, disk("t/orig") + disk("t/clone"));
    let row = store.get("/t").unwrap().unwrap();
    assert_eq!(row.tot.links, 0, "a clone is a file of its own, not a link");
    drop(store);
    fs::remove_dir_all(base).unwrap();
}
