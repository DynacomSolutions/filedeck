// In-place folder compare (Total Commander / WinMerge style): two open panels show the two
// sides of one diff result, rows aligned by relative path, scrolling and navigation synced.
// The diff itself is the existing hub job (/api/diff/jobs); sync actions are one hub op job.
import { useSettings } from "./settings";
import { ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, CircleAlert, Equal, EqualNot, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtDate, fmtSize, opLive, type DiffApiOptions, type DiffCounts, type DiffJobView, type DiffMode, type DiffRow, type DiffStats, type Loc, type OpJob, type SyncStepSpec } from "./api";
import { flattenFolders, joinRoot, relUnder, type CNode, type FolderData } from "./compareModel";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { Tip } from "./Tooltip";
import { wheelX } from "./scrollx";
import { joinRel, planSync, type Plan, type Step, type SyncAction } from "./folderSync";
import { DEFAULT_UI, DIFF_STATUSES, type DiffStatus, type FolderState, type Leaf, type UiOpts } from "./urlState";
import * as Ic from "lucide-react";

/* ------------------------------------------------------------------ options and presets */

export const MODES: { id: DiffMode; label: string; short: string; help: string }[] = [
  { id: "name", label: "Name only", short: "Name", help: "Present on both sides means identical" },
  { id: "size", label: "Size", short: "Size", help: "Same size means identical" },
  { id: "mtime", label: "Modified time", short: "Time", help: "Same modified time (within the tolerance) means identical" },
  { id: "quick", label: "Quick (size + time, then hash)", short: "Quick", help: "Size differs: different. Size and time match: identical. Otherwise sha256 is compared on the nodes" },
  { id: "content", label: "Content (sha256)", short: "Content", help: "Equal size, then sha256 computed on each node; no file data crosses nodes" },
];
const toApi = (o: UiOpts): DiffApiOptions => ({
  mode: o.mode,
  toleranceMs: Math.max(0, Math.round(o.toleranceSec * 1000)),
  ignoreCase: o.ignoreCase,
  ignoreHidden: o.ignoreHidden,
  include: o.include,
  exclude: o.exclude,
  depth: o.depth,
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

export const STATUS: Record<DiffStatus, { Icon: LucideIcon; label: string }> = {
  identical: { Icon: Equal, label: "Identical" },
  different: { Icon: EqualNot, label: "Different" },
  "left-only": { Icon: ArrowLeft, label: "Left only" },
  "right-only": { Icon: ArrowRight, label: "Right only" },
  error: { Icon: CircleAlert, label: "Error" },
};
const ACTION_LABEL: Record<SyncAction, string> = {
  "copy-lr": "Copy left to right",
  "copy-rl": "Copy right to left",
  "delete-left": "Delete from left",
  "delete-right": "Delete from right",
};
/** Same height as a normal file-list row (22 px line plus 2 x .5rem padding and the 1 px separator). */
export const ROW_H = 39;
/** Height of the column header row inside each scroller (same on both sides, so row 0 lines up). */
export const HEAD_H = 28;

interface Exec {
  action: SyncAction;
  plan: Plan;
  state: "plan" | "running" | "done";
  done: number;
  errors: string[];
  canceled: boolean;
  jobId?: string;
  job?: OpJob;
}

/* ------------------------------------------------------------------ controller */

export type Side = "left" | "right";
export interface CompareCtl {
  st: FolderState;
  sideOf: (panelId: string) => Side | null;
  /** live totals of the running or finished compare (null before the first status) */
  summary: CompareSummary | null;
  job: DiffJobView | null;
  running: boolean;
  err: string;
  rows: CNode[];
  /** nesting depth of a visible row (expanded sub-folders), same list on both sides */
  depthOf: (p: string) => number;
  expanded: ReadonlySet<string>;
  toggleOpen: (p: string) => void;
  hide: ReadonlySet<DiffStatus>;
  selected: ReadonlySet<string>;
  cursor: string | null;
  setCursor: (p: string | null) => void;
  setSelected: (s: Set<string>) => void;
  click: (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, n: CNode) => void;
  open: (n: CNode) => void;
  go: (rel: string) => void;
  up: () => void;
  exit: () => void;
  start: (opts?: UiOpts) => void;
  cancel: () => void;
  selectDiffering: () => void;
  /** a row plus every loaded row below it */
  descend: (n: CNode) => string[];
  setOpts: (o: UiOpts) => void;
  setPreset: (p: string) => void;
  toggleStatus: (s: DiffStatus) => void;
  preview: (a: SyncAction) => void;
  exec: Exec | null;
  runExec: () => void;
  stopExec: () => void;
  closeExec: () => void;
  presets: Presets;
  savePreset: (name: string) => void;
  deletePreset: () => void;
  scrollers: React.MutableRefObject<{ left: HTMLElement | null; right: HTMLElement | null }>;
  syncScroll: (from: Side, top: number) => void;
  onStatus: (m: string) => void;
  filtersActive: boolean;
}
export interface CompareSummary {
  files: DiffCounts;
  dirs: DiffCounts;
  stats: DiffStats;
  done: boolean;
  /** folders scanned per second (recent) */
  rate: number;
}
const EMPTY: DiffCounts = { identical: 0, different: 0, leftOnly: 0, rightOnly: 0, error: 0 };
const nameOfRel = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const CompareCtx = createContext<CompareCtl | null>(null);
export const useCompareCtl = () => useContext(CompareCtx);

interface HookArgs {
  state: FolderState | null;
  setState: (fn: (s: FolderState | null) => FolderState | null) => void;
  leafOf: (id: string) => Leaf | undefined;
  patchLeaf: (id: string, p: Partial<Leaf>) => void;
  activeId: string;
  onFileDiff: (l: Loc, r: Loc) => void;
  onStatus: (m: string) => void;
}

export function useCompare({ state, setState, leafOf, patchLeaf, activeId, onFileDiff, onStatus }: HookArgs): CompareCtl | null {
  const st = state;
  const stRef = useRef(st);
  stRef.current = st;
  const [job, setJob] = useState<DiffJobView | null>(null);
  /** the hub session (kept after the job finishes, so folders can still be read); dismissed on exit or restart */
  const [jobId, setJobId] = useState("");
  const [err, setErr] = useState("");
  const [folders, setFolders] = useState<ReadonlyMap<string, FolderData>>(new Map());
  const [rate, setRate] = useState(0);
  const [selected, setSelectedState] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [exec, setExec] = useState<Exec | null>(null);
  const [presets, setPresets] = useState<Presets>(loadPresets);
  const scrollers = useRef<{ left: HTMLElement | null; right: HTMLElement | null }>({ left: null, right: null });
  const hide = useMemo(() => new Set<DiffStatus>(st?.hide ?? []), [st?.hide]);
  const rel = st?.rel ?? "";
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const flat = useMemo(() => (jobId ? flattenFolders(folders, rel, hide, expanded) : []), [jobId, folders, rel, hide, expanded]);
  const rows = useMemo(() => flat.map((f) => f.n), [flat]);
  const depths = useMemo(() => new Map(flat.map((f) => [f.n.row.p, f.depth])), [flat]);
  const toggleOpen = (p: string) =>
    setExpanded((x) => {
      const next = new Set(x);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  const running = job !== null && (job.state === "queued" || job.state === "running");
  const setSelected = (s: Set<string>) => setSelectedState(s);
  /** right spelling of a shared relative folder (only differs when names match ignoring case) */
  const rightRelOf = useCallback(
    (r: string) => {
      if (!r) return r;
      const row = folders.get(parentOf(r))?.rows.find((x) => x.p === r);
      return row?.rp ?? r;
    },
    [folders],
  );

  const start = useCallback(async (opts?: UiOpts) => {
    const s = stRef.current;
    if (!s) return;
    setErr("");
    setSelectedState(new Set());
    setFolders(new Map());
    setRate(0);
    setJobId((old) => {
      if (old) api.cancelDiff(old).catch(() => undefined).finally(() => api.dismissDiff(old).catch(() => undefined));
      return "";
    });
    try {
      const j = await api.startDiff(s.left, s.right, toApi(opts ?? s.opts));
      setJob(j);
      setJobId(j.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Enter or restore compare mode: run the comparison once.
  const ran = useRef(false);
  useEffect(() => {
    if (!st) {
      ran.current = false;
      setJob(null);
      setFolders(new Map());
      setErr("");
      setExec(null);
      setSelectedState(new Set());
      setJobId((old) => {
        if (old) api.cancelDiff(old).catch(() => undefined).finally(() => api.dismissDiff(old).catch(() => undefined));
        return "";
      });
      return;
    }
    if (!ran.current) {
      ran.current = true;
      void start();
    }
  }, [!st]); // eslint-disable-line react-hooks/exhaustive-deps

  // Folders on screen: the current one and every expanded one below it. The hub lists and hashes these first.
  const visible = useMemo(() => [rel, ...[...expanded].filter((p) => !rel || p.startsWith(rel + "/"))], [rel, expanded]);
  const visibleKey = visible.join("\u0000");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const fetchFolders = useCallback(async (id: string, rels: string[]) => {
    const got = await Promise.all(rels.map((r) => api.diffRows(id, r).catch(() => null)));
    setFolders((old) => {
      const next = new Map(old);
      got.forEach((f, i) => {
        if (f) next.set(rels[i] as string, { listed: f.listed, rows: f.rows });
      });
      return next;
    });
  }, []);
  useEffect(() => {
    if (!jobId) return;
    api.diffFocus(jobId, visible).catch(() => undefined);
    const missing = visible.filter((r) => !folders.has(r));
    if (missing.length) void fetchFolders(jobId, missing);
  }, [jobId, visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the session: totals and progress every tick; visible folders again whenever any row changed.
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rev = -1;
    let last: { t: number; dirs: number } | null = null;
    let delay = 500;
    const tick = async () => {
      try {
        const j = await api.diffJob(jobId);
        if (!live) return;
        setJob(j);
        const stt = j.stats;
        if (stt) {
          const now = Date.now();
          if (last && now > last.t) {
            const inst = ((stt.dirsScanned - last.dirs) * 1000) / (now - last.t);
            setRate((r) => (r ? r * 0.6 + inst * 0.4 : inst));
          }
          last = { t: now, dirs: stt.dirsScanned };
          if (stt.rev !== rev) {
            rev = stt.rev;
            await fetchFolders(jobId, visibleRef.current);
          }
        }
        if (j.state === "failed" || j.state === "canceled") {
          setErr(j.state === "failed" ? (j.error ?? "Comparison failed") : "Comparison canceled");
          return;
        }
        // A finished compare stays live: the hub follows both sides' change feeds, so keep reading (more slowly).
        delay = j.state === "done" ? 1500 : 500;
      } catch (e) {
        if (live) setErr((e as Error).message);
        return;
      }
      if (live) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, fetchFolders]);

  /** A row plus every loaded row below it (folders not loaded yet are taken whole by the sync planner). */
  const withLoaded = useCallback(
    (n: CNode, out: string[] = []): string[] => {
      if (n.skel) return out;
      out.push(n.row.p);
      if (n.isDir) for (const r of folders.get(n.row.p)?.rows ?? []) withLoaded({ row: r, name: nameOfRel(r.p), isDir: (r.l?.t ?? r.r?.t) === "dir", children: [] }, out);
      return out;
    },
    [folders],
  );

  /* ---------- navigation: both panels always show the same relative folder ---------- */
  const lp = st ? leafOf(st.lp) : undefined;
  const rp = st ? leafOf(st.rp) : undefined;
  const exit = useCallback(() => {
    const j = jobId;
    if (j) api.cancelDiff(j).catch(() => undefined);
    setState(() => null);
  }, [jobId, setState]);
  const go = useCallback(
    (to: string) => {
      const s = stRef.current;
      if (!s) return;
      setState((x) => (x ? { ...x, rel: to } : x));
      const l = leafOf(s.lp);
      const r = leafOf(s.rp);
      if (l) patchLeaf(s.lp, { node: s.left.node, path: joinRoot(s.left.path, to), sel: undefined, sels: undefined, closed: undefined, sr: undefined, q: undefined });
      if (r) patchLeaf(s.rp, { node: s.right.node, path: joinRoot(s.right.path, rightRelOf(to)), sel: undefined, sels: undefined, closed: undefined, sr: undefined, q: undefined });
      setCursor(null);
      setSelectedState(new Set());
      setExpanded(new Set());
      scrollers.current.left?.scrollTo?.({ top: 0 });
      scrollers.current.right?.scrollTo?.({ top: 0 });
    },
    [rightRelOf, leafOf, patchLeaf, setState],
  );
  // A panel that navigated by itself (breadcrumb, Up, back button) drags the other one along; leaving the
  // compared roots ends the compare.
  useEffect(() => {
    if (!st || !lp || !rp) return;
    const wantL = joinRoot(st.left.path, st.rel);
    const wantR = joinRoot(st.right.path, rightRelOf(st.rel));
    const okL = lp.node === st.left.node && lp.path === wantL;
    const okR = rp.node === st.right.node && rp.path === wantR;
    if (okL && okR) return;
    const fromLeft = !okL && (okR || activeId === st.lp);
    const side = fromLeft ? { leaf: lp, root: st.left } : { leaf: rp, root: st.right };
    const r = side.leaf.node === side.root.node ? relUnder(side.root.path, side.leaf.path) : null;
    if (r === null) {
      onStatus("A compared panel left its folder: compare closed");
      setState(() => null);
      return;
    }
    go(fromLeft ? r : sharedOf(r));
  }, [st?.rel, st?.left, st?.right, lp?.node, lp?.path, rp?.node, rp?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // A closed panel ends the compare.
  useEffect(() => {
    if (st && (!lp || !rp)) setState(() => null);
  }, [st, lp, rp, setState]);

  /** shared relative folder for a right-panel relative folder (differs only for ignore-case matches) */
  function sharedOf(rightSpelling: string): string {
    for (const f of folders.values()) for (const x of f.rows) if (x.rp === rightSpelling) return x.p;
    return rightSpelling;
  }
  const up = () => {
    if (!rel) return;
    go(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
  };
  const open = (n: CNode) => {
    const s = stRef.current;
    if (!s) return;
    const r = n.row;
    if (n.skel) return;
    if (n.isDir) return go(r.p);
    if (!r.l || !r.r) return onStatus(`${r.p} exists only on the ${r.l ? "left" : "right"} side`);
    if (r.l.t !== "file" || r.r.t !== "file") return onStatus("Only regular files can be diffed");
    if (r.status === "identical") return onStatus(`${r.p} is identical on both sides`);
    onFileDiff({ node: s.left.node, path: joinRel(s.left.path, r.p) }, { node: s.right.node, path: joinRel(s.right.path, r.rp ?? r.p) });
  };

  const click: CompareCtl["click"] = (e, n) => {
    if (n.skel) return;
    setCursor(n.row.p);
    if (e.shiftKey && cursor) {
      const a = rows.findIndex((x) => x.row.p === cursor);
      const b = rows.findIndex((x) => x.row.p === n.row.p);
      if (a >= 0 && b >= 0) {
        const next = new Set<string>();
        for (const x of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) withLoaded(x).forEach((p) => next.add(p));
        return setSelectedState(next);
      }
    }
    const all = withLoaded(n);
    if (e.ctrlKey || e.metaKey) {
      setSelectedState((s) => {
        const next = new Set(s);
        const on = !s.has(n.row.p);
        for (const p of all) on ? next.add(p) : next.delete(p);
        return next;
      });
    } else setSelectedState(new Set(all));
  };

  const syncScroll = (from: Side, top: number) => {
    const o = scrollers.current[from === "left" ? "right" : "left"];
    if (o && o.scrollTop !== top) o.scrollTop = top;
  };

  /* ---------- options ---------- */
  const setOpts = (o: UiOpts) => setState((x) => (x ? { ...x, opts: o } : x));
  const setPreset = (p: string) => {
    setState((x) => (x ? { ...x, preset: p, opts: p && presets[p] ? { ...DEFAULT_UI, ...presets[p] } : x.opts } : x));
  };
  const toggleStatus = (s: DiffStatus) => setState((x) => (x ? { ...x, hide: x.hide.includes(s) ? x.hide.filter((h) => h !== s) : [...x.hide, s] } : x));
  const savePreset = (name: string) => {
    if (!st) return;
    const next = { ...presets, [name]: st.opts };
    setPresets(next);
    savePresets(next);
    setState((x) => (x ? { ...x, preset: name } : x));
  };
  const deletePreset = () => {
    if (!st?.preset) return;
    const next = { ...presets };
    delete next[st.preset];
    setPresets(next);
    savePresets(next);
    setState((x) => (x ? { ...x, preset: "" } : x));
  };

  /* ---------- sync ---------- */
  const warnings = job?.stats?.warnings ?? [];
  const filtersActive = !!(st && (st.opts.include.trim() || st.opts.exclude.trim() || st.opts.ignoreHidden)) || warnings.length > 0;
  /** The plan needs every row under the selection, including folders never opened: the hub streams them. */
  const preview = async (action: SyncAction) => {
    if (!jobId || !selected.size) return;
    const sel = [...selected];
    const tops = sel.filter((p) => !sel.some((q) => q !== p && p.startsWith(q + "/")));
    let all: DiffRow[];
    try {
      all = await api.diffSubtree(jobId, tops);
    } catch (e) {
      return onStatus((e as Error).message);
    }
    const final = all.filter((r) => r.status !== "pending") as (DiffRow & { status: DiffStatus })[];
    if (final.length < all.length) onStatus(`${all.length - final.length} selected rows are still being compared and were left out`);
    const picked = new Set(selected);
    for (const r of final) if (tops.some((t) => r.p === t || r.p.startsWith(t + "/"))) picked.add(r.p);
    const plan = planSync(final, picked, action, { wholeDirs: !filtersActive });
    setExec({ action, plan, state: "plan", done: 0, errors: [], canceled: false });
  };
  const selectDiffering = async () => {
    if (!jobId) return;
    const want = DIFF_STATUSES.filter((x) => x !== "identical" && !hide.has(x));
    try {
      setSelectedState(new Set(await api.diffPaths(jobId, want)));
    } catch (e) {
      onStatus((e as Error).message);
    }
  };
  /** The plan becomes one hub job: it keeps running when the compare or the browser is closed. */
  const runExec = async () => {
    if (!exec || !st) return;
    const loc = (side: Side) => (side === "left" ? st.left : st.right);
    const steps: SyncStepSpec[] = [];
    for (const s of exec.plan.steps) {
      if (s.op === "skip") continue;
      if (s.op === "mkdir") steps.push({ kind: "mkdir", node: loc(s.side).node, path: joinRel(loc(s.side).path, s.rel) });
      else if (s.op === "trash") steps.push({ kind: "trash", node: loc(s.side).node, path: joinRel(loc(s.side).path, s.rel) });
      else {
        const from = loc(s.from);
        const to = loc(s.from === "left" ? "right" : "left");
        steps.push({ kind: "copy", src: { node: from.node, path: joinRel(from.path, s.srcRel) }, dst: { node: to.node, dir: s.destDirRel ? joinRel(to.path, s.destDirRel) : to.path }, bytes: s.bytes });
      }
    }
    try {
      const j = await api.startOp({ op: "sync", steps, title: `${ACTION_LABEL[exec.action]}: ${st.left.node}:${st.left.path} / ${st.right.node}:${st.right.path}` });
      setExec({ ...exec, state: "running", jobId: j.id, job: j });
    } catch (e) {
      setExec({ ...exec, state: "done", errors: [(e as Error).message], done: 0 });
    }
  };
  const execJobId = exec?.state === "running" ? exec.jobId : undefined;
  useEffect(() => {
    if (!execJobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.opJob(execJobId);
        if (stop) return;
        if (opLive(j)) setExec((x) => (x && x.jobId === execJobId ? { ...x, job: j } : x));
        else {
          const errors = (j.items ?? []).filter((i) => i.error).slice(0, 50).map((i) => `${i.label}: ${i.error}`);
          setExec((x) => (x && x.jobId === execJobId ? { ...x, job: j, state: "done", done: j.counts.done, errors, canceled: j.state === "canceled" } : x));
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
  const closeExec = () => {
    const ran = exec?.state === "done";
    setExec(null);
    if (ran) void start();
  };

  if (!st) return null;
  const summary: CompareSummary | null = job?.stats ? { files: job.files ?? EMPTY, dirs: job.dirs ?? EMPTY, stats: job.stats, done: job.state === "done", rate } : null;
  return {
    st,
    sideOf: (id) => (id === st.lp ? "left" : id === st.rp ? "right" : null),
    summary,
    job,
    running,
    err,
    rows,
    depthOf: (p) => depths.get(p) ?? 0,
    expanded,
    toggleOpen,
    hide,
    selected,
    cursor,
    setCursor,
    setSelected,
    click,
    open,
    go,
    up,
    exit,
    start: (o?: UiOpts) => void start(o),
    cancel: () => jobId && void api.cancelDiff(jobId).catch(() => undefined),
    selectDiffering: () => void selectDiffering(),
    descend: (n: CNode) => withLoaded(n),
    setOpts,
    setPreset,
    toggleStatus,
    preview: (a: SyncAction) => void preview(a),
    exec,
    runExec: () => void runExec(),
    stopExec: () => exec?.jobId && void api.opAction(exec.jobId, "cancel"),
    closeExec,
    presets,
    savePreset,
    deletePreset,
    scrollers,
    syncScroll,
    onStatus,
    filtersActive,
  };
}

/* ------------------------------------------------------------------ view: one panel's side */

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function Cell({ n, side, ctl }: { n: CNode; side: Side; ctl: CompareCtl }) {
  const r = n.row;
  if (n.skel)
    return (
      <>
        <span className="cmp-name" style={{ paddingLeft: ctl.depthOf(r.p) * 16 }}><span className="cmp-twisty" aria-hidden="true" /><span className="sk sk-ico" /><span className="sk sk-nm" style={{ width: `${[7, 11, 9, 13, 8][r.p.length % 5]}rem` }} /></span>
        <span className="num"><span className="sk sk-num" style={{ "--w": "3rem" } as React.CSSProperties} /></span>
        <span><span className="sk sk-num" style={{ "--w": "7rem" } as React.CSSProperties} /></span>
      </>
    );
  const d = side === "left" ? r.l : r.r;
  const spelling = side === "right" && r.rp ? nameOf(r.rp) : n.name;
  if (!d) return <span className="cmp-ph" aria-label={`Not on the ${side} side`} />;
  return (
    <>
      <Tip label={r.p} fill><span className="cmp-name" style={{ paddingLeft: ctl.depthOf(r.p) * 16 }}>
        {n.isDir ? (
          <button
            className="cmp-twisty"
            aria-label={(ctl.expanded.has(r.p) ? "Collapse " : "Expand ") + spelling}
            aria-expanded={ctl.expanded.has(r.p)}
            onClick={(e) => (e.stopPropagation(), ctl.toggleOpen(r.p))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {ctl.expanded.has(r.p) ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        ) : (
          <span className="cmp-twisty" aria-hidden="true" />
        )}
        <FileIcon className="ico" dir={n.isDir} type={d.t === "symlink" ? "symlink" : "file"} /> {spelling}
      </span></Tip>
      <span className="num">{n.isDir ? "" : fmtSize(d.s)}</span>
      <span className={"cmp-mt" + (r.newer === side ? " fd-newer" : "")}>
        {fmtDate(d.m)}
        {r.newer === side ? <span className="fd-newer-tag" title="Newer side"><ArrowUp /><span className="visually-hidden">newer</span></span> : null}
      </span>
    </>
  );
}

/** Body of a compared panel: the aligned rows of the current folder, this panel's side only. */
export function CompareBody({ ctl, side }: { ctl: CompareCtl; side: Side }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(600);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    ctl.scrollers.current[side] = el;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setH(el.clientHeight)) : null;
    ro?.observe(el);
    setH(el.clientHeight);
    return () => {
      ro?.disconnect();
      if (ctl.scrollers.current[side] === el) ctl.scrollers.current[side] = null;
    };
  }, [side]); // eslint-disable-line react-hooks/exhaustive-deps
  // The parent row (setting: "..", "Up" or hidden) sits above the aligned rows on both sides, so row 0 still lines up. Only inside a sub-folder of the compare.
  const { upRow } = useSettings();
  const showUp = upRow !== "hidden" && !!ctl.st.rel;
  const upH = showUp ? ROW_H : 0;
  const first = Math.max(0, Math.floor(Math.max(0, top - HEAD_H - upH) / ROW_H) - 6);
  const last = Math.min(ctl.rows.length, Math.ceil((top + h - upH) / ROW_H) + 6);
  const sel = ctl.selected;
  const rowMenu = (e: React.MouseEvent, n: CNode) => {
    e.preventDefault();
    if (!sel.has(n.row.p)) ctl.click({ shiftKey: false, ctrlKey: false, metaKey: false }, n);
    const items: MenuItem[] = [
      { label: n.isDir ? "Open folder (both panels)" : "Diff the two files", onSelect: () => ctl.open(n) },
      "sep",
      { label: "Copy selected left to right", onSelect: () => ctl.preview("copy-lr") },
      { label: "Copy selected right to left", onSelect: () => ctl.preview("copy-rl") },
      { label: "Delete selected from left", danger: true, onSelect: () => ctl.preview("delete-left") },
      { label: "Delete selected from right", danger: true, onSelect: () => ctl.preview("delete-right") },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  return (
    <div className={"cmp cmp-" + side} aria-label={`Compare, ${side} side`}>
      <div
        className="cmp-scroll"
        ref={ref}
        role="grid"
        aria-label={`Aligned rows, ${side} side`}
        onScroll={(e) => {
          setTop(e.currentTarget.scrollTop);
          ctl.syncScroll(side, e.currentTarget.scrollTop);
        }}
        onClick={(e) => e.target === e.currentTarget && ctl.setSelected(new Set())}
      >
       <div className="cmp-inner">
        <div className="cmp-head" aria-hidden>
          <span>{side === "left" ? "Left" : "Right"}: name</span>
          <span className="num">Size</span>
          <span>Modified</span>
          <span />
        </div>
        {showUp && (
          <div className="cmp-row up" role="row" style={{ position: "relative", height: ROW_H }} onClick={ctl.up}>
            <span className="cmp-name"><span className="fl"><Ic.CornerLeftUp className="ico" /><button type="button" className="up-btn" aria-label="Up one folder">{upRow === "up" ? "Up" : ".."}</button></span></span>
            <span /><span /><span />
          </div>
        )}
        {ctl.running && !ctl.rows.length && Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="cmp-row skel" role="presentation" aria-hidden="true" style={{ position: "relative", height: ROW_H }}>
            <span><span className="sk sk-ico" /><span className="sk sk-nm" style={{ width: `${[7, 11, 9, 13, 8][i % 5]}rem` }} /></span>
            <span><span className="sk sk-num" style={{ "--w": "3rem" } as React.CSSProperties} /></span>
            <span><span className="sk sk-num" style={{ "--w": "7rem" } as React.CSSProperties} /></span>
            <span />
          </div>
        ))}
        <div style={{ height: ctl.rows.length * ROW_H, position: "relative" }}>
          {ctl.rows.slice(first, last).map((n, k) => {
            const r = n.row;
            return (
              <div
                key={r.p}
                role="row"
                aria-selected={sel.has(r.p)}
                data-rel={r.p}
                data-status={r.status}
                aria-busy={r.status === "pending" || undefined}
                className={"cmp-row st-" + r.status + (n.skel ? " skel" : "") + (sel.has(r.p) ? " sel" : "") + (ctl.cursor === r.p ? " cur" : "") + (!n.skel && !(side === "left" ? r.l : r.r) ? " ph" : "")}
                style={{ top: (first + k) * ROW_H, height: ROW_H }}
                onClick={(e) => ctl.click(e, n)}
                onDoubleClick={() => ctl.open(n)}
                onContextMenu={(e) => rowMenu(e, n)}
              >
                <Cell n={n} side={side} ctl={ctl} />
                {r.status === "pending" ? (
                  <span className="cmp-status" title={n.skel ? "Listing this folder" : n.isDir ? "Comparing what is inside" : "Comparing"}>
                    <LoaderCircle className="cmp-spin" aria-hidden="true" />
                    <span className="visually-hidden">{n.skel ? "Loading" : "Comparing"}</span>
                  </span>
                ) : (
                  <span className="cmp-status" title={r.why ?? STATUS[r.status].label}>
                    {(() => { const I = STATUS[r.status].Icon; return <I aria-hidden="true" />; })()}
                    <span className="visually-hidden">{STATUS[r.status].label}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {!ctl.rows.length && !ctl.running && ctl.summary && <div className="cmp-empty muted">Nothing to show here with the current filters.</div>}
       </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Keyboard handling for compared panels; returns true when the key was used. */
export function compareKey(ctl: CompareCtl, side: Side, e: React.KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const rows = ctl.rows;
  const i = ctl.cursor ? rows.findIndex((x) => x.row.p === ctl.cursor) : -1;
  const move = (to: number) => {
    const n = rows[Math.max(0, Math.min(rows.length - 1, to))];
    if (!n) return;
    ctl.setCursor(n.row.p);
    if (e.shiftKey) ctl.click({ shiftKey: true, ctrlKey: false, metaKey: false }, n);
    else ctl.setSelected(new Set(ctl.descend(n)));
    document.querySelectorAll<HTMLElement>(`.cmp-scroll`).forEach((sc) => {
      const off = sc.querySelector(".cmp-row.up") ? ROW_H : 0;
      const y = HEAD_H + off + rows.indexOf(n) * ROW_H;
      if (y - HEAD_H < sc.scrollTop) sc.scrollTop = y - HEAD_H;
      else if (y + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + ROW_H - sc.clientHeight;
    });
  };
  const k = e.key;
  if (k === "ArrowDown") return move(i + 1), true;
  if (k === "ArrowUp") return move(i < 0 ? 0 : i - 1), true;
  if (k === "Home") return move(0), true;
  if (k === "End") return move(rows.length - 1), true;
  if (k === "PageDown") return move(i + 10), true;
  if (k === "PageUp") return move(i - 10), true;
  if (k === "Enter" && !mod) {
    const n = rows[i];
    return !!n && (ctl.open(n), true);
  }
  if (k === " ") {
    const n = rows[i];
    return !!n && (ctl.click({ shiftKey: false, ctrlKey: true, metaKey: false }, n), true);
  }
  if (k === "ArrowRight" && !mod) {
    const n = rows[i];
    return !!n && n.isDir && (!ctl.expanded.has(n.row.p) && ctl.toggleOpen(n.row.p), true);
  }
  if (k === "ArrowLeft" && !mod) {
    const n = rows[i];
    return !!n && n.isDir && (ctl.expanded.has(n.row.p) && ctl.toggleOpen(n.row.p), true);
  }
  if (k === "Backspace" || (e.altKey && k === "ArrowUp")) return ctl.up(), true;
  if (mod && k.toLowerCase() === "a") return ctl.setSelected(new Set(rows.flatMap((n) => ctl.descend(n)))), true;
  if (k === "Escape") return ctl.selected.size > 0 ? (ctl.setSelected(new Set()), true) : (ctl.exit(), true);
  if (k === "F5") return ctl.selected.size > 0 && (ctl.preview(side === "left" ? "copy-lr" : "copy-rl"), true);
  if (k === "F6") return ctl.selected.size > 0 && (ctl.preview(side === "left" ? "copy-lr" : "copy-rl"), true);
  if (k === "Delete") return ctl.selected.size > 0 && (ctl.preview(side === "left" ? "delete-left" : "delete-right"), true);
  return false;
}

/* ------------------------------------------------------------------ view: toolbar in the panel header */

export function CompareBar({ ctl, side, otherLabel }: { ctl: CompareCtl; side: Side; otherLabel: string }) {
  const { st, summary } = ctl;
  const o = st.opts;
  const c = summary?.files;
  const mode = MODES.find((m) => m.id === o.mode);
  const n = (s: DiffStatus) => (!c ? 0 : s === "identical" ? c.identical : s === "different" ? c.different : s === "left-only" ? c.leftOnly : s === "right-only" ? c.rightOnly : c.error);
  const sel = ctl.selected.size;
  return (
    // Same fixed height on both sides (controls only, one scrollable row): row 0 of both lists lines up.
    <div className="cmp-barwrap">
    <div className="cmp-bar" onWheel={wheelX} role="toolbar" aria-label={`Compare toolbar, ${side} panel`}>
      <Tip label={`${st.left.node}:${st.left.path}  vs  ${st.right.node}:${st.right.path}`}><span className="cmp-badge">Compare</span></Tip>
      <Tip label={`${side === "left" ? "with" : "against"} ${otherLabel}${st.rel ? ` / ${st.rel}` : ""}`}><span className="muted cmp-with">{side === "left" ? "with" : "against"} {otherLabel}{st.rel ? ` / ${st.rel}` : ""}</span></Tip>
      <span className="fd-toggles" role="group" aria-label="Show">
        {DIFF_STATUSES.map((s) => {
          if (s === "error" && !n(s)) return null;
          return (
            <button key={s} className={"fd-tog st-" + s} aria-pressed={!ctl.hide.has(s)} onClick={() => ctl.toggleStatus(s)}>
              {(() => { const I = STATUS[s].Icon; return <I aria-hidden="true" />; })()} {STATUS[s].label} <span className="fd-n">{summary ? n(s).toLocaleString() : ""}</span>
            </button>
          );
        })}
      </span>
      {side === "left" && (
        <>
          <Tip label={`Compare by ${mode?.label ?? o.mode}: ${mode?.help ?? ""}. Change it under Compare in the sidebar.`}>
            <span className="cmp-mode-label"><Ic.Scale aria-hidden="true" /> By {mode?.short ?? o.mode}</span>
          </Tip>
          <button className="primary" onClick={() => (ctl.running ? ctl.cancel() : ctl.start())}>{ctl.running ? <Ic.X /> : <Ic.RefreshCw />} {ctl.running ? "Cancel" : "Compare again"}</button>
          <span className="fd-sep" />
          <span className="fd-sync" role="group" aria-label="Sync selected rows">
            <Tip label="Copy selected left items over to the right side"><button disabled={!sel} onClick={() => ctl.preview("copy-lr")}>Copy <ArrowRight /></button></Tip>
            <Tip label="Copy selected right items over to the left side"><button disabled={!sel} onClick={() => ctl.preview("copy-rl")}><ArrowLeft /> Copy</button></Tip>
            <Tip label="Move selected left items to the trash"><button disabled={!sel} onClick={() => ctl.preview("delete-left")}><Ic.Trash2 /> Delete left</button></Tip>
            <Tip label="Move selected right items to the trash"><button disabled={!sel} onClick={() => ctl.preview("delete-right")}><Ic.Trash2 /> Delete right</button></Tip>
          </span>
          <Tip label="Select every differing row in the whole tree"><button disabled={!summary} onClick={ctl.selectDiffering}><Ic.ListChecks /> Select differing</button></Tip>
          <button disabled={!sel} onClick={() => ctl.setSelected(new Set())}><Ic.Eraser /> Clear</button>
        </>
      )}
      <span className="muted fd-count">{sel} selected</span>
      <Tip label="Leave compare mode (Esc)"><button className="cmp-exit" onClick={ctl.exit}><Ic.LogOut /> Exit compare</button></Tip>
    </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar: what the compare found */

/** Warnings from the compare (depth limit, unreadable folders) as a short label plus the full text for the tooltip. */
function warnRow(w: string): { short: string; full: string } {
  const deep = /deeper than (\d+) levels/.exec(w);
  return { short: deep ? `deeper than ${deep[1]} levels skipped` : w, full: w + (w.endsWith(".") ? "" : ".") + (deep ? " Raise \"Max depth\" in the compare Options." : "") };
}

/** "Compare by": always visible in the sidebar, one click re-runs the compare in the new mode. */
function ModeControl({ ctl }: { ctl: CompareCtl }) {
  const o = ctl.st.opts;
  return (
    <>
    <p className="side-cmp-cap muted" id="cmp-by">Compare by</p>
    <div className="cmp-seg" role="radiogroup" aria-labelledby="cmp-by">
      {MODES.map((m) => (
        <Tip key={m.id} label={`${m.label}: ${m.help}`}>
          <button
            type="button"
            role="radio"
            aria-checked={o.mode === m.id}
            onClick={() => {
              if (o.mode === m.id) return;
              const next = { ...o, mode: m.id };
              ctl.setOpts(next);
              ctl.start(next);
            }}
          >
            {m.short}
          </button>
        </Tip>
      ))}
    </div>
    </>
  );
}

/** Compare options live inline in the sidebar's Compare section (no popover over the panels). */
function CompareOptions({ ctl }: { ctl: CompareCtl }) {
  const { st } = ctl;
  const o = st.opts;
  const [presetName, setPresetName] = useState("");
  return (
        <div className="fd-opts side-opts" role="group" aria-label="Compare options">
          <label>
            Time tolerance (s)
            <input type="number" min={0} step={1} value={o.toleranceSec} onChange={(e) => ctl.setOpts({ ...o, toleranceSec: Number(e.target.value) })} />
          </label>
          <label>
            Include (globs)
            <input type="text" value={o.include} placeholder="*.ts, src/**" onChange={(e) => ctl.setOpts({ ...o, include: e.target.value })} />
          </label>
          <label>
            Exclude (globs)
            <input type="text" value={o.exclude} placeholder="node_modules/, *.log, .git/" onChange={(e) => ctl.setOpts({ ...o, exclude: e.target.value })} />
          </label>
          <label>
            Max depth
            <input type="number" min={1} max={256} value={o.depth} onChange={(e) => ctl.setOpts({ ...o, depth: Number(e.target.value) })} />
          </label>
          <label className="chk"><input type="checkbox" checked={o.ignoreCase} onChange={(e) => ctl.setOpts({ ...o, ignoreCase: e.target.checked })} /> Ignore case in names</label>
          <label className="chk"><input type="checkbox" checked={o.ignoreHidden} onChange={(e) => ctl.setOpts({ ...o, ignoreHidden: e.target.checked })} /> Ignore hidden files</label>
          <div className="fd-presets">
            <label>
              Preset
              <select value={st.preset} onChange={(e) => ctl.setPreset(e.target.value)}>
                <option value="">(none)</option>
                {Object.keys(ctl.presets).sort().map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Save current options as
              <input type="text" value={presetName} placeholder="name" onChange={(e) => setPresetName(e.target.value)} />
            </label>
            <button disabled={!presetName.trim()} onClick={() => (ctl.savePreset(presetName.trim()), setPresetName(""))}><Ic.Save /> Save preset</button>
            <button disabled={!st.preset} onClick={ctl.deletePreset}><Ic.Trash2 /> Delete preset</button>
            <button className="primary" onClick={() => ctl.start()}><Ic.GitCompareArrows /> Apply and compare</button>
          </div>
        </div>
  );
}

/** Compare status in the sidebar, so the panel headers keep only controls: progress, errors, totals, per-side warnings. */
export function CompareInfo() {
  const ctl = useCompareCtl();
  const [optsOpen, setOptsOpen] = useState(false);
  if (!ctl) return null;
  const { st, summary, job, running, err } = ctl;
  const sum = (c: DiffCounts) => c.identical + c.different + c.leftOnly + c.rightOnly + c.error;
  const s = summary?.stats;
  // duration of the compare itself (the job), not of later live updates
  const secs = job?.startedAt ? ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 : 0;
  const lookups = s ? s.cacheHits + s.cacheMisses : 0;
  return (
    <section className="side-cmp" aria-label="Compare status">
      <h2>Compare</h2>
      <Tip label={`${st.left.node}:${st.left.path}  vs  ${st.right.node}:${st.right.path}`}>
        <p className="side-cmp-roots muted">{st.left.node}:{st.left.path} vs {st.right.node}:{st.right.path}</p>
      </Tip>
      <ModeControl ctl={ctl} />
      {err && <p className="side-cmp-err" role="alert">{err}</p>}
      {/* Fixed two-line block while running and after, so the sidebar does not jump as numbers change. */}
      <div className="side-cmp-run" role="status" aria-live="polite">
        {running && job?.state === "queued" && <><b>Queued</b><progress aria-label="Comparison progress" /></>}
        {s && (
          <>
            <span className="side-cmp-line">
              <b>{running ? "Comparing" : s.finishedAt ? "Done" : "Updating"}</b> {s.dirsScanned.toLocaleString()} folders{running && summary ? ` · ${Math.round(summary.rate).toLocaleString()}/s` : ` in ${secs.toFixed(1)} s`}
              {running && s.dirsQueued > 0 ? ` · ${s.dirsQueued.toLocaleString()} queued` : ""}
            </span>
            {running ? <progress aria-label="Comparison progress" /> : null}
            <span className="muted">
              {summary ? `${sum(summary.files).toLocaleString()} files, ${sum(summary.dirs).toLocaleString()} folders` : `${s.entries.toLocaleString()} entries`}
              {s.hashed + s.hashQueued > 0 ? ` · ${s.hashed.toLocaleString()}${running && s.hashQueued > 0 ? ` / ${(s.hashed + s.hashQueued).toLocaleString()}` : ""} hashed (${fmtSize(s.hashedBytes)})` : ""}
            </span>
            {lookups > 0 && <span className="muted">Index: {Math.round((100 * s.cacheHits) / lookups)}% of folder listings from cache</span>}
            {!running && s.live && (
              <Tip label="Changes on either side (seen by the nodes' file watchers) update the affected rows without comparing again">
                <span className="muted side-cmp-live"><Ic.Radio aria-hidden="true" /> Live: following changes</span>
              </Tip>
            )}
          </>
        )}
      </div>
      {(s?.warnings ?? []).map((w) => {
        const x = warnRow(w);
        return (
          <Tip key={w} label={x.full}>
            <p className="side-cmp-warn" role="alert"><TriangleAlert aria-hidden="true" /> <span>{x.short}</span></p>
          </Tip>
        );
      })}
      <button type="button" className="side-opts-toggle" aria-expanded={optsOpen} onClick={() => setOptsOpen((v) => !v)}>
        {optsOpen ? <ChevronDown /> : <ChevronRight />} <Ic.SlidersHorizontal /> Options
      </button>
      {optsOpen && <CompareOptions ctl={ctl} />}
    </section>
  );
}

/* ------------------------------------------------------------------ sync dialog */

export function SyncDialog({ ctl }: { ctl: CompareCtl }) {
  const exec = ctl.exec;
  if (!exec) return null;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={ACTION_LABEL[exec.action]}>
      <div className="modal wide">
        <h2>{ACTION_LABEL[exec.action]}</h2>
        {exec.state === "plan" && (
          <>
            <p className="muted">
              Dry run: nothing has changed yet. {exec.plan.copies} file(s) to copy ({fmtSize(exec.plan.bytes)}), {exec.plan.mkdirs} folder(s) to create, {exec.plan.trashes} item(s) to move to the trash
              {exec.plan.skipped ? `, ${exec.plan.skipped} skipped` : ""}. Replaced and deleted items go to each node's trash and can be restored.
            </p>
            {exec.plan.notes.map((x) => <p key={x} className="muted">{x}</p>)}
            <PlanList steps={exec.plan.steps} />
            <div className="modal-actions">
              <button onClick={ctl.closeExec}><Ic.X /> Cancel</button>
              <button className="primary" onClick={ctl.runExec} disabled={exec.plan.steps.every((s) => s.op === "skip")}><Ic.Play /> Run</button>
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
              <button onClick={ctl.stopExec}><Ic.Square /> Stop</button>
              <button onClick={ctl.closeExec}><Ic.X /> Close, keep running</button>
            </div>
          </>
        )}
        {exec.state === "done" && (
          <>
            <p role="status">{exec.canceled ? "Stopped" : "Finished"}: {exec.done} step(s) run, {exec.errors.length} failed.</p>
            {exec.errors.length > 0 && <ul className="fd-errs">{exec.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            <div className="modal-actions"><button className="primary" onClick={ctl.closeExec}><Ic.RefreshCw /> Close and compare again</button></div>
          </>
        )}
      </div>
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
