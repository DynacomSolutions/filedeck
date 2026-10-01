import { Suspense, lazy, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { FilePanel, type Leaf } from "./FilePanel";
import type { FileRef } from "./EditorViews";

// Monaco (several MB) lives in its own chunks, fetched on first use.
const DiffViewer = lazy(() => import("./EditorViews").then((m) => ({ default: m.DiffViewer })));
import { JobsTray } from "./Jobs";
import { ThemeMenu } from "./ThemeMenu";

type Tree = Leaf | { kind: "split"; id: string; dir: "horizontal" | "vertical"; children: Tree[] };
let seq = 1;
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

function Sidebar({ nodes, onOpen, footer }: { nodes: NodeInfo[]; onOpen: (node: string, path: string) => void; footer: React.ReactNode }) {
  const [mounts, setMounts] = useState<Record<string, Mount[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (n: string) => {
    setOpen((o) => ({ ...o, [n]: !o[n] }));
    if (!mounts[n]) api.mounts(n).then((r) => setMounts((m) => ({ ...m, [n]: r.mounts }))).catch(() => setMounts((m) => ({ ...m, [n]: [] })));
  };
  return (
    <aside className="side">
      <div className="side-scroll">
      <h2>Nodes</h2>
      {nodes.map((n) => (
        <div key={n.name}>
          <button className="side-node" onClick={() => toggle(n.name)}>
            <span className={"dot " + (n.online ? "on" : "off")} /> {open[n.name] ? "▾" : "▸"} {n.name}
          </button>
          {open[n.name] && (
            <ul className="mounts">
              <li><button onClick={() => onOpen(n.name, "/")}>/ (root)</button></li>
              {(mounts[n.name] ?? []).map((m) => (
                <li key={m.mountpoint}>
                  <button onClick={() => onOpen(n.name, m.mountpoint)} title={`${m.device} (${m.fstype})`}>
                    {m.mountpoint}
                    <span className="bar"><i style={{ width: `${m.total ? Math.round((m.used / m.total) * 100) : 0}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!nodes.length && <p className="muted">No nodes</p>}
      </div>
      {footer}
    </aside>
  );
}

export function App() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [tree, setTree] = useState<Tree | null>(null);
  const [activeId, setActiveId] = useState("");
  const [status, setStatus] = useState("");
  const [diff, setDiff] = useState<{ left: FileRef; right: FileRef } | null>(null);
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

  useEffect(() => {
    const load = () => api.nodes().then((r) => setNodes(r.nodes)).catch(() => setNodes([]));
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (tree || !nodes.length) return;
    const l = leaf((nodes.find((n) => n.online) ?? nodes[0])!.name);
    setTree(l);
    setActiveId(l.id);
  }, [nodes, tree]);

  const update = (fn: (l: Leaf) => Tree | null) => setTree((t) => (t ? mapTree(t, fn) : t));
  const navigate = (lid: string) => (node: string, path: string) => update((l) => (l.id === lid ? { ...l, node, path } : l));
  const openInActive = (node: string, path: string) => update((l) => (l.id === activeId ? { ...l, node, path } : l));
  const split = (lid: string) => (dir: "horizontal" | "vertical") =>
    update((l) => (l.id === lid ? { kind: "split", id: id(), dir, children: [l, leaf(l.node, l.path)] } : l));

  const render = (t: Tree, total: number): React.ReactNode => {
    if (t.kind === "leaf") {
      return (
        <FilePanel
          leaf={t}
          active={t.id === activeId}
          onFocus={() => setActiveId(t.id)}
          onNavigate={navigate(t.id)}
          onSplit={split(t.id)}
          onClose={total > 1 ? () => update((l) => (l.id === t.id ? null : l)) : null}
          onDiff={onDiff}
          diffMarked={diffMark !== null}
          onStatus={setStatus}
        />
      );
    }
    return (
      <Group orientation={t.dir} id={t.id}>
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
            <a className="btn btn--ghost btn--sm" href="https://worktrees.example.invalid/">Worktrees</a>
            <a className="btn btn--ghost btn--sm" href="https://gh.example.invalid/">Runners</a>
            <ThemeMenu />
          </div>
        </div>
      </header>
      <div className="body">
        <Sidebar nodes={nodes} onOpen={openInActive} footer={<JobsTray nodes={nodes} />} />
        <div className="main">{tree ? render(tree, count(tree)) : <div className="pad muted">Loading nodes...</div>}</div>
      </div>
      <Suspense fallback={<div className="ed"><div className="pad muted">Loading editor...</div></div>}>
        {diff && <DiffViewer left={diff.left} right={diff.right} onClose={() => setDiff(null)} onStatus={setStatus} />}
      </Suspense>
    </div>
  );
}
