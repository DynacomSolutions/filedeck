//! A cursor names one place in one agent's event journal: `<node>:<epoch>:<seq>`. The epoch changes when the journal is lost or started over
//! (its sequence numbers then mean nothing to a client that holds an older epoch). The node name may hold ":", so a cursor is read from the right.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub node: String,
    pub epoch: String,
    pub seq: u64,
}

pub fn format_cursor(node: &str, epoch: &str, seq: u64) -> String {
    format!("{node}:{epoch}:{seq}")
}

pub fn parse_cursor(s: &str) -> Option<Cursor> {
    if s.len() > 300 {
        return None;
    }
    let b = s.rfind(':')?;
    let a = s[..b].rfind(':')?;
    if a == 0 {
        return None;
    }
    let seq = &s[b + 1..];
    let epoch = &s[a + 1..b];
    let digits = (1..=15).contains(&seq.len()) && seq.bytes().all(|c| c.is_ascii_digit());
    let word = (1..=16).contains(&epoch.len())
        && epoch
            .bytes()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
    if !digits || !word {
        return None;
    }
    Some(Cursor {
        node: s[..a].to_owned(),
        epoch: epoch.to_owned(),
        seq: seq.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_from_the_right() {
        assert_eq!(format_cursor("n1", "ab12", 7), "n1:ab12:7");
        let c = parse_cursor("a:b:c:ab12:7").unwrap();
        assert_eq!((c.node.as_str(), c.epoch.as_str(), c.seq), ("a:b:c", "ab12", 7));
    }

    #[test]
    fn nonsense_is_refused() {
        for s in ["", "x", "x:y", ":a:1", "n:ab:", "n:AB:1", "n:ab:1x", "n::1", "n:ab:1234567890123456"] {
            assert!(parse_cursor(s).is_none(), "{s}");
        }
        assert!(parse_cursor(&format!("{}:ab:1", "n".repeat(400))).is_none());
    }
}
