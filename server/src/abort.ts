/**
 * Runs `fn` once when `signal` aborts, or at once when it has aborted already (an abort listener added then never fires). Gives a
 * function that removes the listener. Without a signal it does nothing.
 */
export function whenAborted(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}
