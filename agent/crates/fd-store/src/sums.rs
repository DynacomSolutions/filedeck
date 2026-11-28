//! The ten counters of a folder row. The names and the order are the ones of the TypeScript store (`METRICS`).

/// Column suffixes: a row has `own_<m>` and `tot_<m>` for each one.
pub const METRICS: [&str; 10] = [
    "bytes",
    "disk",
    "files",
    "symlinks",
    "other",
    "dirs",
    "mounts",
    "errors",
    "links",
    "link_checked",
];

/// Counters of a folder: its own direct children (`own`) or its whole subtree (`tot`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sums {
    pub bytes: i64,
    pub disk: i64,
    pub files: i64,
    pub symlinks: i64,
    pub other: i64,
    pub dirs: i64,
    pub mounts: i64,
    pub errors: i64,
    pub links: i64,
    pub link_checked: i64,
}

impl Sums {
    /// The values in `METRICS` order.
    pub fn to_array(&self) -> [i64; 10] {
        [
            self.bytes,
            self.disk,
            self.files,
            self.symlinks,
            self.other,
            self.dirs,
            self.mounts,
            self.errors,
            self.links,
            self.link_checked,
        ]
    }

    pub fn from_array(a: [i64; 10]) -> Self {
        Self {
            bytes: a[0],
            disk: a[1],
            files: a[2],
            symlinks: a[3],
            other: a[4],
            dirs: a[5],
            mounts: a[6],
            errors: a[7],
            links: a[8],
            link_checked: a[9],
        }
    }

    /// `self += sign * other`
    pub fn add(&mut self, other: &Sums, sign: i64) {
        let mut a = self.to_array();
        for (x, y) in a.iter_mut().zip(other.to_array()) {
            *x += sign * y;
        }
        *self = Self::from_array(a);
    }
}
