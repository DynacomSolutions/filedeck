//! Scans of overlapping folders run one after the other, in the order they asked. A scan of a folder waits for the
//! scans of the folders above it and below it, and for one of the same folder. Scans of folders that do not overlap
//! run side by side.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use fd_store::overlaps;
use tokio::sync::oneshot;

struct Entry {
    id: u64,
    path: String,
    granted: bool,
    since: Instant,
    wake: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Entry>,
    next_id: u64,
    /// grants so far: a scan that was granted while an answer was read makes that answer stale
    grants: u64,
    /// the latest grants, newest last (bounded)
    recent: VecDeque<(u64, String)>,
}

#[derive(Default)]
pub struct Locks {
    state: Mutex<State>,
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A place in the line. Await `ready`; dropping the guard lets go of the place, granted or not.
pub struct Guard {
    locks: Arc<Locks>,
    id: u64,
    rx: Option<oneshot::Receiver<()>>,
}

impl Guard {
    /// Resolves when the lock is granted.
    pub async fn ready(&mut self) {
        if let Some(rx) = self.rx.take() {
            let _ = rx.await;
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.locks.release(self.id);
    }
}

impl Locks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Take a place for `path`. The lock is granted at once when nothing ahead overlaps it.
    pub fn request(self: &Arc<Self>, path: &str) -> Guard {
        let mut s = lock(&self.state);
        let id = s.next_id;
        s.next_id += 1;
        let free = !s.queue.iter().any(|e| overlaps(&e.path, path));
        let (tx, rx) = oneshot::channel();
        let mut entry = Entry {
            id,
            path: path.to_owned(),
            granted: free,
            since: Instant::now(),
            wake: None,
        };
        if free {
            s.grants += 1;
            let g = s.grants;
            s.recent.push_back((g, path.to_owned()));
            if s.recent.len() > 1024 {
                s.recent.pop_front();
            }
        } else {
            entry.wake = Some(tx);
        }
        s.queue.push_back(entry);
        Guard {
            locks: Arc::clone(self),
            id,
            rx: (!free).then_some(rx),
        }
    }

    fn release(&self, id: u64) {
        let mut s = lock(&self.state);
        s.queue.retain(|e| e.id != id);
        // grant every waiting entry that has nothing overlapping ahead of it
        let mut i = 0;
        while i < s.queue.len() {
            if !s.queue[i].granted {
                let p = s.queue[i].path.clone();
                let blocked = s.queue.iter().take(i).any(|e| overlaps(&e.path, &p));
                if !blocked {
                    s.queue[i].granted = true;
                    s.grants += 1;
                    let g = s.grants;
                    s.recent.push_back((g, p));
                    if s.recent.len() > 1024 {
                        s.recent.pop_front();
                    }
                    if let Some(w) = s.queue[i].wake.take() {
                        let _ = w.send(());
                    }
                }
            }
            i += 1;
        }
    }

    /// Age in seconds of the oldest lock that waits and is not granted yet (0 when none).
    pub fn oldest_wait_seconds(&self) -> f64 {
        let s = lock(&self.state);
        s.queue
            .iter()
            .filter(|e| !e.granted)
            .map(|e| e.since.elapsed().as_secs_f64())
            .fold(0.0, f64::max)
    }

    /// A number that grows with every grant.
    pub fn mark(&self) -> u64 {
        lock(&self.state).grants
    }

    /// A scan of a folder that overlaps `path` holds a lock now, or was granted after `mark`.
    pub fn busy_since(&self, path: &str, mark: u64) -> bool {
        let s = lock(&self.state);
        s.queue.iter().any(|e| e.granted && overlaps(&e.path, path))
            || s.recent.iter().any(|(g, p)| *g > mark && overlaps(p, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn overlapping_requests_wait_in_line_and_others_go_beside() {
        let l = Locks::new();
        let mut a = l.request("/x");
        a.ready().await;
        let mut b = l.request("/x/y");
        let mut c = l.request("/z");
        c.ready().await;
        assert!(l.oldest_wait_seconds() >= 0.0);
        let waiting = tokio::time::timeout(std::time::Duration::from_millis(30), b.ready()).await;
        assert!(waiting.is_err(), "b waits for a");
        drop(a);
        tokio::time::timeout(std::time::Duration::from_secs(2), b.ready())
            .await
            .unwrap();
        assert!(l.busy_since("/x", u64::MAX));
        drop(b);
        assert!(!l.busy_since("/x", u64::MAX));
    }
}
