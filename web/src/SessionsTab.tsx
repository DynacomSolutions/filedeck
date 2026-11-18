import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { Tip } from "./Tooltip";
import { Modal } from "./ArchiveDialog";
import { endAccountSessions, endSession, listSessions, sessionsByAccount, type SessionInfo } from "./admin";
import type { Account } from "./auth";
import { fmtDate } from "./fmtDate";
import "./archive.css";
import "./accounts.css";
import "./sessions.css";

/** How often the list reads again while its tab is shown. */
export const REFRESH_MS = 30_000;

type Ask = { one: SessionInfo } | { all: { kind: "sys" | "virt"; name: string } };

/**
 * Who is signed in (administrators only): one row per session, grouped by account. "End" ends one session (its jobs go on); "End all
 * sessions" ends every session of an account and cancels its jobs. Ending the caller's own session, or all of one's own account,
 * asks first and then reloads the page. The list reads again after each action and every 30 s for as long as this tab is mounted.
 * Addresses and names are untrusted text: React text, in <bdi>.
 */
export function SessionsTab({ account }: { account: Account }) {
  const uid = useId();
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState("");
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    listSessions().then(
      (l) => alive.current && (setList(l), setErr("")),
      (e: Error) => alive.current && setErr(e.message),
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const isMine = (kind: string, name: string) => account.kind === kind && account.name === name;

  /** Runs one ended-session call after its confirm. `reload`: the caller's own session goes with it, so the page loads afresh. */
  const run = async (what: string, call: () => Promise<void>, reload: boolean, done: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(what);
    setErr("");
    try {
      await call();
      if (reload) {
        location.reload();
        return;
      }
      setAsking(null);
      setStatus(done);
      load();
      // the row (and the button that opened the confirm) may be gone: focus goes to the heading
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    } catch (e) {
      setErr((e as Error).message);
      setAsking(null);
    } finally {
      sending.current = false;
      setBusy("");
    }
  };

  const groups = list ? sessionsByAccount(list) : [];
  const kindLabel = (k: "sys" | "virt") => (k === "sys" ? "System user" : "Virtual account");

  return (
    <div className="sess-view">
      <section className="set-sec sess-list" aria-labelledby={`${uid}-h`} inert={asking !== null || undefined}>
        <h2 id={`${uid}-h`} ref={heading} tabIndex={-1}>Signed in</h2>
        <p className="muted">Every session that is signed in to this hub now. Ending one session leaves the account's jobs running. Ending all of an account's sessions cancels its jobs too.</p>
        <div className="vault-bar">
          <Tip label="Reload the list"><button type="button" onClick={load}><Ic.RefreshCw aria-hidden="true" /> Refresh</button></Tip>
          <span className="muted vault-count">{list ? `${list.length} ${list.length === 1 ? "session" : "sessions"}` : err ? "" : "Loading..."}</span>
        </div>
        <div className="acc-status" role="status">{status}</div>
        {err && <div className="ad-err" role="alert">{err}</div>}
        <div className="vault-wrap" role="region" aria-label="Signed-in sessions table" tabIndex={0}>
          <table className="ft sess-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Signed in</th>
                <th>Method</th>
                <th>Last used</th>
                <th>Address</th>
                <th>Notes</th>
                <th className="sess-c-act"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={`${g.kind}:${g.name}`}>
                <tr>
                  <th scope="rowgroup" colSpan={7} className="sess-group">
                    <span className="sess-group-in">
                      <span><bdi>{g.name}</bdi> <span className="pill">{kindLabel(g.kind)}</span></span>
                      <span className="sess-spacer" />
                      <button type="button" className="danger" disabled={busy !== ""} aria-label={`End all sessions of ${g.name}`} onClick={() => setAsking({ all: { kind: g.kind, name: g.name } })}>
                        <Ic.LogOut aria-hidden="true" /> End all sessions
                      </button>
                    </span>
                  </th>
                </tr>
                {g.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="acc-c-name"><bdi>{s.name}</bdi></td>
                    <td>{fmtDate(s.created)}</td>
                    <td className="sess-method"><Method s={s} /></td>
                    <td>{fmtDate(s.lastUsed)}</td>
                    <td className="sess-addr">{s.address ? <bdi>{s.address}</bdi> : <span className="muted">Unknown</span>}</td>
                    <td>
                      {s.current && <span className="pill">This session</span>}
                      {s.asRootUntil !== undefined && <span className="pill">Acting as root</span>}
                    </td>
                    <td className="sess-c-act">
                      <button type="button" disabled={busy !== ""} onClick={() => (s.current ? setAsking({ one: s }) : void run(`end-${s.id}`, () => endSession(s.id), false, `Ended the session of ${s.name}.`))}>
                        <Ic.X aria-hidden="true" /> End
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
            {list && list.length === 0 && (
              <tbody>
                <tr><td colSpan={7} className="muted vault-empty">Nobody is signed in.</td></tr>
              </tbody>
            )}
          </table>
        </div>
      </section>
      {asking && "one" in asking && (
        <ConfirmDialog
          title="End your own session"
          busy={busy !== ""}
          confirm="End session"
          onClose={() => setAsking(null)}
          onConfirm={() => void run("self", () => endSession(asking.one.id), true, "")}
        >
          This is the session you are using. Ending it signs you out of this page, which then reloads. The jobs of your account go on.
        </ConfirmDialog>
      )}
      {asking && "all" in asking && (
        <ConfirmDialog
          title="End all sessions"
          busy={busy !== ""}
          confirm="End all sessions"
          onClose={() => setAsking(null)}
          onConfirm={() => {
            const a = asking.all;
            void run("all", () => endAccountSessions(a.kind, a.name), isMine(a.kind, a.name), `Ended all sessions of ${a.name}.`);
          }}
        >
          End all sessions of <bdi>{asking.all.name}</bdi>? Its jobs are cancelled.
          {isMine(asking.all.kind, asking.all.name) ? " This is your own account: you are signed out too, and this page reloads." : ""}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** How a session signed in: "Password", "Key" or "Tailscale (<source>)", with the login or tag that matched and the device when the hub says. */
function Method({ s }: { s: SessionInfo }) {
  if (s.method === "tailscale") {
    return (
      <>
        Tailscale{s.tailnetSource ? ` (${s.tailnetSource})` : ""}
        {s.tailnet && <span className="muted sess-sub"><bdi>{s.tailnet}</bdi></span>}
        {s.tailnetDevice && <span className="muted sess-sub">on <bdi>{s.tailnetDevice}</bdi></span>}
      </>
    );
  }
  if (s.method === "password") return <>Password</>;
  if (s.method === "key") return <>Key</>;
  return <span className="muted">Unknown</span>;
}

/** A confirm in the Modal pattern: Cancel has focus, the action is disabled while it runs, and Escape waits for it. */
export function ConfirmDialog({ title, confirm, busy, error, onClose, onConfirm, children }: { title: string; confirm: string; busy: boolean; error?: string; onClose: () => void; onConfirm: () => void; children: React.ReactNode }) {
  const msgId = useId();
  return (
    <Modal title={title} onClose={() => !busy && onClose()} describedBy={msgId}>
      <p id={msgId} className="pad0">{children}</p>
      {error !== undefined && <div className="ad-err" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}><Ic.X aria-hidden="true" /> Cancel</button>
        <button type="submit" className="danger" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
          <Ic.Check aria-hidden="true" /> {busy ? "Working…" : confirm}
        </button>
      </div>
    </Modal>
  );
}
