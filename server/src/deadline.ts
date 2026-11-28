/**
 * One one-shot timer for the nearest deadline of a set of pending items. It exists only while a deadline is set: nothing is pending, no timer.
 * `arm` keeps the earlier of the old and the new time; `set` replaces it (or clears it with `undefined`). The timer never keeps the process alive.
 */
export class Deadline {
  private timer?: ReturnType<typeof setTimeout>;
  private at = Infinity;

  constructor(private readonly fire: () => void) {}

  /** The time (ms since the epoch) the timer is set for, or `undefined` when none is armed. */
  get due(): number | undefined {
    return this.timer ? this.at : undefined;
  }

  /** Set the timer for `atMs`, unless an earlier time is already set. */
  arm(atMs: number) {
    if (this.timer && atMs >= this.at) return;
    this.set(atMs);
  }

  /** Replace the deadline. `undefined` (or a time that is not a number) means that nothing is pending any more. */
  set(atMs: number | undefined) {
    this.clear();
    if (atMs === undefined || !Number.isFinite(atMs)) return;
    this.at = atMs;
    this.start();
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.at = Infinity;
  }

  private start() {
    // a timer cannot wait longer than 2^31-1 ms: a later deadline waits in steps, and the callback runs only at the deadline
    const wait = Math.min(Math.max(0, this.at - Date.now()), 2_147_483_647);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() < this.at - 5) return this.start();
      this.at = Infinity;
      this.fire();
    }, wait);
    this.timer.unref();
  }
}
