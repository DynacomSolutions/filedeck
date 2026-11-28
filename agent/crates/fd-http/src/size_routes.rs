//! `GET /api/du`, `POST /api/jobs/size` and the job routes.
//!
//! The answers are those of the TypeScript agent (`props.ts`, `archive-routes.ts`). There is no watcher in this release, so
//! no folder is "vouched for": a `du` is answered by a job unless the stored rows are asked for (`cachedOnly`, `refresh=auto`).

use std::collections::HashMap;
use std::convert::Infallible;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxPath, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use fd_store::{DuEntry, Row, StoreError, now_ms, resolve_read};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_stream::wrappers::ReceiverStream;

use crate::jobs::{JobSnapshot, Origin, State as JobState};
use crate::json_error;
use crate::sizes::{DuOut, DuRun, Sizes, lock};
use crate::state::AppState;

/// A failure with its status.
pub(crate) struct ApiError(u16, String);

impl ApiError {
    fn bad(m: impl Into<String>) -> Self {
        Self(400, m.into())
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        Self(e.status_code(), e.client_message())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        json_error(
            StatusCode::from_u16(self.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &self.1,
        )
    }
}

fn leaving() -> ApiError {
    ApiError(503, "this process is shutting down; try again".into())
}

fn unavailable() -> ApiError {
    ApiError(503, "the size store is not available".into())
}

fn sizes_of(state: &AppState) -> Result<Arc<Sizes>, ApiError> {
    state.inner.sizes.clone().ok_or_else(unavailable)
}

/// The first value of each query key, URL-decoded as `URLSearchParams` does.
fn query_map(raw: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for (k, v) in form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        m.entry(k.into_owned()).or_insert_with(|| v.into_owned());
    }
    m
}

/// `Number(text)` as JavaScript reads it, when it is a whole number.
fn js_whole(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0);
    }
    let f: f64 = t.parse().ok()?;
    #[allow(clippy::cast_possible_truncation)]
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15).then_some(f as i64)
}

fn flag(v: Option<&String>) -> bool {
    v.is_some_and(|s| s == "1")
}

fn json_response(status: StatusCode, v: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        v.to_string(),
    )
        .into_response()
}

/// The head of a streamed `du` answer.
struct Head {
    cached: bool,
    watched: bool,
    stale: bool,
    age_ms: Option<i64>,
    refresh_job_id: Option<String>,
}

fn age_of(top: &Row) -> Option<i64> {
    (!top.partial && top.scanned_at != 0).then(|| (now_ms() - top.scanned_at).max(0))
}

type After = Box<dyn FnOnce() -> bool + Send>;

/// The answer, streamed from the store as it is read: the agent never holds a whole answer, whatever its size.
/// `{path, cached, watched, entries: [...], truncated, partial?, stale?, error?}`. `recheck` runs after the last entry
/// (stale when it says no). An error after the first byte cannot change the status: it ends the answer with `error`.
fn answer_tree(
    sizes: &Arc<Sizes>,
    virtual_path: String,
    depth: u32,
    all: bool,
    head: Head,
    recheck: Option<After>,
) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(4);
    let sizes = Arc::clone(sizes);
    tokio::task::spawn_blocking(move || {
        let mut buf = String::new();
        buf.push_str(&format!(
            "{{\"path\":{},\"cached\":{},\"watched\":{},",
            Value::String(virtual_path.clone()),
            head.cached,
            head.watched
        ));
        if let Some(a) = head.age_ms {
            buf.push_str(&format!("\"ageMs\":{a},"));
        }
        if let Some(j) = &head.refresh_job_id {
            buf.push_str(&format!("\"refreshJobId\":{},", Value::String(j.clone())));
        }
        buf.push_str("\"entries\":[");
        let mut first = true;
        let mut gone = false;
        let mut put = |e: DuEntry, buf: &mut String| -> Result<(), StoreError> {
            if !first {
                buf.push(',');
            }
            first = false;
            buf.push_str(&serde_json::to_string(&e).unwrap_or_default());
            if buf.len() >= 64 * 1024 {
                let b = std::mem::take(buf);
                if tx.blocking_send(Ok(Bytes::from(b))).is_err() {
                    gone = true;
                    return Err(StoreError::Canceled);
                }
            }
            Ok(())
        };
        let mut found = false;
        let r = {
            let mut sink = buf.clone();
            buf.clear();
            let out = sizes.store.tree_each(&virtual_path, depth, all, &mut |e| {
                found = true;
                put(e, &mut sink)
            });
            buf = sink;
            out
        };
        if gone {
            return;
        }
        let tail: Value = match r {
            Ok(end) if found => {
                let stale = head.stale || recheck.is_some_and(|f| !f());
                let mut m = Map::new();
                m.insert("truncated".into(), json!(end.truncated));
                if end.partial {
                    m.insert("partial".into(), json!(true));
                }
                if stale {
                    m.insert("stale".into(), json!(true));
                }
                Value::Object(m)
            }
            Ok(_) => {
                json!({"truncated": true, "error": "the sizes of this folder were removed while the answer was read; ask again"})
            }
            Err(e) => json!({"truncated": true, "error": e.client_message()}),
        };
        let text = tail.to_string();
        buf.push_str("],");
        buf.push_str(&text[1..]);
        let _ = tx.blocking_send(Ok(Bytes::from(buf)));
    });
    let mut res = Response::new(Body::from_stream(ReceiverStream::new(rx)));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json; charset=UTF-8"),
    );
    res
}

/// What a finished `du` job's result holds: `{res, read, untrusted}` or, for a joined size job, the result itself.
fn job_result(j: &JobSnapshot) -> (Value, Option<u64>, bool) {
    let r = j.result.clone().unwrap_or(Value::Null);
    let res = r.get("res").cloned().unwrap_or_else(|| r.clone());
    let read = r.get("read").and_then(Value::as_u64);
    let untrusted = r.get("untrusted").and_then(Value::as_bool).unwrap_or(false);
    (res, read, untrusted)
}

/// Removes a `du` request's entry when the request ends (also when the client goes away).
struct RunGuard {
    sizes: Arc<Sizes>,
    key: String,
    run: Arc<DuRun>,
    replay: bool,
    keep: bool,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        let detached = self.run.detached.load(std::sync::atomic::Ordering::SeqCst);
        if !detached || self.replay {
            let mut runs = lock(&self.sizes.runs);
            if runs
                .get(&self.key)
                .is_some_and(|r| Arc::ptr_eq(r, &self.run))
            {
                runs.remove(&self.key);
            }
        }
    }
}

pub(crate) async fn du(State(state): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    match du_inner(&state, raw.as_deref()).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

async fn du_inner(state: &AppState, raw: Option<&str>) -> Result<Response, ApiError> {
    let arrived = Instant::now();
    let sizes = sizes_of(state)?;
    let q = query_map(raw);
    let depth = match q.get("depth") {
        None => 1,
        Some(d) => js_whole(d)
            .filter(|n| (0..=64).contains(n))
            .ok_or_else(|| ApiError::bad("depth must be an integer between 0 and 64"))?,
    };
    let depth = u32::try_from(depth).unwrap_or(1);
    for k in ["all", "fresh", "cachedOnly"] {
        if let Some(v) = q.get(k)
            && v != "0"
            && v != "1"
        {
            return Err(ApiError::bad(format!("{k} must be 0 or 1")));
        }
    }
    let r = resolve_read(&sizes.root, q.get("path").map_or("/", String::as_str))?;
    if !fs::metadata(&r.real).map_err(StoreError::from)?.is_dir() {
        return Err(ApiError::bad("not a directory"));
    }
    let all = flag(q.get("all"));
    let fresh = flag(q.get("fresh"));
    if let Some(v) = q.get("refresh")
        && v != "auto"
    {
        return Err(ApiError::bad("refresh must be auto"));
    }
    let auto = q.contains_key("refresh");
    if auto && (fresh || flag(q.get("cachedOnly"))) {
        return Err(ApiError::bad(
            "refresh=auto conflicts with fresh and cachedOnly",
        ));
    }
    let virtual_path = r.virtual_path;
    let persistent = sizes.store.persistent();

    // cachedOnly=1: stored rows only. Never scans, never waits; 204 when the folder is not stored.
    if flag(q.get("cachedOnly")) {
        let Some(top) = sizes.store.tree_top(&virtual_path)? else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        };
        // `stale: true` always: no watcher vouches for the rows
        return Ok(answer_tree(
            &sizes,
            virtual_path,
            depth,
            all,
            Head {
                cached: persistent,
                watched: false,
                stale: true,
                age_ms: age_of(&top),
                refresh_job_id: None,
            },
            None,
        ));
    }
    if !fresh {
        let stored = sizes.store.tree_top(&virtual_path)?;
        // refresh=auto and the folder is stored: the stored rows go out now, flagged `stale`. One low-priority scan of this
        // folder is joined or started, and its id is in the answer.
        if auto && let Some(stored) = &stored {
            let mut refresh_job_id = sizes.live_scan(&virtual_path, false).map(|j| j.id);
            if refresh_job_id.is_none()
                && !sizes.stopping()
                && sizes.may_scan()
                && !sizes.live_overlap(&virtual_path)
            {
                sizes.note_refresh_ended();
                if lock(&sizes.refreshing).len() < sizes.refresh_max {
                    let (v, started) =
                        sizes.join_or_start("du", &virtual_path, false, Origin::Cli, None);
                    let id = v["id"].as_str().unwrap_or_default().to_owned();
                    if started {
                        lock(&sizes.refreshing).insert(id.clone());
                    }
                    refresh_job_id = Some(id);
                }
            }
            if let Some(id) = &refresh_job_id {
                sizes.jobs.touch(id);
            }
            return Ok(answer_tree(
                &sizes,
                virtual_path,
                depth,
                all,
                Head {
                    cached: persistent,
                    watched: false,
                    stale: true,
                    age_ms: age_of(stored),
                    refresh_job_id,
                },
                None,
            ));
        }
        // Not vouched for, and this process cannot walk or a scan of another overlapping folder is live (a job here would queue
        // behind it): answer from the stored rows, flagged `stale: true`, and start nothing.
        if (!sizes.may_scan() || sizes.live_overlap(&virtual_path)) && stored.is_some() {
            return Ok(answer_tree(
                &sizes,
                virtual_path,
                depth,
                all,
                Head {
                    cached: persistent,
                    watched: false,
                    stale: true,
                    age_ms: None,
                    refresh_job_id: None,
                },
                None,
            ));
        }
    }
    let key = [
        virtual_path.as_str(),
        &depth.to_string(),
        &all.to_string(),
        &fresh.to_string(),
    ]
    .join("\0");
    sizes.forget_stale_runs();
    // an identical request joins the scan already running (or the one that got 202 within the last minute)
    let existing = lock(&sizes.runs).get(&key).cloned();
    let snap = existing.as_ref().and_then(|r| sizes.jobs.snapshot(&r.id));
    let replay = existing
        .as_ref()
        .is_some_and(|r| r.detached.load(std::sync::atomic::Ordering::SeqCst))
        && snap.as_ref().is_some_and(|j| j.state == JobState::Done);
    let run: Arc<DuRun> = match (&existing, &snap) {
        (Some(r), Some(j)) if j.state.live() || replay => Arc::clone(r),
        _ => {
            let out: DuOut = Arc::default();
            if sizes.stopping() && sizes.live_scan(&virtual_path, fresh).is_none() {
                return Err(leaving());
            }
            let (v, _) = sizes.join_or_start(
                "du",
                &virtual_path,
                fresh,
                Origin::Cli,
                Some(Arc::clone(&out)),
            );
            let id = v["id"].as_str().unwrap_or_default().to_owned();
            let r = Arc::new(DuRun {
                id,
                detached: std::sync::atomic::AtomicBool::new(false),
                out,
            });
            lock(&sizes.runs).insert(key.clone(), Arc::clone(&r));
            r
        }
    };
    let mut guard = RunGuard {
        sizes: Arc::clone(&sizes),
        key,
        run: Arc::clone(&run),
        replay,
        keep: false,
    };
    let id = run.id.clone();
    sizes.jobs.touch(&id);
    let deadline = arrived + Duration::from_millis(sizes.du_wait_ms);
    let mut v = loop {
        let Some(j) = sizes.jobs.until_ended(&id, deadline).await else {
            return Err(ApiError(500, "job lost".into()));
        };
        sizes.jobs.touch(&id);
        if !j.state.live() || Instant::now() >= deadline {
            break j;
        }
    };
    if v.state.live() {
        // keep the entry for the repeat request; the job goes on whether or not this client is still there
        run.detached
            .store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(json_response(
            StatusCode::ACCEPTED,
            &json!({"jobId": id, "state": if v.state == JobState::Running { "running" } else { "queued" }}),
        ));
    }
    // the job may have changed again between the wake and the read
    if let Some(j) = sizes.jobs.snapshot(&id) {
        v = j;
    }
    match v.state {
        JobState::Canceled => {
            return Err(if sizes.stopping() {
                leaving()
            } else {
                ApiError(409, "canceled".into())
            });
        }
        JobState::Failed => {
            let (s, m) = v.error.clone().unwrap_or((500, "failed".into()));
            return Err(ApiError(s, m));
        }
        _ => {}
    }
    let (res, read, untrusted) = job_result(&v);
    let _ = res;
    let mark = sizes.locks.mark();
    let t0 = now_ms();
    if sizes.store.tree_top(&virtual_path)?.is_none() {
        return Err(ApiError(404, "not found".into()));
    }
    let stale = run
        .out
        .lock()
        .map(|o| o.is_some_and(|(_, u)| u))
        .unwrap_or(false)
        || untrusted
        || (replay
            && sizes
                .store
                .marked_since(&virtual_path, v.started_at.unwrap_or(v.created_at)));
    let read_now = run
        .out
        .lock()
        .ok()
        .and_then(|o| *o)
        .map(|(r, _)| r)
        .or(read);
    let cached = (replay || read_now == Some(0)) && persistent;
    let s2 = Arc::clone(&sizes);
    let vp = virtual_path.clone();
    let response = answer_tree(
        &sizes,
        virtual_path,
        depth,
        all,
        Head {
            cached,
            watched: false,
            stale,
            age_ms: None,
            refresh_job_id: None,
        },
        Some(Box::new(move || {
            !s2.locks.busy_since(&vp, mark) && !s2.store.marked_since(&vp, t0)
        })),
    );
    guard.keep = false;
    drop(guard);
    Ok(response)
}

pub(crate) async fn size_job(State(state): State<AppState>, body: Body) -> Response {
    match size_job_inner(&state, body).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

async fn size_job_inner(state: &AppState, body: Body) -> Result<Response, ApiError> {
    let sizes = sizes_of(state)?;
    let bytes = axum::body::to_bytes(body, 1 << 20)
        .await
        .map_err(|_| ApiError::bad("invalid JSON body"))?;
    let b: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("invalid JSON body"))?;
    let path = b
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("path must be a string"))?;
    let fresh = b.get("fresh").and_then(Value::as_bool) == Some(true);
    let r = resolve_read(&sizes.root, path)?;
    fs::metadata(&r.real).map_err(StoreError::from)?;
    if sizes.stopping() {
        return Err(leaving());
    }
    // one live size job per path: a second request attaches to it
    let (v, _) = sizes.join_or_start("size", &r.virtual_path, fresh, Origin::Ui, None);
    Ok(json_response(StatusCode::ACCEPTED, &v))
}

pub(crate) async fn jobs_list(State(state): State<AppState>) -> Response {
    let jobs = state
        .inner
        .sizes
        .as_ref()
        .map(|s| s.jobs.list())
        .unwrap_or_default();
    json_response(StatusCode::OK, &json!({ "jobs": jobs }))
}

/// `?wait=<seconds>`: a whole number from 0 to 30.
fn job_wait(v: Option<&String>) -> Result<u64, ApiError> {
    let Some(v) = v else { return Ok(0) };
    let bad = || ApiError::bad("wait must be a whole number of seconds from 0 to 30");
    if v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    v.parse::<u64>().ok().filter(|n| *n <= 30).ok_or_else(bad)
}

pub(crate) async fn job_get(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = query_map(raw.as_deref());
    let wait = match job_wait(q.get("wait")) {
        Ok(w) => w,
        Err(e) => return e.into_response(),
    };
    let Some(sizes) = state.inner.sizes.clone() else {
        return json_error(StatusCode::NOT_FOUND, "not found");
    };
    sizes.jobs.touch(&id);
    // a client polling a CLI du job keeps it alive; `?wait=<seconds>` holds the answer until the job has ended (a long poll)
    if wait > 0 {
        let deadline = Instant::now() + Duration::from_secs(wait);
        loop {
            let Some(j) = sizes.jobs.until_ended(&id, deadline).await else {
                break;
            };
            sizes.jobs.touch(&id);
            if !j.state.live() || Instant::now() >= deadline {
                break;
            }
        }
    }
    match sizes.jobs.get(&id) {
        Some(v) => json_response(StatusCode::OK, &v),
        None => json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

pub(crate) async fn job_cancel(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
) -> Response {
    match state.inner.sizes.as_ref().and_then(|s| s.jobs.cancel(&id)) {
        Some(v) => json_response(StatusCode::OK, &v),
        None => json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

pub(crate) async fn job_dismiss(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
) -> Response {
    if state
        .inner
        .sizes
        .as_ref()
        .is_some_and(|s| s.jobs.dismiss(&id))
    {
        json_response(StatusCode::OK, &json!({"ok": true}))
    } else {
        json_error(StatusCode::NOT_FOUND, "not found or still active")
    }
}
