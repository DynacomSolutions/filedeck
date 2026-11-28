//! The node-local Unix socket (`FILEDECK_EVENTS_SOCKET`). A client connects and sends one JSON line:
//!     {"filter":{"prefix":["/srv/repos"],"glob":["*.md"],"kind":["create","modify"],"type":"file","label":["org:acme"]},"since":"<cursor>"}
//! and the server answers with one JSON line per event (NDJSON), and a `ping` line when nothing happened for a while. No TLS and no token: the
//! folder (mode 0750, group `group`) and the socket (mode 0660) decide who may connect. The request line is at most 16 KiB, and a client has 10 s
//! to send it (a one-shot deadline per connection).

use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

use crate::bus::{Bus, Transport};
use crate::error::EventError;
use crate::filter::{Filter, FilterSpec};

#[derive(Debug, Clone)]
pub struct SocketOptions {
    pub path: PathBuf,
    /// group that may connect (name or number); the socket and its folder are given to it
    pub group: Option<String>,
    /// most clients at once (default 256)
    pub max_clients: usize,
}

impl SocketOptions {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            group: None,
            max_clients: 256,
        }
    }
}

const MAX_REQUEST: usize = 16 * 1024;
const REQUEST_MS: u64 = 10_000;

pub struct EventSocket {
    pub path: PathBuf,
    ino: (u64, u64),
    accept: JoinHandle<()>,
    clients: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl EventSocket {
    /// Stop accepting, end the clients, and remove the socket while it is still this one (a newer process may have put its own there).
    pub async fn close(self) {
        self.accept.abort();
        let _ = self.accept.await;
        let hs: Vec<_> = std::mem::take(
            &mut *self
                .clients
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for h in hs {
            h.abort();
        }
        if let Ok(m) = std::fs::symlink_metadata(&self.path)
            && m.file_type().is_socket()
            && (m.dev(), m.ino()) == self.ino
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn group_id(group: &str) -> Result<u32, String> {
    if let Ok(g) = group.parse::<u32>() {
        return Ok(g);
    }
    // names are looked up in /etc/group (the process may not have NSS)
    let text = std::fs::read_to_string("/etc/group").map_err(|e| e.to_string())?;
    text.lines()
        .find_map(|l| {
            let mut f = l.split(':');
            (f.next() == Some(group)).then(|| f.nth(1).and_then(|g| g.parse().ok()))?
        })
        .ok_or_else(|| format!("events socket group \"{group}\" does not exist"))
}

fn chown_to(p: &Path, group: Option<u32>) -> std::io::Result<()> {
    use rustix::fs::{Gid, chown};
    if let Some(g) = group {
        chown(p, None, Some(Gid::from_raw(g))).map_err(std::io::Error::from)?;
    }
    Ok(())
}

pub async fn start_event_socket(bus: Arc<Bus>, o: SocketOptions) -> Result<EventSocket, String> {
    if o.path.as_os_str().len() > 100 {
        return Err("the socket path is longer than 100 bytes (the limit of a Unix socket address)".into());
    }
    let me = rustix::process::getuid().as_raw();
    let dir = o
        .path
        .parent()
        .ok_or("the socket path has no folder")?
        .to_path_buf();
    // The folder is made (or kept) 0750 only when it is a real folder of this user: the agent never changes the mode or group of a folder it
    // does not own, and never follows a link to one.
    if std::fs::symlink_metadata(&dir).is_err() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o750)
            .create(&dir)
            .map_err(|e| e.to_string())?;
    }
    let dm = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !dm.is_dir() {
        return Err(format!(
            "the socket folder {} is not a folder (a link is not followed)",
            dir.display()
        ));
    }
    if dm.uid() != me {
        return Err(format!(
            "the socket folder {} is not owned by the agent's user: it is not changed",
            dir.display()
        ));
    }
    let gid = o.group.as_deref().map(group_id).transpose()?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).map_err(|e| e.to_string())?;
    chown_to(&dir, gid).map_err(|e| e.to_string())?;
    // Anything but an old socket at that place is kept, and the start is refused.
    if let Ok(old) = std::fs::symlink_metadata(&o.path)
        && !old.file_type().is_socket()
    {
        return Err(format!(
            "{} exists and is not a socket: it is not removed",
            o.path.display()
        ));
    }
    remove_stale_sockets(&o.path).await;
    // six hex characters, like the TS agent
    let own = {
        let mut r = [0u8; 3];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            let _ = f.read_exact(&mut r);
        }
        PathBuf::from(format!("{}.{:02x}{:02x}{:02x}", o.path.display(), r[0], r[1], r[2]))
    };
    let listener = UnixListener::bind(&own).map_err(|e| e.to_string())?;
    let setup = (|| -> std::io::Result<(u64, u64)> {
        std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o660))?;
        chown_to(&own, gid)?;
        std::fs::rename(&own, &o.path)?;
        let m = std::fs::symlink_metadata(&o.path)?;
        Ok((m.dev(), m.ino()))
    })();
    let ino = match setup {
        Ok(i) => i,
        Err(e) => {
            let _ = std::fs::remove_file(&own);
            return Err(e.to_string());
        }
    };
    let clients: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
    let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c2 = Arc::clone(&clients);
    let max = o.max_clients;
    let accept = tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                continue;
            };
            if live.load(std::sync::atomic::Ordering::SeqCst) >= max {
                let mut s = sock;
                let _ = s
                    .write_all(b"{\"kind\":\"error\",\"error\":\"too many clients\"}\n")
                    .await;
                continue;
            }
            live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let bus = Arc::clone(&bus);
            let live2 = Arc::clone(&live);
            let h = tokio::spawn(async move {
                let mut sock = sock;
                if let Err(e) = serve(&bus, &mut sock).await {
                    let line = serde_json::json!({"kind": "error", "error": e.message}).to_string();
                    let _ = sock.write_all(format!("{line}\n").as_bytes()).await;
                }
                let _ = sock.shutdown().await;
                live2.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            });
            let mut hs = c2
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            hs.retain(|h| !h.is_finished());
            hs.push(h);
        }
    });
    Ok(EventSocket {
        path: o.path,
        ino,
        accept,
        clients,
    })
}

/// A process that was killed between `bind` and the rename leaves its `<name>.<6 hex>` socket in the folder. At start, every such name is removed
/// when it is a socket and nobody listens on it (the connection is refused). A name of any other kind stays, and so does a socket that answers.
async fn remove_stale_sockets(sock_path: &Path) {
    let (Some(dir), Some(base)) = (sock_path.parent(), sock_path.file_name()) else {
        return;
    };
    let base = base.to_string_lossy().into_owned();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(tail) = name
            .strip_prefix(&base)
            .and_then(|r| r.strip_prefix('.'))
        else {
            continue;
        };
        if tail.len() != 6 || !tail.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            continue;
        }
        let file = e.path();
        if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_socket()) {
            continue;
        }
        let refused = match tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(&file)).await {
            Ok(Err(e)) => e.kind() == std::io::ErrorKind::ConnectionRefused,
            _ => false,
        };
        if refused && std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_socket()) {
            let _ = std::fs::remove_file(&file);
        }
    }
}

async fn read_line(sock: &mut UnixStream) -> Result<String, EventError> {
    let read = async {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock
                .read(&mut chunk)
                .await
                .map_err(|_| EventError::bad("closed before a request"))?;
            if n == 0 {
                return Err(EventError::bad("closed before a request"));
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = buf.iter().position(|b| *b == b'\n') {
                return Ok(String::from_utf8_lossy(&buf[..i]).into_owned());
            }
            if buf.len() > MAX_REQUEST {
                return Err(EventError::bad("the request line is too long"));
            }
        }
    };
    tokio::time::timeout(Duration::from_millis(REQUEST_MS), read)
        .await
        .map_err(|_| EventError::bad("no request line within 10 s"))?
}

fn strings(v: &Value, what: &str) -> Result<Vec<String>, EventError> {
    match v {
        Value::Null => Ok(Vec::new()),
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                x.as_str().map(str::to_owned).ok_or_else(|| {
                    EventError::bad(format!("filter: {what} must be text of at most 4096 characters"))
                })
            })
            .collect(),
        _ => Err(EventError::bad(format!(
            "filter: {what} must be text of at most 4096 characters"
        ))),
    }
}

fn filter_of(f: &Value) -> Result<Filter, EventError> {
    let get = |k: &str| strings(f.get(k).unwrap_or(&Value::Null), k);
    let type_ = match f.get("type") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(EventError::bad("filter: type is \"file\" or \"dir\"")),
    };
    Filter::new(FilterSpec {
        prefix: get("prefix")?,
        glob: get("glob")?,
        kind: get("kind")?,
        type_,
        label: get("label")?,
    })
}

/// Read the request line, subscribe, and write what the subscriber yields until it ends or the client goes.
async fn serve(bus: &Arc<Bus>, sock: &mut UnixStream) -> Result<(), EventError> {
    let request = read_line(sock).await?;
    let spec: Value = serde_json::from_str(&request)
        .map_err(|_| EventError::bad("the request is one JSON line"))?;
    let Some(obj) = spec.as_object() else {
        return Err(EventError::bad("the request is a JSON object"));
    };
    let since = match obj.get("since") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(EventError::bad("since is a cursor (text)")),
    };
    let filter = match obj.get("filter") {
        None | Some(Value::Null) => Filter::new(FilterSpec::default())?,
        Some(f @ Value::Object(_)) => filter_of(f)?,
        Some(_) => return Err(EventError::bad("filter is an object")),
    };
    let sub = bus.subscribe(filter, since.as_deref(), Transport::Socket)?;
    let mut probe = [0u8; 256];
    let mut reading = true;
    loop {
        tokio::select! {
            batch = sub.next() => {
                let Some(batch) = batch else { break };
                let mut out = Vec::new();
                for b in batch {
                    out.extend_from_slice(&b);
                }
                if sock.write_all(&out).await.is_err() {
                    break;
                }
            }
            // a client that closes its writing side still reads; one that is gone is found when a write fails (a ping, at the latest)
            r = sock.read(&mut probe), if reading => match r {
                Ok(0) => reading = false,
                Ok(_) => {}
                Err(_) => break,
            },
        }
    }
    sub.close();
    Ok(())
}
