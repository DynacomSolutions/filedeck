import { useCallback, useEffect, useRef, useState } from "react";
import { api, emitOpFinished, startedOps, fmtSize, onJobStarted, opLive, type JobView, type NodeInfo, type OpJob } from "./api";

const COLLAPSE_KEY = "filedeck-jobs-collapsed";
const live = (j: JobView) => j.state === "queued" || j.state === "running";

function pct(j: JobView): number | null {
  const p = j.progress;
  if (p.totalBytes > 0) return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  if (p.totalEntries > 0) return Math.min(100, Math.round((p.entries / p.totalEntries) * 100));
  return null;
}

function JobRow({ node, job, onChange }: { node: string; job: JobView; onChange: () => void }) {
  const p = pct(job);
  const act = (fn: () => Promise<unknown>) => void fn().catch(() => undefined).finally(onChange);
  const skipped = job.result?.skipped;
  const skippedN = skipped ? skipped.symlinks + skipped.hardlinks + skipped.special : 0;
  return (
    <li className={"job " + job.state}>
      <div className="job-line">
        <b>{job.title}</b>
        <span className="muted"> on {node}</span>
        <span className="job-state">
          {job.state === "running" && (p === null ? " running" : ` ${p}%`)}
          {job.state === "queued" && " queued"}
          {job.state === "done" && " done"}
          {job.state === "canceled" && " canceled"}
          {job.state === "failed" && " failed"}
        </span>
        {live(job) ? (
          <button onClick={() => act(() => api.cancelJob(node, job.id))}>Cancel</button>
        ) : (
          <button aria-label="Dismiss" onClick={() => act(() => api.dismissJob(node, job.id))}>×</button>
        )}
      </div>
      {live(job) && (
        <>
          {p === null ? <progress aria-label={job.title} /> : <progress aria-label={job.title} max={100} value={p} />}
          <div className="muted job-detail">
            {fmtSize(job.progress.bytes)}
            {job.progress.totalBytes > 0 && ` / ${fmtSize(job.progress.totalBytes)}`} · {job.progress.entries}
            {job.progress.totalEntries > 0 && ` / ${job.progress.totalEntries}`} entries
            {job.progress.current && ` · ${job.progress.current}`}
          </div>
        </>
      )}
      {job.state === "failed" && <div className="fp-err">{job.error}</div>}
      {job.state === "done" && job.result?.path && (
        <div className="muted job-detail">
          {job.result.path}
          {skippedN > 0 && ` · ${skippedN} link/special entr${skippedN === 1 ? "y" : "ies"} skipped for safety`}
        </div>
      )}
    </li>
  );
}

const fmtEta = (sec: number) => (sec < 90 ? `${Math.ceil(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
const opPct = (j: OpJob): number | null => {
  const p = j.progress;
  if (p.totalBytes > 0) return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  if (p.totalEntries > 0) return Math.min(100, Math.round((p.entries / p.totalEntries) * 100));
  return null;
};
const STATE_LABEL: Record<string, string> = { queued: "queued", paused: "paused", waiting: "needs an answer", done: "done", failed: "failed", canceled: "canceled" };

function detailLine(job: OpJob, eta: number | null, live: boolean): string {
  const p = job.progress;
  if (job.state === "queued") return "waiting for a free slot";
  if (p.current === "scanning") return "scanning...";
  const unit = job.op === "copy" || job.op === "move" ? "files" : job.op === "sync" ? "steps" : "items";
  const parts: string[] = [];
  if (p.totalBytes > 0 || p.bytes > 0) parts.push(`${fmtSize(p.bytes)}${p.totalBytes > 0 ? ` / ${fmtSize(p.totalBytes)}` : ""}`);
  if (job.state === "running" && job.speed > 0) parts.push(`${fmtSize(job.speed)}/s`);
  if (eta !== null) parts.push(`${fmtEta(eta)} left`);
  if (p.totalEntries > 0) parts.push(`${p.entries} / ${p.totalEntries} ${unit}`);
  if (live && p.current) parts.push(p.current);
  if (!live) {
    const c = job.counts;
    parts.push(`${c.done} done${c.skipped ? `, ${c.skipped} skipped` : ""}${c.failed ? `, ${c.failed} failed` : ""}`);
  }
  return parts.join(" · ");
}

/** A hub-side bulk job: per-item progress, throughput, pause/cancel and the conflict question. */
function OpRow({ job, detail, expanded, onToggle, onChange }: { job: OpJob; detail?: OpJob; expanded: boolean; onToggle: () => void; onChange: () => void }) {
  const [all, setAll] = useState(false);
  const p = opPct(job);
  const act = (fn: () => Promise<unknown>) => void fn().catch(() => undefined).finally(onChange);
  const live = opLive(job);
  const eta = job.state === "running" && job.speed > 0 && job.progress.totalBytes > job.progress.bytes ? (job.progress.totalBytes - job.progress.bytes) / job.speed : null;
  const items = (detail ?? job).items ?? [];
  const c = job.counts;
  return (
    <li className={"job op " + job.state} data-job-id={job.id}>
      <div className="job-line">
        <b>{job.title}</b>
        <span className="job-state">{job.state === "running" ? (p === null ? " running" : ` ${p}%`) : ` ${STATE_LABEL[job.state] ?? job.state}`}</span>
        {live && job.state !== "waiting" && (
          job.state === "paused" ? (
            <button onClick={() => act(() => api.opAction(job.id, "resume"))}>Resume</button>
          ) : (
            <button onClick={() => act(() => api.opAction(job.id, "pause"))}>Pause</button>
          )
        )}
        {live ? <button onClick={() => act(() => api.opAction(job.id, "cancel"))}>Cancel</button> : <button aria-label="Dismiss" onClick={() => act(() => api.dismissOp(job.id))}>×</button>}
      </div>
      {live && (p === null ? <progress aria-label={job.title} /> : <progress aria-label={job.title} max={100} value={p} />)}
      {live && job.conflict && (
        <div className="job-ask" role="group" aria-label="Name conflict">
          <div>
            <b>{job.conflict.name}</b> already exists at <span className="muted">{job.conflict.target}</span>
            {job.conflict.srcType === "file" && job.conflict.dstType === "file" && <span className="muted"> ({fmtSize(job.conflict.srcSize)} replaces {fmtSize(job.conflict.dstSize)})</span>}
          </div>
          <div className="job-ask-btns">
            <button onClick={() => act(() => api.opResolve(job.id, "skip", all))}>Skip</button>
            <button onClick={() => act(() => api.opResolve(job.id, "overwrite", all))}>{job.conflict.dstType === "dir" && job.conflict.srcType === "dir" ? "Merge" : "Overwrite"}</button>
            <button className="primary" onClick={() => act(() => api.opResolve(job.id, "rename", all))}>Keep both</button>
          </div>
          <label className="chk"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Apply to all remaining</label>
        </div>
      )}
      <div className="muted job-detail">{detailLine(job, eta, live)}</div>
      {job.state === "failed" && job.error && <div className="fp-err">{job.error}</div>}
      <button type="button" className="job-more" aria-expanded={expanded} onClick={onToggle}>{expanded ? "Hide items" : `Items (${c.total})`}</button>
      {expanded && (
        <ul className="job-items" aria-label="Items">
          {items.map((it, i) => (
            <li key={i} className={"it " + it.state}>
              <span className="it-s">{it.state === "done" ? "✓" : it.state === "failed" ? "✕" : it.state === "skipped" ? "–" : it.state === "running" ? "…" : "·"}</span>
              <span className="it-l">{it.label}</span>
              {(it.note || it.error) && <span className={it.error ? "fp-err" : "muted"}> {it.error ?? it.note}</span>}
              {it.bytes > 0 && <span className="muted"> {fmtSize(it.bytes)}</span>}
            </li>
          ))}
          {(detail ?? job).itemsTruncated && <li className="muted">more items not shown</li>}
        </ul>
      )}
    </li>
  );
}

/** Background jobs from every node, polled while anything is active. */
export function JobsTray({ nodes }: { nodes: NodeInfo[] }) {
  const [jobs, setJobs] = useState<Record<string, JobView[]>>({});
  const [ops, setOps] = useState<OpJob[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpJob | undefined>();
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const seen = useRef(new Map<string, string>());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const next: Record<string, JobView[]> = {};
    const opsP = api.opJobs().then((r) => r.jobs, () => [] as OpJob[]);
    const detailP = openRef.current ? api.opJob(openRef.current).catch(() => undefined) : Promise.resolve(undefined);
    await Promise.all(
      nodesRef.current
        .filter((n) => n.online)
        .map(async (n) => {
          try {
            next[n.name] = (await api.jobs(n.name)).jobs;
          } catch {
            next[n.name] = [];
          }
        }),
    );
    const [opList, det] = await Promise.all([opsP, detailP]);
    busy.current = false;
    setJobs(next);
    setOps(opList);
    setDetail(det);
    // Tell panels when a hub job ends (not on the first sight of an already-finished job).
    for (const o of opList) {
      const prev = seen.current.get(o.id) ?? (startedOps.has(o.id) ? "queued" : undefined);
      if (!opLive(o)) startedOps.delete(o.id);
      if (prev !== undefined && opLive({ state: prev as OpJob["state"] }) && !opLive(o)) emitOpFinished(o);
      seen.current.set(o.id, o.state);
    }
    const active = opList.some(opLive) || Object.values(next).some((l) => l.some(live));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void poll(), active ? 700 : 10000);
  }, []);

  useEffect(() => {
    void poll();
    const off = onJobStarted(() => void poll());
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [poll, nodes.length]);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsedPersist = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);
  // A newly started job expands the tray so progress is visible.
  useEffect(() => onJobStarted(() => setCollapsedPersist(false)), [setCollapsedPersist]);

  const now = Date.now();
  // Clean, finished hub jobs fade out of the tray after a while; they stay dismissible until then.
  const opRows = ops.filter((o) => !(o.state === "done" && o.counts.failed === 0 && o.counts.skipped === 0 && o.finishedAt && now - o.finishedAt > 20000));
  const rows = Object.entries(jobs).flatMap(([node, l]) => l.map((job) => ({ node, job })));
  if (!rows.length && !opRows.length) return null;
  const running = rows.filter((r) => live(r.job)).length + opRows.filter(opLive).length;
  const total = rows.length + opRows.length;
  // Questions need attention, so the tray opens by itself.
  const asking = opRows.some((o) => o.state === "waiting");
  return (
    <section className={"jobs" + (collapsed ? " collapsed" : "")} aria-label="Background jobs" role="status">
      <button type="button" className="jobs-toggle" aria-expanded={!collapsed} onClick={() => setCollapsedPersist(!collapsed)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        Jobs
        <span className="n">{asking ? "needs an answer" : running > 0 ? `${running} running` : total}</span>
      </button>
      {(!collapsed || asking) && (
        <div className="jobs-body">
          <ul>
            {opRows.map((job) => (
              <OpRow key={job.id} job={job} detail={open === job.id ? detail : undefined} expanded={open === job.id} onToggle={() => setOpen(open === job.id ? null : job.id)} onChange={() => void poll()} />
            ))}
            {rows.map(({ node, job }) => (
              <JobRow key={node + job.id} node={node} job={job} onChange={() => void poll()} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
