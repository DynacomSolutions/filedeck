import { PANEL_MIME } from "./dock";
import { Dropdown } from "./Dropdown";
import { Suspense, lazy, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, listStream, canEdit, onOpFinished, type OpSpec, createFile, fileUrl, isArchive, join, nodeBase, parent, zipUrl, type Entry } from "./api";
import { dropEntries, enqueueUpload, gatherDrop, pickedFromInput } from "./uploads";
import { CompressDialog, ExtractDialog } from "./ArchiveDialog";
import { getDrag, hasFiles, setDrag } from "./DragData";
import { Preview } from "./Preview";
import { isPreviewableEntry, sidePaneToggles, sidePaneView } from "./sidePane";
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
import { ColGroup, FillCell, HeaderRow, cellCount, dataCell, tableStyle, useColumns } from "./Columns";
import { gitApi, type GitListing } from "./git";
import { GitBadge, GitPill } from "./GitUi";
import { isBookmarked, toggleBookmark, useBookmarks } from "./bookmarks";
import { EMPTY_SEARCH, MAX_SELS, encodeState, type Dock, type Leaf, type Loc, type SearchForm, type SortKey } from "./urlState";
import type { ClickKind } from "./panelSelection";
import { ClipboardPaste, Copy, CopyPlus, FolderUp, Link2, ListChecks, RefreshCw, Ellipsis, Eye, EyeOff, ArrowLeft, ArrowRight, ArrowUp, Archive, ChevronDown, ChevronUp, CircleX, Columns2, CornerLeftUp, Diff, Download, FilePen, FilePlus, FolderPlus, GitBranch, GripVertical, LayoutGrid, List, PackageOpen, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Rows2, Search, SquareCheck, Star, Trash2, Upload, X, type LucideIcon } from "lucide-react";
import { Tip } from "./Tooltip";
import { FileIcon } from "./FileIcon";
import { resolvePanelPreferences, setSettings, useSettings } from "./settings";
import { SkeletonRows, SkeletonTiles } from "./Skeleton";
import { TransferDestination, type TransferKind } from "./TransferDestination";
import { usePresentation } from "./presentation";
import { typeAheadMatch, type TypeAheadState } from "./letterNavigation";
import * as Ic from "lucide-react";

// Monaco (several MB) stays in its own chunk, fetched on first edit.
const TextEditor = lazy(() => import("./EditorViews").then((m) => ({ default: m.TextEditor })));
const DiffViewer = lazy(() => import("./EditorViews").then((m) => ({ default: m.DiffViewer })));

/** Rows put in the DOM at first and added per step while scrolling. */
const RENDER_STEP = 400;
const selectionEchoKey = (node: string, path: string, sel: string | null | undefined, ns: boolean | undefined, sels: readonly string[] | undefined) =>
  JSON.stringify([node, path, sel ?? null, !!ns, sels ? [...sels].sort() : []]);
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
  /** HTML5 drag props for the panel's drag handle (the drag image is the whole panel) */
  dragProps?: React.HTMLAttributes<HTMLElement>;
  /** Alt+Shift+Arrow: dock this panel beside its neighbour */
  onDock?: (key: string) => boolean;
  /** non-navigation state (selection, sort, preview dock...) mirrored into the URL */
  onPatch: (p: Partial<Leaf>) => void;
  /** Two selected files diff directly; one selected file is marked, then paired with the next. */
  onDiff: (files: { node: string; path: string }[]) => void;
  /** open the diff editor with the file at HEAD on the left and the file itself on the right */
  onDiffHead?: (node: string, path: string) => void;
  diffMarked: boolean;
  /** Compare this panel with another one in place (both panels switch to compare mode). */
  onCompare: (peerId: string) => void;
  /** the other panels, for "diff with..." / "compare with..." menu entries */
  peers: { id: string; node: string; path: string; sel?: string; picked?: boolean }[];
  /** items selected in the other panels: Shift/Ctrl+click adds to them, a plain click drops them from the action selection (their active items stay), and actions here run on the lot */
  others: SelRef[];
  /** this panel is one of the selected panels (Ctrl/Cmd+click on its items, Alt+P, or Shift/Ctrl+click on its toolbar) */
  panelPicked: boolean;
  /** a plain selection elsewhere asks every other panel to drop its items from the action selection (each keeps its own active item) */
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
  /** Ctrl/Cmd+click (toggle) or Shift+click (range) on an item: the selected panels follow */
  onClickSelect: (kind: ClickKind, stillSelectedHere: boolean) => void;
  onStatus: (msg: string) => void;
}

type Modal =
  | { k: "link"; dir: string; existing?: Entry }
  | { k: "new"; dir: string; type: "file" | "folder" }
  | { k: "transfer"; kind: TransferKind; refs: SelRef[] }
  | { k: "del"; refs: SelRef[] }
const natural = new Intl.Collator(undefined, { numeric: true }); // shared: localeCompare with options builds a collator per call
const UP_DROP = "\0up";
const isDirEntry = (e: Entry) => e.type === "dir" || !!e.linkDir;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

export function FilePanel({ leaf, active, onFocus, onNavigate, onOpenPanel, onSplit, onClose, dragProps, onDock, onPatch, onDiff, onDiffHead, diffMarked, onCompare, peers, others, panelPicked, clearReq, onSelection, onClearOthers, onTogglePanel, onClickSelect, next, onSwitch, onHelp, onTrash, onStatus }: Props) {
  const { node, path } = leaf;
  const presentation = usePresentation();
  const estimatedFileRowHeight = Math.max(ROW_H, Math.ceil(presentation.fontSize * presentation.lineHeight + 17));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  /** the listing for node:path is still on its way (a refresh of a shown folder keeps its rows and is not "loading") */
  const [loading, setLoading] = useState(true);
  const listKey = useRef("");
  /** Git state of the open folder (work-item): fetched after the listing has painted, never part of it */
  const [git, setGit] = useState<GitListing | null>(null);
  const settings = useSettings();
  const { upRow } = settings;
  const preferences = resolvePanelPreferences(settings, leaf);
  /** more entries of the open folder are still arriving */
  const [streaming, setStreaming] = useState(false);
  const sortRef = useRef<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  /** rows rendered so far: a folder with tens of thousands of entries fills the DOM in steps as it is scrolled */
  const [limit, setLimit] = useState(RENDER_STEP);
  const hidden = preferences.hidden;
  const sort = preferences.sort;
  const [sel, setSel] = useState<Set<string>>(() => new Set(leaf.sels ?? (leaf.sel && !leaf.ns ? [leaf.sel] : [])));
  const setHidden = (h: boolean) => {
    setSettings({ showHidden: h });
    onPatch({ hidden: h });
  };
  const setSort = (fn: (s: { key: SortKey; asc: boolean }) => { key: SortKey; asc: boolean }) => {
    const n = fn(sort);
    setSettings({ sort: n });
    onPatch({ sort: n });
  };
  sortRef.current = sort;
  const [anchor, setAnchor] = useState<string | null>(null);
  /** the panel's ACTIVE item: drives its preview/properties and is never touched by actions in other panels (the action selection is `sel`) */
  const [cursor, setCursor] = useState<string | null>(leaf.sel ?? null);
  const createErrorId = useId();
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const selRef = useRef(sel);
  selRef.current = sel;
  /** Selection patches can arrive back through the URL after a newer keyboard event. */
  const pendingSelectionEchoes = useRef<string[]>([]);
  // Browser history restores a new URL-backed leaf into the mounted panel.
  // Keep the panel's local interaction state in step with that restored state.
  useEffect(() => {
    pendingSelectionEchoes.current = [];
  }, [node, path]);
  useEffect(() => {
    const incoming = selectionEchoKey(node, path, leaf.sel, leaf.ns, leaf.sels);
    const echo = pendingSelectionEchoes.current.indexOf(incoming);
    if (echo >= 0) {
      pendingSelectionEchoes.current.splice(0, echo + 1);
      return;
    }
    const next = new Set(leaf.sels ?? (leaf.sel && !leaf.ns ? [leaf.sel] : []));
    setSel((current) => current.size === next.size && [...next].every((path) => current.has(path)) ? current : next);
    setCursor((current) => current === (leaf.sel ?? null) ? current : leaf.sel ?? null);
    setAnchor(leaf.sel ?? null);
  }, [leaf.sel, leaf.ns, leaf.sels]);
  /** the previous listing's paths in display order, to pick the next sibling when the active item disappears */
  const orderRef = useRef<string[]>([]);
  const view = preferences.view;
  const filter = leaf.q ?? "";
  const [filterOpen, setFilterOpen] = useState(!!leaf.q);
  const filterInput = useRef<HTMLInputElement>(null);
  const secRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const focusAfterNavigation = useRef<{ node: string; path: string } | null>(null);
  const locationRef = useRef({ node, path });
  const typeAhead = useRef<TypeAheadState | null>(null);
  useEffect(() => {
    typeAhead.current = null;
  }, [node, path]);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const navigate = (n: string, p: string) => {
    if (active && (n !== node || p !== path)) focusAfterNavigation.current = { node: n, path: p };
    onNavigate(n, p);
  };
  // Browser history and parent-driven restores do not pass through a local click handler.
  // Treat a real location change as navigation, while refreshes (tick changes) leave focus alone.
  useEffect(() => {
    const previous = locationRef.current;
    if (active && (previous.node !== node || previous.path !== path) && !focusAfterNavigation.current) {
      focusAfterNavigation.current = { node, path };
    }
    locationRef.current = { node, path };
  }, [active, node, path]);
  useEffect(() => {
    const request = focusAfterNavigation.current;
    if (!request) return;
    if (!active) {
      focusAfterNavigation.current = null;
      return;
    }
    if (request.node !== node || request.path !== path || loading) return;
    const frame = requestAnimationFrame(() => {
      if (!active || loadingRef.current || focusAfterNavigation.current !== request) return;
      focusAfterNavigation.current = null;
      secRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, node, path, loading]);
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
  const gitDiff = leaf.gitDiff ?? null;
  const setGitDiff = (f: Leaf["gitDiff"] | null) => onPatch({ gitDiff: f ?? undefined });
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
  // A narrow panel (phone, deep split) stacks the side pane: top and bottom are honoured, left falls back to top and right to bottom.
  // The saved dock is kept for wide panels.
  const savedDock: Dock = leaf.pv?.dock ?? "right";
  const dock: Dock = narrow ? (savedDock === "left" ? "top" : savedDock === "right" ? "bottom" : savedDock) : savedDock;
  // A stacked pane gets at least 58% of the panel height (the list keeps 30%), so its body is not a sliver.
  const pvSize = narrow ? Math.max(leaf.pv?.size ?? 40, 58) : (leaf.pv?.size ?? 40);
  const dockSelectRef = useRef<HTMLButtonElement>(null);
  const restoreDockSelectFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreDockSelectFocus.current) return;
    restoreDockSelectFocus.current = false;
    dockSelectRef.current?.focus();
  }, [leaf.pv?.dock]);
  /** the side panel shows the Properties tab (details of the active item) instead of the Preview */
  const propsOpen = leaf.pv?.tab === "props";
  const pvTab = leaf.pv?.tab;
  const setDock = (d: Dock) => onPatch({ pv: { dock: d, size: pvSize, ...(pvTab ? { tab: pvTab } : {}) } });
  const setTab = (tab: "props" | undefined) => onPatch({ pv: { dock: leaf.pv?.dock ?? "right", size: pvSize, ...(tab ? { tab } : {}) } });
  /** a folder named from a breadcrumb menu (not part of the selection); dropped as soon as the selection or folder changes */
  const [propsFor, setPropsFor] = useState<string | null>(null);
  const openProps = (forPath?: string) => {
    setClosedFor(null);
    setPropsFor(forPath ?? null);
    setTab("props");
  };
  /** Preview mode of the side pane. With nothing previewable selected it opens on the empty state (leaf.pe) instead of staying shut. */
  const showPreview = () =>
    onPatch({ closed: undefined, pe: isPreviewableEntry(only) ? undefined : true, pv: { dock: leaf.pv?.dock ?? "right", size: pvSize } });

  useEffect(() => {
    let live = true;
    const key = `${node}\0${path}\0${hidden}`;
    const fresh = listKey.current !== key;
    if (fresh) {
      // A different folder: drop the old rows so skeleton rows (not the previous folder) hold the space until the list arrives.
      listKey.current = key;
      setEntries([]);
      setGit(null);
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
        const act = cursorRef.current;
        let nextActive = act;
        if (act && !known.has(act)) {
          // The active item vanished (trashed, moved, renamed, external change): the next sibling in the old display order takes over,
          // else the previous one; an emptied folder leaves no active item. A different folder never inherits an item.
          nextActive = null;
          const old = orderRef.current;
          const at = fresh ? -1 : old.indexOf(act);
          if (at >= 0) {
            for (let k = at + 1; k < old.length && !nextActive; k++) if (known.has(old[k]!)) nextActive = old[k]!;
            for (let k = at - 1; k >= 0 && !nextActive; k--) if (known.has(old[k]!)) nextActive = old[k]!;
          }
        }
        const was = selRef.current;
        const kept = [...was].filter((p) => known.has(p));
        const nextSel = kept.length === 0 && act && was.has(act) && nextActive ? new Set([nextActive]) : new Set(kept);
        if (nextActive !== act) {
          setCursor(nextActive);
          setAnchor(nextActive);
        }
        setSel((s) => (nextSel.size === s.size && [...nextSel].every((p) => s.has(p)) ? s : nextSel));
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

  // Git status for the folder, asked for once its listing is on screen. A change event (tick) asks for a fresh read; a repository too big to
  // read within the agent's time budget answers "pending" and is asked again shortly, while the listing stays as it is.
  useEffect(() => {
    if (loading) return;
    let live = true;
    let timer = 0;
    let tries = 0;
    const ctl = new AbortController();
    const ask = (fresh: boolean) =>
      gitApi.status(node, path, fresh, ctl.signal).then(
        (g) => {
          if (!live) return;
          setGit(g);
          if (g.pending && ++tries <= 8) timer = window.setTimeout(() => ask(false), 1500);
        },
        () => live && setGit(null),
      );
    void ask(tick > 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [node, path, loading, tick]);
  const gitMark = (en: Entry, isDir: boolean) => {
    if (!git) return null;
    const child = isDir ? git.children[en.name] : undefined;
    if (child) return <GitPill s={child} />;
    const st = git.entries[en.name] ?? git.base;
    return st ? <GitBadge letters={st} /> : null;
  };
  const gitCol = !!git && (Object.keys(git.children).length > 0 || Object.keys(git.entries).length > 0 || !!git.base);

  const sorted = useMemo(() => {
    const f = [...entries];
    const dirFirst = (e: Entry) => (e.type === "dir" || e.linkDir ? 0 : 1);
    f.sort((a, b) => {
      const d = dirFirst(a) - dirFirst(b);
      if (d) return d;
      if (sort.key === "mtime") {
        // unknown times (no modification time at the source) stay together at the end, either direction
        const ua = !a.mtime, ub = !b.mtime;
        if (ua || ub) return ua && ub ? natural.compare(a.name, b.name) : ua ? 1 : -1;
      }
      const c = sort.key === "name" ? natural.compare(a.name, b.name) : (a[sort.key] ?? 0) - (b[sort.key] ?? 0);
      return sort.asc ? c : -c;
    });
    return f;
  }, [entries, sort]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((e) => e.name.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

  orderRef.current = sorted.map((e) => e.path);
  const activeEntry = cursor ? entries.find((e) => e.path === cursor) : undefined;
  /** the item the side panel shows: the active one, unless several items are selected here */
  const only = sel.size <= 1 ? activeEntry : undefined;
  const previewEntry = isPreviewableEntry(only) && closedFor !== only!.path ? only! : null; // a broken link has nothing to preview
  const emptyOpen = !!leaf.pe;
  useEffect(() => {
    if (closedFor && closedFor !== cursor) setClosedFor(null);
  }, [cursor, closedFor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPropsFor(null), [sel, cursor, node, path]);
  // Mirror the active item and the selection into the URL once the listing has confirmed they exist.
  useEffect(() => {
    if (!entries.length && (sel.size || cursor)) return; // a deep-linked selection waits for the listing
    const v = cursor ?? undefined;
    const many = sel.size > 1 && sel.size <= MAX_SELS ? [...sel].sort() : undefined;
    const ns = cursor && !sel.has(cursor) ? (true as const) : undefined;
    const old = leaf.sels ? [...leaf.sels].sort() : undefined;
    if (v !== leaf.sel || ns !== leaf.ns || many?.join("\0") !== old?.join("\0")) {
      pendingSelectionEchoes.current.push(selectionEchoKey(node, path, v, ns, many));
      if (pendingSelectionEchoes.current.length > 32) pendingSelectionEchoes.current.splice(0, pendingSelectionEchoes.current.length - 32);
      onPatch({ sel: v, sels: many, ns });
    }
  }, [sel, cursor, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Report the selection upward so the other panels and the selection bar see it.
  useEffect(() => {
    onSelection(entries.filter((e) => sel.has(e.path)).map((e) => refOf(leaf.id, node, e)));
  }, [sel, entries, node]); // eslint-disable-line react-hooks/exhaustive-deps
  // A request made before this panel existed (a new panel opened with a selection) is not for it.
  const seenClear = useRef(clearReq?.n);
  useEffect(() => {
    // The active item stays: only the action selection is dropped.
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
    const mod = e.ctrlKey || e.metaKey;
    // Shift: a range inside this panel. Ctrl/Cmd: toggle, and this panel joins the selected panels. Plain: reset to this one item here.
    const kind: ClickKind = e.shiftKey && anchor ? "range" : mod && !e.shiftKey ? "toggle" : "plain";
    // Ctrl/Cmd on a selected item deselects it: the active item then follows what is left (nothing: the open folder).
    const off = kind === "toggle" && sel.has(en.path);
    if (off) {
      const rest = [...sel].filter((x) => x !== en.path);
      setCursor(rest.length === 1 ? rest[0]! : rest.length === 0 ? null : en.path);
    } else setCursor(en.path);
    if (kind === "plain") onClearOthers();
    else onClickSelect(kind, off ? sel.size > 1 : true);
    if (kind === "range") {
      const a = visible.findIndex((x) => x.path === anchor);
      const b = visible.findIndex((x) => x.path === en.path);
      setSel(new Set(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
    } else if (kind === "toggle") {
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
    navigate(node, parent(full));
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
    navigate(n, p);
  };
  const openHit = (rel: string, h: { t: Entry["type"] }) => {
    const full = hitPath(rel);
    if (h.t === "dir") navigate(node, full);
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
    if (isDirEntry(en)) navigate(node, en.path);
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
            { label: isBookmarked(marks, { node, path: one.path }) ? "Remove bookmark" : "Add to bookmarks", onSelect: () => toggleMark({ node, path: one.path }) },
          ] as MenuItem[])
        : one
          ? ([{ label: "Show in new panel", onSelect: () => onOpenPanel(node, parent(one.path), one.path) }] as MenuItem[])
          : []),
      { label: "Preview", disabled: !one || isDirEntry(one), onSelect: showPreview },
      { label: "Edit", disabled: !one || !canEdit(one), onSelect: () => one && setEditing({ node, path: one.path }) },
      ...diffItems(picked, extra),
      "sep",
      { label: "Cut", hint: "Ctrl+X", onSelect: () => setClipboard("cut", picked, extra) },
      { label: "Copy", hint: "Ctrl+C", onSelect: () => setClipboard("copy", picked, extra) },
      { label: "Copy to folder...", onSelect: () => setModal({ k: "transfer", kind: "copy", refs: combine(picked, extra) }) },
      { label: "Move to folder...", onSelect: () => setModal({ k: "transfer", kind: "move", refs: combine(picked, extra) }) },
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
    ...(here ? [] : ([{ label: "Open", onSelect: () => navigate(node, dir) }, { label: "Open in new panel", onSelect: () => onOpenPanel(node, dir) }] as MenuItem[])),
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
    { label: "Properties", hint: here ? "Alt+Enter" : undefined, onSelect: () => openProps(dir) },
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
  const columns = useColumns();
  const sortBy = (key: SortKey) => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const closeSide = () => {
    if (gitDiff) return setGitDiff(null);
    if (editing) return setEditing(null);
    // Closing marks the selected file's preview closed (Properties must not reveal it either) and drops the empty-state flag.
    const closed = only && !isDirEntry(only) ? only.path : undefined;
    setPropsFor(null);
    onPatch({ closed, pe: undefined, ...(propsOpen ? { pv: { dock: leaf.pv?.dock ?? "right", size: pvSize } } : {}) });
  };
  const paneExtra = (
    <span className="pv-extra">
      {!editing && !gitDiff && (
        <span className="pv-dock pv-switch" role="group" aria-label="Side panel content">
          <Tip label={isPreviewableEntry(only) ? "Preview the selected file" : "Select one file to preview it"}>
            <button type="button" className={"pv-dockbtn" + (!propsOpen ? " on" : "")} aria-pressed={!propsOpen} aria-label="Preview" onClick={showPreview}><Ic.Eye /></button>
          </Tip>
          <Tip label="Properties of the active item" shortcut="Alt+Enter">
            <button type="button" className={"pv-dockbtn" + (propsOpen ? " on" : "")} aria-pressed={propsOpen} aria-label="Properties" onClick={() => openProps()}><Ic.Info /></button>
          </Tip>
        </span>
      )}
      <span className="pv-dock">
        <Dropdown
          id={`pv-dock-${leaf.id}`}
          label="Side panel position"
          iconOnly
          className="pv-dockbtn"
          triggerRef={dockSelectRef}
          value={dock}
          options={DOCKS.map((d) => ({ value: d.dock, label: d.label.replace("Dock side panel ", "").replace(/^./, (c) => c.toUpperCase()) + (narrow && d.dock === "left" ? " (stacks on top)" : narrow && d.dock === "right" ? " (stacks below)" : ""), Icon: d.icon }))}
          onChange={(v) => { restoreDockSelectFocus.current = true; setDock(v as Dock); }}
        />
        {!gitDiff && (
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
        )}
      </span>
    </span>
  );
  // Nothing selected: Properties shows the open folder itself.
  const folderProps = !propsFor && sel.size <= 1 && !cursor;
  const propsKey = propsFor ?? (sel.size > 1 ? null : cursor ?? path);
  const propsPane =
    propsKey !== null ? (
      <div className="pv">
        <div className="pv-head">
          <Tip label={propsKey}><b className="pv-title">{propsKey === "/" ? `${node}:/` : base(propsKey)}</b></Tip>
          <span className="muted">{propsFor || folderProps ? "Folder" : "Active"}</span>
          {paneExtra}
        </div>
        <div className="pv-body pp-body" data-testid="git-branch-diff-scroll">
          <PropertiesPanel key={`${node}\0${propsKey}`} node={node} path={propsKey} {...(!propsFor && only ? { entry: only } : {})} onChanged={refresh} onStatus={onStatus} gitTick={tick} selectedTab={leaf.pt ?? "details"} onTabChange={(pt) => onPatch({ pt })} onReveal={(p) => goTo(node, parent(p), p)} onOpenWorktree={(p) => { setClosedFor(null); setPropsFor(null); navigate(node, p); }} worktreeHref={(p) => encodeState({ tree: { kind: "leaf", id: leaf.id, node, path: p, pv: { dock: leaf.pv?.dock ?? "right", size: leaf.pv?.size ?? 40, tab: "props" }, pt: "git" }, active: leaf.id })} {...(onDiffHead ? { onDiffHead: (p: string) => onDiffHead(node, p) } : {})} />
        </div>
      </div>
    ) : sel.size > 1 ? (
      <div className="pv">
        <div className="pv-head">
          <b>{sel.size.toLocaleString()} items</b>
          <span className="muted">Selected</span>
          {paneExtra}
        </div>
        <div className="pv-body pp-body"><PropertiesMulti entries={selEntries} /></div>
      </div>
    ) : null; // no active item: no side panel at all (no placeholder, no folder fallback)
  const pane = cside ? null : editing ? (
    <Suspense fallback={<div className="pad muted">Loading editor...</div>}>
      <TextEditor key={editing.node + editing.path} file={editing} inline onClose={() => setEditing(null)} onStatus={onStatus} extra={paneExtra} />
    </Suspense>
  ) : gitDiff ? (
    <Suspense fallback={<div className="pad muted">Loading editor...</div>}>
      <DiffViewer left={gitDiff} right={{ node: gitDiff.node, path: gitDiff.path }} inPane onClose={() => setGitDiff(null)} onStatus={onStatus} extra={paneExtra} />
    </Suspense>
  ) : propsOpen ? (
    propsPane
  ) : previewEntry ? (
    <Preview node={node} entry={previewEntry} onEdit={(n, p) => setEditing({ node: n, path: p })} extra={paneExtra} />
  ) : emptyOpen ? (
    <div className="pv">
      <div className="pv-head">
        <b className="pv-title">Preview</b>
        {paneExtra}
      </div>
      <div className="pv-body pp-empty"><p className="muted pad">Select a file to preview</p></div>
    </div>
  ) : null;
  // ---- bookmarks ----
  const marks = useBookmarks();
  const here = { node, path };
  const toggleMark = (l: Loc) => {
    onStatus(isBookmarked(marks, l) ? `Removed bookmark ${l.node}:${l.path}` : `Bookmarked ${l.node}:${l.path}`);
    toggleBookmark(l);
  };

  // Shared by the list rows and the grid tiles: selection, open, context menu, drag and drop.
  const itemProps = (en: Entry, isDir: boolean, cls: string) => ({
    "data-path": en.path,
    className: cls + (sel.has(en.path) ? "sel " : "") + (cursor === en.path ? (sel.has(en.path) ? "cur " : "cur act ") : "") + (over === en.path ? "drop" : ""),
    draggable: true,
    onClick: (e: React.MouseEvent) => click(e, en),
    onDoubleClick: () => open(en),
    onAuxClick: isDir ? (e: React.MouseEvent) => e.button === 1 && (e.preventDefault(), onOpenPanel(node, en.path)) : undefined,
    onContextMenu: (e: React.MouseEvent) => {
      onFocus();
      const inSel = sel.has(en.path);
      const picked = inSel ? entries.filter((x) => sel.has(x.path)) : [en];
      if (!inSel) {
        onClearOthers();
        setSel(new Set([en.path]));
        setAnchor(en.path);
        setCursor(en.path);
      }
      showMenu(e, rowItems(picked, inSel ? others : []));
    },
    onDragStart: (e: React.DragEvent) => {
      const paths = sel.has(en.path) ? selected() : [en.path];
      if (!sel.has(en.path)) (onClearOthers(), setSel(new Set([en.path])), setCursor(en.path));
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
      aria-invalid={!!err || undefined}
      aria-describedby={err ? createErrorId : undefined}
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
    if (parentPath !== null) navigate(node, parentPath);
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
          if (e.target === e.currentTarget && sel.size === 0 && e.currentTarget.matches(":focus-visible")) {
            const keep = cursor ? visible.find((x) => x.path === cursor) : undefined;
            const go = keep ?? visible[0];
            if (go) selectOnly(go.path);
          }
        }}
        onClick={(e) => e.target === e.currentTarget && (onClearOthers(), setSel(new Set()), setCursor(null))}
        onContextMenu={(e) => {
          onFocus();
          onClearOthers();
          setSel(new Set());
          showMenu(e, folderItems(path, true));
        }}
      >
        {view === "grid" ? (
          <div className="fp-grid" role="group" aria-label="Files" aria-busy={loading}>
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
                <div key={en.path} role="group" aria-label={`${en.name}${sel.has(en.path) ? ", selected" : ""}`} {...itemProps(en, isDir, "tile ")}>
                  <Thumb node={node} entry={en} isDir={isDir} />
                  <Tip label={en.name} fill><div className="tile-name">{nameEditor(en)}</div></Tip>
                  {gitMark(en, isDir) && <div className="tile-git">{gitMark(en, isDir)}</div>}
                </div>
              );
            })}
            {remaining > 0 && <div ref={(el) => void (moreEl.current = el)} className="more-tiles" aria-hidden="true" />}
          </div>
        ) : (
        <table className="ft cols" aria-busy={loading} style={tableStyle(columns.state, gitCol)}>
          <ColGroup state={columns.state} cols={columns.cols} git={gitCol} />
          <thead>
            <HeaderRow s={columns.state} cols={columns.cols} git={gitCol} sort={sort} onSort={sortBy} onMenu={(x, y, items) => setMenu({ x, y, items })} />
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
                {gitCol && <td />}
                {columns.cols.slice(1).map((c) => <td key={c.id} className={c.align ? "num" : "txt"} />)}
                <FillCell />
              </tr>
            )}
            {loading && <SkeletonRows />}
            {createInput && (
              <tr className="creating">
                <td className="name" colSpan={cellCount(columns.cols, gitCol)}>
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
                    {gitCol && <div className="git-inline">{gitMark(en, isDir)}</div>}
                    {en.type === "symlink" && (
                      <Tip label={en.broken ? `Broken link: ${en.target ?? ""} does not exist` : `Link to ${en.target ?? ""}`}>
                        <span className={"ln-target" + (en.broken ? " broken" : "")}>
                          {en.broken && <span className="visually-hidden">Broken link </span>}
                          <ArrowRight /> {en.target}
                        </span>
                      </Tip>
                    )}
                  </td>
                  {gitCol && <td className="git-td">{gitMark(en, isDir)}</td>}
                  {columns.cols.slice(1).map((c) => dataCell(c, en, isDir))}
                  <FillCell />
                </tr>
              );
            })}
            {remaining > 0 && (
              <tr ref={(el) => void (moreEl.current = el)} className="more" aria-hidden="true" style={{ height: remaining * estimatedFileRowHeight }}>
                <td colSpan={cellCount(columns.cols, gitCol)} />
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
    if (t.closest('input,textarea,select,[contenteditable=true],.monaco-editor,dialog,[role="dialog"]')) return;
    if (t.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    if (cside && cmpCtl && e.key !== "Tab" && !(e.altKey && e.key !== "ArrowUp")) {
      if (compareKey(cmpCtl, cside, e)) (e.preventDefault(), e.stopPropagation());
      return;
    }
    // File-selection and row actions belong to the file viewport. Let tabs,
    // toolbar buttons, and other focusable widgets keep their own Home/End,
    // Delete, Ctrl+A, and arrow-key behaviour. Alt panel commands remain
    // available from panel chrome for keyboard users.
    const inFileArea = e.target === e.currentTarget || !!t.closest(".fp-scroll");
    if (!inFileArea && !e.altKey) return;
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
      if (leaf.sr && !(key === "Tab" || key === "?" || (e.altKey && !mod && "nurcpNURCP".includes(key)) || (mod && e.shiftKey && key.toLowerCase() === "f"))) return false;
      if (!mod && !e.altKey) {
        const r = typeAheadMatch(visible, cursor, key, typeAhead.current, Date.now());
        if (r) {
          typeAhead.current = r.state;
          if (r.match) selectOnly(r.match.path);
          if (r.match || r.continued) return true;
        }
      }
      if (key === "?" && !mod) return onHelp(), true;
      // Folder actions that used to live only in the header "more" menu (also in the right-click menu of the list and the breadcrumb).
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "n") return startCreate(path, "file"), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "u") return fileInput.current?.click(), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "r") return refresh(), true;
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "c") return void copyPaths([path]), true;
      // Keyboard alternative to Ctrl/Cmd+click: add this panel to (or remove it from) the selected panels.
      if (e.altKey && !mod && !e.shiftKey && key.toLowerCase() === "p") return onTogglePanel(), true;
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
      if (key === "Enter" && e.altKey && !mod) return (sideView === "props" ? closeSide() : openProps()), true;
      if (key === "Enter" && !mod) {
        const en = visible[idx];
        return !!en && (open(en), true);
      }
      if (e.altKey && !mod && (key === "ArrowLeft" || key === "ArrowRight")) return histGo(key === "ArrowLeft" ? -1 : 1), true;
      if (key === "Backspace" || (e.altKey && key === "ArrowUp")) return path !== "/" && (navigate(node, parent(path)), true);
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
        return (sel.size > 0 || others.length > 0 || !!cursor) && (setSel(new Set()), setCursor(null), true);
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
  // ---- panel toolbar: frequent actions stay visible, the rest live in grouped menus (New, View, More) ----
  const marked = isBookmarked(marks, here);
  // per-pane back/forward history of the folders this panel showed
  const histRef = useRef<{ s: { node: string; path: string }[]; i: number; skip: boolean }>({ s: [], i: -1, skip: false });
  const [, histTick] = useState(0);
  useEffect(() => {
    const h = histRef.current;
    if (h.skip) h.skip = false;
    else if (!h.s[h.i] || h.s[h.i]!.node !== node || h.s[h.i]!.path !== path) {
      h.s = [...h.s.slice(0, h.i + 1), { node, path }].slice(-50);
      h.i = h.s.length - 1;
    }
    histTick((n) => n + 1);
  }, [node, path]);
  const histGo = (d: number) => {
    const h = histRef.current;
    const t = h.s[h.i + d];
    if (!t) return;
    h.i += d;
    h.skip = true;
    navigate(t.node, t.path);
    histTick((n) => n + 1);
  };
  const canBack = histRef.current.i > 0;
  const canFwd = histRef.current.i < histRef.current.s.length - 1;
  // ---- second header row: grouped menus on the left, the buttons that open the RIGHT side panel grouped on the right ----
  const sole = selEntries.length === 1 ? selEntries[0]! : undefined;
  const anySel = combine(selEntries).length > 0;
  const menuAt = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };
  const newItems = (): MenuItem[] => [
    { label: "New file", hint: "Alt+N", icon: FilePlus, onSelect: () => startCreate(path, "file") },
    { label: "New folder", hint: "F7", icon: FolderPlus, onSelect: () => startCreate(path, "folder") },
    { label: "New symbolic link", icon: Link2, onSelect: () => setModal({ k: "link", dir: path }) },
    "sep",
    { label: "Upload files", hint: "Alt+U", icon: Upload, onSelect: () => fileInput.current?.click() },
    { label: "Upload a folder", icon: FolderUp, onSelect: () => folderInput.current?.click() },
  ];
  const viewItems = (): MenuItem[] => [
    { label: "List view", icon: List, checked: view !== "grid", onSelect: () => (setSettings({ view: "list" }), onPatch({ w: "l" })) },
    { label: "Thumbnail grid", icon: LayoutGrid, checked: view === "grid", onSelect: () => (setSettings({ view: "grid" }), onPatch({ w: "g" })) },
    "sep",
    ...SORTS.map((x): MenuItem => {
      const on = sort.key === x.key;
      const Icon = on && !sort.asc ? x.desc : x.asc;
      return { label: `Sort by ${x.name}${on ? ` (${sort.asc ? x.ascText : x.descText})` : ""}`, icon: Icon, checked: on, onSelect: () => setSort((c) => ({ key: x.key, asc: c.key === x.key ? !c.asc : x.key === "name" })) };
    }),
    "sep",
    { label: hidden ? "Hide hidden files" : "Show hidden files", icon: hidden ? EyeOff : Eye, checked: hidden, onSelect: () => setHidden(!hidden) },
  ];
  const splitItems = (): MenuItem[] => [
    { label: "Split right", icon: Columns2, onSelect: () => onSplit("horizontal") },
    { label: "Split down", icon: Rows2, onSelect: () => onSplit("vertical") },
  ];
  const moreItems = (): MenuItem[] => [
    { label: pasteLabel, hint: "Ctrl+V", icon: ClipboardPaste, disabled: !clip, onSelect: () => void paste(path) },
    { label: "Select all", hint: "Ctrl+A", icon: ListChecks, disabled: !entries.length, onSelect: () => setSel(new Set(entries.map((x) => x.path))) },
    { label: selEntries.length > 1 ? "Copy paths" : "Copy path", hint: "Alt+C", icon: Copy, onSelect: () => void copyPaths(selEntries.length ? selEntries.map((x) => x.path) : [path]) },
    "sep",
    { label: "Rename", hint: "F2", icon: Pencil, disabled: sel.size !== 1 || others.length > 0, onSelect: () => setRenaming([...sel][0] ?? null) },
    { label: "Duplicate", icon: CopyPlus, disabled: !selEntries.length || others.length > 0, onSelect: () => void duplicate(selEntries) },
    { label: "Edit in the editor", hint: "F4", icon: FilePen, disabled: !sole || !canEdit(sole), onSelect: () => sole && setEditing({ node, path: sole.path }) },
    {
      label: diffMarked ? "Diff against the marked file" : "Diff files",
      tip: "Select two files, or mark one then pick another",
      icon: Diff,
      disabled: !combine(selEntries).length || combine(selEntries).length > 2 || !combine(selEntries).every((r) => r.editable),
      onSelect: () => onDiff(combine(selEntries).map((r) => ({ node: r.node, path: r.path }))),
    },
    "sep",
    { label: "Download", icon: Download, disabled: !anySel, onSelect: () => download(selEntries) },
    { label: "Compress selection", icon: Archive, disabled: !anySel, onSelect: () => setDialog("compress") },
    { label: "Extract archive", icon: PackageOpen, disabled: !(sel.size === 1 && !!sole && sole.type === "file" && isArchive(sole.name)), onSelect: () => setDialog("extract") },
    "sep",
    { label: "Move to trash", hint: "Del", icon: Trash2, danger: true, disabled: !anySel, onSelect: () => void trashEntries(selEntries) },
    { label: "Delete permanently", hint: "Shift+Del", icon: CircleX, danger: true, disabled: !anySel, onSelect: () => setModal({ k: "del", refs: combine(selEntries) }) },
    { label: "Open trash", icon: Trash2, onSelect: () => onTrash(node) },
    "sep",
    ...(git?.repo ? ([{ label: "Git worktrees", icon: GitBranch, onSelect: () => showGit() }] as MenuItem[]) : []),
    { label: panelPicked ? "Remove this panel from the selection" : "Add this panel to the selection", hint: "Alt+P", icon: panelPicked ? Ic.SquareMinus : SquareCheck, onSelect: onTogglePanel },
  ];
  /** Properties in the side panel, on its Git tab. */
  const showGit = () => {
    onPatch({ pt: "git" });
    openProps();
  };
  const sideView = sidePaneView({ editing: !!editing, gitDiff: !!gitDiff, propsOpen, previewable: !!previewEntry, emptyOpen });
  const toggles = sidePaneToggles(sideView);
  const canPreview = isPreviewableEntry(only);

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
      <header
        ref={barRef}
        className="fp-bar"
        onClick={(e) => {
          // Shift/Ctrl/Cmd+click on the toolbar background also selects the whole panel (e.g. two panels to compare).
          if ((e.shiftKey || e.ctrlKey || e.metaKey) && !(e.target as Element).closest("button,input,select,label,a,[role=button]")) {
            e.preventDefault();
            onFocus();
            onTogglePanel();
          }
        }}
      >
      <div className="fp-row">
        <Tip label="Drag to move this panel, or use Alt+Shift+Arrow keys" shortcut="Alt+Shift+Arrows">
          <div
            className="fp-grip"
            role="button"
            tabIndex={0}
            aria-label="Move panel: drag, or press Alt+Shift with an arrow key"
            aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
            {...dragProps}
          ><GripVertical aria-hidden="true" /></div>
        </Tip>
        <Tip label="Back" shortcut="Alt+Left"><button type="button" className="fp-up" aria-label="Back" disabled={!canBack} onClick={() => histGo(-1)}><ArrowLeft /></button></Tip>
        <Tip label="Forward" shortcut="Alt+Right"><button type="button" className="fp-up" aria-label="Forward" disabled={!canFwd} onClick={() => histGo(1)}><ArrowRight /></button></Tip>
        <Tip label="Up one folder" shortcut="Backspace"><button type="button" className="fp-up" aria-label="Up one folder" disabled={path === "/"} onClick={() => navigate(node, parent(path))}><ArrowUp /></button></Tip>
        <AddressBar node={node} path={path} active={active} hidden={hidden} onGo={goTo} onCrumbMenu={(e, p) => showMenu(e, folderItems(p, false))} />
        <Tip label="Refresh" shortcut="Alt+R"><button type="button" className="fp-up fp-refresh" aria-label="Refresh" onClick={refresh}><RefreshCw /></button></Tip>
        {git?.repo && !leaf.sr && <span className="git-chip"><GitPill s={git.repo.summary} /></span>}
        <div className="fp-actions">
          <Tip label="Split this panel"><button type="button" aria-label="Split this panel" aria-haspopup="menu" onClick={(e) => menuAt(e, splitItems())}><Columns2 /></button></Tip>
          {onClose ? (
            <Tip label="Close panel"><button type="button" aria-label="Close panel" onClick={() => onClose()}><X /></button></Tip>
          ) : (
            // The only panel cannot be closed: an invisible button of the same size keeps the other controls where they are.
            <button type="button" className="fp-close-ph" aria-hidden="true" tabIndex={-1} disabled><X /></button>
          )}
        </div>
      </div>
      <div className="fp-tools" role="toolbar" aria-label="File and folder actions">
        <div className="fp-tools-main" role="group" aria-label="Folder actions">
          <Tip label="New: file, folder, link or upload"><button type="button" className="fp-menubtn" aria-label="New" aria-haspopup="menu" onClick={(e) => menuAt(e, newItems())}><FilePlus />{!narrow && <span className="fp-menubtn-l">New</span>}<ChevronDown className="fp-caret" /></button></Tip>
          <Tip label="View: list or grid, sort order, hidden files"><button type="button" className="fp-menubtn" aria-label="View" aria-haspopup="menu" onClick={(e) => menuAt(e, viewItems())}>{view === "grid" ? <LayoutGrid /> : <List />}{!narrow && <span className="fp-menubtn-l">View</span>}<ChevronDown className="fp-caret" /></button></Tip>
          <Tip label="Search under this folder" shortcut="Ctrl+Shift+F"><button type="button" aria-label="Search under this folder" aria-pressed={!!leaf.sr} className={leaf.sr ? "marked" : ""} onClick={() => setSearch(leaf.sr ? undefined : EMPTY_SEARCH)}><Search /></button></Tip>
          <Tip label={marked ? "Remove this folder from the bookmarks" : "Bookmark this folder"}><button type="button" aria-label={marked ? "Remove this folder from the bookmarks" : "Bookmark this folder"} aria-pressed={marked} className={marked ? "marked" : ""} onClick={() => toggleMark(here)}><Star fill={marked ? "currentColor" : "none"} /></button></Tip>
          <Tip label="More actions"><button type="button" aria-label="More actions" aria-haspopup="menu" onClick={(e) => menuAt(e, moreItems())}><Ellipsis /></button></Tip>
        </div>
        <div className="fp-tools-side" role="group" aria-label="Side panel">
          <Tip label={canPreview ? "Preview the selected file" : "Preview panel (select a file to fill it)"}>
            <button type="button" aria-label="Preview in the side panel" aria-pressed={toggles.preview} className={toggles.preview ? "marked" : ""} onClick={() => (toggles.preview ? closeSide() : showPreview())}><Eye /></button>
          </Tip>
          <Tip label="Properties in the side panel" shortcut="Alt+Enter">
            <button type="button" aria-label="Properties in the side panel" aria-pressed={toggles.props} className={toggles.props ? "marked" : ""} onClick={() => (toggles.props ? closeSide() : openProps())}><Ic.Info /></button>
          </Tip>
          {git?.repo && (
            <Tip label="Git details in the side panel: branch, changes, worktrees, pull request diff">
              <button type="button" aria-label="Git details in the side panel" aria-pressed={toggles.props && leaf.pt === "git"} className={toggles.props && leaf.pt === "git" ? "marked" : ""} onClick={() => (toggles.props && leaf.pt === "git" ? closeSide() : showGit())}><GitBranch /></button>
            </Tip>
          )}
        </div>
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
      {err && <div id={createErrorId} className="fp-err" role="alert">{err}</div>}
      {pane ? (
        <Group key={dock + (narrow ? "-n" : "")} orientation={horizontal ? "horizontal" : "vertical"} id={`${leaf.id}-pv`} defaultLayout={{ list: 100 - pvSize, pv: pvSize }}
          onLayoutChanged={(l) => { const v = l.pv; if (typeof v === "number" && v >= 10 && v <= 90 && Math.abs(v - pvSize) > 0.5) onPatch({ pv: { dock: savedDock, size: v, ...(pvTab ? { tab: pvTab } : {}) } }); }}>
          {first && <Panel id="pv" minSize={narrow ? "40%" : "15%"}>{pane}</Panel>}
          {first && <Separator className={"sep " + (horizontal ? "horizontal" : "vertical")} />}
          <Panel id="list" minSize={narrow ? "30%" : "20%"}>{listing}</Panel>
          {!first && <Separator className={"sep " + (horizontal ? "horizontal" : "vertical")} />}
          {!first && <Panel id="pv" minSize={narrow ? "40%" : "15%"}>{pane}</Panel>}
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
      {modal?.k === "transfer" && (
        <TransferDestination
          kind={modal.kind}
          items={modal.refs}
          initialNode={node}
          initialPath={path}
          onClose={() => setModal(null)}
          onChoose={(targetNode, targetDir) => void transferOp(modal.kind, modal.refs.map(({ node: sourceNode, path: sourcePath }) => ({ node: sourceNode, path: sourcePath })), targetNode, targetDir)}
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
