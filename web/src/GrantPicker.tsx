import { useEffect, useId, useState } from "react";
import * as Ic from "lucide-react";
import { Modal } from "./ArchiveDialog";
import { api, type Entry } from "./api";
import "./archive.css";
import "./accounts.css";

const parent = (p: string) => (p === "/" ? "/" : p.replace(/\/[^/]*\/?$/, "") || "/");
const join = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;
const isDir = (e: Entry) => e.type === "dir" || (e.type === "symlink" && e.linkDir === true);

/**
 * Picks a folder on one machine for a virtual account's grant. It lists folders as the administrator (`api.list`); a folder the
 * administrator cannot list shows the listing's error and keeps the path, which can be typed and added all the same: the hub checks the
 * form of the path, not that it exists.
 */
export function GrantPicker({ node, onPick, onClose }: { node: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState("/");
  /** the folder to list; `n` lists it again when the same path is asked for twice */
  const [at, setAt] = useState({ dir: "/", n: 0 });
  /** its sub-folders, or the listing's error; undefined while loading */
  const [result, setResult] = useState<{ dirs?: string[]; err?: string }>({});
  const fieldId = useId();
  const noteId = useId();
  useEffect(() => {
    const ac = new AbortController();
    setResult({});
    api.list(node, at.dir, false, ac.signal).then(
      (r) => setResult({ dirs: r.entries.filter(isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b)) }),
      (e: Error) => {
        if (!ac.signal.aborted) setResult({ err: e.message || "The folder could not be listed." });
      },
    );
    return () => ac.abort();
  }, [node, at]);
  /** Lists `dir`; the typed path stays as it is unless `show` puts `dir` in the field. */
  const list = (dir: string, show: boolean) => {
    if (show) setPath(dir);
    setAt((a) => ({ dir, n: a.n + 1 }));
  };
  const typed = path.trim();
  return (
    <Modal title="Add folder" onClose={onClose} wide describedBy={noteId}>
      <p id={noteId} className="pad0 acc-note">
        A folder on <bdi>{node}</bdi>. Pick one below or type its path. The list shows what you can see; the account sees what its run-as user can.
      </p>
      <div className="acc-pick-path">
        <label htmlFor={fieldId}>Folder path</label>
        <div className="acc-pick-row">
          <input
            id={fieldId}
            value={path}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (typed.startsWith("/")) list(typed, false);
              }
            }}
          />
          <button type="button" disabled={!typed.startsWith("/")} onClick={() => list(typed, false)}><Ic.FolderSearch aria-hidden="true" /> List</button>
        </div>
      </div>
      <div className="acc-pick-list" role="region" aria-label="Folders" aria-busy={!result.dirs && !result.err} tabIndex={0}>
        <div className="acc-pick-at muted">In <bdi>{at.dir}</bdi></div>
        {result.err && <div className="ad-err" role="alert">{result.err}</div>}
        {!result.dirs && !result.err && <div className="muted acc-pick-empty">Loading...</div>}
        <ul>
          {at.dir !== "/" && (
            <li>
              <button type="button" onClick={() => list(parent(at.dir), true)}><Ic.CornerLeftUp aria-hidden="true" /> Up one folder</button>
            </li>
          )}
          {result.dirs?.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => list(join(at.dir, name), true)}><Ic.Folder aria-hidden="true" /> <bdi>{name}</bdi></button>
            </li>
          ))}
        </ul>
        {result.dirs && result.dirs.length === 0 && <div className="muted acc-pick-empty">No folders here.</div>}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}><Ic.X aria-hidden="true" /> Cancel</button>
        <button type="submit" disabled={!typed.startsWith("/")} onClick={() => typed.startsWith("/") && onPick(typed)}><Ic.FolderPlus aria-hidden="true" /> Add folder</button>
      </div>
    </Modal>
  );
}
