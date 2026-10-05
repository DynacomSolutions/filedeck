import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import * as Ic from "lucide-react";
import { api, fmtSize, type GitBlob, type GitDiff, type GitFile, type GitRefs } from "./api";
import { OPTS, useTheme } from "./EditorViews";
import { modelUri } from "./monacoSetup";
import { Tip } from "./Tooltip";
import type { PrState } from "./urlState";

const STATUS: Record<GitFile["status"], { label: string; cls: string }> = {
  A: { label: "Added", cls: "pr-a" },
  M: { label: "Modified", cls: "pr-m" },
  D: { label: "Deleted", cls: "pr-d" },
  R: { label: "Renamed", cls: "pr-r" },
};
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

type Side = { state: "loading" } | { state: "none" } | { state: "err"; msg: string } | { state: "ok"; blob: GitBlob };

/** Pull request diff: the changed files of a PR (or of two refs) in a repository folder, each opened in the Monaco diff, read-only. */
export function PrDiffView({ state, onState, onClose, onStatus }: { state: PrState; onState: (s: PrState) => void; onClose: () => void; onStatus: (m: string) => void }) {
  const { node, path } = state;
  const [mode, setMode] = useState<"pr" | "refs">(state.pr || !(state.base && state.head) ? "pr" : "refs");
  const [prText, setPrText] = useState(state.pr ? String(state.pr) : "");
  const [baseText, setBaseText] = useState(state.base ?? "");
  const [headText, setHeadText] = useState(state.head ?? "");
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [data, setData] = useState<GitDiff | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => root.current?.focus(), []);
  useEffect(() => {
    let live = true;
    setRefs(null);
    api.gitRefs(node, path).then((r) => live && setRefs(r), (e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [node, path]);

  const key = `${node}|${path}|${state.pr ?? ""}|${state.base ?? ""}|${state.head ?? ""}`;
  useEffect(() => {
    if (!state.pr && !(state.base && state.head)) {
      setData(null);
      return;
    }
    let live = true;
    setBusy(true);
    setErr("");
    api.gitDiff(node, path, state.pr ? { pr: state.pr } : { base: state.base!, head: state.head! }).then(
      (d) => {
        if (!live) return;
        setData(d);
        setBusy(false);
        onStatus(`${d.files.length} changed file(s)`);
      },
      (e: Error) => {
        if (!live) return;
        setData(null);
        setErr(e.message);
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "pr") {
      const n = Number(prText.trim().replace(/^#/, ""));
      if (!Number.isInteger(n) || n < 1) return setErr("Enter a pull request number, for example 123");
      onState({ node, path, pr: n, ...(state.inline ? { inline: true } : {}) });
    } else {
      if (!baseText.trim() || !headText.trim()) return setErr("Enter both a base and a head ref");
      onState({ node, path, base: baseText.trim(), head: headText.trim(), ...(state.inline ? { inline: true } : {}) });
    }
  };

  const files = useMemo(() => (data?.files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()) || f.oldPath?.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  const current = data?.files.find((f) => f.path === state.file) ?? null;
  const totals = useMemo(() => (data?.files ?? []).reduce((t, f) => ({ add: t.add + (f.add ?? 0), del: t.del + (f.del ?? 0) }), { add: 0, del: 0 }), [data]);
  const pick = (f: GitFile) => onState({ ...state, file: f.path });
  const step = (d: number) => {
    if (!files.length) return;
    const i = files.findIndex((f) => f.path === state.file);
    onState({ ...state, file: files[Math.min(files.length - 1, Math.max(0, i < 0 ? 0 : i + d))]!.path });
  };

  return (
    <div
      ref={root}
      className="ed over prd"
      role="dialog"
      aria-label="Pull request diff"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input,select,textarea,.monaco-editor")) return;
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown" || e.key === "j") step(1);
        else if (e.key === "ArrowUp" || e.key === "k") step(-1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="ed-head" role="group" aria-label="Toolbar">
        <b>Pull request diff</b>
        <Tip label={`${node}:${path}`}><span className="muted ed-pair">{node}:{path}</span></Tip>
        <span className="ed-spacer" />
        <Tip label="Close" shortcut="Esc"><button type="button" onClick={onClose}><Ic.X /> Close</button></Tip>
      </div>
      <form className="tr-bar prd-bar" onSubmit={submit} aria-label="What to compare">
        <div className="tr-tabs prd-mode" role="tablist" aria-label="Compare by">
          <button type="button" role="tab" aria-selected={mode === "pr"} className={mode === "pr" ? "on" : ""} onClick={() => setMode("pr")}><Ic.GitPullRequest /> Pull request</button>
          <button type="button" role="tab" aria-selected={mode === "refs"} className={mode === "refs" ? "on" : ""} onClick={() => setMode("refs")}><Ic.GitBranch /> Two refs</button>
        </div>
        {mode === "pr" ? (
          <>
            <input type="text" inputMode="numeric" list="prd-prs" aria-label="Pull request number" placeholder="PR number, e.g. 123" value={prText} onChange={(e) => setPrText(e.target.value)} />
            <datalist id="prd-prs">{refs?.prs.map((p) => <option key={p.n} value={String(p.n)}>{p.subject}</option>)}</datalist>
          </>
        ) : (
          <>
            <input type="text" list="prd-refs" aria-label="Base ref" placeholder="Base, e.g. main" value={baseText} onChange={(e) => setBaseText(e.target.value)} />
            <Ic.ArrowRight className="muted" aria-hidden />
            <input type="text" list="prd-refs" aria-label="Head ref" placeholder="Head, e.g. feature" value={headText} onChange={(e) => setHeadText(e.target.value)} />
            <datalist id="prd-refs">{refs?.refs.map((r) => <option key={r} value={r} />)}</datalist>
          </>
        )}
        <button type="submit" disabled={busy}><Ic.GitCompareArrows /> Show changes</button>
        {data && (
          <span className="muted tr-count">
            {data.files.length} file(s), <span className="pr-add">+{totals.add}</span> <span className="pr-del">-{totals.del}</span>
            {data.truncated ? " (list truncated)" : ""}
          </span>
        )}
      </form>
      {data && (
        <div className="prd-info muted">
          <Tip label={`base ${data.base.sha}`}><span>{data.pr ? `#${data.pr}: ` : ""}{data.head.ref} @ {data.head.sha.slice(0, 8)} against {data.base.ref} (merge-base {data.mergeBase.slice(0, 8)})</span></Tip>
          {data.note && <span> - {data.note}</span>}
        </div>
      )}
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      <div className="prd-body">
        <div className="prd-files" role="region" aria-label="Changed files">
          {data && data.files.length > 8 && <input type="search" aria-label="Filter changed files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {busy && <div className="pad muted">Loading...</div>}
          {!busy && !data && !err && <div className="pad muted">Enter a pull request number or two refs, then show the changes.{refs && refs.prs.length === 0 && refs.refs.length === 0 ? " This repository has no refs." : ""}</div>}
          {data && data.files.length === 0 && <div className="pad muted">{data.note ?? "No changes."}</div>}
          <ul>
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" className={"prd-file" + (f.path === state.file ? " on" : "")} aria-current={f.path === state.file ? "true" : undefined} onClick={() => pick(f)}>
                  <Tip label={STATUS[f.status].label}><span className={"prd-st " + STATUS[f.status].cls} role="img" aria-label={STATUS[f.status].label}>{f.status}</span></Tip>
                  <Tip label={f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path} fill>
                    <span className="prd-name"><span className="muted">{dir(f.path)}</span>{base(f.path)}</span>
                  </Tip>
                  {f.binary ? <span className="pill">binary</span> : <span className="prd-n"><span className="pr-add">+{f.add}</span> <span className="pr-del">-{f.del}</span></span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="prd-view">
          {data && current ? <FileDiff key={current.path} state={state} data={data} file={current} onInline={(inline) => onState({ ...state, ...(inline ? { inline: true } : { inline: undefined }) })} /> : data && data.files.length > 0 ? <div className="pad muted">Select a file to see its diff.</div> : null}
        </div>
      </div>
    </div>
  );
}

function FileDiff({ state, data, file, onInline }: { state: PrState; data: GitDiff; file: GitFile; onInline: (inline: boolean) => void }) {
  const { node, path } = state;
  const [a, setA] = useState<Side>({ state: "loading" });
  const [b, setB] = useState<Side>({ state: "loading" });
  const ed = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const theme = useTheme();
  const oldPath = file.oldPath ?? file.path;

  const load = useCallback(() => {
    let live = true;
    const get = (sha: string, p: string, set: (s: Side) => void) =>
      api.gitBlob(node, path, sha, p).then(
        (blob) => live && set({ state: "ok", blob }),
        (e: Error) => live && set({ state: "err", msg: e.message }),
      );
    setA({ state: "loading" });
    setB({ state: "loading" });
    if (file.status === "A") setA({ state: "none" });
    else void get(data.base.sha, oldPath, setA);
    if (file.status === "D") setB({ state: "none" });
    else void get(data.head.sha, file.path, setB);
    return () => {
      live = false;
    };
  }, [node, path, data.base.sha, data.head.sha, file.path, file.status, oldPath]);
  useEffect(load, [load]);

  // Same disposal order as the file diff: detach the models from the widget before they are disposed.
  useEffect(
    () => () => {
      const e = ed.current;
      ed.current = null;
      const models = e ? [e.getOriginalEditor().getModel(), e.getModifiedEditor().getModel()] : [];
      try {
        e?.setModel(null);
      } catch {
        /* widget already disposed */
      }
      setTimeout(() => models.forEach((m) => m?.dispose()), 0);
    },
    [],
  );

  const sides = [a, b];
  const failed = sides.find((s): s is { state: "err"; msg: string } => s.state === "err");
  const loading = sides.some((s) => s.state === "loading");
  const blobs = sides.map((s) => (s.state === "ok" ? s.blob : null));
  const isBinary = file.binary || blobs.some((x) => x?.binary);
  const tooLarge = blobs.find((x) => x?.tooLarge);
  const sizeOf = (s: Side) => (s.state === "ok" ? fmtSize(s.blob.size) : "none");

  return (
    <div className="prd-diff">
      <div className="ed-head prd-fhead" role="group" aria-label="File toolbar">
        <Tip label={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
          <b className="ed-pair">{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</b>
        </Tip>
        <span className="pill">{STATUS[file.status].label.toLowerCase()}</span>
        <span className="ed-spacer" />
        <Tip label="Toggle side-by-side / inline">
          <button type="button" onClick={() => onInline(!state.inline)} aria-pressed={!!state.inline}>
            {state.inline ? <Ic.Columns2 /> : <Ic.Rows2 />} {state.inline ? "Side by side" : "Inline"}
          </button>
        </Tip>
      </div>
      <div className="ed-body">
        {failed ? (
          <div className="pad muted" role="alert">{failed.msg}</div>
        ) : loading ? (
          <div className="pad muted">Loading...</div>
        ) : isBinary ? (
          <div className="pad muted">Binary file: {sizeOf(a)} before, {sizeOf(b)} after. No text diff.</div>
        ) : tooLarge ? (
          <div className="pad muted">This file is too large to diff here ({sizeOf(a)} before, {sizeOf(b)} after).</div>
        ) : file.status !== "A" && file.status !== "D" && a.state === "ok" && b.state === "ok" && a.blob.content === b.blob.content ? (
          <div className="pad muted">{file.status === "R" ? "Renamed without content changes." : "No text changes (mode or line endings only)."}</div>
        ) : (
          <DiffEditor
            originalModelPath={modelUri(node, `${path}/@${data.base.sha.slice(0, 12)}/${oldPath}`)}
            modifiedModelPath={modelUri(node, `${path}/@${data.head.sha.slice(0, 12)}/${file.path}`)}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            original={a.state === "ok" ? a.blob.content : ""}
            modified={b.state === "ok" ? b.blob.content : ""}
            theme={theme}
            options={{ ...OPTS, renderSideBySide: !state.inline, originalEditable: false, readOnly: true, useInlineViewWhenSpaceIsLimited: false }}
            onMount={(e) => {
              ed.current = e;
            }}
            loading={<div className="pad muted">Loading editor...</div>}
          />
        )}
      </div>
    </div>
  );
}
