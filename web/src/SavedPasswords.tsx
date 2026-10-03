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
  const load = useCallback(() => {
    api.vaultList().then((r) => (setV(r), setErr("")), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 20_000);
    return () => window.clearInterval(t);
  }, [load]);
  const forget = (id: string) => api.vaultForget(id).then(load, (e: Error) => setErr(e.message));
  const entries = v?.entries ?? [];
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
                <td className="num">{e.expiresAt === null ? "Never" : fmtDate(e.expiresAt)}</td>
                <td className="vault-act">
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
