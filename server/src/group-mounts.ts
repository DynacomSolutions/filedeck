import fs from "node:fs/promises";
import path from "node:path";
import { containsPath } from "./group-rules.ts";
import { networkKind, unescapeMount } from "./mounts.ts";

export interface MountIdentity {
  id: number;
  dev: string;
  root: string;
  mountpoint: string;
  device: string;
  fstype: string;
}

export interface BlockDrive {
  name: string;
  model: string | null;
}

export interface GroupMount extends MountIdentity {
  fsKey: string;
  metricDevice?: string;
  drives: BlockDrive[];
}

export function parseMountInfo(text: string, root = "/"): MountIdentity[] {
  const mounts = new Map<string, MountIdentity>();
  for (const line of text.split("\n")) {
    const [before, after] = line.split(" - ");
    const [id, , dev, fsRoot, mountpoint] = before?.split(" ") ?? [];
    const [fstype, device] = after?.split(" ") ?? [];
    if (!id || !dev || !fsRoot || !mountpoint || !fstype || !device || !/^\d+:\d+$/.test(dev)) continue;
    const full = unescapeMount(mountpoint);
    if (!containsPath(root, full)) continue;
    const visible = root === "/" ? full : full.slice(root.length) || "/";
    mounts.set(visible, { id: Number(id), dev, root: unescapeMount(fsRoot), mountpoint: visible, fstype, device: unescapeMount(device) });
  }
  return [...mounts.values()];
}

export function mountInfoForRoot(mounts: MountIdentity[], root: string): MountIdentity[] {
  if (root === "/") return mounts;
  const parents = mounts.filter((m) => containsPath(m.mountpoint, root));
  const parent = parents.sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
  return [
    ...parent && parent.mountpoint !== root ? [{ ...parent, mountpoint: "/", root: path.posix.join(parent.root, path.posix.relative(parent.mountpoint, root)) }] : [],
    ...mounts.filter((m) => containsPath(root, m.mountpoint))
      .map((m) => ({ ...m, mountpoint: m.mountpoint.slice(root.length) || "/" })),
  ];
}

const namesIn = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);
const readText = (file: string) => fs.readFile(file, "utf8").then((s) => s.trim()).catch(() => "");
const real = (file: string) => fs.realpath(file).catch(() => "");
const blockName = /^[a-zA-Z0-9][a-zA-Z0-9_.!-]*$/;

export class DriveMap {
  private readonly blocks = new Map<string, Promise<BlockDrive[]>>();
  private btrfs?: Promise<string[][]>;

  constructor(private readonly sys: string, private readonly devDir: string) {}

  private async leaves(name: string, seen: Set<string>): Promise<BlockDrive[]> {
    if (!blockName.test(name) || seen.has(name)) return [];
    seen.add(name);
    const entry = path.join(this.sys, "class/block", name);
    const target = await real(entry);
    if (!target) return [];
    const slaves = await namesIn(path.join(entry, "slaves"));
    if (slaves.length) {
      const drives = [];
      for (const slave of slaves) drives.push(...await this.leaves(slave, seen));
      return drives;
    }
    if (await readText(path.join(entry, "partition"))) {
      return this.leaves(path.basename(path.dirname(target)), seen);
    }
    return [{ name, model: await readText(path.join(entry, "device/model")) || null }];
  }

  async describe(mount: MountIdentity): Promise<Pick<GroupMount, "drives" | "fsKey" | "metricDevice">> {
    const byNumber = path.basename(await real(path.join(this.sys, "dev/block", mount.dev)));
    const source = mount.device.startsWith("/dev/") ? path.join(this.devDir, mount.device.slice(5)) : "";
    const bySource = source ? path.basename(await real(source) || source) : "";
    const name = byNumber || bySource;
    let devices = name ? [name] : [];
    let fsKey = `${mount.fstype}:${mount.dev}`;
    if (mount.fstype === "btrfs" && name) {
      this.btrfs ??= namesIn(path.join(this.sys, "fs/btrfs")).then((ids) =>
        Promise.all(ids.map((id) => namesIn(path.join(this.sys, "fs/btrfs", id, "devices")))));
      devices = (await this.btrfs).find((members) => members.includes(name))?.sort() ?? devices;
      fsKey = `btrfs:${devices.join(",")}`;
    }
    const drives = new Map<string, BlockDrive>();
    for (const device of devices) {
      let reading = this.blocks.get(device);
      if (!reading) {
        reading = this.leaves(device, new Set());
        this.blocks.set(device, reading);
      }
      for (const drive of await reading) drives.set(drive.name, drive);
    }
    return { fsKey, metricDevice: name || undefined, drives: [...drives.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
}

export async function groupMounts(root: string, procMounts: string): Promise<MountIdentity[]> {
  const mountinfo = procMounts.replace(/\/mounts$/, "/mountinfo");
  const mounts = parseMountInfo(await readText(mountinfo));
  if (mounts.length) return mountInfoForRoot(mounts, procMounts === "/proc/mounts" ? root : "/");
  return mountInfoForRoot(parseMountInfo(await readText("/proc/self/mountinfo")), root);
}

const virtualTypes = new Set(["tmpfs", "devtmpfs", "ramfs", "proc", "sysfs", "overlay", "squashfs", "autofs"]);
export const isStorageMount = (m: MountIdentity): boolean =>
  !networkKind(m.fstype) && !virtualTypes.has(m.fstype) && m.device.startsWith("/dev/");
