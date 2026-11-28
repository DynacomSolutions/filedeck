use std::fmt;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use rustix::fs::OFlags;

use crate::ConfigError;

const MIN_LEN: usize = 16;
const MAX_FILE: u64 = 4096;

/// The shared secret of the agent. `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// A token from text. Refuses an empty, short or odd token.
    pub fn new(value: &str) -> Result<Self, String> {
        if value.len() < MIN_LEN {
            return Err(format!("the token is shorter than {MIN_LEN} characters"));
        }
        if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("the token holds a space or a control character".into());
        }
        Ok(Self(value.to_owned()))
    }

    /// Read a token file. The file must be a plain file (never a symbolic link),
    /// owned by root or by this user, and closed to group and others (mode 0600).
    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let err = |reason: String| ConfigError::token_file(path, reason);
        let link =
            std::fs::symlink_metadata(path).map_err(|e| err(format!("cannot read it: {e}")))?;
        if link.file_type().is_symlink() {
            return Err(err("it is a symbolic link; use the real file".into()));
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(|e| err(format!("cannot open it: {e}")))?;
        // Check the open descriptor, so the file cannot change between the check and the read.
        let meta = file
            .metadata()
            .map_err(|e| err(format!("cannot read it: {e}")))?;
        if !meta.is_file() {
            return Err(err("it is not a plain file".into()));
        }
        let mode = meta.mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(err(format!(
                "it is readable by group or others (mode {mode:04o}); run: chmod 600 {}",
                path.display()
            )));
        }
        let me = rustix::process::geteuid().as_raw();
        if meta.uid() != 0 && meta.uid() != me {
            return Err(err(format!(
                "it is owned by user {}; it must belong to root or to the agent user",
                meta.uid()
            )));
        }
        if meta.len() > MAX_FILE {
            return Err(err(format!("it is larger than {MAX_FILE} bytes")));
        }
        let mut text = String::new();
        file.by_ref()
            .take(MAX_FILE + 1)
            .read_to_string(&mut text)
            .map_err(|e| err(format!("cannot read it as text: {e}")))?;
        Self::new(text.trim_end_matches(['\n', '\r'])).map_err(err)
    }

    /// The secret, for the one place that compares it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<hidden>)")
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    const GOOD: &str = "t0ken-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fd-core-token-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, body: &str, mode: u32) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn reads_a_private_file_and_trims_the_newline() {
        let d = dir("ok");
        let f = d.join("t");
        write(&f, &format!("{GOOD}\n"), 0o600);
        assert_eq!(Token::from_file(&f).unwrap().expose(), GOOD);
        write(&f, GOOD, 0o400);
        assert!(Token::from_file(&f).is_ok());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_a_file_that_group_or_others_can_read() {
        let d = dir("mode");
        let f = d.join("t");
        for mode in [0o640, 0o604, 0o644, 0o660, 0o666, 0o610] {
            write(&f, GOOD, mode);
            let e = Token::from_file(&f).unwrap_err().to_string();
            assert!(e.contains("readable by group or others"), "{mode:o}: {e}");
            assert!(!e.contains(GOOD));
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_a_symbolic_link_even_to_a_private_file() {
        let d = dir("link");
        let real = d.join("real");
        write(&real, GOOD, 0o600);
        let link = d.join("link");
        symlink(&real, &link).unwrap();
        let e = Token::from_file(&link).unwrap_err().to_string();
        assert!(e.contains("symbolic link"), "{e}");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_missing_empty_short_and_odd_tokens() {
        let d = dir("bad");
        assert!(
            Token::from_file(&d.join("nope"))
                .unwrap_err()
                .to_string()
                .contains("cannot read it")
        );
        assert!(
            Token::from_file(&d)
                .unwrap_err()
                .to_string()
                .contains("not a plain file")
        );
        let f = d.join("t");
        for body in [
            "",
            "\n",
            "short",
            "has space in the middle of it xx",
            "tab\tinside-the-token-xxxxxxxx",
        ] {
            write(&f, body, 0o600);
            assert!(Token::from_file(&f).is_err(), "{body:?}");
        }
        write(&f, &"x".repeat(5000), 0o600);
        assert!(
            Token::from_file(&f)
                .unwrap_err()
                .to_string()
                .contains("larger")
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn debug_hides_the_secret() {
        assert_eq!(
            format!("{:?}", Token::new(GOOD).unwrap()),
            "Token(<hidden>)"
        );
    }
}
