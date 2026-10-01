import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  fmtDate,
  fmtSize,
  type DiffApiOptions,
  type DiffMode,
  type DiffResult,
  type DiffRow,
  type DiffStatus,
  type JobView,
  type OpJob,
  type SyncStepSpec,
  opLive,
  type Loc,
  type NodeInfo,
} from "./api";
import { joinRel, planSync, type Plan, type Step, type SyncAction } from "./folderSync";
import { DEFAULT_UI, type FolderState, type UiOpts } from "./urlState";

/* ------------------------------------------------------------------ options, presets, URL */

const MODES: { id: DiffMode; label: string; help: string }[] = [
  { id: "name", label: "Name only", help: "Present on both sides means identical" },
  { id: "size", label: "Size", help: "Same size" },
  { id: "mtime", label: "Modified time", help: "Same mtime within the tolerance" },
  { id: "quick", label: "Quick (size + time, then hash)", help: "Size differs: different. Size and time match: identical. Otherwise compare sha256 on the agents" },
  { id: "content", label: "Content (sha256)", help: "Equal size, then sha256 computed on each node; no file data crosses nodes" },
];
const toApi = (o: UiOpts): DiffApiOptions => ({
  mode: o.mode,
  toleranceMs: Math.max(0, Math.round(o.toleranceSec * 1000)),
  ignoreCase: o.ignoreCase,
  ignoreHidden: o.ignoreHidden,
  include: o.include,
  exclude: o.exclude,
  depth: o.depth,
  maxEntries: o.maxEntries,
});

const PRESET_KEY = "filedeck-folderdiff-presets";
type Presets = Record<string, UiOpts>;
function loadPresets(): Presets {
  try {
    const v = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "{}") as Presets;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function savePresets(p: Presets) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/* ------------------------------------------------------------------ tree */

interface TNode {
  row: DiffRow;
  name: string;
  isDir: boolean;
  depth: number;
  children: TNode[];
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isDirRow = (r: DiffRow) => (r.l?.t ?? r.r?.t) === "dir";

function buildTree(rows: DiffRow[]): TNode[] {
  const nodes = new Map<string, TNode>();
  for (const row of rows) nodes.set(row.p, { row, name: nameOf(row.p), isDir: isDirRow(row), depth: 0, children: [] });
  const roots: TNode[] = [];
  for (const n of nodes.values()) {
    const i = n.row.p.lastIndexOf("/");
    const parent = i > 0 ? nodes.get(n.row.p.slice(0, i)) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (list: TNode[], depth: number) => {
    list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of list) {
      n.depth = depth;
      sort(n.children, depth + 1);
    }
  };
  sort(roots, 0);
  return roots;
}

const STATUS: Record<DiffStatus, { sym: string; label: string }> = {
  identical: { sym: "=", label: "Identical" },
  different: { sym: "≠", label: "Different" },
  "left-only": { sym: "◀", label: "Left only" },
  "right-only": { sym: "▶", label: "Right only" },
  error: { sym: "!", label: "Error" },
};
const ALL_STATUS = Object.keys(STATUS) as DiffStatus[];
const ROW_H = 26;

function descendants(n: TNode, out: string[] = []): string[] {
  out.push(n.row.p);
  for (const c of n.children) descendants(c, out);
  return out;
}

/* ------------------------------------------------------------------ component */

export interface FolderDiffInit extends Omit<FolderState, "left" | "right"> {
  left: Loc | null;
  right: Loc | null;
  /** start comparing as soon as it opens (set when restored from a shared URL) */
  autorun: boolean;
}

interface Props {
  init: FolderDiffInit;
  /** reports the current folders and options so the app can mirror them into the URL */
  onState: (s: FolderState) => void;
  nodes: NodeInfo[];
  onClose: () => void;
  onFileDiff: (left: Loc, right: Loc) => void;
  onStatus: (m: string) => void;
}

interface Exec {
  action: SyncAction;
  plan: Plan;
  state: "plan" | "running" | "done";
  done: number;
  current: string;
  errors: string[];
  canceled: boolean;
  jobId?: string;
  job?: OpJob;
}

const ACTION_LABEL: Record<SyncAction, string> = {
  "copy-lr": "Copy left to right",
  "copy-rl": "Copy right to left",
  "delete-left": "Delete from left",
  "delete-right": "Delete from right",
};

export function FolderDiff({ init, onState, nodes, onClose, onFileDiff, onStatus }: Props) {
  const firstNode = nodes[0]?.name ?? "";
  const [left, setLeft] = useState<Loc>(init.left ?? { node: firstNode, path: "/" });
  const [right, setRight] = useState<Loc>(init.right ?? { node: firstNode, path: "/" });
  const [opts, setOpts] = useState<UiOpts>(init.opts);
  const [presets, setPresets] = useState<Presets>(loadPresets);
  const [preset, setPreset] = useState(init.preset);
  const [presetName, setPresetName] = useState("");
  const [showOpts, setShowOpts] = useState(!init.autorun);

  const [job, setJob] = useState<JobView | null>(null);
  const [jobId, setJobId] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<DiffResult | null>(null);
  const [shown, setShown] = useState<Set<DiffStatus>>(new Set(ALL_STATUS));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exec, setExec] = useState<Exec | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const running = job !== null && (job.state === "queued" || job.state === "running");

  useEffect(() => {
    onState({ left, right, opts, preset });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, right, opts, preset]);

  const start = useCallback(async () => {
    if (!left.node || !right.node) return setErr("Pick a node for both sides");
    setErr("");
    setResult(null);
    setSelected(new Set());
    try {
      const j = await api.startDiff(left, right, toApi(opts));
      setJob(j);
      setJobId(j.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [left, right, opts]);

  // Poll the job on the hub; fetch the result once it is done.
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = await api.diffJob(jobId);
        if (!live) return;
        setJob(j);
        if (j.state === "done") {
          const r = await api.diffResult(jobId);
          if (!live) return;
          setResult(r);
          setExpanded(new Set(r.rows.filter((x) => isDirRow(x) && x.status === "different").map((x) => x.p)));
          setShowOpts(false);
          setJobId("");
          api.dismissDiff(jobId).catch(() => undefined);
          return;
        }
        if (j.state === "failed") {
          setErr(j.error ?? "Comparison failed");
          setJobId("");
          return;
        }
        if (j.state === "canceled") {
          setErr("Comparison canceled");
          setJobId("");
          return;
        }
      } catch (e) {
        if (live) {
          setErr((e as Error).message);
          setJobId("");
        }
        return;
      }
      timer = setTimeout(() => void tick(), 400);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (init.autorun && firstNode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstNode]);

  const close = () => {
    if (jobId) api.cancelDiff(jobId).catch(() => undefined);
    onClose();
  };

  /* ---------- tree view model ---------- */
  const tree = useMemo(() => (result ? buildTree(result.rows) : []), [result]);
  const visible = useMemo(() => {
    const ok = new Map<TNode, boolean>();
    const mark = (n: TNode): boolean => {
      let v = shown.has(n.row.status);
      for (const c of n.children) if (mark(c)) v = true;
      ok.set(n, v);
      return v;
    };
    tree.forEach(mark);
    const flat: TNode[] = [];
    const walk = (list: TNode[]) => {
      for (const n of list) {
        if (!ok.get(n)) continue;
        flat.push(n);
        if (n.isDir && expanded.has(n.row.p)) walk(n.children);
      }
    };
    walk(tree);
    return flat;
  }, [tree, shown, expanded]);

  const winH = scroller.current?.clientHeight ?? 700;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const last = Math.min(visible.length, Math.ceil((scrollTop + winH) / ROW_H) + 6);

  const allDirs = useMemo(() => (result ? result.rows.filter(isDirRow).map((r) => r.p) : []), [result]);
  const toggleSel = (n: TNode) => {
    const all = descendants(n);
    setSelected((s) => {
      const next = new Set(s);
      const on = !s.has(n.row.p);
      for (const p of all) on ? next.add(p) : next.delete(p);
      return next;
    });
  };
  const open = (n: TNode) => {
    const r = n.row;
    if (n.isDir) return setExpanded((e) => (e.has(r.p) ? new Set([...e].filter((x) => x !== r.p)) : new Set(e).add(r.p)));
    if (!r.l || !r.r) return onStatus(`${r.p} exists only on the ${r.l ? "left" : "right"} side`);
    if (r.l.t !== "file" || r.r.t !== "file") return onStatus("Only regular files can be diffed");
    if (r.status === "identical") return onStatus(`${r.p} is identical on both sides`);
    onFileDiff({ node: left.node, path: joinRel(left.path, r.p) }, { node: right.node, path: joinRel(right.path, r.rp ?? r.p) });
  };

  /* ---------- sync ---------- */
  const filtersActive = !!(opts.include.trim() || opts.exclude.trim() || opts.ignoreHidden) || (result?.warnings.length ?? 0) > 0;
  const preview = (action: SyncAction) => {
    if (!result) return;
    const plan = planSync(result.rows, selected, action, { wholeDirs: !filtersActive });
    setExec({ action, plan, state: "plan", done: 0, current: "", errors: [], canceled: false });
  };
  const loc = (side: "left" | "right") => (side === "left" ? left : right);
  const other = (side: "left" | "right") => (side === "left" ? "right" : "left");
  /** The plan becomes one hub job: it keeps running when this dialog or the browser is closed. */
  const execute = async () => {
    if (!exec) return;
    const steps: SyncStepSpec[] = [];
    for (const s of exec.plan.steps) {
      if (s.op === "skip") continue;
      if (s.op === "mkdir") steps.push({ kind: "mkdir", node: loc(s.side).node, path: joinRel(loc(s.side).path, s.rel) });
      else if (s.op === "trash") steps.push({ kind: "trash", node: loc(s.side).node, path: joinRel(loc(s.side).path, s.rel) });
      else {
        const from = loc(s.from);
        const to = loc(other(s.from));
        steps.push({
          kind: "copy",
          src: { node: from.node, path: joinRel(from.path, s.srcRel) },
          dst: { node: to.node, dir: s.destDirRel ? joinRel(to.path, s.destDirRel) : to.path },
          bytes: s.bytes,
        });
      }
    }
    try {
      const job = await api.startOp({ op: "sync", steps, title: `${ACTION_LABEL[exec.action]}: ${left.node}:${left.path} / ${right.node}:${right.path}` });
      setExec({ ...exec, state: "running", jobId: job.id, job });
    } catch (e) {
      setExec({ ...exec, state: "done", errors: [(e as Error).message], done: 0 });
    }
  };
  // Follow the sync job while the dialog is open.
  const execJobId = exec?.state === "running" ? exec.jobId : undefined;
  useEffect(() => {
    if (!execJobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const job = await api.opJob(execJobId);
        if (stop) return;
        if (opLive(job)) setExec((x) => (x && x.jobId === execJobId ? { ...x, job } : x));
        else {
          const errors = (job.items ?? []).filter((i) => i.error).slice(0, 50).map((i) => `${i.label}: ${i.error}`);
          setExec((x) => (x && x.jobId === execJobId ? { ...x, job, state: "done", done: job.counts.done, errors, canceled: job.state === "canceled" } : x));
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(() => void tick(), 600);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [execJobId]);
  const finishExec = () => {
    const ran = exec?.state === "done";
    setExec(null);
    if (ran) void start();
  };

  const counts = result?.files;
  const sizeTotal = (ps: Plan) => fmtSize(ps.bytes);

  return (
    <div className="ed fd" role="dialog" aria-label="Folder diff">
      <header className="ed-head">
        <b>Folder diff</b>
        <span className="ed-spacer" />
        <button onClick={close} title="Close">Close</button>
      </header>

      <div className="fd-setup">
        <div className="fd-locs">
          <LocEdit label="Left" loc={left} nodes={nodes} onChange={setLeft} />
          <button title="Swap sides" aria-label="Swap sides" onClick={() => { setLeft(right); setRight(left); }}>⇄</button>
          <LocEdit label="Right" loc={right} nodes={nodes} onChange={setRight} />
          <button className="primary" onClick={() => void start()} disabled={running}>{result ? "Compare again" : "Compare"}</button>
          <button onClick={() => setShowOpts((v) => !v)} aria-expanded={showOpts}>Options {showOpts ? "▴" : "▾"}</button>
        </div>

        {showOpts && (
          <div className="fd-opts">
            <label>
              Compare by
              <select value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value as DiffMode })} title={MODES.find((m) => m.id === opts.mode)?.help}>
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label title="Modified times closer than this count as equal">
              Time tolerance (s)
              <input type="number" min={0} step={1} value={opts.toleranceSec} onChange={(e) => setOpts({ ...opts, toleranceSec: Number(e.target.value) })} />
            </label>
            <label>
              Include (globs)
              <input type="text" value={opts.include} placeholder="*.ts, src/**" onChange={(e) => setOpts({ ...opts, include: e.target.value })} />
            </label>
            <label>
              Exclude (globs)
              <input type="text" value={opts.exclude} placeholder="node_modules/, *.log, .git/" onChange={(e) => setOpts({ ...opts, exclude: e.target.value })} />
            </label>
            <label>
              Max depth
              <input type="number" min={1} max={64} value={opts.depth} onChange={(e) => setOpts({ ...opts, depth: Number(e.target.value) })} />
            </label>
            <label>
              Max entries per side
              <input type="number" min={1} max={500000} step={1000} value={opts.maxEntries} onChange={(e) => setOpts({ ...opts, maxEntries: Number(e.target.value) })} />
            </label>
            <label className="chk"><input type="checkbox" checked={opts.ignoreCase} onChange={(e) => setOpts({ ...opts, ignoreCase: e.target.checked })} /> Ignore case in names</label>
            <label className="chk"><input type="checkbox" checked={opts.ignoreHidden} onChange={(e) => setOpts({ ...opts, ignoreHidden: e.target.checked })} /> Ignore hidden files</label>
            <div className="fd-presets">
              <label>
                Preset
                <select
                  value={preset}
                  onChange={(e) => {
                    const name = e.target.value;
                    setPreset(name);
                    if (name && presets[name]) setOpts({ ...DEFAULT_UI, ...presets[name] });
                  }}
                >
                  <option value="">(none)</option>
                  {Object.keys(presets).sort().map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
              <label>
                Save current options as
                <input type="text" value={presetName} placeholder="name" onChange={(e) => setPresetName(e.target.value)} />
              </label>
              <button
                disabled={!presetName.trim()}
                onClick={() => {
                  const n = presetName.trim();
                  const next = { ...presets, [n]: opts };
                  setPresets(next);
                  savePresets(next);
                  setPreset(n);
                  setPresetName("");
                }}
              >Save preset</button>
              <button
                disabled={!preset}
                onClick={() => {
                  const next = { ...presets };
                  delete next[preset];
                  setPresets(next);
                  savePresets(next);
                  setPreset("");
                }}
              >Delete preset</button>
            </div>
          </div>
        )}
      </div>

      {err && <div className="ed-banner err" role="alert">{err}</div>}

      {running && job && (
        <div className="fd-run" role="status">
          <b>{job.state === "queued" ? "Queued" : "Comparing"}</b>
          <span className="muted"> {job.progress.current}</span>
          {job.progress.totalEntries > 0 ? (
            <progress aria-label="Comparison progress" max={Math.max(1, job.progress.totalBytes)} value={job.progress.bytes} />
          ) : (
            <progress aria-label="Comparison progress" />
          )}
          <span className="muted">
            {job.progress.totalEntries > 0
              ? `${job.progress.entries} / ${job.progress.totalEntries} files hashed (${fmtSize(job.progress.bytes)} / ${fmtSize(job.progress.totalBytes)})`
              : `${job.progress.entries} entries found`}
          </span>
          <button onClick={() => void api.cancelDiff(job.id).catch(() => undefined)}>Cancel</button>
        </div>
      )}

      {result && counts && (
        <>
          <div className="fd-bar">
            <span className="fd-toggles" role="group" aria-label="Show">
              {ALL_STATUS.map((s) => {
                const n = s === "identical" ? counts.identical : s === "different" ? counts.different : s === "left-only" ? counts.leftOnly : s === "right-only" ? counts.rightOnly : counts.error;
                if (s === "error" && !n) return null;
                return (
                  <button key={s} className={"fd-tog st-" + s} aria-pressed={shown.has(s)} onClick={() => setShown((x) => { const y = new Set(x); y.has(s) ? y.delete(s) : y.add(s); return y; })}>
                    <span aria-hidden>{STATUS[s].sym}</span> {STATUS[s].label} {n}
                  </button>
                );
              })}
            </span>
            <button onClick={() => setExpanded(new Set(allDirs))}>Expand all</button>
            <button onClick={() => setExpanded(new Set())}>Collapse all</button>
            <span className="fd-sep" />
            <button onClick={() => setSelected(new Set(visible.map((n) => n.row.p)))}>Select shown</button>
            <button onClick={() => setSelected(new Set(result.rows.filter((r) => r.status !== "identical").map((r) => r.p)))}>Select differing</button>
            <button onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
            <span className="fd-sep" />
            <span className="fd-sync" role="group" aria-label="Sync selected rows">
              <button disabled={!selected.size} onClick={() => preview("copy-lr")} title="Copy selected left items over to the right side">Copy ▶</button>
              <button disabled={!selected.size} onClick={() => preview("copy-rl")} title="Copy selected right items over to the left side">◀ Copy</button>
              <button disabled={!selected.size} onClick={() => preview("delete-left")} title="Move selected left items to the trash">Delete left</button>
              <button disabled={!selected.size} onClick={() => preview("delete-right")} title="Move selected right items to the trash">Delete right</button>
            </span>
            <span className="muted fd-count">{selected.size} selected</span>
          </div>
          <div className="fd-sum muted">
            {result.files.identical + result.files.different + result.files.leftOnly + result.files.rightOnly + result.files.error} files and {result.dirs.identical + result.dirs.different + result.dirs.leftOnly + result.dirs.rightOnly + result.dirs.error} folders compared in {(result.durationMs / 1000).toFixed(1)} s
            {result.hashedFiles > 0 && `; ${result.hashedFiles} file pairs hashed (${fmtSize(result.hashedBytes)} read on the agents)`}
          </div>
          {result.warnings.map((w) => <div key={w} className="ed-banner" role="alert">{w}</div>)}

          <div className="fd-head" aria-hidden>
            <span />
            <span>Name</span>
            <span className="num">Left size</span>
            <span>Left modified</span>
            <span>Status</span>
            <span className="num">Right size</span>
            <span>Right modified</span>
          </div>
          <div className="fd-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="tree" aria-label="Comparison result">
            <div style={{ height: visible.length * ROW_H, position: "relative" }}>
              {visible.slice(first, last).map((n, k) => {
                const r = n.row;
                const i = first + k;
                return (
                  <div
                    key={r.p}
                    role="treeitem"
                    aria-level={n.depth + 1}
                    aria-expanded={n.isDir ? expanded.has(r.p) : undefined}
                    aria-selected={selected.has(r.p)}
                    tabIndex={0}
                    className={"fd-row st-" + r.status + (selected.has(r.p) ? " sel" : "")}
                    style={{ top: i * ROW_H, height: ROW_H }}
                    onDoubleClick={() => open(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") open(n);
                      else if (e.key === " ") { e.preventDefault(); toggleSel(n); }
                      else if (e.key === "ArrowRight" && n.isDir) setExpanded((x) => new Set(x).add(r.p));
                      else if (e.key === "ArrowLeft" && n.isDir) setExpanded((x) => new Set([...x].filter((p) => p !== r.p)));
                    }}
                  >
                    <input type="checkbox" aria-label={`Select ${r.p}`} checked={selected.has(r.p)} onChange={() => toggleSel(n)} onDoubleClick={(e) => e.stopPropagation()} />
                    <span className="fd-name" style={{ paddingLeft: n.depth * 16 }} title={r.p}>
                      {n.isDir ? (
                        <button className="fd-caret" aria-label={expanded.has(r.p) ? "Collapse" : "Expand"} onClick={() => open(n)} onDoubleClick={(e) => e.stopPropagation()}>{expanded.has(r.p) ? "▾" : "▸"}</button>
                      ) : (
                        <span className="fd-caret" />
                      )}
                      <span aria-hidden>{n.isDir ? "📁" : r.l?.t === "symlink" || r.r?.t === "symlink" ? "🔗" : "📄"}</span> {n.name}
                    </span>
                    <span className="num">{r.l && !n.isDir ? fmtSize(r.l.s) : ""}</span>
                    <span className={r.newer === "left" ? "fd-newer" : ""}>{r.l ? fmtDate(r.l.m) : ""}{r.newer === "left" ? " ▲ newer" : ""}</span>
                    <span className="fd-status" title={r.why}>
                      <span aria-hidden>{STATUS[r.status].sym}</span> {STATUS[r.status].label}
                      {r.why && r.status !== "identical" && !n.isDir ? <span className="muted"> ({r.why})</span> : null}
                    </span>
                    <span className="num">{r.r && !n.isDir ? fmtSize(r.r.s) : ""}</span>
                    <span className={r.newer === "right" ? "fd-newer" : ""}>{r.r ? fmtDate(r.r.m) : ""}{r.newer === "right" ? " ▲ newer" : ""}</span>
                  </div>
                );
              })}
            </div>
            {!visible.length && <div className="pad muted">Nothing to show with the current filters.</div>}
          </div>
        </>
      )}

      {exec && (
        <div className="modal-back" role="dialog" aria-label={ACTION_LABEL[exec.action]}>
          <div className="modal wide">
            <h3>{ACTION_LABEL[exec.action]}</h3>
            {exec.state === "plan" && (
              <>
                <p className="muted">
                  Dry run: nothing has changed yet. {exec.plan.copies} file(s) to copy ({sizeTotal(exec.plan)}), {exec.plan.mkdirs} folder(s) to create, {exec.plan.trashes} item(s) to move to the trash
                  {exec.plan.skipped ? `, ${exec.plan.skipped} skipped` : ""}. Replaced and deleted items go to each node's trash and can be restored.
                </p>
                {exec.plan.notes.map((n) => <p key={n} className="muted">{n}</p>)}
                <PlanList steps={exec.plan.steps} />
                <div className="modal-actions">
                  <button onClick={finishExec}>Cancel</button>
                  <button className="primary" onClick={() => void execute()} disabled={exec.plan.steps.every((s) => s.op === "skip")}>Run</button>
                </div>
              </>
            )}
            {exec.state === "running" && (
              <>
                <progress aria-label="Sync progress" max={Math.max(1, exec.job?.counts.total ?? 1)} value={exec.job?.progress.entries ?? 0} />
                <p className="muted" role="status">
                  {exec.job?.progress.entries ?? 0} / {exec.job?.counts.total ?? "?"} steps
                  {exec.job && exec.job.progress.bytes > 0 ? ` - ${fmtSize(exec.job.progress.bytes)}${exec.job.speed > 0 ? ` at ${fmtSize(exec.job.speed)}/s` : ""}` : ""}
                  {exec.job?.state === "paused" ? " - paused" : ""} {exec.job?.progress.current ? `- ${exec.job.progress.current}` : ""}
                </p>
                <p className="muted">This runs on the server as a job (see Jobs in the sidebar): you can close this window and it keeps going.</p>
                <div className="modal-actions">
                  <button onClick={() => { if (exec.jobId) void api.opAction(exec.jobId, "cancel"); }}>Stop</button>
                  <button onClick={() => (setExec(null), void start())}>Close, keep running</button>
                </div>
              </>
            )}
            {exec.state === "done" && (
              <>
                <p role="status">{exec.canceled ? "Stopped" : "Finished"}: {exec.done} step(s) run, {exec.errors.length} failed.</p>
                {exec.errors.length > 0 && <ul className="fd-errs">{exec.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
                <div className="modal-actions"><button className="primary" onClick={finishExec}>Close and compare again</button></div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanList({ steps }: { steps: Step[] }) {
  const shown = steps.slice(0, 400);
  const text = (s: Step) =>
    s.op === "copy"
      ? `copy${s.replaces ? " (replace)" : ""} ${s.srcRel} ${s.from === "left" ? "▶" : "◀"}`
      : s.op === "mkdir"
        ? `create folder ${s.rel} on the ${s.side}`
        : s.op === "trash"
          ? `trash ${s.rel} on the ${s.side} (${s.why})`
          : `skip ${s.rel}: ${s.reason}`;
  return (
    <ul className="fd-plan" aria-label="Planned actions">
      {shown.map((s, i) => <li key={i} className={s.op}>{text(s)}</li>)}
      {steps.length > shown.length && <li className="muted">... and {steps.length - shown.length} more</li>}
      {!steps.length && <li className="muted">Nothing to do for the selected rows.</li>}
    </ul>
  );
}

function LocEdit({ label, loc, nodes, onChange }: { label: string; loc: Loc; nodes: NodeInfo[]; onChange: (l: Loc) => void }) {
  return (
    <fieldset className="fd-loc">
      <legend>{label}</legend>
      <select aria-label={`${label} node`} value={loc.node} onChange={(e) => onChange({ ...loc, node: e.target.value })}>
        {!nodes.some((n) => n.name === loc.node) && <option value={loc.node}>{loc.node}</option>}
        {nodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.online ? "" : " (offline)"}</option>)}
      </select>
      <input type="text" aria-label={`${label} folder`} value={loc.path} spellCheck={false} onChange={(e) => onChange({ ...loc, path: e.target.value.startsWith("/") ? e.target.value : "/" + e.target.value })} />
    </fieldset>
  );
}
