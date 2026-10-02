import { brand } from "./brand";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { FilePanel } from "./FilePanel";
import { MAX_TABS, DEFAULT_UI, decodeState, encodeState, leaves, maxId, syncTree, type FolderState, type Leaf, type Tree, type TrashState } from "./urlState";
import type { FileRef } from "./EditorViews";

// Monaco (several MB) lives in its own chunks, fetched on first use.
const DiffViewer = lazy(() => import("./EditorViews").then((m) => ({ default: m.DiffViewer })));
import { JobsTray } from "./Jobs";
import { useBookmarks, removeBookmark, bookmarkLabel } from "./bookmarks";
import { ThemeMenu } from "./ThemeMenu";
import { ShortcutHelp } from "./Shortcuts";
import { TrashBrowser } from "./Trash";
import { CompareCtx, CompareInfo, SyncDialog, useCompare } from "./Compare";
import { SelectionBar, type SelRef } from "./Selection";
import { ChevronDown, ChevronRight, GitCompareArrows, Keyboard, Star, X } from "lucide-react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Tip } from "./Tooltip";
import { PANEL_MIME, dockPanel, keyDock, pickZone, type DropZone } from "./dock";
import * as Ic from "lucide-react";

/** Wraps a panel as a drop target: while another panel is dragged, shows where it would dock (edge = split there, centre = merge as a tab). */
function DockSlot({ id, dragging, onDock, children }: { id: string; dragging: string | null; onDock: (src: string, target: string, zone: DropZone) => void; children: React.ReactNode }) {
  const [zone, setZone] = useState<DropZone | null>(null);
  const foreign = dragging !== null && dragging !== id;
  const pick = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return pickZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  return (
    <div
      className="dock-slot"
      data-dock-slot={id}
      onDragOver={(e) => {
        if (!foreign || !e.dataTransfer.types.includes(PANEL_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setZone(pick(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={(e) => {
        if (!foreign || !e.dataTransfer.types.includes(PANEL_MIME)) return;
        e.preventDefault();
        const src = e.dataTransfer.getData(PANEL_MIME);
        const z = pick(e);
        setZone(null);
        if (src) onDock(src, id, z);
      }}
    >
      {children}
      {foreign && zone && <div className={"dock-drop dock-drop-" + zone} aria-hidden="true" />}
    </div>
  );
}

// Restored from the URL before first render so panel ids keep matching.
const initial = decodeState(window.location.search);
let seq = initial ? maxId(initial.tree) + 1 : 1;
const id = () => `p${seq++}`;
const leaf = (node: string, path = "/"): Leaf => ({ kind: "leaf", id: id(), node, path });

const mapTree = (t: Tree, fn: (l: Leaf) => Tree | null): Tree | null => {
  if (t.kind === "leaf") return fn(t);
  const children = t.children.map((c) => mapTree(c, fn)).filter((c): c is Tree => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] as Tree;
  return { ...t, children };
};
const count = (t: Tree): number => (t.kind === "leaf" ? 1 : t.children.reduce((n, c) => n + count(c), 0));

interface HState {
  idx: number;
  /** panel whose navigation created this entry ("init" for the first) */
  panel: string;
  /** every panel's node/path right after that navigation */
  paths: Record<string, { node: string; path: string; ti?: number }>;
}
const pathsOf = (t: Tree) => Object.fromEntries(leaves(t).map((l) => [l.id, { node: l.node, path: l.path, ti: l.ti ?? 0 }]));

/**
 * The URL always reflects the full app state. A folder change in a panel pushes a
 * history entry tagged with that panel; everything else (layout, sizes, selection,
 * preview, editor) replaces the current entry. Back/forward only walks the entries
 * made by the focused panel and restores that panel's own folder.
 */
function useUrlHistory(tree: Tree | null, active: string, diff: { left: FileRef; right: FileRef } | null, folder: FolderState | null, trash: TrashState | null, panelSel: string[], setTree: React.Dispatch<React.SetStateAction<Tree | null>>, setStatus: (m: string) => void) {
  const cur = useRef<HState | null>((history.state as HState | null) && typeof (history.state as HState).idx === "number" ? (history.state as HState) : null);
  const prev = useRef<Record<string, { node: string; path: string; ti?: number }> | null>(null);
  const fromPop = useRef(false);
  const latest = useRef({ active, url: "", paths: {} as HState["paths"] });
  latest.current.active = active;

  useEffect(() => {
    if (!tree) return;
    const paths = pathsOf(tree);
    const url = encodeState({ tree, active, ...(diff ? { diff } : {}), ...(folder ? { folder } : {}), ...(trash ? { trash } : {}), ...(panelSel.length ? { panelSel } : {}) });
    latest.current.url = url;
    latest.current.paths = paths;
    let changed: string | undefined;
    if (prev.current && !fromPop.current) changed = Object.keys(paths).find((k) => prev.current![k] && prev.current![k]!.ti === paths[k]!.ti && (prev.current![k]!.node !== paths[k]!.node || prev.current![k]!.path !== paths[k]!.path));
    prev.current = paths;
    fromPop.current = false;
    try {
      if (changed && cur.current) {
        const st: HState = { idx: cur.current.idx + 1, panel: changed, paths };
        history.pushState(st, "", url);
        cur.current = st;
      } else {
        const old = cur.current;
        const keep = old ? Object.fromEntries(Object.entries(old.paths).filter(([k]) => k in paths)) : {};
        const st: HState = { idx: old?.idx ?? 0, panel: old?.panel ?? "init", paths: { ...paths, ...keep } };
        history.replaceState(st, "", url);
        cur.current = st;
      }
    } catch {
      /* history unavailable (sandboxed frame) */
    }
  }, [tree, active, diff, folder, trash, panelSel]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const arrival = e.state as HState | null;
      const departed = cur.current;
      if (!arrival || typeof arrival.idx !== "number" || !departed) return;
      cur.current = arrival;
      const focused = latest.current.active;
      const back = arrival.idx < departed.idx;
      const owner = back ? departed.panel : arrival.panel;
      if (owner !== focused) {
        // Not the focused panel's entry: step over it without touching anything.
        if (back ? arrival.idx > 0 : true) history.go(back ? -1 : 1);
        else history.replaceState({ ...arrival, paths: arrival.paths }, "", latest.current.url);
        return;
      }
      const target = arrival.paths[focused];
      if (!target) return;
      fromPop.current = true;
      setTree((t) => {
        if (!t) return t;
        const go = (n: Tree): Tree => (n.kind === "leaf" ? (n.id === focused ? { ...n, node: target.node, path: target.path, sel: undefined, closed: undefined } : n) : { ...n, children: n.children.map(go) });
        return syncTree(go(t));
      });
      setStatus(`${back ? "Back" : "Forward"}: ${target.node}:${target.path}`);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setTree, setStatus]);
}

type How = "here" | "panel" | "tab";

function Sidebar({ nodes, onOpen, onTrash, footer }: { nodes: NodeInfo[]; onOpen: (node: string, path: string, how: How) => void; onTrash: (node: string) => void; footer: React.ReactNode }) {
  const [mounts, setMounts] = useState<Record<string, Mount[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const load = (n: string) => {
    if (!mounts[n]) api.mounts(n).then((r) => setMounts((m) => ({ ...m, [n]: r.mounts }))).catch(() => setMounts((m) => ({ ...m, [n]: [] })));
  };
  const toggle = (n: string) => {
    setOpen((o) => ({ ...o, [n]: !o[n] }));
    load(n);
  };
  const cluster = nodes.filter((n) => n.kind !== "source");
  const network = nodes.filter((n) => n.kind === "source");
  const marks = useBookmarks();
  /** Plain click: the active panel goes there. Middle or Ctrl/Cmd+click: a new panel beside it. Right-click: the context menu. Never a popup on a plain click. */
  const link = (node: string, path: string, then?: () => void) => ({
    onClick: (e: React.MouseEvent) => {
      onOpen(node, path, e.ctrlKey || e.metaKey ? "panel" : "here");
      then?.();
    },
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      onOpen(node, path, "panel");
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Open here", onSelect: () => onOpen(node, path, "here") },
          { label: "Open in new panel", hint: "Middle-click", onSelect: () => onOpen(node, path, "panel") },
          { label: "Open in new tab", onSelect: () => onOpen(node, path, "tab") },
        ],
      });
    },
  });
  return (
    <aside className="side">
      <div className="side-brand">
        <span className="brand-name">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M8 3h8M5.5 6.5h13" />
            <path d="M3 19v-8a1 1 0 0 1 1-1h4a1 1 0 0 1 .7.3L10.5 12H20a1 1 0 0 1 1 1v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          {brand.name}
        </span>
      </div>
      <div className="side-scroll">
      <h2>Bookmarks</h2>
      {marks.length === 0 && <p className="muted side-hint">Star a folder to keep it here.</p>}
      <ul className="marks">
        {marks.map((b) => (
          <li key={b.node + "\0" + b.path}>
            <Tip label={`${b.node}:${b.path}`}>
              <button className="mark-open" {...link(b.node, b.path)}>
                <Star className="mark-star" fill="currentColor" /> {bookmarkLabel(b)} <span className="muted mark-node">{b.node}</span>
              </button>
            </Tip>
            <Tip label="Remove bookmark">
              <button className="mark-rm" onClick={() => removeBookmark(b)} aria-label={`Remove bookmark ${b.node}:${b.path}`}><X /></button>
            </Tip>
          </li>
        ))}
      </ul>
      <h2>Nodes</h2>
      {cluster.map((n) => (
        <div key={n.name}>
          <div className="side-row">
            <button className="side-twisty" aria-expanded={!!open[n.name]} aria-label={`${open[n.name] ? "Collapse" : "Expand"} ${n.name}`} onClick={() => toggle(n.name)}>{open[n.name] ? <ChevronDown /> : <ChevronRight />}</button>
            <button className="side-node" {...link(n.name, "/", () => { setOpen((o) => ({ ...o, [n.name]: true })); load(n.name); })}>
              <span className={"dot " + (n.online ? "on" : "off")} /> {n.name}
            </button>
          </div>
          {open[n.name] && (
            <ul className="mounts">
              <li><button {...link(n.name, "/")}><Ic.HardDrive /> / (root)</button></li>
              <li><button onClick={() => onTrash(n.name)}><Ic.Trash2 /> Trash</button></li>
              {(mounts[n.name] ?? []).map((m) => (
                <li key={m.mountpoint}>
                  <Tip label={`${m.device} (${m.fstype})${m.network ? " - network drive" : ""}${m.unreachable ? " - not responding" : ""}${m.readOnly ? " - read-only" : ""}`}>
                  <button {...link(n.name, m.mountpoint)}>
                    <Ic.HardDrive /> {m.mountpoint}
                    {m.network && <span className={"net-badge" + (m.unreachable ? " bad" : "")}>{m.netKind ?? "network"}</span>}
                    {m.readOnly && <span className="net-badge">read-only</span>}
                    <span className="bar"><i style={{ width: `${m.total ? Math.round((m.used / m.total) * 100) : 0}%` }} /></span>
                  </button>
                  </Tip>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!cluster.length && <p className="muted">No nodes</p>}
      {network.length > 0 && <h2>Network</h2>}
      {network.map((n) => (
        <Tip key={n.name} label={`${n.type ?? "network"} ${n.host ?? ""}${n.online ? "" : " - unreachable"}`}>
          <button className="side-node" {...link(n.name, "/")}>
            <span className={"dot " + (n.online ? "on" : "off")} /> <Ic.Network /> {n.name}
            <span className="net-badge">{(n.type ?? "net").toUpperCase()}</span>
          </button>
        </Tip>
      ))}
      </div>
      {footer}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}

export function App() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [tree, setTree] = useState<Tree | null>(initial?.tree ?? null);
  const [activeId, setActiveId] = useState(initial?.active ?? "");
  const [status, setStatus] = useState("");
  const [trash, setTrash] = useState<TrashState | null>(initial?.trash ?? null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest("input,textarea,select,[contenteditable=true],.monaco-editor")) return;
      e.preventDefault();
      setHelp(true);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const [diff, setDiff] = useState<{ left: FileRef; right: FileRef } | null>(initial?.diff ?? null);
  const [diffMark, setDiffMark] = useState<FileRef | null>(null);
  const onDiff = (files: FileRef[]) => {
    if (files.length === 2) {
      setDiff({ left: files[0]!, right: files[1]! });
      setDiffMark(null);
    } else if (files.length === 1) {
      const f = files[0]!;
      if (diffMark && !(diffMark.node === f.node && diffMark.path === f.path)) {
        setDiff({ left: diffMark, right: f });
        setDiffMark(null);
      } else if (diffMark) {
        setDiffMark(null);
        setStatus("Diff mark cleared");
      } else {
        setDiffMark(f);
        setStatus(`Marked ${f.path} for diff; select another file and press the diff button`);
      }
    }
  };
  // In-place folder compare between two panels; its state (roots, options, folder, filters) is mirrored into the URL.
  const [compare, setCompare] = useState<FolderState | null>(initial?.folder ?? null);

  // Selection across panels: each panel reports its own, plain clicks clear the others, header clicks pick whole panels.
  const [sels, setSels] = useState<Record<string, SelRef[]>>({});
  const [panelSel, setPanelSel] = useState<string[]>(initial?.panelSel ?? []);
  const [clearReq, setClearReq] = useState<{ except: string; n: number } | null>(null);
  const reportSel = useCallback((pid: string, refs: SelRef[]) => {
    setSels((m) => {
      const old = m[pid] ?? [];
      if (old.length === refs.length && old.every((o, i) => o.node === refs[i]!.node && o.path === refs[i]!.path)) return m;
      const n = { ...m };
      if (refs.length) n[pid] = refs;
      else delete n[pid];
      return n;
    });
  }, []);
  const clearOthers = useCallback((pid: string) => {
    setClearReq((c) => ({ except: pid, n: (c?.n ?? 0) + 1 }));
    setPanelSel((p) => (p.length ? [] : p));
  }, []);
  const togglePanel = useCallback((pid: string) => setPanelSel((p) => (p.includes(pid) ? p.filter((x) => x !== pid) : [...p, pid])), []);

  useEffect(() => {
    const load = () => api.nodes().then((r) => setNodes(r.nodes)).catch(() => setNodes([]));
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (tree || !nodes.length) return;
    const cluster = nodes.filter((n) => n.kind !== "source");
    const l = leaf(((cluster.length ? cluster : nodes).find((n) => n.online) ?? nodes[0])!.name);
    setTree(l);
    setActiveId(l.id);
  }, [nodes, tree]);

  // Panels that no longer exist leave the cross-panel selection.
  useEffect(() => {
    if (!tree) return;
    const ids = new Set(leaves(tree).map((l) => l.id));
    setSels((m) => (Object.keys(m).every((k) => ids.has(k)) ? m : Object.fromEntries(Object.entries(m).filter(([k]) => ids.has(k)))));
    setPanelSel((p) => (p.every((k) => ids.has(k)) ? p : p.filter((k) => ids.has(k))));
  }, [tree]);

  useUrlHistory(tree, activeId, diff, compare, trash, panelSel, setTree, setStatus);

  const update = (fn: (l: Leaf) => Tree | null) => setTree((t) => { const m = t ? mapTree(t, fn) : t; return m ? syncTree(m) : m; });
  const patchLeaf = (lid: string, p: Partial<Leaf>) => update((l) => (l.id === lid ? { ...l, ...p } : l));
  const leafOf = (lid: string) => (tree ? leaves(tree).find((l) => l.id === lid) : undefined);
  const cmp = useCompare({ state: compare, setState: setCompare, leafOf, patchLeaf, activeId, onFileDiff: (l, r) => setDiff({ left: l, right: r }), onStatus: setStatus });
  const startCompare = (a: string, b: string) => {
    const la = leafOf(a);
    const lb = leafOf(b);
    if (!la || !lb || a === b) return;
    setCompare({ left: { node: la.node, path: la.path }, right: { node: lb.node, path: lb.path }, opts: DEFAULT_UI, preset: "", lp: a, rp: b, rel: "", hide: [] });
    setPanelSel([]);
    setStatus(`Comparing ${la.node}:${la.path} with ${lb.node}:${lb.path}`);
  };
  // "Compare panels" from the header or the selection bar: two picked panels, else the only two panels,
  // else the focused panel against one chosen from a small menu.
  const [cmpMenu, setCmpMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const panelCount = tree ? leaves(tree).length : 0;
  const compareWhyNot = panelCount < 2 ? "Compare needs two panels: open a second one with a Split button in a panel header." : null;
  const compareClick = (e: React.MouseEvent) => {
    if (!tree || compareWhyNot) return;
    const all = leaves(tree);
    const picked = panelSel.filter((p) => all.some((l) => l.id === p));
    if (picked.length === 2) return startCompare(picked[0]!, picked[1]!);
    const anchor = picked.length === 1 ? picked[0]! : all.some((l) => l.id === activeId) ? activeId : all[0]!.id;
    const others = all.filter((l) => l.id !== anchor);
    if (others.length === 1) return startCompare(anchor, others[0]!.id);
    const al = all.find((l) => l.id === anchor)!;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCmpMenu({ x: r.left, y: r.bottom + 2, items: others.map((l): MenuItem => ({ label: `Compare ${al.node}:${al.path} with ${l.node}:${l.path}`, onSelect: () => startCompare(anchor, l.id) })) });
  };
  const patchSizes = (sid: string, sizes: number[]) =>
    setTree((t) => {
      const go = (n: Tree): Tree => (n.kind === "leaf" ? n : n.id === sid ? { ...n, sizes } : { ...n, children: n.children.map(go) });
      return t ? go(t) : t;
    });
  const navigate = (lid: string) => (node: string, path: string) => update((l) => (l.id === lid ? { ...l, node, path, sr: undefined } : l));
  const openInActive = (node: string, path: string) => update((l) => (l.id === activeId ? { ...l, node, path, sr: undefined } : l));
  /** A new panel split beside the given one (default: the active one) at node:path, optionally with a file selected there. */
  const openPanel = (node: string, path: string, select?: string, beside = activeId) => {
    const fresh: Leaf = { kind: "leaf", id: id(), node, path, ...(select ? { sel: select } : {}) };
    update((l) => (l.id === beside ? { kind: "split", id: id(), dir: "horizontal", children: [l, fresh] } : l));
    setActiveId(fresh.id);
  };
  /** A new tab in the active panel. */
  const openTab = (node: string, path: string) =>
    update((l) => {
      if (l.id !== activeId) return l;
      const tabs = l.tabs ?? [{ node: l.node, path: l.path }];
      if (tabs.length >= MAX_TABS) {
        setStatus(`At most ${MAX_TABS} tabs per panel`);
        return l;
      }
      const ti = l.ti ?? 0;
      return { ...l, tabs: [...tabs.slice(0, ti + 1), { node, path }, ...tabs.slice(ti + 1)], ti: ti + 1, node, path, sel: undefined, sels: undefined, closed: undefined, sr: undefined, q: undefined };
    });
  const openFromSide = (node: string, path: string, how: How) => (how === "panel" ? openPanel(node, path) : how === "tab" ? openTab(node, path) : openInActive(node, path));
  const split = (lid: string) => (dir: "horizontal" | "vertical") =>
    update((l) => (l.id === lid ? { kind: "split", id: id(), dir, children: [l, leaf(l.node, l.path)] } : l));

  const [dragId, setDragId] = useState<string | null>(null);
  const dock = (src: string, target: string, zone: DropZone): boolean => {
    const next = tree ? dockPanel(tree, src, target, zone, id) : null;
    if (!next) {
      setStatus(zone === "center" ? `Cannot merge: at most ${MAX_TABS} tabs per panel` : "Cannot move the panel there");
      return false;
    }
    setTree(syncTree(next));
    setActiveId(src);
    setStatus(zone === "center" ? "Merged panel as tabs" : `Moved panel to the ${zone}`);
    return true;
  };
  const dragProps = (lid: string): React.HTMLAttributes<HTMLElement> => ({
    draggable: true,
    onDragStart: (e) => {
      // inputs and the tab strip keep their own text/drag behaviour
      if ((e.target as Element).closest("input,textarea,select,.fp-tab")) return;
      e.dataTransfer.setData(PANEL_MIME, lid);
      e.dataTransfer.effectAllowed = "move";
      setDragId(lid);
    },
    onDragEnd: () => setDragId(null),
  });
  const onKeyDock = (lid: string) => (key: string): boolean => {
    const r = tree && keyDock(leaves(tree).map((l) => l.id), lid, key);
    if (!r) return true;
    if (dock(lid, r.target, r.zone)) setTimeout(() => document.querySelector<HTMLElement>(`[data-fp="${lid}"]`)?.focus(), 0);
    return true;
  };
  const switchPanel = (from: string, dir: 1 | -1): boolean => {
    if (!tree) return false;
    const all = leaves(tree);
    const i = all.findIndex((l) => l.id === from);
    const to = all[i + dir];
    if (!to) return false;
    setActiveId(to.id);
    setTimeout(() => document.querySelector<HTMLElement>(`[data-fp="${to.id}"]`)?.focus(), 0);
    return true;
  };
  const render = (t: Tree, total: number): React.ReactNode => {
    if (t.kind === "leaf") {
      const all = leaves(tree!);
      const nx = all.length > 1 ? all[(all.findIndex((l) => l.id === t.id) + 1) % all.length] : undefined;
      return (
        <DockSlot id={t.id} dragging={dragId} onDock={dock}>
        <FilePanel
          dragProps={dragProps(t.id)}
          onDock={onKeyDock(t.id)}
          leaf={t}
          active={t.id === activeId}
          onFocus={() => setActiveId(t.id)}
          onNavigate={navigate(t.id)}
          onOpenPanel={(n, p, sel) => openPanel(n, p, sel, t.id)}
          onSplit={split(t.id)}
          onPatch={(p) => patchLeaf(t.id, p)}
          onClose={total > 1 ? () => update((l) => (l.id === t.id ? null : l)) : null}
          onDiff={onDiff}
          diffMarked={diffMark !== null}
          onCompare={(peer) => startCompare(t.id, peer)}
          others={Object.entries(sels).filter(([k]) => k !== t.id).flatMap(([, v]) => v)}
          panelPicked={panelSel.includes(t.id)}
          clearReq={clearReq}
          onSelection={(refs) => reportSel(t.id, refs)}
          onClearOthers={() => clearOthers(t.id)}
          onTogglePanel={() => togglePanel(t.id)}
          next={nx ? { node: nx.node, path: nx.path } : null}
          onSwitch={(d) => switchPanel(t.id, d)}
          onHelp={() => setHelp(true)}
          onTrash={(node) => setTrash({ node, volume: "" })}
          peers={leaves(tree!).filter((l) => l.id !== t.id).map((l) => ({ id: l.id, node: l.node, path: l.path, sel: l.sel, picked: panelSel.includes(l.id) }))}
          onStatus={setStatus}
        />
        </DockSlot>
      );
    }
    return (
      <Group
        key={t.id + ":" + t.children.map((c) => c.id).join(",")}
        orientation={t.dir}
        id={t.id}
        defaultLayout={t.sizes && t.sizes.length === t.children.length ? Object.fromEntries(t.children.map((c, i) => [c.id, t.sizes![i]!])) : undefined}
        onLayoutChanged={(l) => {
          const sizes = t.children.map((c) => l[c.id] ?? 0);
          if (!t.sizes || sizes.some((x, i) => Math.abs(x - (t.sizes![i] ?? 0)) > 0.5)) patchSizes(t.id, sizes);
        }}
      >
        {t.children.flatMap((c, i) => [
          i > 0 ? <Separator key={c.id + "s"} className={"sep " + t.dir} /> : null,
          <Panel key={c.id} id={c.id} minSize="10%">
            {render(c, total)}
          </Panel>,
        ])}
      </Group>
    );
  };

  return (
    <div className="app">
      <CompareCtx.Provider value={cmp}>
      <Sidebar nodes={nodes} onOpen={openFromSide} onTrash={(node) => setTrash({ node, volume: "" })} footer={<><CompareInfo /><div className="side-status" role="status"><Tip label={status || "No messages"} fill><span>{status}</span></Tip></div><JobsTray nodes={nodes} /><ThemeMenu /></>} />
      <div className="app-col">
      <header className="site-header">
        <div className="site-header__inner">
          <SelectionBar
            refs={Object.values(sels).flat()}
            panelCount={Object.keys(sels).length}
            picked={panelSel}
            dests={tree ? leaves(tree).map((l) => ({ id: l.id, node: l.node, path: l.path })) : []}
            onClear={() => {
              setClearReq((c) => ({ except: "", n: (c?.n ?? 0) + 1 }));
              setPanelSel([]);
            }}
            onDiff={(a, b) => setDiff({ left: { node: a.node, path: a.path }, right: { node: b.node, path: b.path } })}
            onStatus={setStatus}
          />
          <div className="site-header__actions">
            {diffMark && (
              <Tip label="Clear diff mark">
                <button onClick={() => setDiffMark(null)}>
                  <Ic.Diff /> <span className="bl">Diff mark: {diffMark.path.slice(diffMark.path.lastIndexOf("/") + 1)}</span> <X />
                </button>
              </Tip>
            )}
            <Tip label={compareWhyNot ?? "Compare two panels in place (folder compare, file diff, sync)"}>
              <button aria-label="Compare panels" disabled={!!compareWhyNot} onClick={compareClick}><GitCompareArrows /> <span className="bl">Compare panels</span></button>
            </Tip>
                        <Tip label="Keyboard shortcuts" shortcut="?"><button onClick={() => setHelp(true)} aria-label="Keyboard shortcuts"><Keyboard /></button></Tip>
          </div>
        </div>
      </header>
      {cmpMenu && <ContextMenu x={cmpMenu.x} y={cmpMenu.y} items={cmpMenu.items} onClose={() => setCmpMenu(null)} />}
      <div className="body">
        <main className="main" aria-label="File panels">
          <h1 className="visually-hidden">Files</h1>
          {tree ? render(tree, count(tree)) : <div className="pad muted">Loading nodes...</div>}
          {diff && (
            <Suspense fallback={<div className="ed over"><div className="pad muted">Loading editor...</div></div>}>
              <DiffViewer overlay left={diff.left} right={diff.right} onClose={() => setDiff(null)} onStatus={setStatus} />
            </Suspense>
          )}
        </main>
      </div>
      </div>
      {cmp && <SyncDialog ctl={cmp} />}
      </CompareCtx.Provider>
      {trash && (
        <Suspense fallback={null}>
          <TrashBrowser node={trash.node} volume={trash.volume} onVolume={(volume) => setTrash((t) => (t ? { ...t, volume } : t))} onClose={() => setTrash(null)} onStatus={setStatus} />
        </Suspense>
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
