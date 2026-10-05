// Selection that spans panels: every panel reports what it has selected, App merges the reports,
// and the actions here run on the combined list (hub jobs take items from any node).
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, canEdit, fileUrl, zipUrl, type Entry, type OpSpec } from "./api";
import { setClip } from "./clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { CompressDialog } from "./ArchiveDialog";
import { ConfirmDialog } from "./Dialogs";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";

export interface SelRef {
  node: string;
  path: string;
  name: string;
  type: Entry["type"];
  /** a folder, or a link to one */
  dir: boolean;
  /** panel the item is selected in */
  panel: string;
  /** a regular file the editor and diff can open */
  editable: boolean;
}
export const refOf = (panel: string, node: string, e: Entry): SelRef => ({ node, path: e.path, name: e.name, type: e.type, dir: e.type === "dir" || !!e.linkDir, panel, editable: canEdit(e) });

const dirOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";
export interface Group {
  node: string;
  dir: string;
  names: string[];
  /** a lone regular file downloads as itself, everything else as a zip */
  single?: SelRef;
}
/** Items grouped by node and parent folder: the archive and zip endpoints take direct children of one folder. */
export function groupRefs(refs: SelRef[]): Group[] {
  const m = new Map<string, Group>();
  for (const r of refs) {
    const dir = dirOf(r.path);
    const k = r.node + "\0" + dir;
    const g = m.get(k) ?? { node: r.node, dir, names: [] };
    g.names.push(r.name);
    m.set(k, g);
  }
  for (const g of m.values()) {
    if (g.names.length === 1) {
      const r = refs.find((x) => x.node === g.node && dirOf(x.path) === g.dir && x.name === g.names[0])!;
      if (r.type === "file") g.single = r;
    }
  }
  return [...m.values()];
}

/** Start one download per group, spaced out so the browser does not drop them. */
export function downloadRefs(refs: SelRef[]) {
  groupRefs(refs).forEach((g, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = g.single ? fileUrl(g.node, g.single.path, "download") : zipUrl(g.node, g.dir, g.names);
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 600);
  });
}

export const counts = (refs: SelRef[]) => ({ files: refs.filter((r) => !r.dir).length, folders: refs.filter((r) => r.dir).length });
export const summary = (refs: SelRef[], panels: number) => {
  const c = counts(refs);
  const parts = [c.files ? `${c.files} file${c.files === 1 ? "" : "s"}` : "", c.folders ? `${c.folders} folder${c.folders === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return `${refs.length} selected (${parts}) in ${panels} panel${panels === 1 ? "" : "s"}`;
};

export const trashSpec = (refs: SelRef[]): OpSpec => ({ op: "trash", items: refs.map((r) => ({ node: r.node, path: r.path })) });
export const deleteSpec = (refs: SelRef[]): OpSpec => ({ op: "delete", items: refs.map((r) => ({ node: r.node, path: r.path })) });

export interface Dest {
  id: string;
  node: string;
  path: string;
}
const isEditable = (r: SelRef) => r.editable;

export interface BarProps {
  refs: SelRef[];
  panelCount: number;
  /** panels picked as a whole */
  picked: string[];
  dests: Dest[];
  onClear: () => void;
  onDiff: (a: SelRef, b: SelRef) => void;
  /** starts the compare (picked panels, the only two panels, or a picker) */
  onStatus: (m: string) => void;
}

export function SelectionBar({ refs, panelCount, picked, dests, onClear, onDiff, onStatus }: BarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [compress, setCompress] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const queue = async (label: string, spec: OpSpec) => {
    try {
      await api.startOp(spec);
      onStatus(`${label} queued (see Jobs)`);
    } catch (e) {
      onStatus(`${label} failed: ${(e as Error).message}`);
    }
  };
  const destItems = (op: "copy" | "move"): MenuItem[] => {
    const label = op === "copy" ? "Copy" : "Move";
    const items: MenuItem[] = dests.map((d) => ({
      label: `${label} to ${d.node}:${d.path}`,
      onSelect: () => void queue(label, { op, items: refs.map((x) => ({ node: x.node, path: x.path })), dst: { node: d.node, dir: d.path }, conflict: "ask" }),
    }));
    return items.length ? items : [{ label: "No other panel", disabled: true }];
  };
  const to = (op: "copy" | "move") => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items: destItems(op) });
  };
  const files = refs.filter(isEditable);
  const diffable = refs.length === 2 && files.length === 2;
  const none = "Select one or more items in a panel first.";
  const need = (label: string) => (refs.length ? label : none);
  const nPanels = new Set(refs.map((r) => r.panel)).size || panelCount;
  const text = `${refs.length ? summary(refs, nPanels) : "0 selected"}${picked.length > 0 ? `${refs.length ? "; " : " - "}${picked.length} panel${picked.length === 1 ? "" : "s"} picked` : ""}`;
  const clip = (mode: "copy" | "cut") => () => (setClip({ mode, items: refs.map((r) => ({ node: r.node, path: r.path })) }), onStatus(`${mode === "copy" ? "Copied" : "Cut"} ${refs.length} item(s) to the file clipboard`));
  interface Act {
    id: string;
    label: string;
    tip: string;
    icon: ReactNode;
    disabled?: boolean;
    danger?: boolean;
    run: (e: React.MouseEvent) => void;
    /** menu entry in the "More" menu: label shown there and, for the destination pickers, the nested items */
    menuLabel: string;
    sub?: () => MenuItem[];
    runMenu?: () => void;
  }
  const off = !refs.length;
  const acts: Act[] = [
    { id: "copy", label: "Copy", tip: need("Copy the selection to the file clipboard"), icon: <Ic.Copy />, disabled: off, run: clip("copy"), menuLabel: "Copy", runMenu: clip("copy") },
    { id: "cut", label: "Cut", tip: need("Cut the selection to the file clipboard"), icon: <Ic.Scissors />, disabled: off, run: clip("cut"), menuLabel: "Cut", runMenu: clip("cut") },
    { id: "copyto", label: "Copy to...", tip: need("Copy the selection into another open panel's folder"), icon: <Ic.CopyPlus />, disabled: off, run: to("copy"), menuLabel: "Copy to...", sub: () => destItems("copy") },
    { id: "moveto", label: "Move to...", tip: need("Move the selection into another open panel's folder"), icon: <Ic.FolderInput />, disabled: off, run: to("move"), menuLabel: "Move to...", sub: () => destItems("move") },
    { id: "download", label: "Download", tip: need("Download the selection (several items or folders as a zip)"), icon: <Ic.Download />, disabled: off, run: () => downloadRefs(refs), menuLabel: "Download", runMenu: () => downloadRefs(refs) },
    { id: "compress", label: "Compress...", tip: need("Compress the selection into an archive"), icon: <Ic.Archive />, disabled: off, run: () => setCompress(true), menuLabel: "Compress...", runMenu: () => setCompress(true) },
    { id: "trash", label: "Trash", tip: need("Move the selection to the trash"), icon: <Ic.Trash2 />, disabled: off, run: () => void queue("Trash", trashSpec(refs)), menuLabel: "Move to trash", runMenu: () => void queue("Trash", trashSpec(refs)) },
    { id: "delete", label: "Delete...", tip: need("Delete the selection permanently"), icon: <Ic.CircleX />, disabled: off, danger: true, run: () => setConfirm(true), menuLabel: "Delete...", runMenu: () => setConfirm(true) },
    { id: "diff", label: "Diff files", tip: diffable ? "Diff the two selected files" : "Select exactly two regular files (in one or two panels) to diff them.", icon: <Ic.Diff />, disabled: !diffable, run: () => diffable && onDiff(refs[0]!, refs[1]!), menuLabel: "Diff files", runMenu: () => diffable && onDiff(refs[0]!, refs[1]!) },
    { id: "clear", label: "Clear", tip: refs.length || picked.length ? "Clear the selection and picked panels" : "Nothing is selected.", icon: <Ic.Eraser />, disabled: !refs.length && !picked.length, run: onClear, menuLabel: "Clear", runMenu: onClear },
  ];

  // Progressive collapse by measured width: level 0 icon + label, 1 icon only, then 1 + k: the last k actions move into "More".
  const bar = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const maxLevel = 1 + acts.length;
  const [, force] = useState(0);
  const lastW = useRef(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    lastW.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - lastW.current) < 1) return;
      lastW.current = el.clientWidth;
      setLevel(0);
      force((n) => n + 1); // render again even when the level was already 0
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The text (and the state of the actions) change widths: measure again from the widest layout.
  useLayoutEffect(() => setLevel(0), [text]);
  // After every render: still clipped, collapse one step further (settles before paint).
  useLayoutEffect(() => {
    const el = bar.current;
    if (el && level < maxLevel && el.scrollWidth > el.clientWidth) setLevel(level + 1);
  });
  const hidden = Math.max(0, level - 1);
  const shown = acts.slice(0, acts.length - hidden);
  const more = acts.slice(acts.length - hidden);
  const openMore = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: more.map((a): MenuItem => ({ label: a.menuLabel, ...(a.disabled ? { disabled: true } : {}), ...(a.danger ? { danger: true } : {}), ...(a.sub ? { sub: a.sub() } : { onSelect: a.runMenu! }) })),
    });
  };
  return (
    // Lives inside the page header (fixed height, always present): nothing moves when a selection starts or ends.
    <div className="selbar" ref={bar} role="region" aria-label="Selection across panels">
      <Tip label={text}><b role="status">{text}</b></Tip>
      <span className="selbar-actions" data-icons={level > 0 ? "1" : undefined}>
        {shown.map((a) => (
          <Tip key={a.id} label={a.tip}>
            <button aria-label={a.label} disabled={a.disabled} className={a.danger ? "danger" : undefined} onClick={a.run}>{a.icon} <span className="bl">{a.label}</span></button>
          </Tip>
        ))}
        {more.length > 0 && (
          <Tip label="More selection actions">
            <button aria-label="More selection actions" aria-haspopup="menu" onClick={openMore}><Ic.Ellipsis /></button>
          </Tip>
        )}
      </span>
      {createPortal(<>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {compress && <CompressDialog groups={groupRefs(refs)} onClose={() => setCompress(false)} onStatus={onStatus} />}
      {confirm && (
        <ConfirmDialog
          title="Delete permanently"
          message={`Permanently delete ${refs.length} item(s) from ${new Set(refs.map((r) => r.panel)).size} panel(s)? This cannot be undone.`}
          action="Delete permanently"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={() => void queue("Delete", deleteSpec(refs))}
        />
      )}
      </>, document.body)}
    </div>
  );
}
