import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eraser, Archive, ChevronRight, CircleX, ClipboardPaste, Copy, CopyPlus, Diff, Download, FilePen, FilePlus, FolderInput, FolderOpen, FolderPlus, GitCompareArrows, GitPullRequest, Info, Link, LogOut, MousePointer2, PackageOpen, Pencil, Eye, RefreshCw, Scissors, SquareCheck, SquarePlus, Star, StarOff, KeyRound, Trash2, Upload, X, ArrowLeft, ArrowRight, Columns2, type LucideIcon } from "lucide-react";

export type MenuItem =
  | "sep"
  | {
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** shortcut text shown on the right */
      hint?: string;
      /** one nested level */
      sub?: MenuItem[];
    };

type Item = Exclude<MenuItem, "sep">;
/** Icon for a menu row, chosen from its label so every item carries one (flat lucide line icon, 16px). */
const ICONS: [RegExp, LucideIcon][] = [
  [/^Open trash/i, Trash2], [/^Pull request diff/i, GitPullRequest], [/^Open in new panel|^Show in new panel/i, Columns2], [/^Open here/i, FolderOpen], [/^Open in new tab|^New tab|^Duplicate tab/i, SquarePlus], [/^Open/i, FolderOpen],
  [/^Remove bookmark/i, StarOff], [/bookmark/i, Star], [/^Preview/i, Eye], [/^Edit link|^Edit/i, FilePen], [/^Cut/i, Scissors], [/^Copy path/i, Copy],
  [/^Copy to|^Copy/i, Copy], [/^Paste/i, ClipboardPaste], [/^Rename/i, Pencil], [/^Duplicate/i, CopyPlus], [/^Compress/i, Archive], [/^Extract/i, PackageOpen], [/^Forget saved/i, KeyRound],
  [/^Download/i, Download], [/^Move to trash|^Delete left|^Delete right/i, Trash2], [/^Delete/i, CircleX], [/^Properties/i, Info], [/^New file/i, FilePlus],
  [/^New folder/i, FolderPlus], [/^New symbolic/i, Link], [/^Select all/i, SquareCheck], [/^Upload/i, Upload], [/^Refresh/i, RefreshCw],
  [/^Clear/i, Eraser], [/^Exit compare/i, LogOut], [/^Compare|^Selected in/i, GitCompareArrows], [/^Mark for diff|^Diff/i, Diff], [/^Move left/i, ArrowLeft], [/^Move right/i, ArrowRight],
  [/^Move to|^Move/i, FolderInput], [/^Close/i, X], [/^No other/i, X],
];
const iconFor = (label: string): LucideIcon => ICONS.find(([re]) => re.test(label))?.[1] ?? MousePointer2;
const actionable = (items: MenuItem[]) => items.map((it, i) => [it, i] as const).filter((p): p is readonly [Item, number] => p[0] !== "sep" && !p[0].disabled).map((p) => p[1]);

function Menu({ items, x, y, onClose, depth = 0, onLeft, onEscape }: { items: MenuItem[]; x: number; y: number; onClose: () => void; depth?: number; onLeft?: () => void; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [cur, setCur] = useState<number>(() => actionable(items)[0] ?? -1);
  const [openSub, setOpenSub] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || depth > 0) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y, items]);
  useLayoutEffect(() => {
    if (cur < 0) ref.current?.focus();
    else ref.current?.querySelector<HTMLElement>(`[data-menu-index="${cur}"]`)?.focus();
  }, [cur]);

  const flip = () => {
    const r = ref.current?.getBoundingClientRect();
    return r ? r.right + 260 > window.innerWidth : false;
  };
  const run = (it: Item) => {
    if (it.disabled) return;
    if (it.sub) return setOpenSub(items.indexOf(it));
    onClose();
    it.onSelect?.();
  };
  const move = (d: 1 | -1) => {
    const a = actionable(items);
    if (!a.length) return;
    const at = a.indexOf(cur);
    setCur(a[(at + d + a.length) % a.length]!);
    setOpenSub(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const it = cur >= 0 ? items[cur] : undefined;
    const item = it && it !== "sep" ? it : undefined;
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") setCur(actionable(items)[0] ?? -1);
    else if (e.key === "End") setCur(actionable(items).at(-1) ?? -1);
    else if (e.key === "Enter" || e.key === " ") item && run(item);
    else if (e.key === "ArrowRight") item?.sub && setOpenSub(cur);
    else if (e.key === "ArrowLeft") (depth > 0 ? onLeft?.() : undefined);
    else if (e.key === "Escape" || e.key === "Tab") {
      onClose();
      if (e.key === "Escape") onEscape?.();
    }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const hit = actionable(items).find((i) => (items[i] as Item).label.toLowerCase().startsWith(k));
      if (hit !== undefined) setCur(hit);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const body = (
    <div ref={ref} className={"ctx" + (depth ? " ctx-sub" : "")} role="menu" tabIndex={-1} style={depth ? undefined : { left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <div key={i} className="ctx-row">
            <button
              type="button"
              role="menuitem"
              data-menu-index={i}
              tabIndex={cur === i ? 0 : -1}
              disabled={it.disabled}
              aria-haspopup={it.sub ? "menu" : undefined}
              aria-expanded={it.sub ? openSub === i : undefined}
              className={(it.danger ? "danger " : "") + (cur === i ? "cur" : "")}
              onFocus={() => {
                if (!it.disabled) setCur(i);
              }}
              onMouseEnter={() => {
                if (it.disabled) return;
                setCur(i);
                setOpenSub(it.sub ? i : null);
              }}
              onClick={() => run(it)}
            >
              <span className="ctx-l">{(() => { const I = iconFor(it.label); return <I aria-hidden="true" />; })()}{it.label}</span>
              {it.sub ? <span className="hint"><ChevronRight /></span> : it.hint ? <span className="hint">{it.hint}</span> : null}
            </button>
            {it.sub && openSub === i && (
              <div className={"ctx-subwrap" + (flip() ? " flip" : "")}>
                <Menu items={it.sub} x={0} y={0} onClose={onClose} depth={1} onEscape={onEscape} onLeft={() => {
                  setOpenSub(null);
                  requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`)?.focus());
                }} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
  return depth === 0 ? createPortal(<div role="region" aria-label="Context menu">{body}</div>, document.body) : body;
}

/** Context menu at viewport coordinates; closes on outside click, Escape, scroll or resize. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const down = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.(".ctx")) onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  return <Menu items={items} x={x} y={y} onClose={onClose} onEscape={() => requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }))} />;
}
