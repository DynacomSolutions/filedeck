import { useId, useRef, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { Modal } from "./ArchiveDialog";
import { SignInError, startAsRoot } from "./auth";
import "./archive.css";

type Method = "password" | "key";
const METHODS: { value: Method; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key file" },
];
type Field = "password" | "key" | "passphrase";

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** KeyFileError from ./sshkey, which is loaded only on the key path, so it is told by name here. */
const keyFileError = (e: unknown): string | null => (e instanceof Error && e.name === "KeyFileError" ? e.message : null);

/**
 * Asks a system administrator for a fresh password or key signature to act as root, with the same fields and messages
 * as the sign-in screen. The key is for the signed-in account's own `name`. The password, key text and passphrase stay
 * in this component's state only for one attempt: they are dropped after each attempt (after a wrong passphrase only
 * the passphrase) and when the dialog closes, and nothing is stored.
 */
export function AsRootDialog({ name, onStarted, onClose }: { name: string; onStarted: (asRootUntil: number) => void; onClose: () => void }) {
  const [method, setMethod] = useState<Method>("password");
  const [password, setPassword] = useState("");
  const [keyText, setKeyText] = useState("");
  const [keyEncrypted, setKeyEncrypted] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  /** a new value empties the file input */
  const [fileGen, setFileGen] = useState(0);
  const [err, setErr] = useState("");
  const [errField, setErrField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  /** counts file picks and resets; a read that finishes after a newer one (or after the secrets were dropped) is ignored */
  const readGen = useRef(0);
  /** false once the dialog has closed, so a late answer does not touch it */
  const open = useRef(true);
  const errId = useId();
  const noteId = useId();

  const fail = (message: string, field: Field | null = null) => {
    setErr(message);
    setErrField(field);
  };
  const clearErr = () => fail("");
  const forgetSecrets = () => {
    readGen.current++;
    setPassword("");
    setKeyText("");
    setKeyEncrypted(false);
    setPassphrase("");
    setFileGen((g) => g + 1);
  };
  const close = () => {
    open.current = false;
    forgetSecrets();
    onClose();
  };

  const pick = (m: Method) => {
    setMethod(m);
    clearErr();
    forgetSecrets();
  };
  const moveMethod = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = METHODS[(i + d + METHODS.length) % METHODS.length]!;
    pick(n.value);
    (e.currentTarget.parentElement?.querySelector(`[data-v="${n.value}"]`) as HTMLElement | null)?.focus();
  };

  const readFile = async (file: File | undefined) => {
    const gen = ++readGen.current;
    clearErr();
    setKeyText("");
    setKeyEncrypted(false);
    setPassphrase("");
    if (!file) return;
    if (file.size > 64 * 1024) return fail("Not an OpenSSH private key", "key");
    try {
      const [text, { parsePrivateKey }] = await Promise.all([file.text(), import("./sshkey")]);
      if (gen !== readGen.current) return;
      setKeyEncrypted(parsePrivateKey(text).encrypted);
      setKeyText(text);
    } catch (e) {
      if (gen !== readGen.current) return;
      fail(sentence(keyFileError(e) ?? "cannot read the key file"), "key");
      setFileGen((g) => g + 1);
    }
  };

  const submit = async () => {
    if (busy) return;
    if (method === "password" && !password) return fail("Enter your password", "password");
    if (method === "key" && !keyText) return fail("Choose a key file", "key");
    if (method === "key" && keyEncrypted && !passphrase) return fail("Enter the passphrase for this key", "passphrase");
    setBusy(true);
    clearErr();
    try {
      const { asRootUntil } = await startAsRoot(method === "password" ? { password } : { keyText, passphrase: keyEncrypted ? passphrase : undefined, name });
      if (!open.current) return;
      forgetSecrets();
      onStarted(asRootUntil);
      close();
    } catch (e) {
      if (!open.current) return;
      const k = keyFileError(e);
      if (k === "wrong passphrase") {
        // keep the chosen file, so only the passphrase needs typing again
        setPassphrase("");
        fail("Wrong passphrase", "passphrase");
      } else {
        forgetSecrets();
        fail(e instanceof SignInError ? e.message : k ? sentence(k) : "Sign-in failed", k ? "key" : null);
      }
    } finally {
      if (open.current) setBusy(false);
    }
  };

  const errProps = (f: Field) => (err && errField === f ? { "aria-invalid": true as const, "aria-describedby": errId } : {});
  return (
    <Modal title="Act as root" onClose={close} describedBy={noteId}>
      <p id={noteId} className="signin-note">Give your password or key again. For 15 minutes, or until you stop it, Filedeck acts as root for you.</p>
      <div className="theme-seg signin-seg" role="radiogroup" aria-label="Confirm with">
        {METHODS.map(({ value, label }, i) => (
          <button key={value} type="button" data-v={value} role="radio" aria-checked={method === value} tabIndex={method === value ? 0 : -1} onClick={() => pick(value)} onKeyDown={(e) => moveMethod(e, i)}>
            {label}
          </button>
        ))}
      </div>
      {method === "password" ? (
        <label>
          Password
          <input type="password" autoFocus autoComplete="current-password" value={password} {...errProps("password")} onChange={(e) => (setPassword(e.target.value), clearErr())} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())} />
        </label>
      ) : (
        <>
          <label>
            Key file
            <input key={fileGen} type="file" className="signin-file" {...errProps("key")} onChange={(e) => void readFile(e.target.files?.[0])} />
          </label>
          <p className="signin-note">The key stays on this device. Only a signature is sent.</p>
          {keyEncrypted && (
            <label>
              Passphrase
              <input type="password" autoComplete="off" value={passphrase} {...errProps("passphrase")} onChange={(e) => (setPassphrase(e.target.value), clearErr())} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())} />
            </label>
          )}
        </>
      )}
      <p id={errId} className="signin-err" role="alert">{err}</p>
      <div className="modal-actions">
        <button type="button" onClick={close}><X aria-hidden="true" /> Cancel</button>
        <button type="submit" disabled={busy} onClick={() => void submit()}><ShieldAlert aria-hidden="true" /> {busy ? "Checking..." : "Act as root"}</button>
      </div>
    </Modal>
  );
}
