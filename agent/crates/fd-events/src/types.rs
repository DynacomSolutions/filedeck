//! The change events of one agent in the form the bus, the journal and every transport share. An event is encoded to one JSON line once;
//! every subscriber gets the same bytes. The field order is fixed, the cursor first (the journal finds a line's cursor without parsing it).

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Create,
    Delete,
    Modify,
    CloseWrite,
    Attrib,
    Move,
    Overflow,
    Reset,
    Ready,
}

pub const KINDS: [Kind; 9] = [
    Kind::Create,
    Kind::Delete,
    Kind::Modify,
    Kind::CloseWrite,
    Kind::Attrib,
    Kind::Move,
    Kind::Overflow,
    Kind::Reset,
    Kind::Ready,
];

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Create => "create",
            Kind::Delete => "delete",
            Kind::Modify => "modify",
            Kind::CloseWrite => "close_write",
            Kind::Attrib => "attrib",
            Kind::Move => "move",
            Kind::Overflow => "overflow",
            Kind::Reset => "reset",
            Kind::Ready => "ready",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        KINDS.iter().copied().find(|k| k.as_str() == s)
    }

    /// Kinds that say something about the stream and not about one entry: every subscriber gets them, whatever its filter says.
    pub fn is_control(self) -> bool {
        matches!(self, Kind::Overflow | Kind::Reset | Kind::Ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Node,
    Filesystem,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Node => "node",
            Scope::Filesystem => "filesystem",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    /// ms since the epoch: events from this time on may be missing
    pub from: i64,
    /// ms since the epoch: the watcher is seeing events again from here (absent while it is still away)
    pub to: Option<i64>,
}

/// What the publisher gives the bus. The bus adds the cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct NewEvent {
    /// ms since the epoch (default: now)
    pub time: Option<i64>,
    pub kind: Kind,
    /// the entry is a folder
    pub dir: bool,
    /// agent virtual path of the entry (a move: where it is now); absent on a control event for the whole node
    pub path: Option<String>,
    /// a move: where the entry was
    pub from: Option<String>,
    pub scope: Option<Scope>,
    pub window: Option<Window>,
    pub reason: Option<String>,
    /// `ready`: mounts that no event covers (virtual paths)
    pub unwatched: Option<Vec<String>>,
}

impl NewEvent {
    pub fn new(kind: Kind) -> Self {
        Self {
            time: None,
            kind,
            dir: false,
            path: None,
            from: None,
            scope: None,
            window: None,
            reason: None,
            unwatched: None,
        }
    }

    pub fn entry(kind: Kind, dir: bool, path: impl Into<String>) -> Self {
        Self {
            dir,
            path: Some(path.into()),
            ..Self::new(kind)
        }
    }

    pub fn control(kind: Kind, scope: Scope) -> Self {
        Self {
            scope: Some(scope),
            ..Self::new(kind)
        }
    }
}

/// Labels of a path, in the order of the template names.
pub type Labels = std::sync::Arc<Map<String, Value>>;

/// The fields a filter looks at.
#[derive(Debug, Clone, Default)]
pub struct Matchable {
    pub kind: Option<Kind>,
    pub dir: bool,
    pub path: Option<String>,
    pub from: Option<String>,
    pub labels: Option<Labels>,
    /// a move: the labels of the place the entry came from (absent when they are the labels of `path`)
    pub from_labels: Option<Labels>,
}

/// An event as the bus holds it: the fields a filter needs and the finished line (JSON and a line feed).
#[derive(Debug, Clone)]
pub struct Encoded {
    pub seq: u64,
    pub time: i64,
    pub matchable: Matchable,
    pub line: Bytes,
}

/// A line of the journal read back, for a filter.
#[derive(Debug, Deserialize)]
struct Line {
    kind: Option<String>,
    #[serde(default)]
    dir: bool,
    path: Option<String>,
    from: Option<String>,
    labels: Option<Map<String, Value>>,
    #[serde(rename = "fromLabels")]
    from_labels: Option<Map<String, Value>>,
}

impl Matchable {
    pub fn from_line(line: &[u8]) -> Option<Matchable> {
        let l: Line = serde_json::from_slice(line).ok()?;
        Some(Matchable {
            kind: l.kind.as_deref().and_then(Kind::parse),
            dir: l.dir,
            path: l.path,
            from: l.from,
            labels: l.labels.map(std::sync::Arc::new),
            from_labels: l.from_labels.map(std::sync::Arc::new),
        })
    }
}

/// An event with its cursor and node, as it is written.
pub struct Full<'a> {
    pub cursor: &'a str,
    pub time: i64,
    pub node: &'a str,
    pub ev: &'a NewEvent,
    pub labels: Option<&'a Labels>,
    pub from_labels: Option<&'a Labels>,
}

pub fn encode_event(f: &Full<'_>) -> Bytes {
    let mut o = Map::new();
    o.insert("cursor".into(), json!(f.cursor));
    o.insert("time".into(), json!(f.time));
    o.insert("node".into(), json!(f.node));
    o.insert("kind".into(), json!(f.ev.kind.as_str()));
    o.insert("dir".into(), json!(f.ev.dir));
    if let Some(p) = &f.ev.path {
        o.insert("path".into(), json!(p));
    }
    if let Some(p) = &f.ev.from {
        o.insert("from".into(), json!(p));
    }
    if let Some(l) = f.labels {
        o.insert("labels".into(), Value::Object((**l).clone()));
    }
    if let Some(l) = f.from_labels {
        o.insert("fromLabels".into(), Value::Object((**l).clone()));
    }
    if let Some(s) = f.ev.scope {
        o.insert("scope".into(), json!(s.as_str()));
    }
    if let Some(w) = f.ev.window {
        let mut m = Map::new();
        m.insert("from".into(), json!(w.from));
        if let Some(to) = w.to {
            m.insert("to".into(), json!(to));
        }
        o.insert("window".into(), Value::Object(m));
    }
    if let Some(r) = &f.ev.reason
        && !r.is_empty()
    {
        o.insert("reason".into(), json!(r));
    }
    if let Some(u) = &f.ev.unwatched {
        o.insert("unwatched".into(), json!(u));
    }
    line_of(&Value::Object(o))
}

/// One JSON object and a line feed.
pub fn line_of(v: &Value) -> Bytes {
    let mut s = v.to_string();
    s.push('\n');
    Bytes::from(s)
}

/// The line sent when a subscriber's own buffer filled: the stream ends, and the client reconnects with `since` = `cursor`.
pub fn lagged_line(node: &str, cursor: Option<&str>, time: i64) -> Bytes {
    let mut o = Map::new();
    o.insert("kind".into(), json!("lagged"));
    o.insert("node".into(), json!(node));
    if let Some(c) = cursor {
        o.insert("cursor".into(), json!(c));
    }
    o.insert("reason".into(), json!("the subscriber was too slow"));
    o.insert("time".into(), json!(time));
    line_of(&Value::Object(o))
}

pub fn ping_line(node: &str, cursor: &str, time: i64) -> Bytes {
    line_of(&json!({"kind": "ping", "node": node, "time": time, "cursor": cursor}))
}

/// The sequence number in a line that starts `{"cursor":"<node>:<epoch>:<seq>"`.
pub fn line_seq(line: &[u8]) -> Option<u64> {
    let rest = line.get(11..)?;
    let end = rest.iter().position(|b| *b == b'"')? + 11;
    let colon = line[..end].iter().rposition(|b| *b == b':')?;
    let digits = &line[colon + 1..end];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_field_order_is_fixed_and_the_cursor_is_first() {
        let mut ev = NewEvent::entry(Kind::Move, false, "/b");
        ev.from = Some("/a".into());
        let line = encode_event(&Full {
            cursor: "n:e:3",
            time: 5,
            node: "n",
            ev: &ev,
            labels: None,
            from_labels: None,
        });
        assert_eq!(
            std::str::from_utf8(&line).unwrap(),
            "{\"cursor\":\"n:e:3\",\"time\":5,\"node\":\"n\",\"kind\":\"move\",\"dir\":false,\"path\":\"/b\",\"from\":\"/a\"}\n"
        );
        assert_eq!(line_seq(&line), Some(3));
    }

    #[test]
    fn a_control_event_has_scope_window_and_reason() {
        let mut ev = NewEvent::control(Kind::Overflow, Scope::Filesystem);
        ev.path = Some("/x".into());
        ev.window = Some(Window { from: 1, to: None });
        ev.reason = Some("why".into());
        let line = encode_event(&Full {
            cursor: "n:e:1",
            time: 2,
            node: "n",
            ev: &ev,
            labels: None,
            from_labels: None,
        });
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(v["scope"], "filesystem");
        assert_eq!(v["window"], json!({"from": 1}));
        assert_eq!(v["reason"], "why");
        let m = Matchable::from_line(&line).unwrap();
        assert_eq!(m.kind, Some(Kind::Overflow));
    }

    #[test]
    fn line_seq_reads_the_number() {
        assert_eq!(line_seq(b"{\"cursor\":\"a:b:42\",\"x\":1}\n"), Some(42));
        assert_eq!(line_seq(b"{\"cursor\":\"a:b:x\"}"), None);
        assert_eq!(line_seq(b"short"), None);
    }
}
