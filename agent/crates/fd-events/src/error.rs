use std::fmt;

/// A refused request: the HTTP status and the message the client sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventError {
    pub status: u16,
    pub message: String,
}

impl EventError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for EventError {}
