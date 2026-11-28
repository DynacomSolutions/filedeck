#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use fd_events::{Bus, BusOptions, JournalOptions, Kind, NewEvent, SocketOptions, start_event_socket};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

fn bus(ping_ms: u64) -> std::sync::Arc<Bus> {
    let mut o = BusOptions::new("n1", JournalOptions::new("n1", None));
    o.ping_ms = ping_ms;
    Bus::new(o)
}

fn short_dir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("s-").tempdir_in(std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, Into::into)).unwrap()
}

#[tokio::test]
async fn the_folder_is_0750_and_the_socket_0660_a_client_sends_one_json_line_and_reads_ndjson() {
    let b = bus(40);
    for i in 1..=3 {
        b.publish(NewEvent::entry(Kind::Create, false, format!("/old{i}")));
    }
    let d = short_dir();
    let sock = d.path().join("run").join("e.sock");
    let s = start_event_socket(b.clone(), SocketOptions::new(&sock)).await.unwrap();
    assert_eq!(std::fs::metadata(sock.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o750);
    assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o660);
    let c = UnixStream::connect(&sock).await.unwrap();
    let (r, mut w) = c.into_split();
    let req = serde_json::json!({"filter": {"kind": ["create"], "glob": ["*.md"]}, "since": b.cursor_of(1)});
    w.write_all(format!("{req}\n").as_bytes()).await.unwrap();
    b.publish(NewEvent::entry(Kind::Create, false, "/new.md"));
    b.publish(NewEvent::entry(Kind::Modify, false, "/new.md"));
    b.publish(NewEvent::entry(Kind::Create, false, "/new.txt"));
    let mut lines = BufReader::new(r).lines();
    let mut got = Vec::new();
    let until = tokio::time::Instant::now() + Duration::from_millis(500);
    while let Ok(Ok(Some(l))) = tokio::time::timeout_at(until, lines.next_line()).await {
        let v: serde_json::Value = serde_json::from_str(&l).unwrap();
        if v["kind"] != "ping" {
            got.push(v["path"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(got, ["/new.md"], "the old events had no .md name; the filter is applied in the agent");
    drop(w);
    drop(lines);
    for _ in 0..50 {
        if b.subscribers()[0] == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(b.subscribers()[0], 0, "the subscriber is released when the client goes");
    s.close().await;
    assert!(!sock.exists(), "close removes the socket");
}

async fn ask(sock: &std::path::Path, req: &str) -> String {
    let mut c = UnixStream::connect(sock).await.unwrap();
    c.write_all(format!("{req}\n").as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 512];
    while !out.contains(&b'\n') {
        let n = tokio::time::timeout(Duration::from_secs(3), c.read(&mut buf)).await.unwrap().unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn a_bad_request_gets_one_error_line_and_an_idle_client_gets_a_ping() {
    let b = bus(40);
    let d = short_dir();
    let sock = d.path().join("e.sock");
    let s = start_event_socket(b, SocketOptions::new(&sock)).await.unwrap();
    assert!(ask(&sock, "not json").await.contains("\"error\""));
    assert!(ask(&sock, r#"{"filter":{"kind":["nope"]}}"#).await.contains("unknown kind"));
    assert!(ask(&sock, r#"{"since":"garbage"}"#).await.contains("not a cursor"));
    assert!(ask(&sock, r#"{"filter":[]}"#).await.contains("filter is an object"));
    let ping: serde_json::Value = serde_json::from_str(ask(&sock, "{}").await.lines().next().unwrap()).unwrap();
    assert_eq!(ping["kind"], "ping");
    s.close().await;
}

#[tokio::test]
async fn a_stale_socket_is_replaced_and_what_is_not_a_socket_is_kept() {
    let b = bus(1000);
    let d = short_dir();
    let sock = d.path().join("e.sock");
    let old = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    drop(old); // the socket of an earlier process: a file with no listener
    let s = start_event_socket(b.clone(), SocketOptions::new(&sock)).await.unwrap();
    s.close().await;
    std::fs::write(&sock, "not a socket").unwrap();
    let err = start_event_socket(b, SocketOptions::new(&sock)).await.err().unwrap();
    assert!(err.contains("not a socket"), "{err}");
    assert_eq!(std::fs::read_to_string(&sock).unwrap(), "not a socket");
}
