import { PANEL_MIME } from "./dock";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, listStream, canEdit, onOpFinished, type OpSpec, createFile, fileUrl, fmtDate, fmtSize, isArchive, join, nodeBase, parent, zipUrl, type Entry } from "./api";
import { dropEntries, enqueueUpload, gatherDrop, pickedFromInput } from "./uploads";
import { CompressDialog, ExtractDialog } from "./ArchiveDialog";
import { getDrag, hasFiles, setDrag } from "./DragData";
import { Preview } from "./Preview";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog, LinkDialog, NameDialog } from "./Dialogs";
import { PropertiesMulti, PropertiesPanel } from "./Properties";
import { copyText, getClip, setClip, useClip } from "./clipboard";
import { deleteSpec, downloadRefs, groupRefs, refOf, trashSpec, type SelRef } from "./Selection";
import type { FileRef } from "./EditorViews";
import { SearchView } from "./Search";
import { wheelX } from "./scrollx";
import { AddressBar } from "./AddressBar";
import { CompareBar, CompareBody, ROW_H, compareKey, useCompareCtl } from "./Compare";
import { Thumb } from "./Thumb";
import { isBookmarked, toggleBookmark, useBookmarks } from "./bookmarks";
import { EMPTY_SEARCH, MAX_SELS, MAX_TABS, type Dock, type Leaf, type Loc, type SearchForm, type SortKey } from "./urlState";
import { Ellipsis, Eye, EyeOff, ArrowRight, ArrowUp, Archive, ChevronDown, ChevronUp, CircleX, Columns2, CornerLeftUp, Diff, Download, FilePen, FilePlus, FolderPlus, GitCompareArrows, LayoutGrid, List, PackageOpen, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Plus, Rows2, Search, SquarePlus, SquareCheck, Star, Trash2, Upload, X, type LucideIcon } from "lucide-react";
import { Tip } from "./Tooltip";
import { FileIcon } from "./FileIcon";
import { useSettings } from "./settings";
import { SkeletonRows, SkeletonTiles } from "./Skeleton";
import * as Ic from "lucide-react";

// Monaco (several MB) stays in its own chunk, fetched on first edit.
const TextEditor = lazy(() => import("./EditorViews").then((m) => ({ default: m.TextEditor })));

/** Rows put in the DOM at first and added per step while scrolling. */
const RENDER_STEP = 400;
const DOCKS: { dock: Dock; icon: LucideIcon; label: string }[] = [
  { dock: "left", icon: PanelLeft, label: "Dock side panel left" },
  { dock: "right", icon: PanelRight, label: "Dock side panel right" },
  { dock: "top", icon: PanelTop, label: "Dock side panel top" },
  { dock: "bottom", icon: PanelBottom, label: "Dock side panel bottom" },
];
const SORTS: { key: SortKey; name: string; ascText: string; descText: string; asc: LucideIcon; desc: LucideIcon }[] = [
  { key: "name", name: "name", ascText: "A to Z", descText: "Z to A", asc: Ic.ArrowDownAZ, desc: Ic.ArrowUpZA },
  { key: "mtime", name: "date modified", ascText: "oldest first", descText: "newest first", asc: Ic.CalendarArrowUp, desc: Ic.CalendarArrowDown },
  { key: "size", name: "size", ascText: "smallest first", descText: "largest first", asc: Ic.ArrowUpNarrowWide, desc: Ic.ArrowDownNarrowWide },
];
export type { Leaf };

interface Props {
  leaf: Leaf;
  active: boolean;
  onFocus: () => void;
  onNavigate: (node: string, path: string) => void;
  /** open node:path in a new panel beside this one, optionally with a file selected */
  onOpenPanel: (node: string, path: string, select?: string) => void;
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
  next: { node: string; path: string; id: string } | null;
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
const natural = new Intl.Collator(undefined, { numeric: true }); // shared: localeCompare with options builds a collator per call
const UP_DROP = "\0up";
const isDirEntry = (e: Entry) => e.type === "dir" || !!e.linkDir;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

export function FilePanel({ leaf, active, onFocus, onNavigate, onOpenPanel, onSplit, onClose, dragProps, onDock, onPatch, onDiff, diffMarked, onCompare, peers, others, panelPicked, clearReq, onSelection, onClearOthers, onTogglePanel, next, onSwitch, onHelp, onTrash, onStatus }: Props) {
  const { node, path } = leaf;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  /** the listing for node:path is still on its way (a refresh of a shown folder keeps its rows and is not "loading") */
  const [loading, setLoading] = useState(true);
  const listKey = useRef("");
  const { upRow } = useSettings();
  /** more entries of the open folder are still arriving */
  const [streaming, setStreaming] = useState(false);
  const sortRef = useRef<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  /** rows rendered so far: a folder with tens of thousands of entries fills the DOM in steps as it is scrolled */
  const [limit, setLimit] = useState(RENDER_STEP);
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
  sortRef.current = sort;
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(leaf.sel ?? null);
  const view = leaf.w === "g" ? "grid" : "list";
  const filter = leaf.q ?? "";
  const [filterOpen, setFilterOpen] = useState(!!leaf.q);
  const filterInput = useRef<HTMLInputElement>(null);
  const secRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [over, setOver] = useState<string | null>(null); // "." = panel itself, else folder path
  const [renaming, setRenaming] = useState<string | null>(null);
  /** New file/folder typed straight into a row at the top of the listing (no dialog). */
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
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
  /** the side panel shows the Properties tab (details of the selection, or of the folder when nothing is selected) instead of the Preview */
  const propsOpen = leaf.pv?.tab === "props";
  const setDock = (d: Dock) => onPatch({ pv: { dock: d, size: pvSize, ...(propsOpen ? { tab: "props" as const } : {}) } });
  const setTab = (tab: "props" | undefined) => onPatch({ pv: { dock: leaf.pv?.dock ?? "right", size: pvSize, ...(tab ? { tab } : {}) } });
  /** a folder named from a breadcrumb menu (not part of the selection); dropped as soon as the selection or folder changes */
  const [propsFor, setPropsFor] = useState<string | null>(null);
  const openProps = (forPath?: string) => {
    setClosedFor(null);
    setPropsFor(forPath ?? null);
    setTab("props");
  };
  const showPreview = () => {
    setClosedFor(null);
    setTab(undefined);
  };

  useEffect(() => {
    let live = true;
    const key = `${node}\0${path}\0${hidden}`;
    const fresh = listKey.current !== key;
    if (fresh) {
      // A different folder: drop the old rows so skeleton rows (not the previous folder) hold the space until the list arrives.
      listKey.current = key;
      setEntries([]);
      setLoading(true);
      setLimit(RENDER_STEP);
    }
    // A folder just opened in the default order shows its rows as they stream in (they arrive in that order, so nothing moves);
    // a refresh, or another sort order, waits for the whole listing and swaps it in at once.
    const progressive = fresh && sortRef.current.key === "name" && sortRef.current.asc;
    const got: Entry[] = [];
    let flush = 0;
    const show = () => {
      flush = 0;
      if (!live) return;
      setEntries(got.slice());
      setLoading(false);
    };
    const ctl = new AbortController();
    listStream(node, path, hidden, ctl.signal, (batch) => {
      got.push(...batch);
      if (!progressive || !live) return;
      setStreaming(true);
      if (!flush) flush = window.setTimeout(show, got.length === batch.length ? 0 : 120);
    })
      .then((r) => {
        if (!live) return;
        window.clearTimeout(flush);
        setEntries(got);
        setLoading(false);
        setStreaming(false);
        setErr(r.truncated ? "Listing truncated" : "");
        const known = new Set(got.map((e) => e.path));
        setSel((s) => new Set([...s].filter((p) => known.has(p))));
      })
      .catch((e: Error) => live && (window.clearTimeout(flush), setErr(e.message), setEntries([]), setLoading(false), setStreaming(false)));
    return () => {
      live = false;
      window.clearTimeout(flush);
      ctl.abort();
    };
  }, [node, path, hidden, tick]);

  // Live feed: refresh when the watched directory changes.
  useEffect(() => {
    const es = new EventSource(`${nodeBase(node)}/api/events?path=${encodeURIComponent(path)}`);
    // A busy folder (a temp dir, a build output) fires many change events: relist at most once per 700 ms, after the last one.
    let t = 0;
    es.addEventListener("change", () => {
      window.clearTimeout(t);
      t = window.setTimeout(refresh, 700);
    });
    return () => (window.clearTimeout(t), es.close());
  }, [node, path, refresh]);

  const sorted = useMemo(() => {
    const f = [...entries];
    const dirFirst = (e: Entry) => (e.type === "dir" || e.linkDir ? 0 : 1);
    f.sort((a, b) => {
      const d = dirFirst(a) - dirFirst(b);
      if (d) return d;
      const c = sort.key === "name" ? natural.compare(a.name, b.name) : a[sort.key] - b[sort.key];
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
  useEffect(() => setPropsFor(null), [sel, node, path]);
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
  // A request made before this panel existed (a new panel opened with a selection) is not for it.
  const seenClear = useRef(clearReq?.n);
  useEffect(() => {
    if (clearReq && clearReq.n !== seenClear.current && clearReq.except !== leaf.id) setSel((s) => (s.size ? new Set() : s));
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
  /** Drop saved archive/PDF passwords for these files or folders (and everything below them). */
  const forgetPasswords = (paths: string[]) =>
    void Promise.all(paths.map((p) => api.vaultForgetPath(node, p)))
      .then((rs) => {
        const n = rs.reduce((a, r) => a + r.removed, 0);
        onStatus(n ? `Forgot ${n} saved password(s)` : "No saved password here");
      })
      .catch((e: Error) => onStatus(e.message));
  const startCreate = (dir: string, type: "file" | "folder") => (dir === path && !cside && !leaf.sr ? setCreating(type) : setModal({ k: "new", dir, type }));
  const rowItems = (picked: Entry[], extra: SelRef[] = others): MenuItem[] => {
    const one = picked.length === 1 ? picked[0]! : undefined;
        const pasteDir = one && isDirEntry(one) ? one.path : path;
    return [
      { label: one && isDirEntry(one) ? "Open folder" : "Open", disabled: !one || extra.length > 0, hint: "Enter", onSelect: () => one && openFile(one) },
      ...(one && isDirEntry(one)
        ? ([
            { label: "Open in new panel", onSelect: () => onOpenPanel(node, one.path) },
            { label: "Open in new tab", onSelect: () => newTab({ node, path: one.path }) },
            { label: isBookmarked(marks, { node, path: one.path }) ? "Remove bookmark" : "Add to bookmarks", onSelect: () => toggleMark({ node, path: one.path }) },
          ] as MenuItem[])
        : one
          ? ([{ label: "Show in new panel", onSelect: () => onOpenPanel(node, parent(one.path), one.path) }] as MenuItem[])
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
      { label: "Forget saved password", disabled: !picked.some((x) => isDirEntry(x) || isArchive(x.name) || /\.pdf$/i.test(x.name)), onSelect: () => forgetPasswords(picked.map((x) => x.path)) },
      { label: picked.length + extra.length === 1 && one!.type === "file" ? "Download" : "Download as zip", onSelect: () => download(picked, extra) },
      "sep",
      { label: picked.length + extra.length > 1 ? "Copy paths" : "Copy path", onSelect: () => void copyPaths(combine(picked, extra).map((x) => x.path)) },
      { label: "Move to trash", hint: "Del", danger: true, onSelect: () => void trashEntries(picked, extra) },
      { label: "Delete permanently...", hint: "Shift+Del", danger: true, onSelect: () => setModal({ k: "del", refs: combine(picked, extra) }) },
      "sep",
      { label: "Properties", hint: "Alt+Enter", onSelect: () => openProps() },
    ];
  };
  /** Menu for a folder itself: empty space in the listing, or a breadcrumb. */
  const folderItems = (dir: string, here: boolean): MenuItem[] => [
    ...(here ? [] : ([{ label: "Open", onSelect: () => onNavigate(node, dir) }, { label: "Open in new panel", onSelect: () => onOpenPanel(node, dir) }, { label: "Open in new tab", onSelect: () => newTab({ node, path: dir }) }] as MenuItem[])),
    { label: isBookmarked(marks, { node, path: dir }) ? "Remove bookmark" : "Add to bookmarks", onSelect: () => toggleMark({ node, path: dir }) },
    { label: "New file...", onSelect: () => startCreate(dir, "file") },
    { label: "New folder...", onSelect: () => startCreate(dir, "folder") },
    { label: "New symbolic link...", onSelect: () => setModal({ k: "link", dir }) },
    { label: pasteLabel, hint: here ? "Ctrl+V" : undefined, disabled: !clip, onSelect: () => void paste(dir) },
    ...(here ? ([{ label: "Select all", hint: "Ctrl+A", onSelect: () => setSel(new Set(entries.map((x) => x.path))) }, { label: "Upload...", onSelect: () => fileInput.current?.click() }, { label: "Upload folder...", onSelect: () => folderInput.current?.click() }, { label: "Refresh", onSelect: refresh }] as MenuItem[]) : []),
    "sep",
    ...compareItems(),
    { label: "Copy path", onSelect: () => void copyPaths([dir]) },
    { label: "Forget saved password", onSelect: () => forgetPasswords([dir]) },
    { label: "Open trash", onSelect: () => onTrash(node) },
    "sep",
    { label: "Properties", hint: here ? "Alt+Enter" : undefined, onSelect: () => openProps(here ? undefined : dir) },
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

  const closeSide = () => {
    if (editing) return setEditing(null);
    if (propsOpen) {
      // Closing Properties must not reveal the preview of a selected file: mark that one closed too.
      setClosedFor(only && !isDirEntry(only) ? only.path : null);
      setPropsFor(null);
      return setTab(undefined);
    }
    if (only) setClosedFor(only.path);
  };
  const paneExtra = (
    <span className="pv-extra">
      {!editing && (
        <span className="pv-dock pv-switch" role="group" aria-label="Side panel content">
          <Tip label={previewEntry || (only && !isDirEntry(only) && !only.broken) ? "Preview the selected file" : "Select one file to preview it"}>
            <button type="button" className={"pv-dockbtn" + (!propsOpen ? " on" : "")} aria-pressed={!propsOpen} disabled={propsOpen && !(only && !isDirEntry(only) && !only.broken)} aria-label="Preview" onClick={showPreview}><Ic.Eye /></button>
          </Tip>
          <Tip label="Properties of the selection (the folder when nothing is selected)" shortcut="Alt+Enter">
            <button type="button" className={"pv-dockbtn" + (propsOpen ? " on" : "")} aria-pressed={propsOpen} aria-label="Properties" onClick={() => openProps()}><Ic.Info /></button>
          </Tip>
        </span>
      )}
      <span className="pv-dock" role="group" aria-label="Side panel position">
        {DOCKS.map((d) => (
          <Tip key={d.dock} label={d.label}>
            <button type="button" className={"pv-dockbtn" + (dock === d.dock ? " on" : "")} aria-pressed={dock === d.dock} aria-label={d.label} onClick={() => setDock(d.dock)}>
              <d.icon />
            </button>
          </Tip>
        ))}
        <Tip label={propsOpen && !editing ? "Close properties" : "Close preview"}>
          <button
            type="button"
            className="pv-dockbtn"
            aria-label={propsOpen && !editing ? "Close properties" : "Close preview"}
            onClick={closeSide}
          >
            <X />
          </button>
        </Tip>
      </span>
    </span>
  );
  const propsKey = propsFor ?? (sel.size === 1 ? [...sel][0]! : sel.size === 0 ? path : null);
  const propsPane =
    propsKey !== null ? (
      <div className="pv">
        <div className="pv-head">
          <Tip label={propsKey}><b>{propsKey === "/" ? `${node}:/` : base(propsKey)}</b></Tip>
          <span className="muted">{propsFor ? "Folder" : sel.size === 0 ? "This folder" : "Selected"}</span>
          {paneExtra}
        </div>
        <div className="pv-body pp-body">
          <PropertiesPanel key={`${node}\0${propsKey}`} node={node} path={propsKey} {...(!propsFor && sel.size === 1 && only ? { entry: only } : {})} onChanged={refresh} onStatus={onStatus} />
        </div>
      </div>
    ) : (
      <div className="pv">
        <div className="pv-head">
          <b>{sel.size.toLocaleString()} items</b>
          <span className="muted">Selected</span>
          {paneExtra}
        </div>
        <div className="pv-body pp-body"><PropertiesMulti entries={selEntries} /></div>
      </div>
    );
  const pane = cside ? null : editing ? (
    <Suspense fallback={<div className="pad muted">Loading editor...</div>}>
      <TextEditor key={editing.node + editing.path} file={editing} inline onClose={() => setEditing(null)} onStatus={onStatus} extra={paneExtra} />
    </Suspense>
  ) : propsOpen ? (
    propsPane
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
  const createInput = creating ? (
    <input
      className="cr-input"
      autoFocus
      aria-label={creating === "file" ? "Name of the new file" : "Name of the new folder"}
      placeholder={creating === "file" ? "New file name, Enter to create" : "New folder name, Enter to create"}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => setCreating(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") return setCreating(null);
        if (e.key !== "Enter") return;
        const v = e.currentTarget.value.trim();
        if (!v || v.includes("/") || v === "." || v === "..") return setErr("Enter a plain name without slashes");
        const target = join(path, v);
        const kind = creating;
        setCreating(null);
        void run(`Create ${kind}`, () => (kind === "file" ? createFile(node, target) : api.mkdir(node, target))).then(() => scrollTo.current = target);
      }}
    />
  ) : null;
  // ---- parent-folder row (setting: "..", "Up" or hidden); not part of the entries, so never selected or counted ----
  const parentPath = path === "/" ? null : parent(path);
  const showUp = parentPath !== null && upRow !== "hidden";
  const upLabel = upRow === "up" ? "Up" : "..";
  const upDrop = {
    onDragOver: (e: React.DragEvent) => parentPath !== null && dragOver(e, UP_DROP),
    onDrop: (e: React.DragEvent) => parentPath !== null && drop(e, parentPath),
  };
  const goUp = () => {
    onFocus();
    if (parentPath !== null) onNavigate(node, parentPath);
  };
  const rowsShown = visible.length > limit ? visible.slice(0, limit) : visible;
  const remaining = visible.length - rowsShown.length;
  const moreEl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = moreEl.current;
    if (!el || remaining <= 0 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((ents) => ents.some((x) => x.isIntersecting) && setLimit((l) => l + RENDER_STEP * 2), { root: el.closest(".fp-scroll"), rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [remaining > 0, limit, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // The cursor (keyboard End/PageDown, a revealed hit) may be past the rows rendered so far.
  useEffect(() => {
    if (!cursor) return;
    const i = visible.findIndex((x) => x.path === cursor);
    if (i >= limit) setLimit(i + RENDER_STEP);
  }, [cursor, visible, limit]);
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
          <div className="fp-grid" role="listbox" aria-label="Files" aria-multiselectable="true" aria-busy={loading}>
            {showUp && (
              <div className={"tile up" + (over === UP_DROP ? " drop" : "")} onClick={goUp} {...upDrop}>
                <div className="tile-img"><span className="tile-ico"><CornerLeftUp /></span></div>
                <div className="tile-name"><button type="button" className="up-btn" aria-label={`Up one folder to ${parentPath}`}>{upLabel}</button></div>
              </div>
            )}
            {loading && <SkeletonTiles />}
            {createInput && (
              <div className="tile creating">
                <div className="tile-img"><span className="tile-ico">{creating === "file" ? <Ic.FilePlus /> : <Ic.FolderPlus />}</span></div>
                <div className="tile-name">{createInput}</div>
              </div>
            )}
            {rowsShown.map((en) => {
              const isDir = !!(en.type === "dir" || en.linkDir);
              return (
                <div key={en.path} role="option" aria-selected={sel.has(en.path)} {...itemProps(en, isDir, "tile ")}>
                  <Thumb node={node} entry={en} isDir={isDir} />
                  <Tip label={en.name} fill><div className="tile-name">{nameEditor(en)}</div></Tip>
                </div>
              );
            })}
            {remaining > 0 && <div ref={(el) => void (moreEl.current = el)} className="more-tiles" aria-hidden="true" />}
          </div>
        ) : (
        <table className="ft" aria-busy={loading}>
          <thead>
            <tr>{th("name", "Name")}{th("size", "Size")}{th("mtime", "Modified")}</tr>
          </thead>
          <tbody>
            {showUp && (
              <tr className={"up" + (over === UP_DROP ? " drop" : "")} onClick={goUp} {...upDrop}>
                <td className="name">
                  <div className="fl">
                    <CornerLeftUp className="ico" />
                    <button type="button" className="up-btn" aria-label={`Up one folder to ${parentPath}`}>{upLabel}</button>
                  </div>
                </td>
                <td className="num" />
                <td className="num" />
              </tr>
            )}
            {loading && <SkeletonRows />}
            {createInput && (
              <tr className="creating">
                <td className="name" colSpan={3}>
                  <div className="cr">{creating === "file" ? <Ic.FilePlus className="ico" /> : <Ic.FolderPlus className="ico" />}{createInput}</div>
                </td>
              </tr>
            )}
            {rowsShown.map((en) => {
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
            {remaining > 0 && (
              <tr ref={(el) => void (moreEl.current = el)} className="more" aria-hidden="true" style={{ height: remaining * ROW_H }}>
                <td colSpan={3} />
              </tr>
            )}
          </tbody>
        </table>
        )}
        {streaming && <div className="muted pad fp-streaming" role="status">Loading entries... {entries.length.toLocaleString()} so far</div>}
        {!loading && !entries.length && !err && !creating && <div className="muted pad">Empty folder. Drop files here to upload.</div>}
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
    const at = visible.findIndex((e) => e.path === p);
    if (at >= limit) return setLimit(at + RENDER_STEP); // render the target first; this effect runs again
    scrollTo.current = null;
    setTimeout(() => secRef.current?.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "center" }), 0);
  }, [entries, limit]); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (leaf.sr && !(key === "Tab" || key === "?" || (e.altKey && !mod && "twTW[]nurcNURC".includes(key)) || (mod && e.shiftKey && key.toLowerCase() === "f"))) return false;
      if (key === "?" && !mod) return onHelp(), true;
      if (e.altKey && !mod && key.toLowerCase() === "t") return newTab(), true;
      // Folder actions that used to live only in the header "more" menu (also in the right-click menu of the list and the breadcrumb).
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "n") return startCreate(path, "file"), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "u") return fileInput.current?.click(), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "r") return refresh(), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "c") return void copyPaths([path]), true;
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
      if (key === "Enter" && e.altKey && !mod) return (propsOpen && !editing ? closeSide() : openProps()), true;
      if (key === "Enter" && !mod) {
        const en = visible[idx];
        return !!en && (open(en), true);
      }
      if (key === "Backspace" || (e.altKey && key === "ArrowUp")) return path !== "/" && (onNavigate(node, parent(path)), true);
      if (key === "F2") return selEntries.length === 1 && (setRenaming(selEntries[0]!.path), true);
      if (key === "F4") return selEntries.length === 1 && canEdit(selEntries[0]!) && (setEditing({ node, path: selEntries[0]!.path }), true);
      if (key === "F5") return toOther("copy"), true;
      if (key === "F6") return toOther("move"), true;
      if (key === "F7") return startCreate(path, "folder"), true;
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
  // ---- panel controls, one row with the address bar: what does not fit moves into the "more" menu ----
  type Ctl = { id: string; label: string; icon: React.ReactNode; pressed?: boolean; disabled?: boolean; run: () => void; ctx?: (e: React.MouseEvent) => void };
  const marked = isBookmarked(marks, here);
  const compareRun = () => {
    if (cside && cmpCtl) return cmpCtl.exit();
    if (!peers.length) return onStatus("Open a second panel first (split button)");
    const pickedPeers = peers.filter((p) => p.picked);
    if (panelPicked && pickedPeers.length === 1) return onCompare(pickedPeers[0]!.id);
    onCompare(next?.id ?? peers[0]!.id);
  };
  const controls: Ctl[] = [
    { id: "view", label: view === "grid" ? "Switch to the list view" : "Switch to the thumbnail grid", icon: view === "grid" ? <List /> : <LayoutGrid />, pressed: view === "grid", run: () => onPatch({ w: view === "grid" ? undefined : "g" }) },
    ...(view === "grid"
      ? SORTS.map((s): Ctl => {
          const on = sort.key === s.key;
          const Icon = on && !sort.asc ? s.desc : s.asc;
          return { id: "sort-" + s.key, label: `Sort by ${s.name}${on ? `, ${sort.asc ? s.ascText : s.descText} (click to reverse)` : ""}`, icon: <Icon />, pressed: on, run: () => setSort((c) => ({ key: s.key, asc: c.key === s.key ? !c.asc : s.key === "name" })) };
        })
      : []),
    { id: "search", label: "Search under this folder (Ctrl+Shift+F)", icon: <Search />, pressed: !!leaf.sr, run: () => setSearch(leaf.sr ? undefined : EMPTY_SEARCH) },
    { id: "hidden", label: hidden ? "Hide hidden files" : "Show hidden files", icon: hidden ? <Eye /> : <EyeOff />, pressed: hidden, run: () => setHidden(!hidden) },
    { id: "props", label: "Properties in the side panel (Alt+Enter)", icon: <Ic.Info />, pressed: propsOpen && !editing, run: () => (propsOpen && !editing ? closeSide() : openProps()) },
    {
      id: "compare",
      label: cside ? "Exit compare mode" : "Compare with another panel (right-click to choose which)",
      icon: <GitCompareArrows />,
      pressed: !!cside,
      run: compareRun,
      ctx: (e) => {
        if (cside || !peers.length) return;
        showMenu(e, peers.map((pr): MenuItem => ({ label: `Compare with ${peerLabel(pr)}`, onSelect: () => onCompare(pr.id) })));
      },
    },
    { id: "mark", label: marked ? "Remove this folder from the bookmarks" : "Bookmark this folder", icon: <Star fill={marked ? "currentColor" : "none"} />, pressed: marked, run: () => toggleMark(here) },
    { id: "tab", label: "New tab with this folder (Alt+T)", icon: <SquarePlus />, run: () => newTab() },
    { id: "pick", label: "Pick this panel (also Shift/Ctrl+click its header), e.g. to compare two panels", icon: <SquareCheck />, pressed: panelPicked, run: onTogglePanel },
    { id: "splitH", label: "Split right", icon: <Columns2 />, run: () => onSplit("horizontal") },
    { id: "splitV", label: "Split down", icon: <Rows2 />, run: () => onSplit("vertical") },
    ...(onClose ? [{ id: "close", label: "Close panel", icon: <X />, run: () => onClose() } as Ctl] : []),
  ];
  const [cap, setCap] = useState(99);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    // room = row width - paddings - up button - the address bar's minimum; one icon button is 28px plus a 4px gap.
    // The more button (one more slot) exists only when not everything fits.
    const measure = () => {
      const room = el.clientWidth - 21 - 32 - 190;
      setCap(controls.length * 32 <= room ? controls.length : Math.max(0, Math.floor((room - 32) / 32)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [controls.length]);
  const shown = controls.slice(0, cap);
  const more = controls.slice(cap);

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
        ref={barRef}
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
        <Tip label="Up one folder" shortcut="Backspace"><button type="button" className="fp-up" aria-label="Up one folder" disabled={path === "/"} onClick={() => onNavigate(node, parent(path))}><ArrowUp /></button></Tip>
        <AddressBar node={node} path={path} active={active} hidden={hidden} onGo={goTo} onCrumbMenu={(e, p) => showMenu(e, folderItems(p, false))} />
        <div className="fp-actions">
          {shown.map((c) => (
            <Tip key={c.id} label={c.label}>
              <button type="button" aria-label={c.label} aria-pressed={c.pressed} className={c.pressed ? "marked" : ""} disabled={c.disabled} onClick={c.run} onContextMenu={c.ctx}>{c.icon}</button>
            </Tip>
          ))}
          {more.length > 0 && (
            <Tip label="More actions">
              <button type="button" aria-label="More actions" aria-haspopup="menu" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.right - 4, y: r.bottom + 4, items: [...more.map((c): MenuItem => ({ label: c.label, disabled: c.disabled, onSelect: c.run })), "sep", ...folderItems(path, true)] });
              }}><Ellipsis /></button>
            </Tip>
          )}
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
          onLayoutChanged={(l) => { const v = l.pv; if (typeof v === "number" && v >= 10 && v <= 90 && Math.abs(v - pvSize) > 0.5) onPatch({ pv: { dock, size: v, ...(propsOpen ? { tab: "props" as const } : {}) } }); }}>
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
      {(dialog === "compress" || (typeof dialog === "object" && dialog?.k === "compress")) && (
        <CompressDialog groups={groupRefs(combine(selEntries, typeof dialog === "object" && dialog ? dialog.extra : others))} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
      {dialog === "extract" && [...sel][0] && (
        <ExtractDialog node={node} archive={[...sel][0]!} defaultDest={path} onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
    </section>
  );
}
