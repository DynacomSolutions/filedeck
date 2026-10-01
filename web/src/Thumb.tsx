import { useEffect, useRef, useState } from "react";
import { fileUrl, thumbKind, thumbUrl, type Entry } from "./api";
import { Play } from "lucide-react";
import { FileIcon } from "./FileIcon";

const SVG_MAX = 1024 * 1024;

/**
 * Grid tile picture. The thumbnail is requested only once the tile scrolls near the view
 * (the agent generates and caches it); anything without a thumbnail, or that fails, shows its icon.
 */
export function Thumb({ node, entry, isDir }: { node: string; entry: Entry; isDir: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [tries, setTries] = useState(0);
  const [bad, setBad] = useState(false);
  const kind = !isDir && entry.type === "file" ? thumbKind(entry.name) : null;
  const usable = kind === "svg" ? entry.size <= SVG_MAX : !!kind;

  useEffect(() => {
    const el = box.current;
    if (!el || !usable || near) return;
    const io = new IntersectionObserver((r) => r.some((x) => x.isIntersecting) && (setNear(true), io.disconnect()), { root: el.closest(".fp-scroll"), rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [usable, near]);

    const src = kind === "svg" ? fileUrl(node, entry.path) : thumbUrl(node, entry.path, entry.mtime, tries);
  return (
    <div className="tile-img" ref={box}>
      {usable && near && !bad ? (
        <>
          <img
            src={src}
            alt=""
            decoding="async"
            draggable={false}
            onError={() => {
              // A busy agent answers 429: one more try after a short random wait, then the icon stays.
              if (tries < 1 && kind !== "svg") setTimeout(() => setTries(1), 1200 + Math.random() * 1500);
              else setBad(true);
            }}
          />
          {kind === "video" && <span className="tile-play" aria-hidden="true"><Play /></span>}
        </>
      ) : (
        <span className="tile-ico"><FileIcon dir={isDir} type={entry.type} kind={kind} /></span>
      )}
    </div>
  );
}
