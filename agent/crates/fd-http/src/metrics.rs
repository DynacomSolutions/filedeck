use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

/// Escape a label value as the Prometheus text format asks.
fn label(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// The text of `GET /metrics` (Prometheus text format 0.0.4). Counts and ages only:
/// nothing that names a path, a node or a size may go here, because the route is open.
pub(crate) fn render(state: &AppState) -> String {
    let i = &state.inner;
    format!(
        "# HELP filedeck_agent_build_info The version, commit and OS of this agent. The value is always 1.\n\
         # TYPE filedeck_agent_build_info gauge\n\
         filedeck_agent_build_info{{version=\"{}\",commit=\"{}\",os=\"{}\"}} 1\n\
         # HELP filedeck_agent_start_timestamp_seconds When this agent started, in Unix seconds.\n\
         # TYPE filedeck_agent_start_timestamp_seconds gauge\n\
         filedeck_agent_start_timestamp_seconds {}\n",
        label(i.build.version),
        label(i.build.commit),
        label(i.build.os),
        i.started_at
    )
}

pub(crate) async fn metrics(State(state): State<AppState>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        render(&state),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::label;

    #[test]
    fn labels_are_escaped() {
        assert_eq!(label("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }
}
