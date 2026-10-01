import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, canEdit, onOpFinished, type OpSpec, createFile, fileUrl, fmtDate, fmtSize, isArchive, join, nodeBase, parent, zipUrl, type Entry } from "./api";
import { dropEntries, enqueueUpload, gatherDrop, pickedFromInput } from "./uploads";
import { CompressDialog, ExtractDialog } from "./ArchiveDialog";
import { getDrag, hasFiles, setDrag } from "./DragData";
import { Preview } from "./Preview";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog, NameDialog } from "./Dialogs";
import { PropertiesDialog } from "./Properties";
import { copyText, getClip, setClip, useClip } from "./clipboard";
import type { FileRef } from "./EditorViews";
import { SearchView } from "./Search";
import { EMPTY_SEARCH, type Dock, type Leaf, type Loc, type SearchForm, type SortKey } from "./urlState";

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
  /** the other panels, for "diff with..." / "compare folders with..." menu entries */
  peers: { id: string; node: string; path: string; sel?: string }[];
  /** the panel F5/F6 copy and move to (the next panel in layout order), if any */
  next: { node: string; path: string } | null;
  /** Tab / Shift+Tab: move focus to the next / previous panel */
  onSwitch: (dir: 1 | -1) => void;
  /** `?` opens the shortcut overlay */
  onHelp: () => void;
  /** open this node's trash browser */
  onTrash: (node: string) => void;
  onStatus: (msg: string) => void;
}

type Modal =
  | { k: "new"; dir: string; type: "file" | "folder" }
  | { k: "del"; paths: string[] }
  | { k: "props"; path: string; entry?: Entry };
const isDirEntry = (e: Entry) => e.type === "dir" || !!e.linkDir;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

export function FilePanel({ leaf, active, onFocus, onNavigate, onSplit, onClose, onPatch, onDiff, diffMarked, onFolderDiff, folderMarked, peers, next, onSwitch, onHelp, onTrash, onStatus }: Props) {
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
  const [cursor, setCursor] = useState<string | null>(leaf.sel ?? null);
  const filter = leaf.q ?? "";
  const [filterOpen, setFilterOpen] = useState(!!leaf.q);
  const filterInput = useRef<HTMLInputElement>(null);
  const secRef = useRef<HTMLElement>(null);
  const [over, setOver] = useState<string | null>(null); // "." = panel itself, else folder path
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"compress" | "extract" | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const clip = useClip();
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

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((e) => e.name.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

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

  // A finished hub job (copy, move, delete...) changes what this folder holds.
  useEffect(() => onOpFinished(() => refresh()), [refresh]);
  /** Hand a bulk operation to the hub job queue; progress shows in the jobs drawer and it survives closing the browser. */
  const queueOp = async (label: string, spec: OpSpec) => {
    try {
      await api.startOp(spec);
      onStatus(`${label} queued (see Jobs)`);
    } catch (e) {
      onStatus(`${label} failed: ${(e as Error).message}`);
    }
  };
  const transferOp = (op: "copy" | "move", from: string, paths: string[], to: string, dir: string) =>
    queueOp(op === "copy" ? "Copy" : "Move", { op, items: paths.map((p) => ({ node: from, path: p })), dst: { node: to, dir }, conflict: "ask" });
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
    setCursor(en.path);
    if (e.shiftKey && anchor) {
      const a = visible.findIndex((x) => x.path === anchor);
      const b = visible.findIndex((x) => x.path === en.path);
      setSel(new Set(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
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
  const open = (en: Entry) => openFile(en);
  // Search results: show a hit in its own folder (selected and scrolled into view) or open it.
  const scrollTo = useRef<string | null>(null);
  const hitPath = (rel: string) => join(path, rel);
  const revealHit = (rel: string) => {
    const full = hitPath(rel);
    scrollTo.current = full;
    onNavigate(node, parent(full));
    setSel(new Set([full]));
    setAnchor(full);
    setCursor(full);
  };
  const openHit = (rel: string, h: { t: Entry["type"] }) => {
    const full = hitPath(rel);
    if (h.t === "dir") onNavigate(node, full);
    else window.open(fileUrl(node, full), "_blank", "noopener");
  };
  const setSearch = (sr: SearchForm | undefined) => onPatch({ sr });
  const selected = () => [...sel];
  const selEntries = entries.filter((e) => sel.has(e.path));

  // ---- shared actions (context menus, toolbar) ----
  const download = (picked: Entry[]) => {
    const one = picked.length === 1 ? picked[0] : undefined;
    if (one && one.type === "file") window.location.href = fileUrl(node, one.path, "download");
    else if (picked.length) window.location.href = zipUrl(node, path, picked.map((x) => x.name));
  };
  const setClipboard = (mode: "copy" | "cut", picked: Entry[]) => {
    setClip({ mode, node, paths: picked.map((x) => x.path) });
    onStatus(`${mode === "cut" ? "Cut" : "Copied"} ${picked.length} item(s) to the file clipboard`);
  };
  const paste = async (dir: string) => {
    const c = getClip();
    if (!c) return;
    const cut = c.mode === "cut";
    if (cut && c.node === node && c.paths.every((p) => parent(p) === dir)) return onStatus("Already in this folder");
    await transferOp(cut ? "move" : "copy", c.node, c.paths, node, dir);
    if (cut) setClip(null);
  };
  const copyPaths = (paths: string[]) =>
    copyText(paths.join("\n")).then(
      () => onStatus(`Copied ${paths.length > 1 ? paths.length + " paths" : paths[0]}`),
      (e: Error) => onStatus(`Copy path failed: ${e.message}`),
    );
  const duplicate = (picked: Entry[]) => run("Duplicate", () => api.copy(node, picked.map((x) => x.path), path));
  const trashPaths = (paths: string[]) => queueOp("Trash", { op: "trash", items: paths.map((p) => ({ node, path: p })) });
  const peerLabel = (pr: { node: string; path: string }) => `${pr.node}:${pr.path}`;
  const diffItems = (picked: Entry[]): MenuItem[] => {
    const files = picked.filter(canEdit);
    if (picked.length === 2 && files.length === 2) return [{ label: "Diff the two selected files", onSelect: () => onDiff(files.map((e) => ({ node, path: e.path }))) }];
    if (picked.length !== 1 || files.length !== 1) return [{ label: "Diff with...", disabled: true }];
    const f = { node, path: files[0]!.path };
    const sub: MenuItem[] = [
      { label: diffMarked ? "Compare with the marked file" : "Mark for diff (pick the other file next)", onSelect: () => onDiff([f]) },
      ...peers.filter((pr) => pr.sel && pr.sel !== f.path || pr.sel && pr.node !== node).map((pr): MenuItem => ({ label: `Selected in ${peerLabel(pr)}: ${base(pr.sel!)}`, onSelect: () => onDiff([f, { node: pr.node, path: pr.sel! }]) })),
    ];
    return [{ label: "Diff with...", sub }];
  };
  const compareItems = (dirs: Loc[]): MenuItem[] => {
    if (dirs.length === 2) return [{ label: "Compare the two selected folders", onSelect: () => onFolderDiff(dirs) }];
    if (dirs.length !== 1) return [{ label: "Compare folders...", disabled: true }];
    const d = dirs[0]!;
    const sub: MenuItem[] = [
      { label: folderMarked ? "Compare with the marked folder" : "Mark for folder compare (pick the other folder next)", onSelect: () => onFolderDiff([d]) },
      ...peers.filter((pr) => pr.node !== d.node || pr.path !== d.path).map((pr): MenuItem => ({ label: `With ${peerLabel(pr)}`, onSelect: () => onFolderDiff([d, { node: pr.node, path: pr.path }]) })),
    ];
    return [{ label: "Compare folders...", sub }];
  };
  const pasteLabel = clip ? `Paste ${clip.paths.length} item(s)${clip.node !== node ? ` from ${clip.node}` : ""}` : "Paste";

  const openFile = (en: Entry) => {
    if (isDirEntry(en)) onNavigate(node, en.path);
    else window.open(fileUrl(node, en.path), "_blank", "noopener");
  };
  const showMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const rowItems = (picked: Entry[]): MenuItem[] => {
    const one = picked.length === 1 ? picked[0]! : undefined;
    const folders = picked.filter(isDirEntry);
    const pasteDir = one && isDirEntry(one) ? one.path : path;
    return [
      { label: one && isDirEntry(one) ? "Open folder" : "Open", disabled: !one, hint: "Enter", onSelect: () => one && openFile(one) },
      { label: "Preview", disabled: !one || isDirEntry(one), onSelect: () => setClosedFor(null) },
      { label: "Edit", disabled: !one || !canEdit(one), onSelect: () => one && setEditing({ node, path: one.path }) },
      ...diffItems(picked),
      ...(folders.length === picked.length ? compareItems(folders.map((f) => ({ node, path: f.path }))) : []),
      "sep",
      { label: "Cut", hint: "Ctrl+X", onSelect: () => setClipboard("cut", picked) },
      { label: "Copy", hint: "Ctrl+C", onSelect: () => setClipboard("copy", picked) },
      { label: pasteLabel + (pasteDir !== path ? " into folder" : ""), hint: "Ctrl+V", disabled: !clip, onSelect: () => void paste(pasteDir) },
      "sep",
      { label: "Rename", hint: "F2", disabled: !one, onSelect: () => one && setRenaming(one.path) },
      { label: "Duplicate", onSelect: () => void duplicate(picked) },
      { label: "Compress...", onSelect: () => setDialog("compress") },
      { label: "Extract...", disabled: !(one && one.type === "file" && isArchive(one.name)), onSelect: () => setDialog("extract") },
      { label: picked.length === 1 && one!.type === "file" ? "Download" : "Download as zip", onSelect: () => download(picked) },
      "sep",
      { label: picked.length > 1 ? "Copy paths" : "Copy path", onSelect: () => void copyPaths(picked.map((x) => x.path)) },
      { label: "Move to trash", hint: "Del", danger: true, onSelect: () => void trashPaths(picked.map((x) => x.path)) },
      { label: "Delete permanently...", hint: "Shift+Del", danger: true, onSelect: () => setModal({ k: "del", paths: picked.map((x) => x.path) }) },
      "sep",
      { label: "Properties", disabled: !one, onSelect: () => one && setModal({ k: "props", path: one.path, entry: one }) },
    ];
  };
  /** Menu for a folder itself: empty space in the listing, or a breadcrumb. */
  const folderItems = (dir: string, here: boolean): MenuItem[] => [
    ...(here ? [] : [{ label: "Open", onSelect: () => onNavigate(node, dir) } as MenuItem]),
    { label: "New file...", onSelect: () => setModal({ k: "new", dir, type: "file" }) },
    { label: "New folder...", onSelect: () => setModal({ k: "new", dir, type: "folder" }) },
    { label: pasteLabel, hint: here ? "Ctrl+V" : undefined, disabled: !clip, onSelect: () => void paste(dir) },
    ...(here ? ([{ label: "Select all", hint: "Ctrl+A", onSelect: () => setSel(new Set(entries.map((x) => x.path))) }, { label: "Upload...", onSelect: () => fileInput.current?.click() }, { label: "Upload folder...", onSelect: () => folderInput.current?.click() }, { label: "Refresh", onSelect: refresh }] as MenuItem[]) : []),
    "sep",
    ...compareItems([{ node, path: dir }]),
    { label: "Copy path", onSelect: () => void copyPaths([dir]) },
    { label: "Open trash", onSelect: () => onTrash(node) },
    "sep",
    { label: "Properties", onSelect: () => setModal({ k: "props", path: dir }) },
  ];

  const drop = async (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const copy = e.ctrlKey || e.altKey;
    const src = getDrag(e);
    if (src) {
      if (src.node === node && src.paths.every((p) => parent(p) === destDir) && !copy) return;
      await transferOp(copy ? "copy" : "move", src.node, src.paths, node, destDir);
    } else if (hasFiles(e)) {
      // Entries are only readable during the event, so take them before awaiting anything.
      const dropped = dropEntries(e.dataTransfer);
      onStatus("Reading dropped items...");
      try {
        const { picked, dirs } = await gatherDrop(dropped);
        if (!picked.length && !dirs.length) return onStatus("Nothing to upload");
        enqueueUpload(node, destDir, picked, dirs);
        onStatus(`Uploading ${picked.length} file(s)${dirs.length ? ` in ${dirs.length} folder(s)` : ""} (see Jobs)`);
      } catch (err) {
        onStatus(`Upload failed: ${(err as Error).message}`);
      }
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
  const folderInput = useRef<HTMLInputElement>(null);

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
  const searchView = leaf.sr ? (
    <SearchView node={node} dir={path} hidden={hidden} form={leaf.sr} onForm={setSearch} onClose={() => (setSearch(undefined), setTimeout(() => secRef.current?.focus(), 0))} onReveal={revealHit} onOpen={openHit} onStatus={onStatus} />
  ) : null;
  const listing = searchView ?? (
      <div
        className="fp-scroll"
        onClick={(e) => e.target === e.currentTarget && setSel(new Set())}
        onContextMenu={(e) => {
          onFocus();
          setSel(new Set());
          showMenu(e, folderItems(path, true));
        }}
      >
        <table className="ft">
          <thead>
            <tr>{th("name", "Name")}{th("size", "Size")}{th("mtime", "Modified")}</tr>
          </thead>
          <tbody>
            {visible.map((en) => {
              const isDir = en.type === "dir" || en.linkDir;
              return (
                <tr
                  key={en.path}
                  data-path={en.path}
                  className={(sel.has(en.path) ? "sel " : "") + (cursor === en.path ? "cur " : "") + (over === en.path ? "drop" : "")}
                  draggable
                  onClick={(e) => click(e, en)}
                  onDoubleClick={() => open(en)}
                  onContextMenu={(e) => {
                    onFocus();
                    const picked = sel.has(en.path) ? entries.filter((x) => sel.has(x.path)) : [en];
                    if (!sel.has(en.path)) {
                      setSel(new Set([en.path]));
                      setAnchor(en.path);
                    }
                    showMenu(e, rowItems(picked));
                  }}
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
        {entries.length > 0 && !visible.length && <div className="muted pad">No entries match the filter.</div>}
      </div>
  );
  // ---- keyboard ----
  const selectOnly = (p: string) => {
    setSel(new Set([p]));
    setAnchor(p);
    setCursor(p);
  };
  useEffect(() => {
    if (!cursor) return;
    secRef.current?.querySelector(`tr[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useEffect(() => {
    const p = scrollTo.current;
    if (!p || !entries.some((e) => e.path === p)) return;
    scrollTo.current = null;
    setTimeout(() => secRef.current?.querySelector(`tr[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "center" }), 0);
  }, [entries]);
  const toOther = (op: "copy" | "move") => {
    if (!next) return onStatus("Open a second panel first (split button)");
    if (!selEntries.length) return;
    const paths = selEntries.map((x) => x.path);
    const label = op === "copy" ? "Copy" : "Move";
    void transferOp(op, node, paths, next.node, next.path);
  };
  function onKeyDown(e: React.KeyboardEvent) {
    if (menu || modal || dialog) return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea,select,[contenteditable=true],.monaco-editor")) return;
    if (t.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const hasText = !!window.getSelection()?.toString();
    const idx = cursor ? visible.findIndex((x) => x.path === cursor) : -1;
    const moveTo = (i: number) => {
      const en = visible[Math.max(0, Math.min(visible.length - 1, i))];
      if (!en) return;
      setCursor(en.path);
      if (e.shiftKey) {
        const a = visible.findIndex((x) => x.path === (anchor ?? en.path));
        const b = visible.findIndex((x) => x.path === en.path);
        setSel(new Set(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
        if (!anchor) setAnchor(en.path);
      } else selectOnly(en.path);
    };
    const handled = (() => {
      // While the search results are open the panel's own selection is hidden: no file operations by key.
      if (leaf.sr && !(key === "Tab" || key === "?" || (mod && e.shiftKey && key.toLowerCase() === "f"))) return false;
      if (key === "?" && !mod) return onHelp(), true;
      if (key === "Tab" && !mod && !e.altKey) return onSwitch(e.shiftKey ? -1 : 1), true;
      if (mod && e.shiftKey && key.toLowerCase() === "f") return setSearch(leaf.sr ?? EMPTY_SEARCH), true;
      if (mod && key.toLowerCase() === "f") {
        if (filterInput.current) {
          filterInput.current.focus();
          filterInput.current.select();
        } else setFilterOpen(true); // the input autofocuses when it mounts
        return true;
      }
      if (mod && key.toLowerCase() === "a") return !hasText && (setSel(new Set(visible.map((x) => x.path))), true);
      if (mod && key.toLowerCase() === "c") return !hasText && selEntries.length > 0 && (setClipboard("copy", selEntries), true);
      if (mod && key.toLowerCase() === "x") return selEntries.length > 0 && (setClipboard("cut", selEntries), true);
      if (mod && key.toLowerCase() === "v") return !!getClip() && (void paste(path), true);
      if (key === "ArrowDown") return moveTo(idx + 1), true;
      if (key === "ArrowUp") return moveTo(idx < 0 ? 0 : idx - 1), true;
      if (key === "Home") return moveTo(0), true;
      if (key === "End") return moveTo(visible.length - 1), true;
      if (key === "PageDown") return moveTo(idx + 10), true;
      if (key === "PageUp") return moveTo(idx - 10), true;
      if (key === "Enter" && !mod) {
        const en = visible[idx];
        return !!en && (open(en), true);
      }
      if (key === "Backspace" || (e.altKey && key === "ArrowUp")) return path !== "/" && (onNavigate(node, parent(path)), true);
      if (key === "F2") return selEntries.length === 1 && (setRenaming(selEntries[0]!.path), true);
      if (key === "F4") return selEntries.length === 1 && canEdit(selEntries[0]!) && (setEditing({ node, path: selEntries[0]!.path }), true);
      if (key === "F5") return toOther("copy"), true;
      if (key === "F6") return toOther("move"), true;
      if (key === "F7") return setModal({ k: "new", dir: path, type: "folder" }), true;
      if (key === "Delete") {
        if (!selEntries.length) return false;
        if (e.shiftKey) setModal({ k: "del", paths: selected() });
        else void trashPaths(selected());
        return true;
      }
      if (key === "Escape") {
        if (filter || filterOpen) return onPatch({ q: undefined }), setFilterOpen(false), true;
        return sel.size > 0 && (setSel(new Set()), true);
      }
      if (key === "ContextMenu" || (e.shiftKey && key === "F10")) {
        const row = cursor ? secRef.current?.querySelector(`tr[data-path="${CSS.escape(cursor)}"]`) : null;
        const r = (row ?? secRef.current?.querySelector(".fp-scroll"))?.getBoundingClientRect();
        const x = (r?.left ?? 100) + 48;
        const y = (row ? r!.bottom : (r?.top ?? 100) + 24);
        setMenu({ x, y, items: selEntries.length ? rowItems(selEntries) : folderItems(path, true) });
        return true;
      }
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  const horizontal = dock === "left" || dock === "right";
  const first = dock === "left" || dock === "top";

  return (
    <section
      ref={secRef}
      data-fp={leaf.id}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={"fp" + (active ? " active" : "") + (over === "." ? " drop" : "")}
      onMouseDown={(e) => {
        onFocus();
        if (!(e.target as Element).closest("input,button,select,textarea,a,[role=menu]")) secRef.current?.focus({ preventScroll: true });
      }}
      onDragOver={(e) => dragOver(e, ".")}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => drop(e, path)}
    >
      <header className="fp-bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <button onClick={() => onNavigate(node, "/")} onContextMenu={(e) => showMenu(e, folderItems("/", false))} title={node}>
            {node}:
          </button>
          {crumbs.map((c, i) => (
            <button key={i} onClick={() => onNavigate(node, "/" + crumbs.slice(0, i + 1).join("/"))} onContextMenu={(e) => showMenu(e, folderItems("/" + crumbs.slice(0, i + 1).join("/"), false))}>
              /{c}
            </button>
          ))}
        </nav>
        <div className="fp-actions">
          <button title="Search under this folder (Ctrl+Shift+F)" className={leaf.sr ? "marked" : ""} aria-pressed={!!leaf.sr} onClick={() => setSearch(leaf.sr ? undefined : EMPTY_SEARCH)}>🔍</button>
          <button title="Up" disabled={path === "/"} onClick={() => onNavigate(node, parent(path))}>↑</button>
          <button title="New folder" onClick={() => setModal({ k: "new", dir: path, type: "folder" })}>＋📁</button>
          <button title="New file" onClick={() => setModal({ k: "new", dir: path, type: "file" })}>＋📄</button>
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
          <button title="Download (several items or folders as a zip)" disabled={!sel.size} onClick={() => download(selEntries)}>⇩</button>
          <button title="Compress selection" disabled={!sel.size} onClick={() => setDialog("compress")}>📦</button>
          <button title="Extract archive" disabled={!(sel.size === 1 && entries.some((x) => x.path === [...sel][0] && x.type === "file" && isArchive(x.name)))} onClick={() => setDialog("extract")}>📂</button>
          <button title="Move to trash" disabled={!sel.size} onClick={() => void trashPaths(selected())}>🗑</button>
          <button title="Delete permanently" disabled={!sel.size} onClick={() => setModal({ k: "del", paths: selected() })}>✕</button>
          <label className="chk"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
          <button title="Split right" onClick={() => onSplit("horizontal")}>▥</button>
          <button title="Split down" onClick={() => onSplit("vertical")}>▤</button>
          {onClose && <button title="Close panel" onClick={onClose}>×</button>}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
            enqueueUpload(node, path, pickedFromInput(files));
            onStatus(`Uploading ${files.length} file(s) (see Jobs)`);
          }} />
          <input ref={folderInput} type="file" hidden {...({ webkitdirectory: "", directory: "" } as object)} onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
            enqueueUpload(node, path, pickedFromInput(files));
            onStatus(`Uploading folder, ${files.length} file(s) (see Jobs)`);
          }} />
        </div>
      </header>
      {filterOpen && (
        <div className="fp-filter">
          <input
            ref={filterInput}
            autoFocus
            type="search"
            placeholder="Filter this folder (Esc to clear)"
            aria-label="Filter this folder"
            value={filter}
            onChange={(e) => onPatch({ q: e.target.value || undefined })}
            onKeyDown={(e) => {
              if (e.key === "Escape" || (e.key === "Enter" && !filter)) {
                e.stopPropagation();
                onPatch({ q: undefined });
                setFilterOpen(false);
                secRef.current?.focus();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                secRef.current?.focus();
                if (visible[0]) selectOnly(visible[0].path);
              }
            }}
          />
        </div>
      )}
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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {modal?.k === "new" && (
        <NameDialog
          title={modal.type === "file" ? "New file" : "New folder"}
          label="Name"
          action="Create"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const target = join(modal.dir, name);
            if (modal.type === "file") await createFile(node, target);
            else await api.mkdir(node, target);
            onStatus(`Created ${target}`);
            refresh();
          }}
        />
      )}
      {modal?.k === "del" && (
        <ConfirmDialog
          title="Delete permanently"
          message={`Permanently delete ${modal.paths.length === 1 ? base(modal.paths[0]!) : modal.paths.length + " items"}? This cannot be undone.`}
          action="Delete permanently"
          danger
          onClose={() => setModal(null)}
          onConfirm={() => void queueOp("Delete", { op: "delete", items: modal.paths.map((p) => ({ node, path: p })) })}
        />
      )}
      {modal?.k === "props" && <PropertiesDialog node={node} path={modal.path} entry={modal.entry} onClose={() => setModal(null)} onChanged={refresh} onStatus={onStatus} />}
      {dialog === "compress" && (
        <CompressDialog node={node} dir={path} names={entries.filter((x) => sel.has(x.path)).map((x) => x.name)} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
      {dialog === "extract" && [...sel][0] && (
        <ExtractDialog node={node} archive={[...sel][0]!} defaultDest={path} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
    </section>
  );
}
