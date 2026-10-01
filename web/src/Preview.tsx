import { useEffect, useState, type ReactNode } from "react";
import { canEdit, fileUrl, fmtDate, fmtSize, isArchive, type Entry } from "./api";
import { ArchiveView } from "./ArchiveView";
import { MarkdownView } from "./MarkdownView";
import { AUDIO_EXT, MediaPlayer, VIDEO_EXT } from "./MediaPlayers";

const ext = (n: string) => n.slice(n.lastIndexOf(".") + 1).toLowerCase();
const IMG = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VID = VIDEO_EXT;
const AUD = AUDIO_EXT;
const TXT = ["txt", "log", "json", "yaml", "yml", "ts", "tsx", "js", "css", "html", "xml", "csv", "sh", "py", "toml", "ini", "conf", "go", "rs"];

function Text({ url }: { url: string }) {
  const [t, setT] = useState("loading...");
  useEffect(() => {
    const ctl = new AbortController();
    fetch(url, { headers: { range: "bytes=0-262143" }, signal: ctl.signal })
      .then((r) => r.text())
      .then(setT)
      .catch(() => setT("(could not load)"));
    return () => ctl.abort();
  }, [url]);
  return <pre className="pv-text">{t}</pre>;
}

export function Preview({ node, entry, onEdit, extra }: { node: string; entry: Entry; onEdit: (node: string, path: string) => void; extra?: ReactNode }) {
  const url = fileUrl(node, entry.path);
  const e = ext(entry.name);
  return (
    <div className="pv">
      <div className="pv-head">
        <b title={entry.path}>{entry.name}</b>
        <span className="muted">
          {fmtSize(entry.size)} · {fmtDate(entry.mtime)}
        </span>
        {canEdit(entry) && (
          <button className="link" onClick={() => onEdit(node, entry.path)} title="Open in the editor">Edit</button>
        )}
        <a href={fileUrl(node, entry.path, "download")}>Download</a>
        {extra}
      </div>
      <div className="pv-body">
        {isArchive(entry.name) ? (
          <ArchiveView node={node} entry={entry} />
        ) : IMG.includes(e) ? (
          <img src={url} alt={entry.name} />
        ) : VID.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="video" />
        ) : AUD.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="audio" />
        ) : e === "pdf" ? (
          <iframe src={url} title={entry.name} sandbox="allow-same-origin" />
        ) : e === "md" || e === "markdown" ? (
          <MarkdownView node={node} path={entry.path} />
        ) : TXT.includes(e) || entry.size === 0 ? (
          <Text url={url} />
        ) : (
          <div className="pv-empty muted">No preview for this type</div>
        )}
      </div>
    </div>
  );
}
