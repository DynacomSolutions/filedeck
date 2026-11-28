//! A fuzz test of path resolution: no client path, however it is built, reaches anything outside the root.
//!
//! The fixture holds hostile links (absolute, climbing, looping, chained, to the root, to a folder beside it). A generator
//! (a fixed-seed xorshift, so a failure repeats) builds many paths from the names in the fixture and from `..`, `.` and empty segments.
//! Every call that succeeds must name a file or folder that is inside the root: its (device, inode) must not be one of the
//! folders above the root or anything in the folder beside it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};

use fd_fs::{Root, list, open_file, read_text, resolve_read, resolve_write, stat_entry};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n).unwrap()).unwrap()
    }
}

fn ids_below(dir: &Path, out: &mut HashSet<(u64, u64)>) {
    let m = fs::symlink_metadata(dir).unwrap();
    out.insert((m.dev(), m.ino()));
    if m.is_dir() {
        for e in fs::read_dir(dir).unwrap() {
            ids_below(&e.unwrap().path(), out);
        }
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    outside_dir: PathBuf,
    forbidden: HashSet<(u64, u64)>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let root = base.join("root");
    let outside = base.join("outside");
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::create_dir_all(root.join("dir")).unwrap();
    fs::create_dir_all(outside.join("deep/er")).unwrap();
    fs::write(root.join("a/file.txt"), "inside").unwrap();
    fs::write(root.join("a/b/c/leaf"), "inside leaf").unwrap();
    fs::write(root.join("dir/text.txt"), "text").unwrap();
    fs::write(outside.join("secret"), "OUTSIDE").unwrap();
    fs::write(outside.join("deep/er/secret"), "OUTSIDE").unwrap();
    let deep_up = "../".repeat(40);
    let links: Vec<(String, String)> = vec![
        ("abs_out".into(), outside.to_str().unwrap().into()),
        ("abs_out_file".into(), outside.join("secret").to_str().unwrap().into()),
        ("abs_base".into(), base.to_str().unwrap().into()),
        ("abs_slash".into(), "/".into()),
        ("abs_etc".into(), "/etc".into()),
        ("a/up1".into(), "..".into()),
        ("a/up2".into(), "../..".into()),
        ("a/up3".into(), "../../..".into()),
        ("a/b/up_far".into(), format!("{deep_up}{}", outside.to_str().unwrap().trim_start_matches('/'))),
        ("a/b/to_outside".into(), "../../../outside".into()),
        ("a/b/to_outside_file".into(), "../../../outside/secret".into()),
        ("a/b/c/dots".into(), "./../c/./../../b/../file.txt".into()),
        ("a/self".into(), ".".into()),
        ("a/fileln".into(), "file.txt".into()),
        ("loop1".into(), "loop2".into()),
        ("loop2".into(), "loop1".into()),
        ("chain1".into(), "chain2".into()),
        ("chain2".into(), "chain3".into()),
        ("chain3".into(), "a/up2/outside".into()),
        ("dir/back".into(), "../a/b/c".into()),
        ("dir/root_abs".into(), "/".into()),
        ("dir/missing".into(), "no/such/place".into()),
        ("dir/empty_target".into(), "a//b///c".into()),
    ];
    for (name, target) in &links {
        symlink(target, root.join(name)).unwrap();
    }
    let mut forbidden = HashSet::new();
    ids_below(&outside, &mut forbidden);
    // every folder above the root, up to /
    let mut up = root.parent();
    while let Some(p) = up {
        let m = fs::symlink_metadata(p).unwrap();
        forbidden.insert((m.dev(), m.ino()));
        up = p.parent();
    }
    // some files of the host
    for host in ["/etc", "/etc/passwd", "/etc/hosts", "/usr", "/bin", "/tmp"] {
        if let Ok(m) = fs::metadata(host) {
            forbidden.insert((m.dev(), m.ino()));
        }
    }
    // The root itself and what it holds are fine. A hard link or a bind mount of the same inode is not in this fixture.
    let mut inside = HashSet::new();
    ids_below(&root, &mut inside);
    forbidden.retain(|id| !inside.contains(id));
    Fixture {
        _tmp: tmp,
        root,
        outside_dir: outside,
        forbidden,
    }
}

const NAMES: &[&str] = &[
    "a", "b", "c", "dir", "file.txt", "leaf", "text.txt", "abs_out", "abs_out_file", "abs_base",
    "abs_slash", "abs_etc", "up1", "up2", "up3", "up_far", "to_outside", "to_outside_file", "dots",
    "self", "fileln", "loop1", "loop2", "chain1", "chain2", "chain3", "back", "root_abs", "missing",
    "empty_target", "outside", "secret", "etc", "passwd", "tmp", "nothing", ".hidden",
    ".filedeck-trash", ".filedeck-work-x", "a\u{e9}", "\u{1f600}", "a", "b", "c", "a", "file.txt",
];

/// Segments that change the shape of a path.
const SHAPES: &[&str] = &[".", "", " ", "..", "..", ".."];

fn random_path(r: &mut Rng) -> String {
    if r.below(2) == 0 {
        return structured_path(r);
    }
    let n = 1 + r.below(5);
    let mut p = String::new();
    if r.below(5) != 0 {
        p.push('/');
    }
    for i in 0..n {
        if i > 0 {
            p.push('/');
            if r.below(10) == 0 {
                p.push('/');
            }
        }
        let pool = if r.below(8) == 0 { SHAPES } else { NAMES };
        p.push_str(pool[r.below(pool.len())]);
    }
    if r.below(8) == 0 {
        p.push('/');
    }
    p
}

fn assert_inside(fx: &Fixture, id: (u64, u64), what: &str, path: &str) {
    assert!(
        !fx.forbidden.contains(&id),
        "{what} reached something outside the root: {path:?}"
    );
}

#[test]
fn no_path_leads_out_of_the_root() {
    let fx = fixture();
    let root = Root::new(&fx.root);
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut opened, mut listed) = (0usize, 0usize);
    for _ in 0..40_000 {
        let p = random_path(&mut r);

        for resolved in [resolve_read(&root, &p), resolve_write(&root, &p)] {
            let Ok(res) = resolved else { continue };
            assert!(res.virtual_path.starts_with('/'), "{p:?}");
            assert!(
                !res.virtual_path.split('/').any(|s| s == ".." || s == "."),
                "virtual path {:?} for {p:?}",
                res.virtual_path
            );
            if let Ok(st) = res.lstat() {
                assert_inside(&fx, (st.st_dev as u64, st.st_ino as u64), "lstat", &p);
            }
            if let Ok(fd) = res.open_dir() {
                let m = fs::File::from(fd).metadata().unwrap();
                assert_inside(&fx, (m.dev(), m.ino()), "open_dir", &p);
            }
        }

        if let Ok(f) = open_file(&root, &p) {
            let m = f.file.metadata().unwrap();
            assert_inside(&fx, (m.dev(), m.ino()), "open_file", &p);
            opened += 1;
        }
        if let Ok(t) = read_text(&root, &p, 1 << 20) {
            assert!(!t.content.contains("OUTSIDE"), "read_text leaked: {p:?}");
        }
        if let Ok(l) = list(&root, &p, true) {
            listed += 1;
            for e in &l.entries {
                assert!(e.path.starts_with('/') && !e.path.contains("/../"), "{p:?}: {}", e.path);
                assert!(!fd_core::is_reserved_name(&e.name), "{p:?}: {}", e.name);
            }
            // the listing of a folder never shows the folder beside the root
            if l.path == "/" {
                assert!(l.entries.iter().all(|e| e.name != "secret"), "{p:?}");
            }
        }
        if let Ok(e) = stat_entry(&root, &p) {
            assert!(e.path.starts_with('/'), "{p:?}");
        }
    }
    // The generator must reach real files and folders, or the test proves nothing.
    assert!(opened > 300, "only {opened} files opened");
    assert!(listed > 200, "only {listed} folders listed");
    // and the outside folder is as it was
    assert_eq!(fs::read_to_string(fx.outside_dir.join("secret")).unwrap(), "OUTSIDE");
}

#[test]
fn the_known_escapes_all_fail() {
    let fx = fixture();
    let root = Root::new(&fx.root);
    for p in [
        "/abs_out/secret",
        "/abs_out_file",
        "/a/b/to_outside/secret",
        "/a/b/to_outside_file",
        "/a/b/up_far/secret",
        "/chain1/secret",
        "/abs_etc/passwd",
        "/abs_base/outside/secret",
    ] {
        assert!(open_file(&root, p).is_err(), "{p}");
        assert!(read_text(&root, p, 1 << 20).is_err(), "{p}");
    }
    // links to "/" are the root itself, never the host's root
    let l = list(&root, "/abs_slash", true).unwrap();
    assert_eq!(l.path, "/");
    assert!(l.entries.iter().any(|e| e.name == "a"));
    assert!(l.entries.iter().all(|e| e.name != "etc"));
}

/// A path that starts at a real folder and ends at a real name, with links and dot segments between.
fn structured_path(r: &mut Rng) -> String {
    const BASES: &[&str] = &["", "/a", "/a/b", "/a/b/c", "/dir"];
    const LINKS: &[&str] = &[
        "abs_out", "abs_slash", "up1", "up2", "up3", "up_far", "to_outside", "self", "back", "root_abs", "dots",
        "abs_base", "abs_etc", "chain1", "..", ".", "",
    ];
    const ENDS: &[&str] = &["file.txt", "leaf", "text.txt", "secret", "fileln", "passwd", "outside", "c", "b"];
    let mut p = BASES[r.below(BASES.len())].to_owned();
    for _ in 0..r.below(4) {
        p.push('/');
        p.push_str(LINKS[r.below(LINKS.len())]);
    }
    p.push('/');
    p.push_str(ENDS[r.below(ENDS.len())]);
    p
}
