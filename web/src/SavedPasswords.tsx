import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, type VaultEntry } from "./api";
import { ConfirmDialog } from "./Dialogs";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";
import "./vault.css";

interface VaultInfo {
  entries: VaultEntry[];
  persistent: boolean;
  ttlSeconds: number;
  maxHours: number;
}

/** Settings section: the archive and PDF passwords the server is holding. Values are never shown or sent here, only where and for how long. */
export function SavedPasswords() {
  const [v, setV] = useState<VaultInfo | null>(null);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [extending, setExtending] = useState<string | null>(null);
  const load = useCallback(() => {
    api.vaultList().then((r) => (setV(r), setErr("")), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 20_000);
    return () => window.clearInterval(t);
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  const forget = (id: string) => api.vaultForget(id).then(load, (e: Error) => setErr(e.message));
  const extend = (id: string) => {
    setExtending(id);
    void api.vaultExtend(id).then(load, (e: Error) => setErr(e.message)).finally(() => setExtending(null));
  };
  const entries = v?.entries ?? [];
  const expiringSoon = entries.filter((e) => e.expiresAt !== null && e.expiresAt > now && e.expiresAt - now <= 60_000);
  const atLifetimeLimit = (e: VaultEntry) => Boolean(v && e.createdAt + v.maxHours * 3_600_000 <= now + 60_000);
  const remaining = (e: VaultEntry) => Math.max(1, Math.ceil((e.expiresAt! - now) / 1000));
  return (
    <section className="set-sec vault-sec" aria-labelledby="set-pw">
      <h2 id="set-pw">Saved passwords</h2>
      <p className="muted">
        Passwords you typed for encrypted archives and PDFs, kept encrypted on the server so you do not retype them.
        {v ? ` Unless remembered they expire after ${Math.round(v.ttlSeconds / 60)} minutes without use, and always ${v.maxHours} hours after they were entered.` : ""}
      </p>
      <p className="vault-note muted" role="status">
        {v && !v.persistent ? <><Ic.TriangleAlert /> No vault key is configured, so saved passwords are held in memory only and are lost when the hub restarts.</> : ""}
      </p>
      {expiringSoon.length > 0 && (
        <div className="vault-warning" role="alert">
          <Ic.TriangleAlert />
          <span>{expiringSoon.length === 1 ? `A saved password expires in about ${remaining(expiringSoon[0]!)} seconds.` : `${expiringSoon.length} saved passwords expire within the next minute.`} {expiringSoon.some((e) => !atLifetimeLimit(e)) ? "Use “Keep active” to renew the idle timeout where the maximum lifetime allows." : "Re-enter the password after it expires."}</span>
        </div>
      )}
      <div className="vault-bar">
        <Tip label="Reload the list"><button onClick={load}><Ic.RefreshCw /> Refresh</button></Tip>
        <button disabled={!entries.length} onClick={() => setConfirm(true)}><Ic.Trash2 /> Forget all</button>
        <span className="muted vault-count">{v ? `${entries.length} saved` : "Loading..."}</span>
      </div>
      {err && <div className="ad-err" role="alert">{err}</div>}
      <div className="vault-wrap">
        <table className="ft vault-table">
          <thead>
            <tr>
              <th>Location</th>
              <th className="vault-scope">Scope</th>
              <th className="vault-kept">Kept</th>
              <th className="vault-date">Last used</th>
              <th className="vault-date">Expires at</th>
              <th className="vault-act"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="vault-loc">
                  <Tip label={`${e.node}:${e.path}`} fill>
                    <span>{e.scope === "folder" ? <Ic.Folder className="ico" /> : <Ic.FileLock className="ico" />}<b>{e.node}</b> {e.path}</span>
                  </Tip>
                </td>
                <td>{e.scope === "folder" ? "All files in folder" : "This file"}</td>
                <td>{e.remembered ? <span className="pill">Remembered</span> : "Expiring"}</td>
                <td className="num">{fmtDate(e.lastUsed)}</td>
                <td className="num">{e.expiresAt === null ? "Never" : <>{fmtDate(e.expiresAt)}{expiringSoon.includes(e) && <span className="vault-expiry-warning">Expires soon</span>}</>}</td>
                <td className="vault-act">
                  {expiringSoon.includes(e) && (atLifetimeLimit(e) ? <span className="vault-maxed">Maximum lifetime; re-enter after expiry</span> : <button type="button" onClick={() => extend(e.id)} disabled={extending === e.id} aria-label={`Keep the saved password for ${e.path} active`}>{extending === e.id ? "Keeping..." : "Keep active"}</button>)}
                  <Tip label="Forget this saved password"><button aria-label={`Forget the saved password for ${e.path}`} onClick={() => void forget(e.id)}><Ic.KeyRound /> Forget</button></Tip>
                </td>
              </tr>
            ))}
            {v && !entries.length && (
              <tr>
                <td colSpan={6} className="muted vault-empty">No saved passwords.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Forget all saved passwords"
          message={`Forget all ${entries.length} saved password(s)? You will be asked again the next time you open those files.`}
          action="Forget all"
          danger
          onConfirm={() => void api.vaultForgetAll().then(load, (e: Error) => setErr(e.message))}
          onClose={() => setConfirm(false)}
        />
      )}
    </section>
  );
}
