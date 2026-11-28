//! The agent's own state: the event journal's folder, and the store files it keeps in the index folder (or, without one, in the temporary folder).
//! A write there must not become an event, else each write of the journal would be an event that is written to the journal.
//!
//! A name alone does not say that a path is the agent's own: a user may have a folder called `changes-<node>` somewhere else. So a path counts
//! only when the folder it names is the very same folder (device and inode) as the agent's own one. The check is made once for each candidate.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct OwnState {
    root: String,
    journal_dir: Option<PathBuf>,
    journal_name: Option<String>,
    state_dir: Option<PathBuf>,
    tmp_dir: PathBuf,
    node: String,
    pid: u32,
    verdicts: Mutex<HashMap<String, bool>>,
}

const MAX_CACHE: usize = 4096;

fn identity(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    m.is_dir().then(|| (m.dev(), m.ino()))
}

impl OwnState {
    /// `root`: the agent's root as the agent sees it (a virtual path is `root + path`).
    pub fn new(
        node: &str,
        root: &str,
        journal_dir: Option<&Path>,
        state_dir: Option<&Path>,
        tmp_dir: &Path,
    ) -> Self {
        Self {
            root: root.to_owned(),
            journal_dir: journal_dir.map(Path::to_path_buf),
            journal_name: journal_dir
                .and_then(Path::file_name)
                .map(|n| n.to_string_lossy().into_owned()),
            state_dir: state_dir.map(Path::to_path_buf),
            tmp_dir: tmp_dir.to_path_buf(),
            node: node.to_owned(),
            pid: std::process::id(),
            verdicts: Mutex::new(HashMap::new()),
        }
    }

    fn same(&self, prefix: &str, reference: &Path) -> bool {
        let key = format!("{}\0{prefix}", reference.display());
        {
            let m = self
                .verdicts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(v) = m.get(&key) {
                return *v;
            }
        }
        let real = if self.root == "/" {
            if prefix.is_empty() { "/".to_owned() } else { prefix.to_owned() }
        } else {
            format!("{}{prefix}", self.root)
        };
        let a = identity(Path::new(&real));
        let b = identity(reference);
        let v = a.is_some() && a == b;
        let mut m = self
            .verdicts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if m.len() >= MAX_CACHE {
            m.clear();
        }
        m.insert(key, v);
        v
    }

    fn store_file(&self, seg: &str) -> bool {
        ["index", "sizes", "jobs"]
            .iter()
            .any(|k| seg.starts_with(&format!("{k}-{}.db", self.node)))
    }

    fn spill_file(&self, seg: &str) -> bool {
        ["index", "sizes", "jobs"]
            .iter()
            .any(|k| seg.starts_with(&format!("filedeck-{k}-{}-", self.pid)))
    }

    /// Is this virtual path the agent's own state?
    pub fn is_own(&self, virtual_path: &str) -> bool {
        let segs: Vec<&str> = virtual_path.split('/').filter(|s| !s.is_empty()).collect();
        for (i, seg) in segs.iter().enumerate() {
            let prefix = format!("/{}", segs[..i].join("/"));
            let up_to = format!("/{}", segs[..=i].join("/"));
            if let (Some(name), Some(dir)) = (&self.journal_name, &self.journal_dir)
                && seg == name
                && self.same(&up_to, dir)
            {
                return true;
            }
            if i == segs.len() - 1 {
                let parent = if prefix == "/" { String::new() } else { prefix };
                if let Some(sd) = &self.state_dir
                    && self.store_file(seg)
                    && self.same(&parent, sd)
                {
                    return true;
                }
                if self.spill_file(seg) && self.same(&parent, &self.tmp_dir) {
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_very_same_folder_counts() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let state = root.join("state");
        std::fs::create_dir_all(state.join("changes-n")).unwrap();
        std::fs::create_dir_all(root.join("user/changes-n")).unwrap();
        let o = OwnState::new(
            "n",
            root.to_str().unwrap(),
            Some(&state.join("changes-n")),
            Some(&state),
            Path::new("/nonexistent-tmp"),
        );
        assert!(o.is_own("/state/changes-n"));
        assert!(o.is_own("/state/changes-n/seg-000000000000001.jsonl"));
        assert!(!o.is_own("/user/changes-n/x"), "a folder of that name elsewhere is not ours");
        assert!(o.is_own("/state/sizes-n.db"));
        assert!(o.is_own("/state/sizes-n.db-wal"));
        assert!(!o.is_own("/user/sizes-n.db"));
        assert!(!o.is_own("/state/other.txt"));
    }
}
