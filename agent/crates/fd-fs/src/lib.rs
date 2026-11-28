//! Confined file access of the FileDeck agent: path resolution under a root, listing, `stat`,
//! file reads with ranges, text reads and the mount list.
//!
//! The rules are the ones of the TypeScript agent (`paths.ts`, `fsops.ts`, `mounts.ts`).
//! A client path is a virtual path under the root. It is resolved one component at a time with `openat`
//! and `O_NOFOLLOW`, so no symbolic link and no swap of a folder can lead out of the root.

mod collate;
mod entry;
mod errno;
mod file;
mod list;
mod mounts;
mod resolve;

pub use collate::{collate, list_order};
pub use entry::{entry_at, stat_entry};
pub use errno::map_errno;
pub use file::{
    OpenedFile, RangeSpec, TextFile, http_date, mime_for, open_file, parse_range, read_text,
};
pub use list::{FIRST_BATCH, Listing, MAX_LIST, Scan, list, scan};
pub use mounts::{Mount, MountSource, is_read_only, list_mounts, parse_mac_mount, parse_mounts};
pub use resolve::{MAX_LINKS, Resolved, Root, resolve_read, resolve_write};
