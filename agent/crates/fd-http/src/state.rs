use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fd_core::{BuildInfo, Config};

use crate::sizes::Sizes;
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
    pub fs_root: fd_fs::Root,
    pub max_edit: u64,
    pub mounts: fd_fs::MountSource,
    pub token_digest: [u8; 32],
    pub build: BuildInfo,
    pub started_at: u64,
    pub sizes: Option<Arc<Sizes>>,
}

impl AppState {
    /// Shutdown, step one: no new job starts and the running ones stop at their next step.
    pub fn begin_shutdown(&self) {
        if let Some(s) = &self.inner.sizes {
            s.begin_shutdown();
        }
    }

    /// Shutdown, step two: wait until no job runs, then give the store's writer lease back.
    pub async fn drain(&self) {
        if let Some(s) = &self.inner.sizes {
            s.drain().await;
        }
    }

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
                fs_root: fd_fs::Root::new(&config.root),
                max_edit: config.max_edit,
                mounts: fd_fs::MountSource {
                    table: config.proc_mounts.clone(),
                },
                token_digest: Sha256::digest(config.token.expose().as_bytes()).into(),
                build: BuildInfo::current(),
                started_at,
                sizes: Sizes::open(config),
            }),
            ready,
        }
    }
}
