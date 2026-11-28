//! The agent's event bus: one in-process point where the watcher's events enter (`publish`), get a cursor, are encoded once, are kept in the
//! journal, and are handed to every subscriber whose filter accepts them. A subscriber is a bounded queue: one that does not read fast enough
//! is ended with a `lagged` line and reads the journal when it comes back, so a slow reader never holds the bus or the watcher.
//!
//! Only the process that holds the size store's writer lock writes the journal and serves subscribers (`writer`). A process that is not the
//! writer drops what it sees and answers 503 to a subscriber (on a Mac the old process is stopped before the new one starts).
//!
//! No timer runs here. A subscriber arms one `ping` deadline while it waits for lines.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::Notify;

use crate::cursor::parse_cursor;
use crate::error::EventError;
use crate::filter::Filter;
use crate::journal::{Gap, Journal, JournalOptions, now_ms, read_chunks};
use crate::labels::LabelRules;
use crate::types::{
    Encoded, Full, KINDS, Kind, Matchable, NewEvent, Scope, encode_event, lagged_line, line_of,
    line_seq, ping_line,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Socket,
    Http,
    Internal,
}

impl Transport {
    pub const ALL: [Transport; 3] = [Transport::Socket, Transport::Http, Transport::Internal];

    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Socket => "socket",
            Transport::Http => "http",
            Transport::Internal => "internal",
        }
    }
}

pub struct BusOptions {
    pub node: String,
    pub journal: JournalOptions,
    pub labels: LabelRules,
    /// may this process write the journal and serve readers? (the size store's writer lock). Default: always.
    pub writer: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// the most bytes one subscriber may have queued before it is ended as lagged (default 1 MiB)
    pub max_queue_bytes: usize,
    /// a subscriber that has nothing to read for this long gets a `ping` line (default 15 s)
    pub ping_ms: u64,
}

impl BusOptions {
    pub fn new(node: impl Into<String>, journal: JournalOptions) -> Self {
        Self {
            node: node.into(),
            journal,
            labels: LabelRules::default(),
            writer: None,
            max_queue_bytes: 1024 * 1024,
            ping_ms: 15_000,
        }
    }
}

type Listener = Arc<dyn Fn(&Matchable) + Send + Sync>;

struct Inner {
    journal: Journal,
    subs: Vec<Arc<SubShared>>,
    listeners: Vec<(u64, Listener)>,
    next_listener: u64,
    closed: bool,
    ready: bool,
    unwatched: BTreeSet<String>,
    last_event_at: i64,
    lag_ms: f64,
    stopped: Vec<(u64, Arc<dyn Fn() + Send + Sync>)>,
}

#[derive(Default)]
struct Counters {
    events: [AtomicU64; 9],
    overflows: AtomicU64,
    resets: AtomicU64,
    dropped_lagged: AtomicU64,
    replayed: AtomicU64,
}

pub struct Bus {
    pub node: String,
    labels: LabelRules,
    writer: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    max_queue_bytes: usize,
    ping_ms: u64,
    inner: Mutex<Inner>,
    counters: Counters,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Replay,
    Live,
    Closing,
    Closed,
}

struct SubQ {
    lines: Vec<Bytes>,
    seqs: Vec<u64>,
    bytes: usize,
    state: SubState,
    live: Vec<Encoded>,
    live_bytes: usize,
    /// the newest sequence number handed to the transport: the point to resume from
    delivered: u64,
    sent: u64,
}

pub(crate) struct SubShared {
    filter: Filter,
    transport: Transport,
    q: Mutex<SubQ>,
    wake: Notify,
    room: Notify,
}

impl SubShared {
    fn wake(&self) {
        self.wake.notify_one();
    }

    /// The bus offers each new event. Returns true when the subscriber lagged (counted by the caller).
    fn offer(&self, e: &Encoded, bus: &Bus, head_cursor: &dyn Fn(u64) -> String) -> bool {
        let mut q = lock(&self.q);
        if matches!(q.state, SubState::Closed | SubState::Closing) {
            return false;
        }
        if !self.filter.matches(&e.matchable) {
            // nothing is queued for an event the filter refuses; the resume point still moves when nothing is waiting before it
            if q.state == SubState::Live && q.lines.is_empty() {
                q.delivered = e.seq;
            }
            return false;
        }
        if q.state == SubState::Replay {
            q.live_bytes += e.line.len();
            q.live.push(e.clone());
            if q.live_bytes > bus.max_queue_bytes {
                return self.lag_locked(&mut q, bus, head_cursor);
            }
            return false;
        }
        q.lines.push(e.line.clone());
        q.seqs.push(e.seq);
        q.bytes += e.line.len();
        let over = q.bytes > bus.max_queue_bytes;
        let lagged = over && self.lag_locked(&mut q, bus, head_cursor);
        drop(q);
        self.wake();
        lagged
    }

    /// The queue filled: drop it, say so, end the stream once that line is read.
    fn lag_locked(&self, q: &mut SubQ, bus: &Bus, head_cursor: &dyn Fn(u64) -> String) -> bool {
        let cur = (q.delivered != 0).then(|| head_cursor(q.delivered));
        let line = lagged_line(&bus.node, cur.as_deref(), now_ms());
        q.bytes = line.len();
        q.lines = vec![line];
        q.seqs = vec![0];
        q.live.clear();
        q.live_bytes = 0;
        q.state = SubState::Closing;
        self.room.notify_one();
        self.wake.notify_one();
        true
    }
}

/// A reader of the bus. `next` gives the lines to send; the stream is over when it gives `None`.
pub struct Subscriber {
    shared: Arc<SubShared>,
    bus: Arc<Bus>,
}

impl Subscriber {
    pub fn transport(&self) -> Transport {
        self.shared.transport
    }

    /// The next lines to send, or `None` once the stream is over. A `ping` comes when nothing happened for the ping time.
    pub async fn next(&self) -> Option<Vec<Bytes>> {
        loop {
            {
                let mut q = lock(&self.shared.q);
                if !q.lines.is_empty() {
                    let batch = std::mem::take(&mut q.lines);
                    let seqs = std::mem::take(&mut q.seqs);
                    q.bytes = 0;
                    for s in seqs {
                        if s > q.delivered {
                            q.delivered = s;
                        }
                    }
                    q.sent += batch.len() as u64;
                    drop(q);
                    self.shared.room.notify_one();
                    return Some(batch);
                }
                if matches!(q.state, SubState::Closing | SubState::Closed) {
                    return None;
                }
            }
            let wait = tokio::time::timeout(
                Duration::from_millis(self.bus.ping_ms),
                self.shared.wake.notified(),
            )
            .await;
            if wait.is_err() {
                // all that came so far was looked at: the ping's cursor lets a client with a narrow filter resume from here
                // (the bus lock is taken before the queue's, never the other way round)
                let (head, line) = self.bus.ping();
                let mut q = lock(&self.shared.q);
                if q.state == SubState::Live && q.lines.is_empty() {
                    q.bytes += line.len();
                    q.lines.push(line);
                    q.seqs.push(head);
                }
            }
        }
    }

    /// The client is gone (or the stream is over): nothing more is queued.
    pub fn close(&self) {
        {
            let mut q = lock(&self.shared.q);
            if q.state == SubState::Closed {
                return;
            }
            q.state = SubState::Closed;
            q.lines.clear();
            q.seqs.clear();
            q.live.clear();
            q.bytes = 0;
        }
        let mut inner = lock(&self.bus.inner);
        inner.subs.retain(|s| !Arc::ptr_eq(s, &self.shared));
        drop(inner);
        self.shared.room.notify_one();
        self.shared.wake();
    }

    /// Lines sent so far.
    pub fn sent(&self) -> u64 {
        lock(&self.shared.q).sent
    }

    /// The newest sequence number handed to the transport.
    pub fn delivered(&self) -> u64 {
        lock(&self.shared.q).delivered
    }
}

impl Drop for Subscriber {
    fn drop(&mut self) {
        self.close();
    }
}

/// What the bus says about itself (for node-status and metrics).
#[derive(Debug, Clone)]
pub struct JournalStatus {
    pub serving: bool,
    pub epoch: String,
    pub head: u64,
    pub oldest: u64,
    pub oldest_cursor: Option<String>,
    pub newest_cursor: Option<String>,
    pub oldest_age_ms: i64,
    pub bytes: u64,
    pub persistent: bool,
    pub unclean_opens: u64,
    pub continued: bool,
    pub last_time: i64,
}

impl Bus {
    pub fn new(o: BusOptions) -> Arc<Self> {
        let mut journal = Journal::new(o.journal);
        journal.open();
        Arc::new(Self {
            node: o.node,
            labels: o.labels,
            writer: o.writer,
            max_queue_bytes: o.max_queue_bytes,
            ping_ms: o.ping_ms,
            inner: Mutex::new(Inner {
                journal,
                subs: Vec::new(),
                listeners: Vec::new(),
                next_listener: 1,
                closed: false,
                ready: false,
                unwatched: BTreeSet::new(),
                last_event_at: 0,
                lag_ms: 0.0,
                stopped: Vec::new(),
            }),
            counters: Counters::default(),
        })
    }

    /// Does this process write the journal and serve readers?
    pub fn serving(&self) -> bool {
        !lock(&self.inner).closed && self.writer.as_ref().is_none_or(|w| w())
    }

    pub fn cursor_of(&self, seq: u64) -> String {
        lock(&self.inner).journal.cursor_of(seq)
    }

    pub fn journal_status(&self) -> JournalStatus {
        let serving = self.serving();
        let inner = lock(&self.inner);
        let j = &inner.journal;
        let head = j.head();
        let oldest = j.oldest();
        JournalStatus {
            serving,
            epoch: j.epoch.clone(),
            head,
            oldest,
            oldest_cursor: (serving && oldest <= head).then(|| j.cursor_of(oldest)),
            newest_cursor: (serving && head > 0).then(|| j.cursor_of(head)),
            oldest_age_ms: j.oldest_age_ms(now_ms()),
            bytes: j.bytes(),
            persistent: j.persistent(),
            unclean_opens: j.unclean_opens,
            continued: j.continued,
            last_time: j.last_time(),
        }
    }

    pub fn subscribers(&self) -> [u64; 3] {
        let inner = lock(&self.inner);
        let mut n = [0u64; 3];
        for s in &inner.subs {
            let i = Transport::ALL
                .iter()
                .position(|t| *t == s.transport)
                .unwrap_or(2);
            n[i] += 1;
        }
        n
    }

    pub fn event_count(&self, k: Kind) -> u64 {
        KINDS
            .iter()
            .position(|x| *x == k)
            .map_or(0, |i| self.counters.events[i].load(Ordering::Relaxed))
    }

    pub fn overflows(&self) -> u64 {
        self.counters.overflows.load(Ordering::Relaxed)
    }

    pub fn resets(&self) -> u64 {
        self.counters.resets.load(Ordering::Relaxed)
    }

    pub fn dropped_lagged(&self) -> u64 {
        self.counters.dropped_lagged.load(Ordering::Relaxed)
    }

    pub fn replayed(&self) -> u64 {
        self.counters.replayed.load(Ordering::Relaxed)
    }

    pub fn lag_ms(&self) -> f64 {
        lock(&self.inner).lag_ms
    }

    pub fn last_event_at(&self) -> i64 {
        lock(&self.inner).last_event_at
    }

    /// true while the kernel watcher runs and has every mark in place (set by the watcher). When it turns false, `on_stopped` listeners are told at once.
    pub fn ready(&self) -> bool {
        lock(&self.inner).ready
    }

    pub fn set_ready(&self, v: bool) {
        let stopped: Vec<Arc<dyn Fn() + Send + Sync>> = {
            let mut inner = lock(&self.inner);
            let was = inner.ready;
            inner.ready = v;
            if !v {
                inner.unwatched.clear();
            }
            if was && !v {
                inner.stopped.iter().map(|s| Arc::clone(&s.1)).collect()
            } else {
                Vec::new()
            }
        };
        for f in stopped {
            f();
        }
    }

    /// Told when the watcher stops: what is held in memory about folders (the folder feed) is no longer kept current.
    pub fn on_stopped(&self, f: Arc<dyn Fn() + Send + Sync>) -> u64 {
        let mut inner = lock(&self.inner);
        let id = inner.next_listener;
        inner.next_listener += 1;
        inner.stopped.push((id, f));
        id
    }

    pub fn off_stopped(&self, id: u64) {
        lock(&self.inner).stopped.retain(|s| s.0 != id);
    }

    /// The mounts that no event covers, as the watcher reported them.
    pub fn unwatched_paths(&self) -> Vec<String> {
        lock(&self.inner).unwatched.iter().cloned().collect()
    }

    /// A listener sees every event the watcher publishes, at once and whether or not this process writes the journal. It runs before the
    /// filters of the subscribers and must not call back into the bus.
    pub fn listen(&self, f: Listener) -> u64 {
        let mut inner = lock(&self.inner);
        let id = inner.next_listener;
        inner.next_listener += 1;
        inner.listeners.push((id, f));
        id
    }

    pub fn unlisten(&self, id: u64) {
        lock(&self.inner).listeners.retain(|l| l.0 != id);
    }

    fn ready_line_in(&self, inner: &Inner, seq: u64) -> Option<Bytes> {
        if !inner.ready {
            return None;
        }
        let mut ev = NewEvent::control(Kind::Ready, Scope::Node);
        if !inner.unwatched.is_empty() {
            ev.unwatched = Some(inner.unwatched.iter().cloned().collect());
        }
        Some(encode_event(&Full {
            cursor: &inner.journal.cursor_of(seq),
            time: now_ms(),
            node: &self.node,
            ev: &ev,
            labels: None,
            from_labels: None,
        }))
    }

    fn ping(&self) -> (u64, Bytes) {
        let inner = lock(&self.inner);
        let head = inner.journal.head();
        (head, ping_line(&self.node, &inner.journal.cursor_of(head), now_ms()))
    }

    /// The watcher saw a change. Never fails, never waits.
    pub fn publish(&self, ev: NewEvent) {
        self.publish_batch(vec![ev]);
    }

    /// Several changes at once: one write to the journal.
    pub fn publish_batch(&self, evs: Vec<NewEvent>) {
        if evs.is_empty() {
            return;
        }
        let writes = self.writer.as_ref().is_none_or(|w| w());
        let t0 = Instant::now();
        let mut guard = lock(&self.inner);
        let inner = &mut *guard;
        if inner.closed {
            return;
        }
        let mut items: Vec<(u64, i64, Bytes)> = Vec::new();
        let mut encoded: Vec<Encoded> = Vec::new();
        let base = inner.journal.head();
        for (n, ev) in evs.iter().enumerate() {
            let time = ev.time.unwrap_or_else(now_ms);
            let control = ev.kind.is_control();
            let labels = ev
                .path
                .as_deref()
                .filter(|_| !control)
                .and_then(|p| self.labels.labels(p));
            let from_labels = ev.from.as_deref().and_then(|p| self.labels.labels(p));
            let from_labels = match (&from_labels, &labels) {
                (Some(f), Some(l)) if Arc::ptr_eq(f, l) => None,
                _ => from_labels,
            };
            let m = Matchable {
                kind: Some(ev.kind),
                dir: ev.dir,
                path: ev.path.clone(),
                from: ev.from.clone(),
                labels: labels.clone(),
                from_labels: from_labels.clone(),
            };
            for (_, l) in &inner.listeners {
                l(&m);
            }
            if ev.kind == Kind::Ready {
                inner.unwatched = ev
                    .unwatched
                    .iter()
                    .flatten()
                    .cloned()
                    .collect::<BTreeSet<_>>();
            }
            if ev.scope == Some(Scope::Filesystem)
                && ev.kind == Kind::Reset
                && let Some(p) = &ev.path
                && ev.window.is_none_or(|w| w.to.is_none())
            {
                inner.unwatched.insert(p.clone());
            }
            if !writes {
                continue;
            }
            let seq = base + n as u64 + 1;
            let cursor = inner.journal.cursor_of(seq);
            let line = encode_event(&Full {
                cursor: &cursor,
                time,
                node: &self.node,
                ev,
                labels: labels.as_ref(),
                from_labels: from_labels.as_ref(),
            });
            items.push((seq, time, line.clone()));
            encoded.push(Encoded {
                seq,
                time,
                matchable: m,
                line,
            });
        }
        if !writes {
            return;
        }
        inner.journal.write_batch(&items);
        let epoch_cursor = {
            let j = &inner.journal;
            let node = self.node.clone();
            let epoch = j.epoch.clone();
            move |seq: u64| crate::cursor::format_cursor(&node, &epoch, seq)
        };
        for (e, ev) in encoded.iter().zip(&evs) {
            if let Some(i) = KINDS.iter().position(|k| *k == ev.kind) {
                self.counters.events[i].fetch_add(1, Ordering::Relaxed);
            }
            match ev.kind {
                Kind::Overflow => {
                    self.counters.overflows.fetch_add(1, Ordering::Relaxed);
                }
                Kind::Reset => {
                    self.counters.resets.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }
            inner.last_event_at = e.time;
            for s in &inner.subs {
                if s.offer(e, self, &epoch_cursor) {
                    self.counters.dropped_lagged.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        let took = t0.elapsed().as_secs_f64() * 1000.0;
        inner.lag_ms = (inner.lag_ms * 0.9).max(took);
    }

    /// A new subscriber. `since` is a cursor the client holds: the journal from there is sent first, then live events, with nothing between.
    /// A bad cursor is a 400; one that cannot be continued (another epoch, older than the journal) is answered with one `reset` line.
    /// 503 when this process is not the writer.
    pub fn subscribe(
        self: &Arc<Self>,
        filter: Filter,
        since: Option<&str>,
        transport: Transport,
    ) -> Result<Subscriber, EventError> {
        let cur = match since.filter(|s| !s.is_empty()) {
            None => None,
            Some(s) => {
                let c = parse_cursor(s)
                    .filter(|c| c.node == self.node)
                    .ok_or_else(|| EventError::bad("since is not a cursor of this node"))?;
                Some((c.epoch, c.seq))
            }
        };
        if !self.serving() {
            return Err(EventError::new(
                503,
                "this process does not write the event journal yet, try again",
            ));
        }
        let shared = Arc::new(SubShared {
            filter,
            transport,
            q: Mutex::new(SubQ {
                lines: Vec::new(),
                seqs: Vec::new(),
                bytes: 0,
                state: SubState::Live,
                live: Vec::new(),
                live_bytes: 0,
                delivered: 0,
                sent: 0,
            }),
            wake: Notify::new(),
            room: Notify::new(),
        });
        let mut replay: Option<(crate::journal::ReadPlan, u64, u64)> = None;
        {
            // registered and the head read in one step: an event is either at or below `head` (read from the journal) or offered to the subscriber
            let mut guard = lock(&self.inner);
            let inner = &mut *guard;
            let head = inner.journal.head();
            let mut q = lock(&shared.q);
            match cur {
                None => {
                    if let Some(l) = self.ready_line_in(inner, head) {
                        q.bytes += l.len();
                        q.lines.push(l);
                        q.seqs.push(0);
                    }
                }
                Some((epoch, seq)) => {
                    let gap = inner.journal.check(&epoch, seq);
                    let plan = match gap {
                        Some(g) => Err(g),
                        None => inner.journal.plan(seq, head),
                    };
                    match plan {
                        Ok(p) => {
                            q.delivered = seq;
                            if let Some(l) = self.ready_line_in(inner, seq) {
                                q.bytes += l.len();
                                q.lines.push(l);
                                q.seqs.push(0);
                            }
                            q.state = SubState::Replay;
                            replay = Some((p, seq, head));
                        }
                        Err(g) => {
                            self.queue_reset(inner, &mut q, g);
                            if let Some(l) = self.ready_line_in(inner, head) {
                                q.bytes += l.len();
                                q.lines.push(l);
                                q.seqs.push(0);
                            }
                        }
                    }
                }
            }
            drop(q);
            inner.subs.push(Arc::clone(&shared));
        }
        let sub = Subscriber {
            shared: Arc::clone(&shared),
            bus: Arc::clone(self),
        };
        shared.wake();
        if let Some((plan, after, head)) = replay {
            let bus = Arc::clone(self);
            tokio::spawn(async move { bus.run_replay(shared, plan, after, head).await });
        }
        Ok(sub)
    }

    /// The cursor asked for cannot be continued from: one `reset` line (its cursor is the journal's head), then live events.
    fn queue_reset(&self, inner: &Inner, q: &mut SubQ, why: Gap) {
        let head = inner.journal.head();
        let line = line_of(&serde_json::json!({
            "cursor": inner.journal.cursor_of(head), "time": now_ms(), "node": self.node, "kind": "reset", "dir": false,
            "scope": "node", "reason": format!("cursor not usable ({}): look at everything again", why.why())
        }));
        self.counters.resets.fetch_add(1, Ordering::Relaxed);
        q.delivered = head;
        q.bytes += line.len();
        q.lines.push(line);
        q.seqs.push(0);
    }

    async fn run_replay(
        self: Arc<Self>,
        shared: Arc<SubShared>,
        plan: crate::journal::ReadPlan,
        after: u64,
        head: u64,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<Bytes>, Gap>>(2);
        let tx2 = tx.clone();
        tokio::task::spawn_blocking(move || {
            let r = read_chunks(plan, after, head, |c| tx.blocking_send(Ok(c)).is_ok());
            if let Err(g) = r {
                let _ = tx2.blocking_send(Err(g));
            }
        });
        let mut failed: Option<Gap> = None;
        while let Some(msg) = rx.recv().await {
            if lock(&shared.q).state != SubState::Replay {
                return;
            }
            match msg {
                Err(g) => {
                    failed = Some(g);
                    break;
                }
                Ok(chunk) => {
                    let out: Vec<Bytes> = chunk
                        .into_iter()
                        .filter(|l| {
                            shared.filter.empty()
                                || Matchable::from_line(l).is_some_and(|m| shared.filter.matches(&m))
                        })
                        .collect();
                    if !out.is_empty() {
                        let n = out.len() as u64;
                        let mut q = lock(&shared.q);
                        for l in out {
                            q.seqs.push(line_seq(&l).unwrap_or(0));
                            q.bytes += l.len();
                            q.lines.push(l);
                        }
                        drop(q);
                        shared.wake();
                        self.counters.replayed.fetch_add(n, Ordering::Relaxed);
                    }
                    // flow control: the reader takes what is queued before more is read
                    loop {
                        let big = {
                            let q = lock(&shared.q);
                            q.state == SubState::Replay && q.bytes > self.max_queue_bytes / 2
                        };
                        if !big {
                            break;
                        }
                        shared.room.notified().await;
                    }
                }
            }
        }
        if let Some(g) = failed {
            // the journal was lost while it was read: the `reset` comes before the `ready` line that may still wait in the queue
            let inner = lock(&self.inner);
            let mut q = lock(&shared.q);
            if q.state != SubState::Replay {
                return;
            }
            let ready_at = q.lines.iter().position(|l| is_ready_line(l));
            let ready = ready_at.map(|i| {
                q.seqs.remove(i);
                let l = q.lines.remove(i);
                q.bytes -= l.len();
                l
            });
            self.queue_reset(&inner, &mut q, g);
            if ready.is_some()
                && let Some(l) = self.ready_line_in(&inner, inner.journal.head())
            {
                q.bytes += l.len();
                q.lines.push(l);
                q.seqs.push(0);
            }
        }
        // events that came while the journal was read follow, in order, with nothing between
        let mut guard = lock(&shared.q);
        if guard.state != SubState::Replay {
            return;
        }
        guard.state = SubState::Live;
        let live = std::mem::take(&mut guard.live);
        guard.live_bytes = 0;
        for e in live {
            guard.lines.push(e.line);
            guard.seqs.push(e.seq);
        }
        guard.bytes = guard.lines.iter().map(Bytes::len).sum();
        let lag = guard.bytes > self.max_queue_bytes;
        drop(guard);
        if lag {
            let inner = lock(&self.inner);
            let cursor = |s| inner.journal.cursor_of(s);
            let mut q = lock(&shared.q);
            if shared.lag_locked(&mut q, &self, &cursor) {
                self.counters.dropped_lagged.fetch_add(1, Ordering::Relaxed);
            }
        }
        shared.wake();
    }

    /// Stop the bus: every subscriber ends, the journal is closed (clean) and, with `remove`, its folder is deleted.
    pub fn close(&self, remove_journal: bool) {
        let (subs, stopped) = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                return;
            }
            inner.closed = true;
            inner.listeners.clear();
            let stopped = std::mem::take(&mut inner.stopped);
            (std::mem::take(&mut inner.subs), stopped)
        };
        drop(stopped);
        for s in subs {
            let mut q = lock(&s.q);
            q.state = SubState::Closed;
            q.lines.clear();
            q.seqs.clear();
            drop(q);
            s.wake();
            s.room.notify_one();
        }
        lock(&self.inner).journal.close(remove_journal);
    }
}

fn is_ready_line(l: &[u8]) -> bool {
    // the `ready` line is ours: it has `"kind":"ready"` and is queued before any journal line
    std::str::from_utf8(l).is_ok_and(|s| s.contains("\"kind\":\"ready\""))
}
