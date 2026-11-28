use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use rustix::fs::statvfs;
use serde::Serialize;

use crate::collate::collate;

/// One mount, as `GET /api/mounts` lists it. The field order is the one of the TypeScript agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mount {
    pub device: String,
    pub mountpoint: String,
    pub fstype: String,
    /// NFS, SMB/CIFS, other network filesystems and every FUSE mount
    pub network: bool,
    #[serde(rename = "netKind", skip_serializing_if = "Option::is_none")]
    pub net_kind: Option<String>,
    pub total: u64,
    pub free: u64,
    pub used: u64,
    /// A network mount that did not answer in time; the sizes are 0
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<bool>,
    /// The agent refuses changes under this mount point
    #[serde(rename = "readOnly", skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Raw {
    device: String,
    mountpoint: String,
    fstype: String,
}

const NET_FS: &[(&str, &str)] = &[
    ("nfs", "NFS"),
    ("nfs4", "NFS"),
    ("cifs", "SMB/CIFS"),
    ("smb3", "SMB/CIFS"),
    ("smbfs", "SMB/CIFS"),
    ("afs", "AFS"),
    ("ceph", "CephFS"),
    ("glusterfs", "GlusterFS"),
    ("lustre", "Lustre"),
    ("9p", "9P"),
    ("ncpfs", "NCP"),
    ("ocfs2", "OCFS2"),
    ("gfs2", "GFS2"),
];
const FUSE_KIND: &[(&str, &str)] = &[
    ("sshfs", "SSHFS"),
    ("rclone", "rclone"),
    ("s3fs", "S3 (s3fs)"),
    ("davfs2", "WebDAV"),
    ("gcsfuse", "GCS"),
    ("goofys", "S3 (goofys)"),
    ("curlftpfs", "FTP"),
    ("glusterfs", "GlusterFS"),
    ("cephfs", "CephFS"),
    ("ceph-fuse", "CephFS"),
    ("nfs", "NFS"),
    ("smb", "SMB/CIFS"),
];

fn find(table: &[(&str, &str)], key: &str) -> Option<String> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_owned())
}

/// Classify a mount as a network drive. `None` for a local filesystem.
fn network_kind(fstype: &str) -> Option<String> {
    if let Some(k) = find(NET_FS, fstype) {
        return Some(k);
    }
    if fstype == "fuse" || fstype.starts_with("fuse.") {
        let sub = fstype.get(5..).unwrap_or("");
        return Some(find(FUSE_KIND, sub).unwrap_or_else(|| "FUSE".to_owned()));
    }
    None
}

const PSEUDO: &[&str] = &[
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "securityfs",
    "debugfs",
    "tracefs",
    "configfs",
    "fusectl",
    "pstore",
    "bpf",
    "autofs",
    "mqueue",
    "hugetlbfs",
    "binfmt_misc",
    "efivarfs",
    "overlay",
    "squashfs",
    "nsfs",
    "ramfs",
    "rpc_pipefs",
    "selinuxfs",
    // macOS
    "devfs",
    "map",
];
const HIDDEN_PREFIXES: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/run/user",
    "/run/k3s",
    "/run/netns",
    "/var/lib/kubelet",
    "/var/lib/rancher",
    "/var/lib/containerd",
    "/var/lib/docker",
    "/snap",
    // macOS volumes that hold no user files
    "/System/Volumes/VM",
    "/System/Volumes/Preboot",
    "/System/Volumes/Update",
    "/System/Volumes/xarts",
    "/System/Volumes/iSCPreboot",
    "/System/Volumes/Hardware",
];

fn under(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|r| r.starts_with('/'))
}

/// `\040` style escapes of `/proc/mounts`.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && b[i + 1..=i + 3].iter().all(|c| (b'0'..=b'7').contains(c))
        {
            let v = u32::from(b[i + 1] - b'0') * 64
                + u32::from(b[i + 2] - b'0') * 8
                + u32::from(b[i + 3] - b'0');
            // The TypeScript agent maps the value to one UTF-16 unit; a value above 255 is not a byte.
            if let Ok(byte) = u8::try_from(v) {
                out.push(byte);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a table in `/proc/mounts` format. Mounts stacked on one mount point: the last covers the others and is kept,
/// at the place of the first. Pseudo filesystems and runtime mounts are left out.
fn parse_table(text: &str) -> Vec<Raw> {
    let mut order: Vec<Raw> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for line in text.split('\n') {
        let f: Vec<&str> = line.split(' ').collect();
        if f.len() < 3 {
            continue;
        }
        let raw = Raw {
            device: unescape(f[0]),
            mountpoint: unescape(f[1]),
            fstype: f[2].to_owned(),
        };
        match at.get(&raw.mountpoint) {
            Some(i) => order[*i] = raw,
            None => {
                at.insert(raw.mountpoint.clone(), order.len());
                order.push(raw);
            }
        }
    }
    order
}

fn visible(raws: Vec<Raw>) -> Vec<Raw> {
    raws.into_iter()
        .filter(|m| {
            if PSEUDO.contains(&m.fstype.as_str()) {
                return false;
            }
            if m.fstype == "tmpfs"
                && !m.mountpoint.starts_with("/tmp")
                && m.mountpoint != "/dev/shm"
            {
                return false;
            }
            !HIDDEN_PREFIXES.iter().any(|p| under(&m.mountpoint, p))
        })
        .collect()
}

/// The mounts of a table in `/proc/mounts` format, as `GET /api/mounts` sees them: `(device, mount point, type)`.
pub fn parse_mounts(text: &str) -> Vec<(String, String, String)> {
    visible(parse_table(text))
        .into_iter()
        .map(|m| (m.device, m.mountpoint, m.fstype))
        .collect()
}

/// The output of the macOS `mount` command: `device on /mount/point (type, option, ...)`.
pub fn parse_mac_mount(text: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((device, rest)) = line.split_once(" on ") else {
            continue;
        };
        let Some(open) = rest.rfind(" (") else {
            continue;
        };
        let mountpoint = &rest[..open];
        let fstype = rest[open + 2..]
            .trim_end_matches(')')
            .split(',')
            .next()
            .unwrap_or("")
            .trim();
        out.push((device.to_owned(), mountpoint.to_owned(), fstype.to_owned()));
    }
    out
}

/// Where the mount table comes from.
#[derive(Debug, Clone)]
pub struct MountSource {
    /// `FILEDECK_PROC_MOUNTS`. `None` reads the system's own table.
    pub table: Option<PathBuf>,
}

fn rebase(raws: Vec<Raw>, root: &str) -> Vec<Raw> {
    if root == "/" {
        return raws;
    }
    raws.into_iter()
        .filter(|m| under(&m.mountpoint, root))
        .map(|mut m| {
            m.mountpoint = match &m.mountpoint[root.len()..] {
                "" => "/".to_owned(),
                rest => rest.to_owned(),
            };
            m
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn system_table(_root: &str) -> Vec<Raw> {
    let out = std::process::Command::new("/sbin/mount").output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    parse_mac_mount(&text)
        .into_iter()
        .map(|(device, mountpoint, fstype)| Raw {
            device,
            mountpoint,
            fstype,
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn system_table(root: &str) -> Vec<Raw> {
    let default = default_table(root);
    read_table(root, &default)
}

#[cfg(not(target_os = "macos"))]
fn default_table(root: &str) -> PathBuf {
    if root == "/" {
        PathBuf::from("/proc/mounts")
    } else {
        PathBuf::from(format!("{root}/proc/1/mounts"))
    }
}

/// Read the table file. When the default `<root>/proc/1/mounts` cannot be read, fall back to `<root>/proc/mounts`
/// rebased on the root. A table that cannot be read gives no mounts.
fn read_table(root: &str, table: &Path) -> Vec<Raw> {
    if let Ok(text) = std::fs::read_to_string(table) {
        return parse_table(&text);
    }
    if root == "/" || table != Path::new(&format!("{root}/proc/1/mounts")) {
        return Vec::new();
    }
    std::fs::read_to_string(format!("{root}/proc/mounts"))
        .map(|t| rebase(parse_table(&t), root))
        .unwrap_or_default()
}

/// Whether a change under `mountpoint` is refused by the read-only prefixes.
pub fn is_read_only(prefixes: &[String], mountpoint: &str) -> bool {
    prefixes.iter().any(|p| p == "/" || under(mountpoint, p))
}

fn sizes(path: &Path, network: bool) -> Option<Result<(u64, u64, u64), ()>> {
    let probe = move |p: PathBuf| {
        statvfs(&p).ok().map(|s| {
            let unit = if s.f_frsize == 0 {
                s.f_bsize
            } else {
                s.f_frsize
            };
            let total = s.f_blocks.saturating_mul(unit);
            (
                total,
                s.f_bavail.saturating_mul(unit),
                total.saturating_sub(s.f_bfree.saturating_mul(unit)),
            )
        })
    };
    if !network {
        return probe(path.to_path_buf()).map(Ok);
    }
    // A dead server can hang statvfs for minutes: ask on another thread and give up after 3 seconds.
    let (tx, rx) = mpsc::channel();
    let p = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = tx.send(probe(p));
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(v) => v.map(Ok),
        Err(_) => Some(Err(())),
    }
}

/// The mounts under `root`, with sizes, sorted by mount point. `read_only` are the prefixes that refuse changes.
pub fn list_mounts(root: &str, source: &MountSource, read_only: &[String]) -> Vec<Mount> {
    let raws = match &source.table {
        Some(t) => read_table(root, t),
        None => system_table(root),
    };
    let mut out = Vec::new();
    for m in visible(raws) {
        let kind = network_kind(&m.fstype);
        let real = if root == "/" {
            PathBuf::from(&m.mountpoint)
        } else {
            PathBuf::from(format!("{root}{}", m.mountpoint))
        };
        let base = Mount {
            device: m.device,
            mountpoint: m.mountpoint.clone(),
            fstype: m.fstype,
            network: kind.is_some(),
            net_kind: kind.clone(),
            total: 0,
            free: 0,
            used: 0,
            unreachable: None,
            read_only: is_read_only(read_only, &m.mountpoint).then_some(true),
        };
        match sizes(&real, kind.is_some()) {
            Some(Ok((total, free, used))) => out.push(Mount {
                total,
                free,
                used,
                ..base
            }),
            Some(Err(())) => out.push(Mount {
                unreachable: Some(true),
                ..base
            }),
            // Unreadable local mounts (permission) are skipped; so is a network mount that failed fast.
            None => {}
        }
    }
    out.sort_by(|a, b| collate(&a.mountpoint, &b.mountpoint, false));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str =
        "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p3 /home ext4 rw 0 0\nproc /proc proc rw 0 0\n";
    const CONTAINER: &str = "overlay / overlay rw 0 0\n/dev/nvme0n1p2 /host ext4 rw 0 0\n/dev/nvme0n1p3 /host/home ext4 rw 0 0\n/dev/nvme0n1p2 /tmp ext4 rw 0 0\n/dev/nvme0n1p2 /var/lib/filedeck ext4 rw 0 0\n";

    fn points(v: &[(String, String, String)]) -> Vec<&str> {
        v.iter().map(|m| m.1.as_str()).collect()
    }

    #[test]
    fn host_table() {
        assert_eq!(points(&parse_mounts(HOST)), ["/", "/home"]);
    }

    #[test]
    fn container_table_is_rebased() {
        let m = visible(rebase(parse_table(CONTAINER), "/host"));
        let got: Vec<_> = m
            .iter()
            .map(|x| (x.device.as_str(), x.mountpoint.as_str()))
            .collect();
        assert_eq!(got, [("/dev/nvme0n1p2", "/"), ("/dev/nvme0n1p3", "/home")]);
    }

    #[test]
    fn stacked_mounts_keep_the_last_at_the_first_place() {
        let t = "/dev/a / ext4 rw 0 0\n/dev/b /srv ext4 rw 0 0\n/dev/c /srv xfs rw 0 0\n/dev/a /alias ext4 rw 0 0\n";
        let m = parse_mounts(t);
        assert_eq!(
            m.iter()
                .map(|x| (x.1.as_str(), x.0.as_str(), x.2.as_str()))
                .collect::<Vec<_>>(),
            [
                ("/", "/dev/a", "ext4"),
                ("/srv", "/dev/c", "xfs"),
                ("/alias", "/dev/a", "ext4")
            ]
        );
        assert!(parse_mounts("/dev/a /x ext4 rw 0 0\nproc /x proc rw 0 0\n").is_empty());
    }

    #[test]
    fn escapes_and_kinds() {
        assert_eq!(
            parse_mounts("/dev/a /my\\040disk ext4 rw 0 0\n")[0].1,
            "/my disk"
        );
        assert_eq!(network_kind("nfs4").as_deref(), Some("NFS"));
        assert_eq!(network_kind("fuse.sshfs").as_deref(), Some("SSHFS"));
        assert_eq!(network_kind("fuse.other").as_deref(), Some("FUSE"));
        assert_eq!(network_kind("fuse").as_deref(), Some("FUSE"));
        assert_eq!(network_kind("ext4"), None);
    }

    #[test]
    fn mac_mount_output() {
        let t = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
                 devfs on /dev (devfs, local, nobrowse)\n\
                 /dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n\
                 //user@nas on /Volumes/My Share (smbfs, nodev, nosuid, mounted by user)\n";
        let m = parse_mac_mount(t);
        assert_eq!(m.len(), 4);
        assert_eq!(
            m[3],
            (
                "//user@nas".into(),
                "/Volumes/My Share".into(),
                "smbfs".into()
            )
        );
        let v = visible(
            m.into_iter()
                .map(|(device, mountpoint, fstype)| Raw {
                    device,
                    mountpoint,
                    fstype,
                })
                .collect(),
        );
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn read_only_prefixes() {
        let p = vec!["/ro".to_owned()];
        assert!(is_read_only(&p, "/ro"));
        assert!(is_read_only(&p, "/ro/x"));
        assert!(!is_read_only(&p, "/rw"));
        assert!(!is_read_only(&p, "/rock"));
        assert!(is_read_only(&["/".to_owned()], "/anything"));
    }
}
