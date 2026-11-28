#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use fd_events::{
    Bus, BusOptions, Filter, FilterSpec, JournalOptions, Kind, LabelRules, NewEvent, Scope,
    Transport, Window,
};
use serde_json::Value;

fn bus_with(f: impl FnOnce(&mut BusOptions)) -> Arc<Bus> {
    let mut o = BusOptions::new("n1", JournalOptions::new("n1", None));
    f(&mut o);
    Bus::new(o)
}

fn bus() -> Arc<Bus> {
    bus_with(|_| {})
}

fn all() -> Filter {
    Filter::new(FilterSpec::default()).unwrap()
}

fn create(b: &Bus, p: &str) {
    b.publish(NewEvent::entry(Kind::Create, false, p));
}

/// The lines of a subscriber until it is silent for `ms`.
async fn drain(s: &fd_events::Subscriber, ms: u64) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(Some(batch)) = tokio::time::timeout(Duration::from_millis(ms), s.next()).await {
        for l in batch {
            out.push(serde_json::from_slice(&l).unwrap());
        }
    }
    out
}

fn kinds(v: &[Value]) -> Vec<(String, String)> {
    v.iter()
        .map(|e| {
            (
                e["kind"].as_str().unwrap().to_owned(),
                e["path"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_subscriber_gets_what_it_asked_for_and_the_line_is_the_same_for_all() {
    let b = bus();
    let s1 = b.subscribe(all(), None, Transport::Http).unwrap();
    let s2 = b
        .subscribe(
            Filter::new(FilterSpec {
                glob: vec!["*.md".into()],
                kind: vec!["create".into()],
                ..FilterSpec::default()
            })
            .unwrap(),
            None,
            Transport::Internal,
        )
        .unwrap();
    create(&b, "/a/x.md");
    create(&b, "/a/x.txt");
    b.publish(NewEvent::entry(Kind::Modify, false, "/a/x.md"));
    let a = drain(&s1, 100).await;
    let m = drain(&s2, 100).await;
    assert_eq!(a.len(), 3);
    assert_eq!(kinds(&m), vec![("create".into(), "/a/x.md".into())]);
    assert_eq!(a[0]["cursor"], m[0]["cursor"]);
    assert_eq!(b.subscribers(), [0, 1, 1]);
    s1.close();
    s2.close();
    assert_eq!(b.subscribers(), [0, 0, 0]);
}

#[tokio::test]
async fn since_gives_the_journal_from_there_then_live_with_no_gap_and_no_repeat() {
    let b = bus();
    for i in 1..=5 {
        create(&b, &format!("/f{i}"));
    }
    let s = b
        .subscribe(all(), Some(&b.cursor_of(2)), Transport::Http)
        .unwrap();
    create(&b, "/f6");
    let got = drain(&s, 100).await;
    let paths: Vec<_> = got.iter().map(|e| e["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["/f3", "/f4", "/f5", "/f6"]);
    assert_eq!(b.replayed(), 3);
}

#[tokio::test]
async fn a_cursor_of_another_epoch_or_from_the_future_gets_one_reset_first() {
    let b = bus();
    create(&b, "/a");
    create(&b, "/b");
    let s = b
        .subscribe(all(), Some("n1:zzzz:1"), Transport::Http)
        .unwrap();
    create(&b, "/c");
    let got = drain(&s, 100).await;
    assert_eq!(got[0]["kind"], "reset");
    assert_eq!(got[0]["scope"], "node");
    assert!(got[0]["reason"].as_str().unwrap().contains("epoch"));
    assert_eq!(got[1]["path"], "/c");
    let f = b
        .subscribe(all(), Some(&b.cursor_of(99)), Transport::Http)
        .unwrap();
    let got = drain(&f, 100).await;
    assert!(got[0]["reason"].as_str().unwrap().contains("future"));
    assert_eq!(b.resets(), 2);
}

#[tokio::test]
async fn a_bad_cursor_is_a_400_and_a_cursor_of_another_node_too() {
    let b = bus();
    assert_eq!(
        b.subscribe(all(), Some("garbage"), Transport::Http).err().unwrap().status,
        400
    );
    assert_eq!(
        b.subscribe(all(), Some("other:ab:1"), Transport::Http).err().unwrap().status,
        400
    );
}

#[tokio::test]
async fn a_subscriber_that_does_not_read_is_ended_with_lagged_and_never_holds_the_others() {
    let b = bus_with(|o| o.max_queue_bytes = 2000);
    let slow = b.subscribe(all(), None, Transport::Http).unwrap();
    let fast = b.subscribe(all(), None, Transport::Http).unwrap();
    for i in 0..40 {
        create(&b, &format!("/some/long/enough/path/name/{i}"));
        let _ = drain(&fast, 1).await;
    }
    assert_eq!(b.dropped_lagged(), 1);
    let got = drain(&slow, 100).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["kind"], "lagged");
    assert!(slow.next().await.is_none(), "the stream is over");
    slow.close(); // the transport lets go when it has written the lagged line
    assert_eq!(b.subscribers()[1], 1);
}

#[tokio::test]
async fn an_idle_subscriber_gets_a_ping_whose_cursor_is_the_head() {
    let b = bus_with(|o| o.ping_ms = 40);
    create(&b, "/a");
    let s = b.subscribe(all(), None, Transport::Http).unwrap();
    let got = tokio::time::timeout(Duration::from_secs(2), s.next())
        .await
        .unwrap()
        .unwrap();
    let v: Value = serde_json::from_slice(&got[0]).unwrap();
    assert_eq!(v["kind"], "ping");
    assert_eq!(v["cursor"], b.cursor_of(1));
}

#[tokio::test]
async fn a_new_subscriber_is_told_the_watchers_state_first_and_stopped_none() {
    let b = bus();
    let none = b.subscribe(all(), None, Transport::Http).unwrap();
    assert!(drain(&none, 30).await.is_empty(), "no ready line while the watcher is not ready");
    let mut ev = NewEvent::control(Kind::Ready, Scope::Node);
    ev.unwatched = Some(vec!["/data".into(), "/backup".into()]);
    b.publish(ev);
    b.set_ready(true);
    assert_eq!(b.unwatched_paths(), ["/backup", "/data"]);
    let s = b.subscribe(all(), None, Transport::Http).unwrap();
    let got = drain(&s, 50).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["kind"], "ready");
    assert_eq!(got[0]["unwatched"], serde_json::json!(["/backup", "/data"]));
    b.set_ready(false);
    assert!(b.unwatched_paths().is_empty());
    let t = b.subscribe(all(), None, Transport::Http).unwrap();
    assert!(drain(&t, 30).await.is_empty());
}

#[tokio::test]
async fn with_a_cursor_ready_comes_after_a_reset_and_before_the_replayed_lines() {
    let b = bus();
    b.publish(NewEvent::control(Kind::Ready, Scope::Node));
    b.set_ready(true);
    create(&b, "/a");
    create(&b, "/b");
    let s = b
        .subscribe(all(), Some(&b.cursor_of(1)), Transport::Http)
        .unwrap();
    let got = drain(&s, 80).await;
    let k: Vec<_> = got.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(k, ["ready", "create", "create"]);
    let r = b
        .subscribe(all(), Some("n1:nope:1"), Transport::Http)
        .unwrap();
    let got = drain(&r, 50).await;
    let k: Vec<_> = got.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(k, ["reset", "ready"]);
}

#[tokio::test]
async fn listeners_hear_every_event_also_when_this_process_is_not_the_writer() {
    let writes = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let w = Arc::clone(&writes);
    let b = bus_with(move |o| o.writer = Some(Arc::new(move || w.load(std::sync::atomic::Ordering::SeqCst))));
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let h = Arc::clone(&heard);
    b.listen(Arc::new(move |m| h.lock().unwrap().push(m.path.clone().unwrap_or_default())));
    create(&b, "/seen");
    assert_eq!(heard.lock().unwrap().as_slice(), ["/seen"]);
    assert_eq!(b.journal_status().head, 0, "nothing is written");
    assert_eq!(
        b.subscribe(all(), None, Transport::Http).err().unwrap().status,
        503
    );
    writes.store(true, std::sync::atomic::Ordering::SeqCst);
    create(&b, "/written");
    assert_eq!(b.journal_status().head, 1);
}

#[tokio::test]
async fn overflow_and_reset_carry_their_window_and_a_move_carries_the_labels_of_both_places() {
    let b = bus_with(|o| o.labels = LabelRules::new("/srv/{org}").unwrap());
    let s = b.subscribe(all(), None, Transport::Http).unwrap();
    let mut o = NewEvent::control(Kind::Overflow, Scope::Filesystem);
    o.path = Some("/srv/a".into());
    o.window = Some(Window { from: 5, to: Some(9) });
    o.reason = Some("dropped".into());
    b.publish(o);
    let mut mv = NewEvent::entry(Kind::Move, false, "/srv/a/x");
    mv.from = Some("/srv/b/x".into());
    b.publish(mv);
    let got = drain(&s, 50).await;
    assert_eq!(got[0]["window"], serde_json::json!({"from": 5, "to": 9}));
    assert_eq!(got[0]["reason"], "dropped");
    assert_eq!(got[1]["labels"], serde_json::json!({"org": "a"}));
    assert_eq!(got[1]["fromLabels"], serde_json::json!({"org": "b"}));
    assert_eq!(b.overflows(), 1);
    let byorg = Filter::new(FilterSpec {
        label: vec!["org:b".into()],
        ..FilterSpec::default()
    })
    .unwrap();
    let l = b.subscribe(byorg, Some(&b.cursor_of(0)), Transport::Http).unwrap();
    let got = drain(&l, 50).await;
    assert!(got.iter().any(|e| e["kind"] == "move"), "a label of the old place matches");
}

#[tokio::test]
async fn replay_from_the_files_of_a_journal_on_disk_in_order_then_live() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("changes-n1");
    let mut jo = JournalOptions::new("n1", Some(dir));
    jo.ring_events = 2;
    let b = Bus::new(BusOptions::new("n1", jo));
    for i in 1..=30 {
        create(&b, &format!("/f{i}"));
    }
    let s = b
        .subscribe(all(), Some(&b.cursor_of(4)), Transport::Socket)
        .unwrap();
    create(&b, "/live");
    let got = drain(&s, 200).await;
    assert_eq!(got.len(), 27);
    assert_eq!(got[0]["path"], "/f5");
    assert_eq!(got[25]["path"], "/f30");
    assert_eq!(got[26]["path"], "/live");
    b.close(false);
}

#[tokio::test]
async fn a_closed_bus_ends_its_subscribers_and_drops_events() {
    let b = bus();
    let s = b.subscribe(all(), None, Transport::Http).unwrap();
    b.close(false);
    assert!(s.next().await.is_none());
    create(&b, "/late");
    assert_eq!(b.journal_status().head, 0);
}
