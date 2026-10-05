import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { api, type WorktreeList } from "./api";
import { Tip } from "./Tooltip";

/**
 * Side-panel tab listing every worktree of the repository the panel's folder belongs to. Clicking a row opens
 * that worktree in this panel; right-click offers the standard folder menu (owned by the panel).
 */
export function WorktreesPane({ node, path, onOpen, onMenu, extra }: { node: string; path: string; onOpen: (p: string) => void; onMenu: (e: React.MouseEvent, p: string) => void; extra: React.ReactNode }) {
  const [data, setData] = useState<WorktreeList | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    api
      .worktrees(node, path)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setErr("");
      })
      .catch((e: Error) => {
        if (mine !== seq.current) return;
        setData(null);
        setErr(e.message);
      })
      .finally(() => mine === seq.current && setBusy(false));
  }, [node, path]);
  useEffect(load, [load]);
  useEffect(() => () => void seq.current++, []);

  return (
    <div className="pv wt">
      <div className="pv-head">
        <b>Worktrees</b>
        {data && <span className="muted">{data.worktrees.length}{data.truncated ? "+" : ""}</span>}
        <span className="pv-acts">
          <Tip label="Refresh the worktree list">
            <button type="button" className="pv-dockbtn" aria-label="Refresh worktrees" disabled={busy} onClick={load}><RefreshCw /></button>
          </Tip>
        </span>
        {extra}
      </div>
      <div className="pv-body wt-body">
        {err ? (
          <div className="pv-empty muted" role="status">{err}</div>
        ) : !data ? (
          <div className="pv-empty muted" role="status">Loading worktrees...</div>
        ) : (
          <ul className="wt-list" aria-label="Worktrees">
            {data.worktrees.map((w) => {
              const label = w.bare ? "bare" : w.detached ? "detached" : (w.branch ?? "");
              const body = (
                <>
                  <span className="wt-top">
                    <GitBranch aria-hidden />
                    <b className="wt-name">{w.name}</b>
                    {w.current && <span className="wt-pill on">here</span>}
                    {w.main && !w.bare && <span className="wt-pill">main</span>}
                    {w.dirty === true && <span className="wt-pill warn">dirty</span>}
                    {w.locked && <span className="wt-pill"><Lock aria-hidden />locked</span>}
                    {w.prunable && <span className="wt-pill warn"><TriangleAlert aria-hidden />missing</span>}
                  </span>
                  <span className="wt-sub muted">
                    {label}
                    {w.head ? ` · ${w.head}` : ""}
                    {w.lockReason ? ` · ${w.lockReason}` : ""}
                  </span>
                  <span className="wt-path muted">{w.path ?? w.gitPath}</span>
                </>
              );
              return (
                <li key={w.gitPath}>
                  {w.path && !w.prunable ? (
                    <button type="button" className={"wt-row" + (w.current ? " cur" : "")} aria-current={w.current ? "true" : undefined} onClick={() => onOpen(w.path!)} onContextMenu={(e) => (e.preventDefault(), onMenu(e, w.path!))}>
                      {body}
                    </button>
                  ) : (
                    <Tip label={w.prunable ? "This worktree folder no longer exists" : "Outside this node's folders: shown, not browsable"}>
                      <div className="wt-row off" role="group" aria-label={w.name} tabIndex={0}>{body}</div>
                    </Tip>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
