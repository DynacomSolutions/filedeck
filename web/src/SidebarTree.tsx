import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Ellipsis, FolderClosed, HardDrive, Network, Server, Star, Trash2 } from "lucide-react";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { addBookmark, bookmarkLabel, isBookmarked, removeBookmark, useBookmarks, type Bookmark } from "./bookmarks";
import { copyText } from "./clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Tip } from "./Tooltip";
import { EXPANDED_KEY, flatten, isOpen, navigate, parseExpanded, rovingId, setOpen, type ExpandState, type TreeNodeBase } from "./sidebarTree";

export type How = "here" | "panel";

type Listing = { status: "loading" } | { status: "ready"; dirs: Entry[]; truncated: boolean } | { status: "error"; error: string };
type MountsState = { status: "loading" } | { status: "ready"; mounts: Mount[] } | { status: "error"; error: string };

interface TNode extends TreeNodeBase {
  kind: "section" | "node" | "mount" | "dir" | "bookmark" | "trash";
  label: string;
  icon: React.ReactNode;
  /** where the row points; sections have none */
  node?: string;
  path?: string;
  defaultOpen: boolean;
  tip?: string;
  extra?: React.ReactNode;
  children?: TNode[];
  /** what to fetch when the row is open and nothing is loaded yet */
  load?: "dir" | "mounts";
  /** inline note under the children */
  note?: { kind: "loading" | "error" | "empty" | "more"; text: string };
  offline?: boolean;
}

const listKey = (node: string, path: string) => node + "\0" + path;
const dirsOf = (entries: Entry[]) => entries.filter((e) => e.type === "dir" || (e.type === "symlink" && e.linkDir)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
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
 * Interaction: each row is a single button. Clicking the label opens the folder in the active panel (and expands it if
 * closed, never collapses); clicking the small chevron only toggles. Ctrl/Cmd or middle click opens in a new panel.
 * The trailing "..." button (and Shift+F10 / the Menu key on the focused row) opens the action menu.
 */
/** Tooltip only when the row's label is cut off. */
const truncated = (wrap: HTMLElement) => [...wrap.querySelectorAll<HTMLElement>(".st-label,.st-sub")].some((el) => el.scrollWidth > el.clientWidth);

export function SideTree({ nodes, onOpen, onTrash }: { nodes: NodeInfo[]; onOpen: (node: string, path: string, how: How) => void; onTrash: (node: string) => void }) {
  const [expanded, setExpanded] = useState<ExpandState>(loadStored);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [mounts, setMounts] = useState<Record<string, MountsState>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const marks = useBookmarks();
  const root = useRef<HTMLUListElement>(null);
  const asked = useRef(new Set<string>());
  const wantFocus = useRef(false);

  const cluster = nodes.filter((n) => n.kind !== "source");
  const network = nodes.filter((n) => n.kind === "source");

  const tree = useMemo<TNode[]>(() => {
    const dirNode = (parent: string, node: string, path: string, e?: Entry, fixedId?: string): TNode => {
      const id = fixedId ?? `${parent}›${path}`;
      const name = e?.name ?? path;
      const open = isOpen(expanded, id, false);
      const t: TNode = { id, kind: "dir", label: name, icon: <FolderClosed />, node, path, expandable: true, defaultOpen: false, tip: `${node}:${path}`, load: "dir" };
      if (open) fill(t);
      return t;
    };
    /** Children and status note of a folder row, from whatever is cached. */
    function fill(t: TNode) {
      const l = listings[listKey(t.node!, t.path!)];
      if (!l || l.status === "loading") t.note = { kind: "loading", text: "Scanning..." };
      else if (l.status === "error") t.note = { kind: "error", text: l.error };
      else {
        t.children = l.dirs.map((e) => dirNode(t.id, t.node!, e.path, e));
        if (!l.dirs.length) t.note = { kind: "empty", text: "No subfolders" };
        else if (l.truncated) t.note = { kind: "more", text: "More folders not shown" };
      }
    }
    const nodeRow = (n: NodeInfo): TNode => {
      const id = "n:" + n.name;
      const t: TNode = { id, kind: "node", label: n.name, icon: <span className={"dot " + (n.online ? "on" : "off")} aria-hidden="true" />, node: n.name, path: "/", expandable: n.online, defaultOpen: false, offline: !n.online, tip: n.online ? undefined : "Offline" };
      if (!n.online || !isOpen(expanded, id, false)) return t;
      const m = mounts[n.name];
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
              <span className="st-bar" aria-label={`${x.total ? Math.round((x.used / x.total) * 100) : 0}% used`}><i style={{ width: `${x.total ? Math.round((x.used / x.total) * 100) : 0}%` }} /></span>
            </>
          );
          kids.push(mt);
        }
      t.children = kids;
      t.load = "mounts";
      if (!m || m.status === "loading") t.note = { kind: "loading", text: "Reading mounts..." };
      else if (m.status === "error") t.note = { kind: "error", text: m.error };
      return t;
    };
    const section = (id: string, label: string, icon: React.ReactNode, kids: TNode[], empty: string): TNode => ({ id, kind: "section", label, icon, expandable: true, defaultOpen: true, children: kids, note: kids.length ? undefined : { kind: "empty", text: empty } });
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
      section("sec:bookmarks", "Bookmarks", <Star />, marks.map(bookmarkRow), "Star a folder to keep it here."),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, expanded, listings, mounts, marks]);

  const byId = useMemo(() => {
    const m = new Map<string, TNode>();
    const walk = (l: TNode[]) => l.forEach((n) => (m.set(n.id, n), n.children && walk(n.children)));
    walk(tree);
    return m;
  }, [tree]);
  const rows = useMemo(() => flatten(tree, (n) => isOpen(expanded, n.id, (n as TNode).defaultOpen)), [tree, expanded]);
  const tabId = rovingId(rows, focusId);

  // Lazy scanning: whatever is open and visible but not loaded yet gets fetched once.
  useEffect(() => {
    for (const r of rows) {
      const t = byId.get(r.id);
      if (!t?.load || !r.expanded || !t.node) continue;
      if (t.load === "mounts") {
        const k = "m\0" + t.node;
        if (asked.current.has(k)) continue;
        asked.current.add(k);
        const node = t.node;
        setMounts((m) => ({ ...m, [node]: { status: "loading" } }));
        api.mounts(node).then((x) => setMounts((m) => ({ ...m, [node]: { status: "ready", mounts: x.mounts } })), (e) => setMounts((m) => ({ ...m, [node]: { status: "error", error: msg(e) } })));
      } else {
        const k = listKey(t.node, t.path!);
        if (asked.current.has(k)) continue;
        asked.current.add(k);
        const node = t.node;
        const path = t.path!;
        setListings((l) => ({ ...l, [k]: { status: "loading" } }));
        api.list(node, path, false).then((x) => setListings((l) => ({ ...l, [k]: { status: "ready", dirs: dirsOf(x.entries), truncated: x.truncated } })), (e) => setListings((l) => ({ ...l, [k]: { status: "error", error: msg(e) } })));
      }
    }
  }, [rows, byId]);

  const refresh = useCallback((t: TNode) => {
    if (t.load === "mounts") {
      asked.current.delete("m\0" + t.node);
      setMounts((m) => {
        const { [t.node!]: _drop, ...rest } = m;
        return rest;
      });
    } else if (t.node && t.path) {
      const k = listKey(t.node, t.path);
      asked.current.delete(k);
      setListings((l) => {
        const { [k]: _drop, ...rest } = l;
        return rest;
      });
    }
  }, []);

  const setExp = useCallback((id: string, open: boolean) => {
    const def = byId.get(id)?.defaultOpen ?? false;
    setExpanded((s) => {
      const next = setOpen(s, id, open, def);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the choice lasts for this page view */
      }
      return next;
    });
  }, [byId]);

  const focusRow = (id: string) => {
    setFocusId(id);
    wantFocus.current = true;
  };
  useLayoutEffect(() => {
    if (!wantFocus.current || !tabId) return;
    wantFocus.current = false;
    root.current?.querySelector<HTMLElement>(`[data-tid="${CSS.escape(tabId)}"]`)?.focus();
  });

  const open = (t: TNode, how: How) => {
    if (t.kind === "section") return setExp(t.id, !isOpen(expanded, t.id, true));
    if (t.kind === "trash") return onTrash(t.node!);
    if (t.offline) return;
    onOpen(t.node!, t.path ?? "/", how);
    if (t.expandable && !isOpen(expanded, t.id, false)) setExp(t.id, true);
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
    else if (a.type === "toggle") setExp(a.id, !isOpen(expanded, a.id, t.defaultOpen));
    else open(t, "here");
  };

  const renderRow = (t: TNode, level: number): React.ReactNode => {
    const isExp = t.expandable && isOpen(expanded, t.id, t.defaultOpen);
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
        aria-keyshortcuts={hasMenu ? "Shift+F10" : undefined}
        tabIndex={tabId === t.id ? 0 : -1}
        className={"st-main" + (t.kind === "section" ? " st-sec" : "")}
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
        {Array.from({ length: level - 1 }, (_, i) => <span key={i} className="st-guide" aria-hidden="true" />)}
        <span className={"st-chev" + (t.expandable ? "" : " none") + (isExp ? " open" : "")} aria-hidden="true">{t.expandable && <ChevronRight />}</span>
        <span className="st-icon" aria-hidden="true">{t.icon}</span>
        <span className="st-label">{t.label}</span>
        {t.extra}
      </button>
    );
    return (
      <li key={t.id} role="none" className={"st-item" + (t.kind === "section" ? " sec" : "")}>
        <div className={"st-row" + (tabId === t.id ? " cur" : "") + (t.offline ? " off" : "")}>
          {t.tip ? <Tip label={t.tip} besideOf=".side" when={truncated}>{main}</Tip> : main}
          {hasMenu && (
            <Tip label="Actions">
              <button type="button" className="st-more" tabIndex={-1} aria-label={`Actions for ${t.label}`} aria-hidden="true" disabled={!mark && t.kind !== "trash"} onClick={(e) => showMenu(t, e.currentTarget)}><Ellipsis /></button>
            </Tip>
          )}
        </div>
        {isExp && (t.children?.length || t.note) ? (
          <ul role="group" className="st-group">
            {t.children?.map((c) => renderRow(c, level + 1))}
            {t.note && (
              <li role="treeitem" aria-level={level + 1} aria-disabled="true" className={"st-note " + t.note.kind} style={{ ["--lvl" as string]: level }}>
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
      <ul role="tree" aria-label="Navigation" className="st-tree" ref={root}>
        {tree.map((t) => renderRow(t, 1))}
      </ul>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
