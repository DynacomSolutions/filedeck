import { useState } from "react";
import { Modal } from "./ArchiveDialog";

/** Ask for a single name (new file/folder, duplicate target...). `onSubmit` throws to show an error. */
export function NameDialog({ title, label, initial = "", action, allowSlash, onSubmit, onClose }: { title: string; label: string; initial?: string; action: string; allowSlash?: boolean; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const v = name.trim();
    if (allowSlash ? !v.startsWith("/") : !v || v.includes("/") || v === "." || v === "..") return setErr(allowSlash ? "Enter an absolute path starting with /" : "Enter a plain name without slashes");
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
