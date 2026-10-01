import { Tip } from "./Tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDate, fmtSize, searchStream, type SearchDone, type SearchHit } from "./api";
import { EMPTY_SEARCH, type SearchForm, type SearchMode, type SearchTypes } from "./urlState";
import { FileIcon } from "./FileIcon";
import { X } from "lucide-react";

interface Props {
  node: string;
  dir: string;
  hidden: boolean;
  form: SearchForm;
  onForm: (f: SearchForm) => void;
  onClose: () => void;
  /** select the hit in its own folder */
  onReveal: (rel: string) => void;
  /** open the hit: folders navigate, files open in a tab */
  onOpen: (rel: string, hit: SearchHit) => void;
  onStatus: (m: string) => void;
}

const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Search results view of a panel: name (substring, glob, regex) and optional content search under the panel's folder. */
export function SearchView({ node, dir, hidden, form, onForm, onClose, onReveal, onOpen, onStatus }: Props) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [done, setDone] = useState<SearchDone | null>(null);
  const [err, setErr] = useState("");
  const [cur, setCur] = useState(0);
  const ac = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const formRef = useRef(form);
  formRef.current = form;

  const cancel = useCallback(() => ac.current?.abort(), []);
  const run = useCallback(() => {
    const f = formRef.current;
    ac.current?.abort();
    if (!f.q && !f.content && f.types === "all") {
      setErr("Enter a name pattern, content text, or pick a type.");
      return;
    }
    const ctl = new AbortController();
    ac.current = ctl;
    setHits([]);
    setDone(null);
    setErr("");
    setScanned(0);
    setCur(0);
    setRunning(true);
    searchStream(node, dir, f, hidden, ctl.signal, (h, sc) => {
      if (ac.current !== ctl) return;
      setScanned(sc);
      if (h.length) setHits((x) => x.concat(h));
    })
      .then((d) => ac.current === ctl && setDone(d))
      .catch((e: Error) => {
        if (ac.current !== ctl) return;
        if (e.name === "AbortError") setErr("Search cancelled");
        else setErr(e.message);
      })
      .finally(() => ac.current === ctl && setRunning(false));
  }, [node, dir, hidden]);

  // A link or reload with a search in the URL reruns it; leaving cancels the walk on the node.
  useEffect(() => {
    if (form.q || form.content || form.types !== "all") run();
    return () => ac.current?.abort();
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: Partial<SearchForm>) => onForm({ ...form, ...p });
  const hit = hits[cur];
  useEffect(() => {
    listRef.current?.querySelector(`tr[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (running) cancel();
      else onClose();
      return;
    }
    if (t.closest("input,select")) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        run();
      } else if (e.key === "ArrowDown" && hits.length) {
        e.preventDefault();
        e.stopPropagation();
        listRef.current?.focus();
      }
      return;
    }
    if (e.key === "ArrowDown") setCur((i) => Math.min(hits.length - 1, i + 1));
    else if (e.key === "ArrowUp") setCur((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setCur(0);
    else if (e.key === "End") setCur(hits.length - 1);
    else if (e.key === "PageDown") setCur((i) => Math.min(hits.length - 1, i + 10));
    else if (e.key === "PageUp") setCur((i) => Math.max(0, i - 10));
    else if (e.key === "Enter" && hit) {
      if (e.shiftKey) onOpen(hit.p, hit);
      else onReveal(hit.p);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const summary = () => {
    if (running) return `Searching... ${hits.length} found, ${scanned.toLocaleString()} entries scanned`;
    if (err) return err;
    if (!done) return "";
    const bits = [`${hits.length} found`, `${done.scanned.toLocaleString()} entries scanned`];
    if (form.content) bits.push(`${done.grepped.toLocaleString()} files read${done.skipped ? `, ${done.skipped} skipped (binary, large or unreadable)` : ""}`);
    if (done.capped) bits.push("stopped at the result or content size limit");
    if (done.truncated) bits.push("entry limit reached");
    if (done.depthLimited) bits.push("depth limit reached");
    if (done.errors) bits.push(`${done.errors} folders unreadable`);
    return bits.join(" · ");
  };

  return (
    <div className="sr" onKeyDown={onKey}>
      <form className="sr-form" onSubmit={(e) => (e.preventDefault(), run())} role="search" aria-label={`Search in ${dir}`}>
        <input
          autoFocus
          type="search"
          placeholder={form.mode === "glob" ? "Name glob, e.g. *.log" : form.mode === "regex" ? "Name regex" : "Name contains"}
          aria-label="Name"
          value={form.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select aria-label="Name match" value={form.mode} onChange={(e) => set({ mode: e.target.value as SearchMode })}>
          <option value="name">contains</option>
          <option value="glob">glob</option>
          <option value="regex">regex</option>
        </select>
        <Tip label="Match name case-sensitively"><label className="chk"><input type="checkbox" checked={!form.ic} onChange={(e) => set({ ic: !e.target.checked })} /> Aa</label></Tip>
        <input type="search" placeholder="Text inside files (optional)" aria-label="Content" value={form.content} onChange={(e) => set({ content: e.target.value })} />
        <Tip label="Treat the content text as a regular expression"><label className="chk"><input type="checkbox" checked={form.cre} onChange={(e) => set({ cre: e.target.checked })} /> regex</label></Tip>
        <Tip label="Match content case-sensitively"><label className="chk"><input type="checkbox" checked={!form.cic} onChange={(e) => set({ cic: !e.target.checked })} /> Aa</label></Tip>
        <select aria-label="Type" value={form.types} onChange={(e) => set({ types: e.target.value as SearchTypes })}>
          <option value="all">files and folders</option>
          <option value="file">files</option>
          <option value="dir">folders</option>
        </select>
        {running ? (
          <button type="button" onClick={cancel}>Cancel</button>
        ) : (
          <button type="submit" className="primary">Search</button>
        )}
        <Tip label="Close search" shortcut="Esc"><button type="button" aria-label="Close search" onClick={() => (onForm(EMPTY_SEARCH), onClose())}><X /></button></Tip>
      </form>
      <div className="sr-sum muted" role="status">
        <Tip label={`${node}:${dir}`}><span>In {dir}</span></Tip> · {summary()}
      </div>
      <div className="sr-list fp-scroll" ref={listRef} tabIndex={0}>
        <table className="ft">
          <thead>
            <tr><th>Name</th><th>Folder</th><th className="size">Size</th><th className="mtime">Modified</th><th /></tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={h.p} data-i={i} className={i === cur ? "sel cur" : ""} onClick={() => setCur(i)} onDoubleClick={() => onReveal(h.p)}>
                <td className="name">
                  <FileIcon className="ico" type={h.t} />
                  <span className="nm">{baseOf(h.p)}</span>
                  {h.x !== undefined && (
                    <span className="sr-snip muted">
                      {" "}
                      :{h.l} {h.x}
                      {h.n && h.n > 1 ? ` (+${h.n - 1} more lines)` : ""}
                    </span>
                  )}
                </td>
                <td className="sr-dir"><Tip label={dirOf(h.p) || "/"} fill><span>{dirOf(h.p) || "."}</span></Tip></td>
                <td className="num">{h.t === "dir" ? "" : fmtSize(h.s)}</td>
                <td className="num">{fmtDate(h.m)}</td>
                <td className="sr-act">
                  <Tip label="Show in its folder" shortcut="Enter"><button type="button" onClick={(e) => (e.stopPropagation(), onReveal(h.p))}>Reveal</button></Tip>
                  <Tip label={h.t === "dir" ? "Open folder" : "Open file in a new tab (Shift+Enter)"}><button type="button" onClick={(e) => (e.stopPropagation(), onOpen(h.p, h))}>Open</button></Tip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!running && done && !hits.length && <div className="muted pad">No matches.</div>}
      </div>
    </div>
  );
}
