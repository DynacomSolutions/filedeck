//! Shared types of the FileDeck agent: configuration, errors, the agent token and build facts.

mod build;
mod config;
mod entry;
mod error;
mod fs_error;
mod token;
mod vpath;

pub use build::BuildInfo;
pub use config::{Config, ConfigSource};
pub use entry::{Entry, EntryType, JsNumber};
pub use error::ConfigError;
pub use fs_error::FsError;
pub use token::Token;
pub use vpath::{
    MAX_VIRTUAL, STAGING_PREFIX, TRASH_DIR, WORK_DIR, assert_not_reserved, clean_virtual,
    is_reserved_name, virtual_join,
};
