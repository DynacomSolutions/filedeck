import { useEffect, useState } from "react";
import * as Ic from "lucide-react";
import { fmtDate } from "./api";
import { gitApi, shortHash, stateText, type GitCommit, type GitInfo, type GitSummary } from "./git";
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

/** Git details for the Properties panel: branch, upstream, last commit, stash, remotes, worktree link, change lists and the HEAD diff. */
export function GitSection({ node, path, tick, onReveal, onDiffHead, onOpenWorktrees, onApplicability }: { node: string; path: string; tick: number; onReveal: (p: string) => void; onDiffHead: (p: string) => void; onOpenWorktrees?: () => void; onApplicability?: (available: boolean | null) => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [err, setErr] = useState("");
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
      {onOpenWorktrees && (
        <div className="perm-row">
          <button type="button" onClick={onOpenWorktrees}><Ic.GitBranch /> All worktrees</button>
        </div>
      )}
      {f && (
        <div className="perm-row">
          <Tip label="Open the file next to its content at the last commit (HEAD) in the diff editor">
            <button type="button" onClick={() => onDiffHead(path)}><Ic.Diff /> Diff against HEAD</button>
          </Tip>
        </div>
      )}
      {GROUPS.map(([k, name]) =>
        r.counts[k] ? (
          <details key={k} className="git-list">
            <summary>{name} ({r.counts[k].toLocaleString()})</summary>
            <ul>
              {r.lists[k].map((it) => (
                <li key={it.path}>
                  <button type="button" className="git-item" onClick={() => onReveal(it.path)}>
                    {it.dir ? <Ic.Folder /> : <Ic.File />}
                    <span>{rel(it.path)}</span>
                  </button>
                  {!it.dir && (
                    <Tip label="Diff against HEAD">
                      <button type="button" aria-label={`Diff ${rel(it.path)} against HEAD`} onClick={() => onDiffHead(it.path)}><Ic.Diff /></button>
                    </Tip>
                  )}
                </li>
              ))}
            </ul>
            {r.counts[k] > r.lists[k].length && <div className="muted perm-hint">Showing the first {r.listCap} of {r.counts[k].toLocaleString()}.</div>}
          </details>
        ) : null,
      )}
    </fieldset>
  );
}
