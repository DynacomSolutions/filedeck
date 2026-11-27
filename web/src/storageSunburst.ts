import type { IOPressure, StorageDrive, StorageGroup, StorageNode } from "./storageTypes";

export const storageModes = ["size", "read", "write"] as const;
export type StorageMode = typeof storageModes[number];

export function storageMode(search: string): StorageMode {
  const mode = new URLSearchParams(search).get("storageMode");
  return mode === "read" || mode === "write" ? mode : "size";
}

export function storageModeUrl(href: string, mode: StorageMode): string {
  const url = new URL(href);
  if (mode === "size") url.searchParams.delete("storageMode");
  else url.searchParams.set("storageMode", mode);
  return url.pathname + url.search + url.hash;
}

export interface Slice {
  id: string;
  label: string;
  description: string;
  level: "node" | "drive" | "group";
  start: number;
  end: number;
  bytes: number;
  parent?: string;
  drive?: StorageDrive;
  group?: StorageGroup;
  io?: IOPressure;
}

export function driveLabel(drive: StorageDrive): string {
  return drive.devices.map((device) => device.name).join(" + ") || drive.mounts.join(", ") || "Unknown drive";
}

const driveBytes = (drive: StorageDrive) => drive.groups.reduce((sum, group) => sum + group.bytes, 0);
const nodeBytes = (node: StorageNode) => node.drives.reduce((sum, drive) => sum + driveBytes(drive), 0);

export function storageSlices(nodes: StorageNode[]): { total: number; slices: Slice[] } {
  const total = nodes.reduce((sum, node) => sum + nodeBytes(node), 0);
  const slices: Slice[] = [];
  const span = (bytes: number) => total ? bytes / total * Math.PI * 2 : 0;
  let angle = -Math.PI / 2;
  for (const node of nodes) {
    const nodeId = JSON.stringify([node.node]);
    const nodeStart = angle;
    const size = nodeBytes(node);
    slices.push({ id: nodeId, label: node.node, description: node.node, level: "node", start: nodeStart, end: nodeStart + span(size), bytes: size });
    for (const drive of node.drives) {
      const driveId = JSON.stringify([node.node, drive.id]);
      const driveStart = angle;
      const bytes = driveBytes(drive);
      const label = driveLabel(drive);
      slices.push({ id: driveId, label, description: `${node.node} / ${label}`, level: "drive", parent: nodeId,
        start: driveStart, end: driveStart + span(bytes), bytes, drive, io: drive.io });
      for (const group of drive.groups) {
        const id = JSON.stringify([node.node, drive.id, group.name, !!group.unattributed]);
        const end = angle + span(group.bytes);
        slices.push({ id, label: group.name, description: `${node.node} / ${label} / ${group.name}`, level: "group", parent: driveId,
          start: angle, end, bytes: group.bytes, group, io: group.io });
        angle = end;
      }
    }
  }
  return { total, slices };
}

export const storageRings = { node: [56, 95], drive: [98, 137], group: [140, 190] } as const;
const point = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)];

export function slicePath(slice: Pick<Slice, "start" | "end" | "level">): string {
  const [inner, outer] = storageRings[slice.level];
  const { start, end } = slice;
  const width = end - start;
  if (width <= 0) return "";
  const gap = width >= 2 * Math.PI - 1e-8 ? 0 : Math.min(0.009, width / 5);
  const a = start + gap;
  // SVG cannot describe a complete circle with one arc.
  const b = Math.min(end - gap, a + 2 * Math.PI - 1e-6);
  const long = b - a > Math.PI ? 1 : 0;
  return `M ${point(outer, a)} A ${outer} ${outer} 0 ${long} 1 ${point(outer, b)} L ${point(inner, b)} A ${inner} ${inner} 0 ${long} 0 ${point(inner, a)} Z`;
}

export function sliceLabel(slice: Slice): { text: string; x: number; y: number; angle: number } | null {
  const [inner, outer] = storageRings[slice.level];
  const r = (inner + outer) / 2;
  const arc = slice.end - slice.start;
  if (arc < 0.48) return null;
  const a = (slice.start + slice.end) / 2;
  const [x = 0, y = 0] = point(r, a);
  const rot = a * 180 / Math.PI + 90;
  const angle = rot > 90 && rot < 270 ? rot - 180 : rot;
  const characters = Math.min(22, Math.floor(r * (arc - 0.09) / 7));
  const text = slice.label.length <= characters ? slice.label : slice.label.slice(0, characters - 1) + "…";
  return { text, x, y, angle };
}

export function sliceValue(slice: Slice, mode: StorageMode): number | null {
  return mode === "size" ? slice.bytes : slice.io?.[mode]?.mean ?? null;
}
