/// A failed file operation, with the status and text the TypeScript agent gives (`mapError`).
///
/// `errno` is the raw operating system error when there was one. A caller can then tell a missing target
/// from a refused one without parsing the text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct FsError {
    pub status: u16,
    pub message: String,
    pub errno: Option<i32>,
}

impl FsError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            errno: None,
        }
    }

    pub fn with_errno(mut self, errno: i32) -> Self {
        self.errno = Some(errno);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, message)
    }

    pub fn not_found() -> Self {
        Self::new(404, "not found")
    }
}
