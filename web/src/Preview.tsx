import { useEffect, useState, type ReactNode } from "react";
import { SkeletonLines } from "./Skeleton";
import { canEdit, fileUrl, fmtDate, fmtSize, type Entry } from "./api";
import { ArchiveView } from "./ArchiveView";
import { OfficeView } from "./OfficeView";
import { PdfView } from "./PdfView";
import { HexView } from "./HexView";
import { MarkdownView } from "./MarkdownView";
import { MediaPlayer } from "./MediaPlayers";
import { extOf, looksLikeText, previewKind, SNIFF_BYTES, type PreviewKind } from "./previewKind";
import { PlainOrCode } from "./PlainOrCode";
import { Tip } from "./Tooltip";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import * as Ic from "lucide-react";

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

/** For a name that says nothing about its type: read the first bytes and report "text" or "binary" (null while loading). */
function useSniff(url: string, size: number, enabled: boolean): "text" | "binary" | null {
  const [r, setR] = useState<"text" | "binary" | null>(null);
  useEffect(() => {
    setR(null);
    if (!enabled) return;
    const ctl = new AbortController();
    fetch(url, { headers: { range: `bytes=0-${Math.min(size, SNIFF_BYTES) - 1}` }, signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, SNIFF_BYTES);
        setR(looksLikeText(bytes, size > bytes.length) ? "text" : "binary");
      })
      .catch((e: Error) => e.name !== "AbortError" && setR("binary"));
    return () => ctl.abort();
  }, [url, size, enabled]);
  return r;
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
  const e = extOf(entry.name);
  const [hex, setHex] = useState(false);
  useEffect(() => setHex(false), [node, entry.path]);
  const byName = previewKind(entry.name, entry.size);
  const sniffed = useSniff(url, entry.size, byName === "unknown");
  const kind: PreviewKind | "sniffing" = byName !== "unknown" ? byName : sniffed === null ? "sniffing" : sniffed === "text" ? "text" : "unknown";
  const [menu, setMenu] = useState<{ x: number; y: number; opener: HTMLElement } | null>(null);
  const known = kind !== "unknown" && kind !== "sniffing";
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
        {kind === "sniffing" ? (
          <SkeletonLines lines={10} />
        ) : hex || (kind === "unknown" && entry.size > 0) ? (
          <HexView node={node} path={entry.path} size={entry.size} />
        ) : kind === "archive" ? (
          <ArchiveView node={node} entry={entry} />
        ) : kind === "image" ? (
          <Img url={url} alt={entry.name} />
        ) : kind === "video" ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="video" />
        ) : kind === "audio" ? (
          <MediaPlayer node={node} path={entry.path} name={entry.name} kind="audio" />
        ) : kind === "pdf" ? (
          <PdfView node={node} path={entry.path} name={entry.name} />
        ) : kind === "office" ? (
          <OfficeView node={node} path={entry.path} ext={e} size={entry.size} />
        ) : kind === "legacy-office" ? (
          <div className="pv-empty muted">Legacy .{e} files cannot be rendered here. Use Hex to inspect, or Download.</div>
        ) : kind === "markdown" ? (
          <MarkdownView node={node} path={entry.path} />
        ) : (
          <Text url={url} path={entry.path} />
        )}
      </div>
    </div>
  );
}
