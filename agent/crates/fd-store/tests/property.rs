//! The property test of the spec (2.4): random create, delete, write, rename and hard-link operations, with a restart of the
//! store in the middle. After each round the answer of the store, read incrementally from the rows it kept, equals a rescan from
//! disk (`fresh`) and an independent walk of the tree, for every counter of the folder row.
//!
//! This release has no watcher, so a change is seen the way the TypeScript store sees it without one: through the folder's mtime.
//! A write in place does not change the folder, so a rewrite here goes through a new file renamed over the old one.
//! The same holds for the link count of a file: a new name or a removed name in one folder changes the count of the file
//! in another folder without changing that folder's mtime. So `links` is exact after a rescan from disk, and the incremental
//! answer is compared on every other counter. The watcher of a later release closes this gap, as it does in the TypeScript agent.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use fd_store::{Ctl, Options, Store, Sums, now_ms};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n.max(1)).unwrap()).unwrap()
    }
}

fn list(dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let (mut dirs, mut files) = (vec![], vec![]);
    for e in fs::read_dir(dir).unwrap().flatten() {
        let ft = e.file_type().unwrap();
        if ft.is_dir() {
            dirs.push(e.path());
        } else {
            files.push(e.path());
        }
    }
    dirs.sort();
    files.sort();
    (dirs, files)
}

fn all_dirs(root: &Path) -> Vec<PathBuf> {
    let mut v = vec![root.to_owned()];
    let mut i = 0;
    while i < v.len() {
        let (d, _) = list(&v[i]);
        v.extend(d);
        i += 1;
    }
    v
}

fn all_files(root: &Path) -> Vec<PathBuf> {
    all_dirs(root).iter().flat_map(|d| list(d).1).collect()
}

/// An independent walk: the totals of the folder as the store defines them.
fn oracle(dir: &Path, dev: u64) -> Sums {
    let mut own = Sums::default();
    let mut tot = Sums::default();
    for e in fs::read_dir(dir).unwrap().flatten() {
        let md = e.metadata().unwrap();
        let ft = md.file_type();
        let disk = i64::try_from(md.blocks() * 512).unwrap();
        if ft.is_dir() {
            own.dirs += 1;
            if md.dev() != dev {
                own.mounts += 1;
            } else {
                own.disk += disk;
                tot.add(&oracle(&e.path(), dev), 1);
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
            own.bytes += i64::try_from(md.size()).unwrap();
            own.disk += disk;
        } else {
            own.other += 1;
        }
    }
    tot.add(&own, 1);
    tot
}

fn open(db: &Path, root: &Path) -> Store {
    let mut o = Options::new(root.to_str().unwrap());
    o.ttl_ms = 3_600_000;
    Store::open(Some(db), o).unwrap()
}

fn mutate(rng: &mut Rng, root: &Path, n: &mut u64) {
    for _ in 0..=rng.below(7) {
        *n += 1;
        let dirs = all_dirs(root);
        let files = all_files(root);
        let pick_dir = |rng: &mut Rng| dirs[rng.below(dirs.len())].clone();
        match rng.below(9) {
            0 | 1 => fs::write(
                pick_dir(rng).join(format!("f{n}")),
                vec![b'x'; rng.below(3000)],
            )
            .unwrap(),
            2 if !files.is_empty() => fs::remove_file(&files[rng.below(files.len())]).unwrap(),
            3 => fs::create_dir(pick_dir(rng).join(format!("d{n}"))).unwrap(),
            4 if dirs.len() > 1 => {
                fs::remove_dir_all(&dirs[1 + rng.below(dirs.len() - 1)]).unwrap_or(())
            }
            5 if !files.is_empty() => {
                let from = &files[rng.below(files.len())];
                let _ = fs::rename(from, pick_dir(rng).join(format!("m{n}")));
            }
            6 if dirs.len() > 1 => {
                let from = &dirs[1 + rng.below(dirs.len() - 1)];
                let to = pick_dir(rng);
                if !to.starts_with(from) {
                    let _ = fs::rename(from, to.join(format!("r{n}")));
                }
            }
            7 if !files.is_empty() => {
                let _ = fs::hard_link(
                    &files[rng.below(files.len())],
                    pick_dir(rng).join(format!("h{n}")),
                );
            }
            8 if !files.is_empty() => {
                // a rewrite: a new file renamed over the old one, so the folder changes
                let victim = &files[rng.below(files.len())];
                let tmp = victim.with_extension(format!("tmp{n}"));
                fs::write(&tmp, vec![b'y'; rng.below(5000)]).unwrap();
                fs::rename(&tmp, victim).unwrap();
            }
            _ => {
                let _ = std::os::unix::fs::symlink("nowhere", pick_dir(rng).join(format!("s{n}")));
            }
        }
    }
}

fn run(seed: u64, rounds: usize) {
    let base = std::env::temp_dir().join(format!("fd-store-prop-{seed}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = fs::canonicalize({
        fs::create_dir_all(base.join("root/work")).unwrap();
        base.join("root")
    })
    .unwrap();
    let db = base.join("state/sizes-t.db");
    let work = root.join("work");
    let dev = fs::metadata(&work).unwrap().dev();
    let mut rng = Rng(seed);
    let mut n = 0;
    for i in 0..4 {
        fs::create_dir_all(work.join(format!("s{i}/in"))).unwrap();
        fs::write(work.join(format!("s{i}/in/f")), "seed").unwrap();
    }
    let mut store = open(&db, &root);
    store
        .scan_read("/work", &Ctl::default(), false, now_ms())
        .unwrap();
    for round in 0..rounds {
        if round == rounds / 2 {
            // the restart in the middle: a new process finds the rows the old one left
            drop(store);
            store = open(&db, &root);
        }
        sleep(Duration::from_millis(15)); // a folder changed in the tick of its last read would keep its mtime
        mutate(&mut rng, &work, &mut n);
        let want = oracle(&work, dev);
        store
            .scan_read("/work", &Ctl::default(), false, now_ms())
            .unwrap();
        let mut incremental = store.get("/work").unwrap().unwrap().tot;
        let mut expect = want;
        incremental.links = 0;
        expect.links = 0;
        assert_eq!(
            incremental, expect,
            "seed {seed} round {round}: the store, read from its rows"
        );
        store
            .scan_read("/work", &Ctl::default(), true, now_ms())
            .unwrap();
        let fresh = store.get("/work").unwrap().unwrap().tot;
        assert_eq!(fresh, want, "seed {seed} round {round}: a rescan from disk");
        // the folders below keep their own totals
        for d in all_dirs(&work).iter().skip(1).take(3) {
            let v = format!("/work/{}", d.strip_prefix(&work).unwrap().to_str().unwrap());
            let row = store.get(&v).unwrap().unwrap();
            assert_eq!(row.tot, oracle(d, dev), "seed {seed} round {round}: {v}");
        }
    }
    drop(store);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn the_store_agrees_with_a_rescan_and_with_the_disk_through_random_changes_and_a_restart() {
    for seed in [
        0x9E37_79B9_7F4A_7C15,
        0xD1B5_4A32_D192_ED03,
        0x2545_F491_4F6C_DD1D,
    ] {
        run(seed, 24);
    }
}
