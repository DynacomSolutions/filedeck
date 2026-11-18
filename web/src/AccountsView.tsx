import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { Tip } from "./Tooltip";
import { Modal } from "./ArchiveDialog";
import { useDialogFocus } from "./dialogFocus";
import { AccountEditor } from "./AccountEditor";
import { deleteAccount, listAccounts, overview, type AccountView, type Overview } from "./admin";
import type { Account } from "./auth";
import "./archive.css";
import "./accounts.css";

type Tab = "accounts" | "sessions" | "system";
const TABS: { id: Tab; label: string; Icon: Ic.LucideIcon }[] = [
  { id: "accounts", label: "Accounts", Icon: Ic.Users },
  { id: "sessions", label: "Signed in", Icon: Ic.MonitorSmartphone },
  { id: "system", label: "System users", Icon: Ic.Server },
];

/**
 * The Accounts view for administrators (overlay like Settings): the virtual accounts, who is signed in and the system users the hub
 * knows of. Every name and path is shown as text in <bdi>, never as HTML.
 */
export function AccountsView({ account, onClose }: { account: Account; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root);
  useEffect(() => root.current?.focus(), []);
  const uid = useId();
  const [tab, setTab] = useState<Tab>("accounts");
  const [data, setData] = useState<{ accounts: AccountView[]; overview: Overview } | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  /** the editor: a new account, or the account being edited */
  const [editing, setEditing] = useState<{ v?: AccountView } | null>(null);
  const [deleting, setDeleting] = useState<AccountView | null>(null);
  const editorBusy = useRef(false);

  const load = useCallback(() => {
    setErr("");
    Promise.all([listAccounts(), overview()]).then(
      ([l, ov]) => setData({ accounts: l.accounts, overview: ov }),
      (e: Error) => setErr(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const self = (name: string) => account.kind === "virt" && account.name === name;
  const tabKeys = (e: React.KeyboardEvent) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const t = TABS[(next + TABS.length) % TABS.length]!;
    setTab(t.id);
    requestAnimationFrame(() => document.getElementById(`${uid}-tab-${t.id}`)?.focus());
  };

  return (
    <div
      ref={root}
      className="ed settings over acc-view"
      role="dialog"
      aria-modal="true"
      aria-label="Accounts"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // a dialog on top of this one (the folder picker, a confirmation) handles its own Escape
        if ((e.target as Element | null)?.closest('[role="dialog"]') !== root.current) return;
        if (editing) {
          if (!editorBusy.current) setEditing(null);
        } else onClose();
      }}
    >
      <div className="ed-head" role="group" aria-label="Toolbar">
        <b>Accounts</b>
        <span className="ed-spacer" />
        <Tip label="Close" shortcut="Esc"><button type="button" onClick={onClose}><Ic.X aria-hidden="true" /> Close</button></Tip>
      </div>
      <div className="tr-tabs" role="tablist" aria-label="Accounts sections" onKeyDown={tabKeys}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            id={`${uid}-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
          >
            <t.Icon aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>
      <div className="ed-body set-body acc-body" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`}>
        {tab !== "accounts" ? (
          <p className="muted">This list is not available yet.</p>
        ) : editing && data ? (
          <AccountEditor
            key={editing.v?.name ?? ""}
            existing={editing.v}
            overview={data.overview}
            self={editing.v ? self(editing.v.name) : false}
            busyRef={editorBusy}
            onCancel={() => setEditing(null)}
            onSaved={(v, created) => {
              setEditing(null);
              setStatus(created ? `Account ${v.name} created.` : `Account ${v.name} saved. Its sessions have ended.`);
              load();
            }}
          />
        ) : (
          <section className="set-sec acc-list" aria-labelledby={`${uid}-list`}>
            <h2 id={`${uid}-list`}>Virtual accounts</h2>
            <p className="muted">Accounts that exist only in Filedeck. Each one acts as a system user on the machines it may use, and sees only the folders given to it.</p>
            <div className="vault-bar">
              <button type="button" className="primary" disabled={!data} onClick={() => (setStatus(""), setEditing({}))}><Ic.UserPlus aria-hidden="true" /> New account</button>
              <Tip label="Reload the list"><button type="button" onClick={load}><Ic.RefreshCw aria-hidden="true" /> Refresh</button></Tip>
              <span className="muted vault-count">{data ? `${data.accounts.length} ${data.accounts.length === 1 ? "account" : "accounts"}` : err ? "" : "Loading..."}</span>
            </div>
            <div className="acc-status" role="status">{status}</div>
            {err && <div className="ad-err" role="alert">{err}</div>}
            <div className="vault-wrap" role="region" aria-label="Virtual accounts table" tabIndex={0}>
              <table className="ft acc-table">
                <thead>
                  <tr>
                    <th className="acc-c-name">Name</th>
                    <th className="acc-c-admin">Administrator</th>
                    <th className="acc-c-sign">Sign-in</th>
                    <th>Machines</th>
                    <th className="acc-c-num">Sessions</th>
                    <th className="acc-c-act"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data?.accounts.map((a) => (
                    <tr key={a.name}>
                      <td className="acc-c-name"><bdi>{a.name}</bdi>{self(a.name) && <span className="pill">You</span>}</td>
                      <td>{a.admin ? "Yes" : "No"}</td>
                      <td>{a.hasPassword || a.keys.length > 0 ? "Can sign in" : "Cannot sign in"}</td>
                      <td className="acc-c-nodes">
                        {Object.keys(a.nodes).length === 0 ? (
                          <span className="muted">None</span>
                        ) : (
                          Object.keys(a.nodes).map((n, i) => (
                            <span key={n}>{i > 0 && ", "}<bdi>{n}</bdi></span>
                          ))
                        )}
                      </td>
                      <td className="num">{a.sessions}</td>
                      <td className="acc-c-act">
                        <span className="acc-acts">
                          <button type="button" aria-label={`Edit ${a.name}`} onClick={() => (setStatus(""), setEditing({ v: a }))}><Ic.Pencil aria-hidden="true" /> Edit</button>
                          <button type="button" className="danger" aria-label={`Delete ${a.name}`} onClick={() => (setStatus(""), setDeleting(a))}><Ic.Trash2 aria-hidden="true" /> Delete</button>
                        </span>
                      </td>
                    </tr>
                  ))}
                  {data && data.accounts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted vault-empty">No virtual accounts.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
      {deleting && (
        <DeleteAccount
          v={deleting}
          self={self(deleting.name)}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setStatus(`Account ${deleting.name} deleted.`);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Asks before deleting an account, and deletes it. A delete can take some seconds: the button shows it and cannot be pressed twice. */
function DeleteAccount({ v, self, onClose, onDeleted }: { v: AccountView; self: boolean; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sending = useRef(false);
  const msgId = useId();
  const go = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setErr("");
    try {
      await deleteAccount(v.name);
      // this page's own account is gone: a fresh load shows the sign-in screen
      if (self) location.reload();
      else onDeleted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete account" onClose={() => !busy && onClose()} describedBy={msgId}>
      <p id={msgId} className="pad0">
        Delete the account <bdi>{v.name}</bdi>? Its sessions and jobs end, and its saved passwords are forgotten.{self ? " This is your own account: this page signs out." : ""}
      </p>
      <div className="ad-err" role="alert">{err}</div>
      <div className="modal-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}><Ic.X aria-hidden="true" /> Cancel</button>
        <button type="submit" className="danger" disabled={busy} aria-busy={busy || undefined} onClick={() => void go()}>
          <Ic.Trash2 aria-hidden="true" /> {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
