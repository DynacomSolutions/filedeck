import type { PressureCollector } from "./collector.ts";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const lbl = (s: string) => esc(s.length > 80 ? s.slice(0, 80) : s);
const f = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");

/**
 * Prometheus text for the disk pressure. Each call reads once and starts nothing that stays. Only the latest snapshot is shown, so a disk or consumer
 * that is gone leaves no series. Per disk, the 10 busiest cgroup and process consumers; path consumers (they name folders) are never exported.
 */
export async function pressureMetricLines(c: PressureCollector): Promise<string[]> {
  // the scrape is the demand: one read now (its rates cover the time since the previous read), and nothing runs between scrapes
  const s = await c.read().catch(() => undefined);
  const fresh = s !== undefined;
  const L: string[] = [];
  const head = (name: string, help: string, type: "gauge" | "counter") => L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  if (fresh && s) {
    head("filedeck_disk_util_ratio", "Share of time the disk had IO in flight (0 to 1)", "gauge");
    for (const d of s.disks) L.push(`filedeck_disk_util_ratio{disk="${lbl(d.name)}"} ${f(d.util)}`);
    head("filedeck_disk_iops", "IO operations per second", "gauge");
    for (const d of s.disks) L.push(`filedeck_disk_iops{disk="${lbl(d.name)}",op="read"} ${f(d.rIops)}`, `filedeck_disk_iops{disk="${lbl(d.name)}",op="write"} ${f(d.wIops)}`);
    head("filedeck_disk_bytes_per_second", "Bytes per second", "gauge");
    for (const d of s.disks) L.push(`filedeck_disk_bytes_per_second{disk="${lbl(d.name)}",op="read"} ${f(d.rBps)}`, `filedeck_disk_bytes_per_second{disk="${lbl(d.name)}",op="write"} ${f(d.wBps)}`);
    head("filedeck_disk_queue_depth", "Average number of IO requests in the queue", "gauge");
    for (const d of s.disks) L.push(`filedeck_disk_queue_depth{disk="${lbl(d.name)}"} ${f(d.queueDepth)}`);
    head("filedeck_disk_await_seconds", "Average time of an IO request, queue included", "gauge");
    for (const d of s.disks) L.push(`filedeck_disk_await_seconds{disk="${lbl(d.name)}",op="read"} ${f(d.rAwaitMs / 1000)}`, `filedeck_disk_await_seconds{disk="${lbl(d.name)}",op="write"} ${f(d.wAwaitMs / 1000)}`);
    head("filedeck_io_pressure_ratio", "Share of time tasks waited for IO (PSI, 0 to 1)", "gauge");
    for (const kind of ["some", "full"] as const) for (const w of ["avg10", "avg60", "avg300"] as const) L.push(`filedeck_io_pressure_ratio{kind="${kind}",window="${w}"} ${f(s.psi[kind][w] / 100)}`);
    const iops: string[] = [];
    const bps: string[] = [];
    for (const d of s.disks) {
      const merged = new Map<string, { kind: string; label: string; r: number; w: number; rb: number; wb: number }>();
      for (const c2 of d.consumers) {
        if (c2.kind === "path") continue;
        if (merged.size >= 10 && !merged.has(`${c2.kind}|${lbl(c2.label)}`)) continue;
        const k = `${c2.kind}|${lbl(c2.label)}`;
        const m = merged.get(k) ?? { kind: c2.kind, label: lbl(c2.label), r: 0, w: 0, rb: 0, wb: 0 };
        m.r += c2.rIops; m.w += c2.wIops; m.rb += c2.rBps; m.wb += c2.wBps;
        merged.set(k, m);
      }
      for (const m of merged.values()) {
        const base = `disk="${lbl(d.name)}"`;
        const tail = `kind="${m.kind}",consumer="${m.label}"`;
        iops.push(`filedeck_disk_consumer_iops{${base},op="read",${tail}} ${f(m.r)}`, `filedeck_disk_consumer_iops{${base},op="write",${tail}} ${f(m.w)}`);
        bps.push(`filedeck_disk_consumer_bytes_per_second{${base},op="read",${tail}} ${f(m.rb)}`, `filedeck_disk_consumer_bytes_per_second{${base},op="write",${tail}} ${f(m.wb)}`);
      }
    }
    head("filedeck_disk_consumer_iops", "IO operations per second of the busiest consumers of a disk (top 10)", "gauge");
    L.push(...iops);
    head("filedeck_disk_consumer_bytes_per_second", "Bytes per second of the busiest consumers of a disk (top 10)", "gauge");
    L.push(...bps);
  }
  head("filedeck_pressure_probe_seconds_total", "CPU time spent by the disk pressure sampling code", "counter");
  L.push(`filedeck_pressure_probe_seconds_total ${c.probeSeconds.toFixed(6)}`);
  head("filedeck_pressure_source", "1 for the attribution source in use (ebpf or proc)", "gauge");
  for (const src of ["ebpf", "proc"] as const) L.push(`filedeck_pressure_source{source="${src}"} ${c.source === src ? 1 : 0}`);
  return L;
}
