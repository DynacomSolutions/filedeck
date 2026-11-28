//! The job queue: bounded concurrency, progress, cancel, a long poll on the state.
//!
//! Nothing here runs on a free timer. A deadline is armed only while there is work for it: a running scan that may
//! become a "big" one, and a queued `du` job that nobody asks about.

use std::any::Any;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fd_store::{Ctl, Progress, now_ms, random_uuid};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;
use tokio::time::Instant;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What a gate hands to its job: a held lock, kept until the job ends.
pub type Permit = Option<Box<dyn Any + Send>>;

/// A failed job: the status is kept for the caller that waits for it.
#[derive(Debug, Clone)]
pub struct JobError {
    pub status: u16,
    pub message: String,
}

type RunFn = Box<dyn FnOnce(Ctl, Permit) -> BoxFut<Result<Value, JobError>> + Send>;
type GateFut = BoxFut<Result<(Permit, bool), JobError>>;

/// Who started a job: `ui` a person in the web UI, the rest run in the background.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Ui,
    Cli,
}

impl Origin {
    fn name(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Cli => "cli",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Queued,
    Running,
    Done,
    Failed,
    Canceled,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub fn live(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

/// A job as the routes and the du route see it.
#[derive(Debug, Clone)]
pub struct JobSnapshot {
    pub id: String,
    pub state: State,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<(u16, String)>,
    pub result: Option<Value>,
}

struct Job {
    id: String,
    kind: &'static str,
    title: String,
    state: State,
    origin: Origin,
    ctl: Ctl,
    error: Option<(u16, String)>,
    result: Option<Value>,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    seen_at: Option<i64>,
    params: Value,
    gated: bool,
    urgent: bool,
    big: bool,
    run: Option<RunFn>,
    permit: Permit,
    /// ends the wait of a gate whose job was cancelled
    stop_gate: Arc<Notify>,
    /// the job has ended (stops the deadline tasks that belong to it)
    ended: Arc<Notify>,
}

struct Inner {
    jobs: Vec<Job>,
    running: usize,
}

/// A running scan stops counting against the concurrency limit after this long, so a small scan queued behind it still starts.
const BIG_SCAN_MS: u64 = 30_000;

pub struct Jobs {
    inner: Mutex<Inner>,
    changed: Notify,
    idle: Notify,
    concurrency: usize,
    keep: usize,
    abandon_ms: u64,
    stopping: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What `create` takes.
pub struct JobSpec {
    pub kind: &'static str,
    pub title: String,
    pub origin: Origin,
    pub params: Value,
    pub run: RunFn,
    /// waits for what the job needs (a lock) without a job slot; `true` = start at once, outside the limit
    pub gate: Option<GateFut>,
}

impl Jobs {
    pub fn new(concurrency: usize, abandon_ms: u64) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                jobs: Vec::new(),
                running: 0,
            }),
            changed: Notify::new(),
            idle: Notify::new(),
            concurrency: concurrency.max(1),
            keep: 100,
            abandon_ms,
            stopping: AtomicBool::new(false),
        })
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Queue a job. It exists at once; it starts when its gate has opened and a slot is free.
    pub fn create(self: &Arc<Self>, spec: JobSpec) -> Value {
        let id = random_uuid();
        let stop_gate = Arc::new(Notify::new());
        let ended = Arc::new(Notify::new());
        let created_at = now_ms();
        let gated = spec.gate.is_some();
        let job = Job {
            id: id.clone(),
            kind: spec.kind,
            title: spec.title,
            state: State::Queued,
            origin: spec.origin,
            ctl: Ctl::default(),
            error: None,
            result: None,
            created_at,
            started_at: None,
            finished_at: None,
            seen_at: None,
            params: spec.params,
            gated,
            urgent: false,
            big: false,
            run: Some(spec.run),
            permit: None,
            stop_gate: Arc::clone(&stop_gate),
            ended: Arc::clone(&ended),
        };
        let abandonable = self.abandonable(job.kind, job.origin);
        let view = {
            let mut g = lock(&self.inner);
            g.jobs.push(job);
            self.prune(&mut g);
            let me = g.jobs.len() - 1;
            self.view_of(&g, me)
        };
        self.changed.notify_waiters();
        if let Some(gate) = spec.gate {
            let me = Arc::clone(self);
            let jid = id.clone();
            tokio::spawn(async move {
                let r = tokio::select! {
                    r = gate => Some(r),
                    () = stop_gate.notified() => None,
                };
                {
                    let mut g = lock(&me.inner);
                    if let Some(j) = g.jobs.iter_mut().find(|j| j.id == jid) {
                        j.gated = false;
                        match r {
                            Some(Ok((permit, urgent))) if j.state == State::Queued => {
                                j.permit = permit;
                                j.urgent = urgent;
                            }
                            Some(Err(e)) if j.state == State::Queued => {
                                j.state = State::Failed;
                                j.error = Some((e.status, e.message));
                                j.finished_at = Some(now_ms());
                                j.run = None;
                                j.ended.notify_waiters();
                            }
                            _ => {}
                        }
                    }
                }
                me.changed.notify_waiters();
                me.pump();
            });
        } else {
            self.pump();
        }
        if abandonable {
            self.arm_abandon(&id, ended);
        }
        view
    }

    fn abandonable(&self, kind: &str, origin: Origin) -> bool {
        self.abandon_ms > 0 && kind == "du" && origin == Origin::Cli
    }

    /// One deadline for a queued `du` job: when nobody has asked about it for the grace period, it is forgotten.
    fn arm_abandon(self: &Arc<Self>, id: &str, ended: Arc<Notify>) {
        let me = Arc::clone(self);
        let id = id.to_owned();
        let grace = i64::try_from(self.abandon_ms).unwrap_or(i64::MAX);
        tokio::spawn(async move {
            loop {
                let due = {
                    let g = lock(&me.inner);
                    let Some(j) = g.jobs.iter().find(|j| j.id == id) else {
                        return;
                    };
                    if j.state != State::Queued {
                        return;
                    }
                    j.seen_at.unwrap_or(0).max(j.created_at) + grace
                };
                let wait = u64::try_from(due - now_ms()).unwrap_or(0);
                if wait == 0 {
                    me.forget(&id);
                    return;
                }
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(wait)) => {}
                    () = ended.notified() => return,
                }
            }
        });
    }

    /// Forget a job at once: a returning client gets 404 and asks for the scan again.
    fn forget(&self, id: &str) {
        self.cancel(id);
        let mut g = lock(&self.inner);
        g.jobs.retain(|j| j.id != id || j.state.live());
        drop(g);
        self.changed.notify_waiters();
    }

    fn can_start(&self, g: &Inner) -> bool {
        let big = g
            .jobs
            .iter()
            .filter(|j| j.state == State::Running && j.big)
            .count();
        g.running - big < self.concurrency && g.running < self.concurrency + 2
    }

    /// Start what may start.
    fn pump(self: &Arc<Self>) {
        if self.is_stopping() {
            return;
        }
        loop {
            let started = {
                let mut g = lock(&self.inner);
                let mut pick = None;
                for i in 0..g.jobs.len() {
                    let j = &g.jobs[i];
                    if j.state != State::Queued || j.gated || j.run.is_none() {
                        continue;
                    }
                    if !j.urgent && !self.can_start(&g) {
                        continue;
                    }
                    pick = Some(i);
                    break;
                }
                let Some(i) = pick else { return };
                g.running += 1;
                let j = &mut g.jobs[i];
                j.state = State::Running;
                j.started_at = Some(now_ms());
                (
                    j.id.clone(),
                    j.kind,
                    j.run.take(),
                    j.permit.take(),
                    j.ctl.clone(),
                    Arc::clone(&j.ended),
                )
            };
            self.changed.notify_waiters();
            let (id, kind, run, permit, ctl, ended) = started;
            let Some(run) = run else { continue };
            if kind == "du" || kind == "size" {
                self.arm_big(&id, Arc::clone(&ended));
            }
            let me = Arc::clone(self);
            let cancel = Arc::clone(&ctl.cancel);
            tokio::spawn(async move {
                let r = run(ctl, permit).await;
                me.finish(&id, &cancel, r);
                ended.notify_waiters();
                me.changed.notify_waiters();
                me.pump();
            });
        }
    }

    /// A running scan that goes on for `BIG_SCAN_MS` stops counting against the limit.
    fn arm_big(self: &Arc<Self>, id: &str, ended: Arc<Notify>) {
        let me = Arc::clone(self);
        let id = id.to_owned();
        tokio::spawn(async move {
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(BIG_SCAN_MS)) => {}
                () = ended.notified() => return,
            }
            {
                let mut g = lock(&me.inner);
                if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id)
                    && j.state == State::Running
                {
                    j.big = true;
                }
            }
            me.pump();
        });
    }

    fn finish(&self, id: &str, cancel: &AtomicBool, r: Result<Value, JobError>) {
        let mut g = lock(&self.inner);
        if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id) {
            if cancel.load(Ordering::SeqCst) {
                j.state = State::Canceled;
            } else {
                match r {
                    Ok(v) => {
                        j.state = State::Done;
                        j.result = Some(v);
                    }
                    Err(e) => {
                        j.state = State::Failed;
                        j.error = Some((e.status, e.message));
                    }
                }
            }
            j.finished_at = Some(now_ms());
        }
        g.running = g.running.saturating_sub(1);
        self.prune(&mut g);
        if g.running == 0 {
            self.idle.notify_waiters();
        }
    }

    fn prune(&self, g: &mut Inner) {
        let mut fin: Vec<(i64, String)> = g
            .jobs
            .iter()
            .filter_map(|j| j.finished_at.map(|f| (f, j.id.clone())))
            .collect();
        if fin.len() <= self.keep {
            return;
        }
        fin.sort();
        let drop_n = fin.len() - self.keep;
        let gone: HashSet<String> = fin.into_iter().take(drop_n).map(|(_, id)| id).collect();
        g.jobs.retain(|j| !gone.contains(&j.id));
    }

    /// A client waits on or polls this job: it is not abandoned.
    pub fn touch(&self, id: &str) {
        let mut g = lock(&self.inner);
        if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id) {
            j.seen_at = Some(now_ms());
        }
    }

    fn view_of(&self, g: &Inner, i: usize) -> Value {
        let j = &g.jobs[i];
        let p: &Progress = &j.ctl.progress;
        let current = p.current.lock().map(|c| c.clone()).unwrap_or_default();
        let mut m = Map::new();
        m.insert("id".into(), json!(j.id));
        m.insert("kind".into(), json!(j.kind));
        m.insert("title".into(), json!(j.title));
        m.insert("state".into(), json!(j.state.name()));
        m.insert("origin".into(), json!(j.origin.name()));
        m.insert(
            "progress".into(),
            json!({
                "bytes": p.bytes.load(Ordering::Relaxed),
                "totalBytes": p.total_bytes.load(Ordering::Relaxed),
                "entries": p.entries.load(Ordering::Relaxed),
                "totalEntries": p.total_entries.load(Ordering::Relaxed),
                "current": current,
            }),
        );
        if let Some((_, e)) = &j.error {
            m.insert("error".into(), json!(e));
        }
        if let Some(r) = &j.result {
            m.insert("result".into(), r.clone());
        }
        m.insert("createdAt".into(), json!(j.created_at));
        if let Some(t) = j.started_at {
            m.insert("startedAt".into(), json!(t));
        }
        if let Some(t) = j.finished_at {
            m.insert("finishedAt".into(), json!(t));
        }
        if let Some(t) = j.seen_at {
            m.insert("seenAt".into(), json!(t));
        }
        if j.state == State::Queued {
            let mut order: Vec<usize> = (0..g.jobs.len()).collect();
            order.sort_by_key(|&k| g.jobs[k].created_at);
            let me = order.iter().position(|&k| k == i).unwrap_or(0);
            let ahead: Vec<Value> = order
                .iter()
                .enumerate()
                .filter(|(pos, k)| {
                    let x = &g.jobs[**k];
                    x.state == State::Running || (x.state == State::Queued && *pos < me)
                })
                .map(|(_, k)| {
                    let x = &g.jobs[*k];
                    json!({"id": x.id, "title": x.title, "state": x.state.name()})
                })
                .collect();
            m.insert(
                "queue".into(),
                json!({"position": ahead.len(), "ahead": ahead}),
            );
        }
        Value::Object(m)
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let g = lock(&self.inner);
        let i = g.jobs.iter().position(|j| j.id == id)?;
        Some(self.view_of(&g, i))
    }

    /// The job as the du route reads it.
    pub fn snapshot(&self, id: &str) -> Option<JobSnapshot> {
        let g = lock(&self.inner);
        let j = g.jobs.iter().find(|j| j.id == id)?;
        Some(JobSnapshot {
            id: j.id.clone(),
            state: j.state,
            created_at: j.created_at,
            started_at: j.started_at,
            finished_at: j.finished_at,
            error: j.error.clone(),
            result: j.result.clone(),
        })
    }

    pub fn list(&self) -> Vec<Value> {
        let g = lock(&self.inner);
        let mut order: Vec<usize> = (0..g.jobs.len()).collect();
        order.sort_by_key(|&k| std::cmp::Reverse(g.jobs[k].created_at));
        order.into_iter().map(|i| self.view_of(&g, i)).collect()
    }

    /// A queued or running job of `kind` whose params match.
    pub fn find_live(
        &self,
        kinds: &[&str],
        matches: impl Fn(&Value) -> bool,
    ) -> Option<JobSnapshot> {
        let id = {
            let g = lock(&self.inner);
            g.jobs
                .iter()
                .find(|j| kinds.contains(&j.kind) && j.state.live() && matches(&j.params))
                .map(|j| j.id.clone())?
        };
        self.snapshot(&id)
    }

    /// Cancel a job: a queued one ends at once, a running one stops at its next step.
    pub fn cancel(&self, id: &str) -> Option<Value> {
        {
            let mut g = lock(&self.inner);
            let j = g.jobs.iter_mut().find(|j| j.id == id)?;
            match j.state {
                State::Queued => {
                    j.state = State::Canceled;
                    j.finished_at = Some(now_ms());
                    j.ctl.cancel.store(true, Ordering::SeqCst);
                    j.run = None;
                    j.permit = None;
                    j.stop_gate.notify_one();
                    j.ended.notify_waiters();
                }
                State::Running => j.ctl.cancel.store(true, Ordering::SeqCst),
                _ => {}
            }
        }
        self.changed.notify_waiters();
        self.get(id)
    }

    /// Forget a finished job. False when it is unknown or still live.
    pub fn dismiss(&self, id: &str) -> bool {
        let mut g = lock(&self.inner);
        let Some(i) = g.jobs.iter().position(|j| j.id == id) else {
            return false;
        };
        if g.jobs[i].state.live() {
            return false;
        }
        g.jobs.remove(i);
        true
    }

    /// Queued jobs and the age in seconds of the oldest (0 when none), for the metrics.
    pub fn queued_stats(&self) -> (usize, f64) {
        let g = lock(&self.inner);
        let now = now_ms();
        let q: Vec<i64> = g
            .jobs
            .iter()
            .filter(|j| j.state == State::Queued)
            .map(|j| j.created_at)
            .collect();
        let oldest = q.iter().copied().min().map_or(0.0, |c| {
            #[allow(clippy::cast_precision_loss)]
            let s = (now - c).max(0) as f64 / 1000.0;
            s
        });
        (q.len(), oldest)
    }

    /// Wait until the job has ended (not queued or running), `deadline` passes, or the caller drops the future.
    /// Returns the last snapshot.
    pub async fn until_ended(&self, id: &str, deadline: Instant) -> Option<JobSnapshot> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let s = self.snapshot(id)?;
            if !s.state.live() || Instant::now() >= deadline {
                return Some(s);
            }
            tokio::select! {
                () = &mut notified => {}
                () = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Shutdown: stop starting jobs and tell every live job to stop.
    pub fn begin_stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        {
            let g = lock(&self.inner);
            for j in g.jobs.iter().filter(|j| j.state.live()) {
                j.ctl.cancel.store(true, Ordering::SeqCst);
                j.stop_gate.notify_one();
            }
        }
        self.changed.notify_waiters();
    }

    /// Wait until no job runs.
    pub async fn drained(&self) {
        loop {
            let n = self.idle.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if lock(&self.inner).running == 0 {
                return;
            }
            n.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: &'static str, run: RunFn) -> JobSpec {
        JobSpec {
            kind,
            title: "t".into(),
            origin: Origin::Ui,
            params: json!({"path": "/x"}),
            run,
            gate: None,
        }
    }

    #[tokio::test]
    async fn jobs_run_in_turn_within_the_limit_and_report_their_result() {
        let jobs = Jobs::new(1, 0);
        let gate = Arc::new(Notify::new());
        let g2 = Arc::clone(&gate);
        let a = jobs.create(spec(
            "size",
            Box::new(move |_, _| {
                Box::pin(async move {
                    g2.notified().await;
                    Ok(json!({"n": 1}))
                })
            }),
        ));
        let b = jobs.create(spec(
            "size",
            Box::new(|_, _| Box::pin(async { Ok(json!({"n": 2})) })),
        ));
        let (ida, idb) = (
            a["id"].as_str().unwrap().to_owned(),
            b["id"].as_str().unwrap().to_owned(),
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(jobs.get(&ida).unwrap()["state"], "running");
        let vb = jobs.get(&idb).unwrap();
        assert_eq!(vb["state"], "queued");
        assert_eq!(vb["queue"]["position"], 1);
        gate.notify_one();
        let end = Instant::now() + Duration::from_secs(5);
        let done = jobs.until_ended(&idb, end).await.unwrap();
        assert_eq!(done.state, State::Done);
        assert_eq!(done.result.unwrap()["n"], 2);
        assert_eq!(jobs.queued_stats().0, 0);
    }

    #[tokio::test]
    async fn a_queued_job_cancels_at_once_and_a_running_one_gets_the_flag() {
        let jobs = Jobs::new(1, 0);
        let a = jobs.create(spec(
            "size",
            Box::new(|ctl, _| {
                Box::pin(async move {
                    while !ctl.cancel.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    Ok(Value::Null)
                })
            }),
        ));
        let b = jobs.create(spec(
            "size",
            Box::new(|_, _| Box::pin(async { Ok(Value::Null) })),
        ));
        let (ida, idb) = (
            a["id"].as_str().unwrap().to_owned(),
            b["id"].as_str().unwrap().to_owned(),
        );
        assert_eq!(jobs.cancel(&idb).unwrap()["state"], "canceled");
        jobs.cancel(&ida);
        let end = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            jobs.until_ended(&ida, end).await.unwrap().state,
            State::Canceled
        );
        assert!(jobs.dismiss(&idb));
        assert!(jobs.get(&idb).is_none());
    }

    #[tokio::test]
    async fn a_queued_cli_du_job_that_nobody_asks_about_is_forgotten() {
        let jobs = Jobs::new(1, 120);
        let _busy = jobs.create(spec(
            "size",
            Box::new(|ctl, _| {
                Box::pin(async move {
                    while !ctl.cancel.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    Ok(Value::Null)
                })
            }),
        ));
        let mut s = spec("du", Box::new(|_, _| Box::pin(async { Ok(Value::Null) })));
        s.origin = Origin::Cli;
        let kept = jobs.create(s);
        let mut s2 = spec("du", Box::new(|_, _| Box::pin(async { Ok(Value::Null) })));
        s2.origin = Origin::Cli;
        let polled = jobs.create(s2);
        let (idk, idp) = (
            kept["id"].as_str().unwrap().to_owned(),
            polled["id"].as_str().unwrap().to_owned(),
        );
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            jobs.touch(&idp);
        }
        assert!(jobs.get(&idk).is_none(), "forgotten");
        assert_eq!(
            jobs.get(&idp).unwrap()["state"],
            "queued",
            "a polled job stays"
        );
        jobs.begin_stop();
    }
}
