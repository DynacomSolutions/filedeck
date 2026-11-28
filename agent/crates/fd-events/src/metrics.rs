use crate::bus::{Bus, Transport};
use crate::types::KINDS;

/// Prometheus text for the event bus: counts and ages only, nothing that names a path.
pub fn event_metrics(bus: &Bus) -> String {
    let subs = bus.subscribers();
    let j = bus.journal_status();
    let mut o = String::new();
    fn put(o: &mut String, help: &str, kind: &str, name: &str, value: String) {
        o.push_str(&format!("# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}\n"));
    }
    o.push_str("# HELP filedeck_events_total Change events published by the watcher, by kind\n# TYPE filedeck_events_total counter\n");
    for k in KINDS {
        o.push_str(&format!(
            "filedeck_events_total{{kind=\"{}\"}} {}\n",
            k.as_str(),
            bus.event_count(k)
        ));
    }
    put(
        &mut o,
        "Kernel event queue overflows seen by the watcher",
        "counter",
        "filedeck_events_overflows_total",
        bus.overflows().to_string(),
    );
    put(
        &mut o,
        "Reset events published or sent: subscribers had to look at everything again",
        "counter",
        "filedeck_events_resets_total",
        bus.resets().to_string(),
    );
    o.push_str("# HELP filedeck_events_subscribers Open event streams, by transport\n# TYPE filedeck_events_subscribers gauge\n");
    for (i, t) in Transport::ALL.iter().enumerate() {
        o.push_str(&format!(
            "filedeck_events_subscribers{{transport=\"{}\"}} {}\n",
            t.as_str(),
            subs[i]
        ));
    }
    put(
        &mut o,
        "Subscribers ended as lagged because they did not read fast enough",
        "counter",
        "filedeck_events_subscribers_dropped_total",
        bus.dropped_lagged().to_string(),
    );
    put(
        &mut o,
        "Events sent from the journal to subscribers that asked for a cursor",
        "counter",
        "filedeck_events_replayed_total",
        bus.replayed().to_string(),
    );
    put(
        &mut o,
        "1 when this process writes the journal and serves event streams",
        "gauge",
        "filedeck_events_serving",
        u8::from(j.serving).to_string(),
    );
    put(
        &mut o,
        "Bytes held by the event journal",
        "gauge",
        "filedeck_events_journal_bytes",
        j.bytes.to_string(),
    );
    put(
        &mut o,
        "Times the journal was opened and its last writer had not closed it cleanly: its epoch started again",
        "counter",
        "filedeck_events_journal_unclean_opens_total",
        j.unclean_opens.to_string(),
    );
    put(
        &mut o,
        "Age in seconds of the oldest event in the journal, 0 when empty",
        "gauge",
        "filedeck_events_journal_oldest_age_seconds",
        format!("{:.3}", j.oldest_age_ms as f64 / 1000.0),
    );
    put(
        &mut o,
        "Time the bus took to hand the latest events to the subscribers (decaying maximum)",
        "gauge",
        "filedeck_events_bus_lag_seconds",
        format!("{:.6}", bus.lag_ms() / 1000.0),
    );
    o
}
