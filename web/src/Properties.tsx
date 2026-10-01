import { useEffect, useRef, useState } from "react";
import { api, fmtDate, fmtMode, fmtSize, stat, type Entry, type JobView, type PermsResult, type Props, type SizeResult } from "./api";
import { Modal } from "./ArchiveDialog";

const TYPE: Record<Entry["type"], string> = { file: "File", dir: "Folder", symlink: "Symbolic link", other: "Special file" };
const GRID: [string, number, number, number][] = [
  ["Owner", 0o400, 0o200, 0o100],
  ["Group", 0o40, 0o20, 0o10],
  ["Others", 0o4, 0o2, 0o1],
];
const SPECIAL: [string, number][] = [
  ["Set user ID", 0o4000],
  ["Set group ID", 0o2000],
  ["Sticky", 0o1000],
];
const octal = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");
const live = (j: JobView) => j.state === "queued" || j.state === "running";

/** Poll a job on a node until it finishes. */
function useJob(node: string) {
  const [job, setJob] = useState<JobView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dead = useRef(false);
  useEffect(() => () => {
    dead.current = true;
    clearTimeout(timer.current);
  }, []);
  const watch = (first: JobView): Promise<JobView> =>
    new Promise((resolve) => {
      const step = (j: JobView) => {
        if (dead.current) return resolve(j);
        setJob(j);
        if (!live(j)) return resolve(j);
        timer.current = setTimeout(() => void api.job(node, j.id).then(step, () => resolve({ ...j, state: "failed", error: "lost track of the job" })), 400);
      };
      step(first);
    });
  return { job, watch, cancel: () => job && live(job) && void api.cancelJob(node, job.id) };
}

/** Details of one entry, with recursive size, chmod and chown. */
export function PropertiesDialog({ node, path, entry, onClose, onChanged, onStatus }: { node: string; path: string; entry?: Entry; onClose: () => void; onChanged: () => void; onStatus: (m: string) => void }) {
  const [p, setP] = useState<Props | null>(null);
  const [basic, setBasic] = useState<Entry | null>(entry ?? null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState(0);
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [scope, setScope] = useState<"all" | "files" | "dirs">("all");
  const [size, setSize] = useState<SizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const sizeJob = useJob(node);
  const permJob = useJob(node);

  const load = () =>
    api
      .props(node, path)
      .then((v) => {
        setP(v);
        setMode(v.mode);
        setOwner(v.owner ?? String(v.uid));
        setGroup(v.group ?? String(v.gid));
        setErr("");
      })
      .catch((e: Error) => {
        setErr(e.message);
        if (!entry) void stat(node, path).then(setBasic, () => undefined);
      });
  useEffect(() => {
    void load();
  }, [node, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const calc = async () => {
    setSize(null);
    try {
      const j = await sizeJob.watch(await api.startSize(node, path));
      if (j.state === "done") setSize(j.result as unknown as SizeResult);
      else if (j.state === "failed") setErr(j.error ?? "size failed");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const origOwner = p ? (p.owner ?? String(p.uid)) : "";
  const origGroup = p ? (p.group ?? String(p.gid)) : "";
  const changed = p ? { mode: mode !== p.mode, owner: owner.trim() !== origOwner, group: group.trim() !== origGroup } : { mode: false, owner: false, group: false };
  const dirty = changed.mode || changed.owner || changed.group;
  const isDir = p?.type === "dir";
  const apply = async () => {
    if (!p) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.perms(node, {
        path,
        ...(changed.mode ? { mode } : {}),
        ...(changed.owner ? { owner: owner.trim() } : {}),
        ...(changed.group ? { group: group.trim() } : {}),
        ...(isDir && recursive ? { recursive: true, scope } : {}),
      });
      let res: PermsResult;
      if ("id" in r) {
        const done = await permJob.watch(r);
        if (done.state !== "done") throw new Error(done.error ?? `job ${done.state}`);
        res = done.result as unknown as PermsResult;
      } else res = r;
      onStatus(`Permissions changed on ${res.changed} item(s)${res.errors ? `, ${res.errors} could not be changed` : ""}`);
      onChanged();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const type = p?.type ?? basic?.type;
  const rows: [string, React.ReactNode][] = [];
  const nm = p?.name ?? basic?.name;
  if (nm !== undefined) rows.push(["Name", nm || "/"]);
  rows.push(["Location", `${node}:${p?.path ?? basic?.path ?? path}`]);
  if (type) rows.push(["Type", TYPE[type] + ((p?.linkDir ?? basic?.linkDir) ? " (to a folder)" : "")]);
  if (p?.linkTarget !== undefined) rows.push(["Link target", p.linkTarget || "(unreadable)"]);
  const sz = p?.size ?? basic?.size;
  if (type && type !== "dir" && sz !== undefined) rows.push(["Size", `${fmtSize(sz)} (${sz.toLocaleString()} bytes)` + (p && p.type === "file" ? ` · ${fmtSize(p.diskBytes)} on disk` : "")]);
  const mt = p?.mtime ?? basic?.mtime;
  if (mt !== undefined) rows.push(["Modified", fmtDate(mt)]);
  if (p) {
    rows.push(["Accessed", fmtDate(p.atime)], ["Changed", fmtDate(p.ctime)]);
    if (p.volume) rows.push(["Volume", `${p.volume.mountpoint} · ${p.volume.fstype}${p.volume.network ? ` (${p.volume.netKind ?? "network"})` : ""} · ${fmtSize(p.volume.free)} free of ${fmtSize(p.volume.total)}`]);
    rows.push(["Inode", `${p.ino} · ${p.nlink} link${p.nlink === 1 ? "" : "s"}`]);
  } else if (basic) rows.push(["Mode", `${fmtMode(basic.mode, basic.type)}  ${octal(basic.mode)}`]);

  const sj = sizeJob.job;
  return (
    <Modal title="Properties" onClose={onClose} wide>
      {err && <div className="fp-err" role="alert">{err}</div>}
      {!p && !basic && !err && <div className="muted">Loading...</div>}
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {isDir && (
          <div>
            <dt>Size</dt>
            <dd>
              {size ? (
                <span data-testid="folder-size">
                  {fmtSize(size.bytes)} ({size.bytes.toLocaleString()} bytes) · {fmtSize(size.diskBytes)} on disk · {size.files.toLocaleString()} file(s), {size.dirs.toLocaleString()} folder(s)
                  {size.symlinks > 0 && `, ${size.symlinks.toLocaleString()} link(s)`}
                  {size.truncated && " · stopped at the entry limit, so this is a lower bound"}
                  {size.mountsSkipped > 0 && ` · ${size.mountsSkipped} other filesystem(s) not counted`}
                  {size.errors > 0 && ` · ${size.errors} unreadable`}
                </span>
              ) : sj && live(sj) ? (
                <span>
                  Calculating... {sj.progress.entries.toLocaleString()} entries, {fmtSize(sj.progress.bytes)} <button type="button" onClick={sizeJob.cancel}>Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => void calc()}>{sj?.state === "canceled" ? "Calculate again" : "Calculate size"}</button>
              )}
            </dd>
          </div>
        )}
      </dl>
      {p && p.type !== "other" && (
        <fieldset className="perm" disabled={busy}>
          <legend>Permissions</legend>
          <table className="perm-grid">
            <thead>
              <tr><th /><th>Read</th><th>Write</th><th>Execute</th></tr>
            </thead>
            <tbody>
              {GRID.map(([who, ...bits]) => (
                <tr key={who}>
                  <th scope="row">{who}</th>
                  {bits.map((b, i) => (
                    <td key={b}>
                      <input type="checkbox" aria-label={`${who} ${["read", "write", "execute"][i]}`} disabled={p.type === "symlink"} checked={(mode & b) !== 0} onChange={(e) => setMode((m) => (e.target.checked ? m | b : m & ~b))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="perm-row">
            {SPECIAL.map(([l, b]) => (
              <label key={l} className="chk">
                <input type="checkbox" disabled={p.type === "symlink"} checked={(mode & b) !== 0} onChange={(e) => setMode((m) => (e.target.checked ? m | b : m & ~b))} /> {l}
              </label>
            ))}
            <label className="perm-oct">
              Octal
              <input
                aria-label="Octal mode"
                value={octal(mode)}
                disabled={p.type === "symlink"}
                onChange={(e) => /^[0-7]{1,4}$/.test(e.target.value) && setMode(parseInt(e.target.value, 8))}
              />
            </label>
            <span className="muted">{fmtMode(mode, p.type)}</span>
          </div>
          <div className="perm-row">
            <label>
              Owner
              <input aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <label>
              Group
              <input aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)} />
            </label>
          </div>
          <div className="muted perm-hint">User and group names come from the host; a number is taken as an id.</div>
          {isDir && (
            <div className="perm-row">
              <label className="chk">
                <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> Apply to everything inside
              </label>
              {recursive && (
                <select aria-label="Apply to" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                  <option value="all">Files and folders</option>
                  <option value="files">Files only</option>
                  <option value="dirs">Folders only</option>
                </select>
              )}
            </div>
          )}
          {permJob.job && live(permJob.job) && (
            <div className="muted">
              Applying... {permJob.job.progress.entries.toLocaleString()} entries <button type="button" onClick={permJob.cancel}>Cancel</button>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" disabled={!dirty || busy} onClick={() => void apply()}>{busy ? "Applying..." : "Apply permissions"}</button>
          </div>
        </fieldset>
      )}
      <div className="modal-actions">
        <button type="submit" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
