import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUploads, pauseUpload, resumeUpload, cancelUpload, retryFailed, dismissUpload, type UpBatch } from "./uploads";
import { api, emitOpFinished, startedOps, fmtSize, onJobStarted, opLive, type JobView, type NodeInfo, type OpJob } from "./api";
import { Check, Circle, Loader, Minus, X } from "lucide-react";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";
import { splitByOrigin } from "./jobOrigin";
import { gaveUp } from "./jobPoll";
import { etaText, jobLines, statusPill } from "./jobRow";
import { HISTORY_KEY, IDLE_COLLAPSE_MS, addToHistory, nextExpiry, parseHistory, shouldAutoCollapse, stillLingering, type HistoryEntry, type Outcome } from "./jobHistory";

const COLLAPSE_KEY = "filedeck-jobs-collapsed";
const live = (j: JobView) => j.state === "queued" || j.state === "running";

function pct(j: JobView): number | null {
  const p = j.progress;
  if (p.totalBytes > 0) return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  if (p.totalEntries > 0) return Math.min(100, Math.round((p.entries / p.totalEntries) * 100));
  return null;
}

const cut = (w: HTMLElement) => w.scrollWidth > w.clientWidth || w.scrollHeight > w.clientHeight + 1;
/** One line (or, with `wrap`, up to two) with an ellipsis; the full text opens as a tooltip only when it is cut off, and then the text takes focus so keyboard and touch reach it. */
function Ell({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isCut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const measure = () => setCut(cut(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <Tip fill label={text} when={cut}>
      <span ref={ref} tabIndex={isCut ? 0 : undefined}>{text}</span>
    </Tip>
  );
}
/** Top right of a row: cancel while live, dismiss once finished (uploads and failed rows keep their dismiss). */
const Corner = ({ title, live, onCancel, onDismiss }: { title: string; live: boolean; onCancel: () => void; onDismiss: () => void }) =>
  live ? (
    <Tip label="Cancel"><button className="job-x" aria-label={`Cancel ${title}`} onClick={onCancel}><X /></button></Tip>
  ) : (
    <Tip label="Dismiss"><button className="job-x" aria-label={`Dismiss ${title}`} onClick={onDismiss}><X /></button></Tip>
  );
/** Subject line with the corner button, then the server and status pills (row actions sit at the right of the pills). */
function Top({ title, server, pill, corner, children }: { title: string; server: string; pill: ReturnType<typeof statusPill>; corner: React.ReactNode; children?: React.ReactNode }) {
  return (
    <>
      <div className="job-head">
        <b className="job-title"><Ell text={title} /></b>
        {corner}
      </div>
      <div className="job-pills">
        <span className="job-pill">{server}</span>
        <span className={"job-pill " + pill.tone}>{pill.label}</span>
        {children && <span className="job-acts">{children}</span>}
      </div>
    </>
  );
}
const Lines = ({ lines, wrap }: { lines: string[]; wrap?: boolean }) => (
  <>
    {lines.slice(0, 2).map((l, i) => (
      <div key={i} className={"muted job-detail" + (wrap ? " wrap" : "")}><Ell text={l} /></div>
    ))}
  </>
);

function JobRow({ node, job, stale, onChange }: { node: string; job: JobView; stale: boolean; onChange: () => void }) {
  const p = pct(job);
  const act = (fn: () => Promise<unknown>) => void fn().catch(() => undefined).finally(onChange);
  return (
    <li className={"job " + job.state}>
      <Top title={job.title} server={node} pill={statusPill(job.state, { stale, who: "agent", pct: p })} corner={<Corner title={job.title} live={live(job)} onCancel={() => act(() => api.cancelJob(node, job.id))} onDismiss={() => act(() => api.dismissJob(node, job.id))} />} />
      {live(job) && (p === null ? <progress aria-label={job.title} /> : <progress aria-label={job.title} max={100} value={p} />)}
      <Lines lines={jobLines(job, Date.now())} wrap={job.state === "failed"} />
    </li>
  );
}

const opPct = (j: OpJob): number | null => {
  const p = j.progress;
  if (p.totalBytes > 0) return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  if (p.totalEntries > 0) return Math.min(100, Math.round((p.entries / p.totalEntries) * 100));
  return null;
};

function detailLines(job: OpJob, eta: number | null, live: boolean): string[] {
  const p = job.progress;
  if (job.state === "queued") return ["waiting for a free slot"];
  if (p.current === "scanning") return ["scanning..."];
  const unit = job.op === "copy" || job.op === "move" ? "files" : job.op === "sync" ? "steps" : "items";
  const parts: string[] = [];
  if (p.totalBytes > 0 || p.bytes > 0) parts.push(`${fmtSize(p.bytes)}${p.totalBytes > 0 ? ` of ${fmtSize(p.totalBytes)}` : ""}`);
  if (job.state === "running" && job.speed > 0) parts.push(`${fmtSize(job.speed)}/s`);
  if (eta !== null) parts.push(etaText(eta));
  if (p.totalEntries > 0) parts.push(`${p.entries.toLocaleString()} of ${p.totalEntries.toLocaleString()} ${unit}`);
  const c = job.counts;
  const tally = `${c.done} done${c.skipped ? `, ${c.skipped} skipped` : ""}${c.failed ? `, ${c.failed} failed` : ""}`;
  if (job.state === "failed" && job.error) return [parts.join(", ") || tally, job.error].filter(Boolean);
  return [parts.join(", "), live ? p.current : tally].filter(Boolean);
}

/** A hub-side bulk job: per-item progress, throughput, pause/cancel and the conflict question. */
function OpRow({ job, stale, detail, expanded, onToggle, onChange }: { job: OpJob; stale: boolean; detail?: OpJob; expanded: boolean; onToggle: () => void; onChange: () => void }) {
  const [all, setAll] = useState(false);
  const [askErr, setAskErr] = useState("");
  // an answer can be refused while the job moves to a new server: show why
  const answer = (a: "skip" | "overwrite" | "rename") => void api.opResolve(job.id, a, all).then(() => setAskErr(""), (e) => setAskErr((e as Error).message)).finally(onChange);
  const p = opPct(job);
  const act = (fn: () => Promise<unknown>) => void fn().catch(() => undefined).finally(onChange);
  const live = opLive(job);
  const eta = job.state === "running" && job.speed > 0 && job.progress.totalBytes > job.progress.bytes ? (job.progress.totalBytes - job.progress.bytes) / job.speed : null;
  const items = (detail ?? job).items ?? [];
  const c = job.counts;
  return (
    <li className={"job op " + job.state} data-job-id={job.id}>
      <Top
        title={job.title}
        server="hub"
        pill={statusPill(job.state, { stale, who: "hub", pct: p })}
        corner={<Corner title={job.title} live={live} onCancel={() => act(() => api.opAction(job.id, "cancel"))} onDismiss={() => act(() => api.dismissOp(job.id))} />}
      >
        {live && job.state !== "waiting" && (
          job.state === "paused" ? (
            <button onClick={() => act(() => api.opAction(job.id, "resume"))}><Ic.Play /> Resume</button>
          ) : (
            <button onClick={() => act(() => api.opAction(job.id, "pause"))}><Ic.Pause /> Pause</button>
          )
        )}
      </Top>
      {live && (p === null ? <progress aria-label={job.title} /> : <progress aria-label={job.title} max={100} value={p} />)}
      {live && job.conflict && (
        <div className="job-ask" role="group" aria-label="Name conflict">
          <div>
            <b>{job.conflict.name}</b> already exists at <span className="muted">{job.conflict.target}</span>
            {job.conflict.srcType === "file" && job.conflict.dstType === "file" && <span className="muted"> ({fmtSize(job.conflict.srcSize)} replaces {fmtSize(job.conflict.dstSize)})</span>}
          </div>
          <div className="job-ask-btns">
            <button onClick={() => answer("skip")}><Ic.SkipForward /> Skip</button>
            <button onClick={() => answer("overwrite")}>{job.conflict.dstType === "dir" && job.conflict.srcType === "dir" ? <Ic.Merge /> : <Ic.Replace />} {job.conflict.dstType === "dir" && job.conflict.srcType === "dir" ? "Merge" : "Overwrite"}</button>
            <button className="primary" onClick={() => answer("rename")}><Ic.CopyPlus /> Keep both</button>
          </div>
          {askErr && <div className="fp-err">{askErr}</div>}
          <label className="ck"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span className="ck-box" aria-hidden="true"><Ic.Check /></span><span>Apply to all remaining</span></label>
        </div>
      )}
      <Lines lines={detailLines(job, eta, live)} wrap={job.state === "failed"} />
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
  return (
    <li className={"job op upload " + b.state} data-job-id={b.id}>
      <Top
        title={b.title}
        server={b.node}
        pill={statusPill(b.state, { pct: b.state === "running" ? p : null })}
        corner={<Corner title={b.title} live={live} onCancel={() => cancelUpload(b.id)} onDismiss={() => dismissUpload(b.id)} />}
      >
        {b.state === "running" && <button onClick={() => pauseUpload(b.id)}><Ic.Pause /> Pause</button>}
        {b.state === "paused" && <button onClick={() => resumeUpload(b.id)}><Ic.Play /> Resume</button>}
        {failed > 0 && !live && <button onClick={() => retryFailed(b.id)}><Ic.RotateCw /> Retry failed</button>}
      </Top>
      {live && <progress aria-label={b.title} max={100} value={p} />}
      <Lines
        lines={[
          [`${fmtSize(sent)} of ${fmtSize(b.totalBytes)}`, b.state === "running" && b.speed > 0 ? `${fmtSize(b.speed)}/s` : "", eta !== null ? etaText(eta) : ""].filter(Boolean).join(", "),
          [`${done} of ${b.files.length} files${b.dirs.length ? `, ${b.dirs.length} folders` : ""}`, failed ? `${failed} failed` : "", `to ${b.dir}`].filter(Boolean).join(", "),
        ]}
      />
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
  // Nodes (and the hub) whose last poll failed: their previous list stays, marked stale, until the outage is five minutes old.
  const [stale, setStale] = useState<Set<string>>(new Set());
  const downSince = useRef(new Map<string, number>());
  const prev = useRef<{ jobs: Record<string, JobView[]>; ops: OpJob[] }>({ jobs: {}, ops: [] });
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
  const [showBg, setShowBg] = useState(false);
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
    const down = new Set<string>();
    const opsP = api.opJobs().then((r) => r.jobs, () => (down.add("hub"), prev.current.ops));
    const detailP = openRef.current ? api.opJob(openRef.current).catch(() => undefined) : Promise.resolve(undefined);
    await Promise.all(
      nodesRef.current
        .filter((n) => n.online || prev.current.jobs[n.name]?.some(live)) // an offline node with live jobs may just be restarting
        .map(async (n) => {
          try {
            next[n.name] = (await api.jobs(n.name)).jobs;
          } catch {
            down.add(n.name);
            next[n.name] = prev.current.jobs[n.name] ?? [];
          }
        }),
    );
    let [opList, det] = await Promise.all([opsP, detailP]);
    busy.current = false;
    const t = Date.now();
    for (const k of [...downSince.current.keys()]) if (!down.has(k)) downSince.current.delete(k);
    for (const k of down) {
      if (!downSince.current.has(k)) downSince.current.set(k, t);
      if (!gaveUp(downSince.current.get(k) as number, t)) continue;
      down.delete(k);
      if (k === "hub") opList = [];
      else next[k] = [];
    }
    prev.current = { jobs: next, ops: opList };
    setStale(down);
    for (const [node, l] of Object.entries(next))
      for (const j of splitByOrigin(l).fore) {
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
    timer.current = setTimeout(() => void poll(), down.size ? 2000 : active ? 700 : 10000);
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
  // Background jobs (CLI, watcher) never open the tray, count in its badge or enter its history: they have their own view, live ones only.
  const split = Object.entries(jobs).map(([node, l]) => ({ node, ...splitByOrigin(l) }));
  const rows = split.flatMap(({ node, fore }) => fore.filter((j) => live(j) || lingers(`j:${node}:${j.id}`)).map((job) => ({ node, job })));
  const bgRows = split.flatMap(({ node, back }) => back.filter(live).map((job) => ({ node, job })));
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

  if (!total && !history.length && !bgRows.length) return null;
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
        <span className="n">{asking ? "needs an answer" : running > 0 ? `${running} running` : total > 0 ? total : history.length > 0 ? `${history.length} past` : "idle"}</span>
      </button>
      {!folded && (
        <div className="jobs-body">
          {total > 0 ? (
            <ul>
              {upRows.map((b) => (
                <UploadRow key={b.id} b={b} expanded={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} />
              ))}
              {opRows.map((job) => (
                <OpRow key={job.id} job={job} stale={stale.has("hub")} detail={open === job.id ? detail : undefined} expanded={open === job.id} onToggle={() => setOpen(open === job.id ? null : job.id)} onChange={() => void poll()} />
              ))}
              {rows.map(({ node, job }) => (
                <JobRow key={node + job.id} node={node} job={job} stale={stale.has(node)} onChange={() => void poll()} />
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
      {bgRows.length > 0 && (
        <div className="jobs-bg">
          <button type="button" className="jobs-bg-toggle" aria-expanded={showBg} aria-controls="jobs-background" onClick={() => setShowBg(!showBg)}>
            <Ic.Activity /> Background jobs <span className="n">{bgRows.length}</span>
          </button>
          {showBg && (
            <ul id="jobs-background" className="jobs-bg-list" aria-label="Background jobs list">
              {bgRows.map(({ node, job }) => (
                <JobRow key={node + job.id} node={node} job={job} stale={stale.has(node)} onChange={() => void poll()} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
