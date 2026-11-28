use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fd_core::{BuildInfo, Config};
use sha2::{Digest, Sha256};

/// A flag that says whether the agent takes work. The binary sets it when the listener is up
/// and clears it on SIGTERM, so `/healthz?ready=1` can fail readiness first.
#[derive(Debug, Clone, Default)]
pub struct Ready(Arc<AtomicBool>);

impl Ready {
    pub fn set(&self, ready: bool) {
        self.0.store(ready, Ordering::SeqCst);
    }

    pub fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What every route may read. Cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub(crate) inner: Arc<Inner>,
    pub ready: Ready,
}

pub(crate) struct Inner {
    pub node: String,
    pub root: String,
    pub read_only: Vec<String>,
    pub token_digest: [u8; 32],
    pub build: BuildInfo,
    pub started_at: u64,
}

impl AppState {
    /// The state for a loaded configuration. The token is kept only as a SHA-256 digest.
    pub fn new(config: &Config, ready: Ready) -> Self {
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        Self {
            inner: Arc::new(Inner {
                node: config.node.clone(),
                root: config.root.clone(),
                // This release has no write route at all, so the whole tree is read only.
                read_only: vec!["/".to_owned()],
                token_digest: Sha256::digest(config.token.expose().as_bytes()).into(),
                build: BuildInfo::current(),
                started_at,
            }),
            ready,
        }
    }
}
