import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, Folder, History, Server, Star, TriangleAlert } from "lucide-react";
import { api, parent, stat, type NodeInfo } from "./api";
import { fmtAddr, fuzzy, itemUri, parseAddress, splitTyped, type Where } from "./address";
import { useBookmarks } from "./bookmarks";
import { getRecents, pushRecent } from "./recents";
import { Tip } from "./Tooltip";
import { wheelX } from "./scrollx";

interface Item {
  key: string;
  kind: "node" | "dir" | "file" | "bookmark" | "recent";
  /** full URI this suggestion completes to */
  uri: string;
  node: string;
  path: string;
  select?: string;
}
const ICON = { node: Server, dir: Folder, file: FileIcon, bookmark: Star, recent: History } as const;
const KIND = { node: "node", dir: "folder", file: "file", bookmark: "bookmark", recent: "recent" } as const;
const MAX_ITEMS = 40;

let nodeCache: { at: number; list: NodeInfo[] } | null = null;
const loadNodes = async (): Promise<NodeInfo[]> => {
  if (nodeCache && Date.now() - nodeCache.at < 20000) return nodeCache.list;
  const list = await api.nodes().then((r) => r.nodes).catch(() => nodeCache?.list ?? []);
  nodeCache = { at: Date.now(), list };
  return list;
};

interface Props {
  node: string;
  path: string;
  active: boolean;
  hidden: boolean;
  /** navigate (pushes the panel history); `select` is a file to select in that folder */
  onGo: (node: string, path: string, select?: string) => void;
  onCrumbMenu: (e: React.MouseEvent, path: string) => void;
}

/**
 * The panel's location as a URI (`node-a:/home/user`). Idle it shows clickable path segments; click, focus or
 * Ctrl+L turns it into a combobox input with suggestions (nodes, child folders, bookmarks, recents).
 */
export function AddressBar({ node, path, active, hidden, onGo, onCrumbMenu }: Props) {
  const here = fmtAddr(node, path);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(here);
  const [items, setItems] = useState<Item[]>([]);
  const [cur, setCur] = useState(-1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const skipFocus = useRef(false);
  const listId = useId();
  const marks = useBookmarks();
  const dirCache = useRef(new Map<string, { name: string; dir: boolean }[]>());
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const crumbs = path.split("/").filter(Boolean);

  useEffect(() => pushRecent({ node, path }), [node, path]);
  useEffect(() => {
    if (!editing && navRef.current) navRef.current.scrollLeft = navRef.current.scrollWidth;
  }, [node, path, editing]);

  const begin = useCallback(() => {
    dirCache.current.clear();
    setText(here);
    setError("");
    setCur(-1);
    setEditing(true);
    void loadNodes().then(setNodes);
  }, [here]);
  const end = useCallback((refocus: boolean) => {
    setEditing(false);
    setItems([]);
    setError("");
    setBusy(false);
    if (refocus) {
      skipFocus.current = true;
      setTimeout(() => (editBtn.current?.focus(), (skipFocus.current = false)), 0);
    }
  }, []);

  useLayoutEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!editing) setText(here);
  }, [here, editing]);

  // Ctrl+L in the active panel.
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        begin();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active, begin]);

  // Suggestions: debounced, one listing per typed parent folder, cancelled when the text changes.
  useEffect(() => {
    if (!editing) return;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      const where: Where = { node, path };
      const names = nodes.map((n) => n.name);
      const out: Item[] = [];
      const seen = new Set<string>();
      const add = (i: Item) => !seen.has(i.uri) && (seen.add(i.uri), out.push(i));
      const q = text.trim();
      const ty = splitTyped(text, where, names);
      if (ty?.bare) {
        nodes
          .map((n) => [n, fuzzy(q, n.name)] as const)
          .filter(([, s]) => s >= 0)
          .sort((a, b) => b[1] - a[1])
          .forEach(([n]) => add({ key: "n:" + n.name, kind: "node", uri: n.name + ":/", node: n.name, path: "/" }));
      }
      {
        if (ty) {
          const key = ty.node + "\0" + ty.dir + "\0" + (hidden || ty.leaf.startsWith("."));
          let list = dirCache.current.get(key);
          if (!list) {
            try {
              const r = await api.list(ty.node, ty.dir, hidden || ty.leaf.startsWith("."), ac.signal);
              list = r.entries.map((e) => ({ name: e.name, dir: e.type === "dir" || !!e.linkDir }));
              dirCache.current.set(key, list);
            } catch {
              list = [];
            }
          }
          if (ac.signal.aborted) return;
          list
            .map((e) => [e, fuzzy(ty.leaf, e.name)] as const)
            .filter(([, s]) => s >= 0)
            .sort((a, b) => Number(b[0].dir) - Number(a[0].dir) || b[1] - a[1] || a[0].name.localeCompare(b[0].name, undefined, { numeric: true }))
            .slice(0, 30)
            .forEach(([e]) => {
              const p = (ty.dir === "/" ? "" : ty.dir) + "/" + e.name;
              add({ key: "f:" + ty.node + p, kind: e.dir ? "dir" : "file", uri: itemUri(ty.node, ty.dir, e.name, e.dir), node: ty.node, path: e.dir ? p : ty.dir, ...(e.dir ? {} : { select: p }) });
            });
        }
      }
      // Bookmarks and recent locations, fuzzy against the typed text.
      const extra = (kind: "bookmark" | "recent", w: Where) => {
        const uri = fmtAddr(w.node, w.path);
        if (q && fuzzy(q, uri) < 0 && fuzzy(q, w.path.split("/").pop() ?? "") < 0) return null;
        return { score: q ? Math.max(fuzzy(q, uri), fuzzy(q, w.path.split("/").pop() ?? "")) : 0, item: { key: kind + ":" + uri, kind, uri, node: w.node, path: w.path } as Item };
      };
      const more = [...marks.map((b) => extra("bookmark", b)), ...getRecents().map((r) => extra("recent", r))].filter((x): x is NonNullable<typeof x> => !!x);
      more.sort((a, b) => b.score - a.score);
      more.slice(0, 8).forEach((m) => add(m.item));
      setItems(out.slice(0, MAX_ITEMS));
      setCur(-1);
    }, 120);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [editing, text, nodes, node, path, hidden, marks]);

  // Dropdown position under the input.
  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    const r = input.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(Math.max(r.width, 360), vw - 8);
    setBox({ left: Math.max(4, Math.min(r.left, vw - width - 4)), top: r.bottom + 4, width });
  }, [editing, items.length, text]);

  const submit = async (raw: string, pick?: Item) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const where: Where = { node, path };
    const known = nodes.length ? nodes : await loadNodes();
    const p = pick && !pick.select ? { node: pick.node, path: pick.path } : pick?.select ? { node: pick.node, path: pick.path, select: pick.select } : parseAddress(raw, where, known.map((n) => n.name));
    if ("error" in p) {
      setError(p.error);
      setBusy(false);
      return;
    }
    try {
      const en = await stat(p.node, p.path);
      const isDir = en.type === "dir" || !!en.linkDir;
      if (isDir) onGo(p.node, p.path, p.select);
      else onGo(p.node, parent(p.path), p.path);
      end(true);
    } catch (e) {
      setError(`Cannot open ${fmtAddr(p.node, p.path)}: ${(e as Error).message || "not found"}`);
      setBusy(false);
    }
  };

  const complete = (i: Item) => {
    setText(i.uri);
    setError("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const open = items.length > 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!open) return;
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      const n = items.length;
      const next = cur < 0 ? (d > 0 ? 0 : n - 1) : (cur + d + n) % n;
      setCur(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[cur];
      void submit(it ? it.uri : text, it);
    } else if (e.key === "Tab" && !e.shiftKey && open && !error) {
      const it = items[cur] ?? (text.trim() && text.trim() !== here ? items[0] : undefined);
      if (it) {
        e.preventDefault();
        complete(it);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      end(true);
    }
  };

  const list = useMemo(
    () =>
      editing && items.length && box
        ? (
            <ul id={listId} role="listbox" aria-label="Address suggestions" className="addr-list" style={{ left: box.left, top: box.top, width: box.width }} onMouseDown={(e) => e.preventDefault()}>
              {items.map((it, i) => {
                const Ico = ICON[it.kind];
                return (
                  <li key={it.key} id={`${listId}-${i}`} role="option" aria-selected={i === cur} className={i === cur ? "cur" : ""} onMouseMove={() => cur !== i && setCur(i)} onClick={() => void submit(it.uri, it)}>
                    <Ico aria-hidden="true" />
                    <span className="addr-uri">{it.uri}</span>
                    <span className="addr-kind">{KIND[it.kind]}</span>
                  </li>
                );
              })}
            </ul>
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, items, box, cur, listId, busy, nodes],
  );

  if (editing) {
    return (
      <div className="addr">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Address"
            aria-autocomplete="list"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={cur >= 0 ? `${listId}-${cur}` : undefined}
            aria-invalid={error ? true : undefined}
            className={"addr-in" + (error ? " bad" : "")}
            value={text}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            onChange={(e) => (setText(e.target.value), setError(""))}
            onKeyDown={onKey}
            onBlur={() => end(false)}
          />
        {error && (
          <Tip label={error} forceOpen>
            <span className="addr-warn"><TriangleAlert aria-hidden="true" /></span>
          </Tip>
        )}
        <span className="sr-only" role="status">{error || (items.length ? `${items.length} suggestion${items.length === 1 ? "" : "s"}` : "")}</span>
        {list}
      </div>
    );
  }
  return (
    <div className="addr">
      <nav className="crumbs" aria-label="Breadcrumb" ref={navRef} onWheel={wheelX}>
        <Tip label={`Root of ${node}`}>
          <button onClick={() => onGo(node, "/")} onContextMenu={(e) => onCrumbMenu(e, "/")}>
            {node}:
          </button>
        </Tip>
        {crumbs.map((c, i) => {
          const p = "/" + crumbs.slice(0, i + 1).join("/");
          return (
            <button key={i} onClick={() => onGo(node, p)} onContextMenu={(e) => onCrumbMenu(e, p)}>
              /{c}
            </button>
          );
        })}
      </nav>
      <Tip label="Edit the address" shortcut="Ctrl+L">
        <button ref={editBtn} type="button" className="addr-edit" aria-label="Edit address" onFocus={() => !skipFocus.current && begin()} onClick={begin} />
      </Tip>
    </div>
  );
}
