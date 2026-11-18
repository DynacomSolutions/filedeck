import { useEffect, useId, useRef, useState } from "react";
import { attemptFailure, MAX_KEY_FILE, METHODS, missingProof, keyFileError, sentence, type Method, type ProofField } from "./proofFields";

/** What an attempt sends on: the password, or the key file text and its passphrase (only for a protected key). */
export type Proof = { password: string } | { keyText: string; passphrase?: string };

/**
 * The password / key-file state shared by the sign-in screen and the act-as-root dialog. A key file is read here and
 * never sent. The password, key text and passphrase are dropped after each attempt (after a wrong passphrase only the
 * passphrase: see attemptFailure), on a change of method, and by `forgetSecrets`; nothing is stored. `F` adds the
 * caller's own fields (the sign-in name) to the ones an error can be about.
 */
export function useProofFields<F extends string = never>() {
  type Field = ProofField | F;
  const [method, setMethod] = useState<Method>("password");
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
  /** false once the owner has gone, so a late answer sets no state */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readGen.current++;
    };
  }, []);
  const errId = useId();

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
    if (file.size > MAX_KEY_FILE) return fail("Not an OpenSSH private key", "key");
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

  /**
   * One attempt: checks what is missing, then `act` with the proof. The secrets are dropped after it, whatever the
   * outcome (after a wrong passphrase only the passphrase). True when `act` succeeded.
   */
  const run = async (act: (proof: Proof) => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    const missing = missingProof({ method, password, keyText, keyEncrypted, passphrase });
    if (missing) return (fail(missing.message, missing.field), false);
    setBusy(true);
    clearErr();
    try {
      await act(method === "password" ? { password } : { keyText, passphrase: keyEncrypted ? passphrase : undefined });
      if (mounted.current) forgetSecrets();
      return true;
    } catch (e) {
      if (!mounted.current) return false;
      const f = attemptFailure(e);
      if (f.keepKey) setPassphrase(""); // the key text stays: see attemptFailure
      else forgetSecrets();
      fail(f.message, f.field);
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * An attempt that needs no password or key (Tailscale sign-in): the same busy state and error line as `run`. The
   * fields are left as they are. True when `act` succeeded.
   */
  const runWithoutProof = async (act: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    clearErr();
    try {
      await act();
      return true;
    } catch (e) {
      if (mounted.current) fail(attemptFailure(e).message);
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const errProps = (f: Field) => (err && errField === f ? { "aria-invalid": true as const, "aria-describedby": errId } : {});
  return { method, password, setPassword, keyText, keyEncrypted, passphrase, setPassphrase, fileGen, err, errId, busy, fail, clearErr, forgetSecrets, pick, moveMethod, readFile, run, runWithoutProof, errProps };
}

/** What the fields need from useProofFields (any caller's extra fields are not theirs to mark) */
type Fields = Omit<ReturnType<typeof useProofFields>, "errProps" | "fail"> & { errProps: (f: ProofField) => object };

/** The method choice, the password or key-file fields, and the error line, as the sign-in screen shows them. */
export function ProofFields({ f, groupLabel, focusPassword }: { f: Fields; groupLabel: string; focusPassword?: boolean }) {
  return (
    <>
      <div className="theme-seg signin-seg" role="radiogroup" aria-label={groupLabel}>
        {METHODS.map(({ value, label }, i) => (
          <button key={value} type="button" data-v={value} role="radio" aria-checked={f.method === value} tabIndex={f.method === value ? 0 : -1} onClick={() => f.pick(value)} onKeyDown={(e) => f.moveMethod(e, i)}>
            {label}
          </button>
        ))}
      </div>
      {f.method === "password" ? (
        <label>
          Password
          <input type="password" autoFocus={focusPassword} autoComplete="current-password" value={f.password} {...f.errProps("password")} onChange={(e) => (f.setPassword(e.target.value), f.clearErr())} />
        </label>
      ) : (
        <>
          <label>
            Key file
            <input key={f.fileGen} type="file" className="signin-file" {...f.errProps("key")} onChange={(e) => void f.readFile(e.target.files?.[0])} />
          </label>
          <p className="signin-note">The key stays on this device. Only a signature is sent.</p>
          {f.keyEncrypted && (
            <label>
              Passphrase
              <input type="password" autoComplete="off" value={f.passphrase} {...f.errProps("passphrase")} onChange={(e) => (f.setPassphrase(e.target.value), f.clearErr())} />
            </label>
          )}
        </>
      )}
      <p id={f.errId} className="signin-err" role="alert">{f.err}</p>
    </>
  );
}
