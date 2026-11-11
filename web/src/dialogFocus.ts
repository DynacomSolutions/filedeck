import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

/** First visible control of a dialog, or the dialog itself. */
function firstControl(el: HTMLElement): HTMLElement {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).find((x) => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== "hidden") ?? el;
}

/**
 * Pure: handlers for a dialog backdrop that closes the dialog only for a deliberate click, that is a press and a release both on the
 * backdrop itself. A drag that starts in a field and ends outside (selecting text), or a press inside that ends outside, is not a click on it.
 * `isDirty` keeps a dialog with typed input open when the backdrop is clicked.
 */
export function backdropClose(onClose: () => void, isDirty: () => boolean = () => false) {
  let pressed = false;
  return {
    onMouseDown: (e: { target: unknown; currentTarget: unknown }) => { pressed = e.target === e.currentTarget; },
    onClick: (e: { target: unknown; currentTarget: unknown }) => {
      const deliberate = pressed && e.target === e.currentTarget;
      pressed = false;
      if (deliberate && !isDirty()) onClose();
    },
  };
}

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
      firstControl(el).focus({ preventScroll: true });
    });
    // When the focused control is removed or disabled (the content swaps, a button turns busy) focus falls to the page body, outside the
    // dialog and its Tab trap. Bring it back to the dialog, unless a newer dialog sits on top of this one.
    const observer = new MutationObserver(() => {
      const el = root.current;
      if (!el || !el.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== el) return;
      firstControl(el).focus({ preventScroll: true });
    });
    if (root.current) observer.observe(root.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
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
      observer.disconnect();
      document.removeEventListener("keydown", trap, true);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [root]);
}
