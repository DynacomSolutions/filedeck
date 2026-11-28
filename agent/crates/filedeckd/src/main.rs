//! `filedeckd`: the FileDeck agent daemon.

use std::path::PathBuf;
use std::process::ExitCode;

use fd_core::{BuildInfo, Config};
use fd_http::{AppState, Ready, router};
use tokio::net::TcpListener;

const USAGE: &str = "usage: filedeckd [--config <file.toml>] | --version | --help\n\
settings come from the environment (FILEDECK_NODE, FILEDECK_ROOT, FILEDECK_HOST, PORT, FILEDECK_INDEX_DIR,\n\
FILEDECK_READONLY, FILEDECK_AGENT_TOKEN_FILE) and from the file named by --config or FILEDECK_CONFIG; the environment wins";

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("filedeckd: {message}");
    ExitCode::from(2)
}

fn config_path(args: &[String]) -> Result<Option<PathBuf>, String> {
    let mut path = std::env::var_os("FILEDECK_CONFIG")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--config" => path = Some(it.next().ok_or("--config needs a file name")?.into()),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    Ok(path)
}

fn load() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let file = match config_path(&args)? {
        Some(p) => {
            let text = std::fs::read_to_string(&p)
                .map_err(|e| format!("config file {}: {e}", p.display()))?;
            Some((p, text))
        }
        None => None,
    };
    Config::load(
        &|k| std::env::var(k).ok(),
        file.as_ref().map(|(p, t)| (p.as_path(), t.as_str())),
    )
    .map_err(|e| e.to_string())
}

/// Resolves on SIGTERM or SIGINT. No timer: the process waits for the signal.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        // No signal handler can be set: never stop on our own.
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
}

#[tokio::main]
async fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            let b = BuildInfo::current();
            println!("filedeckd {} ({}, {})", b.version, b.commit, b.os);
            return ExitCode::SUCCESS;
        }
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => {}
    }
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();

    let config = match load() {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let host = config.host.clone().unwrap_or_else(|| "0.0.0.0".to_owned());
    let listener = match TcpListener::bind((host.as_str(), config.port)).await {
        Ok(l) => l,
        Err(e) => return fail(format!("cannot listen on {host}:{}: {e}", config.port)),
    };
    let addr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => return fail(e),
    };

    let ready = Ready::default();
    let state = AppState::new(&config, ready.clone());
    let app = router(state.clone());
    ready.set(true);
    println!("filedeckd listening on {addr}");
    tracing::info!(node = %config.node, %addr, "agent started");

    let stop = ready.clone();
    let leaving = state.clone();
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // Fail readiness first, then stop accepting and finish the requests in flight.
            stop.set(false);
            // no new scan starts, the running ones stop at their next step
            leaving.begin_shutdown();
            tracing::info!("shutting down");
        })
        .await;
    // the scans have stopped: give the size store's writer lease back
    state.drain().await;
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fail(e),
    }
}
