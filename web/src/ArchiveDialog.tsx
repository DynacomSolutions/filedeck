import { useEffect, useRef, useState } from "react";
import { api, type ArchiveFormat } from "./api";

export function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  // Keyboard users: focus returns to where it was when the dialog closes, and Tab stays inside it.
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null); // read before autoFocus moves it
  useEffect(() => () => opener.current?.focus?.(), []);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key !== "Tab" || !form.current) return;
    const f = Array.from(form.current.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])")).filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <form
        ref={form}
        className={"modal" + (wide ? " wide" : "")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trap}
        onSubmit={(e) => e.preventDefault()}
      >
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  );
}

export function CompressDialog({
  node,
  dir,
  names,
  onClose,
  onStatus,
}: {
  node: string;
  dir: string;
  names: string[];
  onClose: () => void;
  onStatus: (m: string) => void;
}) {
  const [format, setFormat] = useState<ArchiveFormat>("zip");
  const [name, setName] = useState(names.length === 1 ? names[0]! : dir.split("/").filter(Boolean).pop() || "archive");
  const [err, setErr] = useState("");
  const go = () =>
    api
      .startCompress(node, dir, names, format, name)
      .then((j) => {
        onStatus(`Started: ${j.title}`);
        onClose();
      })
      .catch((e: Error) => setErr(e.message));
  return (
    <Modal title={`Compress ${names.length} item(s)`} onClose={onClose}>
      <label>
        Archive name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as ArchiveFormat)}>
          <option value="zip">.zip</option>
          <option value="tar.gz">.tar.gz</option>
          <option value="tar.zst">.tar.zst</option>
          <option value="7z">.7z</option>
        </select>
      </label>
      {err && <div className="fp-err">{err}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" onClick={() => void go()}>Compress</button>
      </div>
    </Modal>
  );
}

export function ExtractDialog({
  node,
  archive,
  defaultDest,
  onClose,
  onStatus,
}: {
  node: string;
  archive: string;
  defaultDest: string;
  onClose: () => void;
  onStatus: (m: string) => void;
}) {
  const [dest, setDest] = useState(defaultDest);
  const [sub, setSub] = useState(true);
  const [err, setErr] = useState("");
  const go = () =>
    api
      .startExtract(node, archive, dest, sub)
      .then((j) => {
        onStatus(`Started: ${j.title}`);
        onClose();
      })
      .catch((e: Error) => setErr(e.message));
  return (
    <Modal title={`Extract ${archive.split("/").pop()}`} onClose={onClose}>
      <label>
        Destination folder
        <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} />
      </label>
      <label className="chk">
        <input type="checkbox" checked={sub} onChange={(e) => setSub(e.target.checked)} /> Put contents in a new subfolder named after the archive
      </label>
      {err && <div className="fp-err">{err}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" onClick={() => void go()}>Extract</button>
      </div>
    </Modal>
  );
}
