import { useEffect, useId, useRef, useState } from "react";
import { LogIn } from "lucide-react";
import { brand } from "./brand";
import { login, loginKey, SignInError } from "./auth";
import "./archive.css";

type Method = "password" | "key";
const METHODS: { value: Method; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key file" },
];

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** KeyFileError from ./sshkey, which is loaded only on the key path, so it is told by name here. */
const keyFileError = (e: unknown): string | null => (e instanceof Error && e.name === "KeyFileError" ? e.message : null);
type Field = "name" | "password" | "key" | "passphrase";

/**
 * The sign-in screen, shown instead of the app when the hub says signed out. A key file is read here and never sent:
 * only the public key line and a signature go to the hub. The password, key text and passphrase are dropped from
 * state after each attempt (after a wrong passphrase only the passphrase, so the file need not be chosen again), and
 * nothing is stored.
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
  /** the field the error is about, if any; only that one is marked invalid */
  const [errField, setErrField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  /** counts file picks and resets; a read that finishes after a newer one (or after the secrets were dropped) is ignored */
  const readGen = useRef(0);
  const errId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Sign in · ${brand.title}`;
  }, []);

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
      if (gen !== readGen.current) return; // the method changed, or another file was picked, meanwhile
      setKeyEncrypted(parsePrivateKey(text).encrypted);
      setKeyText(text);
    } catch (e) {
      if (gen !== readGen.current) return;
      fail(sentence(keyFileError(e) ?? "cannot read the key file"), "key");
      setFileGen((g) => g + 1);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) return (fail("Enter your name", "name"), nameRef.current?.focus());
    if (method === "password" && !password) return fail("Enter your password", "password");
    if (method === "key" && !keyText) return fail("Choose a key file", "key");
    if (method === "key" && keyEncrypted && !passphrase) return fail("Enter the passphrase for this key", "passphrase");
    setBusy(true);
    clearErr();
    try {
      if (method === "password") await login(n, password);
      else await loginKey(n, keyText, keyEncrypted ? passphrase : undefined);
      forgetSecrets();
      onSignedIn();
    } catch (e) {
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
      setBusy(false);
    }
  };

  const errProps = (f: Field) => (err && errField === f ? { "aria-invalid": true as const, "aria-describedby": errId } : {});
  return (
    <main className="signin">
      <form className="modal signin-form" aria-labelledby={`${errId}-h`} onSubmit={(e) => void submit(e)} noValidate>
        <h1 id={`${errId}-h`}>Sign in to {brand.title}</h1>
        <label>
          Name
          <input ref={nameRef} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={name} {...errProps("name")} onChange={(e) => (setName(e.target.value), clearErr())} />
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
            <input type="password" autoComplete="current-password" value={password} {...errProps("password")} onChange={(e) => (setPassword(e.target.value), clearErr())} />
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
                <input type="password" autoComplete="off" value={passphrase} {...errProps("passphrase")} onChange={(e) => (setPassphrase(e.target.value), clearErr())} />
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
