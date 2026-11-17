import { useEffect, useRef, useState } from "react";
import { LogIn } from "lucide-react";
import { brand } from "./brand";
import { login, loginKey } from "./auth";
import { ProofFields, useProofFields } from "./ProofFields";
import "./archive.css";

/**
 * The sign-in screen, shown instead of the app when the hub says signed out. The password and key-file fields and
 * their secret handling are shared with the act-as-root dialog (ProofFields): a key file is read here and never sent,
 * only the public key line and a signature go to the hub, the secrets are dropped from state after each attempt
 * (after a wrong passphrase only the passphrase, so the file need not be chosen again), and nothing is stored.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [name, setName] = useState("");
  const f = useProofFields<"name">();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Sign in · ${brand.title}`;
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.busy) return;
    const n = name.trim();
    if (!n) return (f.fail("Enter your name", "name"), nameRef.current?.focus());
    const ok = await f.run((p) => ("password" in p ? login(n, p.password) : loginKey(n, p.keyText, p.passphrase)).then(() => undefined));
    if (ok) onSignedIn();
  };

  return (
    <main className="signin">
      <form className="modal signin-form" aria-labelledby={`${f.errId}-h`} onSubmit={(e) => void submit(e)} noValidate>
        <h1 id={`${f.errId}-h`}>Sign in to {brand.title}</h1>
        <label>
          Name
          <input ref={nameRef} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={name} {...f.errProps("name")} onChange={(e) => (setName(e.target.value), f.clearErr())} />
        </label>
        <ProofFields f={f} groupLabel="Sign in with" />
        <div className="modal-actions">
          <button type="submit" disabled={f.busy}><LogIn aria-hidden="true" /> {f.busy ? "Signing in..." : "Sign in"}</button>
        </div>
      </form>
    </main>
  );
}
