//! Virtual paths: what a client sends. Pure text work, no file system access.

use crate::FsError;

/// The longest virtual path the agent takes, in UTF-8 bytes of the text (the TypeScript agent counts UTF-16 units; the two agree for ASCII).
pub const MAX_VIRTUAL: usize = 4096;

/// The trash store of the agent. Hidden in listings and refused in reads.
pub const TRASH_DIR: &str = ".filedeck-trash";
/// The private work folder of the agent.
pub const WORK_DIR: &str = ".filedeck-work";
/// The prefix of private staging folders.
pub const STAGING_PREFIX: &str = ".filedeck-work-";

/// The one test for the agent's own names: the trash store, the work folder and the staging prefix.
pub fn is_reserved_name(name: &str) -> bool {
    name == TRASH_DIR || name == WORK_DIR || name.starts_with(STAGING_PREFIX)
}

/// No path may go through the trash store or a work or staging folder.
pub fn assert_not_reserved(virtual_path: &str) -> Result<(), FsError> {
    let mut reserved = false;
    for seg in virtual_path.split('/') {
        if seg == TRASH_DIR {
            return Err(FsError::forbidden("trash is managed via the trash API"));
        }
        reserved |= is_reserved_name(seg);
    }
    if reserved {
        return Err(FsError::forbidden(
            "this name is reserved for the file manager's own use",
        ));
    }
    Ok(())
}

/// Split a client path into segments. Empty and `.` segments go; `..` is refused, never clamped.
pub fn clean_virtual(input: &str) -> Result<Vec<String>, FsError> {
    if input.contains('\0') {
        return Err(FsError::bad_request("invalid path"));
    }
    if input.encode_utf16().count() > MAX_VIRTUAL {
        return Err(FsError::bad_request("path too long"));
    }
    let mut parts = Vec::new();
    for seg in input.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(FsError::bad_request("'..' segments are not allowed")),
            s => parts.push(s.to_owned()),
        }
    }
    Ok(parts)
}

/// Join a folder and one name. The name may not hold a separator or be a dot name.
pub fn virtual_join(dir: &str, name: &str) -> Result<String, FsError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(FsError::bad_request("invalid name"));
    }
    let base = if dir == "/" { "" } else { dir };
    Ok(format!("{base}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_and_refuses() {
        assert_eq!(clean_virtual("a//./b/").unwrap(), ["a", "b"]);
        assert!(clean_virtual("").unwrap().is_empty());
        for bad in ["/..", "/a/../../x", "../x", "/a/.."] {
            assert_eq!(clean_virtual(bad).unwrap_err().status, 400, "{bad}");
        }
        assert_eq!(clean_virtual("/a\0b").unwrap_err().status, 400);
        let long = format!("/{}", "a".repeat(5000));
        assert_eq!(clean_virtual(&long).unwrap_err().message, "path too long");
    }

    #[test]
    fn reserved_names() {
        for n in [
            ".filedeck-trash",
            ".filedeck-work",
            ".filedeck-work-abc",
            ".filedeck-work-9f3a-77",
        ] {
            assert!(is_reserved_name(n), "{n}");
            assert_eq!(
                assert_not_reserved(&format!("/sub/{n}/x"))
                    .unwrap_err()
                    .status,
                403
            );
        }
        for n in [
            "visible.txt",
            ".filedeck-workshop",
            ".filedeck",
            "filedeck-work-abc",
            ".filedeck-trashy",
        ] {
            assert!(!is_reserved_name(n), "{n}");
        }
        assert_eq!(
            assert_not_reserved("/x/.filedeck-trash/y")
                .unwrap_err()
                .message,
            "trash is managed via the trash API"
        );
    }

    #[test]
    fn join_refuses_bad_names() {
        for n in ["", ".", "..", "a/b", "a\0"] {
            assert!(virtual_join("/a", n).is_err(), "{n:?}");
        }
        assert_eq!(virtual_join("/", "x").unwrap(), "/x");
        assert_eq!(virtual_join("/a", "x").unwrap(), "/a/x");
    }
}
