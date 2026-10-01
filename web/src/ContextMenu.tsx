import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
const actionable = (items: MenuItem[]) => items.map((it, i) => [it, i] as const).filter((p): p is readonly [Item, number] => p[0] !== "sep" && !p[0].disabled).map((p) => p[1]);

function Menu({ items, x, y, onClose, depth = 0, onLeft }: { items: MenuItem[]; x: number; y: number; onClose: () => void; depth?: number; onLeft?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [cur, setCur] = useState<number>(() => (depth > 0 ? (actionable(items)[0] ?? -1) : -1));
  const [openSub, setOpenSub] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || depth > 0) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y, items]);
  useEffect(() => {
    ref.current?.focus();
  }, []);

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
    else if (e.key === "Escape" || e.key === "Tab") onClose();
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
              tabIndex={-1}
              disabled={it.disabled}
              aria-haspopup={it.sub ? "menu" : undefined}
              aria-expanded={it.sub ? openSub === i : undefined}
              className={(it.danger ? "danger " : "") + (cur === i ? "cur" : "")}
              onMouseEnter={() => {
                if (it.disabled) return;
                setCur(i);
                setOpenSub(it.sub ? i : null);
              }}
              onClick={() => run(it)}
            >
              <span>{it.label}</span>
              {it.sub ? <span className="hint">▸</span> : it.hint ? <span className="hint">{it.hint}</span> : null}
            </button>
            {it.sub && openSub === i && (
              <div className={"ctx-subwrap" + (flip() ? " flip" : "")}>
                <Menu items={it.sub} x={0} y={0} onClose={onClose} depth={1} onLeft={() => (setOpenSub(null), ref.current?.focus())} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
  return depth === 0 ? createPortal(body, document.body) : body;
}

/** Context menu at viewport coordinates; closes on outside click, Escape, scroll or resize. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
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
  return <Menu items={items} x={x} y={y} onClose={onClose} />;
}
