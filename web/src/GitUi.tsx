import { useEffect, useState } from "react";
import * as Ic from "lucide-react";
import { api, fmtDate, type WorktreeList } from "./api";
import { gitApi, shortHash, stateText, type GitCommit, type GitInfo, type GitSummary } from "./git";
import { GitInlineDiff } from "./GitInlineDiff";
import { SkeletonLines } from "./Skeleton";
import { Tip } from "./Tooltip";

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}`;

/** A sentence for the tooltip and screen readers: where the repository is and what changed. */
export function summaryText(s: GitSummary): string {
  if (s.pending) return "Reading Git status...";
  if (s.error) return `Git status unavailable: ${s.error}`;
  const where = s.kind === "bare" ? "Bare repository" : s.kind === "linked" ? "Linked worktree" : "Git work tree";
  const at = s.branch ? `branch ${s.branch}` : s.detached ? `detached at ${s.head ?? "?"}` : "no commits yet";
  const parts = [`${where}, ${at}`];
  if (s.upstream) parts.push(s.ahead || s.behind ? `${s.ahead ?? 0} ahead, ${s.behind ?? 0} behind ${s.upstream}` : `up to date with ${s.upstream}`);
  if (s.kind !== "bare") {
    const ch = [s.staged && plural(s.staged, "staged"), s.modified && plural(s.modified, "modified"), s.untracked && plural(s.untracked, "untracked"), s.conflicted && plural(s.conflicted, "conflicted")].filter(Boolean);
    parts.push(ch.length ? ch.join(", ") : "clean");
  }
  return parts.join("; ");
}

/** Branch, ahead/behind and change counts of a repository, as a small pill on a folder row (or a "..." while it is still being read). */
export function GitPill({ s, className = "" }: { s: GitSummary; className?: string }) {
  const label = summaryText(s);
  if (s.pending)
    return (
      <Tip label={label}>
        <span className={"git-pill pending " + className} role="status" aria-label={label}>
          <Ic.GitBranch aria-hidden="true" /> …
        </span>
      </Tip>
    );
  if (s.error)
    return (
      <Tip label={label}>
        <span className={"git-pill " + className} role="img" aria-label={label}>
          <Ic.GitBranch aria-hidden="true" /> ?
        </span>
      </Tip>
    );
  const name = s.branch ?? (s.detached ? shortHash(s.head ?? "") : "no commits");
  const dirty = (s.staged ?? 0) + (s.modified ?? 0) + (s.untracked ?? 0) + (s.conflicted ?? 0) > 0;
  return (
    <Tip label={label}>
      <span className={"git-pill " + className} role="img" aria-label={label} data-dirty={dirty || undefined}>
        <Ic.GitBranch aria-hidden="true" />
        <span className="git-br">{name}</span>
        {!!s.ahead && (
          <span className="git-n"><Ic.ArrowUp aria-hidden="true" />{s.ahead}</span>
        )}
        {!!s.behind && (
          <span className="git-n"><Ic.ArrowDown aria-hidden="true" />{s.behind}</span>
        )}
        {!!s.conflicted && <span className="git-n git-c">!{s.conflicted}</span>}
        {!!s.staged && <span className="git-n">+{s.staged}</span>}
        {!!s.modified && <span className="git-n">~{s.modified}</span>}
        {!!s.untracked && <span className="git-n git-u">?{s.untracked}</span>}
        {s.kind !== "bare" && !dirty && <Ic.Check aria-hidden="true" />}
      </span>
    </Tip>
  );
}

/** The state letters of one entry (S staged, M modified, U untracked, I ignored, C conflicted). */
export function GitBadge({ letters }: { letters: string }) {
  const label = `Git: ${stateText(letters)}`;
  return (
    <Tip label={label}>
      <span className="git-st" role="img" aria-label={label} data-st={letters}>
        {letters}
      </span>
    </Tip>
  );
}

const when = (c: GitCommit) => (Date.parse(c.date) ? fmtDate(Date.parse(c.date)) : c.date);
const commitLine = (c: GitCommit) => (
  <>
    <code>{shortHash(c.hash)}</code> {c.subject} <span className="muted">· {c.author} · {when(c)}</span>
  </>
);

const GROUPS = [
  ["conflicted", "Conflicted"],
  ["staged", "Staged"],
  ["modified", "Modified"],
  ["untracked", "Untracked"],
] as const;

function GitWorktrees({ node, root, onOpen, hrefFor }: { node: string; root: string; onOpen: (path: string) => void; hrefFor: (path: string) => string }) {
  const [data, setData] = useState<WorktreeList | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setData(null);
    setErr("");
    void api.worktrees(node, root).then(
      (result) => live && setData(result),
      (error: Error) => live && setErr(error.message),
    );
    return () => { live = false; };
  }, [node, root]);

  return (
    <section className="git-worktrees" aria-label="Repository worktrees">
      <h4>Worktrees</h4>
      {err ? <div className="muted perm-hint" role="status">Worktrees unavailable: {err}</div> : !data ? <div className="muted perm-hint" role="status">Loading worktrees...</div> : data.worktrees.length ? (
        <>
          <ul className="wt-list" aria-label="Repository worktrees">
            {data.worktrees.map((w) => {
              const branch = w.bare ? "bare repository" : w.detached ? "detached" : w.branch ?? "unknown branch";
              const status = w.prunable ? "Missing worktree" : !w.path ? "Outside this node's folders" : null;
              const body = <>
                <span className="wt-top">
                  <Ic.GitBranch aria-hidden="true" />
                  <b className="wt-name">{w.name}</b>
                  {w.current && <span className="wt-pill on">here</span>}
                  {w.main && !w.bare && <span className="wt-pill">main</span>}
                  {w.dirty === true && <span className="wt-pill warn">dirty</span>}
                  {w.locked && <span className="wt-pill">locked</span>}
                </span>
                <span className="wt-sub muted">{branch}{w.head ? ` · ${w.head}` : ""}</span>
                <span className="wt-path muted">{w.path ?? w.gitPath}</span>
                {status && <span className="muted">{status}</span>}
              </>;
              return <li key={w.gitPath}>{w.path && !w.prunable ? (
                <a href={hrefFor(w.path)} data-nav className={"wt-row" + (w.current ? " cur" : "")} aria-current={w.current ? "true" : undefined} aria-label={`Open worktree ${w.name}, ${branch}, ${w.path}`} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen(w.path!); } }}>{body}</a>
              ) : (
                <div className="wt-row off" role="group" aria-label={`${w.name}: ${status ?? "Unavailable"}`}>{body}</div>
              )}</li>;
            })}
          </ul>
          {data.truncated && <div className="muted perm-hint" role="status">The worktree list is truncated. Some entries may not be shown.</div>}
        </>
      ) : <div className="muted perm-hint" role="status">No worktrees found.</div>}
    </section>
  );
}

/** Git details for the Properties panel: branch, upstream, last commit, stash, remotes, worktrees, change lists and the HEAD diff. */
export function GitSection({ node, path, tick, onReveal, onOpenWorktree, worktreeHref, onApplicability }: { node: string; path: string; tick: number; onReveal: (p: string) => void; onOpenWorktree?: (path: string) => void; worktreeHref?: (path: string) => string; onApplicability?: (available: boolean | null) => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    onApplicability?.(null);
    void gitApi.info(node, path, tick > 0).then(
      (v) => live && (setInfo(v), setErr(""), onApplicability?.(!!v.repo)),
      (e: Error) => live && (setErr(e.message), onApplicability?.(false)),
    );
    return () => {
      live = false;
    };
  }, [node, path, tick, onApplicability]);
  if (err) return <div className="muted perm-hint">Git details unavailable: {err}</div>;
  if (!info) return <SkeletonLines lines={3} />;
  const r = info.repo;
  if (!r) return null;
  const toggleDiff = (occurrence: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(occurrence)) next.delete(occurrence);
    else next.add(occurrence);
    return next;
  });
  const s = r.summary;
  const rows: [string, React.ReactNode][] = [];
  const rel = (p: string) => (r.root === "/" ? p : p.slice(r.root.length)).replace(/^\//, "") || ".";
  rows.push(["Repository", r.kind === "bare" ? `Bare repository · ${r.root}` : r.root]);
  if (r.kind === "linked" && r.mainRepo) rows.push(["Worktree", `Linked worktree of ${r.mainRepo}`]);
  rows.push(["Branch", s.branch ?? (s.detached ? `Detached at ${s.head ?? "?"}` : "No commits yet")]);
  if (s.upstream) rows.push(["Upstream", `${s.upstream} · ${s.ahead ?? 0} ahead, ${s.behind ?? 0} behind`]);
  else if (s.branch && r.kind !== "bare") rows.push(["Upstream", <span className="muted">none</span>]);
  rows.push(["Last commit", r.lastCommit ? commitLine(r.lastCommit) : <span className="muted">none</span>]);
  if (r.kind !== "bare") rows.push(["Stash", `${r.stash.toLocaleString()} entr${r.stash === 1 ? "y" : "ies"}`]);
  rows.push(["Remotes", r.remotes.length ? <>{r.remotes.map((x) => <div key={x.name}>{x.name} <span className="muted">{x.url}</span></div>)}</> : <span className="muted">none</span>]);
  const f = r.file;
  if (f) {
    rows.push(["This file", f.letters ? stateText(f.letters) : f.tracked ? "Tracked, unchanged" : "Not tracked"]);
    if (f.lastCommit) rows.push(["File history", commitLine(f.lastCommit)]);
  }
  return (
    <fieldset className="perm git-sec" data-testid="git-section">
      <legend>Git</legend>
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {onOpenWorktree && worktreeHref && <GitWorktrees key={`${node}\0${r.root}`} node={node} root={r.root} onOpen={onOpenWorktree} hrefFor={worktreeHref} />}
      {f && (
        <>
          <div className="perm-row">
            <Tip label={expanded.has(`file:${path}`) ? "Collapse the HEAD diff" : "Show the HEAD diff inline"}>
              <button type="button" aria-expanded={expanded.has(`file:${path}`)} onClick={() => toggleDiff(`file:${path}`)}><Ic.Diff /> {expanded.has(`file:${path}`) ? "Hide diff" : "Diff against HEAD"}</button>
            </Tip>
          </div>
          {expanded.has(`file:${path}`) && <GitInlineDiff node={node} path={path} />}
        </>
      )}
      {GROUPS.map(([k, name]) =>
        r.counts[k] ? (
          <details key={k} className="git-list">
            <summary>{name} ({r.counts[k].toLocaleString()})</summary>
            <ul>
              {r.lists[k].map((it) => {
                const occurrence = `${k}:${it.path}`;
                const open = expanded.has(occurrence);
                return <li key={occurrence} className={open ? "git-change open" : "git-change"}>
                  <button type="button" className="git-item" onClick={() => it.dir ? onReveal(it.path) : toggleDiff(occurrence)} aria-expanded={!it.dir ? open : undefined} aria-label={it.dir ? `Open ${rel(it.path)}` : `${open ? "Collapse" : "Expand"} diff for ${rel(it.path)}`}>
                    {it.dir ? <Ic.Folder /> : open ? <Ic.ChevronDown aria-hidden="true" /> : <Ic.ChevronRight aria-hidden="true" />}
                    <span>{rel(it.path)}</span>
                  </button>
                  <Tip label={it.dir ? "Open folder" : "Open file"}>
                    <button type="button" aria-label={`Open ${rel(it.path)}`} onClick={(event) => { event.stopPropagation(); onReveal(it.path); }}><Ic.FolderOpen /></button>
                  </Tip>
                  {!it.dir && (
                    <Tip label={open ? "Collapse diff" : "Diff against HEAD inline"}>
                      <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${rel(it.path)} diff`} aria-expanded={open} onClick={(event) => { event.stopPropagation(); toggleDiff(occurrence); }}><Ic.Diff /></button>
                    </Tip>
                  )}
                  {open && !it.dir && <GitInlineDiff node={node} path={it.path} />}
                </li>
              })}
            </ul>
            {r.counts[k] > r.lists[k].length && <div className="muted perm-hint">Showing the first {r.listCap} of {r.counts[k].toLocaleString()}.</div>}
          </details>
        ) : null,
      )}
    </fieldset>
  );
}
