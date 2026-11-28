use std::ffi::OsStr;
use std::os::fd::AsFd;
use std::os::unix::ffi::OsStrExt;

use fd_core::{Entry, EntryType, FsError, JsNumber, assert_not_reserved, virtual_join};
use rustix::fs::{AtFlags, FileType, Stat, readlinkat, statat};
use rustix::io::Errno;

use crate::resolve::{Root, resolve_read, resolve_write};

pub(crate) fn kind_of(st: &Stat) -> EntryType {
    match FileType::from_raw_mode(st.st_mode) {
        FileType::Symlink => EntryType::Symlink,
        FileType::Directory => EntryType::Dir,
        FileType::RegularFile => EntryType::File,
        _ => EntryType::Other,
    }
}

/// `mtimeMs` as Node gives it: whole seconds times 1000 plus the nanoseconds in milliseconds.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub(crate) fn mtime_ms(st: &Stat) -> f64 {
    (st.st_mtime as f64) * 1e3 + (st.st_mtime_nsec as f64) / 1e6
}

/// The permission bits. `st_mode` is 16 bits wide on macOS and 32 on Linux.
#[allow(clippy::unnecessary_cast)]
pub(crate) fn mode_bits(st: &Stat) -> u32 {
    (st.st_mode as u32) & 0o7777
}

/// Whether the link at `virtual_path` leads to a folder. A link that cannot be resolved does not.
pub(crate) fn link_is_dir(root: &Root, virtual_path: &str) -> bool {
    resolve_read(root, virtual_path)
        .and_then(|r| r.lstat())
        .is_ok_and(|st| kind_of(&st) == EntryType::Dir)
}

/// The entry of one name in an open folder. `None` when the name vanished or cannot be named.
pub fn entry_at(
    root: &Root,
    parent_virtual: &str,
    parent: impl AsFd,
    name: &OsStr,
) -> Option<Entry> {
    let st = statat(parent.as_fd(), name, AtFlags::SYMLINK_NOFOLLOW).ok()?;
    entry_of(root, parent_virtual, parent.as_fd(), name, &st)
}

#[allow(clippy::cast_sign_loss)]
fn entry_of(
    root: &Root,
    parent_virtual: &str,
    parent: impl AsFd,
    name: &OsStr,
    st: &Stat,
) -> Option<Entry> {
    let text = String::from_utf8_lossy(name.as_bytes()).into_owned();
    let path = virtual_join(parent_virtual, &text).ok()?;
    let kind = kind_of(st);
    let mut e = Entry {
        name: text,
        path,
        kind,
        size: st.st_size.max(0) as u64,
        mtime: JsNumber(mtime_ms(st)),
        mode: mode_bits(st),
        target: None,
        link_dir: None,
        broken: None,
    };
    if kind == EntryType::Symlink {
        e.target = readlinkat(parent.as_fd(), name, Vec::new())
            .ok()
            .map(|t| String::from_utf8_lossy(t.to_bytes()).into_owned());
        // Confined: the target is resolved under the root, never on the host.
        match resolve_read(root, &e.path) {
            Ok(r) => match r.lstat() {
                Ok(t) => e.link_dir = Some(kind_of(&t) == EntryType::Dir),
                Err(err) => {
                    e.link_dir = Some(false);
                    e.broken = Some(
                        err.errno == Some(Errno::NOENT.raw_os_error())
                            || err.errno == Some(Errno::NOTDIR.raw_os_error())
                            || err.errno == Some(Errno::LOOP.raw_os_error()),
                    );
                }
            },
            Err(_) => {
                // A loop of links or a reserved target: not a folder, not reported as broken.
                e.link_dir = Some(false);
                e.broken = Some(false);
            }
        }
    }
    Some(e)
}

/// `GET /api/fs/stat`: the entry of the final name, links not followed.
pub fn stat_entry(root: &Root, path: &str) -> Result<Entry, FsError> {
    let r = resolve_write(root, path)?;
    assert_not_reserved(&r.virtual_path)?;
    let st = r.lstat()?;
    if r.virtual_path == "/" {
        // The root has no parent in the virtual tree. Its name is the last part of the real root path.
        let name = root
            .path()
            .file_name()
            .map(|n| String::from_utf8_lossy(n.as_bytes()).into_owned())
            .unwrap_or_default();
        return Ok(Entry {
            name,
            path: "/".into(),
            kind: kind_of(&st),
            size: st.st_size.max(0) as u64,
            mtime: JsNumber(mtime_ms(&st)),
            mode: mode_bits(&st),
            target: None,
            link_dir: None,
            broken: None,
        });
    }
    let parent_virtual = match r.virtual_path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(i) => r.virtual_path[..i].to_owned(),
    };
    let name = r.name().ok_or_else(FsError::not_found)?;
    entry_of(root, &parent_virtual, r.parent()?, name, &st).ok_or_else(FsError::not_found)
}
