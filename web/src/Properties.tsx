import { useEffect, useRef, useState } from "react";
import { api, fmtDate, fmtMode, fmtSize, stat, type Entry, type JobView, type PermsResult, type Props, type SizeResult } from "./api";
import { SkeletonLines } from "./Skeleton";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";

const TYPE: Record<Entry["type"], string> = { file: "File", dir: "Folder", symlink: "Symbolic link", other: "Special file" };
const GRID: [string, number, number, number][] = [
  ["Owner", 0o400, 0o200, 0o100],
  ["Group", 0o40, 0o20, 0o10],
  ["Others", 0o4, 0o2, 0o1],
];
const SPECIAL: [string, number, string][] = [
  ["setuid", 0o4000, "Run the file with its owner's rights instead of the user's (a program bit; it does not change the owner)"],
  ["setgid", 0o2000, "Run the file with its group's rights; on a folder, new files inherit the folder's group (it does not change the group)"],
  ["sticky", 0o1000, "On a shared folder, only a file's owner can delete or rename it"],
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

/**
 * Details of one entry for the properties pane, with recursive size, chmod and chown. The pane remounts it (key) when the selection
 * changes, so every item starts from its own state; a folder-size job still running for the previous item is cancelled.
 */
export function PropertiesPanel({ node, path, entry, onChanged, onStatus }: { node: string; path: string; entry?: Entry; onChanged: () => void; onStatus: (m: string) => void }) {
  const [p, setP] = useState<Props | null>(null);
  const [basic, setBasic] = useState<Entry | null>(entry ?? null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState(0);
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [scope, setScope] = useState<"all" | "files" | "dirs">("all");
  const [size, setSize] = useState<SizeResult | null>(null);
  /** which field a change is being applied for (spinner next to it) */
  const [busy, setBusy] = useState<"mode" | "owner" | "group" | "tree" | null>(null);
  /** an error from the last permission change, shown next to the controls */
  const [permErr, setPermErr] = useState("");
  /** what is typed in the octal box while it is being edited (null = show the live mode) */
  const [oct, setOct] = useState<string | null>(null);
  const sizeJob = useJob(node);
  const permJob = useJob(node);
  const running = useRef({ node, size: sizeJob, perm: permJob });
  running.current = { node, size: sizeJob, perm: permJob };
  useEffect(
    () => () => {
      const r = running.current;
      for (const j of [r.size.job, r.perm.job]) if (j && live(j)) void api.cancelJob(r.node, j.id).catch(() => undefined);
    },
    [],
  );

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
  const modeChanged = p ? mode !== p.mode : false;
  const isDir = p?.type === "dir";
  const octOk = (v: string) => /^[0-7]{3,4}$/.test(v);
  /** Send one permission change (or, for a folder, the whole set to its contents) and reload what the node now reports. */
  const apply = async (field: NonNullable<typeof busy>, body: { mode?: number; owner?: string; group?: string }, tree = false) => {
    if (!p) return;
    setBusy(field);
    setPermErr("");
    try {
      const r = await api.perms(node, { path, ...body, ...(tree ? { recursive: true, scope } : {}) });
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
      setPermErr((e as Error).message);
      // the fields go back to what the node still reports
      setMode(p.mode);
      setOwner(origOwner);
      setGroup(origGroup);
    } finally {
      setBusy(null);
    }
  };
  /** Octal box: Enter or leaving it applies a valid 3-4 digit value; anything else goes back to the live mode. */
  const commitOct = () => {
    if (oct === null) return;
    const v = oct;
    setOct(null);
    if (!octOk(v)) return;
    const m = parseInt(v, 8);
    setMode(m);
    if (p && m !== p.mode) void apply("mode", { mode: m });
  };
  /** Owner and group apply as soon as the field is committed (Enter or leaving it). */
  const commitName = (field: "owner" | "group") => {
    if (!p) return;
    const v = (field === "owner" ? owner : group).trim();
    if (v === (field === "owner" ? origOwner : origGroup)) return field === "owner" ? setOwner(origOwner) : setGroup(origGroup);
    if (!v) return field === "owner" ? setOwner(origOwner) : setGroup(origGroup);
    void apply(field, { [field]: v });
  };
  const nameKeys = (field: "owner" | "group") => (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") {
      e.preventDefault();
      field === "owner" ? setOwner(origOwner) : setGroup(origGroup);
    }
  };
  const slot = (f: NonNullable<typeof busy>) => <span className="perm-spin" aria-hidden={busy !== f}>{busy === f && <Ic.Loader className="cmp-spin" role="status" aria-label="Applying" />}</span>;

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
    <div className="pp" aria-busy={!p && !basic && !err}>
      {err && <div className="fp-err" role="alert">{err}</div>}
      {!p && !basic && !err && <SkeletonLines lines={7} />}
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
                  Calculating... {sj.progress.entries.toLocaleString()} entries, {fmtSize(sj.progress.bytes)} <button type="button" onClick={sizeJob.cancel}><Ic.X /> Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => void calc()}><Ic.Calculator /> {sj?.state === "canceled" ? "Calculate again" : "Calculate size"}</button>
              )}
            </dd>
          </div>
        )}
      </dl>
      {!p && (basic || err) && !err && <SkeletonLines lines={5} />}
      {p && p.type !== "other" && (
        <fieldset className="perm" disabled={busy !== null}>
          <legend>Permissions</legend>
          <table className="perm-grid">
            <thead>
              <tr><th><span className="visually-hidden">Class</span></th><th>Read</th><th>Write</th><th>Execute</th></tr>
            </thead>
            <tbody>
              {GRID.map(([who, ...bits]) => (
                <tr key={who}>
                  <th scope="row">{who}</th>
                  {bits.map((b, i) => (
                    <td key={b}>
                      <input type="checkbox" aria-label={`${who} ${["read", "write", "execute"][i]}`} disabled={p.type === "symlink"} checked={(mode & b) !== 0} onChange={(e) => (setOct(null), setMode((m) => (e.target.checked ? m | b : m & ~b)))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="perm-row">
            <label className="perm-oct">
              Octal
              <input
                aria-label="Octal mode"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={4}
                value={oct ?? octal(mode)}
                aria-invalid={oct !== null && !octOk(oct)}
                disabled={p.type === "symlink"}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!/^[0-7]{0,4}$/.test(v)) return;
                  setOct(v);
                  if (octOk(v)) setMode(parseInt(v, 8)); // the grid follows while typing
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    e.preventDefault();
                    setOct(null);
                    setMode(p.mode);
                  }
                }}
                onBlur={commitOct}
              />
            </label>
            <span className="muted">{fmtMode(mode, p.type)}</span>
            {slot("mode")}
            <button type="button" disabled={!modeChanged || busy !== null || (oct !== null && !octOk(oct))} onClick={() => (setOct(null), void apply("mode", { mode }))}><Ic.ShieldCheck /> Apply</button>
          </div>
          <details className="perm-special">
            <summary>Special bits</summary>
            <div className="perm-row">
              {SPECIAL.map(([l, b, tip]) => (
                <Tip key={l} label={tip}>
                  <label className="chk">
                    <input type="checkbox" disabled={p.type === "symlink"} checked={(mode & b) !== 0} onChange={(e) => (setOct(null), setMode((m) => (e.target.checked ? m | b : m & ~b)))} /> {l}
                  </label>
                </Tip>
              ))}
            </div>
          </details>
          <div className="perm-row">
            <label>
              Owner
              <span className="perm-field">
                <input aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} onKeyDown={nameKeys("owner")} onBlur={() => commitName("owner")} />
                {slot("owner")}
              </span>
            </label>
            <label>
              Group
              <span className="perm-field">
                <input aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)} onKeyDown={nameKeys("group")} onBlur={() => commitName("group")} />
                {slot("group")}
              </span>
            </label>
          </div>
          <div className="muted perm-hint">Owner and group apply when you press Enter or leave the field. Names come from the host; a number is taken as an id.</div>
          {isDir && (
            <div className="perm-row">
              <select aria-label="Apply to" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="all">Files and folders</option>
                <option value="files">Files only</option>
                <option value="dirs">Folders only</option>
              </select>
              <Tip label="Set the mode, owner and group shown above on everything inside this folder">
                <button type="button" disabled={busy !== null} onClick={() => void apply("tree", { mode, owner: owner.trim() || origOwner, group: group.trim() || origGroup }, true)}><Ic.FolderTree /> Apply to contents</button>
              </Tip>
              {slot("tree")}
            </div>
          )}
          {permErr && <div className="fp-err" role="alert">{permErr}</div>}
          {permJob.job && live(permJob.job) && (
            <div className="muted">
              Applying... {permJob.job.progress.entries.toLocaleString()} entries <button type="button" onClick={permJob.cancel}><Ic.X /> Cancel</button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

/** Several items selected: counts and the total size of the files among them. */
export function PropertiesMulti({ entries }: { entries: Entry[] }) {
  const dirs = entries.filter((e) => e.type === "dir" || e.linkDir).length;
  const files = entries.filter((e) => e.type === "file").length;
  const bytes = entries.reduce((n, e) => (e.type === "file" ? n + e.size : n), 0);
  return (
    <div className="pp">
      <dl className="props">
        <div><dt>Selected</dt><dd>{entries.length.toLocaleString()} items</dd></div>
        <div><dt>Files</dt><dd>{files.toLocaleString()} · {fmtSize(bytes)} ({bytes.toLocaleString()} bytes)</dd></div>
        <div><dt>Folders</dt><dd>{dirs.toLocaleString()} <span className="muted">(select one folder to calculate its size)</span></dd></div>
      </dl>
    </div>
  );
}
