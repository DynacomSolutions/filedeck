import { useRef, type MouseEvent, type ReactNode } from "react";
import useSWR from "swr";
import { ArrowLeft, Gauge } from "lucide-react";
import { BACKGROUND_HEADER, type NodeInfo } from "./api";
import { PressureChart } from "./PressureChart";
import { PressureTable } from "./PressureTable";
import { StatusTime } from "./StatusJobsPanel";
import {
  fmtIops, fmtMBps, fmtMs, fmtPercent, fmtPsi, inOrder, parseNodeSummaries, windowSamples,
  type PressureNodeSummary, type PressureSource,
} from "./pressure";
import { PRESSURE_DEFAULTS, PRESSURE_GROUPS, PRESSURE_TOPS, PRESSURE_WINDOWS, statusUrl, type StatusRoute } from "./statusRoute";
import { usePressureStream } from "./usePressureStream";

const NODES_URL = "/api/v1/pressure/nodes";
const SUMMARY_REFRESH_MS = 5000;

class PressureHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function getSummaries(url: string): Promise<PressureNodeSummary[]> {
  const response = await fetch(url, { headers: BACKGROUND_HEADER, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new PressureHttpError(response.status === 404 || response.status === 501 ? "This hub does not provide disk pressure yet." : `Disk pressure is unavailable (HTTP ${response.status}).`, response.status);
  return parseNodeSummaries(await response.json());
}

/** The per-node disk summary, refreshed while the page is visible. */
export function usePressureNodes(enabled: boolean) {
  const { data, error, isLoading } = useSWR(enabled ? NODES_URL : null, getSummaries, {
    refreshInterval: SUMMARY_REFRESH_MS, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  });
  return { data, error: error as Error | undefined, isLoading };
}

const modified = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.button !== 0;

/** A link inside the status page: the address is real, a plain click moves in the page without a reload. */
export function PressureLink({ to, navigate, children, className = "btn-a", onNavigated, label }: {
  to: StatusRoute;
  navigate: (route: StatusRoute) => void;
  children: ReactNode;
  className?: string;
  onNavigated?: () => void;
  label?: string;
}) {
  return <a data-nav className={className} href={statusUrl(to, "")} aria-label={label} onClick={(e) => {
    if (modified(e)) return;
    e.preventDefault();
    navigate(to);
    onNavigated?.();
  }}>{children}</a>;
}

const sourceLabel: Record<PressureSource, string> = { ebpf: "eBPF", proc: "proc" };
const sourceHint: Record<PressureSource, string> = {
  ebpf: "Attribution from block IO tracing, per request.",
  proc: "Attribution estimated from the proc and cgroup counters. It is less exact than eBPF.",
};

export function SourceBadge({ source }: { source: PressureSource }) {
  return <span className="pressure-badge pressure-source" title={sourceHint[source]}>Source: {sourceLabel[source]}</span>;
}

const busiest = (entry: PressureNodeSummary) => [...entry.disks].sort((a, b) => b.util - a.util || (a.name < b.name ? -1 : 1))[0];

/** A short list of nodes with their busiest disk, for the status overview and the node health cards. */
export function PressureSummary({ entries, route, navigate, heading = true }: {
  entries: readonly PressureNodeSummary[];
  route: StatusRoute;
  navigate: (route: StatusRoute) => void;
  heading?: boolean;
}) {
  const id = "pressure-summary-" + (heading ? "all" : entries[0]?.node ?? "node");
  return (
    <section className={heading ? "status-section" : "status-card"} aria-labelledby={id}>
      {heading
        ? <div className="status-section-head"><div><h2 id={id}>Disk pressure</h2><p>The busiest disk of each node, now.</p></div>
          <PressureLink to={{ ...route, section: "disks", disk: undefined, job: undefined }} navigate={navigate}><Gauge size={16} aria-hidden="true" /> Open disk pressure</PressureLink></div>
        : <h4 id={id}>Disk pressure</h4>}
      <ul className="status-rows pressure-summary" aria-label="Disk pressure by node">
        {entries.map((entry) => {
          const top = busiest(entry);
          return (
            <li className={heading ? "status-row pressure-summary-row" : "pressure-summary-row"} key={entry.node}>
              <strong>{entry.node}</strong>
              {top
                ? <PressureLink to={{ ...route, node: entry.node, section: "disks", disk: top.name, job: undefined }} navigate={navigate}>{top.name}</PressureLink>
                : <span className="status-subtitle">No disk data</span>}
              {top && <span className="status-subtitle">{fmtPercent(top.util)} busy · PSI full {fmtPsi(top.psiFull10)}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Bar({ ratio }: { ratio: number }) {
  return <span className="pressure-bar" aria-hidden="true"><span className="pressure-bar-read" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></span>;
}

function DiskList({ route, navigate, entries, nodes, moved }: { route: StatusRoute; navigate: (route: StatusRoute) => void; entries: readonly PressureNodeSummary[]; nodes?: readonly NodeInfo[]; moved: () => void }) {
  const shown = route.node ? entries.filter((entry) => entry.node === route.node) : entries;
  if (!shown.length) return <p className="status-message">{route.node ? `No disk pressure data for ${route.node}.` : "No nodes report disk pressure."}</p>;
  return <>
    {shown.map((entry) => {
      const offline = nodes?.find((node) => node.name === entry.node)?.online === false;
      return (
        <section className="status-node" key={entry.node} aria-labelledby={`pressure-node-${entry.node}`}>
          <div className="status-node-head">
            <h3 id={`pressure-node-${entry.node}`}>{entry.node}</h3>
            <span className="status-subtitle">{entry.source && <SourceBadge source={entry.source} />} {entry.at !== undefined && <>Updated <StatusTime at={entry.at} /></>}</span>
          </div>
          {offline && <p className="status-message" role="status">Node offline. The numbers are the last known ones.</p>}
          {entry.disks.length === 0 ? <p className="status-message">No disk data for this node.</p> : (
            <div className="pressure-table-wrap" role="region" aria-label={`Disks of ${entry.node}`} tabIndex={0}>
              <table className="pressure-table">
                <thead><tr><th scope="col">Disk</th><th scope="col" className="num">Busy</th><th scope="col">Load</th><th scope="col" className="num">PSI full (10 s)</th></tr></thead>
                <tbody>
                  {[...entry.disks].sort((a, b) => (a.name < b.name ? -1 : 1)).map((disk) => (
                    <tr key={disk.name}>
                      <th scope="row"><PressureLink to={{ ...route, node: entry.node, section: "disks", disk: disk.name }} navigate={navigate} onNavigated={moved}>{disk.name}</PressureLink></th>
                      <td className="num">{fmtPercent(disk.util)}</td>
                      <td><Bar ratio={disk.util} /></td>
                      <td className="num">{fmtPsi(disk.psiFull10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      );
    })}
  </>;
}

function LiveDisk({ node, disk, windowMin, group, top, offline }: { node: string; disk: string; windowMin: number; group: NonNullable<StatusRoute["group"]>; top: number; offline: boolean }) {
  const url = offline ? null : "/api/v1/pressure/stream?" + new URLSearchParams({ node, disk, top: String(top) });
  const state = usePressureStream(url, disk);
  const current = state.latest?.disks.find((d) => d.name === disk);
  const samples = windowSamples(state.samples, windowMin);
  const collected = samples.length > 1 ? samples.at(-1)!.at - samples[0]!.at : 0;
  const intervalMs = state.latest?.intervalMs ?? 1000;
  const consumers = current ? inOrder(current.consumers.filter((c) => c.kind === group), state.order?.ids ?? []) : [];
  const status = offline ? { status: "offline", message: "Node offline. Disk pressure resumes when it is back." } : state;
  return (
    <>
      <div className="pressure-status">
        <p role="status" className={`pressure-state pressure-state-${status.status}`}>{status.message}</p>
        {state.latest && !offline && <span className="status-subtitle">{state.latest.source && <SourceBadge source={state.latest.source} />} Updated <StatusTime at={state.latest.at} /></span>}
        {collected > 0 && collected < windowMin * 60_000 - 5000 && <span className="status-subtitle">Collecting history: {Math.round(collected / 1000)} s of {windowMin} min</span>}
      </div>
      {!offline && state.missing && <p className="status-message">No data for disk {disk} on {node}. The node does not report it.</p>}
      {!offline && !state.latest && state.status === "live" && <p className="status-message">Waiting for the first sample…</p>}
      {current && (
        <dl className="status-facts pressure-facts">
          <div><dt>Busy</dt><dd>{fmtPercent(current.util)}</dd></div>
          <div><dt>Read</dt><dd>{fmtIops(current.rIops)} IOPS · {fmtMBps(current.rBps)} MB/s</dd></div>
          <div><dt>Write</dt><dd>{fmtIops(current.wIops)} IOPS · {fmtMBps(current.wBps)} MB/s</dd></div>
          <div><dt>Queue depth</dt><dd>{current.queueDepth.toLocaleString("en-GB", { maximumFractionDigits: 1 })}</dd></div>
          <div><dt>Await read, write</dt><dd>{fmtMs(current.rAwaitMs)}, {fmtMs(current.wAwaitMs)}</dd></div>
          <div><dt>PSI some, full (10 s)</dt><dd>{fmtPsi(state.latest!.psi.some.avg10)}, {fmtPsi(state.latest!.psi.full.avg10)}</dd></div>
        </dl>
      )}
      {samples.length > 0 && (
        <div className="pressure-charts" role="group" aria-label={`Disk ${disk}, last ${windowMin} min`}>
          <PressureChart title="Busy" series={[{ key: "util", label: "Busy", pick: (s) => s.util }]} samples={samples} minutes={windowMin} yMax={1} format={fmtPercent} intervalMs={intervalMs} />
          <PressureChart title="IOPS" series={[{ key: "r", label: "Read", pick: (s) => s.rIops }, { key: "w", label: "Write", pick: (s) => s.wIops, dashed: true }]} samples={samples} minutes={windowMin} floor={10} format={fmtIops} intervalMs={intervalMs} />
          <PressureChart title="Throughput (MB/s)" series={[{ key: "r", label: "Read", pick: (s) => s.rBps / 1e6 }, { key: "w", label: "Write", pick: (s) => s.wBps / 1e6, dashed: true }]} samples={samples} minutes={windowMin} floor={1} format={(v) => v.toLocaleString("en-GB", { maximumFractionDigits: 1 })} intervalMs={intervalMs} />
          <PressureChart title="Queue depth" series={[{ key: "q", label: "Queue", pick: (s) => s.queueDepth }]} samples={samples} minutes={windowMin} floor={1} format={(v) => v.toLocaleString("en-GB", { maximumFractionDigits: 1 })} intervalMs={intervalMs} />
          <PressureChart title="Await" series={[{ key: "r", label: "Read", pick: (s) => s.rAwaitMs }, { key: "w", label: "Write", pick: (s) => s.wAwaitMs, dashed: true }]} samples={samples} minutes={windowMin} floor={1} format={fmtMs} intervalMs={intervalMs} />
          <PressureChart title="IO pressure (PSI, 10 s)" series={[{ key: "some", label: "Some", pick: (s) => s.psiSome10 }, { key: "full", label: "Full", pick: (s) => s.psiFull10, dashed: true }]} samples={samples} minutes={windowMin} floor={5} format={fmtPsi} intervalMs={intervalMs} />
        </div>
      )}
      {current && (
        <section className="pressure-consumers" aria-labelledby="pressure-consumers-title">
          <h3 id="pressure-consumers-title">Who is using this disk now</h3>
          <p className="status-subtitle">Busiest first, by IOPS. Values update every second. The order changes at most every two seconds.</p>
          {consumers.length === 0
            ? <p className="status-message">No {group === "cgroup" ? "cgroup" : group === "process" ? "process" : "folder"} consumers on this disk right now.{state.latest?.source === "proc" && group === "cgroup" ? " Attribution from the proc source can be coarse." : ""}</p>
            : <PressureTable node={node} consumers={consumers} />}
        </section>
      )}
    </>
  );
}

function Segment<T extends string | number>({ label, values, value, text, onChange }: { label: string; values: readonly T[]; value: T; text: (value: T) => string; onChange: (value: T) => void }) {
  return (
    <div className="storage-toggle" role="group" aria-label={label}>
      {values.map((v) => <button type="button" key={v} aria-pressed={v === value} onClick={() => onChange(v)}>{text(v)}</button>)}
    </div>
  );
}

const groupLabels = { cgroup: "Cgroup", process: "Process", path: "Folder" } as const;

function DiskPage({ route, navigate, entries, nodes, moved }: { route: StatusRoute; navigate: (route: StatusRoute) => void; entries?: readonly PressureNodeSummary[]; nodes?: readonly NodeInfo[]; moved: () => void }) {
  const node = route.node!;
  const disk = route.disk!;
  const windowMin = route.window ?? PRESSURE_DEFAULTS.window;
  const group = route.group ?? PRESSURE_DEFAULTS.group;
  const top = route.top ?? PRESSURE_DEFAULTS.top;
  const names = [...new Set([disk, ...(entries?.find((entry) => entry.node === node)?.disks.map((d) => d.name) ?? [])])].sort();
  const offline = nodes?.find((info) => info.name === node)?.online === false;
  return (
    <>
      <div className="pressure-toolbar">
        <PressureLink to={{ ...route, disk: undefined }} navigate={navigate} onNavigated={moved}><ArrowLeft size={16} aria-hidden="true" /> All disks</PressureLink>
        <label>Disk
          <select aria-label="Disk" value={disk} onChange={(e) => navigate({ ...route, disk: e.target.value })}>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <Segment label="History window" values={PRESSURE_WINDOWS} value={windowMin as typeof PRESSURE_WINDOWS[number]} text={(v) => `${v} min`} onChange={(v) => navigate({ ...route, window: v })} />
        <Segment label="Group by" values={PRESSURE_GROUPS} value={group} text={(v) => groupLabels[v]} onChange={(v) => navigate({ ...route, group: v })} />
        <label>Top
          <select aria-label="Top" value={top} onChange={(e) => navigate({ ...route, top: PRESSURE_TOPS.find((v) => String(v) === e.target.value) })}>
            {PRESSURE_TOPS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>
      <LiveDisk key={`${node}\0${disk}`} node={node} disk={disk} windowMin={windowMin} group={group} top={top} offline={offline} />
    </>
  );
}

/** The Disk pressure section of the status page: disk list at /status/<node>/disks, one disk at /status/<node>/disks/<disk>. */
export function PressureSection({ route, navigate, nodes }: { route: StatusRoute; navigate: (route: StatusRoute) => void; nodes?: readonly NodeInfo[] }) {
  const { data, error, isLoading } = usePressureNodes(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = () => heading.current?.focus({ preventScroll: true });
  const title = route.node && route.disk ? `Disk ${route.disk} on ${route.node}` : "Disk pressure";
  return (
    <section className="status-section" aria-labelledby="pressure-title">
      <div className="status-section-head"><div>
        <h2 id="pressure-title" tabIndex={-1} ref={heading}>{title}</h2>
        <p>{route.disk ? "Live load, latency and the consumers that use this disk." : "How busy each disk is, and where to look first."}</p>
      </div></div>
      {route.node && route.disk
        ? <DiskPage route={route} navigate={navigate} {...(data ? { entries: data } : {})} {...(nodes ? { nodes } : {})} moved={moved} />
        : <>
          {isLoading && <p role="status">Loading disk pressure…</p>}
          {error && <p className="status-message" role="status">{error.message}</p>}
          {data && <DiskList route={route} navigate={navigate} entries={data} {...(nodes ? { nodes } : {})} moved={moved} />}
        </>}
    </section>
  );
}
