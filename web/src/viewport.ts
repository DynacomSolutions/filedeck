/**
 * Phone layout and on-screen keyboard handling.
 *
 * The page height follows the visual viewport (`--vvh`), so content above an
 * on-screen keyboard stays reachable on browsers that do not resize the layout
 * viewport themselves (iOS Safari). `interactive-widget=resizes-content` in the
 * viewport meta covers Chromium on Android; both agree, so they do not stack.
 */
import { useSyncExternalStore } from "react";

/** Widths up to this many CSS pixels are laid out as a phone: one panel at a time. */
export const PHONE_MAX_WIDTH = 700;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
/** A visual viewport this much shorter than the layout viewport means a keyboard is open. */
export const KEYBOARD_MIN_INSET = 120;
/** Space kept between a focused control and the keyboard edge. */
const MARGIN = 8;

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
}

export interface ViewportMetrics {
  /** height of the area the app may use, in px */
  height: number;
  /** distance the visual viewport is scrolled down inside the layout viewport, in px */
  top: number;
  /** height covered at the bottom, in px */
  keyboard: number;
  keyboardOpen: boolean;
}

/** Derive the usable area from the layout viewport height and the visual viewport. */
export function viewportMetrics(layoutHeight: number, vv: VisualViewportLike): ViewportMetrics {
  const height = Math.max(0, Math.round(vv.height));
  const top = Math.max(0, Math.round(vv.offsetTop));
  const keyboard = Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
  return { height, top, keyboard, keyboardOpen: keyboard >= KEYBOARD_MIN_INSET };
}

/**
 * How far to scroll (positive = down) so the control at `rect` sits inside the visible
 * area of height `visibleHeight`. 0 when it already fits.
 */
export function scrollDeltaToReveal(rect: { top: number; bottom: number }, visibleHeight: number): number {
  if (rect.bottom > visibleHeight - MARGIN) {
    // Taller than the area: align the top edge instead of hiding it.
    return Math.min(rect.bottom - (visibleHeight - MARGIN), Math.max(0, rect.top - MARGIN));
  }
  if (rect.top < MARGIN) return rect.top - MARGIN;
  return 0;
}

const EDITABLE = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[contenteditable=true],[contenteditable='']";
export const isEditableTarget = (el: Element | null): boolean => !!el && el.matches(EDITABLE);

interface Win {
  innerHeight: number;
  visualViewport?: (VisualViewportLike & EventTarget) | null;
  document: Document;
  requestAnimationFrame(cb: () => void): number;
}

/** Publish `--vvh` / `--vv-top`, toggle `kb-open` on <html>, and keep the focused control visible. */
export function installViewportTracking(win: Win = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  let frame = 0;
  const reveal = () => {
    const el = win.document.activeElement;
    if (!el || !isEditableTarget(el)) return;
    // The page may have been panned by the browser; scrollIntoView also works for nested scrollers.
    const r = el.getBoundingClientRect();
    if (scrollDeltaToReveal(r, vv.height) !== 0) (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const apply = () => {
    frame = 0;
    const m = viewportMetrics(win.innerHeight, vv);
    root.style.setProperty("--vvh", `${m.height}px`);
    root.style.setProperty("--vv-top", `${m.top}px`);
    root.classList.toggle("kb-open", m.keyboardOpen);
    if (m.keyboardOpen) reveal();
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(apply);
  };
  const onFocusIn = (e: Event) => {
    if (e.target instanceof Element && isEditableTarget(e.target)) {
      // The keyboard animates in after focus; the viewport events that follow re-run reveal.
      schedule();
      setTimeout(reveal, 300);
    }
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  win.document.addEventListener("focusin", onFocusIn);
  apply();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    win.document.removeEventListener("focusin", onFocusIn);
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--vv-top");
    root.classList.remove("kb-open");
  };
}

const phoneSubscribe = (f: () => void) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", f);
  return () => mq.removeEventListener("change", f);
};
/** True on phone widths; follows the browser window, not the panel. */
export const usePhone = () =>
  useSyncExternalStore(phoneSubscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
