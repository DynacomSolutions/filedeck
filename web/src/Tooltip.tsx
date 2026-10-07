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
  /** Keep the tooltip open while true (an error that appears under a control that already has focus). */
  forceOpen?: boolean;
  /** Only open when this returns true for the wrapper (e.g. the text is actually truncated). */
  when?: (wrap: HTMLElement) => boolean;
  /** Place beside the closest ancestor matching this selector (to its right) instead of under the control, so it never covers neighbouring rows. */
  besideOf?: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/**
 * Themed tooltip for icon-only controls, truncated text and info badges. Opens on hover (after a short
 * delay) and on keyboard focus, closes on leave, blur and Esc, stays inside the viewport and is linked to
 * its control with aria-describedby. Replaces the native `title` attribute.
 */
export function Tip({ label, shortcut, fill, forceOpen, when, besideOf, children }: Props) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const shown = open || !!forceOpen;
  const has = label !== undefined && label !== null && label !== "";

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(hideTimer.current);
    timer.current = window.setTimeout(() => {
      if (!when || (wrap.current && when(wrap.current))) setOpen(true);
    }, delay);
  }, [when]);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(hideTimer.current);
    setOpen(false);
    setPos(null);
  }, []);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(hideTimer.current);
  }, []);

  // Place under the control, flip above when there is no room, and keep inside the viewport.
  useLayoutEffect(() => {
    if (!shown || !wrap.current || !bubble.current) return;
    const a = wrap.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const side = besideOf ? wrap.current.closest(besideOf) : null;
    if (side) {
      const sr = side.getBoundingClientRect();
      const sx = Math.min(sr.right + GAP, vw - b.width - 4);
      setPos({ x: Math.max(4, sx), y: Math.max(4, Math.min(a.top + a.height / 2 - b.height / 2, vh - b.height - 4)) });
      return;
    }
    let y = a.bottom + GAP;
    if (y + b.height > vh - 4 && a.top - GAP - b.height >= 4) y = a.top - GAP - b.height;
    y = Math.max(4, Math.min(y, vh - b.height - 4));
    const x = Math.max(4, Math.min(a.left + a.width / 2 - b.width / 2, vw - b.width - 4));
    setPos({ x, y });
  }, [shown, label, shortcut]);

  // Esc dismisses (WCAG 1.4.13) without leaving the control.
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && (hide(), e.stopPropagation());
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open, hide]);

  if (!has) return children;
  const child = isValidElement(children) ? cloneElement(children, { "aria-describedby": shown ? id : undefined }) : children;
  return (
    <span ref={wrap} className={"tip" + (fill ? " tip--fill" : "")} onMouseEnter={() => show(DELAY)} onMouseLeave={(e) => {
      // The tooltip is portalled to body, so moving the pointer to it leaves this wrapper.
      // Keep it open while the pointer is over the tooltip, as required by 1.4.13.
      if (bubble.current?.contains(e.relatedTarget as Node | null)) return;
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        if (!wrap.current?.contains(document.activeElement) && !bubble.current?.matches(":hover")) hide();
      }, 180);
    }} onFocus={() => show(150)} onBlur={(e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      hide();
    }} onPointerDown={hide}>
      {child}
      {shown &&
        createPortal(
          <div ref={bubble} id={id} role="tooltip" className="tip-bubble" onMouseEnter={() => { window.clearTimeout(timer.current); window.clearTimeout(hideTimer.current); setOpen(true); }} onMouseLeave={(e) => {
            if (wrap.current?.contains(e.relatedTarget as Node | null)) return;
            window.clearTimeout(hideTimer.current);
            hideTimer.current = window.setTimeout(() => {
              if (!wrap.current?.contains(document.activeElement)) hide();
            }, 120);
          }} style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: "hidden" }}>
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}
