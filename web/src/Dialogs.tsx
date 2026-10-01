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

/** Create a symbolic link (name + target) or, with `existing`, retarget one. `onSubmit` throws to show an error. */
export function LinkDialog({ existing, onSubmit, onClose }: { existing?: { name: string; target: string }; onSubmit: (name: string, target: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [target, setTarget] = useState(existing?.target ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const n = name.trim();
    if (!n || n.includes("/") || n === "." || n === "..") return setErr("Enter a plain link name without slashes");
    if (!target) return setErr("Enter where the link points");
    setBusy(true);
    try {
      await onSubmit(n, target);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={existing ? "Edit link target" : "New symbolic link"} onClose={onClose}>
      <label>
        Link name
        <input autoFocus={!existing} value={name} readOnly={!!existing} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Points to (relative to the link's folder, or an absolute path)
        <input autoFocus={!!existing} value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
      </label>
      {err && <div className="fp-err" role="alert">{err}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy} onClick={() => void go()}>{existing ? "Save" : "Create"}</button>
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
