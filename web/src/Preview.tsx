import { useEffect, useState } from "react";
import { canEdit, fileUrl, fmtDate, fmtSize, type Entry } from "./api";

const ext = (n: string) => n.slice(n.lastIndexOf(".") + 1).toLowerCase();
const IMG = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VID = ["mp4", "m4v", "webm", "mov", "mkv"];
const AUD = ["mp3", "m4a", "ogg", "wav", "flac", "opus"];
const TXT = ["txt", "md", "log", "json", "yaml", "yml", "ts", "tsx", "js", "css", "html", "xml", "csv", "sh", "py", "toml", "ini", "conf", "go", "rs"];

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

export function Preview({ node, entry, onEdit }: { node: string; entry: Entry | null; onEdit: (node: string, path: string) => void }) {
  if (!entry || entry.type === "dir") return <div className="pv-empty muted">Select a file to preview</div>;
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
      </div>
      <div className="pv-body">
        {IMG.includes(e) ? (
          <img src={url} alt={entry.name} />
        ) : VID.includes(e) ? (
          <video src={url} controls preload="metadata" />
        ) : AUD.includes(e) ? (
          <audio src={url} controls preload="metadata" />
        ) : e === "pdf" ? (
          <iframe src={url} title={entry.name} sandbox="allow-same-origin" />
        ) : TXT.includes(e) || entry.size === 0 ? (
          <Text url={url} />
        ) : (
          <div className="pv-empty muted">No preview for this type</div>
        )}
      </div>
    </div>
  );
}
