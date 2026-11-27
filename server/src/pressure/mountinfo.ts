import { unescapeMount } from "../mounts.ts";

export interface MountEntry {
  /** "major:minor" of the mount's device */
  dev: string;
  mountpoint: string;
  fstype: string;
  /** the mount source, for example /dev/nvme0n1p2 */
  source: string;
}

/** Fields of /proc/<pid>/mountinfo: `36 35 98:0 /root /mnt rw,noatime master:1 - ext3 /dev/root rw`. */
export function parseMountInfoFull(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 10) continue;
    const dash = f.indexOf("-");
    if (dash < 6) continue;
    out.push({
      dev: f[2] as string,
      mountpoint: unescapeMount(f[4] as string),
      fstype: (f[dash + 1] as string) ?? "",
      source: unescapeMount((f[dash + 2] as string) ?? ""),
    });
  }
  return out;
}

const VIRTUAL = new Set(["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "overlay", "mqueue", "debugfs", "tracefs", "securityfs", "pstore", "bpf", "configfs", "fusectl", "autofs", "hugetlbfs", "binfmt_misc", "nsfs", "squashfs", "ramfs", "efivarfs", "fuse.lxcfs"]);

/** Mounts that sit on a block device (their source is a /dev node): virtual filesystems are left out. */
export function blockMounts(entries: MountEntry[]): MountEntry[] {
  return entries.filter((e) => !VIRTUAL.has(e.fstype) && e.source.startsWith("/dev/"));
}

/** Network and FUSE mounts: no local disk serves them, but a change under one must not be counted under the mount above it. */
export function remoteMounts(entries: MountEntry[]): MountEntry[] {
  return entries.filter((e) => /^(nfs|cifs|smb|fuse|ceph|9p|gluster|lustre|afs)/.test(e.fstype) && e.fstype !== "fuse.lxcfs");
}
