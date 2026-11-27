import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import useSWR from "swr";
import { ApiError, fmtDate, fmtSize } from "./api";
import { useDialogFocus } from "./dialogFocus";
import type { DiskVerifyRoute } from "./urlState";
import "./disk-verify.css";

interface Disk {
  name: string;
  model: string;
  serial: string;
  transport: string;
  size: number;
  byId?: string;
  reason?: string;
  fingerprint?: string;
}

interface Job {
  id: string;
  disk: Disk;
  state: "running" | "paused" | "pass" | "warn" | "fail";
  kind: "full" | "short" | "long";
  phase: string;
  total: number;
  offset: number;
  started: number;
  updated: number;
  actor: string;
  error?: string;
  findings: string[];
  samples: { time: number; bps: number; phase: string }[];
  details: Record<string, { bytes: number; seconds: number }>;
  bytesPerSecond?: number;
  etaSeconds?: number;
  jobEtaSeconds?: number;
  before?: unknown;
  after?: unknown;
}

interface NodeInventory {
  node: string;
  writable?: boolean;
  disks?: Disk[];
  jobs?: Job[];
  error?: string;
}

const path = "/api/disk-verify";
const phases: Record<string, string> = {
  "capacity-write": "Fake capacity probe: write",
  "capacity-read": "Fake capacity probe: verify",
  "sequential-write": "Sequential write benchmark",
  "sequential-read": "Sequential read benchmark",
  "random-write": "4 KiB random write benchmark",
  "random-read": "4 KiB random read benchmark",
  fill: "Full random fill",
  verify: "Full read-back verification",
  "smart-after": "SMART comparison",
  discard: "Discard",
  wipefs: "Wipefs signature check",
  "self-test": "SMART self-test",
};
const states: Record<Job["state"], string> = { running: "Running", paused: "Paused", pass: "Pass", warn: "Warning", fail: "Fail" };
const kinds = { full: "Full destructive test", short: "SMART short self-test", long: "SMART long self-test" };
const displayPhase = (phase: string) => phases[phase] ?? phase;

async function request<T>(url: string): Promise<T> { return readResponse<T>(await fetch(url)); }

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new ApiError(detail?.error ?? (response.statusText || `HTTP ${response.status}`), response.status);
  }
  const data = await response.json();
  return data as T;
}

export function DiskVerifyView({ route, onRoute, onClose }: {
  route: DiskVerifyRoute;
  onRoute: (route: DiskVerifyRoute) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  useDialogFocus(dialog);
  useEffect(() => dialog.current?.focus({ preventScroll: true }), []);
  const inv = useSWR(path, request<{ nodes: NodeInventory[] }>, { refreshInterval: 3000 });
  const target = inv.data?.nodes.find((n) => n.node === route.node);
  const base = target && `${path}/nodes/${encodeURIComponent(target.node)}`;
  const history = useSWR(base && route.serial ? `${base}/history?${new URLSearchParams({ serial: route.serial })}` : null,
    request<{ jobs: Job[] }>, { refreshInterval: 3000 });
  const nodes = (inv.data?.nodes ?? []).filter((n) => !route.node || n.node === route.node);
  const selected = target?.disks?.find((disk) => disk.serial === route.serial);
  const jobs = history.data?.jobs ?? target?.jobs?.filter((job) => job.disk.serial === route.serial) ?? [];
  const detail = useSWR(base && route.job ? `${base}/${encodeURIComponent(route.job)}` : null, request<Job>, { refreshInterval: 3000 });
  const job = detail.data?.disk.serial === route.serial ? detail.data : undefined;
  const active = (inv.data?.nodes ?? []).flatMap((node) => (node.jobs ?? [])
    .filter((j) => j.state === "running").map((j) => ({ node: node.node, job: j })));
  const refresh = () => Promise.all([inv.mutate(), history.mutate(), detail.mutate()]);
  return (
    <div ref={dialog} className="ed over disk-verify" role="dialog" aria-modal="true" aria-labelledby={title}
      tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="ed-head">
        <b id={title}>Disk verify</b><span className="ed-spacer" />
        <button type="button" onClick={onClose}><X aria-hidden="true" /> Close</button>
      </div>
      <div className="ed-body set-body disk-verify-body">
        <label>Node <select value={route.node ?? ""} onChange={(e) => onRoute(e.target.value ? { node: e.target.value } : {})}>
          <option value="">All nodes</option>
          {route.node && !target && <option value={route.node}>{route.node}</option>}
          {inv.data?.nodes.map((node) => <option key={node.node} value={node.node}>{node.node}</option>)}
        </select></label>
        {inv.error && <p role="alert">{inv.error.message}</p>}
        {!inv.data && !inv.error && <p>Loading disk inventory…</p>}
        {inv.data?.nodes.length === 0 && <p>No agents are available to this account.</p>}

        {!!active.length && <section aria-label="Active disk jobs">
          <h2>Active jobs</h2>
          <ul className="disk-verify-list">
            {active.map(({ node, job }) => <li key={job.id}>
              <button type="button" onClick={() => onRoute({ node, serial: job.disk.serial, job: job.id })}>
                {node} · {job.disk.serial} · {displayPhase(job.phase)}
              </button>
              {job.total > 0 && <progress value={job.offset} max={job.total} aria-label={`${job.disk.serial} progress`} />}
            </li>)}
          </ul>
        </section>}

        {nodes.map((node) => <section key={node.node} aria-label={`${node.node} disk inventory`}>
          <h2>{node.node}</h2>
          {node.error && <p role="status">{node.error}</p>}
          {node.disks?.length === 0 && <p>No disks found.</p>}
          <ul className="disk-verify-list">
            {node.disks?.map((disk) => <li key={disk.name}>
              <button type="button" disabled={!disk.serial}
                aria-pressed={route.node === node.node && route.serial === disk.serial}
                onClick={() => onRoute({ node: node.node, serial: disk.serial })}>
                {disk.model || disk.name} · {disk.serial || "Serial unavailable"}
              </button>
              <span>{disk.name} · {disk.transport || "Unknown transport"} · {fmtSize(disk.size)}</span>
            </li>)}
          </ul>
          <details>
            <summary>Recent history</summary>
            {(node.jobs ?? []).length === 0 && <p>No results.</p>}
            <ul className="disk-verify-list">
              {node.jobs?.slice(0, 10).map((job) => <li key={job.id}>
                <button type="button" onClick={() => onRoute({ node: node.node, serial: job.disk.serial, job: job.id })}>
                  {job.disk.serial} · {kinds[job.kind]} · {states[job.state]}
                </button>
              </li>)}
            </ul>
          </details>
        </section>)}

        {route.node && route.serial && (
          <section aria-label="Selected disk">
            <h2>{selected?.model || route.serial}</h2>
            {base && selected && <DiskActions key={JSON.stringify([base, route.serial, selected.fingerprint])}
              disk={selected} base={base} node={route.node} writable={!!target?.writable}
              onRun={(id) => { onRoute({ node: route.node, serial: route.serial, job: id }); void refresh(); }}
              resume={job?.kind === "full" && job.state === "paused" ? job.id : undefined}
              running={jobs.some((entry) => entry.state === "running")} />}
            {!selected && <p>The selected disk is absent from the current inventory.</p>}
            <h3>History for {route.serial}</h3>
            {history.error && <p role="alert">{history.error.message}</p>}
            {!jobs.length && <p>No results for this serial.</p>}
            <ul className="disk-verify-list">
              {jobs.map((entry) => <li key={entry.id}>
                <button type="button" aria-pressed={entry.id === route.job} onClick={() => onRoute({ ...route, job: entry.id })}>
                  {states[entry.state]} · {kinds[entry.kind]} · {fmtDate(entry.started)}
                </button>
              </li>)}
            </ul>
            {detail.error && <p role="alert">{detail.error.message}</p>}
            {job && base && <JobDetails key={job.id} job={job} node={route.node} refresh={refresh} />}
          </section>
        )}
      </div>
    </div>
  );
}

type Smart = { snapshot: unknown; health?: boolean; metrics: Record<string, number> };

function DiskActions({ disk, base, node, writable, running, resume, onRun }: {
  disk: Disk; base: string; node: string; writable: boolean; running: boolean; resume?: string; onRun: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [kind, setKind] = useState<Job["kind"]>("short");
  const [busy, setBusy] = useState(false);
  const [smart, setSmart] = useState<Smart>();
  const [error, setError] = useState("");
  const ready = writable && !disk.reason && disk.byId && disk.fingerprint && !running;
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await run(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const start = (resumeId?: string) => action(async () => {
    const response = await fetch(`${path}/nodes/${encodeURIComponent(node)}/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byId: disk.byId, serial: disk.serial, kind: resumeId ? "full" : kind, confirm, fingerprint: disk.fingerprint, resume: resumeId }),
    });
    const job = await readResponse<Job>(response);
    setConfirm("");
    onRun(job.id);
  });
  const readSmart = () => action(async () => {
    setSmart(await request<Smart>(`${base}/smart?${new URLSearchParams({ id: disk.byId!, serial: disk.serial })}`));
  });
  return (
    <div className="disk-verify-actions">
      <p>{disk.name} · {disk.serial} · {disk.transport || "Unknown transport"} · {fmtSize(disk.size)}</p>
      {disk.byId && <p>By-id <code>{disk.byId}</code></p>}
      <button type="button" onClick={() => void readSmart()} disabled={!disk.byId || busy}>Read SMART health and wear</button>
      {smart && <>
        <p>SMART health: {smart.health === true ? "Pass" : smart.health === false ? "Fail" : "Unavailable"}</p>
        <ul>{Object.entries(smart.metrics).map(([key, value]) => <li key={key}>{key}: {value}</li>)}</ul>
        <details><summary>SMART report</summary><pre>{JSON.stringify(smart.snapshot, null, 2)}</pre></details>
      </>}
      {!ready && <p>{running ? "A test is already running." : disk.reason ?? "This agent has no native disk test access."}</p>}
      {ready && <form onSubmit={(e) => { e.preventDefault(); if (confirm === disk.serial && !busy) void start(); }}>
        <label>Test <select value={kind} onChange={(e) => { setKind(e.target.value as Job["kind"]); setConfirm(""); }}>
          {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {(kind === "full" || resume) && <p><strong>Warning:</strong> The full test and its resume operation overwrite the entire disk.</p>}
        <label>Type the exact disk serial to confirm
          <input type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="disk-verify-buttons">
          <button type="submit" disabled={confirm !== disk.serial || busy}>Start {kinds[kind]}</button>
          {resume && <button type="button" disabled={confirm !== disk.serial || busy} onClick={() => void start(resume)}>Resume full destructive test</button>}
        </div>
      </form>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function JobDetails({ job, node, refresh }: { job: Job; node: string; refresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      await readResponse(await fetch(`${path}/nodes/${encodeURIComponent(node)}/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }));
      await refresh();
    }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const maximum = Math.max(1, ...job.samples.map((point) => point.bps));
  return (
    <section aria-label="Disk job details" className="disk-verify-job">
      <h3>{kinds[job.kind]} · {states[job.state]}</h3>
      <p>{displayPhase(job.phase)} · Started {fmtDate(job.started)} by {job.actor}</p>
      {!!job.total && <p>
        <progress value={job.offset} max={job.total} aria-label="Current phase progress" />
        {" "}{job.phase === "self-test" ? `${job.offset}%` : `${fmtSize(job.offset)} / ${fmtSize(job.total)}`}
      </p>}
      {job.state === "running" && <p>
        {job.bytesPerSecond !== undefined && <>{fmtSize(job.bytesPerSecond)}/s · </>}
        {job.etaSeconds !== undefined ? `${Math.ceil(job.etaSeconds / 60)} min left in this phase` : "ETA unavailable"}
        {job.jobEtaSeconds !== undefined && job.phase !== "discard" && <> · About {Math.ceil(job.jobEtaSeconds / 60)} min of fill and verification left</>}
      </p>}
      {job.state === "running" && <button type="button" onClick={() => void cancel()} disabled={busy}>Cancel test</button>}
      {job.error && <p role="status">{job.error}</p>}
      {error && <p role="alert">{error}</p>}
      {job.findings.length > 0 && <ul>{job.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}
      {job.samples.length > 0 && <figure>
        <figcaption>Recent measured throughput (peak {fmtSize(maximum)}/s)</figcaption>
        <div className="disk-verify-graph" role="img" aria-label={`Recent throughput, peak ${fmtSize(maximum)} per second`}>
          {job.samples.map((point, index) => <span key={index} style={{ height: `${point.bps / maximum * 100}%` }}
            title={`${displayPhase(point.phase)} · ${fmtSize(point.bps)}/s`} />)}
        </div>
      </figure>}
      <dl className="disk-verify-results">
        {Object.entries(job.details).map(([phase, value]) => <div key={phase}>
          <dt>{displayPhase(phase)}</dt>
          <dd>{fmtSize(value.bytes)} in {value.seconds.toFixed(1)} s · {fmtSize(Math.round(value.bytes / value.seconds))}/s
            {phase.startsWith("random-") && <> · {Math.round(value.bytes / 4096 / value.seconds)} IOPS</>}
          </dd>
        </div>)}
      </dl>
      <details><summary>SMART before</summary><pre>{JSON.stringify(job.before, null, 2)}</pre></details>
      {job.after !== undefined && <details><summary>SMART after</summary><pre>{JSON.stringify(job.after, null, 2)}</pre></details>}
    </section>
  );
}
