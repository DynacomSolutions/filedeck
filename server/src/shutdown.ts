import type { Server } from "node:http";

export interface ShutdownOptions {
  /** how long open requests may finish before their sockets are cut */
  drainMs?: number;
  /** absolute limit for the whole shutdown, whatever is still running */
  hardMs?: number;
  exit?: (code: number) => void;
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
    const drain = setTimeout(() => server.closeAllConnections(), drainMs);
    drain.unref();
    server.close(); // stops listening now; the close event fires once every socket is gone
    server.closeIdleConnections();
    const closed = new Promise<void>((r) => (server.listening ? server.once("close", () => r()) : r()));
    void Promise.allSettled([Promise.resolve().then(cleanup), closed]).then(() => exit(0));
  };
}
