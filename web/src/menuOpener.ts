/** Opener tracking for popup menus: a press on the element that opened a menu must close it and stay closed. */
export const TRIGGER_SELECTOR = "button,[role=button],[aria-haspopup]";

export interface LastPress {
  target: Element | null;
  button: number;
  time: number;
}

let last: LastPress | null = null;
let installed = false;

/** Installs the (single) window listener remembering the latest primary-button pointerdown. */
export function trackPresses(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      last = { target: e.target instanceof Element ? e.target : null, button: e.button, time: Date.now() };
    },
    true,
  );
}
export const lastPress = (): LastPress | null => last;

/** Pure: the element that opened a menu mounted at `now`, from the latest press and the focused element. */
export function resolveOpener(press: LastPress | null, active: Element | null, now: number, maxAgeMs = 1000): Element | null {
  const fresh = !!press && now - press.time <= maxAgeMs;
  if (fresh) {
    // A right-click (context menu) or a press on non-trigger content has no opener button.
    if (press!.button !== 0) return null;
    return press!.target?.closest?.(TRIGGER_SELECTOR) ?? null;
  }
  // Keyboard-opened: the focused trigger.
  return active && active !== document.body && active.matches?.(TRIGGER_SELECTOR) ? active : null;
}

/** Pure: whether a press at `target` lands on the opener (which toggles the menu closed instead of reopening it). */
export const isOpenerPress = (target: Node | null, opener: Node | null): boolean => !!target && !!opener && opener.contains(target);

/** Swallows the next click on `opener` (the click that follows the press that just closed its menu); self-clears after ~500ms. */
export function swallowNextClick(opener: Element, win: Window = window, ttlMs = 500): void {
  const off = () => {
    win.removeEventListener("click", on, true);
    clearTimeout(timer);
  };
  const on = (e: Event) => {
    if (!isOpenerPress(e.target as Node | null, opener)) return;
    e.stopPropagation();
    e.preventDefault();
    off();
  };
  const timer = setTimeout(off, ttlMs);
  win.addEventListener("click", on, true);
}
