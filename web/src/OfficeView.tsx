import { SkeletonLines } from "./Skeleton";
import { useEffect, useState } from "react";
import { fileUrl } from "./api";
import { MAX_ZIP, isEncryptedOffice, parseOffice, type OfficeDoc } from "./officeParse";
import * as Ic from "lucide-react";

/** Read-only text rendering of Word, Excel, PowerPoint, OpenDocument and CSV files, parsed in the browser. */
export function OfficeView({ node, path, ext, size }: { node: string; path: string; ext: string; size: number }) {
  const [doc, setDoc] = useState<OfficeDoc | null>(null);
  const [err, setErr] = useState("");
  const [sheet, setSheet] = useState(0);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setErr("");
    setSheet(0);
    setLocked(false);
    if (size > MAX_ZIP) return void setErr(`Too large to preview here (over ${MAX_ZIP / 1024 / 1024} MiB). Download it instead.`);
    fetch(fileUrl(node, path))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => {
        if (isEncryptedOffice(ext, b)) return void (live && setLocked(true));
        const d = parseOffice(ext, b);
        if (live) setDoc(d);
      })
      .catch((e: Error) => live && setErr(`Could not render this file: ${e.message}`));
    return () => {
      live = false;
    };
  }, [node, path, ext, size]);
  if (locked) {
    return (
      <div className="pv-empty muted pv-locked" role="alert">
        <Ic.Lock /> This document is password protected. Office encryption cannot be opened in the preview: download it and open it with its password.
      </div>
    );
  }
  if (err) return <div className="pv-empty muted" role="alert">{err}</div>;
  if (!doc) return <SkeletonLines lines={10} />;
  if (doc.kind === "doc") {
    return (
      <article className="pv-md pv-office" aria-label="Document text">
        {doc.note && <p className="muted">{doc.note}</p>}
        {doc.blocks.map((b, i) =>
          b.t === "table" ? (
            <table key={i}>
              <tbody>{b.rows.map((r, y) => <tr key={y}>{r.map((c, x) => <td key={x}>{c}</td>)}</tr>)}</tbody>
            </table>
          ) : b.h ? (
            b.h === 1 ? <h1 key={i}>{b.spans.map((s) => s.text).join("")}</h1> : b.h === 2 ? <h2 key={i}>{b.spans.map((s) => s.text).join("")}</h2> : <h3 key={i}>{b.spans.map((s) => s.text).join("")}</h3>
          ) : (
            <p key={i} className={b.bullet ? "pv-li" : undefined}>
              {b.spans.length ? b.spans.map((s, k) => (s.b || s.i ? <span key={k} className={(s.b ? "sp-b " : "") + (s.i ? "sp-i" : "")}>{s.text}</span> : s.text)) : " "}
            </p>
          ),
        )}
      </article>
    );
  }
  if (doc.kind === "slides") {
    return (
      <div className="pv-office pv-slides">
        {doc.slides.map((s, i) => (
          <section key={i} aria-label={`Slide ${i + 1}`}>
            <h4>Slide {i + 1}</h4>
            {s.length ? s.map((t, k) => <p key={k}>{t}</p>) : <p className="muted">(no text)</p>}
          </section>
        ))}
      </div>
    );
  }
  const sh = doc.sheets[Math.min(sheet, doc.sheets.length - 1)];
  return (
    <div className="pv-office pv-sheets">
      {doc.sheets.length > 1 && (
        <div className="pv-tabs" role="tablist" aria-label="Sheets">
          {doc.sheets.map((s, i) => (
            <button key={i} role="tab" aria-selected={i === sheet} className={i === sheet ? "on" : ""} onClick={() => setSheet(i)}><Ic.Table2 /> {s.name}</button>
          ))}
        </div>
      )}
      {sh && (
        <div className="pv-sheetwrap">
          <table>
            <tbody>
              {sh.rows.map((r, y) => (
                <tr key={y}>
                  <th scope="row">{y + 1}</th>
                  {r.map((c, x) => <td key={x}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {sh.truncated && <p className="muted pad">Only the first rows and columns are shown.</p>}
          {sh.rows.length === 0 && <p className="muted pad">Empty sheet</p>}
        </div>
      )}
    </div>
  );
}
