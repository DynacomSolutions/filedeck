import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { FilePanel } from "./FilePanel";
import { DEFAULT_UI, decodeState, encodeState, leaves, maxId, type FolderState, type Leaf, type Tree, type TrashState } from "./urlState";
import type { FileRef } from "./EditorViews";

// Monaco (several MB) lives in its own chunks, fetched on first use.
const DiffViewer = lazy(() => import("./EditorViews").then((m) => ({ default: m.DiffViewer })));
import { JobsTray } from "./Jobs";
import { ThemeMenu } from "./ThemeMenu";
import { ShortcutHelp } from "./Shortcuts";
import { TrashBrowser } from "./Trash";
import { FolderDiff, type FolderDiffInit } from "./FolderDiff";
import type { Loc } from "./api";

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
  paths: Record<string, { node: string; path: string }>;
}
const pathsOf = (t: Tree) => Object.fromEntries(leaves(t).map((l) => [l.id, { node: l.node, path: l.path }]));

/**
 * The URL always reflects the full app state. A folder change in a panel pushes a
 * history entry tagged with that panel; everything else (layout, sizes, selection,
 * preview, editor) replaces the current entry. Back/forward only walks the entries
 * made by the focused panel and restores that panel's own folder.
 */
function useUrlHistory(tree: Tree | null, active: string, diff: { left: FileRef; right: FileRef } | null, folder: FolderState | null, trash: TrashState | null, setTree: React.Dispatch<React.SetStateAction<Tree | null>>, setStatus: (m: string) => void) {
  const cur = useRef<HState | null>((history.state as HState | null) && typeof (history.state as HState).idx === "number" ? (history.state as HState) : null);
  const prev = useRef<Record<string, { node: string; path: string }> | null>(null);
  const fromPop = useRef(false);
  const latest = useRef({ active, url: "", paths: {} as HState["paths"] });
  latest.current.active = active;

  useEffect(() => {
    if (!tree) return;
    const paths = pathsOf(tree);
    const url = encodeState({ tree, active, ...(diff ? { diff } : {}), ...(folder ? { folder } : {}), ...(trash ? { trash } : {}) });
    latest.current.url = url;
    latest.current.paths = paths;
    let changed: string | undefined;
    if (prev.current && !fromPop.current) changed = Object.keys(paths).find((k) => prev.current![k] && (prev.current![k]!.node !== paths[k]!.node || prev.current![k]!.path !== paths[k]!.path));
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
  }, [tree, active, diff, folder, trash]);

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
        return go(t);
      });
      setStatus(`${back ? "Back" : "Forward"}: ${target.node}:${target.path}`);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setTree, setStatus]);
}

function Sidebar({ nodes, onOpen, onTrash, footer }: { nodes: NodeInfo[]; onOpen: (node: string, path: string) => void; onTrash: (node: string) => void; footer: React.ReactNode }) {
  const [mounts, setMounts] = useState<Record<string, Mount[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (n: string) => {
    setOpen((o) => ({ ...o, [n]: !o[n] }));
    if (!mounts[n]) api.mounts(n).then((r) => setMounts((m) => ({ ...m, [n]: r.mounts }))).catch(() => setMounts((m) => ({ ...m, [n]: [] })));
  };
  const cluster = nodes.filter((n) => n.kind !== "source");
  const network = nodes.filter((n) => n.kind === "source");
  return (
    <aside className="side">
      <div className="side-scroll">
      <h2>Nodes</h2>
      {cluster.map((n) => (
        <div key={n.name}>
          <button className="side-node" onClick={() => toggle(n.name)}>
            <span className={"dot " + (n.online ? "on" : "off")} /> {open[n.name] ? "▾" : "▸"} {n.name}
          </button>
          {open[n.name] && (
            <ul className="mounts">
              <li><button onClick={() => onOpen(n.name, "/")}>/ (root)</button></li>
              <li><button onClick={() => onTrash(n.name)}>Trash</button></li>
              {(mounts[n.name] ?? []).map((m) => (
                <li key={m.mountpoint}>
                  <button
                    onClick={() => onOpen(n.name, m.mountpoint)}
                    title={`${m.device} (${m.fstype})${m.network ? " - network drive" : ""}${m.unreachable ? " - not responding" : ""}`}
                  >
                    {m.mountpoint}
                    {m.network && <span className={"net-badge" + (m.unreachable ? " bad" : "")}>{m.netKind ?? "network"}</span>}
                    <span className="bar"><i style={{ width: `${m.total ? Math.round((m.used / m.total) * 100) : 0}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!cluster.length && <p className="muted">No nodes</p>}
      {network.length > 0 && <h2>Network</h2>}
      {network.map((n) => (
        <button key={n.name} className="side-node" onClick={() => onOpen(n.name, "/")} title={`${n.type ?? "network"} ${n.host ?? ""}${n.online ? "" : " - unreachable"}`}>
          <span className={"dot " + (n.online ? "on" : "off")} /> {n.name}
          <span className="net-badge">{(n.type ?? "net").toUpperCase()}</span>
        </button>
      ))}
      </div>
      {footer}
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
  const [folderDiff, setFolderDiff] = useState<FolderDiffInit | null>(() => (initial?.folder ? { ...initial.folder, autorun: true } : null));
  // Live folder-diff state (folders + options) that the URL mirrors while the dialog is open.
  const [folderLive, setFolderLive] = useState<FolderState | null>(initial?.folder ?? null);
  const [folderMark, setFolderMark] = useState<Loc | null>(null);
  const onFolderDiff = (folders: Loc[]) => {
    const open = (l: Loc, r: Loc) => {
      setFolderDiff({ left: l, right: r, opts: DEFAULT_UI, preset: "", autorun: false });
      setFolderMark(null);
    };
    if (folders.length === 2) return open(folders[0]!, folders[1]!);
    const f = folders[0];
    if (!f) return;
    if (folderMark && !(folderMark.node === f.node && folderMark.path === f.path)) open(folderMark, f);
    else if (folderMark) {
      setFolderMark(null);
      setStatus("Folder diff mark cleared");
    } else {
      setFolderMark(f);
      setStatus(`Marked ${f.node}:${f.path} for folder diff; pick another folder in any panel and press the folder diff button`);
    }
  };

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

  useUrlHistory(tree, activeId, diff, folderDiff ? folderLive : null, trash, setTree, setStatus);

  const update = (fn: (l: Leaf) => Tree | null) => setTree((t) => (t ? mapTree(t, fn) : t));
  const patchLeaf = (lid: string, p: Partial<Leaf>) => update((l) => (l.id === lid ? { ...l, ...p } : l));
  const patchSizes = (sid: string, sizes: number[]) =>
    setTree((t) => {
      const go = (n: Tree): Tree => (n.kind === "leaf" ? n : n.id === sid ? { ...n, sizes } : { ...n, children: n.children.map(go) });
      return t ? go(t) : t;
    });
  const navigate = (lid: string) => (node: string, path: string) => update((l) => (l.id === lid ? { ...l, node, path, sr: undefined } : l));
  const openInActive = (node: string, path: string) => update((l) => (l.id === activeId ? { ...l, node, path, sr: undefined } : l));
  const split = (lid: string) => (dir: "horizontal" | "vertical") =>
    update((l) => (l.id === lid ? { kind: "split", id: id(), dir, children: [l, leaf(l.node, l.path)] } : l));

  const switchPanel = (from: string, dir: 1 | -1) => {
    if (!tree) return;
    const all = leaves(tree);
    const i = all.findIndex((l) => l.id === from);
    const to = all[(i + dir + all.length) % all.length];
    if (!to) return;
    setActiveId(to.id);
    setTimeout(() => document.querySelector<HTMLElement>(`[data-fp="${to.id}"]`)?.focus(), 0);
  };
  const render = (t: Tree, total: number): React.ReactNode => {
    if (t.kind === "leaf") {
      const all = leaves(tree!);
      const nx = all.length > 1 ? all[(all.findIndex((l) => l.id === t.id) + 1) % all.length] : undefined;
      return (
        <FilePanel
          leaf={t}
          active={t.id === activeId}
          onFocus={() => setActiveId(t.id)}
          onNavigate={navigate(t.id)}
          onSplit={split(t.id)}
          onPatch={(p) => patchLeaf(t.id, p)}
          onClose={total > 1 ? () => update((l) => (l.id === t.id ? null : l)) : null}
          onDiff={onDiff}
          diffMarked={diffMark !== null}
          onFolderDiff={onFolderDiff}
          folderMarked={folderMark !== null}
          next={nx ? { node: nx.node, path: nx.path } : null}
          onSwitch={(d) => switchPanel(t.id, d)}
          onHelp={() => setHelp(true)}
          onTrash={(node) => setTrash({ node, volume: "" })}
          peers={leaves(tree!).filter((l) => l.id !== t.id).map((l) => ({ id: l.id, node: l.node, path: l.path, sel: l.sel }))}
          onStatus={setStatus}
        />
      );
    }
    return (
      <Group
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
      <header className="site-header">
        <div className="site-header__inner shell">
          <a className="brand-logo" href="/" aria-label="Filedeck">
            <img className="brand-logo__white" src="/assets/logo/lockup-horizontal-white.svg" alt="" />
            <img className="brand-logo__default" src="/assets/logo/lockup-horizontal-default.svg" alt="" />
          </a>
          <span className="crumb">Files</span>
          <span className="status" role="status">{status}</span>
          <div className="site-header__actions">
            {diffMark && (
              <button className="btn btn--ghost btn--sm" onClick={() => setDiffMark(null)} title="Clear diff mark">
                Diff mark: {diffMark.path.slice(diffMark.path.lastIndexOf("/") + 1)} ×
              </button>
            )}
            {folderMark && (
              <button className="btn btn--ghost btn--sm" onClick={() => setFolderMark(null)} title="Clear folder diff mark">
                Folder mark: {folderMark.node}:{folderMark.path} ×
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
            <a className="btn btn--ghost btn--sm" href="https://worktrees.example.invalid/">Worktrees</a>
            <a className="btn btn--ghost btn--sm" href="https://gh.example.invalid/">Runners</a>
            <ThemeMenu />
          </div>
        </div>
      </header>
      <div className="body">
        <Sidebar nodes={nodes} onOpen={openInActive} onTrash={(node) => setTrash({ node, volume: "" })} footer={<JobsTray nodes={nodes} />} />
        <div className="main">{tree ? render(tree, count(tree)) : <div className="pad muted">Loading nodes...</div>}</div>
      </div>
      {trash && (
        <Suspense fallback={null}>
          <TrashBrowser node={trash.node} volume={trash.volume} onVolume={(volume) => setTrash((t) => (t ? { ...t, volume } : t))} onClose={() => setTrash(null)} onStatus={setStatus} />
        </Suspense>
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      <Suspense fallback={<div className="ed"><div className="pad muted">Loading editor...</div></div>}>
        {folderDiff && nodes.length > 0 && (
          <FolderDiff
            init={folderDiff}
            onState={setFolderLive}
            nodes={nodes}
            onClose={() => setFolderDiff(null)}
            onFileDiff={(l, r) => setDiff({ left: l, right: r })}
            onStatus={setStatus}
          />
        )}
        {diff && <DiffViewer left={diff.left} right={diff.right} onClose={() => setDiff(null)} onStatus={setStatus} />}
      </Suspense>
    </div>
  );
}
