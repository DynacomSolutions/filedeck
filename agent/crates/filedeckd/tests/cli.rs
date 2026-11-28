//! Runs the real binary: start-up errors, then a live request over a socket.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const TOKEN: &str = "t0ken-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

fn bin() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_filedeckd"));
    c.env_clear();
    c
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("filedeckd-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn token_file(dir: &std::path::Path, mode: u32) -> PathBuf {
    let f = dir.join("token");
    std::fs::write(&f, TOKEN).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
    f
}

fn stderr_of(mut c: Command) -> (Option<i32>, String) {
    let out = c.output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn refuses_to_start_without_a_token() {
    let (code, err) = stderr_of(bin());
    assert_eq!(code, Some(2));
    assert!(err.contains("no agent token"), "{err}");
}

#[test]
fn refuses_auth_on() {
    let mut c = bin();
    c.env("FILEDECK_AGENT_TOKEN", TOKEN)
        .env("FILEDECK_AUTH", "on");
    let (code, err) = stderr_of(c);
    assert_eq!(code, Some(2));
    assert!(err.contains("FILEDECK_AUTH=on is not supported"), "{err}");
}

#[test]
fn refuses_a_group_readable_token_file() {
    let d = scratch("mode");
    let f = token_file(&d, 0o640);
    let mut c = bin();
    c.env("FILEDECK_AGENT_TOKEN_FILE", &f);
    let (code, err) = stderr_of(c);
    assert_eq!(code, Some(2));
    assert!(err.contains("readable by group or others"), "{err}");
    assert!(!err.contains(TOKEN));
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn refuses_a_token_file_that_is_a_symlink() {
    let d = scratch("link");
    let f = token_file(&d, 0o600);
    let l = d.join("link");
    std::os::unix::fs::symlink(&f, &l).unwrap();
    let mut c = bin();
    c.env("FILEDECK_AGENT_TOKEN_FILE", &l);
    let (code, err) = stderr_of(c);
    assert_eq!(code, Some(2));
    assert!(err.contains("symbolic link"), "{err}");
    let _ = std::fs::remove_dir_all(d);
}

fn get(addr: &str, path: &str, auth: Option<&str>) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    let a = auth
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: x\r\n{a}Connection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn serves_over_a_socket_and_stops_on_sigterm() {
    let d = scratch("serve");
    let f = token_file(&d, 0o600);
    let cfg = d.join("agent.toml");
    std::fs::write(&cfg, "node = \"from-file\"\nhost = \"127.0.0.1\"\n").unwrap();
    let mut child = bin()
        .args(["--config", cfg.to_str().unwrap()])
        .env("FILEDECK_AGENT_TOKEN_FILE", &f)
        .env("PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line
        .trim()
        .strip_prefix("filedeckd listening on ")
        .expect(&line)
        .to_owned();

    assert!(get(&addr, "/healthz?ready=1", None).starts_with("HTTP/1.1 200"));
    assert!(get(&addr, "/api/info", None).starts_with("HTTP/1.1 401"));
    let info = get(&addr, "/api/info", Some(TOKEN));
    assert!(info.starts_with("HTTP/1.1 200"), "{info}");
    assert!(info.contains("\"node\":\"from-file\""), "{info}");

    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    assert!(child.wait().unwrap().success(), "clean exit on SIGTERM");
    let _ = std::fs::remove_dir_all(d);
}
