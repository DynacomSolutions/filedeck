import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

const DELAY = 450;
const GAP = 8;

interface Props {
  /** Tooltip text; empty or missing shows nothing. */
  label?: ReactNode;
  /** Keyboard shortcut shown beside the label. */
  shortcut?: string;
  /** Truncated-text mode: the wrapper fills the cell and ellipsises. */
  fill?: boolean;
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/**
 * Themed tooltip for icon-only controls, truncated text and info badges. Opens on hover (after a short
 * delay) and on keyboard focus, closes on leave, blur and Esc, stays inside the viewport and is linked to
 * its control with aria-describedby. Replaces the native `title` attribute.
 */
export function Tip({ label, shortcut, fill, children }: Props) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const has = label !== undefined && label !== null && label !== "";

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Place under the control, flip above when there is no room, and keep inside the viewport.
  useLayoutEffect(() => {
    if (!open || !wrap.current || !bubble.current) return;
    const a = wrap.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let y = a.bottom + GAP;
    if (y + b.height > vh - 4 && a.top - GAP - b.height >= 4) y = a.top - GAP - b.height;
    y = Math.max(4, Math.min(y, vh - b.height - 4));
    const x = Math.max(4, Math.min(a.left + a.width / 2 - b.width / 2, vw - b.width - 4));
    setPos({ x, y });
  }, [open, label, shortcut]);

  // Esc dismisses (WCAG 1.4.13) without leaving the control.
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && (hide(), e.stopPropagation());
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open, hide]);

  if (!has) return children;
  const child = isValidElement(children) ? cloneElement(children, { "aria-describedby": open ? id : undefined }) : children;
  return (
    <span ref={wrap} className={"tip" + (fill ? " tip--fill" : "")} onMouseEnter={() => show(DELAY)} onMouseLeave={hide} onFocus={() => show(150)} onBlur={hide} onPointerDown={hide}>
      {child}
      {open &&
        createPortal(
          <div ref={bubble} id={id} role="tooltip" className="tip-bubble" style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: "hidden" }}>
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}
