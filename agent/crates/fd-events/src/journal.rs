//! The event journal of one agent: a bounded, append-only record of the encoded event lines, so a subscriber that was away can read what it
//! missed. Lines are kept as they were sent (JSON, one per line, the cursor first), in segment files `seg-<first seq>.jsonl` next to a
//! `meta.json` that holds the epoch. Whole segments are removed from the old end when the journal is older than `max_age_ms` or larger than
//! `max_bytes`. The last events are also kept in memory (the ring), so a client that is close behind reads no file.
//!
//! Every event is written to the file when it is committed: there is no flush timer. A journal opens clean only when its last writer closed
//! it (`meta.json` says `clean`); a crash, a failed write or a lost lease starts a new epoch, so a restart never continues an epoch from a disk
//! that is behind what readers were told. Without a folder the journal lives in memory, with a new epoch at every start.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use bytes::Bytes;
use serde_json::json;

use crate::cursor::format_cursor;
use crate::types::line_seq;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gap {
    Epoch,
    Old,
    Future,
    Lost,
}

impl Gap {
    pub fn why(self) -> &'static str {
        match self {
            Gap::Epoch => "epoch",
            Gap::Old => "old",
            Gap::Future => "future",
            Gap::Lost => "lost",
        }
    }
}

#[derive(Debug, Clone)]
pub struct JournalOptions {
    /// where the segments live; `None` = memory only
    pub dir: Option<PathBuf>,
    pub node: String,
    /// keep at most this many bytes on disk (default 2 GiB)
    pub max_bytes: u64,
    /// drop segments whose last event is older than this (default 24 h)
    pub max_age_ms: i64,
    /// a segment is closed once it holds this many bytes (default: a quarter of the limit, at most 64 MiB)
    pub segment_bytes: u64,
    /// events kept in memory and their bytes
    pub ring_events: usize,
    pub ring_bytes: usize,
}

impl JournalOptions {
    pub fn new(node: impl Into<String>, dir: Option<PathBuf>) -> Self {
        let max_bytes: u64 = 2 * 1024 * 1024 * 1024;
        Self {
            dir,
            node: node.into(),
            max_bytes,
            max_age_ms: 24 * 3_600_000,
            segment_bytes: (max_bytes / 4).clamp(4096, 64 * 1024 * 1024),
            ring_events: 8192,
            ring_bytes: 8 * 1024 * 1024,
        }
    }

    pub fn with_limits(mut self, max_bytes: u64, max_age_ms: i64) -> Self {
        self.max_bytes = max_bytes;
        self.max_age_ms = max_age_ms;
        self.segment_bytes = (max_bytes / 4).clamp(4096, 64 * 1024 * 1024);
        self
    }
}

#[derive(Debug, Clone)]
struct Segment {
    first: u64,
    last: u64,
    bytes: u64,
    last_time: i64,
    first_time: i64,
    file: PathBuf,
}

fn seg_name(first: u64) -> String {
    format!("seg-{first:015}.jsonl")
}

fn parse_seg(name: &str) -> Option<u64> {
    let n = name.strip_prefix("seg-")?.strip_suffix(".jsonl")?;
    (n.len() == 15 && n.bytes().all(|c| c.is_ascii_digit())).then(|| n.parse().ok())?
}

pub fn new_epoch() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut r = [0u8; 2];
    if let Ok(mut f) = File::open("/dev/urandom") {
        let _ = f.read_exact(&mut r);
    }
    format!("{}{:02x}{:02x}", to_base36(t), r[0], r[1])
}

fn to_base36(mut n: u128) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut v = Vec::new();
    while n > 0 {
        v.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).unwrap_or_default()
}

pub struct Journal {
    o: JournalOptions,
    pub epoch: String,
    seq: u64,
    segs: Vec<Segment>,
    ring: VecDeque<(u64, i64, Bytes)>,
    ring_bytes: usize,
    fh: Option<File>,
    opened: bool,
    failed: bool,
    closed: bool,
    /// times `open` found a journal that its last writer had not closed cleanly
    pub unclean_opens: u64,
    pub appended: u64,
    /// the journal continued an earlier run that ended clean
    pub continued: bool,
    last_time_seen: i64,
}

fn io_err(e: &std::io::Error) -> String {
    e.to_string()
}

impl Journal {
    pub fn new(o: JournalOptions) -> Self {
        Self {
            o,
            epoch: new_epoch(),
            seq: 0,
            segs: Vec::new(),
            ring: VecDeque::new(),
            ring_bytes: 0,
            fh: None,
            opened: false,
            failed: false,
            closed: false,
            unclean_opens: 0,
            appended: 0,
            continued: false,
            last_time_seen: 0,
        }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.o.dir.as_deref()
    }

    /// The newest sequence number (0 = none yet).
    pub fn head(&self) -> u64 {
        self.seq
    }

    /// The oldest sequence number a reader can still get (head + 1 when the journal is empty).
    pub fn oldest(&self) -> u64 {
        if let Some(s) = self.segs.first() {
            return s.first;
        }
        self.ring.front().map_or(self.seq + 1, |r| r.0)
    }

    /// Time of the newest event on disk or in the ring (0 = none).
    pub fn last_time(&self) -> i64 {
        self.last_time_seen
            .max(self.ring.back().map_or(0, |r| r.1))
            .max(self.segs.last().map_or(0, |s| s.last_time))
    }

    pub fn bytes(&self) -> u64 {
        self.segs.iter().map(|s| s.bytes).sum()
    }

    /// Age in ms of the oldest event still held (0 = none).
    pub fn oldest_age_ms(&self, now: i64) -> i64 {
        let t = self
            .segs
            .first()
            .map(|s| s.first_time)
            .filter(|t| *t != 0)
            .or_else(|| self.ring.front().map(|r| r.1))
            .unwrap_or(0);
        if t == 0 { 0 } else { (now - t).max(0) }
    }

    /// false when the folder could not be used: the journal then lives in memory only
    pub fn persistent(&self) -> bool {
        self.o.dir.is_some() && !self.failed
    }

    pub fn cursor_of(&self, seq: u64) -> String {
        format_cursor(&self.o.node, &self.epoch, seq)
    }

    /// Read what is on disk: the epoch, the segments and where the sequence continues. A folder that cannot be used leaves the journal in memory.
    pub fn open(&mut self) {
        if self.opened {
            return;
        }
        self.opened = true;
        let Some(dir) = self.o.dir.clone() else {
            return;
        };
        if let Err(e) = self.open_dir(&dir) {
            self.failed = true;
            self.segs.clear();
            self.seq = 0;
            self.epoch = new_epoch();
            eprintln!(
                "event journal: {} cannot be used ({e}); events are kept in memory only",
                dir.display()
            );
        }
    }

    fn open_dir(&mut self, dir: &Path) -> Result<(), String> {
        make_private_dir(dir).map_err(|e| io_err(&e))?;
        let mut names: Vec<(u64, String)> = fs::read_dir(dir)
            .map_err(|e| io_err(&e))?
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                parse_seg(&n).map(|s| (s, n))
            })
            .collect();
        names.sort();
        let mut epoch = String::new();
        let mut clean = false;
        if let Ok(text) = fs::read_to_string(dir.join("meta.json"))
            && let Ok(m) = serde_json::from_str::<serde_json::Value>(&text)
        {
            if let Some(e) = m["epoch"].as_str()
                && (1..=16).contains(&e.len())
                && e.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
                && m["node"].as_str() == Some(self.o.node.as_str())
            {
                epoch = e.to_owned();
            }
            clean = m["clean"].as_bool() == Some(true);
            if !clean {
                self.unclean_opens += 1;
            }
        }
        let mut segs: Vec<Segment> = Vec::new();
        for (first, n) in &names {
            let file = dir.join(n);
            let st = fs::metadata(&file).map_err(|e| io_err(&e))?;
            segs.push(Segment {
                first: *first,
                last: first.saturating_sub(1),
                bytes: st.len(),
                last_time: 0,
                first_time: 0,
                file,
            });
        }
        let mut ok = !epoch.is_empty() && clean && !segs.is_empty();
        if ok && let Some(last) = segs.last_mut() {
            ok = scan_tail(last).unwrap_or(false);
        }
        if ok {
            for i in 0..segs.len().saturating_sub(1) {
                segs[i].last = segs[i + 1].first - 1;
            }
            self.seq = segs.last().map_or(0, |s| s.last);
            self.last_time_seen = segs.last().map_or(0, |s| s.last_time);
            self.epoch = epoch;
            self.continued = true;
            if let Some(f) = segs.first_mut() {
                f.first_time = first_time_of(&f.file);
            }
            self.segs = segs;
        } else {
            // not stopped cleanly, lost or damaged: nothing on disk is trusted, the epoch changes, and old cursors get a reset
            for s in &segs {
                let _ = fs::remove_file(&s.file);
            }
            self.segs.clear();
            self.seq = 0;
            self.epoch = new_epoch();
            self.continued = false;
        }
        // the clean mark is cleared while this process writes
        self.write_meta(false).map_err(|e| io_err(&e))
    }

    fn write_meta(&self, clean: bool) -> std::io::Result<()> {
        let Some(dir) = &self.o.dir else {
            return Ok(());
        };
        let tmp = dir.join(format!("meta.json.{}.{}", std::process::id(), new_epoch()));
        let body = json!({"epoch": self.epoch, "node": self.o.node, "clean": clean, "covered": now_ms()}).to_string();
        let r = (|| {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode_private()
                .open(&tmp)?;
            f.write_all(body.as_bytes())?;
            fs::rename(&tmp, dir.join("meta.json"))
        })();
        if r.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        r
    }

    /// The cursor and sequence the next event gets.
    pub fn next(&self) -> (u64, String) {
        let seq = self.seq + 1;
        (seq, format_cursor(&self.o.node, &self.epoch, seq))
    }

    /// Keep events (the lines the bus encoded with `next()`'s cursors), in order. Written to the file at once.
    pub fn write_batch(&mut self, items: &[(u64, i64, Bytes)]) {
        if items.is_empty() {
            return;
        }
        for (seq, time, line) in items {
            debug_assert_eq!(*seq, self.seq + 1, "journal: events must be written in order");
            self.seq = *seq;
            self.appended += 1;
            self.ring.push_back((*seq, *time, line.clone()));
            self.ring_bytes += line.len();
            while self.ring.len() > self.o.ring_events || self.ring_bytes > self.o.ring_bytes {
                match self.ring.pop_front() {
                    Some(r) => self.ring_bytes -= r.2.len(),
                    None => break,
                }
            }
        }
        if !self.persistent() || self.closed {
            return;
        }
        if let Err(e) = self.append(items) {
            self.failed = true;
            eprintln!(
                "event journal: writing failed ({e}); events are kept in memory only from now on"
            );
        }
    }

    fn append(&mut self, items: &[(u64, i64, Bytes)]) -> std::io::Result<()> {
        let Some(dir) = self.o.dir.clone() else {
            return Ok(());
        };
        let first = items[0].0;
        let last = items[items.len() - 1].0;
        let last_time = items[items.len() - 1].1;
        let data: Vec<u8> = items.iter().flat_map(|i| i.2.iter().copied()).collect();
        let need_new = self.segs.last().is_none_or(|s| s.bytes >= self.o.segment_bytes);
        if need_new {
            self.fh = None;
            let file = dir.join(seg_name(first));
            let f = OpenOptions::new()
                .append(true)
                .create(true)
                .mode_private()
                .open(&file)?;
            self.fh = Some(f);
            self.segs.push(Segment {
                first,
                last: first - 1,
                bytes: 0,
                last_time,
                first_time: items[0].1,
                file,
            });
        } else if self.fh.is_none()
            && let Some(cur) = self.segs.last()
        {
            // the first write after open continues the last segment
            self.fh = Some(OpenOptions::new().append(true).open(&cur.file)?);
        }
        if let Some(f) = self.fh.as_mut() {
            f.write_all(&data)?;
        }
        if let Some(cur) = self.segs.last_mut() {
            cur.bytes += data.len() as u64;
            cur.last = last;
            cur.last_time = last_time;
            if cur.first_time == 0 {
                cur.first_time = items[0].1;
            }
        }
        if need_new {
            self.trim();
        }
        Ok(())
    }

    fn trim(&mut self) {
        let now = now_ms();
        while self.segs.len() > 1 {
            let total: u64 = self.segs.iter().map(|s| s.bytes).sum();
            let s = &self.segs[0];
            if total <= self.o.max_bytes && s.last_time >= now - self.o.max_age_ms {
                break;
            }
            let s = self.segs.remove(0);
            let _ = fs::remove_file(&s.file);
        }
    }

    /// Can a reader holding `since` continue from here? Else why not.
    pub fn check(&self, epoch: &str, seq: u64) -> Option<Gap> {
        if epoch != self.epoch {
            return Some(Gap::Epoch);
        }
        if seq > self.seq {
            return Some(Gap::Future);
        }
        if seq + 1 < self.oldest() {
            return Some(Gap::Old);
        }
        None
    }

    /// A copy of what a reader needs to read the lines above `after` up to `up_to` without the journal's lock.
    pub fn plan(&self, after: u64, up_to: u64) -> Result<ReadPlan, Gap> {
        if after >= up_to {
            return Ok(ReadPlan::Lines(Vec::new()));
        }
        if let Some(r0) = self.ring.front()
            && after + 1 >= r0.0
        {
            let first = usize::try_from(after + 1 - r0.0).unwrap_or(0);
            let end = usize::try_from(up_to + 1 - r0.0).unwrap_or(0).min(self.ring.len());
            let lines: Vec<(u64, Bytes)> = self
                .ring
                .iter()
                .skip(first)
                .take(end.saturating_sub(first))
                .map(|r| (r.0, r.2.clone()))
                .collect();
            // the ring is in order: a hole cannot happen, and it is never passed on silently
            if lines.iter().zip(after + 1..).any(|((s, _), e)| *s != e) {
                return Err(Gap::Lost);
            }
            return Ok(ReadPlan::Lines(lines));
        }
        if !self.persistent() {
            return Err(Gap::Old);
        }
        if after + 1 < self.oldest() {
            return Err(Gap::Old);
        }
        Ok(ReadPlan::Files(
            self.segs
                .iter()
                .filter(|s| s.last > after)
                .map(|s| (s.first, s.last, s.file.clone()))
                .collect(),
        ))
    }

    /// Close the file. A journal that wrote every event notes `clean` in `meta.json`, so the next process continues its epoch.
    /// With `remove`, delete the journal's folder (a journal made in a temporary place).
    pub fn close(&mut self, remove: bool) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.fh = None;
        if self.opened && self.persistent() && !remove {
            let _ = self.write_meta(true);
        }
        if remove && let Some(d) = &self.o.dir {
            let _ = fs::remove_dir_all(d);
        }
    }
}

/// What to read, copied out of the journal.
pub enum ReadPlan {
    Lines(Vec<(u64, Bytes)>),
    /// segments that may hold the lines: (first, last, file)
    Files(Vec<(u64, u64, PathBuf)>),
}

/// Read the lines of `plan` above `after` up to `up_to`, as chunks of whole lines. A segment that is gone is a gap.
pub fn read_chunks(
    plan: ReadPlan,
    after: u64,
    up_to: u64,
    mut emit: impl FnMut(Vec<Bytes>) -> bool,
) -> Result<(), Gap> {
    const CHUNK: usize = 256 * 1024;
    match plan {
        ReadPlan::Lines(lines) => {
            let mut batch = Vec::new();
            let mut n = 0usize;
            for (_, line) in lines {
                n += line.len();
                batch.push(line);
                if n >= CHUNK {
                    if !emit(std::mem::take(&mut batch)) {
                        return Ok(());
                    }
                    n = 0;
                }
            }
            if !batch.is_empty() {
                emit(batch);
            }
            Ok(())
        }
        ReadPlan::Files(segs) => {
            let mut expect = after + 1;
            for (first, last, file) in segs {
                if last < expect {
                    continue;
                }
                if first > expect {
                    return Err(Gap::Lost);
                }
                let mut f = File::open(&file).map_err(|_| Gap::Lost)?;
                let mut carry: Vec<u8> = Vec::new();
                let mut buf = vec![0u8; CHUNK];
                loop {
                    let n = f.read(&mut buf).map_err(|_| Gap::Lost)?;
                    if n == 0 {
                        break;
                    }
                    let mut chunk = std::mem::take(&mut carry);
                    chunk.extend_from_slice(&buf[..n]);
                    let Some(nl) = chunk.iter().rposition(|b| *b == b'\n') else {
                        carry = chunk;
                        continue;
                    };
                    carry = chunk[nl + 1..].to_vec();
                    chunk.truncate(nl + 1);
                    let mut lines: Vec<Bytes> = Vec::new();
                    let mut stop = false;
                    for l in chunk.split_inclusive(|b| *b == b'\n') {
                        let s = line_seq(l).unwrap_or(0);
                        if s <= after {
                            continue;
                        }
                        if s > up_to {
                            stop = true;
                            break;
                        }
                        lines.push(Bytes::copy_from_slice(l));
                    }
                    if !lines.is_empty() && !emit(lines) {
                        return Ok(());
                    }
                    if stop {
                        return Ok(());
                    }
                }
                expect = last + 1;
            }
            Ok(())
        }
    }
}

/// Last complete line of a segment: sets its `last` and `last_time`, cuts a partial line. False when the segment holds nothing readable.
fn scan_tail(s: &mut Segment) -> std::io::Result<bool> {
    let mut f = OpenOptions::new().read(true).write(true).open(&s.file)?;
    let size = f.metadata()?.len();
    if size == 0 {
        return Ok(false);
    }
    let len = size.min(128 * 1024);
    let mut buf = vec![0u8; usize::try_from(len).unwrap_or(0)];
    f.seek(SeekFrom::Start(size - len))?;
    f.read_exact(&mut buf)?;
    let Some(nl) = buf.iter().rposition(|b| *b == b'\n') else {
        return Ok(false);
    };
    if nl != buf.len() - 1 {
        let keep = size - len + nl as u64 + 1;
        f.set_len(keep)?;
        s.bytes = keep;
    }
    let start = buf[..nl].iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let last = &buf[start..nl];
    let Some(seq) = line_seq(last) else {
        return Ok(false);
    };
    if seq < s.first {
        return Ok(false);
    }
    s.last = seq;
    match serde_json::from_slice::<serde_json::Value>(last) {
        Ok(v) => {
            s.last_time = v["time"].as_i64().unwrap_or(0);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

fn first_time_of(file: &Path) -> i64 {
    let Ok(mut f) = File::open(file) else {
        return 0;
    };
    let mut buf = vec![0u8; 8192];
    let n = f.read(&mut buf).unwrap_or(0);
    let Some(nl) = buf[..n].iter().position(|b| *b == b'\n') else {
        return 0;
    };
    serde_json::from_slice::<serde_json::Value>(&buf[..nl])
        .ok()
        .and_then(|v| v["time"].as_i64())
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

trait PrivateMode {
    fn mode_private(&mut self) -> &mut Self;
}

impl PrivateMode for OpenOptions {
    fn mode_private(&mut self) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.mode(0o600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(node: &str, epoch: &str, seq: u64, time: i64) -> Bytes {
        Bytes::from(format!(
            "{{\"cursor\":\"{node}:{epoch}:{seq}\",\"time\":{time},\"node\":\"{node}\",\"kind\":\"create\",\"dir\":false,\"path\":\"/f{seq}\"}}\n"
        ))
    }

    fn put(j: &mut Journal, n: u64) {
        for _ in 0..n {
            let (seq, _) = j.next();
            let l = line("n", &j.epoch, seq, now_ms());
            j.write_batch(&[(seq, now_ms(), l)]);
        }
    }

    fn all(j: &Journal, after: u64) -> Result<Vec<u64>, Gap> {
        let plan = j.plan(after, j.head())?;
        let mut out = Vec::new();
        read_chunks(plan, after, j.head(), |c| {
            for l in c {
                out.push(line_seq(&l).unwrap());
            }
            true
        })?;
        Ok(out)
    }

    #[test]
    fn lines_survive_a_clean_restart_with_the_same_epoch() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("changes-n");
        let mut j = Journal::new(JournalOptions::new("n", Some(dir.clone())));
        j.open();
        put(&mut j, 5);
        let epoch = j.epoch.clone();
        j.close(false);
        let mut k = Journal::new(JournalOptions::new("n", Some(dir)));
        k.open();
        assert_eq!(k.epoch, epoch);
        assert!(k.continued);
        assert_eq!(k.head(), 5);
        put(&mut k, 2);
        assert_eq!(k.head(), 7);
        // read from the files: a fresh journal has an empty ring
        let mut m = Journal::new(k.o.clone());
        k.close(false);
        m.open();
        assert_eq!(all(&m, 2).unwrap(), vec![3, 4, 5, 6, 7]);
    }

    #[test]
    fn a_journal_that_was_not_closed_starts_a_new_epoch() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("c");
        let mut j = Journal::new(JournalOptions::new("n", Some(dir.clone())));
        j.open();
        put(&mut j, 3);
        let epoch = j.epoch.clone();
        drop(j); // a crash: no close
        let mut k = Journal::new(JournalOptions::new("n", Some(dir)));
        k.open();
        assert_ne!(k.epoch, epoch);
        assert_eq!(k.head(), 0);
        assert_eq!(k.unclean_opens, 1);
        assert!(!k.continued);
    }

    #[test]
    fn a_half_written_last_line_is_cut_off() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("c");
        let mut j = Journal::new(JournalOptions::new("n", Some(dir.clone())));
        j.open();
        put(&mut j, 3);
        j.close(false);
        let seg = fs::read_dir(&dir).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("seg-")).unwrap().path();
        let mut f = OpenOptions::new().append(true).open(&seg).unwrap();
        f.write_all(b"{\"cursor\":\"n:x:4\",\"tim").unwrap();
        let mut k = Journal::new(JournalOptions::new("n", Some(dir)));
        k.open();
        assert_eq!(k.head(), 3);
    }

    #[test]
    fn segments_rotate_and_the_oldest_go_by_size_and_a_cursor_older_than_that_is_a_gap() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("c");
        let mut o = JournalOptions::new("n", Some(dir)).with_limits(16 * 1024, 3_600_000);
        o.segment_bytes = 4096;
        o.ring_events = 4;
        let mut j = Journal::new(o);
        j.open();
        put(&mut j, 400);
        assert!(j.bytes() <= 16 * 1024 + 4096 + 200, "{}", j.bytes());
        assert!(j.oldest() > 1);
        assert_eq!(j.check(&j.epoch, 1), Some(Gap::Old));
        assert_eq!(j.check(&j.epoch, 9999), Some(Gap::Future));
        assert_eq!(j.check("other", 3), Some(Gap::Epoch));
        let from = j.oldest() - 1;
        assert!(j.check(&j.epoch, from).is_none());
        let got = all(&j, from).unwrap();
        assert_eq!(got.first(), Some(&j.oldest()));
        assert_eq!(got.last(), Some(&400));
        assert_eq!(got.len() as u64, 400 - from);
    }

    #[test]
    fn memory_only_journals_read_from_the_ring() {
        let mut j = Journal::new(JournalOptions::new("n", None));
        j.open();
        put(&mut j, 10);
        assert_eq!(all(&j, 4).unwrap(), vec![5, 6, 7, 8, 9, 10]);
        assert_eq!(all(&j, 10).unwrap(), Vec::<u64>::new());
        let mut o = JournalOptions::new("n", None);
        o.ring_events = 3;
        let mut s = Journal::new(o);
        put(&mut s, 10);
        assert!(s.plan(2, 10).is_err());
        assert!(s.check(&s.epoch, 2).is_some());
    }
}
