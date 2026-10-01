import fs from "node:fs/promises";
import path from "node:path";

export interface Mount {
  device: string;
  mountpoint: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  /** true for NFS, SMB/CIFS, other network filesystems and every FUSE mount (which is usually a remote or cloud drive) */
  network: boolean;
  /** human label when `network`, e.g. "NFS", "SMB/CIFS", "SSHFS", "FUSE" */
  netKind?: string;
  /** a network mount that did not answer statfs in time (stale or unreachable); sizes are 0 */
  unreachable?: boolean;
  /** the agent refuses changes under this mount point (FILEDECK_READONLY) */
  readOnly?: boolean;
}

const NET_FS: Record<string, string> = {
  nfs: "NFS", nfs4: "NFS", cifs: "SMB/CIFS", smb3: "SMB/CIFS", smbfs: "SMB/CIFS", afs: "AFS", ceph: "CephFS",
  glusterfs: "GlusterFS", lustre: "Lustre", "9p": "9P", ncpfs: "NCP", ocfs2: "OCFS2", gfs2: "GFS2",
};
const FUSE_KIND: Record<string, string> = {
  sshfs: "SSHFS", rclone: "rclone", s3fs: "S3 (s3fs)", davfs2: "WebDAV", gcsfuse: "GCS", goofys: "S3 (goofys)",
  curlftpfs: "FTP", glusterfs: "GlusterFS", cephfs: "CephFS", "ceph-fuse": "CephFS", nfs: "NFS", smb: "SMB/CIFS",
};

/** Classify a mount as a network drive. Returns the label, or null for local filesystems. */
export function networkKind(fstype: string): string | null {
  if (NET_FS[fstype]) return NET_FS[fstype];
  if (fstype === "fuse" || fstype.startsWith("fuse.")) {
    const sub = fstype.slice(5);
    return FUSE_KIND[sub] ?? "FUSE";
  }
  return null;
}

const PSEUDO = new Set([
  "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs",
  "configfs", "fusectl", "pstore", "bpf", "autofs", "mqueue", "hugetlbfs", "binfmt_misc", "efivarfs",
  "overlay", "squashfs", "nsfs", "ramfs", "rpc_pipefs", "selinuxfs",
]);
const HIDDEN_PREFIXES = [
  "/proc", "/sys", "/dev", "/run/user", "/run/k3s", "/run/netns", "/var/lib/kubelet", "/var/lib/rancher",
  "/var/lib/containerd", "/var/lib/docker", "/snap",
];

export function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

export function parseMounts(text: string) {
  const seen = new Set<string>();
  const out: { device: string; mountpoint: string; fstype: string }[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 3) continue;
    const device = unescapeMount(f[0] as string);
    const mountpoint = unescapeMount(f[1] as string);
    const fstype = f[2] as string;
    if (PSEUDO.has(fstype)) continue;
    if (fstype === "tmpfs" && !mountpoint.startsWith("/tmp") && mountpoint !== "/dev/shm") continue;
    if (HIDDEN_PREFIXES.some((p) => mountpoint === p || mountpoint.startsWith(p + "/"))) continue;
    if (seen.has(mountpoint)) continue;
    seen.add(mountpoint);
    out.push({ device, mountpoint, fstype });
  }
  return out;
}

export async function listMounts(root: string, procMounts: string): Promise<Mount[]> {
  let text = "";
  try {
    text = await fs.readFile(procMounts, "utf8");
  } catch {
    return [];
  }
  const res: Mount[] = [];
  for (const m of parseMounts(text)) {
    const kind = networkKind(m.fstype);
    const label = kind ? { network: true, netKind: kind } : { network: false };
    try {
      const real = path.join(root, m.mountpoint);
      // A dead NFS/SMB server can hang statfs for minutes; show the mount as unreachable instead of blocking the list.
      const s = kind ? await Promise.race([fs.statfs(real), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000).unref())]) : await fs.statfs(real);
      const total = s.blocks * s.bsize;
      res.push({ ...m, ...label, total, free: s.bavail * s.bsize, used: total - s.bfree * s.bsize });
    } catch (e) {
      // network mount that timed out: keep it, clearly marked; other unreadable mounts (permission) are skipped
      if (kind && (e as Error).message === "timeout") res.push({ ...m, ...label, total: 0, free: 0, used: 0, unreachable: true });
    }
  }
  return res.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}
