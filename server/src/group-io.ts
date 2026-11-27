import { GroupMetrics } from "./group-metrics.ts";
import type { GroupRule } from "./group-rules.ts";
import type { AgentGroups } from "./group-agent.ts";
import type { GroupsResult, IOPressure, Statistics, StorageNode } from "./group-types.ts";

const metrics = [
  ["drive_read", "node_disk_read_bytes_total"],
  ["drive_write", "node_disk_written_bytes_total"],
  ["drive_utilisation", "node_disk_io_time_seconds_total"],
  ["group_read", "container_fs_reads_bytes_total"],
  ["group_write", "container_fs_writes_bytes_total"],
  ["group_utilisation", "container_fs_io_time_seconds_total"],
] as const;

type Kind = typeof metrics[number][0];
type Series = { metric: Record<string, string>; values: [number, string][] };
type Snapshot = { sampledAt: number; byNode: Map<string, Series[]> };
const windowSeconds = 3600;
const intervalSeconds = 60;

export function ioStatistics(values: number[]): Statistics | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const quarterEnd = Math.ceil(sorted.length / 4);
  const mid = (quarterEnd - 1) / 2;
  return {
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    resting: (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2,
  };
}

function summarise(series: Series[], kind: Kind): Statistics | null {
  const totals = new Map<number, number>();
  const isBusy = kind.endsWith("utilisation");
  const seen = new Map<string, Map<number, number>>();
  for (const { metric, values } of series) {
    if (metric.filedeck_io_kind !== kind) continue;
    const key = JSON.stringify(kind.startsWith("drive") ? [metric.device] :
      [metric.namespace, metric.pod, metric.container, metric.device, metric.id ?? metric.cgroup]);
    const samples = seen.get(key) ?? new Map<number, number>();
    seen.set(key, samples);
    for (const [time, raw] of values) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || raw.trim() === "") continue;
      // Two scrapes of one device or container must not add its throughput twice.
      samples.set(time, Math.max(value, samples.get(time) ?? 0));
    }
  }
  for (const samples of seen.values()) {
    for (const [time, value] of samples) {
      const prior = totals.get(time) ?? 0;
      totals.set(time, isBusy ? Math.max(prior, Math.min(value * 100, 100)) : prior + value);
    }
  }
  return ioStatistics([...totals.values()]);
}

function pressure(series: Series[], scope: "drive" | "group"): IOPressure {
  return {
    read: summarise(series, `${scope}_read`),
    write: summarise(series, `${scope}_write`),
    utilisation: summarise(series, `${scope}_utilisation`),
  };
}

const responseLimit = 8 * 1024 * 1024;

class OversizeResponse extends Error {}

async function readMatrix(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing IO response body");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        throw new OversizeResponse("IO response exceeds the byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export class GroupIO {
  readonly metrics = new GroupMetrics("group_io");
  private snapshot?: Snapshot;
  private lastAttempt = -Infinity;
  private pending?: Promise<void>;
  private failed = false;
  private oversizeResponses = 0;

  constructor(
    private readonly base?: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly nodes: string[] = [],
    private readonly rulesByNode: ReadonlyMap<string, GroupRule[]> = new Map(),
    private readonly maxResponseBytes = responseLimit,
  ) {}

  metricLines(): string[] {
    const name = "filedeck_group_io_oversize_responses_total";
    return [
      ...this.metrics.lines(),
      `# HELP ${name} Number of IO responses rejected at the byte limit`,
      `# TYPE ${name} counter`,
      `${name} ${this.oversizeResponses}`,
    ];
  }

  private containerSelectors(): string[] {
    const selectors = new Set<string>();
    for (const [node, rules] of this.rulesByNode) {
      for (const { labels } of rules) {
        const matchers = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
        if (!matchers.length) continue;
        const exact = matchers.map(([key, value]) => `${key}=${JSON.stringify(value)}`);
        selectors.add([`node=${JSON.stringify(node)}`, 'container!=""', 'container!="POD"', ...exact].join(","));
      }
    }
    return [...selectors];
  }

  private async collect() {
    this.metrics.requests++;
    try {
      const url = new URL(this.base!.replace(/\/+$/, "") + "/api/v1/query_range");
      const sampledAt = this.now();
      const end = Math.floor(sampledAt / 1000 / intervalSeconds) * intervalSeconds;
      const nodePattern = this.nodes.map((node) => node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const nodeLabels = nodePattern ? `node=~${JSON.stringify(nodePattern)}` : 'node!=""';
      const containerSelectors = this.containerSelectors();
      const query = metrics.flatMap(([kind, metric]) => {
        const selectors = kind.startsWith("group") ? containerSelectors : [nodeLabels];
        return selectors.map((selector) => `label_set(rate(${metric}{${selector}}[5m]), "filedeck_io_kind", "${kind}")`);
      }).join(" or ");
      const body = new URLSearchParams({ query, start: String(end - windowSeconds), end: String(end), step: String(intervalSeconds) });
      const res = await this.request(url, { method: "POST", body, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error("IO query failed");
      }
      const result = await readMatrix(res, this.maxResponseBytes) as { status: string; data?: { resultType: string; result: Series[] } };
      if (result.status !== "success" || result.data?.resultType !== "matrix" || !Array.isArray(result.data.result)) throw new Error("invalid IO response");
      const byNode = new Map<string, Series[]>();
      for (const series of result.data.result) {
        const node = series.metric?.node;
        if (!node || !Array.isArray(series.values)) continue;
        const rows = byNode.get(node) ?? [];
        rows.push(series);
        byNode.set(node, rows);
      }
      this.snapshot = { sampledAt, byNode };
      this.failed = false;
      this.metrics.lastSuccess = this.now();
    } catch (error) {
      if (error instanceof OversizeResponse) this.oversizeResponses++;
      this.metrics.errors++;
      this.failed = true;
    }
  }

  async join(nodes: AgentGroups[], unavailable: string[], sizesOnly = false): Promise<GroupsResult> {
    const bare: StorageNode[] = nodes.map(({ node, drives }) => ({
      node, drives: drives.map((drive) => ({
        ...drive, groups: drive.groups.map(({ ioDevices: _, ...group }) => group),
      })),
    }));
    if (!this.base || sizesOnly) return { nodes: bare, unavailable, io: { status: "disabled" } };
    if (this.now() - this.lastAttempt >= intervalSeconds * 1000 && !this.pending) {
      this.lastAttempt = this.now();
      this.pending = this.collect().finally(() => { this.pending = undefined; });
    }
    await this.pending;
    const snapshot = this.snapshot;
    if (!snapshot) return { nodes: bare, unavailable, io: { status: "unavailable" } };
    return {
      unavailable,
      io: { status: "available", sampledAt: snapshot.sampledAt, stale: this.failed },
      nodes: nodes.map(({ node, drives, labels }) => {
        const series = snapshot.byNode.get(node) ?? [];
        const labelSets = new Map(labels.map(({ name, match }) => [name, Object.entries(match)]));
        return { node, drives: drives.map((drive) => {
          const devices = new Set(drive.devices.map((d) => d.name));
          const io = pressure(series.filter((s) => s.metric.device && devices.has(s.metric.device)), "drive");
          return {
            ...drive, io,
            groups: drive.groups.map(({ ioDevices, ...group }) => {
              const match = labelSets.get(group.name);
              if (group.unattributed || !match?.length) return group;
              const groupDevices = new Set(ioDevices ?? []);
              const groupSeries = series.filter((s) =>
                match.every(([key, value]) => s.metric[key] === value) &&
                (s.metric.device === undefined || (groupDevices.has(s.metric.device) || groupDevices.has(s.metric.device.replace(/^\/dev\//, "")))));
              return { ...group, io: pressure(groupSeries, "group") };
            }),
          };
        }) };
      }),
    };
  }
}
