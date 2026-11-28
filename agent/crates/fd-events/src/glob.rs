//! A small glob matcher for the change filters (gitignore flavoured), port of `server/src/glob.ts`:
//!  - `*` any run of characters except "/", `**` any run including "/", `?` one character
//!  - `[abc]` / `[a-z]` / `[!abc]` classes, `{a,b}` alternatives
//!  - no "/" in the pattern: match the base name at any depth; with "/": match the whole relative path
//!  - leading "/" anchors at the compared root; trailing "/" matches directories only
//!
//! Patterns run on an automaton with the live states kept in a list: no backtracking, so the work is at most
//! (text length x token count). A step budget stops a hostile pattern set.

use crate::error::EventError;

const MAX_PATTERN: usize = 256;
const MAX_PATTERNS: usize = 100;
/// Most rules (after brace expansion) and tokens in one matcher: more is refused (400).
pub const MAX_RULES: usize = 256;
pub const MAX_TOTAL_TOKENS: usize = 1024;
/// Automaton steps one `test` call may spend over all its rules.
pub const MAX_STEPS_PER_TEST: i64 = 40_000;

/// What `test` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    No,
    /// the step budget ran out: the path is not judged either way
    Skip,
}

#[derive(Debug, Clone)]
enum Tok {
    Lit(char),
    One,
    Class(bool, Vec<(char, char)>),
    Star,
    DStar,
    /// `**/` may match zero directories: skippable, entered before the first character
    Dsa,
    /// inside the run, ends at a "/"
    Dsb,
}

fn expand_braces(p: &str, depth: usize) -> Vec<String> {
    let chars: Vec<char> = p.chars().collect();
    let Some(open) = chars.iter().position(|c| *c == '{') else {
        return vec![p.to_owned()];
    };
    if depth > 4 {
        return vec![p.to_owned()];
    }
    let mut level = 0i32;
    let mut close = None;
    for (i, c) in chars.iter().enumerate().skip(open) {
        if *c == '{' {
            level += 1;
        } else if *c == '}' {
            level -= 1;
            if level == 0 {
                close = Some(i);
                break;
            }
        }
    }
    let Some(close) = close else {
        return vec![p.to_owned()];
    };
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    level = 0;
    for c in &chars[open + 1..close] {
        if *c == '{' {
            level += 1;
        }
        if *c == '}' {
            level -= 1;
        }
        if *c == ',' && level == 0 {
            parts.push(std::mem::take(&mut cur));
        } else {
            cur.push(*c);
        }
    }
    parts.push(cur);
    let head: String = chars[..open].iter().collect();
    let tail: String = chars[close + 1..].iter().collect();
    let mut out = Vec::new();
    for alt in &parts {
        for rest in expand_braces(&tail, depth + 1) {
            out.extend(expand_braces(&format!("{head}{alt}{rest}"), depth + 1));
        }
    }
    out.truncate(64);
    out
}

/// Glob text to tokens; `None` when it is not a valid glob (an inverted range in a class): such a pattern is ignored.
fn tokenise(g: &str) -> Option<Vec<Tok>> {
    let c: Vec<char> = g.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '*' {
            if c.get(i + 1) == Some(&'*') {
                while c.get(i + 1) == Some(&'*') {
                    i += 1;
                }
                if c.get(i + 1) == Some(&'/') {
                    i += 1;
                    out.push(Tok::Dsa);
                    out.push(Tok::Dsb);
                } else {
                    out.push(Tok::DStar);
                }
            } else {
                out.push(Tok::Star);
            }
        } else if ch == '?' {
            out.push(Tok::One);
        } else if ch == '['
            && let Some(rel) = c.iter().skip(i + 2).position(|x| *x == ']')
        {
            let end = i + 2 + rel;
            let mut body: &[char] = &c[i + 1..end];
            let neg = matches!(body.first(), Some('!' | '^'));
            if neg {
                body = &body[1..];
            }
            let mut items = Vec::new();
            let mut j = 0;
            while j < body.len() {
                if body.get(j + 1) == Some(&'-') && j + 2 < body.len() {
                    if body[j] > body[j + 2] {
                        return None;
                    }
                    items.push((body[j], body[j + 2]));
                    j += 3;
                } else {
                    items.push((body[j], body[j]));
                    j += 1;
                }
            }
            out.push(Tok::Class(neg, items));
            i = end;
        } else {
            out.push(Tok::Lit(ch));
        }
        i += 1;
    }
    Some(out)
}

fn in_class(items: &[(char, char)], ch: char) -> bool {
    items.iter().any(|(a, b)| ch >= *a && ch <= *b)
}

#[derive(Debug)]
struct Rule {
    toks: Vec<Tok>,
    base: bool,
    dir_only: bool,
}

/// A set of globs, ready to test paths.
pub struct Matcher {
    rules: Vec<Rule>,
}

impl std::fmt::Debug for Matcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Matcher({} rules)", self.rules.len())
    }
}

/// Compile the patterns. A pattern set that is too large is a 400.
pub fn compile_globs(patterns: &[String]) -> Result<Matcher, EventError> {
    let mut rules = Vec::new();
    let mut tokens = 0usize;
    for raw in patterns.iter().take(MAX_PATTERNS) {
        let mut raw = raw.trim().to_owned();
        if raw.is_empty() || raw.chars().count() > MAX_PATTERN {
            continue;
        }
        let dir_only = raw.ends_with('/');
        if dir_only {
            raw.pop();
        }
        let anchored = raw.starts_with('/');
        if anchored {
            raw.remove(0);
        }
        if raw.is_empty() {
            continue;
        }
        let base = !anchored && !raw.contains('/');
        for g in expand_braces(&raw, 0) {
            let Some(mut toks) = tokenise(&g) else {
                continue;
            };
            if toks.is_empty() {
                continue;
            }
            let mut rule_base = base;
            // `**/name-pattern` with no "/" left in it matches the base name at any depth, like a pattern without "/"
            if !rule_base
                && matches!(toks[0], Tok::Dsa)
                && toks.len() > 2
                && toks[2..].iter().all(|t| match t {
                    Tok::Lit(c) => *c != '/',
                    Tok::Class(neg, items) => in_class(items, '/') == *neg,
                    Tok::DStar | Tok::Dsa | Tok::Dsb => false,
                    _ => true,
                })
            {
                toks.drain(..2);
                rule_base = true;
            }
            tokens += toks.len();
            if rules.len() >= MAX_RULES || tokens > MAX_TOTAL_TOKENS {
                return Err(EventError::bad(
                    "the glob patterns are too large: use fewer patterns or fewer {alternatives}",
                ));
            }
            rules.push(Rule {
                toks,
                base: rule_base,
                dir_only,
            });
        }
    }
    Ok(Matcher { rules })
}

struct Sim<'a> {
    toks: &'a [Tok],
    seen: Vec<u32>,
    stamp: u32,
}

impl Sim<'_> {
    /// Adds state `i` and what it reaches without consuming a character.
    fn add(&mut self, list: &mut Vec<usize>, mut i: usize) {
        let m = self.toks.len();
        loop {
            if self.seen[i] == self.stamp {
                return;
            }
            self.seen[i] = self.stamp;
            list.push(i);
            if i >= m {
                return;
            }
            match self.toks[i] {
                Tok::Star | Tok::DStar => i += 1,
                Tok::Dsa => i += 2,
                _ => return,
            }
        }
    }
}

/// Run one rule over `text`. `None` when the budget ran out.
fn run(toks: &[Tok], text: &str, budget: &mut i64) -> Option<bool> {
    let m = toks.len();
    let mut sim = Sim {
        toks,
        seen: vec![0; m + 3],
        stamp: 1,
    };
    let mut cur: Vec<usize> = Vec::new();
    sim.add(&mut cur, 0);
    for ch in text.chars() {
        sim.stamp += 1;
        let mut nxt: Vec<usize> = Vec::new();
        *budget -= i64::try_from(cur.len()).unwrap_or(i64::MAX);
        if *budget < 0 {
            return None;
        }
        for &i in &cur {
            if i >= m {
                continue;
            }
            match &toks[i] {
                Tok::Lit(c) => {
                    if *c == ch {
                        sim.add(&mut nxt, i + 1);
                    }
                }
                Tok::One => {
                    if ch != '/' {
                        sim.add(&mut nxt, i + 1);
                    }
                }
                Tok::Class(neg, items) => {
                    if in_class(items, ch) != *neg {
                        sim.add(&mut nxt, i + 1);
                    }
                }
                Tok::Star => {
                    if ch != '/' {
                        sim.add(&mut nxt, i);
                    }
                }
                Tok::DStar => sim.add(&mut nxt, i),
                Tok::Dsa => {
                    sim.add(&mut nxt, i + 1);
                    if ch == '/' {
                        sim.add(&mut nxt, i + 2);
                    }
                }
                Tok::Dsb => {
                    sim.add(&mut nxt, i);
                    if ch == '/' {
                        sim.add(&mut nxt, i + 1);
                    }
                }
            }
        }
        if nxt.is_empty() {
            return Some(false);
        }
        cur = nxt;
    }
    Some(cur.contains(&m))
}

impl Matcher {
    /// `rel` is the path without its leading "/".
    pub fn test(&self, rel: &str, is_dir: bool) -> Verdict {
        let mut budget = MAX_STEPS_PER_TEST;
        let name = rel.rsplit('/').next().unwrap_or(rel);
        for r in &self.rules {
            if r.dir_only && !is_dir {
                continue;
            }
            let t = if r.base { name } else { rel };
            match run(&r.toks, t, &mut budget) {
                None => return Verdict::Skip,
                Some(true) => return Verdict::Yes,
                Some(false) => {}
            }
        }
        Verdict::No
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &[&str]) -> Matcher {
        compile_globs(&p.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).unwrap()
    }

    fn yes(p: &[&str], rel: &str, dir: bool) -> bool {
        m(p).test(rel, dir) == Verdict::Yes
    }

    #[test]
    fn base_name_at_any_depth_and_whole_paths() {
        assert!(yes(&["*.md"], "a/b/readme.md", false));
        assert!(!yes(&["*.md"], "a/b/readme.txt", false));
        assert!(yes(&["/srv/**/*.log"], "srv/x/y/app.log", false));
        assert!(!yes(&["/srv/**/*.log"], "var/x/app.log", false));
        assert!(yes(&["srv/**/*.log"], "srv/app.log", false), "** matches zero folders");
        assert!(yes(&["*.tmp", "*.md"], "a/x.md", false));
    }

    #[test]
    fn classes_braces_and_directories_only() {
        assert!(yes(&["[a-c]x"], "bx", false));
        assert!(!yes(&["[!a-c]x"], "bx", false));
        assert!(yes(&["f.{png,jpg}"], "f.jpg", false));
        assert!(yes(&["build/"], "build", true));
        assert!(!yes(&["build/"], "build", false));
        assert!(yes(&["a?c"], "abc", false));
        assert!(!yes(&["a?c"], "a/c", false));
    }

    #[test]
    fn a_hostile_glob_is_linear() {
        let g = m(&["*a*a*a*a*a*a*a*a*a*a*b"]);
        let text = "a".repeat(5000);
        let t0 = std::time::Instant::now();
        let v = g.test(&text, false);
        assert!(t0.elapsed().as_millis() < 2000);
        assert!(matches!(v, Verdict::No | Verdict::Skip));
    }

    #[test]
    fn too_large_is_a_400() {
        let many: Vec<String> = (0..100).map(|i| format!("a{{b,c,d}}{i}*")).collect();
        assert_eq!(compile_globs(&many).unwrap_err().status, 400);
    }
}
