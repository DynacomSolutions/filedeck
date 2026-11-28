use std::path::PathBuf;

/// A start-up error. The text is for the operator and never holds the token.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{name}: {reason}")]
    Invalid { name: &'static str, reason: String },
    #[error("FILEDECK_MODE={0}: this program runs only as an agent (FILEDECK_MODE=agent)")]
    NotAgentMode(String),
    #[error(
        "FILEDECK_AUTH=on is not supported by the Rust agent yet: sign-in needs the TypeScript agent. Unset FILEDECK_AUTH"
    )]
    AuthNotSupported,
    #[error(
        "no agent token: set FILEDECK_AGENT_TOKEN_FILE (a file with mode 0600) or FILEDECK_AGENT_TOKEN"
    )]
    NoToken,
    #[error("FILEDECK_AGENT_TOKEN and FILEDECK_AGENT_TOKEN_FILE are both set: set only one")]
    TwoTokens,
    #[error("token file {}: {reason}", .path.display())]
    TokenFile { path: PathBuf, reason: String },
    #[error("config file {}: {reason}", .path.display())]
    ConfigFile { path: PathBuf, reason: String },
}

impl ConfigError {
    pub(crate) fn invalid(name: &'static str, reason: impl Into<String>) -> Self {
        Self::Invalid {
            name,
            reason: reason.into(),
        }
    }

    pub(crate) fn token_file(path: &std::path::Path, reason: impl Into<String>) -> Self {
        Self::TokenFile {
            path: path.to_path_buf(),
            reason: reason.into(),
        }
    }
}
