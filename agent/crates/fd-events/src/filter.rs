//! A subscriber's filter, evaluated in the agent before any byte is sent. Every part is optional; an event passes when it passes all parts
//! that are given (a part with several values passes when any one value matches, except `label`, which needs every key to match).
//!  - `prefix`: the event's path (or, for a move, the path it came from) is the prefix or is below it
//!  - `glob`: the event's path (or its old path) matches one of the globs
//!  - `kind`: one of the kinds
//!  - `type`: `file` or `dir`
//!  - `label`: `key:value`; the same key twice means either value
//!
//! Control events (overflow, reset, ready) always pass.

use std::collections::{HashMap, HashSet};

use crate::error::EventError;
use crate::glob::{Matcher, Verdict, compile_globs};
use crate::types::{Kind, Labels, Matchable};

const MAX_VALUES: usize = 32;
const MAX_LEN: usize = 4096;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilterSpec {
    pub prefix: Vec<String>,
    pub glob: Vec<String>,
    pub kind: Vec<String>,
    pub type_: Option<String>,
    pub label: Vec<String>,
}

fn check(v: &[String], what: &str) -> Result<(), EventError> {
    if v.len() > MAX_VALUES {
        return Err(EventError::bad(format!(
            "filter: at most {MAX_VALUES} values for {what}"
        )));
    }
    if v.iter().any(|x| x.chars().count() > MAX_LEN) {
        return Err(EventError::bad(format!(
            "filter: {what} must be text of at most {MAX_LEN} characters"
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub struct Filter {
    pub spec: FilterSpec,
    prefixes: Vec<String>,
    globs: Option<Matcher>,
    kinds: Option<HashSet<Kind>>,
    type_dir: Option<bool>,
    labels: Option<HashMap<String, HashSet<String>>>,
}

impl Filter {
    /// 400 on a bad filter.
    pub fn new(input: FilterSpec) -> Result<Self, EventError> {
        let prefix: Vec<String> = input.prefix.iter().filter(|s| !s.is_empty()).cloned().collect();
        let glob: Vec<String> = input.glob.iter().filter(|s| !s.is_empty()).cloned().collect();
        let label: Vec<String> = input.label.iter().filter(|s| !s.is_empty()).cloned().collect();
        let kind_raw: Vec<String> = input.kind.iter().filter(|s| !s.is_empty()).cloned().collect();
        check(&prefix, "prefix")?;
        check(&glob, "glob")?;
        check(&kind_raw, "kind")?;
        check(&label, "label")?;
        let kind: Vec<String> = kind_raw
            .iter()
            .flat_map(|k| k.split(',').map(|x| x.trim().to_owned()))
            .filter(|k| !k.is_empty())
            .collect();
        let mut kinds = HashSet::new();
        for k in &kind {
            kinds.insert(
                Kind::parse(k)
                    .ok_or_else(|| EventError::bad(format!("filter: unknown kind \"{k}\"")))?,
            );
        }
        let type_ = input.type_.clone().filter(|t| !t.is_empty());
        let type_dir = match type_.as_deref() {
            None => None,
            Some("file") => Some(false),
            Some("dir") => Some(true),
            Some(_) => return Err(EventError::bad("filter: type is \"file\" or \"dir\"")),
        };
        let mut prefixes = Vec::new();
        for p in &prefix {
            if !p.starts_with('/') {
                return Err(EventError::bad("filter: a prefix is an absolute path"));
            }
            let t = if p.len() > 1 {
                let t = p.trim_end_matches('/');
                if t.is_empty() { "/" } else { t }
            } else {
                p.as_str()
            };
            prefixes.push(t.to_owned());
        }
        let globs = if glob.is_empty() {
            None
        } else {
            Some(compile_globs(&glob)?)
        };
        let labels = if label.is_empty() {
            None
        } else {
            let mut m: HashMap<String, HashSet<String>> = HashMap::new();
            for l in &label {
                let i = l
                    .find(':')
                    .filter(|i| *i > 0)
                    .ok_or_else(|| EventError::bad("filter: a label is \"key:value\""))?;
                m.entry(l[..i].to_owned())
                    .or_default()
                    .insert(l[i + 1..].to_owned());
            }
            Some(m)
        };
        Ok(Self {
            spec: FilterSpec {
                prefix,
                glob,
                kind: kind_raw,
                type_,
                label,
            },
            prefixes,
            globs,
            kinds: (!kind.is_empty()).then_some(kinds),
            type_dir,
            labels,
        })
    }

    pub fn empty(&self) -> bool {
        self.prefixes.is_empty()
            && self.globs.is_none()
            && self.kinds.is_none()
            && self.type_dir.is_none()
            && self.labels.is_none()
    }

    pub fn matches(&self, e: &Matchable) -> bool {
        let Some(kind) = e.kind else {
            return false;
        };
        if kind.is_control() {
            return true;
        }
        if let Some(k) = &self.kinds
            && !k.contains(&kind)
        {
            return false;
        }
        if let Some(d) = self.type_dir
            && e.dir != d
        {
            return false;
        }
        // a move matches by the labels of either place, as it does by the path of either place
        if self.labels.is_some()
            && !self.labels_match(e.labels.as_ref())
            && !(e.from.is_some() && self.labels_match(e.from_labels.as_ref()))
        {
            return false;
        }
        if !self.prefixes.is_empty()
            && !self.under_prefix(e.path.as_deref())
            && !self.under_prefix(e.from.as_deref())
        {
            return false;
        }
        if self.globs.is_some() && !self.glob_hit(e) {
            return false;
        }
        true
    }

    fn labels_match(&self, labels: Option<&Labels>) -> bool {
        let (Some(want), Some(have)) = (&self.labels, labels) else {
            return false;
        };
        want.iter().all(|(k, vs)| {
            have.get(k)
                .and_then(|v| v.as_str())
                .is_some_and(|v| vs.contains(v))
        })
    }

    fn under_prefix(&self, p: Option<&str>) -> bool {
        let Some(p) = p else {
            return false;
        };
        self.prefixes.iter().any(|x| {
            x == "/" || p == x || (p.starts_with(x.as_str()) && p.as_bytes().get(x.len()) == Some(&b'/'))
        })
    }

    fn glob_hit(&self, e: &Matchable) -> bool {
        let Some(g) = &self.globs else {
            return false;
        };
        [e.path.as_deref(), e.from.as_deref()]
            .into_iter()
            .flatten()
            .any(|p| g.test(p.strip_prefix('/').unwrap_or(p), e.dir) == Verdict::Yes)
    }
}

/// The filter a query string asks for: `prefix`, `glob`, `kind` (also comma separated), `type` and `label`, each as often as needed.
pub fn filter_from_pairs(pairs: &[(String, String)]) -> Result<Filter, EventError> {
    let all = |k: &str| -> Vec<String> {
        pairs
            .iter()
            .filter(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .collect()
    };
    let types = all("type");
    if types.len() > 1 {
        return Err(EventError::bad("filter: type is given once"));
    }
    Filter::new(FilterSpec {
        prefix: all("prefix"),
        glob: all("glob"),
        kind: all("kind"),
        type_: types.into_iter().next(),
        label: all("label"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn e(kind: Kind, path: &str) -> Matchable {
        Matchable {
            kind: Some(kind),
            dir: false,
            path: Some(path.into()),
            ..Matchable::default()
        }
    }

    fn spec(f: impl FnOnce(&mut FilterSpec)) -> Filter {
        let mut s = FilterSpec::default();
        f(&mut s);
        Filter::new(s).unwrap()
    }

    #[test]
    fn prefix_matches_whole_segments_and_a_move_by_either_place() {
        let f = spec(|s| s.prefix = vec!["/srv/a/".into()]);
        assert!(f.matches(&e(Kind::Create, "/srv/a")));
        assert!(f.matches(&e(Kind::Create, "/srv/a/x/y")));
        assert!(!f.matches(&e(Kind::Create, "/srv/ab")));
        let mut m = e(Kind::Move, "/other/x");
        m.from = Some("/srv/a/x".into());
        assert!(f.matches(&m));
        assert!(spec(|s| s.prefix = vec!["/".into()]).matches(&e(Kind::Modify, "/q")));
    }

    #[test]
    fn kind_type_glob_and_label_combine_with_and() {
        let f = spec(|s| {
            s.kind = vec!["create,delete".into()];
            s.type_ = Some("file".into());
            s.glob = vec!["*.md".into()];
        });
        assert!(f.matches(&e(Kind::Create, "/a/x.md")));
        assert!(!f.matches(&e(Kind::Modify, "/a/x.md")));
        assert!(!f.matches(&e(Kind::Create, "/a/x.txt")));
        let mut d = e(Kind::Create, "/a/x.md");
        d.dir = true;
        assert!(!f.matches(&d));
        let g = spec(|s| s.glob = vec!["*.md".into()]);
        let mut mv = e(Kind::Move, "/a/x.txt");
        mv.from = Some("/a/x.md".into());
        assert!(g.matches(&mv), "the old name counts");

        let l = spec(|s| s.label = vec!["org:acme".into(), "org:beta".into()]);
        let mut with = e(Kind::Create, "/a");
        let mut m = serde_json::Map::new();
        m.insert("org".into(), serde_json::json!("beta"));
        with.labels = Some(Arc::new(m));
        assert!(l.matches(&with));
        assert!(!l.matches(&e(Kind::Create, "/a")));
    }

    #[test]
    fn control_events_always_pass_and_an_empty_filter_passes_everything() {
        let f = spec(|s| s.prefix = vec!["/x".into()]);
        let ctl = Matchable {
            kind: Some(Kind::Reset),
            ..Matchable::default()
        };
        assert!(f.matches(&ctl));
        let none = spec(|_| {});
        assert!(none.empty());
        assert!(none.matches(&e(Kind::Modify, "/anything")));
    }

    #[test]
    fn bad_input_is_a_400() {
        let bad = |s: FilterSpec| Filter::new(s).unwrap_err().status;
        assert_eq!(bad(FilterSpec { kind: vec!["nope".into()], ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { type_: Some("x".into()), ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { prefix: vec!["rel".into()], ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { label: vec!["nocolon".into()], ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { label: vec![":v".into()], ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { prefix: (0..33).map(|i| format!("/{i}")).collect(), ..FilterSpec::default() }), 400);
        assert_eq!(bad(FilterSpec { glob: vec!["a".repeat(5000)], ..FilterSpec::default() }), 400);
        let pairs = vec![("type".to_owned(), "file".to_owned()), ("type".to_owned(), "dir".to_owned())];
        assert!(filter_from_pairs(&pairs).is_err());
    }
}
