import { useCallback, useEffect, useRef, useState } from "react";
import { useUploads, pauseUpload, resumeUpload, cancelUpload, retryFailed, dismissUpload, type UpBatch } from "./uploads";
import { api, emitOpFinished, startedOps, fmtSize, onJobStarted, opLive, type JobView, type NodeInfo, type OpJob } from "./api";
import { Check, Circle, Loader, Minus, X } from "lucide-react";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";
import { HISTORY_KEY, IDLE_COLLAPSE_MS, addToHistory, nextExpiry, parseHistory, shouldAutoCollapse, stillLingering, type HistoryEntry, type Outcome } from "./jobHistory";

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
          <button onClick={() => act(() => api.cancelJob(node, job.id))}><Ic.X /> Cancel</button>
        ) : (
          <Tip label="Dismiss"><button aria-label="Dismiss" onClick={() => act(() => api.dismissJob(node, job.id))}><X /></button></Tip>
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
const STATE_LABEL: Record<string, string> = { queued: "queued", paused: "paused", waiting: "waiting for you", done: "done", failed: "failed", canceled: "canceled" };

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
        <b className="job-title">{job.title}</b>
        <span className="job-state">{job.state === "running" ? (p === null ? " running" : ` ${p}%`) : ` ${STATE_LABEL[job.state] ?? job.state}`}</span>
        {live && job.state !== "waiting" && (
          job.state === "paused" ? (
            <button onClick={() => act(() => api.opAction(job.id, "resume"))}><Ic.Play /> Resume</button>
          ) : (
            <button onClick={() => act(() => api.opAction(job.id, "pause"))}><Ic.Pause /> Pause</button>
          )
        )}
        {live ? <button onClick={() => act(() => api.opAction(job.id, "cancel"))}><Ic.X /> Cancel</button> : <Tip label="Dismiss"><button aria-label="Dismiss" onClick={() => act(() => api.dismissOp(job.id))}><X /></button></Tip>}
      </div>
      {live && (p === null ? <progress aria-label={job.title} /> : <progress aria-label={job.title} max={100} value={p} />)}
      {live && job.conflict && (
        <div className="job-ask" role="group" aria-label="Name conflict">
          <div>
            <b>{job.conflict.name}</b> already exists at <span className="muted">{job.conflict.target}</span>
            {job.conflict.srcType === "file" && job.conflict.dstType === "file" && <span className="muted"> ({fmtSize(job.conflict.srcSize)} replaces {fmtSize(job.conflict.dstSize)})</span>}
          </div>
          <div className="job-ask-btns">
            <button onClick={() => act(() => api.opResolve(job.id, "skip", all))}><Ic.SkipForward /> Skip</button>
            <button onClick={() => act(() => api.opResolve(job.id, "overwrite", all))}>{job.conflict.dstType === "dir" && job.conflict.srcType === "dir" ? <Ic.Merge /> : <Ic.Replace />} {job.conflict.dstType === "dir" && job.conflict.srcType === "dir" ? "Merge" : "Overwrite"}</button>
            <button className="primary" onClick={() => act(() => api.opResolve(job.id, "rename", all))}><Ic.CopyPlus /> Keep both</button>
          </div>
          <label className="ck"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span className="ck-box" aria-hidden="true"><Ic.Check /></span><span>Apply to all remaining</span></label>
        </div>
      )}
      <div className="muted job-detail">{detailLine(job, eta, live)}</div>
      {job.state === "failed" && job.error && <div className="fp-err">{job.error}</div>}
      <button type="button" className="job-more" aria-expanded={expanded} onClick={onToggle}><Ic.List /> {expanded ? "Hide items" : `Items (${c.total})`}</button>
      {expanded && (
        <ul className="job-items" aria-label="Items">
          {items.map((it, i) => (
            <li key={i} className={"it " + it.state}>
              <span className="it-s">{it.state === "done" ? <Check role="img" aria-label="done" /> : it.state === "failed" ? <X role="img" aria-label="failed" /> : it.state === "skipped" ? <Minus role="img" aria-label="skipped" /> : it.state === "running" ? <Loader role="img" aria-label="running" /> : <Circle role="img" aria-label="pending" />}</span>
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

/** A browser-driven upload batch (files or a folder tree): chunked and resumable, with pause. */
function UploadRow({ b, expanded, onToggle }: { b: UpBatch; expanded: boolean; onToggle: () => void }) {
  const live = b.state === "running" || b.state === "paused";
  const sent = b.files.reduce((n, f) => n + (f.state === "done" ? f.file.size : f.sent), 0);
  const p = b.totalBytes > 0 ? Math.min(100, Math.round((sent / b.totalBytes) * 100)) : b.files.every((f) => f.state === "done") ? 100 : 0;
  const done = b.files.filter((f) => f.state === "done").length;
  const failed = b.files.filter((f) => f.state === "failed").length;
  const eta = b.state === "running" && b.speed > 0 ? (b.totalBytes - sent) / b.speed : null;
  const label = b.state === "running" ? ` ${p}%` : ` ${b.state}`;
  return (
    <li className={"job op upload " + b.state} data-job-id={b.id}>
      <div className="job-line">
        <b>{b.title}</b>
        <span className="muted"> to {b.node}:{b.dir}</span>
        <span className="job-state">{label}</span>
        {b.state === "running" && <button onClick={() => pauseUpload(b.id)}><Ic.Pause /> Pause</button>}
        {b.state === "paused" && <button onClick={() => resumeUpload(b.id)}><Ic.Play /> Resume</button>}
        {failed > 0 && !live && <button onClick={() => retryFailed(b.id)}><Ic.RotateCw /> Retry failed</button>}
        {live ? <button onClick={() => cancelUpload(b.id)}><Ic.X /> Cancel</button> : <Tip label="Dismiss"><button aria-label="Dismiss" onClick={() => dismissUpload(b.id)}><X /></button></Tip>}
      </div>
      {live && <progress aria-label={b.title} max={100} value={p} />}
      <div className="muted job-detail">
        {[
          `${fmtSize(sent)} / ${fmtSize(b.totalBytes)}`,
          b.state === "running" && b.speed > 0 ? `${fmtSize(b.speed)}/s` : "",
          eta !== null ? `${fmtEta(eta)} left` : "",
          `${done} / ${b.files.length} files${b.dirs.length ? `, ${b.dirs.length} folders` : ""}`,
          failed ? `${failed} failed` : "",
        ].filter(Boolean).join(" · ")}
      </div>
      <button type="button" className="job-more" aria-expanded={expanded} onClick={onToggle}><Ic.List /> {expanded ? "Hide items" : `Items (${b.files.length})`}</button>
      {expanded && (
        <ul className="job-items" aria-label="Items">
          {b.files.slice(0, 500).map((f, i) => (
            <li key={i} className={"it " + (f.state === "pending" ? "pending" : f.state)}>
              <span className="it-s">{f.state === "done" ? <Check role="img" aria-label="done" /> : f.state === "failed" ? <X role="img" aria-label="failed" /> : f.state === "running" ? <Loader role="img" aria-label="running" /> : <Circle role="img" aria-label="pending" />}</span>
              <span className="it-l">{f.rel}</span>
              {f.state === "running" && f.file.size > 0 && <span className="muted"> {Math.round((f.sent / f.file.size) * 100)}%</span>}
              {(f.note || f.error) && <span className={f.error ? "fp-err" : "muted"}> {f.error ?? f.note}</span>}
            </li>
          ))}
          {b.files.length > 500 && <li className="muted">more items not shown</li>}
        </ul>
      )}
    </li>
  );
}

const outcomeOf = (state: string): Outcome => (state === "failed" ? "failed" : state === "canceled" ? "canceled" : "done");
const loadHistory = (): HistoryEntry[] => {
  try {
    return parseHistory(localStorage.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
};
const fmtAt = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A finished job as the tray tracks it: when it ended, whether it needs reading, and its history line. */
interface Finished {
  at: number;
  attention: boolean;
  entry: HistoryEntry;
}

/** Background jobs from every node, polled while anything is active. */
export function JobsTray({ nodes }: { nodes: NodeInfo[] }) {
  const [jobs, setJobs] = useState<Record<string, JobView[]>>({});
  const [ops, setOps] = useState<OpJob[]>([]);
  const uploads = useUploads();
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpJob | undefined>();
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const seen = useRef(new Map<string, string>());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);
  const again = useRef(false);
  // Finished jobs by key: when they were first seen finished. Clean ones leave the live list soon after, but stay in history.
  const finished = useRef(new Map<string, Finished>());
  const firstLoad = useRef(true);
  const cleared = useRef(new Set<string>());
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [, tick] = useState(0);

  const track = useCallback((key: string, state: string, endedAt: number | undefined, createdAt: number, title: string, where: string | undefined, attention: boolean, detail: string | undefined) => {
    if (state !== "done" && state !== "failed" && state !== "canceled") return;
    if (finished.current.has(key)) return;
    // Already finished when the page opened: do not let it linger as if it had just ended.
    const at = endedAt ?? (firstLoad.current ? createdAt : Date.now());
    finished.current.set(key, { at, attention: attention || state === "failed", entry: { key, title, where, outcome: outcomeOf(state), detail, at } });
  }, []);
  const trackOp = useCallback((o: OpJob) => {
    const c = o.counts;
    const detail = o.state === "failed" && o.error ? o.error : `${c.done} done${c.skipped ? `, ${c.skipped} skipped` : ""}${c.failed ? `, ${c.failed} failed` : ""}`;
    track("o:" + o.id, o.state, o.finishedAt, o.createdAt, o.title, undefined, c.failed > 0 || c.skipped > 0, detail);
  }, [track]);
  const flushHistory = useCallback(() => {
    const all = [...finished.current.values()].map((f) => f.entry).filter((e) => !cleared.current.has(e.key));
    setHistory((h) => addToHistory(h, all));
  }, []);

  const poll = useCallback(async () => {
    if (busy.current) {
      again.current = true; // a poll is in flight with the old selection: run once more when it ends
      return;
    }
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
    for (const [node, l] of Object.entries(next))
      for (const j of l) {
        const sk = j.result?.skipped;
        track(`j:${node}:${j.id}`, j.state, undefined, j.createdAt, j.title, node, !!sk && sk.symlinks + sk.hardlinks + sk.special > 0, j.state === "failed" ? j.error : j.result?.path);
      }
    for (const o of opList) trackOp(o);
    firstLoad.current = false;
    flushHistory();
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
    if (again.current) {
      again.current = false;
      void poll();
    }
  }, [track, trackOp, flushHistory]);

  // Expanding a job's items fetches them at once; without live jobs the regular poll is 10 s apart.
  useEffect(() => {
    if (open) void poll();
  }, [open, poll]);

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
  // Folded by the idle timer rather than by the user: not persisted, and any new activity undoes it.
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const setCollapsedPersist = useCallback((v: boolean) => {
    setCollapsed(v);
    if (!v) setAutoCollapsed(false);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);
  // A newly started job expands the tray so progress is visible.
  useEffect(() => onJobStarted(() => setCollapsedPersist(false)), [setCollapsedPersist]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* storage unavailable: history lasts for this page view */
    }
  }, [history]);

  const now = Date.now();
  // Uploads end in this browser, so they are recorded here rather than in the poll.
  for (const u of uploads) {
    const f = u.files.filter((x) => x.state === "done").length;
    track("u:" + u.id, u.state, u.finishedAt, u.createdAt, u.title, `${u.node}:${u.dir}`, u.files.some((x) => x.state === "failed"), `${f} / ${u.files.length} files`);
  }
  useEffect(flushHistory, [uploads, flushHistory]);
  const lingers = (key: string) => {
    const f = finished.current.get(key);
    return !f || stillLingering(f.at, now, f.attention);
  };
  // Clean, finished jobs leave the live list a few seconds after ending (failures linger longer); history keeps them.
  const opRows = ops.filter((o) => opLive(o) || lingers("o:" + o.id));
  const upRows = uploads.filter((u) => !(u.state === "done" || u.state === "failed" || u.state === "canceled") || lingers("u:" + u.id));
  const rows = Object.entries(jobs).flatMap(([node, l]) => l.filter((j) => live(j) || lingers(`j:${node}:${j.id}`)).map((job) => ({ node, job })));
  const running = rows.filter((r) => live(r.job)).length + opRows.filter(opLive).length + upRows.filter((u) => u.state === "running" || u.state === "paused").length;
  const total = rows.length + opRows.length + upRows.length;
  // Questions need attention, so the tray opens by itself.
  const asking = opRows.some((o) => o.state === "waiting");
  const idle = total === 0;

  // Re-render when the next finished job is due to leave the live list.
  const dueIn = nextExpiry([...finished.current.values()], now);
  useEffect(() => {
    if (dueIn === null) return;
    const t = setTimeout(() => tick((n) => n + 1), dueIn + 20);
    return () => clearTimeout(t);
  });
  // Nothing live or lingering for a while: fold the tray away. Activity opens it again.
  useEffect(() => {
    if (!idle) {
      setAutoCollapsed(false);
      return;
    }
    const since = Date.now();
    const t = setTimeout(() => {
      if (shouldAutoCollapse(since, Date.now())) setAutoCollapsed(true);
    }, IDLE_COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [idle]);

  if (!total && !history.length) return null;
  const folded = (collapsed || autoCollapsed) && !asking;
  const clearHistory = () => {
    setHistory([]);
    setShowHistory(false);
    // Jobs finished so far must not be re-added by the next poll.
    cleared.current = new Set(finished.current.keys());
  };
  return (
    <section className={"jobs" + (folded ? " collapsed" : "")} aria-label="Background jobs">
      <span className="sr-only" role="status">{asking ? `${total} background jobs. An operation needs an answer.` : `${running} of ${total} background jobs running.`}</span>
      <button type="button" className="jobs-toggle" aria-expanded={!folded} onClick={() => setCollapsedPersist(!folded)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        Jobs
        <span className="n">{asking ? "needs an answer" : running > 0 ? `${running} running` : total > 0 ? total : `${history.length} past`}</span>
      </button>
      {!folded && (
        <div className="jobs-body">
          {total > 0 ? (
            <ul>
              {upRows.map((b) => (
                <UploadRow key={b.id} b={b} expanded={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} />
              ))}
              {opRows.map((job) => (
                <OpRow key={job.id} job={job} detail={open === job.id ? detail : undefined} expanded={open === job.id} onToggle={() => setOpen(open === job.id ? null : job.id)} onChange={() => void poll()} />
              ))}
              {rows.map(({ node, job }) => (
                <JobRow key={node + job.id} node={node} job={job} onChange={() => void poll()} />
              ))}
            </ul>
          ) : (
            <p className="muted jobs-idle">No jobs running.</p>
          )}
          {history.length > 0 && (
            <div className="jobs-hist">
              <div className="jobs-hist-head">
                <button type="button" aria-expanded={showHistory} aria-controls="jobs-history" onClick={() => setShowHistory(!showHistory)}>
                  <Ic.History /> History ({history.length})
                </button>
                {showHistory && <button type="button" className="jobs-clear" onClick={clearHistory}><Ic.Eraser /> Clear history</button>}
              </div>
              {showHistory && (
                <ul id="jobs-history" className="jobs-hist-list" aria-label="Past jobs">
                  {history.map((h) => (
                    <li key={h.key}>
                      <div className="h-line">
                        <span className="h-title">{h.title}</span>
                        <span className={"h-out " + h.outcome}>{h.outcome}</span>
                      </div>
                      <div className="muted h-detail">{[fmtAt(h.at), h.where, h.detail].filter(Boolean).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
