import { posix } from "node:path";
import { containsPath, type GroupRule } from "./group-rules.ts";
import type { GroupMount } from "./group-mounts.ts";
import type { StorageDrive, StorageGroup } from "./group-types.ts";

export interface StoredGroupSize {
  dev: number;
  bytes: number;
  scannedAt: number;
  stale: boolean;
  errors: number;
  files: number;
  links: number;
  linkChecked: number;
}

type Space = { used: number; capacity: number };
type Cut = { path: string; mount: GroupMount; rule: GroupRule | null; alias?: boolean; remapped?: boolean };
type GroupTotal = StorageGroup & { files: number; links: number; checked: number; ioDevices: Set<string> };
export type MeasuredDrive = Omit<StorageDrive, "groups"> & { groups: (StorageGroup & { ioDevices?: string[] })[] };

const deepest = <T extends { mountpoint: string }>(mounts: T[], p: string): T | undefined =>
  mounts.find((m) => containsPath(m.mountpoint, p));

function deviceNumber(dev: string): number {
  const [major = 0n, minor = 0n] = dev.split(":").map(BigInt);
  return Number(((major & 0xfffn) << 8n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n));
}

function mountAliases(mounts: GroupMount[]): Map<string, GroupMount> {
  const aliases = new Map<string, GroupMount>();
  const ordered = [...mounts].sort((a, b) => a.root.length - b.root.length ||
    a.id - b.id || a.mountpoint.localeCompare(b.mountpoint));
  for (const [i, m] of ordered.entries()) {
    const source = ordered.slice(0, i).find((other) => {
      if (other.fsKey !== m.fsKey || other.dev !== m.dev || !containsPath(other.root, m.root)) return false;
      const p = posix.join(other.mountpoint, posix.relative(other.root, m.root));
      return deepest(mounts, p) === other;
    });
    if (source) aliases.set(m.mountpoint, source);
  }
  return aliases;
}

function buildCuts(mounts: GroupMount[], aliases: Map<string, GroupMount>, rules: GroupRule[]): Cut[] {
  const cuts = new Map<string, Cut>();
  const requested = rules.flatMap((rule) => [
    ...rule.paths.map((path) => ({ path, rule })),
    ...rule.exclude.map((path) => ({ path, rule: null })),
  ]);
  for (const m of mounts) {
    if (aliases.has(m.mountpoint)) continue;
    const inherited = requested.filter((r) => containsPath(r.path, m.mountpoint))
      .sort((a, b) => b.path.length - a.path.length || Number(!!b.rule) - Number(!!a.rule))[0];
    if (inherited?.rule) cuts.set(m.mountpoint, { path: m.mountpoint, mount: m, rule: inherited.rule });
  }
  for (const r of requested) {
    const mount = deepest(mounts, r.path);
    if (!mount) continue;
    const source = aliases.get(mount.mountpoint);
    const path = source ? posix.join(source.mountpoint, posix.relative(source.root, mount.root), posix.relative(mount.mountpoint, r.path)) : r.path;
    const prior = cuts.get(path);
    if (!prior || (prior.remapped && !source) || (!source && (prior.path === prior.mount.mountpoint || r.rule))) {
      cuts.set(path, { path, mount: source ?? mount, rule: r.rule, remapped: !!source });
    }
  }
  for (const m of mounts) {
    if (!aliases.has(m.mountpoint)) continue;
    const above = deepest(mounts.filter((p) => p !== m), m.mountpoint);
    if (above?.dev === m.dev) cuts.set(m.mountpoint, { path: m.mountpoint, mount: above, rule: null, alias: true });
  }
  return [...cuts.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
}

const empty = (name: string): GroupTotal =>
  ({ name, bytes: 0, scannedAt: null, stale: false, notStored: false, errors: 0, hardLinks: "unknown", files: 0, links: 0, checked: 0, ioDevices: new Set() });

export async function groupStorage(
  mountTable: GroupMount[],
  rules: GroupRule[],
  stored: (path: string) => Promise<StoredGroupSize | null>,
  stat: (mountpoint: string) => Promise<Space | null>,
  isStorage: (mount: GroupMount) => boolean,
): Promise<MeasuredDrive[]> {
  const mounts = [...mountTable].sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  const aliases = mountAliases(mounts);
  const cuts = buildCuts(mounts, aliases, rules);
  const children = new Map<Cut, Cut[]>();
  const indexed = new Map<string, Cut>();
  for (const c of cuts) {
    for (let p = c.path; p !== "/"; ) {
      p = posix.dirname(p);
      const parent = indexed.get(p);
      if (parent?.mount === c.mount) {
        children.get(parent)?.push(c);
        break;
      }
    }
    indexed.set(c.path, c);
    children.set(c, []);
  }
  const volumes = new Map<string, { mount: GroupMount; groups: Map<string, GroupTotal>; mounts: Set<string> }>();
  for (const m of mounts.filter(isStorage)) {
    const canonical = aliases.get(m.mountpoint) ?? m;
    const vol = volumes.get(m.fsKey) ?? { mount: canonical, groups: new Map(), mounts: new Set() };
    if (canonical.root.length < vol.mount.root.length) vol.mount = canonical;
    if (!aliases.has(m.mountpoint)) vol.mounts.add(m.mountpoint);
    volumes.set(m.fsKey, vol);
  }
  const reads = new Map<Cut, StoredGroupSize | null>();
  const get = async (cut: Cut) => {
    if (!reads.has(cut)) {
      const row = await stored(cut.path);
      reads.set(cut, row?.dev === deviceNumber(cut.mount.dev) ? row : null);
    }
    return reads.get(cut) ?? null;
  };
  for (const c of cuts) {
    const vol = volumes.get(c.mount.fsKey);
    if (!c.rule || !vol || !isStorage(c.mount)) continue;
    const group = vol.groups.get(c.rule.name) ?? empty(c.rule.name);
    vol.groups.set(c.rule.name, group);
    const row = await get(c);
    if (!row) {
      group.notStored = true;
      continue;
    }
    const deductions = [];
    for (const child of children.get(c) ?? []) {
      const item = await get(child);
      if (item) deductions.push(item);
      else group.notStored = true;
    }
    const needed = (children.get(c) ?? []).length;
    for (const sample of [row, ...deductions]) {
      group.stale ||= sample.stale;
      group.scannedAt = Math.min(group.scannedAt ?? Infinity, sample.scannedAt);
    }
    if (deductions.length !== needed) continue;
    const bytes = row.bytes - deductions.reduce((sum, child) => sum + child.bytes, 0);
    group.stale ||= bytes < 0;
    group.bytes += Math.max(0, bytes);
    group.files += row.files - deductions.reduce((sum, child) => sum + child.files, 0);
    group.links += row.links - deductions.reduce((sum, child) => sum + child.links, 0);
    group.checked += row.linkChecked - deductions.reduce((sum, child) => sum + child.linkChecked, 0);
    group.errors += Math.max(0, row.errors - deductions.reduce((sum, child) => sum + child.errors, 0));
  }
  const drives = new Map<string, MeasuredDrive>();
  const totalsByDrive = new Map<string, Map<string, GroupTotal>>();
  for (const { mount, groups, mounts: paths } of volumes.values()) {
    const id = mount.drives.length ? JSON.stringify(mount.drives.map((d) => d.name)) : mount.fsKey;
    const drive = drives.get(id) ?? { id, devices: mount.drives, mounts: [], usedBytes: 0, capacityBytes: 0, overageBytes: 0, groups: [] };
    drive.mounts.push(...paths);
    const ioDevices = mounts.filter((m) => m.fsKey === mount.fsKey)
      .flatMap((m) => [m.device, m.metricDevice].filter((d): d is string => !!d));
    const space = await stat(mount.mountpoint);
    drive.usedBytes = space && drive.usedBytes !== null ? drive.usedBytes + space.used : null;
    drive.capacityBytes = space && drive.capacityBytes !== null ? drive.capacityBytes + space.capacity : null;
    const attributed = [...groups.values()].reduce((sum, g) => sum + g.bytes, 0);
    if (space) drive.overageBytes += Math.max(0, attributed - space.used);
    const totals = totalsByDrive.get(id) ?? new Map<string, GroupTotal>();
    for (const [name, group] of groups) {
      const total = totals.get(name) ?? empty(name);
      for (const key of ["bytes", "errors", "files", "links", "checked"] as const) total[key] += group[key];
      if (group.scannedAt !== null) total.scannedAt = Math.min(total.scannedAt ?? Infinity, group.scannedAt);
      total.stale ||= group.stale;
      total.notStored ||= group.notStored;
      for (const device of ioDevices) total.ioDevices.add(device);
      totals.set(name, total);
    }
    totalsByDrive.set(id, totals);
    const remainder = space ? Math.max(0, space.used - attributed) : 0;
    if (remainder) {
      const previous = drive.groups[0]?.bytes ?? 0;
      drive.groups[0] = { name: "Unattributed", bytes: previous + remainder, unattributed: true,
        notStored: false, stale: false, scannedAt: null, errors: 0, hardLinks: "unknown" };
    }
    drives.set(id, drive);
  }
  for (const [id, drive] of drives) {
    for (const { files, links, checked, ioDevices, ...group } of totalsByDrive.get(id)!.values()) {
      group.hardLinks = checked > 0 && links >= 10 && links / checked >= 0.1 ? "heavy" :
        checked === files && !group.notStored && links >= 0 ? "normal" : "unknown";
      drive.groups.unshift({ ...group, ioDevices: [...ioDevices] });
    }
  }
  return [...drives.values()].sort((a, b) => a.id.localeCompare(b.id));
}
