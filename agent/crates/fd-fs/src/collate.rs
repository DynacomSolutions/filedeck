//! The order of names in a listing: folders first, then natural name order.
//!
//! The TypeScript agent uses `Intl.Collator(undefined, { numeric: true })`. This module follows the ICU root order for
//! ASCII (punctuation, then digits, then letters without regard to case, runs of digits by value) and puts any other
//! letter after the ASCII letters, in code point order of its lower case form. The accented letters of Latin-1 count as
//! their base letter, an unaccented letter first. Other accented letters can sort differently from ICU. Equal names under this order fall back to UTF-16 order, as in the TypeScript agent.

use std::cmp::Ordering;

/// ASCII punctuation and symbols in ICU root order.
const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// The lower case base letter of a Latin-1 accented letter, and whether it carried an accent.
fn fold(c: char) -> (char, bool) {
    let lower = c.to_lowercase().next().unwrap_or(c);
    let base = match lower {
        '\u{e0}'..='\u{e5}' => 'a',
        '\u{e7}' => 'c',
        '\u{e8}'..='\u{eb}' => 'e',
        '\u{ec}'..='\u{ef}' => 'i',
        '\u{f1}' => 'n',
        '\u{f2}'..='\u{f6}' | '\u{f8}' => 'o',
        '\u{f9}'..='\u{fc}' => 'u',
        '\u{fd}' | '\u{ff}' => 'y',
        _ => return (lower, false),
    };
    (base, true)
}

fn weight(c: char) -> u32 {
    let c = fold(c).0;
    if c.is_control() || c.is_whitespace() {
        return 1;
    }
    if let Some(i) = PUNCT.find(c) {
        return 10 + u32::try_from(i).unwrap_or(0);
    }
    if let Some(d) = c.to_digit(10).filter(|_| c.is_ascii_digit()) {
        return 100 + d;
    }
    if c.is_ascii_alphabetic() {
        return 200 + u32::from(c.to_ascii_lowercase()) - u32::from(b'a');
    }
    if c.is_ascii() {
        return 90; // any other ASCII symbol
    }
    let lower = c.to_lowercase().next().unwrap_or(c);
    1000 + u32::from(lower)
}

fn digit_run(chars: &[char], from: usize) -> usize {
    chars[from..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count()
}

fn cmp_numbers(a: &[char], b: &[char]) -> Ordering {
    let strip = |s: &[char]| -> Vec<char> {
        let n = s.iter().take_while(|c| **c == '0').count();
        s[n..].to_vec()
    };
    let (a, b) = (strip(a), strip(b));
    a.len().cmp(&b.len()).then_with(|| a.cmp(&b))
}

/// Compare two names at the primary level, then by case (lower case first).
/// With `numeric`, a run of digits counts by its value.
pub fn collate(a: &str, b: &str, numeric: bool) -> Ordering {
    let (x, y): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (mut i, mut j) = (0, 0);
    while i < x.len() && j < y.len() {
        if numeric && x[i].is_ascii_digit() && y[j].is_ascii_digit() {
            let (n, m) = (digit_run(&x, i), digit_run(&y, j));
            let o = cmp_numbers(&x[i..i + n], &y[j..j + m]);
            if o != Ordering::Equal {
                return o;
            }
            i += n;
            j += m;
            continue;
        }
        let o = weight(x[i]).cmp(&weight(y[j]));
        if o != Ordering::Equal {
            return o;
        }
        i += 1;
        j += 1;
    }
    let o = (x.len() - i).cmp(&(y.len() - j));
    if o != Ordering::Equal {
        return o;
    }
    // The same at the primary level: an unaccented letter before an accented one at the first difference,
    // then lower case before upper case at the first difference.
    for (p, q) in x.iter().zip(&y) {
        let (ap, aq) = (fold(*p).1, fold(*q).1);
        if ap != aq {
            return ap.cmp(&aq);
        }
    }
    for (p, q) in x.iter().zip(&y) {
        if p != q && p.to_lowercase().eq(q.to_lowercase()) {
            return if p.is_lowercase() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
    }
    Ordering::Equal
}

/// The default listing order: folders first, natural name order, then UTF-16 code unit order so the order is total.
pub fn list_order(a: (&str, bool), b: (&str, bool)) -> Ordering {
    b.1.cmp(&a.1)
        .then_with(|| collate(a.0, b.0, true))
        .then_with(|| a.0.encode_utf16().cmp(b.0.encode_utf16()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut v: Vec<&str>) -> Vec<&str> {
        v.sort_by(|a, b| list_order((a, false), (b, false)));
        v
    }

    #[test]
    fn digits_count_by_value() {
        assert_eq!(
            sorted(vec!["f10", "f2", "f1", "f02"]),
            ["f1", "f02", "f2", "f10"]
        );
    }

    #[test]
    fn case_is_ignored_first() {
        assert_eq!(
            sorted(vec!["b.txt", "A.txt", "a.txt", "B.txt"]),
            ["a.txt", "A.txt", "b.txt", "B.txt"]
        );
    }

    #[test]
    fn latin_1_accents_count_as_their_base_letter() {
        assert_eq!(
            sorted(vec!["escape", "\u{e9} \u{fc}.txt", "e", "\u{e9}", "f", "\u{c9}"]),
            ["e", "\u{e9}", "\u{c9}", "\u{e9} \u{fc}.txt", "escape", "f"]
        );
    }

    #[test]
    fn punctuation_digits_letters() {
        assert_eq!(
            sorted(vec!["a", "1", "_", "-", "b"]),
            ["_", "-", "1", "a", "b"]
        );
    }

    #[test]
    fn folders_first_and_total() {
        let mut v = [
            ("b", false),
            ("a", false),
            ("z", true),
            ("01", false),
            ("1", false),
        ];
        v.sort_by(|a, b| list_order(*a, *b));
        assert_eq!(
            v.iter().map(|x| x.0).collect::<Vec<_>>(),
            ["z", "01", "1", "a", "b"]
        );
    }

    #[test]
    fn plain_compare_has_no_numeric_runs() {
        assert_eq!(collate("a10", "a2", false), Ordering::Less);
        assert_eq!(collate("a10", "a2", true), Ordering::Greater);
    }
}
