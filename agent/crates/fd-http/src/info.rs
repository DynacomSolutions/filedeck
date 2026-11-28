use axum::Json;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::state::AppState;

/// `GET /healthz`: liveness. `?ready=1` is readiness: 503 until the agent takes work and again after SIGTERM.
pub(crate) async fn healthz(State(state): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let wants_ready = query
        .as_deref()
        .is_some_and(|q| q.split('&').any(|p| p == "ready=1"));
    let (status, body) = if wants_ready && !state.ready.get() {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready")
    } else {
        (StatusCode::OK, "ok")
    };
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        body,
    )
        .into_response()
}

/// What the TypeScript agent calls `sandboxSummary()`. This agent has no sandbox yet, so it says so.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sandbox {
    mode: &'static str,
    state: &'static str,
    landlock_abi: u32,
    socket_filter: bool,
    archive_tools: &'static str,
}

/// The answer of `GET /api/info`. The field order is the one of the TypeScript agent.
#[derive(Serialize)]
struct Info<'a> {
    node: &'a str,
    root: &'a str,
    watches: u64,
    #[serde(rename = "readOnly")]
    read_only: &'a [String],
    sandbox: Sandbox,
}

pub(crate) async fn info(State(state): State<AppState>) -> Response {
    let i = &state.inner;
    Json(Info {
        node: &i.node,
        root: &i.root,
        watches: 0,
        read_only: &i.read_only,
        sandbox: Sandbox {
            mode: "off",
            state: "off",
            landlock_abi: 0,
            socket_filter: false,
            archive_tools: "disabled",
        },
    })
    .into_response()
}
