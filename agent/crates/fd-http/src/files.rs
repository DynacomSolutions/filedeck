//! The file routes: mounts, list, stat, read, download and text. Read only.
//!
//! The answers match the TypeScript agent (`agent-routes.ts`). The file work is blocking, so it runs on the blocking pool.

use std::convert::Infallible;
use std::io::SeekFrom;

use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use fd_core::{Entry, FsError, JsNumber};
use fd_fs::{RangeSpec, http_date};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;

use crate::json_error;
use crate::state::AppState;

type Params = Query<Vec<(String, String)>>;

fn param<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn fs_error(e: &FsError) -> Response {
    json_error(
        StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &e.message,
    )
}

/// Run blocking file work. A panic or a lost task is an internal error.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, FsError> + Send + 'static,
) -> Result<T, FsError> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(FsError::new(500, "internal error")))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/mounts", get(mounts))
        .route("/api/fs/list", get(list))
        .route("/api/fs/stat", get(stat))
        .route("/api/fs/read", get(read))
        .route("/api/fs/download", get(download))
        .route("/api/fs/text", get(text))
        .merge(read_only_routes())
}

/// The routes that change files. This agent is read only: they answer 403 after the bearer check.
fn read_only_routes() -> Router<AppState> {
    const WRITE: &[&str] = &[
        "/api/fs/write",
        "/api/fs/upload",
        "/api/upload",
        "/api/upload/chunk",
        "/api/fs/perms",
        "/api/fs/mkdir",
        "/api/fs/symlink",
        "/api/fs/rename",
        "/api/fs/move",
        "/api/fs/copy",
        "/api/fs/trash",
        "/api/fs/delete",
        "/api/trash/restore",
        "/api/trash/delete",
        "/api/trash/empty",
        "/api/jobs/compress",
        "/api/jobs/extract",
    ];
    WRITE.iter().fold(Router::new(), |r, p| {
        r.route(
            p,
            any(|| async { json_error(StatusCode::FORBIDDEN, "this agent is read-only") }),
        )
    })
}

#[derive(Serialize)]
struct MountsOut {
    mounts: Vec<fd_fs::Mount>,
}

async fn mounts(State(s): State<AppState>) -> Response {
    let i = s.inner.clone();
    let r = blocking(move || Ok(fd_fs::list_mounts(&i.root, &i.mounts, &i.read_only))).await;
    match r {
        Ok(mounts) => Json(MountsOut { mounts }).into_response(),
        Err(e) => fs_error(&e),
    }
}

#[derive(Serialize)]
struct ListOut {
    path: String,
    entries: Vec<Entry>,
    truncated: bool,
}

#[derive(Serialize)]
struct BatchLine<'a> {
    e: &'a [Entry],
}

#[derive(Serialize)]
struct DoneLine<'a> {
    done: DoneBody<'a>,
}

#[derive(Serialize)]
struct DoneBody<'a> {
    path: &'a str,
    truncated: bool,
}

fn ndjson<T: Serialize>(v: &T) -> Bytes {
    let mut text = serde_json::to_string(v).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    Bytes::from(text)
}

async fn list(State(s): State<AppState>, Query(q): Params) -> Response {
    let path = param(&q, "path").unwrap_or("/").to_owned();
    let hidden = param(&q, "hidden") == Some("1");
    let root = s.inner.fs_root.clone();
    if param(&q, "stream") != Some("1") {
        return match blocking(move || fd_fs::list(&root, &path, hidden)).await {
            Ok(l) => Json(ListOut {
                path: l.path,
                entries: l.entries,
                truncated: l.truncated,
            })
            .into_response(),
            Err(e) => fs_error(&e),
        };
    }
    // NDJSON: `{"e":[entries]}` batches in the default order, then `{"done":{path,truncated}}`.
    // A bad path fails here, before the first byte, with its own status.
    let scan = match blocking(move || fd_fs::scan(&root, &path, hidden)).await {
        Ok(scan) => scan,
        Err(e) => return fs_error(&e),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, Infallible>>(2);
    tokio::task::spawn_blocking(move || {
        let path = scan.virtual_path().to_owned();
        let truncated = scan.truncated();
        for batch in scan.batches(500) {
            // The client went away: stop reading the folder.
            if tx
                .blocking_send(Ok(ndjson(&BatchLine { e: &batch })))
                .is_err()
            {
                return;
            }
        }
        let _ = tx.blocking_send(Ok(ndjson(&DoneLine {
            done: DoneBody {
                path: &path,
                truncated,
            },
        })));
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

async fn stat(State(s): State<AppState>, Query(q): Params) -> Response {
    let path = param(&q, "path").unwrap_or("/").to_owned();
    let root = s.inner.fs_root.clone();
    match blocking(move || fd_fs::stat_entry(&root, &path)).await {
        Ok(e) => Json(e).into_response(),
        Err(e) => fs_error(&e),
    }
}

const NOSNIFF: (&str, &str) = ("x-content-type-options", "nosniff");
const CSP: (&str, &str) = (
    "content-security-policy",
    "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
);

/// `encodeURIComponent`: everything except letters, digits and `-_.!~*'()` is escaped.
fn uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The `Content-Disposition` of a download: an ASCII name for old clients and the UTF-8 name.
fn attachment(name: &str) -> String {
    let mut ascii = String::new();
    for c in name.chars() {
        if (' '..='~').contains(&c) && c != '"' && c != '\\' {
            ascii.push(c);
        } else {
            // The TypeScript agent replaces each UTF-16 unit.
            for _ in 0..c.len_utf16() {
                ascii.push('_');
            }
        }
    }
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        uri_component(name)
    )
}

async fn read(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Query(q): Params,
) -> Response {
    serve(&s, &method, &headers, &q, false).await
}

async fn download(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Query(q): Params,
) -> Response {
    serve(&s, &method, &headers, &q, true).await
}

async fn serve(
    s: &AppState,
    method: &Method,
    req: &HeaderMap,
    q: &[(String, String)],
    download: bool,
) -> Response {
    let path = param(q, "path").unwrap_or("").to_owned();
    let root = s.inner.fs_root.clone();
    let f = match blocking(move || fd_fs::open_file(&root, &path)).await {
        Ok(f) => f,
        Err(e) => return fs_error(&e),
    };
    let range = fd_fs::parse_range(req.get(header::RANGE).and_then(|v| v.to_str().ok()), f.size);
    let mut h = HeaderMap::new();
    let mut put = |k: &str, v: &str| {
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
            h.insert(k, v);
        }
    };
    put(NOSNIFF.0, NOSNIFF.1);
    put(CSP.0, CSP.1);
    put("content-type", f.mime);
    put("accept-ranges", "bytes");
    put("last-modified", &http_date(f.mtime_ms));
    put(
        "content-disposition",
        &if download {
            attachment(&f.name)
        } else {
            "inline".to_owned()
        },
    );
    let (status, start, len) = match range {
        RangeSpec::Invalid => {
            put("content-range", &format!("bytes */{}", f.size));
            return (StatusCode::RANGE_NOT_SATISFIABLE, h, Body::empty()).into_response();
        }
        _ if method == Method::HEAD => {
            put("content-length", &f.size.to_string());
            return (StatusCode::OK, h, Body::empty()).into_response();
        }
        RangeSpec::Bytes { start, end } => {
            put("content-range", &format!("bytes {start}-{end}/{}", f.size));
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        RangeSpec::Whole => (StatusCode::OK, 0, f.size),
    };
    put("content-length", &len.to_string());
    let mut file = tokio::fs::File::from_std(f.file);
    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(len), 64 * 1024));
    (status, h, body).into_response()
}

#[derive(Serialize)]
struct TextOut {
    path: String,
    content: String,
    size: u64,
    mtime: JsNumber,
    etag: String,
}

async fn text(State(s): State<AppState>, Query(q): Params) -> Response {
    let path = param(&q, "path").unwrap_or("").to_owned();
    let root = s.inner.fs_root.clone();
    let max = s.inner.max_edit;
    match blocking(move || fd_fs::read_text(&root, &path, max)).await {
        Ok(t) => Json(TextOut {
            path: t.path,
            content: t.content,
            size: t.size,
            mtime: t.mtime,
            etag: t.etag,
        })
        .into_response(),
        Err(e) => fs_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names() {
        assert_eq!(
            attachment("a b.txt"),
            "attachment; filename=\"a b.txt\"; filename*=UTF-8''a%20b.txt"
        );
        assert_eq!(
            attachment("é\"x\\😀"),
            "attachment; filename=\"__x___\"; filename*=UTF-8''%C3%A9%22x%5C%F0%9F%98%80"
        );
        assert_eq!(uri_component("a-b_c.d!e~f*g'h(i)"), "a-b_c.d!e~f*g'h(i)");
    }
}
