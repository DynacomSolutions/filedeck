import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtDate, fmtSize, parent, type TrashItem, type TrashResult, type TrashVolume } from "./api";
import { Modal } from "./ArchiveDialog";
import { ConfirmDialog, NameDialog } from "./Dialogs";
import { FileIcon } from "./FileIcon";
import { Tip } from "./Tooltip";

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
  const root = useRef<HTMLDivElement>(null);

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
  useEffect(() => root.current?.focus(), []);

  const current = vols?.find((v) => v.volume === volume) ?? vols?.find((v) => v.items.length) ?? vols?.[0];
  useEffect(() => {
    if (current && current.volume !== volume) onVolume(current.volume);
  }, [current, volume, onVolume]);
  const items = useMemo(() => [...(current?.items ?? [])].sort((a, b) => b.deletedAt - a.deletedAt), [current]);
  useEffect(() => setSel((s) => new Set([...s].filter((id) => items.some((i) => i.id === id)))), [items]);

  const click = (e: React.MouseEvent, it: TrashItem) => {
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

  const summarise = (label: string, rs: TrashResult[]) => {
    const ok = rs.filter((r) => r.ok).length;
    const bad = rs.filter((r) => !r.ok && !r.conflict);
    onStatus(`${label}: ${ok} done${bad.length ? `, ${bad.length} failed (${bad[0]!.error})` : ""}`);
  };
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

  return (
    <div
      ref={root}
      className="ed trash"
      role="dialog"
      aria-label={`Trash on ${node}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (dlg || (e.target as HTMLElement).closest("input,select,textarea")) return;
        if (e.key === "Escape") onClose();
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSel(new Set(items.map((i) => i.id)));
        } else if (e.key === "Delete" && ids.length) setDlg({ k: "del", ids });
        else if (e.key === "Enter" && restorable) void restore(ids);
        else return;
        e.stopPropagation();
      }}
    >
      <header className="ed-head">
        <b>Trash</b>
        <span className="muted">{node}</span>
        <span className="ed-spacer" />
        <Tip label="Reload"><button onClick={load}>Refresh</button></Tip>
        <Tip label="Close" shortcut="Esc"><button onClick={onClose}>Close</button></Tip>
      </header>
      {vols && vols.length > 0 && (
        <div className="tr-tabs" role="tablist" aria-label="Volumes">
          {vols.map((v) => (
            <button key={v.volume} role="tab" aria-selected={v.volume === current?.volume} className={v.volume === current?.volume ? "on" : ""} onClick={() => (setSel(new Set()), onVolume(v.volume))}>
              {v.volume} <span className="pill">{v.items.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="tr-bar">
        <Tip label="Restore to the original location" shortcut="Enter"><button disabled={!restorable || busy} onClick={() => void restore(ids)}>Restore</button></Tip>
        <button disabled={!restorable || busy} onClick={() => setDlg({ k: "to", ids })}>Restore to...</button>
        <Tip label="Delete permanently" shortcut="Del"><button disabled={!ids.length || busy} onClick={() => setDlg({ k: "del", ids })}>Delete permanently</button></Tip>
        <button disabled={!items.length || busy} onClick={() => setDlg({ k: "empty" })}>Empty trash...</button>
        <span className="muted tr-count">{items.length ? `${items.length} item(s)${current?.truncated ? " (list truncated)" : ""}${ids.length ? `, ${ids.length} selected` : ""}` : ""}</span>
      </div>
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      <div className="ed-body tr-body">
        {!vols && !err && <div className="pad muted">Loading...</div>}
        {vols && !items.length && <div className="pad muted">{vols.length ? "The trash is empty on this volume." : "Nothing has been trashed on this node."}</div>}
        {items.length > 0 && (
          <table className="ft">
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
                <tr key={it.id} className={sel.has(it.id) ? "sel" : ""} onClick={(e) => click(e, it)} onDoubleClick={() => !it.orphan && void restore([it.id])}>
                  <td className="name">
                    <FileIcon className="ico" type={it.type} />
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
            <button type="button" onClick={() => setDlg(null)}>Skip</button>
            <button type="button" onClick={() => (setDlg(null), void restore(dlg.ids, { conflict: "rename", toDir: dlg.toDir }))}>Keep both</button>
            <Tip label="The existing item moves to the trash"><button type="submit" onClick={() => (setDlg(null), void restore(dlg.ids, { conflict: "replace", toDir: dlg.toDir }))}>Replace</button></Tip>
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
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="danger" disabled={!valid} onClick={() => (onClose(), onRun(n))}>Empty trash</button>
      </div>
    </Modal>
  );
}
