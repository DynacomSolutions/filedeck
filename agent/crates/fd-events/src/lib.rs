//! The change events of the FileDeck agent: types, filters, the journal, the bus and the Unix socket.
//!
//! This is the Rust port of `server/src/events/*` and `docs/change-events.md`. No timer runs here: a subscriber arms one `ping` deadline while it waits.
#![forbid(unsafe_code)]

mod bus;
mod cursor;
mod error;
mod filter;
mod glob;
mod journal;
mod labels;
mod metrics;
mod own_state;
mod socket;
mod types;

pub use bus::{Bus, BusOptions, JournalStatus, Subscriber, Transport};
pub use cursor::{Cursor, format_cursor, parse_cursor};
pub use error::EventError;
pub use filter::{Filter, FilterSpec, filter_from_pairs};
pub use glob::{Matcher, Verdict, compile_globs};
pub use journal::{Gap, Journal, JournalOptions, new_epoch, now_ms};
pub use labels::LabelRules;
pub use metrics::event_metrics;
pub use own_state::OwnState;
pub use socket::{EventSocket, SocketOptions, start_event_socket};
pub use types::{
    Encoded, Kind, Labels, Matchable, NewEvent, Scope, Window, encode_event, lagged_line,
    line_seq, ping_line,
};
