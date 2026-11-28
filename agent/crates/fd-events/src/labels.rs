//! Labels from path templates. A template is a path whose segments are either text (must match exactly) or `{name}` (matches any one segment
//! and gives it to the label `name`): `/srv/repos/{org}/{repo}`. A path below the template's depth gets the labels of every folder level it
//! passes. Matching is by whole segments, never by a regular expression. When several templates match, the one with the most text segments
//! wins; on a tie, the first one written.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::types::Labels;

struct Template {
    text: Vec<Option<String>>,
    names: Vec<Option<String>>,
    literals: usize,
}

const MAX_TEMPLATES: usize = 64;
const MAX_SEGMENTS: usize = 16;
const CACHE_MAX: usize = 20_000;

pub struct LabelRules {
    templates: Vec<Template>,
    depth: usize,
    cache: Mutex<HashMap<String, Option<Labels>>>,
}

impl Default for LabelRules {
    fn default() -> Self {
        Self {
            templates: Vec::new(),
            depth: 0,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

fn valid_name(n: &str) -> bool {
    let mut it = n.chars();
    let Some(f) = it.next() else {
        return false;
    };
    n.len() <= 32
        && f.is_ascii_alphabetic()
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl LabelRules {
    /// `spec`: templates separated by a line feed, a semicolon or a comma. An error names a bad template (so a typo is seen at start-up).
    pub fn new(spec: &str) -> Result<Self, String> {
        let list: Vec<&str> = spec
            .split(['\n', ';', ','])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if list.len() > MAX_TEMPLATES {
            return Err(format!("at most {MAX_TEMPLATES} label templates"));
        }
        let mut me = Self::default();
        for raw in list {
            if !raw.starts_with('/') {
                return Err(format!("label template must start with \"/\": {raw}"));
            }
            let segs: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
            if segs.is_empty() || segs.len() > MAX_SEGMENTS {
                return Err(format!(
                    "label template has 1 to {MAX_SEGMENTS} segments: {raw}"
                ));
            }
            let mut t = Template {
                text: Vec::new(),
                names: Vec::new(),
                literals: 0,
            };
            let mut seen: Vec<&str> = Vec::new();
            for s in &segs {
                if let Some(inner) = s.strip_prefix('{').and_then(|x| x.strip_suffix('}'))
                    && !inner.contains(['{', '}'])
                {
                    if !valid_name(inner) || seen.contains(&inner) {
                        return Err(format!("bad or repeated label name in template: {raw}"));
                    }
                    seen.push(inner);
                    t.text.push(None);
                    t.names.push(Some(inner.to_owned()));
                } else {
                    if s.contains(['{', '}']) {
                        return Err(format!("a label name takes a whole segment: {raw}"));
                    }
                    t.text.push(Some((*s).to_owned()));
                    t.names.push(None);
                    t.literals += 1;
                }
            }
            me.depth = me.depth.max(segs.len());
            me.templates.push(t);
        }
        Ok(me)
    }

    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }

    /// The labels of a virtual path, or `None`.
    pub fn labels(&self, p: &str) -> Option<Labels> {
        if self.templates.is_empty() {
            return None;
        }
        // the first `depth` segments of the path decide, so they are the cache key
        let mut end = 1usize;
        let mut cut = None;
        for _ in 0..self.depth {
            match p.get(end..).and_then(|r| r.find('/')) {
                Some(i) => end += i + 1,
                None => {
                    cut = Some(p.len());
                    break;
                }
            }
        }
        let head = match cut {
            Some(n) => &p[..n],
            None => &p[..end - 1],
        };
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(hit) = cache.get(head) {
            return hit.clone();
        }
        let r = self.compute(head);
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(head.to_owned(), r.clone());
        r
    }

    fn compute(&self, head: &str) -> Option<Labels> {
        let segs: Vec<&str> = head.split('/').filter(|s| !s.is_empty()).collect();
        let mut best: Option<&Template> = None;
        for t in &self.templates {
            if segs.len() < t.text.len() {
                continue;
            }
            let ok = t
                .text
                .iter()
                .zip(&segs)
                .all(|(want, got)| want.as_deref().is_none_or(|w| w == *got));
            if ok && best.is_none_or(|b| t.literals > b.literals) {
                best = Some(t);
            }
        }
        let t = best?;
        let mut out = Map::new();
        for (i, n) in t.names.iter().enumerate() {
            if let Some(n) = n {
                out.insert(n.clone(), Value::String(segs[i].to_owned()));
            }
        }
        Some(Arc::new(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_only_the_most_specific_template_wins_the_first_of_equals() {
        let r = LabelRules::new("/srv/repos/{org}/{repo}\n/srv/repos/.worktrees/{org}/{task}/{repo}").unwrap();
        let l = r.labels("/srv/repos/acme/app/src/x.rs").unwrap();
        assert_eq!(l["org"], "acme");
        assert_eq!(l["repo"], "app");
        let w = r.labels("/srv/repos/.worktrees/acme/t1/app/f").unwrap();
        assert_eq!(w["task"], "t1");
        assert_eq!(w["repo"], "app");
        assert!(r.labels("/elsewhere/x").is_none());
        assert!(r.labels("/srv/repos").is_none(), "shorter than the template");
        let tie = LabelRules::new("/a/{x}, /a/{y}").unwrap();
        assert!(tie.labels("/a/1").unwrap().contains_key("x"));
    }

    #[test]
    fn a_bad_template_is_refused() {
        for s in ["rel/{a}", "/a/{1bad}", "/a/{x}/{x}", "/a/b{c}", "/", "/a/{}"] {
            assert!(LabelRules::new(s).is_err(), "{s}");
        }
        assert!(LabelRules::new("").unwrap().is_empty());
    }
}
