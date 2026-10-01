import fs from "node:fs/promises";
import path from "node:path";

export interface Mount {
  device: string;
  mountpoint: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
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
    try {
      const real = path.join(root, m.mountpoint);
      const s = await fs.statfs(real);
      const total = s.blocks * s.bsize;
      res.push({ ...m, total, free: s.bavail * s.bsize, used: total - s.bfree * s.bsize });
    } catch {
      // unreadable mount (permission, stale NFS): skip
    }
  }
  return res.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}
