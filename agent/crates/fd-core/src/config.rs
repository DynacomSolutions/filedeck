use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{ConfigError, Token};

/// Where a setting is read from: the process environment (a lookup function, so tests need no real environment).
pub type ConfigSource<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The settings of the agent. The names match the TypeScript agent where one exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `FILEDECK_NODE`, default `local`
    pub node: String,
    /// `FILEDECK_ROOT`, default `/host`, without a trailing slash (`/` stays `/`)
    pub root: String,
    /// `FILEDECK_HOST`; `None` binds every address
    pub host: Option<String>,
    /// `PORT`, default 8080
    pub port: u16,
    /// `FILEDECK_INDEX_DIR`, the state folder
    pub index_dir: Option<PathBuf>,
    /// `FILEDECK_READONLY`, clean absolute prefixes
    pub read_only: Vec<String>,
    pub token: Token,
}

/// The keys of the TOML file. Environment settings win over the file.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    node: Option<String>,
    root: Option<String>,
    host: Option<String>,
    port: Option<u32>,
    index_dir: Option<PathBuf>,
    read_only: Option<Vec<String>>,
    agent_token_file: Option<PathBuf>,
}

impl Config {
    /// Build the settings from the environment and an optional TOML file text.
    /// `file_path` is only used in messages.
    pub fn load(env: ConfigSource<'_>, file: Option<(&Path, &str)>) -> Result<Self, ConfigError> {
        let get = |k: &str| env(k).filter(|v| !v.is_empty());
        let f = match file {
            Some((path, text)) => {
                toml::from_str::<FileConfig>(text).map_err(|e| ConfigError::ConfigFile {
                    path: path.to_path_buf(),
                    reason: e.message().to_owned(),
                })?
            }
            None => FileConfig::default(),
        };

        match get("FILEDECK_MODE").as_deref() {
            None | Some("agent") => {}
            Some(other) => return Err(ConfigError::NotAgentMode(other.to_owned())),
        }
        if get("FILEDECK_AUTH").as_deref() == Some("on") {
            return Err(ConfigError::AuthNotSupported);
        }

        let node = get("FILEDECK_NODE")
            .or(f.node)
            .unwrap_or_else(|| "local".into());
        if node.chars().any(char::is_control) {
            return Err(ConfigError::invalid(
                "FILEDECK_NODE",
                "it holds a control character",
            ));
        }

        let root_raw = get("FILEDECK_ROOT")
            .or(f.root)
            .unwrap_or_else(|| "/host".into());
        if !root_raw.starts_with('/') || root_raw.contains('\0') {
            return Err(ConfigError::invalid(
                "FILEDECK_ROOT",
                format!("\"{root_raw}\" is not an absolute path"),
            ));
        }
        let root = match root_raw.trim_end_matches('/') {
            "" => "/".to_owned(),
            t => t.to_owned(),
        };

        let port = match get("PORT") {
            Some(v) => v.parse::<u32>().ok(),
            None => Some(f.port.unwrap_or(8080)),
        };
        let port = port.and_then(|p| u16::try_from(p).ok()).ok_or_else(|| {
            ConfigError::invalid("PORT", "it must be a whole number from 0 to 65535")
        })?;

        let read_only = match get("FILEDECK_READONLY") {
            Some(v) => parse_read_only(v.split(',').map(str::to_owned))?,
            None => parse_read_only(f.read_only.unwrap_or_default())?,
        };

        let token = load_token(
            get("FILEDECK_AGENT_TOKEN"),
            get("FILEDECK_AGENT_TOKEN_FILE")
                .map(PathBuf::from)
                .or(f.agent_token_file),
        )?;

        Ok(Self {
            node,
            root,
            host: get("FILEDECK_HOST").or(f.host),
            port,
            index_dir: get("FILEDECK_INDEX_DIR").map(PathBuf::from).or(f.index_dir),
            read_only,
            token,
        })
    }
}

fn load_token(env_token: Option<String>, file: Option<PathBuf>) -> Result<Token, ConfigError> {
    match (env_token, file) {
        (Some(_), Some(_)) => Err(ConfigError::TwoTokens),
        (None, None) => Err(ConfigError::NoToken),
        (Some(v), None) => {
            Token::new(&v).map_err(|r| ConfigError::invalid("FILEDECK_AGENT_TOKEN", r))
        }
        (None, Some(p)) => Token::from_file(&p),
    }
}

/// Clean absolute prefixes as the TypeScript `parseReadOnly` does: `//`, `/./` and a trailing slash go,
/// `..` is resolved, and anything that is not an absolute path is refused.
fn parse_read_only(items: impl IntoIterator<Item = String>) -> Result<Vec<String>, ConfigError> {
    let mut out = Vec::new();
    for raw in items {
        let x = raw.trim();
        if x.is_empty() {
            continue;
        }
        let bad = || {
            ConfigError::invalid(
                "FILEDECK_READONLY",
                format!(
                    "\"{x}\" is not an absolute path inside the root (use entries such as /mnt/backup)"
                ),
            )
        };
        if !x.starts_with('/') || x.contains('\0') {
            return Err(bad());
        }
        let mut parts: Vec<&str> = Vec::new();
        for seg in x.split('/') {
            match seg {
                "" | "." => {}
                ".." => {
                    parts.pop().ok_or_else(bad)?;
                }
                s => parts.push(s),
            }
        }
        out.push(format!("/{}", parts.join("/")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const TOKEN: &str = "t0ken-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    fn load(pairs: &[(&str, &str)], file: Option<&str>) -> Result<Config, ConfigError> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Config::load(
            &|k| m.get(k).cloned(),
            file.map(|t| (Path::new("agent.toml"), t)),
        )
    }

    #[test]
    fn defaults_match_the_typescript_agent() {
        let c = load(&[("FILEDECK_AGENT_TOKEN", TOKEN)], None).unwrap();
        assert_eq!(
            (c.node.as_str(), c.root.as_str(), c.port),
            ("local", "/host", 8080)
        );
        assert_eq!(c.host, None);
        assert!(c.read_only.is_empty());
        assert_eq!(c.token.expose(), TOKEN);
    }

    #[test]
    fn env_wins_over_the_file() {
        let file =
            "node = \"from-file\"\nport = 9000\nroot = \"/data/\"\nread_only = [\"/a/../b\"]";
        let c = load(&[("FILEDECK_AGENT_TOKEN", TOKEN)], Some(file)).unwrap();
        assert_eq!(
            (c.node.as_str(), c.root.as_str(), c.port),
            ("from-file", "/data", 9000)
        );
        assert_eq!(c.read_only, ["/b"]);
        let c = load(
            &[
                ("FILEDECK_AGENT_TOKEN", TOKEN),
                ("FILEDECK_NODE", "n"),
                ("PORT", "1234"),
                ("FILEDECK_READONLY", "/x/, /y//z"),
            ],
            Some(file),
        )
        .unwrap();
        assert_eq!((c.node.as_str(), c.port), ("n", 1234));
        assert_eq!(c.read_only, ["/x", "/y/z"]);
    }

    #[test]
    fn root_slash_stays_a_slash() {
        let c = load(
            &[("FILEDECK_AGENT_TOKEN", TOKEN), ("FILEDECK_ROOT", "/")],
            None,
        )
        .unwrap();
        assert_eq!(c.root, "/");
    }

    #[test]
    fn refuses_bad_settings_with_a_clear_message() {
        let t = ("FILEDECK_AGENT_TOKEN", TOKEN);
        let msg = |pairs: &[(&str, &str)]| load(pairs, None).unwrap_err().to_string();
        assert!(msg(&[t, ("FILEDECK_MODE", "hub")]).contains("only as an agent"));
        assert!(msg(&[t, ("FILEDECK_AUTH", "on")]).contains("FILEDECK_AUTH=on is not supported"));
        assert!(msg(&[t, ("PORT", "70000")]).starts_with("PORT:"));
        assert!(msg(&[t, ("PORT", "abc")]).starts_with("PORT:"));
        assert!(msg(&[t, ("FILEDECK_ROOT", "relative")]).starts_with("FILEDECK_ROOT:"));
        assert!(msg(&[t, ("FILEDECK_READONLY", "mnt/backup")]).starts_with("FILEDECK_READONLY:"));
        assert!(msg(&[t, ("FILEDECK_READONLY", "/..")]).starts_with("FILEDECK_READONLY:"));
        assert!(msg(&[]).contains("no agent token"));
        assert!(msg(&[("FILEDECK_AGENT_TOKEN", "short")]).starts_with("FILEDECK_AGENT_TOKEN:"));
        assert!(msg(&[t, ("FILEDECK_AGENT_TOKEN_FILE", "/x")]).contains("both set"));
    }

    #[test]
    fn auth_other_than_on_is_off() {
        assert!(
            load(
                &[("FILEDECK_AGENT_TOKEN", TOKEN), ("FILEDECK_AUTH", "off")],
                None
            )
            .is_ok()
        );
    }

    #[test]
    fn refuses_an_unknown_key_in_the_file() {
        let e = load(&[("FILEDECK_AGENT_TOKEN", TOKEN)], Some("nod = \"x\""))
            .unwrap_err()
            .to_string();
        assert!(e.starts_with("config file agent.toml:"), "{e}");
        let e = load(&[("FILEDECK_AGENT_TOKEN", TOKEN)], Some("node = ["))
            .unwrap_err()
            .to_string();
        assert!(e.starts_with("config file agent.toml:"), "{e}");
    }

    #[test]
    fn the_error_never_shows_the_token() {
        let e = load(&[("FILEDECK_AGENT_TOKEN", TOKEN), ("PORT", "x")], None)
            .unwrap_err()
            .to_string();
        assert!(!e.contains(TOKEN));
        assert!(
            !format!(
                "{:?}",
                load(&[("FILEDECK_AGENT_TOKEN", TOKEN)], None).unwrap()
            )
            .contains(TOKEN)
        );
    }

    #[test]
    fn the_token_file_is_checked_through_the_config() {
        let d = std::env::temp_dir().join(format!("fd-core-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("token");
        std::fs::write(&f, TOKEN).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let p = f.to_str().unwrap();
        let e = load(&[("FILEDECK_AGENT_TOKEN_FILE", p)], None)
            .unwrap_err()
            .to_string();
        assert!(e.contains("readable by group or others"), "{e}");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            load(&[("FILEDECK_AGENT_TOKEN_FILE", p)], None)
                .unwrap()
                .token
                .expose(),
            TOKEN
        );
        let _ = std::fs::remove_dir_all(d);
    }
}
