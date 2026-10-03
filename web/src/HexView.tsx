import { SkeletonLines } from "./Skeleton";
import { useEffect, useState } from "react";
import { fileUrl } from "./api";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Tip } from "./Tooltip";

const PAGE = 4096;
const COLS = 16;

/** One hex-dump row: offset, up to 16 byte pairs (a gap after 8) and the printable ASCII. */
export function hexRow(offset: number, bytes: Uint8Array): { off: string; hex: string; ascii: string } {
  let hex = "";
  let ascii = "";
  for (let i = 0; i < COLS; i++) {
    const b = bytes[i];
    hex += (i === 8 ? "  " : i ? " " : "") + (b === undefined ? "  " : b.toString(16).padStart(2, "0"));
    ascii += b === undefined ? "" : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  return { off: offset.toString(16).padStart(8, "0"), hex, ascii };
}

/** Parse "0x1f00", "1f00h" (hex) or "4096" (decimal); null when not a number. */
export function parseOffset(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const n = /^0x[0-9a-f]+$/.test(t) ? parseInt(t.slice(2), 16) : /^[0-9a-f]+h$/.test(t) ? parseInt(t.slice(0, -1), 16) : /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Paged hex dump of any file, read with Range requests (4 KiB at a time) so size does not matter. */
export function HexView({ node, path, size }: { node: string; path: string; size: number }) {
  const [page, setPage] = useState(0);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [err, setErr] = useState("");
  const [jump, setJump] = useState("");
  const pages = Math.max(1, Math.ceil(size / PAGE));
  useEffect(() => {
    setPage(0);
  }, [node, path]);
  useEffect(() => {
    if (size === 0) return void setBytes(new Uint8Array());
    const ctl = new AbortController();
    setBytes(null);
    setErr("");
    const start = page * PAGE;
    fetch(fileUrl(node, path), { headers: { range: `bytes=${start}-${Math.min(size, start + PAGE) - 1}` }, signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setBytes(new Uint8Array(await r.arrayBuffer()));
      })
      .catch((e: Error) => e.name !== "AbortError" && setErr("Could not read the file: " + e.message));
    return () => ctl.abort();
  }, [node, path, page, size]);
  const go = (p: number) => setPage(Math.min(pages - 1, Math.max(0, p)));
  const rows = [];
  if (bytes) for (let i = 0; i < bytes.length; i += COLS) rows.push(hexRow(page * PAGE + i, bytes.subarray(i, i + COLS)));
  return (
    <div className="pv-hex">
      <div className="pv-hexbar">
        <Tip label="First page"><button onClick={() => go(0)} disabled={page === 0} aria-label="First page"><ChevronsLeft /></button></Tip>
        <Tip label="Previous page"><button onClick={() => go(page - 1)} disabled={page === 0} aria-label="Previous page"><ChevronLeft /></button></Tip>
        <span className="muted">
          {(page * PAGE).toString(16)}h - {Math.min(size, (page + 1) * PAGE).toString(16)}h of {size.toString(16)}h ({page + 1}/{pages})
        </span>
        <Tip label="Next page"><button onClick={() => go(page + 1)} disabled={page >= pages - 1} aria-label="Next page"><ChevronRight /></button></Tip>
        <Tip label="Last page"><button onClick={() => go(pages - 1)} disabled={page >= pages - 1} aria-label="Last page"><ChevronsRight /></button></Tip>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseOffset(jump);
            if (n === null) return setErr("Enter an offset such as 0x1f00, 1f00h or 4096");
            setErr("");
            go(Math.floor(n / PAGE));
          }}
        >
          <input value={jump} onChange={(e) => setJump(e.target.value)} placeholder="Go to offset" aria-label="Go to offset (0x.. hex, or decimal)" size={12} />
        </form>
      </div>
      {err && <div className="fp-err" role="alert">{err}</div>}
      {bytes === null && !err && <SkeletonLines lines={12} />}
      {bytes && size === 0 && <div className="pv-empty muted">Empty file</div>}
      <pre className="pv-hexdump" aria-label="Hex dump" tabIndex={0}>
        {rows.map((r) => (
          <div key={r.off}>
            <span className="hx-off">{r.off}</span>  <span className="hx-hex">{r.hex}</span>  <span className="hx-asc">{r.ascii}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
