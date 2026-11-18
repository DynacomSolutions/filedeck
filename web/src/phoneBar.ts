// Phone selection bar sizing: how many actions fit between the menu and Jobs buttons.

/** Width of one phone action button, in px: the minimum touch target. Keep in step with `.selbar-actions button` in the phone rules of styles.css. */
export const PHONE_BTN = 44;
/** Most room the selection count takes on a phone, in px. */
export const PHONE_COUNT_MAX = 88;
/**
 * How many of the primary actions a phone bar shows. Clear and More always show; the count keeps its text (up to `PHONE_COUNT_MAX`);
 * every whole button that still fits is a primary action, and the rest go into the More menu.
 */
export function phoneActionsFit(barWidth: number, countWidth: number, total: number): number {
  const room = barWidth - Math.min(countWidth, PHONE_COUNT_MAX);
  return Math.max(0, Math.min(total, Math.floor(room / PHONE_BTN) - 2));
}
