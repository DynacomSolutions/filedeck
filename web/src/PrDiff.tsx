import { useEffect, useMemo, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { api, type GitDiff, type GitRefs } from "./api";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { GitBranchFileDiff } from "./GitUi";
import { SkeletonLines } from "./Skeleton";
import { Tip } from "./Tooltip";

/** What the section compares: a pull request number, or two refs. */
export interface PrChoice {
  pr?: number;
  base?: string;
  head?: string;
}

/** Parse "123" or "#123" into a pull request number; null when it is not one. */
export function parsePrNumber(text: string): number | null {
  const n = Number(text.trim().replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Most refs offered in a menu; a repository can hold thousands, the box accepts any ref by typing. */
const MAX_REF_MENU = 200;
const STATUS: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" };

/**
 * Pull request diff for a repository folder, embedded in the Git section of the properties pane: pick a pull request (or two refs),
 * see the changed files and open each file's diff inline (the same read-only diff the branch comparison uses).
 */
export function PrDiffSection({ node, root }: { node: string; root: string }) {
  const [mode, setMode] = useState<"pr" | "refs">("pr");
  const [prText, setPrText] = useState("");
  const [baseText, setBaseText] = useState("");
  const [headText, setHeadText] = useState("");
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [choice, setChoice] = useState<PrChoice | null>(null);
  const [data, setData] = useState<GitDiff | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const loadId = useRef(0);

  useEffect(() => {
    let live = true;
    api.gitRefs(node, root).then((r) => live && setRefs(r), () => live && setRefs({ bare: false, refs: [], prs: [] }));
    return () => {
      live = false;
    };
  }, [node, root]);

  useEffect(() => {
    if (!choice) return;
    const id = ++loadId.current;
    setBusy(true);
    setErr("");
    api.gitDiff(node, root, choice.pr ? { pr: choice.pr } : { base: choice.base!, head: choice.head! }).then(
      (d) => {
        if (loadId.current !== id) return;
        setData(d);
        setOpen(new Set());
        setBusy(false);
      },
      (e: Error) => {
        if (loadId.current !== id) return;
        setData(null);
        setErr(e.message);
        setBusy(false);
      },
    );
  }, [node, root, choice]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "pr") {
      const n = parsePrNumber(prText);
      if (n === null) return setErr("Enter a pull request number, for example 123");
      setChoice({ pr: n });
    } else {
      if (!baseText.trim() || !headText.trim()) return setErr("Enter both a base and a head ref");
      setChoice({ base: baseText.trim(), head: headText.trim() });
    }
  };
  const pickFrom = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };
  const refItems = (set: (v: string) => void): MenuItem[] => {
    const all = refs?.refs ?? [];
    if (!all.length) return [{ label: "No refs in this repository", disabled: true }];
    return all.slice(0, MAX_REF_MENU).map((r): MenuItem => ({ label: r, icon: Ic.GitBranch, onSelect: () => set(r) }));
  };
  const prItems = (): MenuItem[] => {
    const all = refs?.prs ?? [];
    if (!all.length) return [{ label: "No pull request refs fetched", disabled: true }];
    return all.slice(0, MAX_REF_MENU).map((p): MenuItem => ({ label: `#${p.n} ${p.subject}`.slice(0, 80), icon: Ic.GitPullRequest, onSelect: () => { setPrText(String(p.n)); setChoice({ pr: p.n }); } }));
  };

  const files = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q) || f.oldPath?.toLowerCase().includes(q));
  }, [data, filter]);
  const totals = useMemo(() => (data?.files ?? []).reduce((t, f) => ({ add: t.add + (f.add ?? 0), del: t.del + (f.del ?? 0) }), { add: 0, del: 0 }), [data]);

  return (
    <section className="git-branch-diff git-pr" data-testid="git-pr-diff" aria-label="Pull request diff">
      <h4>Pull request diff</h4>
      <form className="git-pr-form" onSubmit={submit} aria-label="What to compare">
        <div className="git-pr-mode" role="group" aria-label="Compare by">
          <button type="button" aria-pressed={mode === "pr"} className={mode === "pr" ? "on" : ""} onClick={() => setMode("pr")}><Ic.GitPullRequest /> Pull request</button>
          <button type="button" aria-pressed={mode === "refs"} className={mode === "refs" ? "on" : ""} onClick={() => setMode("refs")}><Ic.GitBranch /> Two refs</button>
        </div>
        {mode === "pr" ? (
          <div className="git-pr-row">
            <input type="text" inputMode="numeric" aria-label="Pull request number" placeholder="PR number, e.g. 123" value={prText} onChange={(e) => setPrText(e.target.value)} />
            <Tip label="Choose from the pull request refs in this repository"><button type="button" aria-haspopup="menu" aria-label="Choose a pull request" onClick={(e) => pickFrom(e, prItems())}><Ic.ChevronDown /></button></Tip>
          </div>
        ) : (
          <>
            <div className="git-pr-row">
              <input type="text" aria-label="Base ref" placeholder="Base, e.g. main" value={baseText} onChange={(e) => setBaseText(e.target.value)} />
              <Tip label="Choose the base ref"><button type="button" aria-haspopup="menu" aria-label="Choose the base ref" onClick={(e) => pickFrom(e, refItems(setBaseText))}><Ic.ChevronDown /></button></Tip>
            </div>
            <div className="git-pr-row">
              <input type="text" aria-label="Head ref" placeholder="Head, e.g. feature" value={headText} onChange={(e) => setHeadText(e.target.value)} />
              <Tip label="Choose the head ref"><button type="button" aria-haspopup="menu" aria-label="Choose the head ref" onClick={(e) => pickFrom(e, refItems(setHeadText))}><Ic.ChevronDown /></button></Tip>
            </div>
          </>
        )}
        <button type="submit" disabled={busy}><Ic.GitCompareArrows /> Show changes</button>
      </form>
      {err && <div className="ed-banner err" role="alert">{err}</div>}
      {busy && <SkeletonLines lines={3} />}
      {data && !busy && (
        <>
          <div className="muted perm-hint" role="status">
            {data.pr ? `#${data.pr}: ` : ""}{data.head.ref} @ {data.head.sha.slice(0, 8)} against {data.base.ref} (merge base {data.mergeBase.slice(0, 8)}) · {data.files.length} file(s), <span className="pr-add">+{totals.add}</span> <span className="pr-del">-{totals.del}</span>
            {data.truncated ? " (list truncated)" : ""}{data.note ? ` · ${data.note}` : ""}
          </div>
          {data.files.length > 8 && <input type="search" className="git-pr-filter" aria-label="Filter changed files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {data.files.length === 0 ? <div className="muted perm-hint">No changes.</div> : (
            <ul className="git-branch-files" aria-label="Files changed in the pull request">
              {files.map((f) => {
                const isOpen = open.has(f.path);
                return (
                  <li key={f.path} className={isOpen ? "open" : ""} data-path={f.path}>
                    <div className="git-branch-file-head">
                      <button type="button" className="git-item" aria-expanded={isOpen} onClick={() => setOpen((cur) => { const n = new Set(cur); if (isOpen) n.delete(f.path); else n.add(f.path); return n; })}>
                        {isOpen ? <Ic.ChevronDown aria-hidden="true" /> : <Ic.ChevronRight aria-hidden="true" />}
                        <span>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
                        <span className="git-branch-file-status" role="img" aria-label={STATUS[f.status] ?? f.status}>{f.status}</span>
                      </button>
                      <span className="muted git-branch-file-count">{f.binary ? "binary" : `+${f.add ?? 0} −${f.del ?? 0}`}</span>
                    </div>
                    {isOpen && <GitBranchFileDiff node={node} root={root} data={data} file={f} />}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}
