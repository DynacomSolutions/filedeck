//! Tests of the HTTP surface, driven in process with no socket.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use fd_core::Config;
use fd_http::{AppState, Ready, router};
use http_body_util::BodyExt;
use tower::ServiceExt;

const TOKEN: &str = "t0ken-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

fn app(extra: &[(&str, &str)]) -> (axum::Router, Ready) {
    let mut env: Vec<(String, String)> = vec![
        ("FILEDECK_AGENT_TOKEN".into(), TOKEN.into()),
        ("FILEDECK_NODE".into(), "zq-node-7".into()),
    ];
    env.extend(extra.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    let config = Config::load(
        &|k| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()),
        None,
    )
    .unwrap();
    let ready = Ready::default();
    (router(AppState::new(&config, ready.clone())), ready)
}

async fn call(
    app: &axum::Router,
    path: &str,
    auth: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let mut req = Request::builder().uri(path);
    if let Some(a) = auth {
        req = req.header(header::AUTHORIZATION, a);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        String::from_utf8(bytes.to_vec()).unwrap(),
    )
}

fn bearer() -> String {
    format!("Bearer {TOKEN}")
}

#[tokio::test]
async fn probes_are_open() {
    let (app, _) = app(&[]);
    let (s, h, b) = call(&app, "/healthz", None).await;
    assert_eq!((s, b.as_str()), (StatusCode::OK, "ok"));
    assert_eq!(h[header::CONTENT_TYPE], "text/plain; charset=UTF-8");
    let (s, h, b) = call(&app, "/metrics?x=1", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CONTENT_TYPE], "text/plain; version=0.0.4");
    assert!(b.contains("filedeck_agent_build_info{version=\""));
    assert!(b.contains("filedeck_agent_start_timestamp_seconds "));
}

#[tokio::test]
async fn everything_else_needs_the_token_and_the_401_body_equals_the_typescript_one() {
    let golden = include_str!("../../../tests/golden/unauthorized.json").trim_end();
    let (app, _) = app(&[]);
    for (path, auth) in [
        ("/api/info", None),
        ("/api/info", Some("Bearer wrong")),
        ("/api/info", Some(&format!("Basic {TOKEN}")[..])),
        ("/api/fs/list?path=/", None),
        ("/metrics/host", None),
        ("/healthz/", None),
        ("/nope", None),
    ] {
        let (s, h, b) = call(&app, path, auth).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{path} {auth:?}");
        assert_eq!(b, golden, "{path}");
        assert_eq!(h[header::CONTENT_TYPE], "application/json");
    }
    let (s, _, _) = call(&app, "/api/info", Some(&bearer())).await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn an_unknown_route_is_404_with_the_token_and_never_leaks_without_it() {
    let (app, _) = app(&[]);
    let (s, _, b) = call(&app, "/api/fs/list?path=/", Some(&bearer())).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(b, r#"{"error":"not found"}"#);
}

#[tokio::test]
async fn ready_probe_follows_the_flag() {
    let (app, ready) = app(&[]);
    assert_eq!(
        call(&app, "/healthz?ready=1", None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(&app, "/healthz", None).await.0,
        StatusCode::OK,
        "liveness does not depend on readiness"
    );
    ready.set(true);
    assert_eq!(call(&app, "/healthz?ready=1", None).await.0, StatusCode::OK);
    ready.set(false);
    assert_eq!(
        call(&app, "/healthz?ready=1", None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn info_has_the_shape_of_the_typescript_agent() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/golden/info.json")).unwrap();
    let (app, _) = app(&[("FILEDECK_ROOT", "/")]);
    let (s, h, b) = call(&app, "/api/info", Some(&bearer())).await;
    assert_eq!(s, StatusCode::OK);
    assert!(
        h[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    let got: serde_json::Value = serde_json::from_str(&b).unwrap();
    assert_eq!(got["node"], "zq-node-7");
    assert_eq!(got["root"], "/");
    assert_eq!(got["readOnly"], serde_json::json!(["/"]));
    // same keys in the same order, at both levels, and the same JSON type for each
    assert_eq!(shape(&got), shape(&golden));
    let order = |s: &str| -> Vec<String> {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(s)
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    assert_eq!(
        order(&b),
        order(include_str!("../../../tests/golden/info.json"))
    );
    assert!(!b.contains(TOKEN));
}

fn shape(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value::*;
    match v {
        Object(m) => Object(m.iter().map(|(k, v)| (k.clone(), shape(v))).collect()),
        Array(_) => String("array".into()),
        Null => String("null".into()),
        Bool(_) => String("boolean".into()),
        Number(_) => String("number".into()),
        String(_) => String("string".into()),
    }
}

#[tokio::test]
async fn metrics_hold_no_path_node_or_token() {
    let (app, _) = app(&[("FILEDECK_ROOT", "/secret/place")]);
    let (_, _, b) = call(&app, "/metrics", None).await;
    for bad in [TOKEN, "zq-node-7", "/secret/place"] {
        assert!(!b.contains(bad), "{bad}");
    }
}
