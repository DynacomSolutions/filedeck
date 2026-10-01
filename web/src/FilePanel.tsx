import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, canEdit, fileUrl, fmtDate, fmtSize, isArchive, join, nodeBase, parent, zipUrl, type Entry } from "./api";
import { CompressDialog, ExtractDialog } from "./ArchiveDialog";
import { getDrag, hasFiles, setDrag } from "./DragData";
import { Preview } from "./Preview";
import type { FileRef } from "./EditorViews";
import type { Dock, Leaf, SortKey } from "./urlState";

// Monaco (several MB) stays in its own chunk, fetched on first edit.
const TextEditor = lazy(() => import("./EditorViews").then((m) => ({ default: m.TextEditor })));

const DOCKS: { dock: Dock; icon: string; label: string }[] = [
  { dock: "left", icon: "◧", label: "Dock preview left" },
  { dock: "right", icon: "◨", label: "Dock preview right" },
  { dock: "top", icon: "⬒", label: "Dock preview top" },
  { dock: "bottom", icon: "⬓", label: "Dock preview bottom" },
];
export type { Leaf };

interface Props {
  leaf: Leaf;
  active: boolean;
  onFocus: () => void;
  onNavigate: (node: string, path: string) => void;
  onSplit: (dir: "horizontal" | "vertical") => void;
  onClose: (() => void) | null;
  /** non-navigation state (selection, sort, preview dock...) mirrored into the URL */
  onPatch: (p: Partial<Leaf>) => void;
  /** Two selected files diff directly; one selected file is marked, then paired with the next. */
  onDiff: (files: { node: string; path: string }[]) => void;
  diffMarked: boolean;
  /** Folder diff: two selected folders compare directly; one folder (or this panel's folder when nothing is selected) is marked, then paired with the next. */
  onFolderDiff: (folders: { node: string; path: string }[]) => void;
  folderMarked: boolean;
  onStatus: (msg: string) => void;
}

export function FilePanel({ leaf, active, onFocus, onNavigate, onSplit, onClose, onPatch, onDiff, diffMarked, onFolderDiff, folderMarked, onStatus }: Props) {
  const { node, path } = leaf;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  const [hidden, setHiddenState] = useState(leaf.hidden ?? false);
  const [sort, setSortState] = useState<{ key: SortKey; asc: boolean }>(leaf.sort ?? { key: "name", asc: true });
  const [sel, setSel] = useState<Set<string>>(() => new Set(leaf.sel ? [leaf.sel] : []));
  const setHidden = (h: boolean) => {
    setHiddenState(h);
    onPatch({ hidden: h || undefined });
  };
  const setSort = (fn: (s: { key: SortKey; asc: boolean }) => { key: SortKey; asc: boolean }) => {
    const n = fn(sort);
    setSortState(n);
    onPatch({ sort: n.key === "name" && n.asc ? undefined : n });
  };
  const [anchor, setAnchor] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null); // "." = panel itself, else folder path
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"compress" | "extract" | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Per-panel preview: shown only while exactly one file is selected here (or being edited).
  const editing = leaf.edit ?? null;
  const setEditing = (f: FileRef | null) => onPatch({ edit: f ?? undefined });
  const closedFor = leaf.closed ?? null;
  const setClosedFor = (p: string | null) => onPatch({ closed: p ?? undefined });
  const dock: Dock = leaf.pv?.dock ?? "right";
  const pvSize = leaf.pv?.size ?? 40;
  const setDock = (d: Dock) => onPatch({ pv: { dock: d, size: pvSize } });

  useEffect(() => {
    let live = true;
    api
      .list(node, path, hidden)
      .then((r) => {
        if (!live) return;
        setEntries(r.entries);
        setErr(r.truncated ? "Listing truncated" : "");
        setSel((s) => new Set([...s].filter((p) => r.entries.some((e) => e.path === p))));
      })
      .catch((e: Error) => live && (setErr(e.message), setEntries([])));
    return () => {
      live = false;
    };
  }, [node, path, hidden, tick]);

  // Live feed: refresh when the watched directory changes.
  useEffect(() => {
    const es = new EventSource(`${nodeBase(node)}/api/events?path=${encodeURIComponent(path)}`);
    es.addEventListener("change", refresh);
    return () => es.close();
  }, [node, path, refresh]);

  const sorted = useMemo(() => {
    const f = [...entries];
    const dirFirst = (e: Entry) => (e.type === "dir" || e.linkDir ? 0 : 1);
    f.sort((a, b) => {
      const d = dirFirst(a) - dirFirst(b);
      if (d) return d;
      const c = sort.key === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a[sort.key] - b[sort.key];
      return sort.asc ? c : -c;
    });
    return f;
  }, [entries, sort]);

  const only = sel.size === 1 ? entries.find((e) => e.path === [...sel][0]) : undefined;
  const previewEntry = only && only.type !== "dir" && !only.linkDir && closedFor !== only.path ? only : null;
  useEffect(() => {
    if (closedFor && closedFor !== only?.path) setClosedFor(null);
  }, [only?.path, closedFor]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mirror a single selection into the URL once the listing has confirmed it exists.
  useEffect(() => {
    if (!entries.length && sel.size) return; // a deep-linked selection waits for the listing
    const v = sel.size === 1 ? [...sel][0] : undefined;
    if (v !== leaf.sel) onPatch({ sel: v });
  }, [sel, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      onStatus(label + "...");
      await fn();
      onStatus(label + " done");
    } catch (e) {
      onStatus(`${label} failed: ${(e as Error).message}`);
    }
    refresh();
  };

  const click = (e: React.MouseEvent, en: Entry) => {
    onFocus();
    if (e.shiftKey && anchor) {
      const a = sorted.findIndex((x) => x.path === anchor);
      const b = sorted.findIndex((x) => x.path === en.path);
      setSel(new Set(sorted.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        n.has(en.path) ? n.delete(en.path) : n.add(en.path);
        return n;
      });
      setAnchor(en.path);
    } else {
      setSel(new Set([en.path]));
      setAnchor(en.path);
    }
  };
  const open = (en: Entry) => {
    if (en.type === "dir" || en.linkDir) onNavigate(node, en.path);
    else window.open(fileUrl(node, en.path), "_blank", "noopener");
  };
  const selected = () => [...sel];
  const selEntries = entries.filter((e) => sel.has(e.path));

  const drop = async (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const copy = e.ctrlKey || e.altKey;
    const src = getDrag(e);
    if (src) {
      if (src.node === node) {
        if (src.paths.every((p) => parent(p) === destDir) && !copy) return;
        await run(copy ? "Copy" : "Move", () => (copy ? api.copy(node, src.paths, destDir) : api.move(node, src.paths, destDir)));
      } else {
        await run("Transfer", async () => {
          for (const p of src.paths) await api.transfer({ node: src.node, path: p }, { node, dir: destDir }, copy ? "copy" : "move");
        });
      }
    } else if (hasFiles(e)) {
      const files = Array.from(e.dataTransfer.files);
      await run(`Upload ${files.length} file(s)`, async () => {
        for (const f of files) await api.upload(node, destDir, f, (p) => onStatus(`Uploading ${f.name} ${Math.round(p * 100)}%`));
      });
    }
  };
  const dragOver = (e: React.DragEvent, target: string) => {
    if (!getDrag(e) && !hasFiles(e) && !Array.from(e.dataTransfer.types).includes("application/x-filedeck")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? "copy" : "move";
    setOver(target);
  };

  const crumbs = path.split("/").filter(Boolean);
  const th = (key: SortKey, label: string) => (
    <th onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))} className={"sortable " + key}>
      {label}
      {sort.key === key ? (sort.asc ? " ▲" : " ▼") : ""}
    </th>
  );
  const fileInput = useRef<HTMLInputElement>(null);

  const paneExtra = (
    <span className="pv-dock" role="group" aria-label="Preview position">
      {DOCKS.map((d) => (
        <button key={d.dock} type="button" className={"pv-dockbtn" + (dock === d.dock ? " on" : "")} aria-pressed={dock === d.dock} title={d.label} aria-label={d.label} onClick={() => setDock(d.dock)}>
          {d.icon}
        </button>
      ))}
      <button type="button" className="pv-dockbtn" title="Close preview" aria-label="Close preview" onClick={() => (editing ? setEditing(null) : only && setClosedFor(only.path))}>
        ×
      </button>
    </span>
  );
  const pane = editing ? (
    <Suspense fallback={<div className="pad muted">Loading editor...</div>}>
      <TextEditor key={editing.node + editing.path} file={editing} inline onClose={() => setEditing(null)} onStatus={onStatus} extra={paneExtra} />
    </Suspense>
  ) : previewEntry ? (
    <Preview node={node} entry={previewEntry} onEdit={(n, p) => setEditing({ node: n, path: p })} extra={paneExtra} />
  ) : null;
  const listing = (
      <div className="fp-scroll" onClick={(e) => e.target === e.currentTarget && setSel(new Set())}>
        <table className="ft">
          <thead>
            <tr>{th("name", "Name")}{th("size", "Size")}{th("mtime", "Modified")}</tr>
          </thead>
          <tbody>
            {sorted.map((en) => {
              const isDir = en.type === "dir" || en.linkDir;
              return (
                <tr
                  key={en.path}
                  className={(sel.has(en.path) ? "sel " : "") + (over === en.path ? "drop" : "")}
                  draggable
                  onClick={(e) => click(e, en)}
                  onDoubleClick={() => open(en)}
                  onDragStart={(e) => {
                    const paths = sel.has(en.path) ? selected() : [en.path];
                    if (!sel.has(en.path)) setSel(new Set([en.path]));
                    setDrag(e, { node, paths });
                  }}
                  onDragOver={isDir ? (e) => dragOver(e, en.path) : undefined}
                  onDrop={isDir ? (e) => drop(e, en.path) : undefined}
                >
                  <td className="name">
                    <span className="ico">{isDir ? "📁" : en.type === "symlink" ? "🔗" : "📄"}</span>
                    {renaming === en.path ? (
                      <input
                        autoFocus
                        defaultValue={en.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setRenaming(null);
                          if (e.key === "Enter") {
                            const v = e.currentTarget.value.trim();
                            setRenaming(null);
                            if (v && v !== en.name) void run("Rename", () => api.rename(node, en.path, join(parent(en.path), v)));
                          }
                        }}
                      />
                    ) : (
                      <span className="nm">{en.name}</span>
                    )}
                  </td>
                  <td className="num">{isDir ? "" : fmtSize(en.size)}</td>
                  <td className="num">{fmtDate(en.mtime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!entries.length && !err && <div className="muted pad">Empty folder. Drop files here to upload.</div>}
      </div>
  );
  const horizontal = dock === "left" || dock === "right";
  const first = dock === "left" || dock === "top";

  return (
    <section
      className={"fp" + (active ? " active" : "") + (over === "." ? " drop" : "")}
      onMouseDown={onFocus}
      onDragOver={(e) => dragOver(e, ".")}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => drop(e, path)}
    >
      <header className="fp-bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <button onClick={() => onNavigate(node, "/")} title={node}>
            {node}:
          </button>
          {crumbs.map((c, i) => (
            <button key={i} onClick={() => onNavigate(node, "/" + crumbs.slice(0, i + 1).join("/"))}>
              /{c}
            </button>
          ))}
        </nav>
        <div className="fp-actions">
          <button title="Up" disabled={path === "/"} onClick={() => onNavigate(node, parent(path))}>↑</button>
          <button title="New folder" onClick={() => {
            const n = prompt("Folder name");
            if (n) void run("New folder", () => api.mkdir(node, join(path, n)));
          }}>＋📁</button>
          <button title="Upload" onClick={() => fileInput.current?.click()}>⇪</button>
          <button title="Rename" disabled={sel.size !== 1} onClick={() => setRenaming([...sel][0] ?? null)}>✎</button>
          <button title="Edit (Monaco)" disabled={!selEntries.length || selEntries.length !== 1 || !selEntries.every(canEdit)} onClick={() => selEntries[0] && setEditing({ node, path: selEntries[0].path })}>✐</button>
          <button
            title={diffMarked ? "Diff against the marked file" : "Diff: select two files, or mark one then pick another"}
            className={diffMarked ? "marked" : ""}
            disabled={!selEntries.length || selEntries.length > 2 || !selEntries.every(canEdit)}
            onClick={() => onDiff(selEntries.map((e) => ({ node, path: e.path })))}
          >⇄</button>
          <button
            title={folderMarked ? "Folder diff against the marked folder" : "Folder diff: select two folders, or mark one (or this folder) then pick another"}
            className={folderMarked ? "marked" : ""}
            disabled={selEntries.length > 2 || !selEntries.every((e) => e.type === "dir" || e.linkDir)}
            onClick={() => onFolderDiff(selEntries.length ? selEntries.map((e) => ({ node, path: e.path })) : [{ node, path }])}
          >⇆</button>
          <button title="Download (several items or folders as a zip)" disabled={!sel.size} onClick={() => {
            const picked = entries.filter((x) => sel.has(x.path));
            const one = picked.length === 1 ? picked[0] : undefined;
            if (one && one.type === "file") window.location.href = fileUrl(node, one.path, "download");
            else if (picked.length) window.location.href = zipUrl(node, path, picked.map((x) => x.name));
          }}>⇩</button>
          <button title="Compress selection" disabled={!sel.size} onClick={() => setDialog("compress")}>📦</button>
          <button title="Extract archive" disabled={!(sel.size === 1 && entries.some((x) => x.path === [...sel][0] && x.type === "file" && isArchive(x.name)))} onClick={() => setDialog("extract")}>📂</button>
          <button title="Move to trash" disabled={!sel.size} onClick={() => void run("Trash", () => api.trash(node, selected()))}>🗑</button>
          <button title="Delete permanently" disabled={!sel.size} onClick={() => {
            if (confirm(`Permanently delete ${sel.size} item(s)? This cannot be undone.`)) void run("Delete", () => api.remove(node, selected()));
          }}>✕</button>
          <label className="chk"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
          <button title="Split right" onClick={() => onSplit("horizontal")}>▥</button>
          <button title="Split down" onClick={() => onSplit("vertical")}>▤</button>
          {onClose && <button title="Close panel" onClick={onClose}>×</button>}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void run(`Upload ${files.length} file(s)`, async () => {
              for (const f of files) await api.upload(node, path, f);
            });
          }} />
        </div>
      </header>
      {err && <div className="fp-err">{err}</div>}
      {pane ? (
        <Group key={dock} orientation={horizontal ? "horizontal" : "vertical"} id={`${leaf.id}-pv`} defaultLayout={{ list: 100 - pvSize, pv: pvSize }}
          onLayoutChanged={(l) => { const v = l.pv; if (typeof v === "number" && v >= 10 && v <= 90 && Math.abs(v - pvSize) > 0.5) onPatch({ pv: { dock, size: v } }); }}>
          {first && <Panel id="pv" minSize="15%">{pane}</Panel>}
          {first && <Separator className={"sep " + (horizontal ? "horizontal" : "vertical")} />}
          <Panel id="list" minSize="20%">{listing}</Panel>
          {!first && <Separator className={"sep " + (horizontal ? "horizontal" : "vertical")} />}
          {!first && <Panel id="pv" minSize="15%">{pane}</Panel>}
        </Group>
      ) : (
        listing
      )}
      {dialog === "compress" && (
        <CompressDialog node={node} dir={path} names={entries.filter((x) => sel.has(x.path)).map((x) => x.name)} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
      {dialog === "extract" && [...sel][0] && (
        <ExtractDialog node={node} archive={[...sel][0]!} defaultDest={path} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
    </section>
  );
}
