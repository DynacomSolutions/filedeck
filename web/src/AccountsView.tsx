import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { Tip } from "./Tooltip";
import { Modal } from "./ArchiveDialog";
import { useDialogFocus } from "./dialogFocus";
import { AccountEditor } from "./AccountEditor";
import { SessionsTab, ConfirmDialog } from "./SessionsTab";
import { SystemUsersTab, type SystemCtl } from "./SystemUsersTab";
import { deleteAccount, forgetUnownedPasswords, listAccounts, overview, type AccountView, type Overview } from "./admin";
import type { Account } from "./auth";
import "./archive.css";
import "./accounts.css";
import "./sessions.css";

type Tab = "accounts" | "sessions" | "system";
const TABS: { id: Tab; label: string; Icon: Ic.LucideIcon }[] = [
  { id: "accounts", label: "Accounts", Icon: Ic.Users },
  { id: "sessions", label: "Signed in", Icon: Ic.MonitorSmartphone },
  { id: "system", label: "System users", Icon: Ic.Server },
];

/**
 * The Accounts view for administrators (overlay like Settings): the virtual accounts, who is signed in and the system users the hub
 * knows of. Every name, path and address is shown as text in <bdi>, never as HTML. The tabs are a tablist: arrow keys, Home and End move
 * between them. The Accounts tab stays mounted (hidden) while another is shown, so an open editor keeps what was typed.
 */
export function AccountsView({ account, onClose }: { account: Account; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root);
  // preventScroll: focusing the overlay must not scroll the page under it
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const uid = useId();
  const [tab, setTab] = useState<Tab>("accounts");
  const [data, setData] = useState<{ accounts: AccountView[]; overview: Overview } | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  /** the editor: a new account, or the account being edited */
  const [editing, setEditing] = useState<{ v?: AccountView } | null>(null);
  const [deleting, setDeleting] = useState<AccountView | null>(null);
  /** the "Forget them" confirm for the saved passwords from before sign-in was on */
  const [forgetting, setForgetting] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  /** a tab was opened by click or Enter (not an arrow key): focus then goes to the panel's heading */
  const opened = useRef(false);
  /** a change is with the hub: the editor is disabled, and Close and Escape wait */
  const [busy, setBusy] = useState(false);
  /** the editor's own close, which asks first when there are unsaved changes */
  const editorClose = useRef<((then?: () => void) => void) | null>(null);
  const editorDirty = useRef<(() => boolean) | null>(null);
  /** the System users tab's editor: whether it is open, whether it has unsaved changes, and how to leave it (asking first) */
  const sysCtl = useRef<SystemCtl | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  /** whether the editor was open at the last render: on its close focus goes to the list heading */
  const wasEditing = useRef(false);

  const load = useCallback(() => {
    setErr("");
    Promise.all([listAccounts(), overview()]).then(
      ([l, ov]) => setData({ accounts: l.accounts, overview: ov }),
      (e: Error) => setErr(e.message),
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (wasEditing.current && !editing) listHeading.current?.focus({ preventScroll: true });
    wasEditing.current = editing !== null;
  }, [editing]);
  useEffect(() => {
    if (!opened.current) return;
    opened.current = false;
    // the visible heading: the Accounts panel is hidden while another tab shows
    [...(panel.current?.querySelectorAll<HTMLElement>("h2") ?? [])].find((h) => h.getClientRects().length > 0)?.focus({ preventScroll: true });
  }, [tab]);
  /** Back to the list from the editor; the list is read again, since keys may have changed meanwhile. */
  const closeEditor = () => {
    setEditing(null);
    load();
  };

  /**
   * Leaves the whole view (Close, or Escape with no editor open). An editor with unsaved changes, on this tab or another, asks
   * "Discard changes?" first; the Accounts editor's prompt is on the Accounts tab, so that tab is shown for it.
   */
  const closeView = () => {
    if (busy) return;
    if (tab === "system" && sysCtl.current?.editing()) return sysCtl.current.close(onClose);
    if (editing && editorDirty.current?.()) {
      setTab("accounts");
      editorClose.current?.(onClose);
      return;
    }
    onClose();
  };

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
        if (busy) return;
        if (tab === "system" && sysCtl.current?.editing()) sysCtl.current.close();
        else if (editing && tab === "accounts") editorClose.current?.();
        else closeView();
      }}
    >
      <div className="ed-head" role="group" aria-label="Toolbar">
        <b>Accounts</b>
        <span className="ed-spacer" />
        <Tip label="Close" shortcut="Esc"><button type="button" disabled={busy} onClick={closeView}><Ic.X aria-hidden="true" /> Close</button></Tip>
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
            onClick={() => ((opened.current = true), setTab(t.id))}
          >
            <t.Icon aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>
      <div className="ed-body set-body acc-body" id={`${uid}-panel`} ref={panel} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`}>
        {tab === "sessions" && <SessionsTab account={account} />}
        {tab === "system" && <SystemUsersTab account={account} ctl={sysCtl} />}
        <div hidden={tab !== "accounts"}>
        {/* above the list and the editor alike: "created" shows while the new account's editor is open */}
        <div className="acc-status" role="status">{status}</div>
        {editing && data ? (
          <AccountEditor
            key={editing.v?.name ?? ""}
            existing={editing.v}
            overview={data.overview}
            self={editing.v ? self(editing.v.name) : false}
            onBusy={setBusy}
            closeRef={editorClose}
            dirtyRef={editorDirty}
            onClose={closeEditor}
            onSaved={(v, created) => {
              if (created) {
                // open the new account's editor, where keys can be added
                setStatus(`Account ${v.name} created. Add keys here if it signs in with one.`);
                setEditing({ v });
              } else {
                setStatus(`Account ${v.name} saved. Its sessions have ended.`);
                setEditing(null);
              }
              load();
            }}
          />
        ) : (
          <section className="set-sec acc-list" aria-labelledby={`${uid}-list`}>
            <h2 id={`${uid}-list`} ref={listHeading} tabIndex={-1}>Virtual accounts</h2>
            <p className="muted">Accounts that exist only in Filedeck. Each one acts as a system user on the machines it may use, and sees only the folders given to it.</p>
            {data && data.overview.unownedPasswords > 0 && (
              <section className="acc-warn acc-notice" aria-label="Old saved passwords">
                <Ic.KeyRound aria-hidden="true" />
                <span className="acc-notice-text">
                  {data.overview.unownedPasswords === 1
                    ? "1 saved password from before sign-in was on is kept but not used."
                    : `${data.overview.unownedPasswords} saved passwords from before sign-in was on are kept but not used.`}
                </span>
                <button type="button" onClick={() => (setStatus(""), setForgetting(true))}><Ic.Trash2 aria-hidden="true" /> Forget them</button>
              </section>
            )}
            <div className="vault-bar">
              <button type="button" className="primary" disabled={!data} onClick={() => (setStatus(""), setEditing({}))}><Ic.UserPlus aria-hidden="true" /> New account</button>
              <Tip label="Reload the list"><button type="button" onClick={load}><Ic.RefreshCw aria-hidden="true" /> Refresh</button></Tip>
              <span className="muted vault-count">{data ? `${data.accounts.length} ${data.accounts.length === 1 ? "account" : "accounts"}` : err ? "" : "Loading..."}</span>
            </div>
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
                      <td>
                        {a.hasPassword || a.keys.length > 0 || (data.overview.tailscale !== null && a.tailnet.length > 0) ? "Can sign in" : "Cannot sign in"}
                        {a.tailnet.length > 0 && <span className="pill">Tailscale</span>}
                      </td>
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
      </div>
      {forgetting && data && (
        <ForgetPasswords
          count={data.overview.unownedPasswords}
          onClose={() => setForgetting(false)}
          onForgotten={(n) => {
            setForgetting(false);
            // the notice goes at once; focus goes to the list's heading, since the button that opened the confirm is gone
            setData((d) => d && { ...d, overview: { ...d.overview, unownedPasswords: 0 } });
            setStatus(`${n} saved ${n === 1 ? "password" : "passwords"} forgotten.`);
            requestAnimationFrame(() => listHeading.current?.focus({ preventScroll: true }));
            load();
          }}
        />
      )}
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

/** Asks before forgetting the passwords saved while sign-in was off (nobody can use them now), and forgets them. */
function ForgetPasswords({ count, onClose, onForgotten }: { count: number; onClose: () => void; onForgotten: (removed: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sending = useRef(false);
  const go = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setErr("");
    try {
      onForgotten(await forgetUnownedPasswords());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog title="Forget saved passwords" confirm="Forget them" busy={busy} error={err} onClose={onClose} onConfirm={() => void go()}>
      Forget {count === 1 ? "the 1 saved password" : `the ${count} saved passwords`} from before sign-in was on? Nobody can use {count === 1 ? "it" : "them"} now, and this cannot be undone.
    </ConfirmDialog>
  );
}
