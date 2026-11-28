import path from "node:path";
import type { PodInfo } from "./pod-watch.ts";

/** A stored folder total: `bytes` are disk bytes, `stale` when the store cannot vouch for the row at this moment. */
export type StoredSize = { bytes: number; stale: boolean } | null;

/** The paths of `FILEDECK_SIZE_GAUGES`: separated by line feeds, semicolons or commas; each must be absolute. */
export function parseSizeGauges(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\n;,]/)) {
    const t = raw.trim();
    if (!t) continue;
    if (!t.startsWith("/")) throw new Error(`FILEDECK_SIZE_GAUGES: "${t.slice(0, 80)}" is not an absolute path`);
    out.add(path.posix.normalize(t).replace(/(.)\/+$/, "$1"));
  }
  return [...out];
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));

/** The mount point that holds a container id: containerd mounts a container's root at `.../<64 hex id>/rootfs`. */
const ROOTFS = /\/([0-9a-f]{64})\/rootfs$/;

/**
 * The writable layer of each running container, from the host mount table (`/proc/<pid>/mounts` format): an overlay mount whose point ends in
 * `<container id>/rootfs` and whose options name `upperdir=`. A stopped container has no mount, so it has no layer here.
 */
export function overlayUppers(mounts: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of mounts.split("\n")) {
    const f = line.split(" ");
    const [, point = "", type, options = ""] = f;
    if (f.length < 4 || type !== "overlay") continue;
    const id = ROOTFS.exec(unescapeMount(point))?.[1];
    const upper = /(?:^|,)upperdir=([^,]+)/.exec(options)?.[1];
    if (id && upper) out.set(id, unescapeMount(upper));
  }
  return out;
}

export interface GaugeDeps {
  /** the node label */
  node: string;
  /** configured paths for `filedeck_path_bytes` */
  paths: string[];
  /** the store's answer for one folder, without any walk or job */
  size: (virtual: string) => Promise<StoredSize>;
  /** pod ephemeral storage: off when absent */
  pods?: {
    list: () => PodInfo[];
    synced: () => boolean;
    mounts: () => Promise<string>;
    podsDir: string;
    logsDir: string;
  };
}

/** The folders that kubelet counts for a pod: its local volumes, its container log folder and the writable layer of each running container. */
export function podParts(p: PodInfo, uppers: Map<string, string>, podsDir: string, logsDir: string): string[] {
  const parts = p.volumes.map((v) => path.posix.join(podsDir, p.uid, "volumes", v.plugin, v.name));
  parts.push(path.posix.join(logsDir, `${p.namespace}_${p.name}_${p.uid}`));
  for (const id of p.containerIds) {
    const upper = uppers.get(id);
    if (upper) parts.push(upper);
  }
  return parts;
}

/**
 * Prometheus lines for the size gauges. Every value is read from the size store at scrape time: this never walks and never starts a job. A folder the store does
 * not hold gives no series and raises a `_missing` gauge. A stored row that the store cannot vouch for at this moment keeps its value and gets `stale="true"`.
 */
export async function sizeGaugeLines(d: GaugeDeps): Promise<string[]> {
  const lines: string[] = [];
  const node = esc(d.node);
  if (d.paths.length) {
    let missing = 0;
    const rows: string[] = [];
    for (const p of d.paths) {
      const s = await d.size(p);
      if (!s) missing++;
      else rows.push(`filedeck_path_bytes{node="${node}",path="${esc(p)}"${s.stale ? ',stale="true"' : ""}} ${s.bytes}`);
    }
    lines.push(
      '# HELP filedeck_path_bytes Disk bytes of a configured folder, from the size store (no walk). Stale rows carry stale="true"',
      "# TYPE filedeck_path_bytes gauge",
      ...rows,
      "# HELP filedeck_path_bytes_missing Configured folders that the size store does not hold: they have no series",
      "# TYPE filedeck_path_bytes_missing gauge",
      `filedeck_path_bytes_missing ${missing}`,
    );
  }
  if (d.pods) {
    const uppers = overlayUppers(await d.pods.mounts().catch(() => ""));
    let missing = 0;
    const rows: { labels: string; bytes: number }[] = [];
    for (const p of d.pods.list()) {
      let bytes = 0;
      let stale = false;
      let all = true;
      for (const part of podParts(p, uppers, d.pods.podsDir, d.pods.logsDir)) {
        const s = await d.size(part);
        if (!s) {
          all = false;
          break;
        }
        bytes += s.bytes;
        stale ||= s.stale;
      }
      if (!all) {
        missing++;
        continue;
      }
      rows.push({ labels: `node="${node}",namespace="${esc(p.namespace)}",pod="${esc(p.name)}",pod_uid="${esc(p.uid)}"${stale ? ',stale="true"' : ""}`, bytes });
    }
    lines.push(
      "# HELP agent_resource_pod_ephemeral_storage_used_bytes Ephemeral storage of a pod on this node, from the size store: local volumes, logs and container writable layers",
      "# TYPE agent_resource_pod_ephemeral_storage_used_bytes gauge",
      ...rows.map((r) => `agent_resource_pod_ephemeral_storage_used_bytes{${r.labels}} ${r.bytes}`),
      "# HELP filedeck_pod_ephemeral_storage_bytes The same value under the FileDeck name",
      "# TYPE filedeck_pod_ephemeral_storage_bytes gauge",
      ...rows.map((r) => `filedeck_pod_ephemeral_storage_bytes{${r.labels}} ${r.bytes}`),
      "# HELP filedeck_pod_ephemeral_storage_missing Pods of this node with a part that the size store does not hold: they have no series",
      "# TYPE filedeck_pod_ephemeral_storage_missing gauge",
      `filedeck_pod_ephemeral_storage_missing ${missing}`,
      "# HELP filedeck_pod_watch_synced 1 when the pod list of this node is loaded and kept current by the watch",
      "# TYPE filedeck_pod_watch_synced gauge",
      `filedeck_pod_watch_synced ${d.pods.synced() ? 1 : 0}`,
    );
  }
  return lines;
}
