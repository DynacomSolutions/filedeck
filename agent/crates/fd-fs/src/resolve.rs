//! Path resolution under a root, chroot style, one component at a time.
//!
//! - a `..` segment in the client path is refused (400), never clamped
//! - an absolute symlink target is re-based on the root
//! - a relative symlink whose `..` would climb above the root is clamped at the root
//!   (`escaped` is set; a write refuses it)
//! - the final component is followed only when asked
//!
//! Every folder on the way is opened with `openat` and `O_NOFOLLOW`, and the next step starts from that descriptor.
//! A folder that is swapped for a link after the open changes nothing: the descriptor still names the old folder.

use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;

use fd_core::{FsError, assert_not_reserved, clean_virtual};
use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags, Stat, openat, readlinkat, statat};
use rustix::io::Errno;

use crate::map_errno;

/// The most symbolic links one resolution follows.
pub const MAX_LINKS: u32 = 40;

/// The folder the agent serves as `/`.
#[derive(Debug, Clone)]
pub struct Root {
    path: PathBuf,
}

impl Root {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    fn open(&self) -> Result<OwnedFd, FsError> {
        openat(
            CWD,
            &self.path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(map_errno)
    }
}

/// A resolved virtual path: the folder that holds the final name (an open descriptor) and the name.
#[derive(Debug)]
pub struct Resolved {
    /// Canonical virtual path (`/` rooted, no link in the folders on the way)
    pub virtual_path: String,
    /// A link's `..` tried to climb above the root and was clamped
    pub escaped: bool,
    parent: OwnedFd,
    name: Option<OsString>,
    missing: Option<Errno>,
}

const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

fn resolve(root: &Root, input: &str, follow_final: bool) -> Result<Resolved, FsError> {
    let segs = clean_virtual(input)?;
    let root_fd = root.open()?;
    let mut pending: Vec<OsString> = segs.into_iter().rev().map(OsString::from).collect();
    let mut names: Vec<OsString> = Vec::new();
    let mut dirs: Vec<OwnedFd> = Vec::new();
    // Set when a folder on the way is missing or is not a folder: the rest of the path only adds names.
    let mut missing: Option<Errno> = None;
    let mut escaped = false;
    let mut links = 0u32;

    while let Some(seg) = pending.pop() {
        if seg == ".." {
            if names.is_empty() {
                escaped = true;
            } else {
                names.pop();
                if dirs.len() > names.len() {
                    dirs.pop();
                }
                if names.len() <= dirs.len() {
                    missing = None;
                }
            }
            continue;
        }
        if missing.is_some() {
            names.push(seg);
            continue;
        }
        let cur = dirs.last().map_or_else(|| root_fd.as_fd(), AsFd::as_fd);
        let last = pending.is_empty();
        let is_link = statat(cur, seg.as_os_str(), AtFlags::SYMLINK_NOFOLLOW)
            .is_ok_and(|st| FileType::from_raw_mode(st.st_mode) == FileType::Symlink);
        if is_link && (!last || follow_final) {
            links += 1;
            if links > MAX_LINKS {
                return Err(FsError::bad_request("too many symbolic links"));
            }
            let target = readlinkat(cur, seg.as_os_str(), Vec::new())
                .map_err(map_errno)?
                .into_bytes();
            if target.first() == Some(&b'/') {
                names.clear();
                dirs.clear();
                missing = None;
            }
            for part in target.rsplit(|b| *b == b'/') {
                if !part.is_empty() && part != b"." {
                    pending.push(OsString::from_vec(part.to_vec()));
                }
            }
        } else if last {
            names.push(seg);
        } else {
            match openat(cur, seg.as_os_str(), DIR_FLAGS, Mode::empty()) {
                Ok(fd) => dirs.push(fd),
                Err(e) => missing = Some(e),
            }
            names.push(seg);
        }
    }
    // The final name is an opened folder (a link to a folder ended the walk): hold its parent instead.
    if missing.is_none() && !names.is_empty() && dirs.len() == names.len() {
        dirs.pop();
    }
    let parent = match dirs.pop() {
        Some(fd) => fd,
        None => root_fd,
    };
    let virtual_path = format!(
        "/{}",
        names
            .iter()
            .map(|n| n.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    );
    let name = names.pop();
    Ok(Resolved {
        virtual_path,
        escaped,
        parent,
        name,
        missing,
    })
}

/// Resolve for reading: links are followed, clamped at the root. The agent's own folders are refused.
pub fn resolve_read(root: &Root, input: &str) -> Result<Resolved, FsError> {
    let r = resolve(root, input, true)?;
    assert_not_reserved(&r.virtual_path)?;
    Ok(r)
}

/// Resolve the way a change or a `stat` needs: the final component is not followed, and a link's escape is refused.
pub fn resolve_write(root: &Root, input: &str) -> Result<Resolved, FsError> {
    let r = resolve(root, input, false)?;
    if r.escaped {
        return Err(FsError::forbidden("symlink escapes root"));
    }
    Ok(r)
}

impl Resolved {
    /// The error of a folder on the way that is missing or is not a folder.
    pub fn check(&self) -> Result<(), FsError> {
        self.missing.map_or(Ok(()), |e| Err(map_errno(e)))
    }

    /// The final name, or `None` for the root itself.
    pub fn name(&self) -> Option<&OsStr> {
        self.name.as_deref()
    }

    /// The folder that holds the final name.
    pub fn parent(&self) -> Result<&OwnedFd, FsError> {
        self.check()?;
        Ok(&self.parent)
    }

    /// `lstat` of the final name (the root itself for `/`).
    pub fn lstat(&self) -> Result<Stat, FsError> {
        let parent = self.parent()?;
        statat(
            parent,
            self.name.as_deref().unwrap_or(OsStr::new(".")),
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(map_errno)
    }

    /// Open the final name as a folder.
    pub fn open_dir(&self) -> Result<OwnedFd, FsError> {
        let parent = self.parent()?;
        openat(
            parent,
            self.name.as_deref().unwrap_or(OsStr::new(".")),
            DIR_FLAGS,
            Mode::empty(),
        )
        .map_err(map_errno)
    }

    /// Open the final name for reading. `O_NONBLOCK` keeps a FIFO that is swapped in from hanging the open;
    /// the caller checks the type on the descriptor.
    pub fn open_read(&self) -> Result<OwnedFd, FsError> {
        let parent = self.parent()?;
        openat(
            parent,
            self.name.as_deref().unwrap_or(OsStr::new(".")),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(map_errno)
    }

    /// The name as text.
    pub fn name_lossy(&self) -> String {
        self.name.as_deref().map_or_else(String::new, |n| {
            String::from_utf8_lossy(n.as_bytes()).into_owned()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    struct Fx {
        _tmp: tempfile::TempDir,
        root: Root,
        outside: PathBuf,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), "top secret").unwrap();
        fs::write(root.join("a/file.txt"), "hello world").unwrap();
        symlink(&outside, root.join("abs-out")).unwrap();
        symlink("../../../outside", root.join("a/b/rel-out")).unwrap();
        symlink("../../../../../outside", root.join("a/b/deep-out")).unwrap();
        symlink("file.txt", root.join("a/inner")).unwrap();
        symlink("loop2", root.join("loop1")).unwrap();
        symlink("loop1", root.join("loop2")).unwrap();
        Fx {
            _tmp: tmp,
            root: Root::new(root),
            outside,
        }
    }

    #[test]
    fn plain_paths() {
        let f = fx();
        let r = resolve_read(&f.root, "/a/file.txt").unwrap();
        assert_eq!(r.virtual_path, "/a/file.txt");
        assert_eq!(
            resolve_read(&f.root, "a//./file.txt").unwrap().virtual_path,
            "/a/file.txt"
        );
        assert_eq!(resolve_read(&f.root, "/").unwrap().virtual_path, "/");
        assert_eq!(resolve_read(&f.root, "").unwrap().virtual_path, "/");
        assert!(resolve_read(&f.root, "/").unwrap().name().is_none());
    }

    #[test]
    fn dot_dot_is_refused() {
        let f = fx();
        for p in ["/..", "/a/../../etc/passwd", "../x", "/a/b/../..", "/a/.."] {
            assert_eq!(resolve_read(&f.root, p).unwrap_err().status, 400, "{p}");
            assert_eq!(resolve_write(&f.root, p).unwrap_err().status, 400, "{p}");
        }
    }

    #[test]
    fn nul_and_long_paths_are_refused() {
        let f = fx();
        assert_eq!(resolve_read(&f.root, "/a\0b").unwrap_err().status, 400);
        let long = format!("/{}", "a".repeat(5000));
        assert_eq!(resolve_read(&f.root, &long).unwrap_err().status, 400);
    }

    #[test]
    fn absolute_link_is_rebased_on_the_root() {
        let f = fx();
        let r = resolve_read(&f.root, "/abs-out/secret").unwrap();
        // The outside path is now read under the root, where it does not exist.
        assert!(
            r.virtual_path.ends_with("/outside/secret"),
            "{}",
            r.virtual_path
        );
        assert_eq!(r.open_read().unwrap_err().status, 404);
        let _ = &f.outside;
    }

    #[test]
    fn relative_link_climbing_above_the_root_is_clamped_for_read_and_refused_for_write() {
        let f = fx();
        for link in ["/a/b/rel-out/secret", "/a/b/deep-out/secret"] {
            let r = resolve_read(&f.root, link).unwrap();
            assert!(r.escaped, "{link}");
            assert!(r.open_read().is_err(), "{link}");
            let e = resolve_write(&f.root, link).unwrap_err();
            assert_eq!(
                (e.status, e.message.as_str()),
                (403, "symlink escapes root")
            );
        }
    }

    #[test]
    fn write_resolution_does_not_follow_the_final_link() {
        let f = fx();
        assert_eq!(
            resolve_write(&f.root, "/abs-out").unwrap().virtual_path,
            "/abs-out"
        );
        assert_eq!(
            resolve_write(&f.root, "/a/inner").unwrap().virtual_path,
            "/a/inner"
        );
        // read resolution follows it
        assert_eq!(
            resolve_read(&f.root, "/a/inner").unwrap().virtual_path,
            "/a/file.txt"
        );
    }

    #[test]
    fn link_loops_are_refused() {
        let f = fx();
        let e = resolve_read(&f.root, "/loop1/x").unwrap_err();
        assert_eq!(
            (e.status, e.message.as_str()),
            (400, "too many symbolic links")
        );
    }

    #[test]
    fn a_missing_folder_gives_not_found_after_the_reserved_check() {
        let f = fx();
        let r = resolve_read(&f.root, "/nope/deeper/file").unwrap();
        assert_eq!(r.open_read().unwrap_err().status, 404);
        assert_eq!(
            resolve_read(&f.root, "/a/file.txt/x")
                .unwrap()
                .open_read()
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            resolve_read(&f.root, "/nope/.filedeck-trash/x")
                .unwrap_err()
                .status,
            403
        );
    }
}
