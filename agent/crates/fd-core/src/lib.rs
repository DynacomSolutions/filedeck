//! Shared types of the FileDeck agent: configuration, errors, the agent token and build facts.

mod build;
mod config;
mod error;
mod token;

pub use build::BuildInfo;
pub use config::{Config, ConfigSource};
pub use error::ConfigError;
pub use token::Token;
