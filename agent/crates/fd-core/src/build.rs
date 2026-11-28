/// What this binary is. The commit comes from `FILEDECK_BUILD_COMMIT` at build time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: &'static str,
    pub os: &'static str,
}

impl BuildInfo {
    /// The facts of the running binary.
    pub const fn current() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION"),
            commit: match option_env!("FILEDECK_BUILD_COMMIT") {
                Some(c) => c,
                None => "unknown",
            },
            os: std::env::consts::OS,
        }
    }
}
