import { useEffect, useId, useRef, useState } from "react";
import { LogIn } from "lucide-react";
import { brand } from "./brand";
import { login, loginKey, SignInError } from "./auth";
import { KeyFileError, parsePrivateKey } from "./sshkey";
import "./archive.css";

type Method = "password" | "key";
const METHODS: { value: Method; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key file" },
];

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The sign-in screen, shown instead of the app when the hub says signed out. A key file is read here and never sent:
 * only the public key line and a signature go to the hub. The password, key text and passphrase are dropped from
 * state after each attempt, and nothing is stored.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [method, setMethod] = useState<Method>("password");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [keyText, setKeyText] = useState("");
  const [keyEncrypted, setKeyEncrypted] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  /** a new value empties the file input */
  const [fileGen, setFileGen] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const errId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Sign in · ${brand.title}`;
  }, []);

  const forgetSecrets = () => {
    setPassword("");
    setKeyText("");
    setKeyEncrypted(false);
    setPassphrase("");
    setFileGen((g) => g + 1);
  };

  const pick = (m: Method) => {
    setMethod(m);
    setErr("");
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
    setErr("");
    setKeyText("");
    setKeyEncrypted(false);
    setPassphrase("");
    if (!file) return;
    if (file.size > 64 * 1024) return setErr("Not an OpenSSH private key");
    const text = await file.text();
    try {
      setKeyEncrypted(parsePrivateKey(text).encrypted);
      setKeyText(text);
    } catch (e) {
      setErr(e instanceof KeyFileError ? sentence(e.message) : "Cannot read the key file");
      setFileGen((g) => g + 1);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) return (setErr("Enter your name"), nameRef.current?.focus());
    if (method === "password" && !password) return setErr("Enter your password");
    if (method === "key" && !keyText) return setErr("Choose a key file");
    if (method === "key" && keyEncrypted && !passphrase) return setErr("Enter the passphrase for this key");
    setBusy(true);
    setErr("");
    try {
      if (method === "password") await login(n, password);
      else await loginKey(n, keyText, keyEncrypted ? passphrase : undefined);
      forgetSecrets();
      onSignedIn();
    } catch (e) {
      forgetSecrets();
      setErr(e instanceof SignInError ? e.message : e instanceof KeyFileError ? sentence(e.message) : "Sign-in failed");
      setBusy(false);
    }
  };

  const invalid = err ? true : undefined;
  const describedBy = err ? errId : undefined;
  return (
    <main className="signin">
      <form className="modal signin-form" aria-labelledby={`${errId}-h`} onSubmit={(e) => void submit(e)} noValidate>
        <h1 id={`${errId}-h`}>Sign in to {brand.title}</h1>
        <label>
          Name
          <input ref={nameRef} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={name} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => (setName(e.target.value), setErr(""))} />
        </label>
        <div className="theme-seg signin-seg" role="radiogroup" aria-label="Sign in with">
          {METHODS.map(({ value, label }, i) => (
            <button key={value} type="button" data-v={value} role="radio" aria-checked={method === value} tabIndex={method === value ? 0 : -1} onClick={() => pick(value)} onKeyDown={(e) => moveMethod(e, i)}>
              {label}
            </button>
          ))}
        </div>
        {method === "password" ? (
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => (setPassword(e.target.value), setErr(""))} />
          </label>
        ) : (
          <>
            <label>
              Key file
              <input key={fileGen} type="file" className="signin-file" aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => void readFile(e.target.files?.[0])} />
            </label>
            <p className="signin-note">The key stays on this device. Only a signature is sent.</p>
            {keyEncrypted && (
              <label>
                Passphrase
                <input type="password" autoComplete="off" value={passphrase} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => (setPassphrase(e.target.value), setErr(""))} />
              </label>
            )}
          </>
        )}
        <p id={errId} className="signin-err" role="alert">{err}</p>
        <div className="modal-actions">
          <button type="submit" disabled={busy}><LogIn aria-hidden="true" /> {busy ? "Signing in..." : "Sign in"}</button>
        </div>
      </form>
    </main>
  );
}
