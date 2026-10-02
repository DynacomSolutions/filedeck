import { PANEL_MIME } from "./dock";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, canEdit, onOpFinished, type OpSpec, createFile, fileUrl, fmtDate, fmtSize, isArchive, join, nodeBase, parent, zipUrl, type Entry } from "./api";
import { dropEntries, enqueueUpload, gatherDrop, pickedFromInput } from "./uploads";
import { CompressDialog, ExtractDialog } from "./ArchiveDialog";
import { getDrag, hasFiles, setDrag } from "./DragData";
import { Preview } from "./Preview";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog, LinkDialog, NameDialog } from "./Dialogs";
import { PropertiesDialog } from "./Properties";
import { copyText, getClip, setClip, useClip } from "./clipboard";
import { deleteSpec, downloadRefs, groupRefs, refOf, trashSpec, type SelRef } from "./Selection";
import type { FileRef } from "./EditorViews";
import { SearchView } from "./Search";
import { wheelX } from "./scrollx";
import { AddressBar } from "./AddressBar";
import { CompareBar, CompareBody, compareKey, useCompareCtl } from "./Compare";
import { Thumb } from "./Thumb";
import { isBookmarked, toggleBookmark, useBookmarks } from "./bookmarks";
import { EMPTY_SEARCH, MAX_SELS, MAX_TABS, type Dock, type Leaf, type Loc, type SearchForm, type SortKey } from "./urlState";
import { ArrowRight, ArrowUp, Archive, ChevronDown, ChevronUp, CircleX, Columns2, Diff, Download, FilePen, FilePlus, FolderPlus, GitCompareArrows, LayoutGrid, List, PackageOpen, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Plus, Rows2, Search, SquarePlus, SquareCheck, Star, Trash2, Upload, X, type LucideIcon } from "lucide-react";
import { Tip } from "./Tooltip";
import { FileIcon } from "./FileIcon";
import * as Ic from "lucide-react";

// Monaco (several MB) stays in its own chunk, fetched on first edit.
const TextEditor = lazy(() => import("./EditorViews").then((m) => ({ default: m.TextEditor })));

const DOCKS: { dock: Dock; icon: LucideIcon; label: string }[] = [
  { dock: "left", icon: PanelLeft, label: "Dock preview left" },
  { dock: "right", icon: PanelRight, label: "Dock preview right" },
  { dock: "top", icon: PanelTop, label: "Dock preview top" },
  { dock: "bottom", icon: PanelBottom, label: "Dock preview bottom" },
];
export type { Leaf };

interface Props {
  leaf: Leaf;
  active: boolean;
  onFocus: () => void;
  onNavigate: (node: string, path: string) => void;
  onSplit: (dir: "horizontal" | "vertical") => void;
  onClose: (() => void) | null;
  /** HTML5 drag props that make the panel header the drag handle for docking */
  dragProps?: React.HTMLAttributes<HTMLElement>;
  /** Alt+Shift+Arrow: dock this panel beside its neighbour */
  onDock?: (key: string) => boolean;
  /** non-navigation state (selection, sort, preview dock...) mirrored into the URL */
  onPatch: (p: Partial<Leaf>) => void;
  /** Two selected files diff directly; one selected file is marked, then paired with the next. */
  onDiff: (files: { node: string; path: string }[]) => void;
  diffMarked: boolean;
  /** Compare this panel with another one in place (both panels switch to compare mode). */
  onCompare: (peerId: string) => void;
  /** the other panels, for "diff with..." / "compare with..." menu entries */
  peers: { id: string; node: string; path: string; sel?: string; picked?: boolean }[];
  /** items selected in the other panels: Shift/Ctrl+click adds to them, a plain click clears them, and actions here run on the lot */
  others: SelRef[];
  /** this panel is picked as a whole (Shift/Ctrl+click on its header) */
  panelPicked: boolean;
  /** a plain selection elsewhere asks every other panel to drop its selection */
  clearReq: { except: string; n: number } | null;
  onSelection: (refs: SelRef[]) => void;
  onClearOthers: () => void;
  onTogglePanel: () => void;
  /** the panel F5/F6 copy and move to (the next panel in layout order), if any */
  next: { node: string; path: string } | null;
  /** Tab / Shift+Tab: move focus to the next / previous panel */
  /** move to the neighbouring panel; false when there is none in that direction (Tab then leaves the panels normally) */
  onSwitch: (dir: 1 | -1) => boolean;
  /** `?` opens the shortcut overlay */
  onHelp: () => void;
  /** open this node's trash browser */
  onTrash: (node: string) => void;
  onStatus: (msg: string) => void;
}

type Modal =
  | { k: "link"; dir: string; existing?: Entry }
  | { k: "new"; dir: string; type: "file" | "folder" }
  | { k: "del"; refs: SelRef[] }
  | { k: "props"; path: string; entry?: Entry };
const isDirEntry = (e: Entry) => e.type === "dir" || !!e.linkDir;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

export function FilePanel({ leaf, active, onFocus, onNavigate, onSplit, onClose, dragProps, onDock, onPatch, onDiff, diffMarked, onCompare, peers, others, panelPicked, clearReq, onSelection, onClearOthers, onTogglePanel, next, onSwitch, onHelp, onTrash, onStatus }: Props) {
  const { node, path } = leaf;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  const [hidden, setHiddenState] = useState(leaf.hidden ?? false);
  const [sort, setSortState] = useState<{ key: SortKey; asc: boolean }>(leaf.sort ?? { key: "name", asc: true });
  const [sel, setSel] = useState<Set<string>>(() => new Set(leaf.sels ?? (leaf.sel ? [leaf.sel] : [])));
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
  const view = leaf.w === "g" ? "grid" : "list";
  const filter = leaf.q ?? "";
  const [filterOpen, setFilterOpen] = useState(!!leaf.q);
  const filterInput = useRef<HTMLInputElement>(null);
  const secRef = useRef<HTMLElement>(null);
  const [over, setOver] = useState<string | null>(null); // "." = panel itself, else folder path
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"compress" | "extract" | { k: "compress"; extra: SelRef[] } | null>(null);
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
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = secRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? 999) < 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A narrow panel (phone, deep split) always stacks the preview underneath; the saved dock is kept for wide panels.
  const dock: Dock = narrow ? "bottom" : (leaf.pv?.dock ?? "right");
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
  const previewEntry = only && only.type !== "dir" && !only.linkDir && !only.broken && closedFor !== only.path ? only : null; // a broken link has nothing to preview
  useEffect(() => {
    if (closedFor && closedFor !== only?.path) setClosedFor(null);
  }, [only?.path, closedFor]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mirror a single selection into the URL once the listing has confirmed it exists.
  useEffect(() => {
    if (!entries.length && sel.size) return; // a deep-linked selection waits for the listing
    const v = sel.size === 1 ? [...sel][0] : undefined;
    const many = sel.size > 1 && sel.size <= MAX_SELS ? [...sel].sort() : undefined;
    const old = leaf.sels ? [...leaf.sels].sort() : undefined;
    if (v !== leaf.sel || many?.join("\0") !== old?.join("\0")) onPatch({ sel: v, sels: many });
  }, [sel, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Report the selection upward so the other panels and the selection bar see it.
  useEffect(() => {
    onSelection(entries.filter((e) => sel.has(e.path)).map((e) => refOf(leaf.id, node, e)));
  }, [sel, entries, node]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (clearReq && clearReq.except !== leaf.id) setSel((s) => (s.size ? new Set() : s));
  }, [clearReq]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const transferOp = (op: "copy" | "move", items: { node: string; path: string }[], to: string, dir: string) =>
    queueOp(op === "copy" ? "Copy" : "Move", { op, items: items.map((i) => ({ node: i.node, path: i.path })), dst: { node: to, dir }, conflict: "ask" });
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
    // Plain click selects here and nowhere else; Shift (range) and Ctrl/Cmd (toggle) keep the other panels' selections.
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) onClearOthers();
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
  /** Address bar: go to a folder, optionally selecting a file in it (also when it is already the open folder). */
  const goTo = (n: string, p: string, select?: string) => {
    if (select) {
      scrollTo.current = select;
      onClearOthers();
      setSel(new Set([select]));
      setAnchor(select);
      setCursor(select);
    }
    onNavigate(n, p);
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
  const myRefs = (picked: Entry[]) => picked.map((e) => refOf(leaf.id, node, e));
  /** this panel's picked entries plus whatever is selected in the other panels */
  const combine = (picked: Entry[], extra: SelRef[] = others): SelRef[] => [...myRefs(picked), ...extra];
  const download = (picked: Entry[], extra: SelRef[] = others) => downloadRefs(combine(picked, extra));
  const setClipboard = (mode: "copy" | "cut", picked: Entry[], extra: SelRef[] = others) => {
    const refs = combine(picked, extra);
    setClip({ mode, items: refs.map((r) => ({ node: r.node, path: r.path })) });
    onStatus(`${mode === "cut" ? "Cut" : "Copied"} ${refs.length} item(s) to the file clipboard`);
  };
  const paste = async (dir: string) => {
    const c = getClip();
    if (!c) return;
    const cut = c.mode === "cut";
    if (cut && c.items.every((i) => i.node === node && parent(i.path) === dir)) return onStatus("Already in this folder");
    await transferOp(cut ? "move" : "copy", c.items, node, dir);
    if (cut) setClip(null);
  };
  const copyPaths = (paths: string[]) =>
    copyText(paths.join("\n")).then(
      () => onStatus(`Copied ${paths.length > 1 ? paths.length + " paths" : paths[0]}`),
      (e: Error) => onStatus(`Copy path failed: ${e.message}`),
    );
  const duplicate = (picked: Entry[]) => run("Duplicate", () => api.copy(node, picked.map((x) => x.path), path));
  const trashEntries = (picked: Entry[], extra: SelRef[] = others) => queueOp("Trash", trashSpec(combine(picked, extra)));
  const peerLabel = (pr: { node: string; path: string }) => `${pr.node}:${pr.path}`;
  const diffItems = (picked: Entry[], extra: SelRef[] = others): MenuItem[] => {
    const refs = combine(picked, extra);
    if (refs.length === 2 && refs.every((r) => r.editable)) return [{ label: "Diff the two selected files", onSelect: () => onDiff(refs.map((r) => ({ node: r.node, path: r.path }))) }];
    const files = picked.filter(canEdit);
    if (refs.length !== 1 || files.length !== 1) return [{ label: "Diff with...", disabled: true }];
    const f = { node, path: files[0]!.path };
    const sub: MenuItem[] = [
      { label: diffMarked ? "Compare with the marked file" : "Mark for diff (pick the other file next)", onSelect: () => onDiff([f]) },
      ...peers.filter((pr) => pr.sel && pr.sel !== f.path || pr.sel && pr.node !== node).map((pr): MenuItem => ({ label: `Selected in ${peerLabel(pr)}: ${base(pr.sel!)}`, onSelect: () => onDiff([f, { node: pr.node, path: pr.sel! }]) })),
    ];
    return [{ label: "Diff with...", sub }];
  };
  const cmpCtl = useCompareCtl();
  const cside = cmpCtl?.sideOf(leaf.id) ?? null;
  const compareItems = (): MenuItem[] => {
    if (cside && cmpCtl) return [{ label: "Exit compare", onSelect: cmpCtl.exit }];
    if (!peers.length) return [{ label: "Compare with... (open a second panel first)", disabled: true }];
    return [{ label: "Compare with", sub: peers.map((pr): MenuItem => ({ label: peerLabel(pr), onSelect: () => onCompare(pr.id) })) }];
  };
  const pasteLabel = clip ? `Paste ${clip.items.length} item(s)${clip.items.some((i) => i.node !== node) ? ` from ${[...new Set(clip.items.map((i) => i.node))].join(", ")}` : ""}` : "Paste";

  const openFile = (en: Entry) => {
    if (isDirEntry(en)) onNavigate(node, en.path);
    else window.open(fileUrl(node, en.path), "_blank", "noopener");
  };
  const showMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const rowItems = (picked: Entry[], extra: SelRef[] = others): MenuItem[] => {
    const one = picked.length === 1 ? picked[0]! : undefined;
        const pasteDir = one && isDirEntry(one) ? one.path : path;
    return [
      { label: one && isDirEntry(one) ? "Open folder" : "Open", disabled: !one || extra.length > 0, hint: "Enter", onSelect: () => one && openFile(one) },
      ...(one && isDirEntry(one)
        ? ([
            { label: "Open in new tab", onSelect: () => newTab({ node, path: one.path }) },
            { label: isBookmarked(marks, { node, path: one.path }) ? "Remove bookmark" : "Add to bookmarks", onSelect: () => toggleMark({ node, path: one.path }) },
          ] as MenuItem[])
        : []),
      { label: "Preview", disabled: !one || isDirEntry(one), onSelect: () => setClosedFor(null) },
      { label: "Edit", disabled: !one || !canEdit(one), onSelect: () => one && setEditing({ node, path: one.path }) },
      ...diffItems(picked, extra),
      "sep",
      { label: "Cut", hint: "Ctrl+X", onSelect: () => setClipboard("cut", picked, extra) },
      { label: "Copy", hint: "Ctrl+C", onSelect: () => setClipboard("copy", picked, extra) },
      { label: pasteLabel + (pasteDir !== path ? " into folder" : ""), hint: "Ctrl+V", disabled: !clip, onSelect: () => void paste(pasteDir) },
      "sep",
      ...(one && one.type === "symlink" ? ([{ label: "Edit link target...", onSelect: () => setModal({ k: "link", dir: path, existing: one }) }] as MenuItem[]) : []),
      { label: "Rename", hint: "F2", disabled: !one || extra.length > 0, onSelect: () => one && setRenaming(one.path) },
      { label: "Duplicate", disabled: extra.length > 0, onSelect: () => void duplicate(picked) },
      { label: "Compress...", onSelect: () => setDialog(extra.length ? { k: "compress", extra } : "compress") },
      { label: "Extract...", disabled: !(one && one.type === "file" && isArchive(one.name)), onSelect: () => setDialog("extract") },
      { label: picked.length + extra.length === 1 && one!.type === "file" ? "Download" : "Download as zip", onSelect: () => download(picked, extra) },
      "sep",
      { label: picked.length + extra.length > 1 ? "Copy paths" : "Copy path", onSelect: () => void copyPaths(combine(picked, extra).map((x) => x.path)) },
      { label: "Move to trash", hint: "Del", danger: true, onSelect: () => void trashEntries(picked, extra) },
      { label: "Delete permanently...", hint: "Shift+Del", danger: true, onSelect: () => setModal({ k: "del", refs: combine(picked, extra) }) },
      "sep",
      { label: "Properties", disabled: !one, onSelect: () => one && setModal({ k: "props", path: one.path, entry: one }) },
    ];
  };
  /** Menu for a folder itself: empty space in the listing, or a breadcrumb. */
  const folderItems = (dir: string, here: boolean): MenuItem[] => [
    ...(here ? [] : ([{ label: "Open", onSelect: () => onNavigate(node, dir) }, { label: "Open in new tab", onSelect: () => newTab({ node, path: dir }) }] as MenuItem[])),
    { label: isBookmarked(marks, { node, path: dir }) ? "Remove bookmark" : "Add to bookmarks", onSelect: () => toggleMark({ node, path: dir }) },
    { label: "New file...", onSelect: () => setModal({ k: "new", dir, type: "file" }) },
    { label: "New folder...", onSelect: () => setModal({ k: "new", dir, type: "folder" }) },
    { label: "New symbolic link...", onSelect: () => setModal({ k: "link", dir }) },
    { label: pasteLabel, hint: here ? "Ctrl+V" : undefined, disabled: !clip, onSelect: () => void paste(dir) },
    ...(here ? ([{ label: "Select all", hint: "Ctrl+A", onSelect: () => setSel(new Set(entries.map((x) => x.path))) }, { label: "Upload...", onSelect: () => fileInput.current?.click() }, { label: "Upload folder...", onSelect: () => folderInput.current?.click() }, { label: "Refresh", onSelect: refresh }] as MenuItem[]) : []),
    "sep",
    ...compareItems(),
    { label: "Copy path", onSelect: () => void copyPaths([dir]) },
    { label: "Open trash", onSelect: () => onTrash(node) },
    "sep",
    { label: "Properties", onSelect: () => setModal({ k: "props", path: dir }) },
  ];

  const drop = async (e: React.DragEvent, destDir: string) => {
    if (e.dataTransfer.types.includes(PANEL_MIME)) return; // a dragged panel: the dock slot handles it
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const copy = e.ctrlKey || e.altKey;
    const src = getDrag(e);
    if (src) {
      if (src.node === node && src.paths.every((p) => parent(p) === destDir) && !copy) return;
      await transferOp(copy ? "copy" : "move", src.paths.map((p) => ({ node: src.node, path: p })), node, destDir);
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
      {sort.key === key ? (sort.asc ? <ChevronUp role="img" aria-label="ascending" /> : <ChevronDown role="img" aria-label="descending" />) : null}
    </th>
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const paneExtra = (
    <span className="pv-dock" role="group" aria-label="Preview position">
      {DOCKS.map((d) => (
        <Tip key={d.dock} label={d.label}>
          <button type="button" className={"pv-dockbtn" + (dock === d.dock ? " on" : "")} aria-pressed={dock === d.dock} aria-label={d.label} onClick={() => setDock(d.dock)}>
            <d.icon />
          </button>
        </Tip>
      ))}
      <Tip label="Close preview">
        <button type="button" className="pv-dockbtn" aria-label="Close preview" onClick={() => (editing ? setEditing(null) : only && setClosedFor(only.path))}>
          <X />
        </button>
      </Tip>
    </span>
  );
  const pane = cside ? null : editing ? (
    <Suspense fallback={<div className="pad muted">Loading editor...</div>}>
      <TextEditor key={editing.node + editing.path} file={editing} inline onClose={() => setEditing(null)} onStatus={onStatus} extra={paneExtra} />
    </Suspense>
  ) : previewEntry ? (
    <Preview node={node} entry={previewEntry} onEdit={(n, p) => setEditing({ node: n, path: p })} extra={paneExtra} />
  ) : null;
  // ---- tabs: several folders per panel; `node`/`path` stay the active tab's, the list lives in the URL ----
  const marks = useBookmarks();
  const here = { node, path };
  const tabs: Loc[] = leaf.tabs ?? [here];
  const ti = Math.min(leaf.ti ?? 0, tabs.length - 1);
  const [tabDrag, setTabDrag] = useState<number | null>(null);
  const applyTabs = (list: Loc[], idx: number, reset: boolean) => {
    const t = list[idx]!;
    onPatch({
      tabs: list.length > 1 ? list : undefined,
      ti: list.length > 1 && idx > 0 ? idx : undefined,
      node: t.node,
      path: t.path,
      ...(reset ? { sel: undefined, closed: undefined, sr: undefined, q: undefined } : {}),
    });
    if (reset) {
      setSel(new Set());
      setFilterOpen(false);
    }
  };
  const newTab = (at: Loc = here) => {
    if (tabs.length >= MAX_TABS) return onStatus(`At most ${MAX_TABS} tabs per panel`);
    const list = [...tabs.slice(0, ti + 1), at, ...tabs.slice(ti + 1)];
    applyTabs(list, ti + 1, at.node !== node || at.path !== path);
  };
  const selectTab = (i: number) => i !== ti && applyTabs(tabs, i, true);
  const closeTab = (i: number) => {
    if (tabs.length < 2) return;
    const list = tabs.filter((_, k) => k !== i);
    const idx = i < ti ? ti - 1 : i === ti ? Math.min(i, list.length - 1) : ti;
    applyTabs(list, idx, i === ti);
  };
  const moveTab = (from: number, to: number) => {
    if (from === to || to < 0 || to >= tabs.length) return;
    const list = tabs.slice();
    const [m] = list.splice(from, 1);
    list.splice(to, 0, m!);
    const idx = ti === from ? to : from < ti && to >= ti ? ti - 1 : from > ti && to <= ti ? ti + 1 : ti;
    applyTabs(list, idx, false);
  };
  const tabLabel = (t: Loc) => (t.path === "/" ? t.node + ":/" : t.path.slice(t.path.lastIndexOf("/") + 1));
  const tabMenu = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      { label: "Duplicate tab", onSelect: () => { if (tabs.length >= MAX_TABS) return onStatus(`At most ${MAX_TABS} tabs per panel`); applyTabs([...tabs.slice(0, i + 1), tabs[i]!, ...tabs.slice(i + 1)], ti > i ? ti + 1 : ti, false); } },
      { label: "Move left", disabled: i === 0, onSelect: () => moveTab(i, i - 1) },
      { label: "Move right", disabled: i === tabs.length - 1, onSelect: () => moveTab(i, i + 1) },
      "sep",
      { label: "Close tab", hint: "Alt+W", disabled: tabs.length < 2, onSelect: () => closeTab(i) },
      { label: "Close other tabs", disabled: tabs.length < 2, onSelect: () => applyTabs([tabs[i]!], 0, i !== ti) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const toggleMark = (l: Loc) => {
    onStatus(isBookmarked(marks, l) ? `Removed bookmark ${l.node}:${l.path}` : `Bookmarked ${l.node}:${l.path}`);
    toggleBookmark(l);
  };

  // Shared by the list rows and the grid tiles: selection, open, context menu, drag and drop.
  const itemProps = (en: Entry, isDir: boolean, cls: string) => ({
    "data-path": en.path,
    className: cls + (sel.has(en.path) ? "sel " : "") + (cursor === en.path ? "cur " : "") + (over === en.path ? "drop" : ""),
    draggable: true,
    onClick: (e: React.MouseEvent) => click(e, en),
    onDoubleClick: () => open(en),
    onAuxClick: isDir ? (e: React.MouseEvent) => e.button === 1 && (e.preventDefault(), newTab({ node, path: en.path })) : undefined,
    onContextMenu: (e: React.MouseEvent) => {
      onFocus();
      const inSel = sel.has(en.path);
      const picked = inSel ? entries.filter((x) => sel.has(x.path)) : [en];
      if (!inSel) {
        onClearOthers();
        setSel(new Set([en.path]));
        setAnchor(en.path);
      }
      showMenu(e, rowItems(picked, inSel ? others : []));
    },
    onDragStart: (e: React.DragEvent) => {
      const paths = sel.has(en.path) ? selected() : [en.path];
      if (!sel.has(en.path)) (onClearOthers(), setSel(new Set([en.path])));
      setDrag(e, { node, paths });
    },
    onDragOver: isDir ? (e: React.DragEvent) => dragOver(e, en.path) : undefined,
    onDrop: isDir ? (e: React.DragEvent) => drop(e, en.path) : undefined,
  });
  const nameEditor = (en: Entry) =>
    renaming === en.path ? (
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
    );
  const searchView = leaf.sr ? (
    <SearchView node={node} dir={path} hidden={hidden} form={leaf.sr} onForm={setSearch} onClose={() => (setSearch(undefined), setTimeout(() => secRef.current?.focus(), 0))} onReveal={revealHit} onOpen={openHit} onStatus={onStatus} />
  ) : null;
  const listing = cside && cmpCtl ? <CompareBody ctl={cmpCtl} side={cside} /> : searchView ?? (
      <div
        className="fp-scroll"
        tabIndex={0}
        role="group"
        aria-label={`Files in ${path} on ${node}. Arrow keys select, Enter opens.`}
        onFocus={(e) => {
          // Tabbing into the list selects the first entry so the arrow keys have somewhere to start. A mouse click
          // also focuses the list but must not: selecting (and scrolling to) the first row between mousedown and
          // mouseup made clicks on rows further down land elsewhere. :focus-visible is true for keyboard focus only.
          if (e.target === e.currentTarget && sel.size === 0 && visible[0] && e.currentTarget.matches(":focus-visible")) selectOnly(visible[0].path);
        }}
        onClick={(e) => e.target === e.currentTarget && (onClearOthers(), setSel(new Set()))}
        onContextMenu={(e) => {
          onFocus();
          onClearOthers();
          setSel(new Set());
          showMenu(e, folderItems(path, true));
        }}
      >
        {view === "grid" ? (
          <div className="fp-grid" role="listbox" aria-label="Files" aria-multiselectable="true">
            {visible.map((en) => {
              const isDir = !!(en.type === "dir" || en.linkDir);
              return (
                <div key={en.path} role="option" aria-selected={sel.has(en.path)} {...itemProps(en, isDir, "tile ")}>
                  <Thumb node={node} entry={en} isDir={isDir} />
                  <Tip label={en.name} fill><div className="tile-name">{nameEditor(en)}</div></Tip>
                </div>
              );
            })}
          </div>
        ) : (
        <table className="ft">
          <thead>
            <tr>{th("name", "Name")}{th("size", "Size")}{th("mtime", "Modified")}</tr>
          </thead>
          <tbody>
            {visible.map((en) => {
              const isDir = !!(en.type === "dir" || en.linkDir);
              return (
                <tr key={en.path} {...itemProps(en, isDir, "")}>
                  <td className="name">
                    <FileIcon className="ico" dir={isDir} type={en.type} />
                    {nameEditor(en)}
                    {en.type === "symlink" && (
                      <Tip label={en.broken ? `Broken link: ${en.target ?? ""} does not exist` : `Link to ${en.target ?? ""}`}>
                        <span className={"ln-target" + (en.broken ? " broken" : "")}>
                          {en.broken && <span className="visually-hidden">Broken link </span>}
                          <ArrowRight /> {en.target}
                        </span>
                      </Tip>
                    )}
                  </td>
                  <td className="num">{isDir ? "" : fmtSize(en.size)}</td>
                  <td className="num">{fmtDate(en.mtime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {!entries.length && !err && <div className="muted pad">Empty folder. Drop files here to upload.</div>}
        {entries.length > 0 && !visible.length && <div className="muted pad">No entries match the filter.</div>}
      </div>
  );
  // ---- keyboard ----
  const selectOnly = (p: string) => {
    onClearOthers();
    setSel(new Set([p]));
    setAnchor(p);
    setCursor(p);
  };
  useEffect(() => {
    if (!cursor) return;
    secRef.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useEffect(() => {
    const p = scrollTo.current;
    if (!p || !entries.some((e) => e.path === p)) return;
    scrollTo.current = null;
    setTimeout(() => secRef.current?.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "center" }), 0);
  }, [entries]);
  const toOther = (op: "copy" | "move") => {
    if (!next) return onStatus("Open a second panel first (split button)");
    const refs = combine(selEntries);
    if (!refs.length) return;
    void transferOp(op, refs, next.node, next.path);
  };
  function onKeyDown(e: React.KeyboardEvent) {
    if (menu || modal || dialog) return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea,select,[contenteditable=true],.monaco-editor")) return;
    if (t.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    if (cside && cmpCtl && e.key !== "Tab" && !(e.altKey && e.key !== "ArrowUp")) {
      if (compareKey(cmpCtl, cside, e)) (e.preventDefault(), e.stopPropagation());
      return;
    }
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
      if (e.altKey && e.shiftKey && !mod && key.startsWith("Arrow") && onDock) return onDock(key);
      // While the search results are open the panel's own selection is hidden: no file operations by key.
      if (leaf.sr && !(key === "Tab" || key === "?" || (e.altKey && !mod && "twTW[]".includes(key)) || (mod && e.shiftKey && key.toLowerCase() === "f"))) return false;
      if (key === "?" && !mod) return onHelp(), true;
      if (e.altKey && !mod && key.toLowerCase() === "t") return newTab(), true;
      if (e.altKey && !mod && key.toLowerCase() === "w") return tabs.length > 1 && (closeTab(ti), true);
      if (e.altKey && !mod && (key === "]" || key === "[") && tabs.length > 1) return selectTab((ti + (key === "]" ? 1 : -1) + tabs.length) % tabs.length), true;
      // Tab hops between panels only from the list itself, and never wraps: otherwise it would be a keyboard trap.
      if (key === "Tab" && !mod && !e.altKey && (e.target === e.currentTarget || !!(e.target as HTMLElement).closest(".fp-scroll"))) return onSwitch(e.shiftKey ? -1 : 1);
      if (mod && e.shiftKey && key.toLowerCase() === "f") return setSearch(leaf.sr ?? EMPTY_SEARCH), true;
      if (mod && key.toLowerCase() === "f") {
        if (filterInput.current) {
          filterInput.current.focus();
          filterInput.current.select();
        } else setFilterOpen(true); // the input autofocuses when it mounts
        return true;
      }
      if (mod && key.toLowerCase() === "a") return !hasText && (setSel(new Set(visible.map((x) => x.path))), true);
      if (mod && key.toLowerCase() === "c") return !hasText && combine(selEntries).length > 0 && (setClipboard("copy", selEntries), true);
      if (mod && key.toLowerCase() === "x") return combine(selEntries).length > 0 && (setClipboard("cut", selEntries), true);
      if (mod && key.toLowerCase() === "v") return !!getClip() && (void paste(path), true);
      // Grid: left/right step one tile, up/down one row (columns measured from the layout).
      const cols = (() => {
        if (view !== "grid") return 1;
        const tiles = Array.from(secRef.current?.querySelectorAll<HTMLElement>(".tile") ?? []);
        const top = tiles[0]?.offsetTop;
        return Math.max(1, tiles.findIndex((t) => t.offsetTop !== top) < 0 ? tiles.length : tiles.findIndex((t) => t.offsetTop !== top));
      })();
      if (view === "grid" && key === "ArrowRight") return moveTo(idx + 1), true;
      if (view === "grid" && key === "ArrowLeft") return moveTo(idx < 0 ? 0 : idx - 1), true;
      if (key === "ArrowDown") return moveTo(idx + cols), true;
      if (key === "ArrowUp") return moveTo(idx < 0 ? 0 : idx - cols), true;
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
        const refs = combine(selEntries);
        if (!refs.length) return false;
        if (e.shiftKey) setModal({ k: "del", refs });
        else void trashEntries(selEntries);
        return true;
      }
      if (key === "Escape") {
        if (filter || filterOpen) return onPatch({ q: undefined }), setFilterOpen(false), true;
        if (others.length) onClearOthers();
        return (sel.size > 0 || others.length > 0) && (setSel(new Set()), true);
      }
      if (key === "ContextMenu" || (e.shiftKey && key === "F10")) {
        const row = cursor ? secRef.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`) : null;
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
      className={"fp" + (active ? " active" : "") + (panelPicked ? " picked" : "") + (over === "." ? " drop" : "")}
      onMouseDown={(e) => {
        onFocus();
        // .ed = the editor/diff overlay rendered inside this panel: taking focus there would steal it from Monaco
        if (!(e.target as Element).closest("input,button,select,textarea,a,[role=menu],.ed")) secRef.current?.focus({ preventScroll: true });
      }}
      onDragOver={(e) => dragOver(e, ".")}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => drop(e, path)}
    >
      {tabs.length > 1 && !cside && (
        <div className="fp-tabs" role="tablist" aria-label="Tabs">
          {tabs.map((t, i) => (
            <Tip key={i} label={`${t.node}:${t.path}`}>
            <div
              role="tab"
              aria-selected={i === ti}
              tabIndex={-1}
              className={"fp-tab" + (i === ti ? " on" : "") + (tabDrag === i ? " dragging" : "")}
              draggable
              onClick={() => selectTab(i)}
              onAuxClick={(e) => e.button === 1 && (e.preventDefault(), closeTab(i))}
              onContextMenu={(e) => tabMenu(e, i)}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-filedeck-tab", String(i));
                e.dataTransfer.effectAllowed = "move";
                setTabDrag(i);
              }}
              onDragEnd={() => setTabDrag(null)}
              onDragOver={(e) => {
                if (tabDrag === null) return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                if (tabDrag === null) return;
                e.preventDefault();
                e.stopPropagation();
                moveTab(tabDrag, i);
                setTabDrag(null);
              }}
            >
              <span className="fp-tab-name">{tabLabel(t)}</span>
              <button type="button" className="fp-tab-x" aria-label={`Close tab ${tabLabel(t)}`} onClick={(e) => (e.stopPropagation(), closeTab(i))}><X /></button>
            </div>
            </Tip>
          ))}
          <Tip label="New tab" shortcut="Alt+T"><button type="button" className="fp-tab-new" aria-label="New tab" onClick={() => newTab()}><Plus /></button></Tip>
        </div>
      )}
      <header
        className="fp-bar"
        {...dragProps}
        onClick={(e) => {
          // Shift/Ctrl/Cmd+click on the header picks the whole panel (e.g. two panels to compare).
          if ((e.shiftKey || e.ctrlKey || e.metaKey) && !(e.target as Element).closest("button,input,select,label,a")) {
            e.preventDefault();
            onFocus();
            onTogglePanel();
          }
        }}
      >
        <AddressBar node={node} path={path} active={active} hidden={hidden} onGo={goTo} onCrumbMenu={(e, p) => showMenu(e, folderItems(p, false))} />
        <div className="fp-actions" onWheel={wheelX}>
          <Tip label="Pick this panel (also Shift/Ctrl+click its header), e.g. to compare two panels"><button aria-label="Pick this panel" aria-pressed={panelPicked} className={panelPicked ? "marked" : ""} onClick={onTogglePanel}><SquareCheck /></button></Tip>
          <Tip label="Search under this folder" shortcut="Ctrl+Shift+F"><button aria-label="Search under this folder" className={leaf.sr ? "marked" : ""} aria-pressed={!!leaf.sr} onClick={() => setSearch(leaf.sr ? undefined : EMPTY_SEARCH)}><Search /></button></Tip>
          <Tip label={view === "grid" ? "Switch to the list view" : "Switch to the thumbnail grid"}><button aria-label={view === "grid" ? "Switch to the list view" : "Switch to the thumbnail grid"} aria-pressed={view === "grid"} className={view === "grid" ? "marked" : ""} onClick={() => onPatch({ w: view === "grid" ? undefined : "g" })}>{view === "grid" ? <List /> : <LayoutGrid />}</button></Tip>
          {view === "grid" && (
            <select className="fp-sort" aria-label="Sort" value={sort.key + ":" + (sort.asc ? "a" : "d")} onChange={(e) => { const [key, d] = e.target.value.split(":"); setSort(() => ({ key: key as SortKey, asc: d === "a" })); }}>
              <option value="name:a">Name A-Z</option><option value="name:d">Name Z-A</option>
              <option value="mtime:d">Newest first</option><option value="mtime:a">Oldest first</option>
              <option value="size:d">Largest first</option><option value="size:a">Smallest first</option>
            </select>
          )}
          <Tip label={isBookmarked(marks, here) ? "Remove this folder from the bookmarks" : "Bookmark this folder"}><button aria-label={isBookmarked(marks, here) ? "Remove this folder from the bookmarks" : "Bookmark this folder"} aria-pressed={isBookmarked(marks, here)} className={isBookmarked(marks, here) ? "marked" : ""} onClick={() => toggleMark(here)}><Star fill={isBookmarked(marks, here) ? "currentColor" : "none"} /></button></Tip>
          <Tip label="New tab with this folder" shortcut="Alt+T"><button aria-label="New tab with this folder" onClick={() => newTab()}><SquarePlus /></button></Tip>
          <Tip label="Up one folder"><button aria-label="Up one folder" disabled={path === "/"} onClick={() => onNavigate(node, parent(path))}><ArrowUp /></button></Tip>
          <Tip label="New folder"><button aria-label="New folder" onClick={() => setModal({ k: "new", dir: path, type: "folder" })}><FolderPlus /></button></Tip>
          <Tip label="New file"><button aria-label="New file" onClick={() => setModal({ k: "new", dir: path, type: "file" })}><FilePlus /></button></Tip>
          <Tip label="Upload"><button aria-label="Upload" onClick={() => fileInput.current?.click()}><Upload /></button></Tip>
          <Tip label="Rename" shortcut="F2"><button aria-label="Rename" disabled={sel.size !== 1} onClick={() => setRenaming([...sel][0] ?? null)}><Pencil /></button></Tip>
          <Tip label="Edit in the editor"><button aria-label="Edit in the editor" disabled={!selEntries.length || selEntries.length !== 1 || !selEntries.every(canEdit)} onClick={() => selEntries[0] && setEditing({ node, path: selEntries[0].path })}><FilePen /></button></Tip>
          <Tip label={diffMarked ? "Diff against the marked file" : "Diff: select two files, or mark one then pick another"}>
            <button
              aria-label="Diff files"
              className={diffMarked ? "marked" : ""}
              disabled={!combine(selEntries).length || combine(selEntries).length > 2 || !combine(selEntries).every((r) => r.editable)}
              onClick={() => onDiff(combine(selEntries).map((r) => ({ node: r.node, path: r.path })))}
            ><Diff /></button>
          </Tip>
          <Tip label={cside ? "Exit compare mode" : "Compare this panel with another panel, in place"}>
            <button
              aria-label={cside ? "Exit compare mode" : "Compare with another panel"}
              aria-pressed={!!cside}
              className={cside ? "marked" : ""}
              onClick={(e) => {
                if (cside && cmpCtl) return cmpCtl.exit();
                if (!peers.length) return onStatus("Open a second panel first (split button)");
                const pickedPeers = peers.filter((p) => p.picked);
                if (panelPicked && pickedPeers.length === 1) return onCompare(pickedPeers[0]!.id);
                if (peers.length === 1) return onCompare(peers[0]!.id);
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 2, items: peers.map((pr): MenuItem => ({ label: `Compare with ${peerLabel(pr)}`, onSelect: () => onCompare(pr.id) })) });
              }}
            ><GitCompareArrows /></button>
          </Tip>
          <Tip label="Download (several items or folders as a zip)"><button aria-label="Download" disabled={!combine(selEntries).length} onClick={() => download(selEntries)}><Download /></button></Tip>
          <Tip label="Compress selection"><button aria-label="Compress selection" disabled={!combine(selEntries).length} onClick={() => setDialog("compress")}><Archive /></button></Tip>
          <Tip label="Extract archive"><button aria-label="Extract archive" disabled={!(sel.size === 1 && entries.some((x) => x.path === [...sel][0] && x.type === "file" && isArchive(x.name)))} onClick={() => setDialog("extract")}><PackageOpen /></button></Tip>
          <Tip label="Move to trash"><button aria-label="Move to trash" disabled={!combine(selEntries).length} onClick={() => void trashEntries(selEntries)}><Trash2 /></button></Tip>
          <Tip label="Delete permanently"><button aria-label="Delete permanently" disabled={!combine(selEntries).length} onClick={() => setModal({ k: "del", refs: combine(selEntries) })}><CircleX /></button></Tip>
          <label className="chk"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
          <Tip label="Split right"><button aria-label="Split right" onClick={() => onSplit("horizontal")}><Columns2 /></button></Tip>
          <Tip label="Split down"><button aria-label="Split down" onClick={() => onSplit("vertical")}><Rows2 /></button></Tip>
          {onClose && <Tip label="Close panel"><button aria-label="Close panel" onClick={onClose}><X /></button></Tip>}
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
      {cside && cmpCtl && <CompareBar ctl={cmpCtl} side={cside} otherLabel={cside === "left" ? `${cmpCtl.st.right.node}:${cmpCtl.st.right.path}` : `${cmpCtl.st.left.node}:${cmpCtl.st.left.path}`} />}
      {filterOpen && !cside && (
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
      {modal?.k === "link" && (
        <LinkDialog
          {...(modal.existing ? { existing: { name: modal.existing.name, target: modal.existing.target ?? "" } } : {})}
          onClose={() => setModal(null)}
          onSubmit={async (name, target) => {
            const at = modal.existing ? modal.existing.path : join(modal.dir, name);
            await api.symlink(node, at, target, !!modal.existing);
            onStatus(modal.existing ? `Retargeted ${at}` : `Created link ${at}`);
            refresh();
          }}
        />
      )}
      {modal?.k === "del" && (
        <ConfirmDialog
          title="Delete permanently"
          message={`Permanently delete ${modal.refs.length === 1 ? modal.refs[0]!.name : modal.refs.length + " items"}? This cannot be undone.`}
          action="Delete permanently"
          danger
          onClose={() => setModal(null)}
          onConfirm={() => void queueOp("Delete", deleteSpec(modal.refs))}
        />
      )}
      {modal?.k === "props" && <PropertiesDialog node={node} path={modal.path} entry={modal.entry} onClose={() => setModal(null)} onChanged={refresh} onStatus={onStatus} />}
      {(dialog === "compress" || (typeof dialog === "object" && dialog?.k === "compress")) && (
        <CompressDialog groups={groupRefs(combine(selEntries, typeof dialog === "object" && dialog ? dialog.extra : others))} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
      {dialog === "extract" && [...sel][0] && (
        <ExtractDialog node={node} archive={[...sel][0]!} defaultDest={path} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
    </section>
  );
}
