//! Virtual paths: the path a client names, confined under the root. The rules are those of `paths.ts`.

use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use crate::error::StoreError;

/// A folder or file inside the root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// canonical virtual path (`/` rooted, no symbolic link in it)
    pub virtual_path: String,
    /// absolute path on the real file system
    pub real: PathBuf,
}

const MAX_LINKS: u32 = 40;
const TRASH_DIR: &str = ".filedeck-trash";
const WORK_DIR: &str = ".filedeck-work";
const STAGING_PREFIX: &str = ".filedeck-work-";

/// The names the agent keeps for itself: hidden from scans and refused in paths.
pub fn is_reserved_name(n: &str) -> bool {
    n == TRASH_DIR || n == WORK_DIR || n.starts_with(STAGING_PREFIX)
}

/// The parent of a canonical virtual path; `""` for `/`.
pub fn parent_of(p: &str) -> String {
    if p == "/" {
        return String::new();
    }
    match p.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(i) => p[..i].to_owned(),
    }
}

/// The last part of a virtual path.
pub fn base_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or("")
}

/// `dir` and `name` as one virtual path.
pub fn virtual_join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The exclusive bounds of every path below `p` (the character after `/` is `0`).
pub fn below(p: &str) -> (String, String) {
    let pre = if p == "/" {
        "/".to_owned()
    } else {
        format!("{p}/")
    };
    let hi = format!("{}0", &pre[..pre.len() - 1]);
    (pre, hi)
}

/// `a` is a folder above `b` (not `b` itself).
pub fn above(a: &str, b: &str) -> bool {
    a != b && (a == "/" || b.starts_with(&format!("{a}/")))
}

/// `b` is `a` or a folder below it.
pub fn at_or_below(b: &str, a: &str) -> bool {
    b == a || a == "/" || b.starts_with(&format!("{a}/"))
}

/// The two paths name the same folder or one holds the other.
pub fn overlaps(a: &str, b: &str) -> bool {
    at_or_below(a, b) || at_or_below(b, a)
}

/// The parts of a client path. A `..` part is refused, never clamped.
pub fn clean_virtual(input: &str) -> Result<Vec<&str>, StoreError> {
    if input.contains('\0') {
        return Err(StoreError::bad("invalid path"));
    }
    if input.len() > 4096 {
        return Err(StoreError::bad("path too long"));
    }
    let mut parts = Vec::new();
    for seg in input.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(StoreError::bad("'..' segments are not allowed")),
            s => parts.push(s),
        }
    }
    Ok(parts)
}

/// Resolve for reading: a symbolic link is followed (also at the end) and clamped at the root, as `resolveRead`.
pub fn resolve_read(root: &str, input: &str) -> Result<Resolved, StoreError> {
    let mut pending: Vec<String> = clean_virtual(input)?
        .into_iter()
        .rev()
        .map(str::to_owned)
        .collect();
    let mut stack: Vec<String> = Vec::new();
    let mut links = 0;
    while let Some(seg) = pending.pop() {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            stack.pop();
            continue;
        }
        let mut candidate = PathBuf::from(root);
        candidate.extend(&stack);
        candidate.push(&seg);
        let link = fs::symlink_metadata(&candidate).is_ok_and(|m| m.file_type().is_symlink());
        if link {
            links += 1;
            if links > MAX_LINKS {
                return Err(StoreError::bad("too many symbolic links"));
            }
            let target = fs::read_link(&candidate).map_err(StoreError::from)?;
            let bytes = target.as_os_str().as_bytes();
            if bytes.contains(&0) {
                return Err(StoreError::bad("invalid link"));
            }
            if target.is_absolute() {
                stack.clear();
            }
            let text = target.to_string_lossy().into_owned();
            for s in text.split('/').rev() {
                if !s.is_empty() && s != "." {
                    pending.push(s.to_owned());
                }
            }
        } else {
            stack.push(seg);
        }
    }
    let virtual_path = format!("/{}", stack.join("/"));
    let v: Vec<&str> = virtual_path.split('/').collect();
    if v.contains(&TRASH_DIR) {
        return Err(StoreError::status(
            403,
            "trash is managed via the trash API",
        ));
    }
    if v.iter().any(|s| is_reserved_name(s)) {
        return Err(StoreError::status(
            403,
            "this name is reserved for the file manager's own use",
        ));
    }
    let mut real = PathBuf::from(root);
    real.extend(&stack);
    Ok(Resolved { virtual_path, real })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parents_and_bounds() {
        assert_eq!(parent_of("/"), "");
        assert_eq!(parent_of("/a"), "/");
        assert_eq!(parent_of("/a/b"), "/a");
        assert_eq!(below("/"), ("/".into(), "0".into()));
        assert_eq!(below("/a"), ("/a/".into(), "/a0".into()));
        assert!(overlaps("/a", "/a/b") && overlaps("/a/b", "/a") && overlaps("/", "/x"));
        assert!(!overlaps("/a", "/ab"));
    }

    #[test]
    fn dot_dot_and_reserved_names_are_refused() {
        assert_eq!(clean_virtual("/a/../b").unwrap_err().status_code(), 400);
        let dir = std::env::temp_dir().join(format!("fd-vpath-{}", std::process::id()));
        fs::create_dir_all(dir.join("t")).unwrap();
        let root = dir.to_str().unwrap();
        assert_eq!(
            resolve_read(root, "/t/.filedeck-trash")
                .unwrap_err()
                .status_code(),
            403
        );
        assert_eq!(resolve_read(root, "//t/./").unwrap().virtual_path, "/t");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_absolute_link_is_rebased_onto_the_root() {
        let dir = std::env::temp_dir().join(format!("fd-vpath-link-{}", std::process::id()));
        fs::create_dir_all(dir.join("real/inner")).unwrap();
        std::os::unix::fs::symlink("/real", dir.join("l")).unwrap();
        let r = resolve_read(dir.to_str().unwrap(), "/l/inner").unwrap();
        assert_eq!(r.virtual_path, "/real/inner");
        fs::remove_dir_all(dir).unwrap();
    }
}
