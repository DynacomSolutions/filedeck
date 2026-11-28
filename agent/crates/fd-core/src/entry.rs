use serde::{Serialize, Serializer};

/// A number the way JavaScript prints it: a whole value has no fraction (`1700000000123`, not `1700000000123.0`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        #[allow(clippy::cast_possible_truncation)]
        if v.is_finite() && v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
            s.serialize_i64(v as i64)
        } else {
            s.serialize_f64(v)
        }
    }
}

impl std::fmt::Display for JsNumber {
    /// The text `String(number)` gives in JavaScript for the values a file system produces.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The type of an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Dir,
    Symlink,
    Other,
}

/// One row of a listing or a `stat` answer. The field order is the one of the TypeScript agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: EntryType,
    pub size: u64,
    pub mtime: JsNumber,
    pub mode: u32,
    /// For a symlink: the link text as stored
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// For a symlink: whether the target is a folder
    #[serde(rename = "linkDir", skip_serializing_if = "Option::is_none")]
    pub link_dir: Option<bool>,
    /// For a symlink: the target does not exist
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let e = Entry {
            name: "a".into(),
            path: "/a".into(),
            kind: EntryType::File,
            size: 3,
            mtime: JsNumber(1_700_000_000_123.0),
            mode: 0o644,
            target: None,
            link_dir: None,
            broken: None,
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"name":"a","path":"/a","type":"file","size":3,"mtime":1700000000123,"mode":420}"#
        );
        assert_eq!(
            serde_json::to_string(&JsNumber(1_700_000_000_123.5)).unwrap(),
            "1700000000123.5"
        );
        assert_eq!(JsNumber(1_700_000_000_123.0).to_string(), "1700000000123");
    }
}
