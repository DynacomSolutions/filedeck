import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { ChevronRight, Ellipsis, FolderClosed, HardDrive, Network, Server, Star, Trash2 } from "lucide-react";
import { fmtSize, type Entry, type Mount, type NodeInfo } from "./api";
import { duFetcher, duKey, listFetcher, listKey as swrListKey, mountsFetcher, mountsKey } from "./data";
import { listState } from "./sidebarState";
import { SkeletonTreeRows } from "./Skeleton";
import { addBookmark, bookmarkLabel, isBookmarked, removeBookmark, useBookmarks, type Bookmark } from "./bookmarks";
import { copyText } from "./clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Tip } from "./Tooltip";
import { EXPANDED_KEY, ancestorPaths, flatten, folderSizes, heldIds, hold, isOpen, navigate, parseExpanded, rovingId, serverUsage, setOpen, shownOpen, usagePct, type ExpandState, type Held, type FolderSize, type TreeNodeBase, type Usage } from "./sidebarTree";

export type How = "here" | "panel";

type Listing = { status: "loading" } | { status: "ready"; dirs: Entry[]; truncated: boolean } | { status: "error"; error: string };
type MountsState = { status: "loading" } | { status: "ready"; mounts: Mount[] } | { status: "error"; error: string };

export interface TNode extends TreeNodeBase {
  kind: "section" | "node" | "mount" | "dir" | "bookmark" | "trash";
  label: string;
  icon: React.ReactNode;
  /** where the row points; sections have none */
  node?: string;
  path?: string;
  defaultOpen: boolean;
  /** on the path to the current folder: open unless collapsed by hand */
  auto?: boolean;
  tip?: string;
  extra?: React.ReactNode;
  /** disk usage: draws the bar under the label and fills the popover */
  usage?: Usage;
  /** folder size from the size store: bar and popover like usage; "unknown" = not stored yet (no bar) */
  size?: FolderSize | "unknown";
  children?: TNode[];
  /** what to fetch when the row is open and nothing is loaded yet */
  load?: "dir" | "mounts";
  /** inline note under the children */
  note?: { kind: "loading" | "error" | "empty" | "more" | "skeleton"; text: string };
  offline?: boolean;
}

const listKey = (node: string, path: string) => node + "\0" + path;
const duWant = (node: string, path: string) => "d\0" + listKey(node, path);
const sameListing = (a: Listing | undefined, b: Listing) => !!a && a.status === b.status && (a.status !== "ready" || b.status !== "ready" ? true : a.dirs === b.dirs && a.truncated === b.truncated) && (a.status !== "error" || b.status !== "error" || a.error === b.error);
const sameMounts = (a: MountsState | undefined, b: MountsState) => !!a && a.status === b.status && (a.status !== "ready" || b.status !== "ready" ? true : a.mounts === b.mounts) && (a.status !== "error" || b.status !== "error" || a.error === b.error);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Want = { k: string; kind: "dir" | "mounts" | "du"; node: string; path: string };
type Dus = Record<string, { path: string; diskBytes: number }[] | null>;

/**
 * Fetches one lazily scanned folder (or a node's mounts) through SWR and reports it to the tree. A re-expanded row
 * therefore shows its cached listing at once while a background request refreshes it. Renders nothing.
 */
function Feed({ want, onDirs, onMounts, onDu }: { want: Want; onDirs: (k: string, l: Listing) => void; onMounts: (node: string, m: MountsState) => void; onDu: (k: string, e: Dus[string]) => void }) {
  // Stored sizes only (never a scan); once per expansion, so no revalidation on focus, reconnect or remount.
  const du = useSWR(want.kind === "du" ? duKey(want.node, want.path) : null, duFetcher, { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false, shouldRetryOnError: false });
  useEffect(() => {
    if (want.kind === "du" && !du.isLoading && (du.data !== undefined || du.error)) onDu(want.k, du.data ?? null);
  }, [want, du.data, du.error, du.isLoading, onDu]);
  const dirs = useSWR(want.kind === "dir" ? swrListKey(want.node, want.path) : null, listFetcher, { revalidateOnFocus: true });
  const mts = useSWR(want.kind === "mounts" ? mountsKey(want.node) : null, mountsFetcher, { revalidateOnFocus: true });
  useEffect(() => {
    if (want.kind !== "dir") return;
    onDirs(want.k, dirs.data ? { status: "ready", dirs: dirs.data.dirs, truncated: dirs.data.truncated } : dirs.isLoading || !dirs.error ? { status: "loading" } : { status: "error", error: msg(dirs.error) });
  }, [want, dirs.data, dirs.error, dirs.isLoading, onDirs]);
  useEffect(() => {
    if (want.kind !== "mounts") return;
    onMounts(want.node, mts.data ? { status: "ready", mounts: mts.data } : mts.isLoading || !mts.error ? { status: "loading" } : { status: "error", error: msg(mts.error) });
  }, [want, mts.data, mts.error, mts.isLoading, onMounts]);
  return null;
}
const loadStored = (): ExpandState => {
  try {
    return parseExpanded(localStorage.getItem(EXPANDED_KEY));
  } catch {
    return {};
  }
};

/**
 * Tree navigation for the left sidebar: Nodes, Networks and Bookmarks as top-level groups.
 *
 * Interaction: each row is a single button. Clicking the label of a collapsed expandable row only expands it; clicking
 * a row that is already expanded (or not expandable) opens the folder in the active panel. The small chevron only
 * toggles. Ctrl/Cmd or middle click opens in a new panel immediately. Enter always opens, Space toggles.
 * The trailing "..." button (and Shift+F10 / the Menu key on the focused row) opens the action menu.
 */
/** Tooltip only when the row's label is cut off. */
const truncated = (wrap: HTMLElement) => [...wrap.querySelectorAll<HTMLElement>(".st-label,.st-sub")].some((el) => el.scrollWidth > el.clientWidth);

const known = (s: TNode["size"]) => (s && s !== "unknown" ? s : undefined);

export function UsageBar({ usage }: { usage: Usage }) {
  const p = usagePct(usage);
  return <span className="st-bar" role="img" aria-label={`${p}% used`}><i style={{ width: `${p}%` }} /></span>;
}

/** Popover content: the full label, what the row points at, and the size details when known. */
export function Popover({ t }: { t: TNode }) {
  return (
    <span className="st-pop">
      <b>{t.label}</b>
      {t.tip && <span className="st-pop-tip">{t.tip}</span>}
      {t.usage && (
        <>
          <span>{fmtSize(t.usage.used)} of {fmtSize(t.usage.total)} used ({usagePct(t.usage)}%)</span>
          <UsageBar usage={t.usage} />
        </>
      )}
      {t.size === "unknown" && <span>size not calculated yet</span>}
      {known(t.size) && (
        <>
          <span>{fmtSize(known(t.size)!.used)} ({usagePct(known(t.size)!)}% of {known(t.size)!.basis === "mount" ? "the used space on the mount" : "the parent folder"})</span>
          <UsageBar usage={known(t.size)!} />
        </>
      )}
    </span>
  );
}

export interface NodesState {
  nodes: NodeInfo[] | undefined;
  error?: unknown;
  isLoading: boolean;
  reload: () => void;
}

export function SideTree({ nodesState, current, onOpen, onTrash }: { nodesState: NodesState; current?: { node: string; path: string }; onOpen: (node: string, path: string, how: How) => void; onTrash: (node: string) => void }) {
  const [expanded, setExpanded] = useState<ExpandState>(loadStored);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [mounts, setMounts] = useState<Record<string, MountsState>>({});
  const [dus, setDus] = useState<Dus>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [held, setHeld] = useState<Held>({ loc: "", ids: [] });
  const marks = useBookmarks();
  const root = useRef<HTMLUListElement>(null);
  const { mutate } = useSWRConfig();
  const nodes = nodesState.nodes ?? [];
  const nodesView = listState({ data: nodesState.nodes, error: nodesState.error, isLoading: nodesState.isLoading });
  const wantFocus = useRef(false);

  // Derived from the current folder on every render, so it needs no cleanup when the user navigates away.
  const loc = current ? current.node + "\0" + current.path : "";
  const heldNow = useMemo(() => new Set(heldIds(held, loc)), [held, loc]);
  const autoDirs = useMemo(() => new Set(current ? ancestorPaths(current.path) : []), [current]);
  const isAuto = (node: string, path: string) => !!current && node === current.node && autoDirs.has(path);
  const openNow = (t: TNode) => shownOpen(isOpen(expanded, t.id, t.defaultOpen), !!t.auto, heldNow.has(t.id));

  const cluster = nodes.filter((n) => n.kind !== "source");
  const network = nodes.filter((n) => n.kind === "source");

  const tree = useMemo<TNode[]>(() => {
    const dirNode = (parent: string, node: string, path: string, e?: Entry, fixedId?: string): TNode => {
      const id = fixedId ?? `${parent}›${path}`;
      const name = e?.name ?? path;
      const t: TNode = { id, kind: "dir", label: name, icon: <FolderClosed />, node, path, expandable: true, defaultOpen: false, auto: isAuto(node, path), tip: `${node}:${path}`, load: "dir" };
      if (openNow(t)) fill(t);
      return t;
    };
    /** Children and status note of a folder row, from whatever is cached. */
    function fill(t: TNode) {
      const l = listings[listKey(t.node!, t.path!)];
      if (!l || l.status === "loading") t.note = { kind: "loading", text: "Scanning..." };
      else if (l.status === "error") t.note = { kind: "error", text: l.error };
      else {
        t.children = l.dirs.map((e) => dirNode(t.id, t.node!, e.path, e));
        const du = dus[duWant(t.node!, t.path!)];
        if (du !== undefined) {
          const m = mounts[t.node!];
          const sz = folderSizes(du ?? [], t.path!, m?.status === "ready" ? m.mounts.find((x) => x.mountpoint === t.path)?.used : undefined);
          for (const c of t.children) c.size = sz[c.path!] ?? "unknown";
        }
        if (!l.dirs.length) t.note = { kind: "empty", text: "No subfolders" };
        else if (l.truncated) t.note = { kind: "more", text: "More folders not shown" };
      }
    }
    const nodeRow = (n: NodeInfo): TNode => {
      const id = "n:" + n.name;
      const t: TNode = { id, kind: "node", label: n.name, icon: <span className={"dot " + (n.online ? "on" : "off")} aria-hidden="true" />, node: n.name, path: "/", expandable: n.online, defaultOpen: false, offline: !n.online, tip: n.online ? undefined : "Offline" };
      const m = mounts[n.name];
      if (n.online && m?.status === "ready") t.usage = serverUsage(m.mounts) ?? undefined;
      t.auto = current?.node === n.name;
      if (!n.online || !openNow(t)) return t;
      const kids: TNode[] = [dirNode(id, n.name, "/", { name: "/ (root)" } as Entry), { id: `${id}:trash`, kind: "trash", label: "Trash", icon: <Trash2 />, node: n.name, expandable: false, defaultOpen: false }];
      if (m?.status === "ready")
        for (const x of m.mounts) {
          const mt = dirNode(id + ":m", n.name, x.mountpoint, { name: x.mountpoint } as Entry);
          mt.kind = "mount";
          mt.icon = <HardDrive />;
          mt.tip = `${x.device} (${x.fstype})${x.network ? " - network drive" : ""}${x.unreachable ? " - not responding" : ""}${x.readOnly ? " - read-only" : ""}`;
          mt.extra = (
            <>
              {x.network && <span className={"net-badge" + (x.unreachable ? " bad" : "")}>{x.netKind ?? "network"}</span>}
              {x.readOnly && <span className="net-badge">read-only</span>}
            </>
          );
          if (x.total > 0) mt.usage = { used: x.used, total: x.total };
          kids.push(mt);
        }
      t.children = kids;
      t.load = "mounts";
      if (!m || m.status === "loading") t.note = { kind: "loading", text: "Reading mounts..." };
      else if (m.status === "error") t.note = { kind: "error", text: m.error };
      return t;
    };
    // Nodes and networks arrive in one request, so they share one loading/error state; "empty" is shown only after a successful load.
    const sectionNote = (kids: TNode[], empty: string, remote: boolean): TNode["note"] =>
      remote && nodesView === "loading" ? { kind: "skeleton", text: "Loading" } : remote && nodesView === "error" ? { kind: "error", text: `Could not load: ${msg(nodesState.error)}` } : kids.length ? undefined : { kind: "empty", text: empty };
    const section = (id: string, label: string, icon: React.ReactNode, kids: TNode[], empty: string, remote = true): TNode => ({ id, kind: "section", label, icon, expandable: true, defaultOpen: true, children: kids, note: sectionNote(kids, empty, remote) });
    const sourceRow = (n: NodeInfo): TNode => {
      const t = dirNode("", n.name, "/", undefined, "n:" + n.name);
      t.kind = "node";
      t.label = n.name;
      t.icon = <><span className={"dot " + (n.online ? "on" : "off")} aria-hidden="true" /><Network /></>;
      t.expandable = n.online;
      t.offline = !n.online;
      t.extra = <span className="net-badge">{(n.type ?? "net").toUpperCase()}</span>;
      t.tip = `${n.type ?? "network"} ${n.host ?? ""}${n.online ? "" : n.offlineReason === "host-key-changed" ? " - host key changed, connection refused" : " - unreachable"}`;
      return t;
    };
    const bookmarkRow = (b: Bookmark): TNode => {
      const id = `b:${b.node}\0${b.path}`;
      const t = dirNode("", b.node, b.path, undefined, id);
      t.kind = "bookmark";
      t.label = bookmarkLabel(b);
      t.icon = <Star className="mark-star" fill="currentColor" />;
      t.extra = <span className="muted st-sub">{b.node}</span>;
      return t;
    };
    return [
      section("sec:nodes", "Nodes", <Server />, cluster.map(nodeRow), "No nodes"),
      section("sec:networks", "Networks", <Network />, network.map(sourceRow), "No network sources"),
      section("sec:bookmarks", "Bookmarks", <Star />, marks.map(bookmarkRow), "Star a folder to keep it here.", false),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, nodesView, nodesState.error, expanded, listings, mounts, dus, marks, current?.node, current?.path, heldNow]);

  const byId = useMemo(() => {
    const m = new Map<string, TNode>();
    const walk = (l: TNode[]) => l.forEach((n) => (m.set(n.id, n), n.children && walk(n.children)));
    walk(tree);
    return m;
  }, [tree]);
  const rows = useMemo(() => flatten(tree, (n) => openNow(n as TNode)), [tree, expanded, heldNow]);
  const tabId = rovingId(rows, focusId);
  // The first visible row for the current folder (a bookmark of it is not "the" current row).
  const currentId = current ? rows.find((r) => { const t = byId.get(r.id); return t && t.kind !== "bookmark" && t.node === current.node && t.path === current.path; })?.id : undefined;
  useEffect(() => {
    if (currentId) root.current?.querySelector<HTMLElement>(`[data-tid="${CSS.escape(currentId)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [currentId]);

  // Lazy scanning: whatever is open and visible gets a SWR feed (cached listing first, then revalidated).
  const wants = useMemo<Want[]>(() => {
    const out: Want[] = [];
    for (const r of rows) {
      const t = byId.get(r.id);
      if (!t?.load || !r.expanded || !t.node) continue;
      out.push(t.load === "mounts" ? { k: "m\0" + t.node, kind: "mounts", node: t.node, path: "" } : { k: listKey(t.node, t.path!), kind: "dir", node: t.node, path: t.path! });
      if (t.load === "dir") out.push({ k: duWant(t.node, t.path!), kind: "du", node: t.node, path: t.path! });
    }
    // Server rows show a size bar, so every online node's mounts are read, not only the expanded ones.
    for (const n of cluster) if (n.online && !out.some((w) => w.k === "m\0" + n.name)) out.push({ k: "m\0" + n.name, kind: "mounts", node: n.name, path: "" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, byId, nodes]);
  const onDirs = useCallback((k: string, l: Listing) => setListings((x) => (sameListing(x[k], l) ? x : { ...x, [k]: l })), []);
  const onMounts = useCallback((node: string, m: MountsState) => setMounts((x) => (sameMounts(x[node], m) ? x : { ...x, [node]: m })), []);

  const onDu = useCallback((k: string, e: Dus[string]) => setDus((x) => (k in x && x[k] === e ? x : { ...x, [k]: e })), []);

  const refresh = useCallback((t: TNode) => {
    if (t.kind === "section") nodesState.reload();
    else if (t.load === "mounts") void mutate(mountsKey(t.node!));
    else if (t.node && t.path) (void mutate(swrListKey(t.node, t.path)), void mutate(duKey(t.node, t.path)));
  }, [mutate, nodesState.reload]);

  const setExp = useCallback((id: string, open: boolean) => {
    const def = byId.get(id)?.defaultOpen ?? false;
    if (!open && byId.get(id)?.auto) setHeld((h) => hold(h, loc, id));
    setExpanded((s) => {
      const next = setOpen(s, id, open, def);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the choice lasts for this page view */
      }
      return next;
    });
  }, [byId, loc]);

  const focusRow = (id: string) => {
    setFocusId(id);
    wantFocus.current = true;
  };
  useLayoutEffect(() => {
    if (!wantFocus.current || !tabId) return;
    wantFocus.current = false;
    root.current?.querySelector<HTMLElement>(`[data-tid="${CSS.escape(tabId)}"]`)?.focus();
  });

  const open = (t: TNode, how: How, direct = false) => {
    if (t.kind === "section") return setExp(t.id, !openNow(t));
    if (t.kind === "trash") return onTrash(t.node!);
    if (t.offline) return;
    if (how === "here" && !direct && t.expandable && !openNow(t)) return setExp(t.id, true);
    onOpen(t.node!, t.path ?? "/", how);
  };

  const bookmarkOf = (t: TNode): Bookmark | null => (t.node && t.path && t.kind !== "trash" ? { node: t.node, path: t.path } : null);
  const menuItems = (t: TNode): MenuItem[] => {
    if (t.kind === "trash") return [{ label: "Open trash", onSelect: () => onTrash(t.node!) }];
    const b = bookmarkOf(t);
    if (!b) return [];
    const items: MenuItem[] = [
      { label: "Open here", disabled: t.offline, onSelect: () => onOpen(b.node, b.path, "here") },
      { label: "Open in new panel", hint: "Middle-click", disabled: t.offline, onSelect: () => onOpen(b.node, b.path, "panel") },
      "sep",
      isBookmarked(marks, b) ? { label: "Remove bookmark", onSelect: () => removeBookmark(b) } : { label: "Bookmark", onSelect: () => addBookmark(b) },
      { label: "Copy path", onSelect: () => void copyText(b.path).catch(() => undefined) },
    ];
    if (t.expandable && !t.offline) items.push({ label: "Refresh", onSelect: () => refresh(t) });
    if (t.kind === "node") items.push("sep", { label: "Open trash", onSelect: () => onTrash(b.node) });
    return items;
  };
  const showMenu = (t: TNode, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const items = menuItems(t);
    if (items.length) setMenu({ x: r.right - 8, y: r.bottom, items });
  };

  const onKeyDown = (e: React.KeyboardEvent, t: TNode) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      return showMenu(t, e.currentTarget as HTMLElement);
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const a = navigate(rows, t.id, e.key);
    if (!a) return;
    e.preventDefault();
    if (a.type === "focus") focusRow(a.id);
    else if (a.type === "expand") setExp(a.id, true);
    else if (a.type === "collapse") setExp(a.id, false);
    else if (a.type === "toggle") setExp(a.id, !openNow(t));
    else open(t, "here", true);
  };

  const renderRow = (t: TNode, level: number): React.ReactNode => {
    const isExp = t.expandable && openNow(t);
    const mark = bookmarkOf(t);
    const hasMenu = t.kind !== "section";
    const main = (
      <button
        type="button"
        role="treeitem"
        data-tid={t.id}
        aria-level={level}
        aria-expanded={t.expandable ? isExp : undefined}
        aria-disabled={t.offline || undefined}
        aria-current={t.id === currentId ? "page" : undefined}
        aria-keyshortcuts={hasMenu ? "Shift+F10" : undefined}
        tabIndex={tabId === t.id ? 0 : -1}
        className={"st-main" + (t.kind === "section" ? " st-sec" : "")}
        style={{ ["--lvl" as string]: level }}
        onFocus={() => setFocusId(t.id)}
        onKeyDown={(e) => onKeyDown(e, t)}
        onClick={(e) => {
          if ((e.target as Element).closest(".st-chev") && t.kind !== "section") return setExp(t.id, !isExp);
          open(t, e.ctrlKey || e.metaKey ? "panel" : "here");
        }}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
        }}
        onAuxClick={(e) => {
          if (e.button !== 1 || t.kind === "section") return;
          e.preventDefault();
          if (t.kind !== "trash" && !t.offline) onOpen(t.node!, t.path ?? "/", "panel");
        }}
        onContextMenu={(e) => {
          if (!hasMenu) return;
          e.preventDefault();
          const items = menuItems(t);
          if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
        }}
      >
        <span className="st-line">
          {Array.from({ length: level - 1 }, (_, i) => <span key={i} className="st-guide" aria-hidden="true" />)}
          <span className={"st-chev" + (t.expandable ? "" : " none") + (isExp ? " open" : "")} aria-hidden="true">{t.expandable && <ChevronRight />}</span>
          <span className="st-icon" aria-hidden="true">{t.icon}</span>
          <span className="st-label">{t.label}</span>
          {t.extra}
          {known(t.size) && <span className="muted st-sub">{fmtSize(known(t.size)!.used)}</span>}
        </span>
        {(t.usage ?? known(t.size)) && <UsageBar usage={(t.usage ?? known(t.size))!} />}
      </button>
    );
    return (
      <li key={t.id} role="none" className={"st-item" + (t.kind === "section" ? " sec" : "")}>
        <div className={"st-row" + (tabId === t.id ? " cur" : "") + (t.id === currentId ? " here" : "") + (t.offline ? " off" : "")}>
          {t.tip || t.usage || t.size ? <Tip label={<Popover t={t} />} besideOf=".side" when={(w) => !!t.usage || !!t.size || truncated(w)}>{main}</Tip> : main}
          {hasMenu && (
            <Tip label="Actions">
              <button type="button" className="st-more" tabIndex={-1} aria-label={`Actions for ${t.label}`} aria-hidden="true" disabled={!mark && t.kind !== "trash"} onClick={(e) => showMenu(t, e.currentTarget)}><Ellipsis /></button>
            </Tip>
          )}
        </div>
        {isExp && (t.children?.length || t.note) ? (
          <ul role="group" className="st-group">
            {t.children?.map((c) => renderRow(c, level + 1))}
            {t.note?.kind === "skeleton" && <SkeletonTreeRows level={level + 1} />}
            {t.note && t.note.kind !== "skeleton" && (
              <li role="treeitem" aria-level={level + 1} aria-disabled={t.note.kind === "error" ? undefined : "true"} className={"st-note " + t.note.kind} style={{ ["--lvl" as string]: level }}>
                <span role={t.note.kind === "error" ? "alert" : undefined}>{t.note.text}</span>
                {t.note.kind === "error" && <button type="button" className="st-retry" onClick={() => refresh(t)}>Retry</button>}
              </li>
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <ul role="tree" aria-label="Navigation" className="st-tree" ref={root} aria-busy={nodesView === "loading" || undefined}>
        {tree.map((t) => renderRow(t, 1))}
      </ul>
      {wants.map((w) => <Feed key={w.k} want={w} onDirs={onDirs} onMounts={onMounts} onDu={onDu} />)}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
