import { useEffect, useState } from "react";
import { api, fileUrl, passwordState, pdfDecryptedUrl, type Pw } from "./api";
import { PasswordInput, RememberOptions, type LockState } from "./ArchiveDialog";
import * as Ic from "lucide-react";
import "./archive.css";

/**
 * PDF preview. The browser's own viewer renders ordinary PDFs. A PDF that needs a password asks for it here;
 * the password goes to the server (and, by default, into the encrypted vault), which hands the viewer a decrypted
 * copy, so the password itself never reaches the page or the viewer.
 */
export function PdfView({ node, path, name }: { node: string; path: string; name: string }) {
  const [state, setState] = useState<"loading" | "open" | "decrypted" | "locked">("loading");
  const [lock, setLock] = useState<LockState>("required");
  const [draft, setDraft] = useState("");
  const [remember, setRemember] = useState(false);
  const [folder, setFolder] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const check = (pw?: Pw) =>
    api
      .pdfStatus(node, path, pw)
      .then((r) => {
        setErr("");
        // encrypted but open (empty user password) renders natively; a password that was needed goes through the server copy
        setState(r.locked ? "locked" : r.encrypted && (r.usedSaved || pw) ? "decrypted" : "open");
      })
      .catch((e: Error) => {
        const st = passwordState(e);
        if (!st) {
          // not a PDF qpdf can read (or tools missing): fall back to the plain viewer
          setState("open");
          return;
        }
        setLock(st);
        setErr(st === "incorrect" ? "Wrong password." : "");
        setState("locked");
      });

  useEffect(() => {
    setState("loading");
    setDraft("");
    setErr("");
    setLock("required");
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, path]);

  if (state === "loading") return <div className="pv-empty muted">Loading...</div>;
  // No `sandbox` attribute: Chromium's PDF viewer refuses to load inside a sandboxed frame (the document would show
  // "blocked"). The agent already serves PDFs with `Content-Security-Policy: sandbox`, which keeps the content isolated.
  if (state === "open") return <iframe src={fileUrl(node, path)} title={name} />;
  if (state === "decrypted") return <iframe src={pdfDecryptedUrl(node, path)} title={name} />;
  return (
    <div className="av-lock">
      <b><Ic.Lock /> This PDF is password protected</b>
      <span className="muted">Enter the password to preview it. It is checked on the server and never shown again.</span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft) return;
          setBusy(true);
          void check({ password: draft, remember, folder }).finally(() => setBusy(false));
        }}
      >
        <PasswordInput value={draft} onChange={setDraft} state={lock} />
        <RememberOptions remember={remember} setRemember={setRemember} folder={folder} setFolder={setFolder} />
        <div className="ad-err" role="alert">{err}</div>
        <button type="submit" disabled={!draft || busy}><Ic.LockOpen /> Unlock</button>
      </form>
    </div>
  );
}
