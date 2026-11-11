import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtSize, parent, passwordState, type ArchiveEntry, type Entry, type Pw } from "./api";
import { ExtractDialog, PasswordInput, RememberOptions } from "./ArchiveDialog";
import { FileIcon } from "./FileIcon";
import { Tip } from "./Tooltip";
import { singleFlight } from "./singleFlight";
import * as Ic from "lucide-react";

type Listing = { entries: ArchiveEntry[]; truncated: boolean; bytes: number; encrypted?: boolean };

/** Browse an archive's contents without extracting it; pick entries to extract just those. */
export function ArchiveView({ node, entry }: { node: string; entry: Entry }) {
  const [data, setData] = useState<Listing | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [pw, setPw] = useState<Pw | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [remember, setRemember] = useState(false);
  const [folder, setFolder] = useState(false);
  const [lock, setLock] = useState<"required" | "incorrect" | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<string[] | null>(null);
  const [starting, setStarting] = useState(false);
  const startHere = useRef<() => Promise<unknown>>(async () => undefined);
  startHere.current = () =>
    api
      .startExtract(node, entry.path, parent(entry.path), true, {}, pw)
      .then((j) => setMsg(`Started: ${j.title}`))
      .catch((e: Error) => (passwordState(e) ? setDialog([]) : setMsg(e.message)));
  // one wrapper for the life of the view, so a double click starts one job
  const extractHere = useRef(singleFlight(() => startHere.current(), setStarting)).current;
  useEffect(() => {
    setData(null);
    setErr("");
    setMsg("");
    setPw(undefined);
    setDraft("");
    setLock(null);
    setPicked(new Set());
  }, [node, entry.path]);
  useEffect(() => {
    let live = true;
    setErr("");
    api
      .archiveList(node, entry.path, pw)
      .then((d) => {
        if (!live) return;
        setLock(null);
        setData(d);
      })
      .catch((e: Error) => {
        if (!live) return;
        const st = passwordState(e);
        if (st) setLock(st);
        else setErr(e.message);
      });
    return () => {
      live = false;
    };
  }, [node, entry.path, pw]);

  const names = useMemo(() => (data ? data.entries.map((e) => e.name.replace(/\/$/, "")) : []), [data]);
  const toggle = (n: string) =>
    setPicked((p) => {
      const q = new Set(p);
      if (q.has(n)) q.delete(n);
      else q.add(n);
      return q;
    });
  const allOn = names.length > 0 && picked.size === names.length;

  if (lock && !data) {
    return (
      <div className="av">
        <div className="av-lock">
          <b><Ic.Lock /> This archive is password protected</b>
          <span className="muted">Its file list is encrypted, so a password is needed even to browse it.</span>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft) setPw({ password: draft, remember, folder });
            }}
          >
            <PasswordInput value={draft} onChange={setDraft} state={lock} errorId={lock === "incorrect" ? "av-pw-err" : undefined} />
            <RememberOptions remember={remember} setRemember={setRemember} folder={folder} setFolder={setFolder} />
            <div className="ad-err" id="av-pw-err" role="alert">{lock === "incorrect" ? "Wrong password." : ""}</div>
            <button type="submit" disabled={!draft}><Ic.LockOpen /> Unlock</button>
          </form>
        </div>
      </div>
    );
  }
  return (
    <div className="av">
      <div className="av-bar">
        <button disabled={starting} onClick={() => void extractHere()}>
          <Ic.PackageOpen /> Extract here
        </button>
        <Tip label="Choose a destination, overwrite policy and password for the ticked entries">
          <button disabled={picked.size === 0} onClick={() => setDialog([...picked])}>
            <Ic.ListChecks /> Extract selected{picked.size ? ` (${picked.size})` : ""}
          </button>
        </Tip>
        <span className="muted" role="status">
          {data ? `${data.entries.length}${data.truncated ? "+" : ""} entries, ${fmtSize(data.bytes)} uncompressed` : err ? "" : "reading archive..."}
        </span>
        {data?.encrypted && <span className="muted"><Ic.Lock /> encrypted</span>}
        <span className="muted" role="status">{msg}</span>
      </div>
      {err && <div className="fp-err" role="alert">{err}</div>}
      {data && (
        <table className="ft av-table">
          <thead>
            <tr>
              <th className="sel">
                <input type="checkbox" aria-label="Select all entries" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(names))} />
              </th>
              <th>Name</th>
              <th className="size">Size</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={i} aria-selected={picked.has(names[i]!)}>
                <td className="sel">
                  <input type="checkbox" aria-label={`Select ${e.name}`} checked={picked.has(names[i]!)} onChange={() => toggle(names[i]!)} />
                </td>
                <td className="name">
                  <Tip label={e.link ? `${e.name} -> ${e.link}` : e.name} fill>
                    <span>
                      <FileIcon className="ico" type={e.type} />
                      {e.name}
                      {e.encrypted && <Ic.Lock className="ico" aria-label="encrypted" />}
                    </span>
                  </Tip>
                </td>
                <td className="num">{e.type === "file" ? fmtSize(e.size) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.truncated && <div className="fp-err">Listing truncated; extract to see everything.</div>}
      {dialog && (
        <ExtractDialog
          node={node}
          archive={entry.path}
          defaultDest={parent(entry.path)}
          entries={dialog}
          password={pw}
          onClose={() => setDialog(null)}
          onStatus={setMsg}
        />
      )}
    </div>
  );
}
