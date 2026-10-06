import { useEffect, useRef, useState } from "react";
import { api, passwordState, type ArchiveFormat, type OverwritePolicy, type Pw } from "./api";
import { Tip } from "./Tooltip";
import "./archive.css";
import * as Ic from "lucide-react";
import { useDialogFocus } from "./dialogFocus";

export function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  useDialogFocus(form);
  return (
    <div className="modal-back" role="presentation" onMouseDown={onClose}>
      <form
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={"modal" + (wide ? " wide" : "")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => e.preventDefault()}
      >
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  );
}

export interface CompressGroup {
  node: string;
  dir: string;
  names: string[];
}

const FORMATS: { id: ArchiveFormat; label: string; hint: string; encrypt: boolean; split: boolean }[] = [
  { id: "zip", label: ".zip", hint: "Opens everywhere. Password uses AES-256.", encrypt: true, split: true },
  { id: "7z", label: ".7z", hint: "Best ratio. Can also hide file names.", encrypt: true, split: true },
  { id: "tar.gz", label: ".tar.gz", hint: "Unix standard. No password.", encrypt: false, split: false },
  { id: "tar.zst", label: ".tar.zst", hint: "Fast and strong. No password.", encrypt: false, split: false },
  { id: "tar.xz", label: ".tar.xz", hint: "Small, slow. No password.", encrypt: false, split: false },
];
const LEVELS: { v: number; label: string }[] = [
  { v: 0, label: "Store (no compression)" },
  { v: 1, label: "Fastest" },
  { v: 3, label: "Fast" },
  { v: 5, label: "Normal" },
  { v: 7, label: "Maximum" },
  { v: 9, label: "Ultra" },
];
const UNITS = [
  { u: "MB", n: 1024 ** 2 },
  { u: "GB", n: 1024 ** 3 },
];

/** Compress the selection; items from several folders (or nodes) become one archive per folder. */
export function CompressDialog({ groups, onClose, onStatus }: { groups: CompressGroup[]; onClose: () => void; onStatus: (m: string) => void }) {
  const total = groups.reduce((n, g) => n + g.names.length, 0);
  const first = groups[0]!;
  const [format, setFormat] = useState<ArchiveFormat>("zip");
  const [name, setName] = useState(total === 1 ? first.names[0]! : first.dir.split("/").filter(Boolean).pop() || "archive");
  const [level, setLevel] = useState(5);
  const [dest, setDest] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hdr, setHdr] = useState(false);
  const [vol, setVol] = useState("");
  const [unit, setUnit] = useState(UNITS[0]!.n);
  const [excl, setExcl] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const spec = FORMATS.find((f) => f.id === format)!;
  const canHdr = format === "7z" && pw !== "";
  const go = async () => {
    setErr("");
    const volBytes = vol.trim() === "" ? undefined : Math.round(Number(vol) * unit);
    if (spec.encrypt && pw !== pw2) return setErr("The two passwords do not match.");
    if (/[\r\n]/.test(pw)) return setErr("A password cannot contain a line break.");
    if (format === "zip" && /[^\x20-\x7e]/.test(pw)) return setErr("Zip passwords can only use plain ASCII characters. Use 7z for any characters.");
    if (volBytes !== undefined && (!Number.isFinite(volBytes) || volBytes < 64 * 1024)) return setErr("Volume size must be at least 64 KB.");
    const exclude = excl.split("\n").map((x) => x.trim()).filter(Boolean);
    setBusy(true);
    try {
      for (const [i, g] of groups.entries()) {
        const j = await api.startCompress(
          g.node,
          g.dir,
          g.names,
          format,
          groups.length > 1 ? `${name}-${i + 1}` : name,
          {
            level,
            ...(exclude.length ? { exclude } : {}),
            ...(dest.trim() ? { destDir: dest.trim() } : {}),
            ...(spec.split && volBytes ? { splitBytes: volBytes } : {}),
            ...(canHdr && hdr ? { encryptHeaders: true } : {}),
          },
          spec.encrypt && pw ? { password: pw } : undefined,
        );
        onStatus(`Started: ${j.title}`);
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Compress ${total} item(s)`} onClose={onClose} wide>
      <div className="ad-grid">
        <label>
          Archive name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Location
          <input value={dest} placeholder={groups.length > 1 ? "Next to each item" : first.dir} onChange={(e) => setDest(e.target.value)} />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as ArchiveFormat)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label>
          Compression level
          <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            {LEVELS.map((l) => (
              <option key={l.v} value={l.v} disabled={l.v === 0 && !FORMATS.find((f) => f.id === format)!.encrypt}>{l.label}</option>
            ))}
          </select>
        </label>
        <label>
          Password
          <input type="password" autoComplete="new-password" value={pw} disabled={!spec.encrypt} placeholder={spec.encrypt ? "Optional" : "Not available for this format"} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label>
          Repeat password
          <input type="password" autoComplete="new-password" value={pw2} disabled={!spec.encrypt || pw === ""} onChange={(e) => setPw2(e.target.value)} />
        </label>
        <label className="chk ad-span">
          <input type="checkbox" checked={canHdr && hdr} disabled={!canHdr} onChange={(e) => setHdr(e.target.checked)} /> Also encrypt file names (.7z with a password)
        </label>
        <label>
          Split into volumes
          <span className="ad-row">
            <input type="number" min={0} step="any" inputMode="decimal" value={vol} disabled={!spec.split} placeholder={spec.split ? "No splitting" : "Zip and 7z only"} onChange={(e) => setVol(e.target.value)} />
            <select value={unit} disabled={!spec.split} onChange={(e) => setUnit(Number(e.target.value))} aria-label="Volume size unit">
              {UNITS.map((u) => (
                <option key={u.u} value={u.n}>{u.u}</option>
              ))}
            </select>
          </span>
        </label>
        <label className="ad-excl">
          Exclude patterns, one per line
          <textarea rows={3} value={excl} placeholder={"*.log\nnode_modules"} spellCheck={false} onChange={(e) => setExcl(e.target.value)} />
        </label>
      </div>
      <p className="muted ad-note">
        {spec.hint}
        {groups.length > 1 ? ` The items sit in ${groups.length} folders, so ${groups.length} archives are made.` : ""}
      </p>
      <div className="ad-err" role="alert">{err}</div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}><Ic.X /> Cancel</button>
        <button type="submit" disabled={busy} onClick={() => void go()}><Ic.Archive /> Compress</button>
      </div>
    </Modal>
  );
}

/** Password row for a locked archive; `state` says why it is shown. */
export type LockState = "none" | "required" | "incorrect" | "saved";
export function PasswordInput({ value, onChange, state, disabled, label = "Password" }: { value: string; onChange: (v: string) => void; state: LockState; disabled?: boolean; label?: string }) {
  return (
    <label className="ad-pw">
      {label}
      <span className="ad-pw-in">
        {state === "none" ? <Ic.LockOpen /> : state === "saved" ? <Ic.KeyRound /> : <Ic.Lock />}
        <input
          type="password"
          autoComplete="off"
          value={value}
          disabled={disabled ?? (state === "none" || state === "saved")}
          placeholder={state === "none" ? "Not password protected" : state === "saved" ? "Using the saved password" : state === "incorrect" ? "Wrong password, try again" : "This archive is password protected"}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

/** Remember / folder switches shown under a password field. Unticked, the hub keeps the password encrypted for a sliding window (24 h at most). */
export function RememberOptions({ remember, setRemember, folder, setFolder, disabled }: { remember: boolean; setRemember: (v: boolean) => void; folder: boolean; setFolder: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="ad-rem">
      <Tip label="Without this the server still keeps the password, encrypted, while you keep using it (it expires after a short idle time and always after 24 hours). With it, it is kept until you choose Forget saved password.">
        <label className="chk">
          <input type="checkbox" checked={remember} disabled={disabled} onChange={(e) => setRemember(e.target.checked)} /> Remember
        </label>
      </Tip>
      <Tip label="Also use this password for every other file in this folder.">
        <label className="chk">
          <input type="checkbox" checked={folder} disabled={disabled} onChange={(e) => setFolder(e.target.checked)} /> Use for all files in this folder
        </label>
      </Tip>
    </div>
  );
}

export function ExtractDialog({
  node,
  archive,
  defaultDest,
  entries,
  password: initialPw,
  onClose,
  onStatus,
}: {
  node: string;
  archive: string;
  defaultDest: string;
  /** archive entries chosen in the archive browser; empty or missing extracts everything */
  entries?: string[];
  password?: Pw;
  onClose: () => void;
  onStatus: (m: string) => void;
}) {
  const [dest, setDest] = useState(defaultDest);
  const [sub, setSub] = useState(!entries?.length);
  const [policy, setPolicy] = useState<OverwritePolicy>("rename");
  const [pw, setPw] = useState(initialPw?.password ?? "");
  const [remember, setRemember] = useState(initialPw?.remember ?? false);
  const [folder, setFolder] = useState(initialPw?.folder ?? false);
  const [lock, setLock] = useState<LockState>(initialPw ? "required" : "none");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Detect protection up front: the password row switches on instead of failing the job later.
  useEffect(() => {
    let live = true;
    api
      .archiveList(node, archive, initialPw, 1)
      .then((d) => live && d.encrypted && setLock(d.usedSaved ? "saved" : "required"))
      .catch((e) => live && passwordState(e) && setLock("required"));
    return () => {
      live = false;
    };
  }, [node, archive, initialPw]);
  const go = async () => {
    setErr("");
    setBusy(true);
    try {
      const j = await api.startExtract(node, archive, dest, sub, { overwrite: policy, ...(entries?.length ? { entries } : {}) }, lock !== "none" && lock !== "saved" && pw ? { password: pw, remember, folder } : undefined);
      onStatus(`Started: ${j.title}`);
      onClose();
    } catch (e) {
      const st = passwordState(e);
      if (st) setLock(st);
      setErr(st === "incorrect" ? "Wrong password." : st === "required" ? "Enter the archive password." : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Extract ${archive.split("/").pop()}`} onClose={onClose}>
      {!!entries?.length && <p className="muted ad-note">Extracting {entries.length} selected item(s) from the archive.</p>}
      <label>
        Destination folder
        <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} />
      </label>
      <label className="chk">
        <input type="checkbox" checked={sub} onChange={(e) => setSub(e.target.checked)} /> Put contents in a new subfolder named after the archive
      </label>
      <label>
        If a file already exists
        <select value={policy} onChange={(e) => setPolicy(e.target.value as OverwritePolicy)}>
          <option value="rename">Keep both (rename the new one)</option>
          <option value="overwrite">Replace the existing file</option>
          <option value="skip">Skip, keep the existing file</option>
        </select>
      </label>
      <PasswordInput value={pw} onChange={setPw} state={lock} />
      <div className="ad-saved">
        {lock === "saved" ? (
          <button type="button" onClick={() => setLock("required")}><Ic.KeyRound /> Use a different password</button>
        ) : (
          <RememberOptions remember={remember} setRemember={setRemember} folder={folder} setFolder={setFolder} disabled={lock === "none"} />
        )}
      </div>
      <div className="ad-err" role="alert">{err}</div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}><Ic.X /> Cancel</button>
        <button type="submit" disabled={busy} onClick={() => void go()}><Ic.PackageOpen /> Extract</button>
      </div>
    </Modal>
  );
}
