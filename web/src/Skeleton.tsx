import type { CSSProperties } from "react";

/** Name widths (percent of the column) cycled through so the placeholder rows do not look like a barcode. */
const NAME_W = [46, 62, 38, 54, 70, 44, 58, 34, 66, 50, 42, 60];

/** Placeholder list rows with the metrics of real rows (same cells, same 22 px line), so data replaces them without moving anything. Static, no shimmer. */
export function SkeletonRows({ rows = 12, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} className="skel" aria-hidden="true">
          <td className="name">
            <span className="sk sk-ico" />
            <span className="sk sk-nm" style={{ width: `${NAME_W[i % NAME_W.length]! / 4}rem`, maxWidth: "70%" }} />
          </td>
          {cols > 1 && <td className="num"><span className="sk sk-num" style={{ "--w": "3.4rem" } as CSSProperties} /></td>}
          {cols > 2 && <td className="num"><span className="sk sk-num" style={{ "--w": "7.2rem" } as CSSProperties} /></td>}
        </tr>
      ))}
    </>
  );
}

/** Placeholder grid tiles with the size of real tiles. */
export function SkeletonTiles({ tiles = 12 }: { tiles?: number }) {
  return (
    <>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="tile skel" aria-hidden="true">
          <div className="tile-img" />
          <div className="tile-name"><span className="sk sk-tile" style={{ width: `${NAME_W[i % NAME_W.length]}%` }} /></div>
        </div>
      ))}
    </>
  );
}

/** A block of text-line placeholders for a pane that is loading (preview, properties). `lines` keeps the height stable. */
export function SkeletonLines({ lines = 8 }: { lines?: number }) {
  return (
    <div className="sk-lines" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="sk" style={{ width: `${NAME_W[(i * 5) % NAME_W.length]! + 20}%` }} />
      ))}
    </div>
  );
}
