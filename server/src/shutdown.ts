import type { Server } from "node:http";

export interface ShutdownOptions {
  /** how long open requests may finish before their sockets are cut */
  drainMs?: number;
  /** absolute limit for the whole shutdown, whatever is still running */
  hardMs?: number;
  exit?: (code: number) => void;
  /** runs at the very start of the shutdown, beside the drain: work the next process waits for (releasing a lease) must not queue behind open connections */
  onSignal?: () => Promise<void> | void;
}

/**
 * Graceful stop that always ends. `server.close()` alone waits for every open connection, and SSE feeds, long
 * downloads and keep-alive sockets can stay open forever; the pod then sits in Terminating. So: stop accepting,
 * drop idle sockets, cut the rest after `drainMs`, and exit at `hardMs` even if cleanup itself hangs.
 * A second signal exits at once.
 */
export function installShutdown(server: Server, cleanup: () => Promise<void> | void, o: ShutdownOptions = {}) {
  const { drainMs = 5_000, hardMs = 15_000, exit = (c: number) => process.exit(c) } = o;
  let started = false;
  return (): void => {
    if (started) return exit(1);
    started = true;
    setTimeout(() => exit(1), hardMs).unref();
    void Promise.resolve(o.onSignal?.()).catch(() => undefined);
    const drain = setTimeout(() => server.closeAllConnections(), drainMs);
    drain.unref();
    // Registered before close(): the callback fires only when the last socket is gone, not when listening stops.
    const drained = new Promise<void>((r) => server.close(() => r()));
    server.closeIdleConnections();
    void drained.then(() => clearTimeout(drain));
    // Cleanup (database handles, source backends) runs only after in-flight requests are done or cut.
    void drained.then(() => cleanup()).catch(() => undefined).then(() => exit(0));
  };
}
