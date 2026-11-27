import { ChevronRight } from "lucide-react";
import { fmtSize, type OpJob } from "./api";
import type { JobsSnapshot } from "./Jobs";
import { jobLines, progressPercent, statusPill } from "./jobRow";
import { isActive, jobDuration, statusJobs, type StatusJob } from "./statusJobs";
import { JOB_FILTERS, type StatusRoute } from "./statusRoute";

export function StatusTime({ at }: { at: number | null | undefined }) {
  return at == null ? "Unavailable" : <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>;
}

function JobDetails({ row, detail }: { row: StatusJob; detail?: OpJob }) {
  const job = row.job;
  const op = "op" in job ? detail?.id === job.id ? detail : job : undefined;
  const lines = "op" in job ? [] : jobLines(job, Date.now());
  return (
    <div className="status-job-detail">
      <dl className="status-facts">
        <div><dt>Job ID</dt><dd><code>{job.id}</code></dd></div>
        <div><dt>Origin</dt><dd>{"origin" in job ? job.origin ?? (job.kind === "du" ? "cli" : "ui") : "ui"}</dd></div>
        <div><dt>Created</dt><dd><StatusTime at={job.createdAt} /></dd></div>
        <div><dt>Finished</dt><dd>{job.finishedAt ? <StatusTime at={job.finishedAt} /> : "Pending"}</dd></div>
        <div><dt>Data processed</dt><dd>{fmtSize(job.progress.bytes)}{job.progress.totalBytes > 0 && ` of ${fmtSize(job.progress.totalBytes)}`}</dd></div>
        <div><dt>Entries processed</dt><dd>{job.progress.entries.toLocaleString()}{job.progress.totalEntries > 0 && ` of ${job.progress.totalEntries.toLocaleString()}`}</dd></div>
        {op && <div><dt>Items</dt><dd>{op.counts.done} done, {op.counts.skipped} skipped, {op.counts.failed} failed</dd></div>}
        {"queue" in job && job.queue && <div><dt>Queue position</dt><dd>{job.queue.position}</dd></div>}
      </dl>
      {job.progress.current && <p>{job.progress.current}</p>}
      {lines.filter((line) => line !== job.error && line !== job.progress.current).map((line, i) => <p key={i}>{line}</p>)}
      {op?.conflict && <p>Waiting for a decision on {op.conflict.target}.</p>}
      {op?.items && <ul className="status-items" aria-label="Job items">
        {op.items.map((item, i) => <li key={i}>{item.label} · {item.state}{item.error || item.note ? ` · ${item.error ?? item.note}` : ""}</li>)}
        {op.itemsTruncated && <li>Only the first items are available.</li>}
      </ul>}
    </div>
  );
}

export function StatusJobsPanel({ snapshot, route, navigate }: {
  snapshot: JobsSnapshot;
  route: StatusRoute;
  navigate: (route: StatusRoute) => void;
}) {
  const rows = statusJobs(snapshot, route);
  const active = rows.filter(({ job }) => isActive(job));
  const queued = active.filter(({ job }) => job.state === "queued").length;
  const recent = rows.length - active.length;
  const failures = [...snapshot.stale].flatMap((key) => {
    if (!key.startsWith("agent:")) return [key];
    const node = key.slice(6);
    return route.node && route.node !== node ? [] : [node];
  });
  return (
    <section className="status-section" aria-labelledby="status-jobs-title">
      <div className="status-section-head">
        <div>
          <h2 id="status-jobs-title">Jobs</h2>
          {!snapshot.loading && <p>{active.length - queued} in progress · {queued} queued · {recent} finished</p>}
        </div>
        <label>Show <select value={route.jobs ?? ""} onChange={(e) => navigate({ ...route, job: undefined, jobs: JOB_FILTERS.find((x) => x === e.target.value) })}>
          <option value="">All jobs</option><option value="active">Active</option><option value="recent">Recent</option><option value="failed">Failed</option>
        </select></label>
      </div>
      {failures.length > 0 && <p className="status-message" role="status">Last update failed for {failures.join(", ")}. Previously received jobs may be out of date.</p>}
      {snapshot.loading && <p role="status">Loading jobs…</p>}
      {!snapshot.loading && !rows.length && <p className="status-message">No jobs for this view.</p>}
      {route.job && !snapshot.loading && !rows.some((row) => row.key === route.job) && <p className="status-message">This job is no longer available.</p>}
      <ul className="status-rows" aria-label="Jobs">
        {rows.map((row) => {
          const { job, key, nodes, source } = row;
          const selected = key === route.job;
          const percent = progressPercent(job.progress);
          const pill = statusPill(job.state, { pct: percent });
          const where = nodes.join(", ") || (source === "compares" ? "Hub compare" : "Hub");
          const stale = snapshot.stale.has(source === "agent" ? `agent:${nodes[0]}` : source);
          return (
            <li className="status-row" key={key}>
              <div className="status-job-summary">
                <div>
                  <button type="button" aria-expanded={selected} onClick={() => navigate({ ...route, job: selected ? undefined : key })}>
                    <ChevronRight size={16} aria-hidden="true" /> {job.title}
                  </button>
                  <div className="status-subtitle">{where} · {"op" in job ? job.op : job.kind}{stale ? " · Update delayed" : ""}</div>
                </div>
                <span className={"job-pill " + pill.tone}>{pill.label}</span>
                <div className="status-job-time">{job.startedAt === undefined ? "Not started" : <><StatusTime at={job.startedAt} /> · {jobDuration(job, Date.now())}</>}</div>
              </div>
              {isActive(job) && job.state !== "queued" && <progress max={100} value={percent} aria-label={`Progress for ${job.title}`} />}
              {job.error && <p className="status-job-error">{job.error}</p>}
              {selected && <JobDetails row={row} detail={snapshot.opDetail} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
