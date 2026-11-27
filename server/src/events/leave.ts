/**
 * The steps of a stop on SIGTERM, with a limit. The slow steps (the jobs, the worker pool, the watcher's hand-over, the socket) share `boundMs`; when they
 * are not done by then, the journal is closed anyway, because the hard exit of the process comes soon after and the journal must be written (and marked
 * clean) before it. A step that fails is logged and does not stop the close.
 *
 * A step that is still running at the bound is not stopped: it goes on beside the release of the lease that follows. It must not change the journal then.
 * That holds because `closeJournal` closes the bus, and a closed bus drops every event that is published to it (it writes nothing and tells nobody). The
 * close starts in the same turn as the bound, before anything else can run, so there is no gap between the bound and the close.
 */
export async function leaveBounded(steps: () => Promise<void>, closeJournal: () => Promise<void>, boundMs: number, log?: (s: string) => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= closeJournal());
  const limit = new Promise<void>((res) => {
    timer = setTimeout(() => {
      log?.(`stop: the first steps took more than ${boundMs} ms; the event journal is closed now`);
      void close().catch(() => {}); // (at once, in this turn: a late step publishes into a closed bus from here on; the result is awaited below)
      res();
    }, boundMs);
    timer.unref();
  });
  try {
    await Promise.race([steps().catch((e: unknown) => log?.(`stop: a step failed (${(e as Error)?.message ?? e})`)), limit]);
  } finally {
    clearTimeout(timer);
  }
  await close();
}
