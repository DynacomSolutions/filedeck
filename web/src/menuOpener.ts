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

/** Pure: where focus goes when a menu closes. The trigger if there is one, else whatever held focus when the menu opened (the file list after Shift+F10 or a right-click); nothing if that was the page body. */
export function resolveReturnFocus(opener: Element | null, active: Element | null, body: Element | null, pressed: Element | null = null): Element | null {
  if (opener) return opener;
  if (active && active !== body) return active;
  return pressed; // a right-click on content that does not take focus: the focusable container it happened in
}

/** Pure: the nearest focusable ancestor of a fresh secondary-button press, if there is one. */
export function pressedFocusable(press: LastPress | null, now: number, maxAgeMs = 1000): Element | null {
  if (!press || now - press.time > maxAgeMs || press.button !== 2) return null;
  return press.target?.closest?.("[tabindex],button,a[href],input,select,textarea") ?? null;
}

/**
 * Pure: the element to focus on closing a menu. The one captured at open time when it is still in the page; when the view re-rendered
 * meanwhile (the file list is rebuilt after a right-click) the connected element carrying the same label and role.
 */
export function liveReturnTarget(el: Element | null, all: () => Iterable<Element>): Element | null {
  if (!el) return null;
  if (el.isConnected) return el;
  const label = el.getAttribute("aria-label");
  if (!label) return null;
  for (const c of all()) if (c.getAttribute("aria-label") === label && c.getAttribute("role") === el.getAttribute("role")) return c;
  return null;
}
