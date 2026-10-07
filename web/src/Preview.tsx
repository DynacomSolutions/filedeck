import { useEffect, useState, type ReactNode } from "react";
import { SkeletonLines } from "./Skeleton";
import { canEdit, fileUrl, fmtDate, fmtSize, isArchive, type Entry } from "./api";
import { ArchiveView } from "./ArchiveView";
import { OfficeView } from "./OfficeView";
import { PdfView } from "./PdfView";
import { LEGACY_OFFICE, OFFICE_EXT } from "./officeParse";
import { HexView } from "./HexView";
import { MarkdownView } from "./MarkdownView";
import { AUDIO_EXT, MediaPlayer, VIDEO_EXT } from "./MediaPlayers";
import { isTextName } from "./highlight";
import { PlainOrCode } from "./PlainOrCode";
import { Tip } from "./Tooltip";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import * as Ic from "lucide-react";

const ext = (n: string) => n.slice(n.lastIndexOf(".") + 1).toLowerCase();
const IMG = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VID = VIDEO_EXT;
const AUD = AUDIO_EXT;
function Text({ url, path }: { url: string; path: string }) {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    setT(null);
    const ctl = new AbortController();
    fetch(url, { headers: { range: "bytes=0-262143" }, signal: ctl.signal })
      .then((r) => r.text())
      .then(setT)
      .catch(() => setT("(could not load)"));
    return () => ctl.abort();
  }, [url]);
  if (t === null) return <SkeletonLines lines={10} />;
  if (t.length === 0) return <pre className="pv-text" />;
  return <PlainOrCode id={url} name={path.slice(path.lastIndexOf("/") + 1)} text={t} />;
}

/** The image fades in once decoded; until then a placeholder block holds the space. */
function Img({ url, alt }: { url: string; alt: string }) {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(false), [url]);
  return (
    <>
      {!ok && <div className="pv-imgsk" role="status" aria-label="Loading" />}
      <img src={url} alt={alt} style={ok ? undefined : { opacity: 0, position: "absolute" }} onLoad={() => setOk(true)} onError={() => setOk(true)} />
    </>
  );
}

export function Preview({ node, entry, onEdit, extra }: { node: string; entry: Entry; onEdit: (node: string, path: string) => void; extra?: ReactNode }) {
  const url = fileUrl(node, entry.path);
  const e = ext(entry.name);
  const [hex, setHex] = useState(false);
  useEffect(() => setHex(false), [node, entry.path]);
  const isOffice = OFFICE_EXT.includes(e) && (e !== "csv" && e !== "tsv" || entry.size <= 8 * 1024 * 1024);
  const [menu, setMenu] = useState<{ x: number; y: number; opener: HTMLElement } | null>(null);
  const known = isArchive(entry.name) || IMG.includes(e) || VID.includes(e) || AUD.includes(e) || e === "pdf" || isOffice || LEGACY_OFFICE.includes(e) || e === "md" || e === "markdown" || isTextName(entry.name) || entry.size === 0;
  const items: MenuItem[] = [
    ...(entry.size > 0 && known ? [{ label: hex ? "Back to preview" : "Hex dump", icon: hex ? Ic.Eye : Ic.Binary, onSelect: () => setHex(!hex) } satisfies MenuItem] : []),
    { label: "Download", onSelect: () => {
      const a = document.createElement("a");
      a.href = fileUrl(node, entry.path, "download");
      a.download = entry.name;
      a.click();
    } },
  ];
  return (
    <div className="pv">
      <div className="pv-head">
        <Tip label={entry.path}><b className="pv-title">{entry.name}</b></Tip>
        <span className="muted pv-meta">{fmtSize(entry.size)} · {fmtDate(entry.mtime)}</span>
        <span className="pv-acts">
          {canEdit(entry) && (
            <Tip label="Open in the editor"><button type="button" aria-label="Edit" onClick={() => onEdit(node, entry.path)}><Ic.FilePen /><span className="pv-lbl">Edit</span></button></Tip>
          )}
          <Tip label="More actions">
            <button type="button" aria-label="More file actions" aria-haspopup="menu" aria-expanded={!!menu} onClick={(ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right, y: r.bottom + 4, opener: ev.currentTarget });
            }}><Ic.Ellipsis /></button>
          </Tip>
        </span>
        {extra}
        {menu && <ContextMenu x={menu.x} y={menu.y} opener={menu.opener} items={items} onClose={() => setMenu(null)} />}
      </div>
      <div className="pv-body">
        {hex || (!known && entry.size > 0) ? (
          <HexView node={node} path={entry.path} size={entry.size} />
        ) : isArchive(entry.name) ? (
          <ArchiveView node={node} entry={entry} />
        ) : IMG.includes(e) ? (
          <Img url={url} alt={entry.name} />
        ) : VID.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="video" />
        ) : AUD.includes(e) ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="audio" />
        ) : e === "pdf" ? (
          <PdfView node={node} path={entry.path} name={entry.name} />
        ) : isOffice ? (
          <OfficeView node={node} path={entry.path} ext={e} size={entry.size} />
        ) : LEGACY_OFFICE.includes(e) ? (
          <div className="pv-empty muted">Legacy .{e} files cannot be rendered here. Use Hex to inspect, or Download.</div>
        ) : e === "md" || e === "markdown" ? (
          <MarkdownView node={node} path={entry.path} />
        ) : isTextName(entry.name) || entry.size === 0 ? (
          <Text url={url} path={entry.path} />
        ) : (
          <div className="pv-empty muted">No preview for this type</div>
        )}
      </div>
    </div>
  );
}
