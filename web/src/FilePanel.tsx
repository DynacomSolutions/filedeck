import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, fmtDate, fmtSize, join, nodeBase, parent, type Entry } from "./api";
import { getDrag, hasFiles, setDrag } from "./DragData";

export interface Leaf {
  kind: "leaf";
  id: string;
  node: string;
  path: string;
}
type SortKey = "name" | "size" | "mtime";

interface Props {
  leaf: Leaf;
  active: boolean;
  onFocus: () => void;
  onNavigate: (node: string, path: string) => void;
  onSplit: (dir: "horizontal" | "vertical") => void;
  onClose: (() => void) | null;
  onPreview: (e: Entry | null) => void;
  onStatus: (msg: string) => void;
}

export function FilePanel({ leaf, active, onFocus, onNavigate, onSplit, onClose, onPreview, onStatus }: Props) {
  const { node, path } = leaf;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null); // "." = panel itself, else folder path
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

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

  useEffect(() => {
    const only = sel.size === 1 ? entries.find((e) => e.path === [...sel][0]) : null;
    if (active) onPreview(only ?? null);
  }, [sel, entries, active]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (e.shiftKey && anchor) {
      const a = sorted.findIndex((x) => x.path === anchor);
      const b = sorted.findIndex((x) => x.path === en.path);
      setSel(new Set(sorted.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
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
  const open = (en: Entry) => {
    if (en.type === "dir" || en.linkDir) onNavigate(node, en.path);
    else window.open(fileUrl(node, en.path), "_blank", "noopener");
  };
  const selected = () => [...sel];

  const drop = async (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const copy = e.ctrlKey || e.altKey;
    const src = getDrag(e);
    if (src) {
      if (src.node === node) {
        if (src.paths.every((p) => parent(p) === destDir) && !copy) return;
        await run(copy ? "Copy" : "Move", () => (copy ? api.copy(node, src.paths, destDir) : api.move(node, src.paths, destDir)));
      } else {
        await run("Transfer", async () => {
          for (const p of src.paths) await api.transfer({ node: src.node, path: p }, { node, dir: destDir }, copy ? "copy" : "move");
        });
      }
    } else if (hasFiles(e)) {
      const files = Array.from(e.dataTransfer.files);
      await run(`Upload ${files.length} file(s)`, async () => {
        for (const f of files) await api.upload(node, destDir, f, (p) => onStatus(`Uploading ${f.name} ${Math.round(p * 100)}%`));
      });
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

  return (
    <section
      className={"fp" + (active ? " active" : "") + (over === "." ? " drop" : "")}
      onMouseDown={onFocus}
      onDragOver={(e) => dragOver(e, ".")}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => drop(e, path)}
    >
      <header className="fp-bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <button onClick={() => onNavigate(node, "/")} title={node}>
            {node}:
          </button>
          {crumbs.map((c, i) => (
            <button key={i} onClick={() => onNavigate(node, "/" + crumbs.slice(0, i + 1).join("/"))}>
              /{c}
            </button>
          ))}
        </nav>
        <div className="fp-actions">
          <button title="Up" disabled={path === "/"} onClick={() => onNavigate(node, parent(path))}>↑</button>
          <button title="New folder" onClick={() => {
            const n = prompt("Folder name");
            if (n) void run("New folder", () => api.mkdir(node, join(path, n)));
          }}>＋📁</button>
          <button title="Upload" onClick={() => fileInput.current?.click()}>⇪</button>
          <button title="Rename" disabled={sel.size !== 1} onClick={() => setRenaming([...sel][0] ?? null)}>✎</button>
          <button title="Download" disabled={sel.size !== 1} onClick={() => {
            const en = entries.find((x) => x.path === [...sel][0]);
            if (en && en.type === "file") window.location.href = fileUrl(node, en.path, "download");
          }}>⇩</button>
          <button title="Move to trash" disabled={!sel.size} onClick={() => void run("Trash", () => api.trash(node, selected()))}>🗑</button>
          <button title="Delete permanently" disabled={!sel.size} onClick={() => {
            if (confirm(`Permanently delete ${sel.size} item(s)? This cannot be undone.`)) void run("Delete", () => api.remove(node, selected()));
          }}>✕</button>
          <label className="chk"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
          <button title="Split right" onClick={() => onSplit("horizontal")}>▥</button>
          <button title="Split down" onClick={() => onSplit("vertical")}>▤</button>
          {onClose && <button title="Close panel" onClick={onClose}>×</button>}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void run(`Upload ${files.length} file(s)`, async () => {
              for (const f of files) await api.upload(node, path, f);
            });
          }} />
        </div>
      </header>
      {err && <div className="fp-err">{err}</div>}
      <div className="fp-scroll" onClick={(e) => e.target === e.currentTarget && setSel(new Set())}>
        <table className="ft">
          <thead>
            <tr>{th("name", "Name")}{th("size", "Size")}{th("mtime", "Modified")}</tr>
          </thead>
          <tbody>
            {sorted.map((en) => {
              const isDir = en.type === "dir" || en.linkDir;
              return (
                <tr
                  key={en.path}
                  className={(sel.has(en.path) ? "sel " : "") + (over === en.path ? "drop" : "")}
                  draggable
                  onClick={(e) => click(e, en)}
                  onDoubleClick={() => open(en)}
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
      </div>
    </section>
  );
}
