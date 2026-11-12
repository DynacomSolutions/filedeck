import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, fmtDate, fmtSize, parent, type TrashItem, type TrashResult, type TrashVolume } from "./api";
import { Modal } from "./ArchiveDialog";
import { ConfirmDialog, NameDialog } from "./Dialogs";
import { FileIcon } from "./FileIcon";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";
import { useDialogFocus } from "./dialogFocus";
import { trashKey, trashSummary } from "./trashNav";

type Dlg =
  | { k: "del"; ids: string[] }
  | { k: "empty" }
  | { k: "to"; ids: string[] }
  | { k: "conflict"; ids: string[]; toDir?: string };

const dirOf = (p: string) => (p ? parent(p) : "");

/** Per-node trash: one tab per volume that has a trash store; restore, restore elsewhere, delete, empty. */
export function TrashBrowser({ node, volume, onVolume, onClose, onStatus }: { node: string; volume: string; onVolume: (v: string) => void; onClose: () => void; onStatus: (m: string) => void }) {
  const [vols, setVols] = useState<TrashVolume[] | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  /** true while the focus change came from the keyboard, so the row element must take focus */
  const keyed = useRef(false);
  const uid = useId();

  const load = useCallback(() => {
    api
      .trashList(node)
      .then((r) => {
        setVols(r.volumes);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  }, [node]);
  useEffect(load, [load]);
  useDialogFocus(root);
  useEffect(() => root.current?.focus(), []);

  const current = vols?.find((v) => v.volume === volume) ?? vols?.find((v) => v.items.length) ?? vols?.[0];
  useEffect(() => {
    if (current && current.volume !== volume) onVolume(current.volume);
  }, [current, volume, onVolume]);
  const items = useMemo(() => [...(current?.items ?? [])].sort((a, b) => b.deletedAt - a.deletedAt), [current]);
  useEffect(() => setSel((s) => new Set([...s].filter((id) => items.some((i) => i.id === id)))), [items]);

  useEffect(() => {
    if (keyed.current && focus) rowRefs.current.get(focus)?.focus();
    keyed.current = false;
  }, [focus]);
  /** the row that takes Tab: the focused one, else the first selected, else the first */
  const tabRow = focus && items.some((i) => i.id === focus) ? focus : (items.find((i) => sel.has(i.id)) ?? items[0])?.id;

  const click = (e: React.MouseEvent, it: TrashItem) => {
    setFocus(it.id);
    if (e.shiftKey && anchor) {
      const a = items.findIndex((x) => x.id === anchor);
      const b = items.findIndex((x) => x.id === it.id);
      setSel(new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        n.has(it.id) ? n.delete(it.id) : n.add(it.id);
        return n;
      });
      setAnchor(it.id);
    } else {
      setSel(new Set([it.id]));
      setAnchor(it.id);
    }
  };

  const summarise = (label: string, rs: TrashResult[]) => onStatus(trashSummary(label, rs));
  const vol = current?.volume ?? "/";
  const restore = async (ids: string[], o: { conflict?: "fail" | "rename" | "replace"; toDir?: string } = {}) => {
    setBusy(true);
    try {
      const { results } = await api.trashRestore(node, vol, ids, o);
      summarise("Restore", results);
      const clash = results.filter((r) => r.conflict).map((r) => r.id);
      if (clash.length) setDlg({ k: "conflict", ids: clash, toDir: o.toDir });
    } catch (e) {
      onStatus(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      load();
    }
  };
  const del = async (ids: string[]) => {
    setBusy(true);
    try {
      summarise("Delete permanently", (await api.trashDelete(node, vol, ids)).results);
    } catch (e) {
      onStatus(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      load();
    }
  };
  const ids = [...sel];
  const restorable = ids.length > 0 && ids.every((id) => !items.find((i) => i.id === id)?.orphan);

  const listKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,select,textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    const ids = items.map((i) => i.id);
    const row = e.target instanceof HTMLElement ? e.target.closest("tr") : null;
    if (!row?.hasAttribute("data-id") && e.target !== root.current) return;
    if (e.key === "Delete") {
      const target = sel.size ? [...sel] : focus ? [focus] : [];
      if (!target.length) return;
      e.preventDefault();
      setDlg({ k: "del", ids: target });
    } else if (e.key === "Enter" && !mod && !e.shiftKey) {
      const target = sel.size ? [...sel] : focus ? [focus] : [];
      if (!target.length || !target.every((id) => !items.find((i) => i.id === id)?.orphan) || busy) return;
      e.preventDefault();
      void restore(target);
    } else {
      const next = trashKey(ids, { focus: focus ?? row?.getAttribute("data-id") ?? null, anchor, sel }, e.key, { shift: e.shiftKey, mod });
      if (!next) return;
      e.preventDefault();
      keyed.current = true;
      setFocus(next.focus);
      setAnchor(next.anchor);
      setSel(new Set(next.sel));
    }
    e.stopPropagation();
  };

  return (
    <div
      ref={root}
      className="ed trash over"
      role="dialog"
      aria-label={`Trash on ${node}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (dlg || (e.target as HTMLElement).closest("input,select,textarea")) return;
        if (e.key === "Escape") {
          onClose();
          e.stopPropagation();
        } else if (e.target === e.currentTarget) listKey(e);
      }}
    >
      <div className="ed-head" role="group" aria-label="Toolbar">
        <b>Trash</b>
        <span className="muted">{node}</span>
        <span className="ed-spacer" />
        <Tip label="Reload"><button onClick={load}><Ic.RefreshCw /> Refresh</button></Tip>
        <Tip label="Close" shortcut="Esc"><button onClick={onClose}><Ic.X /> Close</button></Tip>
      </div>
      {vols && vols.length > 0 && (
        <div
          className="tr-tabs"
          role="tablist"
          aria-label="Volumes"
          onKeyDown={(e) => {
            const at = vols.findIndex((v) => v.volume === current?.volume);
            const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? vols.length - 1 : null;
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            const v = vols[(next + vols.length) % vols.length]!;
            setSel(new Set());
            onVolume(v.volume);
            requestAnimationFrame(() => document.getElementById(`${uid}-tab-${vols.indexOf(v)}`)?.focus());
          }}
        >
          {vols.map((v, i) => (
            <button key={v.volume} id={`${uid}-tab-${i}`} role="tab" aria-selected={v.volume === current?.volume} aria-controls={`${uid}-panel`} tabIndex={v.volume === current?.volume ? 0 : -1} className={v.volume === current?.volume ? "on" : ""} onClick={() => (setSel(new Set()), onVolume(v.volume))}>
              <Ic.HardDrive /> {v.volume} <span className="pill">{v.items.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="tr-bar">
        <Tip label="Restore to the original location" shortcut="Enter"><button disabled={!restorable || busy} onClick={() => void restore(ids)}><Ic.Undo2 /> Restore</button></Tip>
        <button disabled={!restorable || busy} onClick={() => setDlg({ k: "to", ids })}><Ic.FolderInput /> Restore to...</button>
        <Tip label="Delete permanently" shortcut="Del"><button disabled={!ids.length || busy} onClick={() => setDlg({ k: "del", ids })}><Ic.CircleX /> Delete permanently</button></Tip>
        <button disabled={!items.length || busy} onClick={() => setDlg({ k: "empty" })}><Ic.Trash2 /> Empty trash...</button>
        <span className="muted tr-count">{items.length ? `${items.length} item(s)${current?.truncated ? " (list truncated)" : ""}${ids.length ? `, ${ids.length} selected` : ""}` : ""}</span>
      </div>
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      <div className="ed-body tr-body" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${Math.max(0, vols?.findIndex((v) => v.volume === current?.volume) ?? 0)}`}>
        {!vols && !err && <div className="pad muted">Loading...</div>}
        {vols && !items.length && <div className="pad muted">{vols.length ? "The trash is empty on this volume." : "Nothing has been trashed on this node."}</div>}
        {items.length > 0 && (
          <table
            className="ft"
            role="grid"
            aria-label="Trashed items"
            aria-multiselectable="true"
            onKeyDown={listKey}
          >
            <thead>
              <tr>
                <th>Name</th>
                <th>Original location</th>
                <th className="mtime">Deleted</th>
                <th className="size">Size</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.id}
                  data-id={it.id}
                  ref={(el) => void (el ? rowRefs.current.set(it.id, el) : rowRefs.current.delete(it.id))}
                  tabIndex={it.id === tabRow ? 0 : -1}
                  aria-selected={sel.has(it.id)}
                  className={sel.has(it.id) ? "sel" : ""}
                  onFocus={() => setFocus(it.id)}
                  onClick={(e) => click(e, it)} onDoubleClick={() => !it.orphan && void restore([it.id])}>
                  <td className="name">
                    <FileIcon className="ico" type={it.type} />
                    <span className="visually-hidden">{it.type === "dir" ? "Folder: " : "File: "}</span>
                    <span className="nm">{it.name}</span>
                    {it.orphan && <Tip label="metadata missing: can be deleted but not restored"><span className="pill">orphan</span></Tip>}
                  </td>
                  <td className="muted tr-loc"><Tip label={it.originalPath} fill><span>{dirOf(it.originalPath) || "-"}</span></Tip></td>
                  <td className="num">{it.deletedAt ? fmtDate(it.deletedAt) : "-"}</td>
                  <td className="num">{it.type === "dir" ? "" : fmtSize(it.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {dlg?.k === "del" && (
        <ConfirmDialog
          title="Delete permanently"
          message={`Permanently delete ${dlg.ids.length} item(s) from the trash? This cannot be undone.`}
          action="Delete permanently"
          danger
          onClose={() => setDlg(null)}
          onConfirm={() => void del(dlg.ids)}
        />
      )}
      {dlg?.k === "empty" && <EmptyDialog volume={vol} count={items.length} onClose={() => setDlg(null)} onRun={(days) => {
        setBusy(true);
        api.trashEmpty(node, vol, days).then((r) => onStatus(`Emptied ${vol}: ${r.removed} removed${r.failed ? `, ${r.failed} failed` : ""}`), (e: Error) => onStatus(`Empty failed: ${e.message}`)).finally(() => (setBusy(false), load()));
      }} />}
      {dlg?.k === "to" && (
        <NameDialog
          title={`Restore ${dlg.ids.length} item(s) to...`}
          label="Folder path on this node"
          initial={dirOf(items.find((i) => i.id === dlg.ids[0])?.originalPath ?? "") || "/"}
          action="Restore"
          allowSlash
          onClose={() => setDlg(null)}
          onSubmit={async (to) => void restore(dlg.ids, { toDir: to })}
        />
      )}
      {dlg?.k === "conflict" && (
        <Modal title="Name already taken" onClose={() => setDlg(null)}>
          <p className="pad0">{dlg.ids.length} item(s) cannot be restored because something with the same name is already there.</p>
          <div className="modal-actions">
            <button type="button" onClick={() => setDlg(null)}><Ic.SkipForward /> Skip</button>
            <button type="button" onClick={() => (setDlg(null), void restore(dlg.ids, { conflict: "rename", toDir: dlg.toDir }))}><Ic.CopyPlus /> Keep both</button>
            <Tip label="The existing item moves to the trash"><button type="submit" onClick={() => (setDlg(null), void restore(dlg.ids, { conflict: "replace", toDir: dlg.toDir }))}><Ic.Replace /> Replace</button></Tip>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EmptyDialog({ volume, count, onRun, onClose }: { volume: string; count: number; onRun: (days?: number) => void; onClose: () => void }) {
  const [days, setDays] = useState("");
  const n = days.trim() === "" ? undefined : Number(days);
  const valid = n === undefined || (Number.isFinite(n) && n >= 0);
  return (
    <Modal title={`Empty trash on ${volume}`} onClose={onClose}>
      <label>
        Only items deleted more than this many days ago (blank = everything)
        <input autoFocus inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 30" />
      </label>
      <p className="pad0">{n === undefined ? `All ${count} item(s) will be permanently deleted.` : "Matching items will be permanently deleted."} This cannot be undone.</p>
      <div className="modal-actions">
        <button type="button" onClick={onClose}><Ic.X /> Cancel</button>
        <button type="submit" className="danger" disabled={!valid} onClick={() => (onClose(), onRun(n))}><Ic.Trash2 /> Empty trash</button>
      </div>
    </Modal>
  );
}
