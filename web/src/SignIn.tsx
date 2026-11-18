import { useEffect, useId, useRef, useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import { brand } from "./brand";
import { login, loginKey, loginTailscale, tailnet, type Tailnet } from "./auth";
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
  const [tn, setTn] = useState<Tailnet>(null);
  const asId = useId();

  useEffect(() => {
    document.title = `Sign in · ${brand.title}`;
    let live = true;
    void tailnet().then((t) => live && setTn(t));
    return () => {
      live = false;
    };
  }, []);

  const withTailscale = async () => {
    const ok = await f.runWithoutProof(() => loginTailscale().then(() => undefined));
    if (ok) onSignedIn();
  };

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
        {tn && "unavailable" in tn ? (
          <p className="signin-note">Tailscale sign-in is not available now.</p>
        ) : tn ? (
          <>
            <div className="signin-tailnet">
              <button type="button" className="signin-tailnet-btn" disabled={f.busy} aria-describedby={asId} onClick={() => void withTailscale()}>
                <LogIn aria-hidden="true" /> Sign in with Tailscale
              </button>
              <p id={asId} className="signin-note signin-as"><TailnetAs t={tn} /></p>
            </div>
            <p className="signin-or">or</p>
          </>
        ) : null}
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

/** "as alice@github" (with the display name when it says more), or "as this device: tag:ci, tag:web" for a tagged device. */
function TailnetAs({ t }: { t: Exclude<Tailnet, null | { unavailable: true }> }) {
  if (t.login !== undefined) {
    const shown = t.displayName && t.displayName !== t.login ? t.displayName : undefined;
    return (
      <>
        as {shown ? <><bdi>{shown}</bdi> (<bdi>{t.login}</bdi>)</> : <bdi>{t.login}</bdi>}
        {t.node !== undefined && <> on <bdi>{t.node}</bdi></>}
      </>
    );
  }
  return (
    <>
      as this device{t.node !== undefined && <> (<bdi>{t.node}</bdi>)</>}: {(t.tags ?? []).map((g, i) => <span key={g}>{i > 0 && ", "}<bdi>{g}</bdi></span>)}
    </>
  );
}

/**
 * Shown instead of the app while `GET /api/auth/me` answers 503: a Tailscale session whose tailscaled does not answer.
 * The hub keeps the session, so this is not the sign-in screen; the caller asks again with a growing wait, and
 * "Try now" asks at once.
 */
export function TailnetWaiting({ onRetry }: { onRetry: () => void }) {
  useEffect(() => {
    document.title = brand.title;
  }, []);
  return (
    <main className="signin">
      <div className="modal signin-form" role="group" aria-labelledby="tailnet-wait-h">
        <h1 id="tailnet-wait-h">{brand.title}</h1>
        <p className="pad0" role="status">Tailscale is not answering, trying again.</p>
        <div className="modal-actions">
          <button type="button" onClick={onRetry}><RefreshCw aria-hidden="true" /> Try now</button>
        </div>
      </div>
    </main>
  );
}
