//! HTTP server of the FileDeck agent: routes, bearer authentication and metrics.
//!
//! The wire protocol is the one of the TypeScript agent, byte for byte where a client can see it.

mod auth;
mod files;
mod info;
mod jobs;
mod locks;
mod metrics;
mod size_routes;
mod sizes;
mod state;

use axum::Router;
use axum::http::{StatusCode, header};
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};

pub use auth::{bearer_matches, is_open_probe};
pub use state::{AppState, Ready};

/// The JSON body of a refused request, as the TypeScript agent sends it.
pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message }).to_string();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not found")
}

/// The router of the agent. Bearer authentication wraps every route, the fallback too.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(info::healthz))
        .route("/metrics", get(metrics::metrics))
        .route("/api/info", get(info::info))
        .route("/api/du", get(size_routes::du))
        .route("/api/jobs/size", post(size_routes::size_job))
        .route("/api/jobs", get(size_routes::jobs_list))
        .route(
            "/api/jobs/{id}",
            get(size_routes::job_get).delete(size_routes::job_dismiss),
        )
        .route("/api/jobs/{id}/cancel", post(size_routes::job_cancel))
        .merge(files::routes())
        .fallback(not_found)
        .layer(from_fn_with_state(state.clone(), auth::require_bearer))
        .with_state(state)
}
