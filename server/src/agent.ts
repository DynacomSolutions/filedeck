import path from "node:path";
import { Hono } from "hono";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { registerSizeRoutes } from "./props.ts";
import { FanWatch } from "./fanwatch.ts";
import { agentError, registerFileRoutes } from "./agent-routes.ts";
import * as trash from "./trash.ts";
import { agentAuth, agentUser } from "./agent-auth.ts";
import { sandboxInfo, sandboxSummary } from "./sandbox.ts";
import { audit, trustProxies, type AuditSink } from "./audit.ts";
import { requestGuard } from "./request-guard.ts";
import { readOnlyGuard, hitsReadOnly } from "./readonly.ts";
import { withReadOnly } from "./pinwalk.ts";
import type { Config } from "./config.ts";
import { makeResolver, type AccountResolver } from "./local-accounts.ts";
import { executable } from "./native.ts";
import { HostPam, hostPam } from "./host-pam.ts";
import { registerAgentAuthRoutes } from "./agent-auth-routes.ts";
import { KeyCheck } from "./agent-keys.ts";
import { MIN_VIRTUAL_ABI, WorkerPool, landlockForVirtual, type StartWorker } from "./worker-pool.ts";
import { GateAnswer, accountWorkers, makeWorkerSpecs, rootRequests, workerGate, type AccountWorkers, type WorkerSpecs } from "./agent-workers.ts";
import { Followers, registerOwnedJobRoutes, sizeAccess } from "./agent-jobs.ts";

export interface AgentOptions {
  /** the account lookup (sign-in on); default: `makeResolver` */
  accounts?: AccountResolver;
  /** how the pool starts a worker process; default: through the sandbox launcher */
  startWorker?: StartWorker;
  /** the system users' password check (sign-in on); default: `filedeck-pam` from the host helpers `makeResolver` found, else none */
  pam?: HostPam;
  /** the system users' key check (sign-in on); default: one over the host's account lookup when `makeResolver` found the host helpers, else none */
  keys?: KeyCheck;
}

/**
 * The agent's app. With sign-in on it also makes the account lookup (started here, awaited by the first request that needs it) and the
 * worker pool, and sends every request that is not one of the root process's own routes to the account's worker (agent-workers.ts).
 * Sign-in off: no lookup, no pool, no gate; every route runs here as before.
 */
export function createAgent(cfg: Config, auditSink?: AuditSink, opts: AgentOptions = {}) {
  const app = new Hono();
  let pool: WorkerPool | undefined;
  let accounts: AccountResolver | undefined;
  let specs: WorkerSpecs | undefined;
  let workers: AccountWorkers | undefined;
  let pam: Promise<HostPam | undefined> | undefined;
  let keys: Promise<KeyCheck | undefined> | undefined;
  if (cfg.auth) {
    const made = opts.accounts ? undefined : makeResolver(cfg, (s) => console.error(s));
    const found: Promise<AccountResolver> = opts.accounts ? Promise.resolve(opts.accounts) : made!.then((r) => r.resolver);
    found.catch(() => undefined); // (a failure is answered per request, as a failed lookup)
    // system sign-in: `filedeck-pam` beside the `filedeck-id` that answered; without it every password check answers `unavailable`
    // (an account lookup passed in, as tests do, comes without host helpers: no PAM, and nothing to log)
    pam = opts.pam
      ? Promise.resolve(opts.pam)
      : made
          ?.then(async (r) => {
            if (!r.helpers) throw new Error(r.reason ?? "no host helpers");
            if (!(await executable(path.join(r.helpers.dir, "filedeck-pam")))) throw new Error(`no filedeck-pam in ${r.helpers.dir}`);
            return hostPam(cfg, r.helpers);
          })
          .catch((e: unknown) => {
            console.error(`system sign-in: unavailable (${(e as Error)?.message ?? String(e)})`);
            return undefined;
          });
    // key sign-in: `authorized_keys` read as the user inside the machine's root; only with the host's own account lookup (the
    // /etc/passwd fallback refuses system sign-in), and not for an account lookup passed in without `opts.keys`
    keys = opts.keys ? Promise.resolve(opts.keys) : made?.then((r) => (r.helpers ? new KeyCheck({ root: r.helpers.root, accounts: r.resolver }) : undefined)).catch(() => undefined);
    accounts = { resolve: async (name, fresh) => (await found).resolve(name, fresh) };
    specs = makeWorkerSpecs(cfg, { live: () => pool?.list().map((w) => w.key) ?? [], uidInUse: (uid) => pool?.usesUid(uid) ?? false });
    const ws = specs;
    // (a worker's own requests to this process, such as its trash folder, are served over its connection only; once a worker has
    // stopped, its account's thumbnail cache is emptied)
    pool = new WorkerPool({ max: cfg.maxWorkers, idleMs: cfg.workerIdleMs, start: opts.startWorker, rootHandler: rootRequests(cfg), onStopped: (s) => ws.stopped(s), beforeStart: (s) => ws.emptied(s.account.uid) });
    // (one set of account rules, epochs included, for the gate and for the root routes that reach a worker)
    workers = accountWorkers({ pool, accounts, spec: specs.spec });
    void sandboxInfo().then((i) =>
      console.error(
        landlockForVirtual(i)
          ? `workers: virtual accounts are confined by Landlock ABI ${i.abi}`
          : `workers: virtual accounts are refused here (they need Landlock ABI ${MIN_VIRTUAL_ABI} or newer; this machine has ${i.state === "landlock" ? `ABI ${i.abi}` : "none usable"})`,
      ),
    );
  }
  app.use("*", trustProxies(cfg.trustedProxies));
  app.use("*", agentAuth(cfg.agentToken));
  app.use("*", agentUser(cfg, auditSink)); // with auth on: a valid signed user header, or 401
  app.use("*", requestGuard({ maxEdit: cfg.maxEdit, audit: { who: `agent:${cfg.node}`, sink: auditSink } }));
  app.use("*", audit(`agent:${cfg.node}`, auditSink));
  app.use("*", (_c, next) => withReadOnly(cfg.root, cfg.readOnly, next)); // the pinned operations re-check where their descriptors really point
  app.use("*", readOnlyGuard(cfg.root, cfg.readOnly));
  // sign-in on: from here on, only the root process's own routes are served in this process. The checks above still run as root first
  // (so `readOnlyGuard` answers for read-only volumes before the worker is asked; see workerGate).
  if (pool && accounts && specs) app.use("*", workerGate(cfg, { pool, accounts, spec: specs.spec, workers }));
  Object.assign(app, { pool, workerBase: specs?.base, workerSpecs: specs });
  const root = cfg.root;

  app.onError((e, c) => (e instanceof GateAnswer ? e.res : agentError(e, c))); // (a GateAnswer: the account rules refused, sign-in on)

  app.get("/healthz", (c) => c.text("ok"));
  if (cfg.auth && accounts) {
    const a = accounts;
    registerAgentAuthRoutes(app, { pam, keys, accounts: async () => a });
  }
  app.get("/api/info", async (c) => c.json({ node: cfg.node, root: cfg.root, watches: files.watches.size, readOnly: cfg.readOnly, sandbox: await sandboxSummary() }));
  // The jobs of this process (kept in the shared job file when there is one), the file routes, the folder sizes and the job list, all over the same jobs
  const jobs = makeAgentJobs(cfg);
  const files = registerFileRoutes(app, cfg, jobs);
  // sign-in on: sizes and jobs follow the account (agent-jobs.ts); off: as before
  const followers = pool && workers ? new Followers(jobs) : undefined;
  const sizes = registerSizeRoutes(app, cfg, jobs, pool && workers && followers ? sizeAccess(cfg, { pool, workers, jobs, followers }) : undefined);
  if (pool && workers && followers) registerOwnedJobRoutes(app, jobs, { pool, workers, followers });
  else registerJobRoutes(app, jobs);
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
      await Promise.all([jobs.interrupt(), pool?.close()]);
      await specs?.close(); // (no worker runs any more)
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
