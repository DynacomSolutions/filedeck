import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtSize, onJobStarted, type JobView, type NodeInfo } from "./api";

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

/** Background jobs from every node, polled while anything is active. */
export function JobsTray({ nodes }: { nodes: NodeInfo[] }) {
  const [jobs, setJobs] = useState<Record<string, JobView[]>>({});
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const next: Record<string, JobView[]> = {};
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
    busy.current = false;
    setJobs(next);
    const active = Object.values(next).some((l) => l.some(live));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void poll(), active ? 1000 : 10000);
  }, []);

  useEffect(() => {
    void poll();
    const off = onJobStarted(() => void poll());
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [poll, nodes.length]);

  const rows = Object.entries(jobs).flatMap(([node, l]) => l.map((job) => ({ node, job })));
  if (!rows.length) return null;
  return (
    <section className="jobs" aria-label="Background jobs" role="status">
      <ul>
        {rows.map(({ node, job }) => (
          <JobRow key={node + job.id} node={node} job={job} onChange={() => void poll()} />
        ))}
      </ul>
    </section>
  );
}
