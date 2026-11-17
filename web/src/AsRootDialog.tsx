import { useId, useRef } from "react";
import { ShieldAlert, X } from "lucide-react";
import { Modal } from "./ArchiveDialog";
import { startAsRoot } from "./auth";
import { ProofFields, useProofFields } from "./ProofFields";
import "./archive.css";

/**
 * Asks a system administrator for a fresh password or key signature to act as root, with the sign-in screen's fields,
 * messages and secret handling (ProofFields). The key signs for the signed-in account's own `name`. The secrets are
 * dropped after each attempt and when the dialog closes; nothing is stored. `onStarted` gets the local end time.
 */
export function AsRootDialog({ name, onStarted, onClose }: { name: string; onStarted: (endsAt: number) => void; onClose: () => void }) {
  const f = useProofFields();
  const noteId = useId();
  const open = useRef(true);
  const close = () => {
    open.current = false;
    f.forgetSecrets();
    onClose();
  };
  const submit = async () => {
    // a switch the hub turned on is reported even if the dialog was closed meanwhile: it is on at the hub either way
    const ok = await f.run(async (p) => onStarted((await startAsRoot("password" in p ? p : { ...p, name })).asRootEndsAt));
    if (ok && open.current) close();
  };
  return (
    <Modal title="Act as root" onClose={close} describedBy={noteId}>
      <p id={noteId} className="signin-note">Give your password or key again. For 15 minutes, or until you stop it, Filedeck acts as root for you.</p>
      <ProofFields f={f} groupLabel="Confirm with" focusPassword />
      <div className="modal-actions">
        <button type="button" onClick={close}><X aria-hidden="true" /> Cancel</button>
        <button type="submit" disabled={f.busy} onClick={() => void submit()}><ShieldAlert aria-hidden="true" /> {f.busy ? "Checking..." : "Act as root"}</button>
      </div>
    </Modal>
  );
}
