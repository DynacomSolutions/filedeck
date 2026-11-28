use std::io;

/// A failure with the status the TypeScript agent would answer with.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A refusal for the client: the status and the message go out as `{"error": message}`.
    #[error("{message}")]
    Status { status: u16, message: String },
    /// The scan was cancelled.
    #[error("canceled")]
    Canceled,
    /// The database failed.
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
}

impl StoreError {
    pub fn status(status: u16, message: impl Into<String>) -> Self {
        Self::Status {
            status,
            message: message.into(),
        }
    }

    pub fn bad(message: impl Into<String>) -> Self {
        Self::status(400, message)
    }

    /// The HTTP status of this failure (`mapError` of the TypeScript agent).
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Status { status, .. } => *status,
            Self::Canceled => 400,
            Self::Db(_) => 500,
        }
    }

    /// The message the client sees. A database failure is `internal error`, like any unknown failure.
    pub fn client_message(&self) -> String {
        match self {
            Self::Status { message, .. } => message.clone(),
            Self::Canceled => "canceled".to_owned(),
            Self::Db(_) => "internal error".to_owned(),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        use io::ErrorKind::{NotADirectory, NotFound, PermissionDenied, StorageFull};
        match e.kind() {
            NotFound => Self::status(404, "not found"),
            NotADirectory => Self::status(400, "not a directory"),
            PermissionDenied => Self::status(403, "permission denied"),
            StorageFull => Self::status(507, "no space left on device"),
            _ => match e.raw_os_error() {
                Some(21) => Self::status(400, "is a directory"),
                Some(30) => Self::status(403, "permission denied"),
                _ => Self::status(500, "internal error"),
            },
        }
    }
}
