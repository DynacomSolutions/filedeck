//! The folder size service: the store, the job queue and the scan locks, tied together.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use fd_core::Config;
use fd_store::{Options, SizeResult, Store, StoreError, base_name, now_ms};
use serde_json::{Value, json};

use crate::jobs::{JobError, JobSnapshot, JobSpec, Jobs, Origin, Permit};
use crate::locks::Locks;

/// What a finished `du` job told: folders read from disk, and whether rows were reused on their age under a watcher.
pub(crate) type DuOut = Arc<Mutex<Option<(u64, bool)>>>;

/// A `du` request that started a job (or joined one): later identical requests join it.
pub(crate) struct DuRun {
    pub id: String,
    pub detached: AtomicBool,
    pub out: DuOut,
}

pub struct Sizes {
    pub(crate) store: Arc<Store>,
    pub(crate) jobs: Arc<Jobs>,
    pub(crate) locks: Arc<Locks>,
    pub(crate) runs: Mutex<HashMap<String, Arc<DuRun>>>,
    pub(crate) refreshing: Mutex<HashSet<String>>,
    pub(crate) root: String,
    pub(crate) du_wait_ms: u64,
    pub(crate) refresh_max: usize,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn job_error(e: &StoreError) -> JobError {
    JobError {
        status: e.status_code(),
        message: e.client_message(),
    }
}

impl Sizes {
    /// Open the store named by the settings. A store that cannot be opened at all leaves `None`: the size routes then say so.
    pub fn open(config: &Config) -> Option<Arc<Self>> {
        let mut o = Options::new(config.root.clone());
        o.ttl_ms = i64::try_from(config.index_revalidate_ms).unwrap_or(i64::MAX);
        o.max_entries = config.walk_max_entries;
        let file = config
            .index_dir
            .as_ref()
            .map(|d| d.join(format!("sizes-{}.db", config.node)));
        let store = Store::open(file.as_deref().map(Path::new), o).ok()?;
        Some(Arc::new(Self {
            store: Arc::new(store),
            jobs: Jobs::new(config.job_concurrency, config.du_abandon_ms),
            locks: Locks::new(),
            runs: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashSet::new()),
            root: config.root.clone(),
            du_wait_ms: config.du_wait_ms,
            refresh_max: config.job_concurrency.max(1),
        }))
    }

    pub fn stopping(&self) -> bool {
        self.jobs.is_stopping()
    }

    /// Start a size or `du` job of `virtual_path`. `out` receives what the `du` job learned.
    pub(crate) fn start_scan(
        self: &Arc<Self>,
        kind: &'static str,
        virtual_path: &str,
        fresh: bool,
        origin: Origin,
        out: Option<DuOut>,
    ) -> Value {
        let since = now_ms();
        let title = format!(
            "Size of {}",
            match base_name(virtual_path) {
                "" => "/",
                b => b,
            }
        );
        let params = json!({
            "path": virtual_path,
            "fresh": fresh,
            "freshSince": if fresh { Some(since) } else { None },
            "since": since,
        });
        // the place in line is taken now, so scans start in the order they were asked for
        let mut guard = self.locks.request(virtual_path);
        let gate = Box::pin(async move {
            guard.ready().await;
            Ok((Some(Box::new(guard) as Box<dyn Any + Send>), false))
        });
        let store = Arc::clone(&self.store);
        let v = virtual_path.to_owned();
        let run = Box::new(move |ctl: fd_store::Ctl, permit: Permit| {
            Box::pin(async move {
                let _held = permit;
                let scan =
                    tokio::task::spawn_blocking(move || store.scan_read(&v, &ctl, fresh, since))
                        .await
                        .map_err(|_| JobError {
                            status: 500,
                            message: "internal error".to_owned(),
                        })?
                        .map_err(|e| job_error(&e))?;
                if let Some(o) = out {
                    *lock(&o) = Some((scan.read, scan.untrusted));
                }
                Ok(result_json(kind, &scan.res, scan.read, scan.untrusted))
            }) as crate::jobs::BoxFut<Result<Value, JobError>>
        });
        self.jobs.create(JobSpec {
            kind,
            title,
            origin,
            params,
            run,
            gate: Some(gate),
        })
    }

    /// The live size or `du` job of a path: a second request joins it instead of queuing another walk.
    /// A rescan (`fresh`) only joins a rescan: a cached job would answer it with stale rows.
    pub(crate) fn live_scan(&self, virtual_path: &str, fresh: bool) -> Option<JobSnapshot> {
        self.jobs.find_live(&["du", "size"], |p| {
            p["path"] == virtual_path && (!fresh || p["fresh"] == true)
        })
    }

    /// A live scan of another folder that overlaps this one (a job here would queue behind it).
    pub(crate) fn live_overlap(&self, virtual_path: &str) -> bool {
        self.jobs
            .find_live(&["du", "size"], |p| {
                p["path"]
                    .as_str()
                    .is_some_and(|q| q != virtual_path && fd_store::overlaps(q, virtual_path))
            })
            .is_some()
    }

    /// `true` while this process may walk (it holds the store's writer lease).
    pub(crate) fn may_scan(&self) -> bool {
        self.store.is_writer()
    }

    /// The Prometheus text of the size store and the queue: counts and ages only.
    pub(crate) fn metrics_text(&self) -> String {
        let (queued, oldest) = self.jobs.queued_stats();
        format!(
            "# HELP filedeck_size_store_available 1 when the folder-size store answers from its file, 0 when sizes are not cached\n\
             # TYPE filedeck_size_store_available gauge\n\
             filedeck_size_store_available {}\n\
             # HELP filedeck_size_store_damaged 1 when the store file is damaged and the agent has not yet replaced it with a new one\n\
             # TYPE filedeck_size_store_damaged gauge\n\
             filedeck_size_store_damaged {}\n\
             # HELP filedeck_jobs_queued Jobs of this process that wait to run\n\
             # TYPE filedeck_jobs_queued gauge\n\
             filedeck_jobs_queued {queued}\n\
             # HELP filedeck_jobs_oldest_queued_seconds Age in seconds of the oldest queued job of this process, 0 when none\n\
             # TYPE filedeck_jobs_oldest_queued_seconds gauge\n\
             filedeck_jobs_oldest_queued_seconds {oldest:.3}\n\
             # HELP filedeck_size_lock_oldest_wait_seconds Age in seconds of the oldest size-store lock that waits and is not yet granted, 0 when none\n\
             # TYPE filedeck_size_lock_oldest_wait_seconds gauge\n\
             filedeck_size_lock_oldest_wait_seconds {:.3}\n\
             # HELP filedeck_size_store_write_transactions_total Write transactions of the size store\n\
             # TYPE filedeck_size_store_write_transactions_total counter\n\
             filedeck_size_store_write_transactions_total {}\n",
            i32::from(self.store.persistent()),
            i32::from(self.store.damaged()),
            self.locks.oldest_wait_seconds(),
            self.store.commits(),
        )
    }

    /// Shutdown: stop taking jobs and tell the running ones to stop.
    pub fn begin_shutdown(&self) {
        self.jobs.begin_stop();
    }

    /// Wait until no job runs, then give the writer lease back.
    pub async fn drain(&self) {
        self.jobs.drained().await;
        self.store.release();
    }

    pub(crate) fn forget_stale_runs(&self) {
        const DETACHED_KEEP_MS: i64 = 60_000;
        let mut runs = lock(&self.runs);
        runs.retain(|_, d| match self.jobs.snapshot(&d.id) {
            None => false,
            Some(j) => j.state.live() || now_ms() - j.finished_at.unwrap_or(0) <= DETACHED_KEEP_MS,
        });
    }

    pub(crate) fn note_refresh_ended(&self) {
        let mut set = lock(&self.refreshing);
        set.retain(|id| self.jobs.snapshot(id).is_some_and(|j| j.state.live()));
    }
}

fn result_json(kind: &str, res: &SizeResult, read: u64, untrusted: bool) -> Value {
    let r = serde_json::to_value(res).unwrap_or(Value::Null);
    if kind == "size" {
        let mut m = r.as_object().cloned().unwrap_or_default();
        m.insert("untrusted".into(), json!(untrusted));
        Value::Object(m)
    } else {
        json!({"res": r, "read": read, "untrusted": untrusted})
    }
}

impl Drop for Sizes {
    fn drop(&mut self) {
        self.store.release();
    }
}
