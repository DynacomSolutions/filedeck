import { Tip } from "./Tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, Editor } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { ConflictError, api, fmtSize, type TextFile } from "./api";
import { gitApi } from "./git";
import { modelUri, monacoTheme } from "./monacoSetup";
import { ArrowLeftRight } from "lucide-react";
import * as Ic from "lucide-react";

export interface FileRef {
  node: string;
  path: string;
  /** a Git revision to show the file at instead of the file itself (only the left side of a diff; read-only) */
  rev?: string;
}
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function languageForPath(path: string): string | undefined {
  const name = base(path).toLowerCase();
  const languages = monaco.languages.getLanguages();
  const named = languages.find((language) => language.filenames?.some((filename) => filename.toLowerCase() === name));
  if (named) return named.id;
  return languages
    .filter((language) => language.extensions?.some((extension) => name.endsWith(extension.toLowerCase())))
    .sort((a, b) => Math.max(...(b.extensions ?? []).map((extension) => extension.length)) - Math.max(...(a.extensions ?? []).map((extension) => extension.length)))[0]?.id;
}

export const OPTS: MonacoEditor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  tabSize: 2,
};

function useCtrlS(save: () => void) {
  const ref = useRef(save);
  ref.current = save;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
}

function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
}

export const useTheme = () => {
  const [t, setT] = useState(monacoTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setT(monacoTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => setT(monacoTheme());
    mq.addEventListener("change", f);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", f);
    };
  }, []);
  return t;
};

function Conflict({ onOverwrite, onReload }: { onOverwrite: () => void; onReload: () => void }) {
  return (
    <div className="ed-banner" role="alert">
      <span>This file changed on disk since you opened it.</span>
      <button onClick={onOverwrite}><Ic.Replace /> Overwrite</button>
      <button onClick={onReload}><Ic.RotateCw /> Discard my edits and reload</button>
    </div>
  );
}

/** Single-file editor with dirty indicator, Ctrl+S and conflict handling. */
export function TextEditor({ file, onClose, onStatus, inline = false, extra }: { file: FileRef; onClose: () => void; onStatus: (m: string) => void; inline?: boolean; extra?: React.ReactNode }) {
  const { node, path } = file;
  const [loaded, setLoaded] = useState<TextFile | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const theme = useTheme();
  const dirty = loaded !== null && text !== loaded.content;
  useLeaveGuard(dirty);

  const load = useCallback(() => {
    setErr("");
    setConflict(null);
    api
      .readText(node, path)
      .then((f) => {
        setLoaded(f);
        setText(f.content);
      })
      .catch((e: Error) => setErr(e.message));
  }, [node, path]);
  useEffect(load, [load]);

  const save = useCallback(
    async (force = false) => {
      if (!loaded || saving || (!dirty && !force)) return;
      setSaving(true);
      try {
        const etag = force && conflict ? conflict : loaded.etag;
        const r = await api.writeText(node, path, text, etag);
        setLoaded({ ...loaded, content: text, etag: r.etag, size: r.size, mtime: r.mtime });
        setConflict(null);
        setErr("");
        onStatus(`Saved ${base(path)}`);
      } catch (e) {
        if (e instanceof ConflictError) setConflict(e.etag);
        else setErr((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [loaded, saving, dirty, conflict, node, path, text, onStatus],
  );
  useCtrlS(() => void save());

  const close = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <div className={"ed" + (inline ? " inline" : "")} role="dialog" aria-label={`Editing ${base(path)}`}>
      <div className="ed-head" role="group" aria-label="Editor toolbar">
        <b>
          {dirty && <Tip label="Unsaved changes"><span className="dirty-dot" role="img" aria-label="Unsaved changes" /></Tip>}
          <Tip label={`${node}:${path}`}><span>{base(path)}</span></Tip>
        </b>
        <span className="muted">{node}:{path}{loaded ? ` · ${fmtSize(loaded.size)}` : ""}</span>
        <span className="ed-spacer" />
        <Tip label="Save" shortcut="Ctrl+S"><button onClick={() => void save()} disabled={!dirty || saving}><Ic.Save /> {saving ? "Saving..." : "Save"}</button></Tip>
        <Tip label="Close"><button onClick={close}><Ic.X /> Close</button></Tip>
        {extra}
      </div>
      {conflict !== null && <Conflict onOverwrite={() => void save(true)} onReload={load} />}
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      <div className="ed-body">
        {loaded && (
          <Editor
            path={modelUri(node, path)}
            value={loaded.content}
            theme={theme}
            options={OPTS}
            onChange={(v) => setText(v ?? "")}
            onMount={(e) => e.focus()}
            loading={<div className="pad muted">Loading editor...</div>}
          />
        )}
        {!loaded && !err && <div className="pad muted">Loading...</div>}
      </div>
    </div>
  );
}

/** Two-file diff: left is read-only, right is editable and saveable. */
/** `overlay` places the diff over the panel area (inside <main>) instead of the whole page. */
export function DiffViewer({ left, right, onClose, onStatus, overlay, inline = false, extra }: { left: FileRef; right: FileRef; onClose: () => void; onStatus: (m: string) => void; overlay?: boolean; inline?: boolean; extra?: React.ReactNode }) {
  const [l, setL] = useState<TextFile | null>(null);
  const [r, setR] = useState<TextFile | null>(null);
  const [rText, setRText] = useState("");
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inline, setInline] = useState(false);
  const ed = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const theme = useTheme();
  const dirty = r !== null && rText !== r.content;
  useLeaveGuard(dirty);

  // The wrapper would dispose both models before the diff widget lets go of them, which
  // Monaco reports as "TextModel got disposed before DiffEditorWidget model got reset".
  // Keep the models alive across the wrapper's own cleanup, detach them from the widget
  // here, and dispose them only after the widget is gone.
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

  const load = useCallback(() => {
    setErr("");
    setConflict(null);
    Promise.all([left.rev ? gitApi.show(left.node, left.path, left.rev) : api.readText(left.node, left.path), api.readText(right.node, right.path)])
      .then(([a, b]) => {
        setL(a);
        setR(b);
        setRText(b.content);
      })
      .catch((e: Error) => setErr(e.message));
  }, [left.node, left.path, left.rev, right.node, right.path]);
  useEffect(load, [load]);

  const save = useCallback(
    async (force = false) => {
      if (!r || saving || (!dirty && !force)) return;
      const text = ed.current?.getModifiedEditor().getValue() ?? rText;
      setSaving(true);
      try {
        const etag = force && conflict ? conflict : r.etag;
        const res = await api.writeText(right.node, right.path, text, etag);
        setR({ ...r, content: text, etag: res.etag, size: res.size, mtime: res.mtime });
        setRText(text);
        setConflict(null);
        setErr("");
        onStatus(`Saved ${base(right.path)}`);
      } catch (e) {
        if (e instanceof ConflictError) setConflict(e.etag);
        else setErr((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [r, saving, dirty, conflict, right.node, right.path, rText, onStatus],
  );
  useCtrlS(() => void save());

  const close = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  };
  const same = l && r && l.content === r.content;

  return (
    <div className={"ed" + (overlay ? " over" : "") + (inline ? " inline" : "")} role="region" aria-label="File diff">
      <div className="ed-head" role="group" aria-label="Diff toolbar">
        <b>Diff</b>
        <Tip label={`${left.rev ? left.rev + " of " : ""}${left.node}:${left.path}`}><span className="muted ed-pair">{left.rev ? `${left.rev}:` : ""}{left.node}:{left.path}</span></Tip>
        <ArrowLeftRight className="muted" />
        <span className="muted ed-pair">
          {dirty && <Tip label="Unsaved changes"><span className="dirty-dot" role="img" aria-label="Unsaved changes" /></Tip>}
          {right.node}:{right.path}
        </span>
        {same && <span className="pill">identical</span>}
        {left.rev && (l as { absent?: boolean } | null)?.absent && <span className="pill">not in {left.rev}</span>}
        <span className="ed-spacer" />
        <Tip label="Toggle side-by-side / inline">
          <button onClick={() => setInline((v) => !v)} aria-pressed={inline}>
            {inline ? <Ic.Columns2 /> : <Ic.Rows2 />} {inline ? "Side by side" : "Inline"}
          </button>
        </Tip>
        <Tip label="Save right side" shortcut="Ctrl+S"><button onClick={() => void save()} disabled={!dirty || saving}><Ic.Save /> {saving ? "Saving..." : "Save right"}</button></Tip>
        <Tip label="Close"><button onClick={close}><Ic.X /> Close</button></Tip>
        {extra}
      </div>
      {conflict !== null && <Conflict onOverwrite={() => void save(true)} onReload={load} />}
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      <div className="ed-body">
        {l && r && (
          <DiffEditor
            originalLanguage={languageForPath(left.path)}
            modifiedLanguage={languageForPath(right.path)}
            originalModelPath={modelUri(left.node, left.path) + "?side=left" + (left.rev ? `&rev=${encodeURIComponent(left.rev)}` : "")}
            modifiedModelPath={modelUri(right.node, right.path) + "?side=right"}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            original={l.content}
            modified={r.content}
            theme={theme}
            options={{ ...OPTS, renderSideBySide: !inline, originalEditable: false, readOnly: false, useInlineViewWhenSpaceIsLimited: false }}
            onMount={(e) => {
              ed.current = e;
              e.getModifiedEditor().focus();
              e.getModifiedEditor().onDidChangeModelContent(() => setRText(e.getModifiedEditor().getValue()));
            }}
            loading={<div className="pad muted">Loading editor...</div>}
          />
        )}
        {!(l && r) && !err && <div className="pad muted">Loading...</div>}
      </div>
    </div>
  );
}
