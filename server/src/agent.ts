import { Hono } from "hono";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { registerSizeRoutes } from "./props.ts";
import { FanWatch } from "./fanwatch.ts";
import { agentError, registerFileRoutes } from "./agent-routes.ts";
import * as trash from "./trash.ts";
import { agentAuth, agentUser } from "./agent-auth.ts";
import { sandboxSummary } from "./sandbox.ts";
import { audit, trustProxies, type AuditSink } from "./audit.ts";
import { requestGuard } from "./request-guard.ts";
import { readOnlyGuard, hitsReadOnly } from "./readonly.ts";
import { withReadOnly } from "./pinwalk.ts";
import type { Config } from "./config.ts";

export function createAgent(cfg: Config, auditSink?: AuditSink) {
  const app = new Hono();
  app.use("*", trustProxies(cfg.trustedProxies));
  app.use("*", agentAuth(cfg.agentToken));
  app.use("*", agentUser(cfg, auditSink)); // with auth on: a valid signed user header, or 401
  app.use("*", requestGuard({ maxEdit: cfg.maxEdit, audit: { who: `agent:${cfg.node}`, sink: auditSink } }));
  app.use("*", audit(`agent:${cfg.node}`, auditSink));
  app.use("*", (_c, next) => withReadOnly(cfg.root, cfg.readOnly, next)); // the pinned operations re-check where their descriptors really point
  app.use("*", readOnlyGuard(cfg.root, cfg.readOnly));
  const root = cfg.root;

  app.onError(agentError);

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/info", async (c) => c.json({ node: cfg.node, root: cfg.root, watches: files.watches.size, readOnly: cfg.readOnly, sandbox: await sandboxSummary() }));
  // The jobs of this process (kept in the shared job file when there is one), the file routes, the folder sizes and the job list, all over the same jobs
  const jobs = makeAgentJobs(cfg);
  const files = registerFileRoutes(app, cfg, jobs);
  const sizes = registerSizeRoutes(app, cfg, jobs);
  registerJobRoutes(app, jobs);
  // Prometheus text for the size store (outside /api and exempt from the agent token, like /healthz: only these two 0/1 gauges may ever be served here): 1 when it answers from its file, and whether its file is damaged beyond repair (an operator must move it aside)
  app.get("/metrics", (c) => {
    const h = sizes.health();
    return c.text(
      [
        "# HELP filedeck_size_store_available 1 when the folder-size store answers from its file, 0 when sizes are not cached",
        "# TYPE filedeck_size_store_available gauge",
        `filedeck_size_store_available ${h.available ? 1 : 0}`,
        "# HELP filedeck_size_store_damaged 1 when the store file is damaged and cannot be repaired by the agent",
        "# TYPE filedeck_size_store_damaged gauge",
        `filedeck_size_store_damaged ${h.damaged ? 1 : 0}`,
        "",
      ].join("\n"),
      200,
      { "content-type": "text/plain; version=0.0.4" },
    );
  });
  const fan = new FanWatch(sizes, { helper: cfg.fanwatch, root, procMounts: cfg.procMounts, handoverMs: cfg.handoverMs });
  sizes.covers = (v) => fan.covers(v);
  sizes.watchedSince = () => fan.watchedSince();
  sizes.quiet = (v) => fan.settled(v);
  sizes.chainMin = () => fan.chainMin();
  // main.ts starts the watcher once the server listens: its backlog work must never delay the port
  (app as unknown as { startWatcher: () => void }).startWatcher = () => void fan.start();
  // On SIGTERM, at once (not after the connections drain): stop the jobs (their rows are handed to the next process), hand the watcher's events and watched time
  // to the store, and release the size store's writer lease, so the next process can write while this one is still answering its last requests.
  let leaving: Promise<void> | undefined;
  const leave = () =>
    (leaving ??= (async () => {
      await jobs.interrupt();
      await fan.handover();
      await sizes.releaseLease();
    })());
  (app as unknown as { leave: () => Promise<void> }).leave = leave;

  // Trash retention: every volume's trash loses what is older than the age limit, then its oldest items while it is over its cap. A minute after start,
  // then on a timer; one sweep at a time.
  let sweeping = false;
  const sweepTrash = async () => {
    if (sweeping || leaving) return;
    sweeping = true;
    try {
      const policy = { maxAgeDays: cfg.trashMaxAgeDays, maxPercent: cfg.trashMaxPercent, maxBytes: cfg.trashMaxBytes, blocked: (v: string) => hitsReadOnly(root, cfg.readOnly, v) }; // only a read-only volume: its trash folder sits at its top, never in a read-only folder below it (each removal checks that too)
      // (outside a request: the pinned removals check read-only prefixes in a scope of their own, like a job)
      for (const r of await withReadOnly(root, cfg.readOnly, () => trash.applyRetention(root, cfg.procMounts, policy))) console.error(JSON.stringify({ trashRetention: r.volume, removed: r.removed, freedBytes: r.freed, failed: r.failed }));
    } catch (e) {
      console.error(JSON.stringify({ trashRetention: "failed", error: String((e as Error)?.message ?? e) }));
    } finally {
      sweeping = false;
    }
  };
  const retentionOn = cfg.trashSweepMs > 0 && (cfg.trashMaxAgeDays > 0 || cfg.trashMaxPercent > 0 || cfg.trashMaxBytes > 0);
  const firstSweep = retentionOn ? setTimeout(() => void sweepTrash(), Math.min(60_000, cfg.trashSweepMs)).unref() : undefined;
  const sweepTimer = retentionOn ? setInterval(() => void sweepTrash(), cfg.trashSweepMs).unref() : undefined;
  (app as unknown as { sweepTrash: () => Promise<void> }).sweepTrash = sweepTrash;

  (app as unknown as { close: () => Promise<void> }).close = async () => {
    clearTimeout(firstSweep);
    clearInterval(sweepTimer);
    await leave();
    files.close();
    sizes.close();
  };

  return app;
}
