// Selection that spans panels: every panel reports what it has selected, App merges the reports,
// and the actions here run on the combined list (hub jobs take items from any node).
import { useState } from "react";
import { createPortal } from "react-dom";
import { api, canEdit, fileUrl, zipUrl, type Entry, type OpSpec } from "./api";
import { setClip } from "./clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { CompressDialog } from "./ArchiveDialog";
import { ConfirmDialog } from "./Dialogs";
import { Tip } from "./Tooltip";
import { wheelX } from "./scrollx";

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
  const to = (op: "copy" | "move") => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const label = op === "copy" ? "Copy" : "Move";
    const items: MenuItem[] = dests.map((d) => ({
      label: `${label} to ${d.node}:${d.path}`,
      onSelect: () => void queue(label, { op, items: refs.map((x) => ({ node: x.node, path: x.path })), dst: { node: d.node, dir: d.path }, conflict: "ask" }),
    }));
    setMenu({ x: r.left, y: r.bottom + 2, items: items.length ? items : [{ label: "No other panel", disabled: true }] });
  };
  const files = refs.filter(isEditable);
  const diffable = refs.length === 2 && files.length === 2;
  const none = "Select one or more items in a panel first.";
  const need = (label: string) => (refs.length ? label : none);
  const nPanels = new Set(refs.map((r) => r.panel)).size || panelCount;
  const text = `${refs.length ? summary(refs, nPanels) : "0 selected"}${picked.length > 0 ? `${refs.length ? "; " : " - "}${picked.length} panel${picked.length === 1 ? "" : "s"} picked` : ""}`;
  const clip = (mode: "copy" | "cut") => () => (setClip({ mode, items: refs.map((r) => ({ node: r.node, path: r.path })) }), onStatus(`${mode === "copy" ? "Copied" : "Cut"} ${refs.length} item(s) to the file clipboard`));
  return (
    // Lives inside the page header (fixed height, always present): nothing moves when a selection starts or ends.
    <div className="selbar" onWheel={wheelX} role="region" aria-label="Selection across panels">
      <Tip label={text}><b role="status">{text}</b></Tip>
      <span className="selbar-actions">
        <Tip label={need("Copy the selection to the file clipboard")}><button disabled={!refs.length} onClick={clip("copy")}>Copy</button></Tip>
        <Tip label={need("Cut the selection to the file clipboard")}><button disabled={!refs.length} onClick={clip("cut")}>Cut</button></Tip>
        <Tip label={need("Copy the selection into another open panel's folder")}><button disabled={!refs.length} onClick={to("copy")}>Copy to...</button></Tip>
        <Tip label={need("Move the selection into another open panel's folder")}><button disabled={!refs.length} onClick={to("move")}>Move to...</button></Tip>
        <Tip label={need("Download the selection (several items or folders as a zip)")}><button disabled={!refs.length} onClick={() => downloadRefs(refs)}>Download</button></Tip>
        <Tip label={need("Compress the selection into an archive")}><button disabled={!refs.length} onClick={() => setCompress(true)}>Compress...</button></Tip>
        <Tip label={need("Move the selection to the trash")}><button disabled={!refs.length} onClick={() => void queue("Trash", trashSpec(refs))}>Trash</button></Tip>
        <Tip label={need("Delete the selection permanently")}><button disabled={!refs.length} className="danger" onClick={() => setConfirm(true)}>Delete...</button></Tip>
        <Tip label={diffable ? "Diff the two selected files" : "Select exactly two regular files (in one or two panels) to diff them."}>
          <button disabled={!diffable} onClick={() => diffable && onDiff(refs[0]!, refs[1]!)}>Diff files</button>
        </Tip>
        <Tip label={refs.length || picked.length ? "Clear the selection and picked panels" : "Nothing is selected."}>
          <button disabled={!refs.length && !picked.length} onClick={onClear}>Clear</button>
        </Tip>
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
