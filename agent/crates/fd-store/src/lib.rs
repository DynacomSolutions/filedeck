//! The folder size store of the FileDeck agent: the walker, the SQLite file and the `du` answer.
//!
//! The file has the schema and the meaning of the TypeScript store (`server/src/size-store.ts`), so either agent can
//! read what the other wrote. This crate is synchronous. The HTTP side runs it on blocking threads.

mod error;
mod rows;
mod schema;
mod store;
mod sums;
mod tree;
mod vpath;
mod walk;

pub use error::StoreError;
pub use rows::Row;
pub use store::{Options, Store, now_ms, random_uuid};
pub use sums::{METRICS, Sums};
pub use tree::{DuEntry, EntryType, TreeEnd};
pub use vpath::{
    Resolved, above, at_or_below, base_name, below, clean_virtual, is_reserved_name, overlaps,
    parent_of, resolve_read, virtual_join,
};
pub use walk::{Ctl, Progress, ScanOut, SizeResult};
