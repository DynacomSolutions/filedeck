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
  const files = refs.filter(isEditable);
  const diffable = refs.length === 2 && files.length === 2;
  const nPanels = new Set(refs.map((r) => r.panel)).size || panelCount;
  const nPick = picked.length;
  const text = refs.length ? `${refs.length} selected` : nPick ? `${nPick} panel${nPick === 1 ? "" : "s"} picked` : "No selection";
  const detail = `${refs.length ? summary(refs, nPanels) : text}${refs.length && nPick ? `; ${nPick} panel${nPick === 1 ? "" : "s"} picked` : ""}`;
  const clip = (mode: "copy" | "cut") => () => (setClip({ mode, items: refs.map((r) => ({ node: r.node, path: r.path })) }), onStatus(`${mode === "copy" ? "Copied" : "Cut"} ${refs.length} item(s) to the file clipboard`));
  const doTrash = () => void queue("Trash", trashSpec(refs));
  const primary = [
    { id: "copy", label: "Copy", tip: "Copy the selection to the file clipboard", icon: <Ic.Copy />, run: clip("copy") },
    { id: "cut", label: "Cut", tip: "Cut the selection to the file clipboard", icon: <Ic.Scissors />, run: clip("cut") },
    { id: "download", label: "Download", tip: "Download the selection (several items or folders as a zip)", icon: <Ic.Download />, run: () => downloadRefs(refs) },
    { id: "trash", label: "Trash", tip: "Move the selection to the trash", icon: <Ic.Trash2 />, run: doTrash },
  ];
  const openMore = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const diffItem: MenuItem = { label: "Diff files", icon: Ic.Diff, ...(diffable ? { onSelect: () => onDiff(refs[0]!, refs[1]!) } : { disabled: true }) };
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        { label: "Copy to...", icon: Ic.CopyPlus, sub: destItems("copy") },
        { label: "Move to...", icon: Ic.FolderInput, sub: destItems("move") },
        { label: "Compress...", icon: Ic.Archive, onSelect: () => setCompress(true) },
        "sep",
        diffItem,
        "sep",
        { label: "Delete permanently...", icon: Ic.CircleX, danger: true, hint: "Shift+Del", onSelect: () => setConfirm(true) },
      ],
    });
  };
  return (
    // Lives inside the page header (fixed height, always present): nothing moves when a selection starts or ends.
    <div className="selbar" role="region" aria-label="Selection across panels">
      <Tip label={detail}><b role="status" className={refs.length || nPick ? undefined : "selbar-none"}>{text}</b></Tip>
      {(refs.length > 0 || nPick > 0) && (
        <span className="selbar-actions">
          {refs.length > 0 && primary.map((a) => (
            <Tip key={a.id} label={a.tip}>
              <button aria-label={a.label} onClick={a.run}>{a.icon} <span className="bl">{a.label}</span></button>
            </Tip>
          ))}
          {refs.length > 0 && (
            <Tip label="More selection actions">
              <button aria-label="More selection actions" aria-haspopup="menu" onClick={openMore}><Ic.Ellipsis /></button>
            </Tip>
          )}
          <Tip label="Clear the selection and picked panels">
            <button aria-label="Clear" className="selbar-clear" onClick={onClear}><Ic.X /></button>
          </Tip>
        </span>
      )}
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
