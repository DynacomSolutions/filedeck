import { useEffect, useState, type ReactNode } from "react";
import { canEdit, fileUrl, fmtDate, fmtSize, isArchive, type Entry } from "./api";
import { ArchiveView } from "./ArchiveView";
import { OfficeView } from "./OfficeView";
import { LEGACY_OFFICE, OFFICE_EXT } from "./officeParse";
import { HexView } from "./HexView";
import { MarkdownView } from "./MarkdownView";
import { AUDIO_EXT, MediaPlayer, VIDEO_EXT } from "./MediaPlayers";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";

const ext = (n: string) => n.slice(n.lastIndexOf(".") + 1).toLowerCase();
const IMG = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VID = VIDEO_EXT;
const AUD = AUDIO_EXT;
const TXT = ["txt", "log", "json", "yaml", "yml", "ts", "tsx", "js", "css", "html", "xml", "csv", "tsv", "sh", "py", "toml", "ini", "conf", "go", "rs"];

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
  const [hex, setHex] = useState(false);
  useEffect(() => setHex(false), [node, entry.path]);
  const isOffice = OFFICE_EXT.includes(e) && (e !== "csv" && e !== "tsv" || entry.size <= 8 * 1024 * 1024);
  const known = isArchive(entry.name) || IMG.includes(e) || VID.includes(e) || AUD.includes(e) || e === "pdf" || isOffice || LEGACY_OFFICE.includes(e) || e === "md" || e === "markdown" || TXT.includes(e) || entry.size === 0;
  return (
    <div className="pv">
      <div className="pv-head">
        <Tip label={entry.path}><b>{entry.name}</b></Tip>
        <span className="muted">
          {fmtSize(entry.size)} · {fmtDate(entry.mtime)}
        </span>
        {canEdit(entry) && (
          <Tip label="Open in the editor"><button className="link" onClick={() => onEdit(node, entry.path)}><Ic.FilePen /> Edit</button></Tip>
        )}
        {entry.size > 0 && known && (
          <Tip label="Show the raw bytes as a hex dump"><button className="link" aria-pressed={hex} onClick={() => setHex(!hex)}>{hex ? <Ic.Eye /> : <Ic.Binary />} {hex ? "Preview" : "Hex"}</button></Tip>
        )}
        <a href={fileUrl(node, entry.path, "download")}><Ic.Download /> Download</a>
        {extra}
      </div>
      <div className="pv-body">
        {hex || (!known && entry.size > 0) ? (
          <HexView node={node} path={entry.path} size={entry.size} />
        ) : isArchive(entry.name) ? (
          <ArchiveView node={node} entry={entry} />
        ) : IMG.includes(e) ? (
          <img src={url} alt={entry.name} />
        ) : VID.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="video" />
        ) : AUD.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="audio" />
        ) : e === "pdf" ? (
          <iframe src={url} title={entry.name} sandbox="allow-same-origin" />
        ) : isOffice ? (
          <OfficeView node={node} path={entry.path} ext={e} size={entry.size} />
        ) : LEGACY_OFFICE.includes(e) ? (
          <div className="pv-empty muted">Legacy .{e} files cannot be rendered here. Use Hex to inspect, or Download.</div>
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
