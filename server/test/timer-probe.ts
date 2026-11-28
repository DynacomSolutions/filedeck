/**
 * Counts the timers that are alive: every `setInterval` that was not cleared, and every `setTimeout` that has not fired or been cleared.
 * A test uses it to show that an idle part of FileDeck holds no timer.
 */
export function trackTimers() {
  const live = new Set<unknown>();
  const orig = { si: globalThis.setInterval, ci: globalThis.clearInterval, st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    const t = orig.si(fn, ms, ...a);
    live.add(t);
    return t;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((t: unknown) => {
    live.delete(t);
    orig.ci(t as never);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    const t: unknown = orig.st(() => {
      live.delete(t);
      fn(...a);
    }, ms);
    live.add(t);
    return t;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((t: unknown) => {
    live.delete(t);
    orig.ct(t as never);
  }) as typeof clearTimeout;
  return {
    active: () => live.size,
    restore() {
      globalThis.setInterval = orig.si;
      globalThis.clearInterval = orig.ci;
      globalThis.setTimeout = orig.st;
      globalThis.clearTimeout = orig.ct;
    },
  };
}
