import { useEffect, useRef, type RefObject } from "react";

/** Focus a dialog on open, keep Tab inside its active layer, and return focus on close. */
export function useDialogFocus<T extends HTMLElement>(root: RefObject<T | null>) {
  // Capture during render, before children with autoFocus move focus during commit.
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = root.current;
      if (!el) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && el.contains(active) && active.getClientRects().length) return;
      const first = Array.from(el.querySelectorAll<HTMLElement>("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])"))
        .find((x) => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== "hidden");
      (first ?? el).focus({ preventScroll: true });
    });
    const trap = (event: KeyboardEvent) => {
      const el = root.current;
      if (!el || event.key !== "Tab" || (event.target as Element | null)?.closest('[role="dialog"]') !== el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])"))
        .filter((x) => !((x as HTMLButtonElement).disabled) && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== "hidden" && (x.closest('[role="dialog"]') === el || !x.closest('[role="dialog"]')));
      if (!focusable.length) {
        event.preventDefault();
        el.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap, true);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [root]);
}
