/**
 * Wraps an async action so a second call made while the first is still running is ignored
 * (a double click on a button that starts a job must start one job). `busy` reports the state
 * so the button can show it.
 */
export function singleFlight<A extends unknown[]>(fn: (...a: A) => Promise<unknown>, busy: (b: boolean) => void = () => undefined): (...a: A) => Promise<void> {
  let running = false;
  return async (...a: A) => {
    if (running) return;
    running = true;
    busy(true);
    try {
      await fn(...a);
    } finally {
      running = false;
      busy(false);
    }
  };
}
