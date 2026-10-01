import { useEffect, useState } from "react";
import { fmtDate, fmtMode, fmtSize, stat, type Entry } from "./api";
import { Modal } from "./ArchiveDialog";

/** Ask for a single name (new file/folder, duplicate target...). `onSubmit` throws to show an error. */
export function NameDialog({ title, label, initial = "", action, onSubmit, onClose }: { title: string; label: string; initial?: string; action: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const v = name.trim();
    if (!v || v.includes("/") || v === "." || v === "..") return setErr("Enter a plain name without slashes");
    setBusy(true);
    try {
      await onSubmit(v);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <label>
        {label}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </label>
      {err && <div className="fp-err">{err}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy} onClick={() => void go()}>{action}</button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ title, message, action, danger, onConfirm, onClose }: { title: string; message: string; action: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="pad0">{message}</p>
      <div className="modal-actions">
        <button type="button" autoFocus onClick={onClose}>Cancel</button>
        <button
          type="submit"
          className={danger ? "danger" : undefined}
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}

const TYPE: Record<Entry["type"], string> = { file: "File", dir: "Folder", symlink: "Symbolic link", other: "Special file" };

/** Read-only properties of one entry (fetched when only a path is known). */
export function PropertiesDialog({ node, path, entry, onClose }: { node: string; path: string; entry?: Entry; onClose: () => void }) {
  const [e, setE] = useState<Entry | null>(entry ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (entry) return;
    stat(node, path).then(setE).catch((x: Error) => setErr(x.message));
  }, [node, path, entry]);
  const rows: [string, string][] = e
    ? [
        ["Name", e.name || "/"],
        ["Location", `${node}:${e.path}`],
        ["Type", TYPE[e.type] + (e.linkDir ? " (to a folder)" : "")],
        ...(e.type === "dir" ? [] : ([["Size", `${fmtSize(e.size)} (${e.size.toLocaleString()} bytes)`]] as [string, string][])),
        ["Modified", fmtDate(e.mtime)],
        ["Mode", `${fmtMode(e.mode, e.type)}  ${(e.mode & 0o7777).toString(8).padStart(4, "0")}`],
      ]
    : [];
  return (
    <Modal title="Properties" onClose={onClose}>
      {err && <div className="fp-err">{err}</div>}
      {!e && !err && <div className="muted">Loading...</div>}
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="modal-actions">
        <button type="submit" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
