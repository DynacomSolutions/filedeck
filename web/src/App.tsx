import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, type Entry, type Mount, type NodeInfo } from "./api";
import { FilePanel, type Leaf } from "./FilePanel";
import { Preview } from "./Preview";

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

function Sidebar({ nodes, onOpen }: { nodes: NodeInfo[]; onOpen: (node: string, path: string) => void }) {
  const [mounts, setMounts] = useState<Record<string, Mount[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (n: string) => {
    setOpen((o) => ({ ...o, [n]: !o[n] }));
    if (!mounts[n]) api.mounts(n).then((r) => setMounts((m) => ({ ...m, [n]: r.mounts }))).catch(() => setMounts((m) => ({ ...m, [n]: [] })));
  };
  return (
    <aside className="side">
      <h2>Nodes</h2>
      {nodes.map((n) => (
        <div key={n.name}>
          <button className="node" onClick={() => toggle(n.name)}>
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
    </aside>
  );
}

export function App() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [tree, setTree] = useState<Tree | null>(null);
  const [activeId, setActiveId] = useState("");
  const [preview, setPreview] = useState<Entry | null>(null);
  const [previewNode, setPreviewNode] = useState("");
  const [status, setStatus] = useState("");
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? "");

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

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "" : "dark";
    setTheme(next);
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    try {
      next ? localStorage.setItem("filedeck-theme", next) : localStorage.removeItem("filedeck-theme");
    } catch {
      /* storage unavailable */
    }
  };

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
          onPreview={(e) => {
            setPreview(e);
            setPreviewNode(t.node);
          }}
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
      <header className="top">
        <b>filedeck</b>
        <span className="muted status" role="status">{status}</span>
        <button onClick={toggleTheme} title="Theme: auto / dark / light">Theme: {theme || "auto"}</button>
      </header>
      <div className="body">
        <Sidebar nodes={nodes} onOpen={openInActive} />
        <Group orientation="horizontal" id="main">
          <Panel id="panels" minSize="30%">{tree ? render(tree, count(tree)) : <div className="pad muted">Loading nodes...</div>}</Panel>
          <Separator className="sep horizontal" />
          <Panel id="preview" defaultSize="28%" minSize="10%" collapsible>
            <Preview node={previewNode} entry={preview} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
