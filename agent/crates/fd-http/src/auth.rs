use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::json_error;
use crate::state::AppState;

/// The two paths that need no credentials: the liveness probe and the metrics scrape.
/// The query string is not part of the path, as in the TypeScript agent.
pub fn is_open_probe(path: &str) -> bool {
    path == "/healthz" || path == "/metrics"
}

/// Whether an `Authorization` header value is `Bearer <token>` for this digest.
/// Both sides are hashed first, so the compare takes the same time for every length.
pub fn bearer_matches(header_value: Option<&str>, want: &[u8; 32]) -> bool {
    let Some(given) = header_value
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty())
    else {
        return false;
    };
    let got: [u8; 32] = Sha256::digest(given.as_bytes()).into();
    got.ct_eq(want).into()
}

pub(crate) async fn require_bearer(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if is_open_probe(req.uri().path()) {
        return next.run(req).await;
    }
    let value = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if bearer_matches(value, &state.inner.token_digest) {
        next.run(req).await
    } else {
        json_error(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(s: &str) -> [u8; 32] {
        Sha256::digest(s.as_bytes()).into()
    }

    #[test]
    fn open_probes_are_exactly_two_paths() {
        assert!(is_open_probe("/healthz"));
        assert!(is_open_probe("/metrics"));
        for p in [
            "/healthz/",
            "/metrics/host",
            "/api/info",
            "/Healthz",
            "/",
            "/healthz2",
        ] {
            assert!(!is_open_probe(p), "{p}");
        }
    }

    #[test]
    fn bearer_compare() {
        let want = digest("secret-token-0123456789");
        assert!(bearer_matches(
            Some("Bearer secret-token-0123456789"),
            &want
        ));
        assert!(!bearer_matches(
            Some("Bearer secret-token-012345678"),
            &want
        ));
        assert!(!bearer_matches(
            Some("Bearer secret-token-0123456789x"),
            &want
        ));
        assert!(!bearer_matches(
            Some("bearer secret-token-0123456789"),
            &want
        ));
        assert!(!bearer_matches(
            Some("Basic secret-token-0123456789"),
            &want
        ));
        assert!(!bearer_matches(Some("secret-token-0123456789"), &want));
        assert!(!bearer_matches(Some("Bearer "), &want));
        assert!(!bearer_matches(Some(""), &want));
        assert!(!bearer_matches(None, &want));
    }
}
