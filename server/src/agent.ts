import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { makeAgentJobs, registerJobRoutes } from "./archive-routes.ts";
import { AgentGroupReader } from "./group-agent.ts";
import { registerSizeRoutes } from "./props.ts";
import { FanWatch, type SizeWriteStats } from "./fanwatch.ts";
import { MacWatch } from "./macwatch.ts";
import { agentError, registerFileRoutes } from "./agent-routes.ts";
import * as trash from "./trash.ts";
import { agentAuth, agentUser } from "./agent-auth.ts";
import { sandboxInfo, sandboxSummary } from "./sandbox.ts";
import { audit, trustProxies, type AuditSink } from "./audit.ts";
import { requestGuard } from "./request-guard.ts";
import { readOnlyGuard, hitsReadOnly } from "./readonly.ts";
import { withReadOnly } from "./pinwalk.ts";
import type { Config } from "./config.ts";
import { makeResolver, signInAccount, SignInLookups, type AccountResolver } from "./local-accounts.ts";
import { executable } from "./native.ts";
import { HostPam, hostPam } from "./host-pam.ts";
import { registerAgentAuthRoutes } from "./agent-auth-routes.ts";
import { KeyCheck } from "./agent-keys.ts";
import { MIN_VIRTUAL_ABI, WorkerPool, landlockForVirtual, type StartWorker } from "./worker-pool.ts";
import { GateAnswer, accountWorkers, makeWorkerSpecs, rootRequests, workerGate, type AccountWorkers, type WorkerSpecs } from "./agent-workers.ts";
import { Followers, registerOwnedJobRoutes, sizeAccess } from "./agent-jobs.ts";
import { registerNodeStatus, StatusEventBus } from "./node-status.ts";
import { DirWatchers } from "./events/dirwatch.ts";
import { LabelRules } from "./events/labels.ts";
import { ownState } from "./events/own-state.ts";
import { eventMetrics } from "./events/metrics.ts";
import { leaveBounded } from "./events/leave.ts";
import { registerChangeRoutes } from "./events/routes.ts";
import { startEventSocket, type EventSocket } from "./events/socket.ts";
import type { FeedRef } from "./diff-routes.ts";
import { PressureCollector } from "./pressure/collector.ts";
import { iotracePath } from "./pressure/helper.ts";
import { pressureMetricLines, registerPressureRoutes } from "./pressure/routes.ts";

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
  let signInLookups: SignInLookups | undefined;
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
    accounts = { resolve: async (name, fresh) => (await found).resolve(name, fresh), forSignIn: async (name) => signInAccount(await found, name) };
    // the sign-in routes' lookups run before anyone is signed in: at most 4 at once (the key check's too)
    signInLookups = new SignInLookups(accounts);
    const lookups = signInLookups;
    keys = opts.keys ? Promise.resolve(opts.keys) : made?.then((r) => (r.helpers ? new KeyCheck({ root: r.helpers.root, accounts: lookups }) : undefined)).catch(() => undefined);
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
  if (cfg.auth && signInLookups) {
    const a = signInLookups;
    registerAgentAuthRoutes(app, { pam, keys, accounts: async () => a });
  }
  app.get("/api/info", async (c) => c.json({ node: cfg.node, root: cfg.root, watches: files.watches.size, readOnly: cfg.readOnly, sandbox: await sandboxSummary() }));
  // The jobs of this process (kept in the shared job file when there is one), the file routes, the folder sizes and the job list, all over the same jobs
  const jobs = makeAgentJobs(cfg);
  Object.assign(app, { jobs }); // (tests read a job's owner through it)
  const feedRef: FeedRef = {}; // set below, once the watcher exists
  const files = registerFileRoutes(app, cfg, jobs, feedRef);
  // sign-in on: sizes and jobs follow the account (agent-jobs.ts); off: as before
  const followers = pool && workers ? new Followers(jobs) : undefined;
  const sizes = registerSizeRoutes(app, cfg, jobs, pool && workers && followers ? sizeAccess(cfg, { pool, workers, jobs, followers }) : undefined);
  const storageGroups = new AgentGroupReader(cfg, cfg.groups, (p) => sizes.groupSize(p));
  app.get("/api/groups", async (c) => {
    if (cfg.auth && c.get("user")?.storageGroups !== true) return c.json({ error: "administrators only" }, 403);
    try {
      return c.json(await storageGroups.read(), 200, { "cache-control": "no-store" });
    } catch {
      return c.json({ error: "storage groups unavailable" }, 503);
    }
  });
  if (pool && workers && followers) registerOwnedJobRoutes(app, jobs, { pool, workers, followers });
  else registerJobRoutes(app, jobs);
  // The event bus (events/bus.ts): every change the watcher sees goes through it to the journal, the subscribers and the folder feed of the compare index and
  // the live change feed. The journal lives next to the other agent state (the index folder), else in a temporary folder that goes with the process.
  let labels = new LabelRules();
  try {
    labels = new LabelRules(cfg.eventsLabels);
  } catch (e) {
    console.error(`FILEDECK_EVENTS_LABELS ignored: ${(e as Error).message}`);
  }
  const ownJournalDir = cfg.eventsJournalBytes > 0 && cfg.eventsJournalHours > 0 && !cfg.indexDir;
  const journalDir = cfg.eventsJournalBytes > 0 && cfg.eventsJournalHours > 0 ? (cfg.indexDir ? path.join(cfg.indexDir, `changes-${cfg.node}`) : path.join(os.tmpdir(), `filedeck-changes-${cfg.node}-${process.pid}-${randomUUID()}`)) : null;
  const bus = new StatusEventBus({
    node: cfg.node,
    labels,
    journal: { dir: journalDir, maxBytes: cfg.eventsJournalBytes || undefined, maxAgeMs: cfg.eventsJournalHours * 3600_000 || undefined },
    writer: () => sizes.mayWrite,
    disk: () => sizes.isWriter, // (no usable store, no lease: the journal stays in memory, so two processes never write one folder)
    log: (s) => console.error(s),
  });
  registerChangeRoutes(app, bus);
  Object.assign(app, { events: bus }); // (tests publish to it and read its counters)
  // Live disk pressure (docs/disk-pressure.md): off unless FILEDECK_PRESSURE is on; it samples only while a stream, a request or the metrics scrape asks
  const pressure = cfg.pressure && process.platform === "linux"
    ? new PressureCollector({
        node: cfg.node, intervalMs: cfg.pressureIntervalMs, hostRoot: cfg.root, cgroupRoot: cfg.pressureCgroupRoot, procRoot: cfg.pressureProcRoot,
        labels: cfg.pressureLabels, pathDepth: cfg.pressurePathDepth, iotrace: iotracePath(cfg.pressureIotrace), bus, log: (s) => console.error(s),
      })
    : undefined;
  if (pressure) registerPressureRoutes(app, pressure);
  Object.assign(app, { pressure });
  const fan = process.platform === "darwin"
    ? new MacWatch(sizes, { root, procMounts: cfg.procMounts, bus })
    : new FanWatch(sizes, { helper: cfg.fanwatch, root, procMounts: cfg.procMounts, handoverMs: cfg.handoverMs, commitMs: cfg.sizeCommitMs, exclude: cfg.sizeExclude, dirtyMax: cfg.sizeDirtyMax, bus, ignorePath: ownState({ node: cfg.node, root, journalDir, stateDir: cfg.indexDir, tmpDir: os.tmpdir() }) });
  registerNodeStatus(app, cfg, sizes, fan, bus);
  const dirs = new DirWatchers(bus, (v) => fan.covers(v));
  feedRef.feed = dirs;
  sizes.covers = (v) => fan.covers(v);
  sizes.watchedSince = () => fan.watchedSince();
  sizes.quiet = (v) => fan.settled(v);
  sizes.chainMin = () => fan.chainMin();
  sizes.onReopen = () => fan.storeReplaced();
  // Prometheus text for the size store (outside /api and exempt from the agent token, like /healthz: only counts and ages may ever be served here, nothing that names a path, a node or a size): whether the size store answers from its file, whether its file is damaged and not yet replaced, the queued jobs and the oldest wait
  app.get("/metrics", (c) => {
    const h = sizes.health();
    const q = jobs.queuedStats();
    const w = fan.status();
    const sw = (w as { size?: SizeWriteStats }).size ?? { commits: 0, dirtyPaths: 0, lastDirtyPaths: 0, excludedEvents: 0, collapsed: 0, commitSeconds: 0 };
    return c.text(
      [
        "# HELP filedeck_size_store_available 1 when the folder-size store answers from its file, 0 when sizes are not cached",
        "# TYPE filedeck_size_store_available gauge",
        `filedeck_size_store_available ${h.available ? 1 : 0}`,
        "# HELP filedeck_size_store_damaged 1 when the store file is damaged and the agent has not yet replaced it with a new one",
        "# TYPE filedeck_size_store_damaged gauge",
        `filedeck_size_store_damaged ${h.damaged ? 1 : 0}`,
        "# HELP filedeck_jobs_queued Jobs of this process that wait to run",
        "# TYPE filedeck_jobs_queued gauge",
        `filedeck_jobs_queued ${q.count}`,
        "# HELP filedeck_jobs_oldest_queued_seconds Age in seconds of the oldest queued job of this process, 0 when none",
        "# TYPE filedeck_jobs_oldest_queued_seconds gauge",
        `filedeck_jobs_oldest_queued_seconds ${q.oldestSeconds.toFixed(3)}`,
        "# HELP filedeck_size_lock_oldest_wait_seconds Age in seconds of the oldest size-store lock that waits and is not yet granted, 0 when none",
        "# TYPE filedeck_size_lock_oldest_wait_seconds gauge",
        `filedeck_size_lock_oldest_wait_seconds ${sizes.oldestLockWaitSeconds().toFixed(3)}`,
        "# HELP filedeck_watcher_running 1 when the native watcher is running",
        "# TYPE filedeck_watcher_running gauge",
        `filedeck_watcher_running ${w.running ? 1 : 0}`,
        "# HELP filedeck_watcher_ready 1 when all current watcher marks are installed",
        "# TYPE filedeck_watcher_ready gauge",
        `filedeck_watcher_ready ${w.ready ? 1 : 0}`,
        "# HELP filedeck_watcher_mounts_total Current non-pseudo mounts visible to the agent",
        "# TYPE filedeck_watcher_mounts_total gauge",
        `filedeck_watcher_mounts_total ${w.mounts}`,
        "# HELP filedeck_watcher_mounts_watched Current mounts with native event coverage",
        "# TYPE filedeck_watcher_mounts_watched gauge",
        `filedeck_watcher_mounts_watched ${w.watched}`,
        "# HELP filedeck_watcher_mounts_covered Current local mount paths covered by native events, including parent-filesystem coverage",
        "# TYPE filedeck_watcher_mounts_covered gauge",
        `filedeck_watcher_mounts_covered ${w.covered}`,
        "# HELP filedeck_watcher_mounts_unsupported Current local mount paths without a direct helper mark, such as file bind mounts",
        "# TYPE filedeck_watcher_mounts_unsupported gauge",
        `filedeck_watcher_mounts_unsupported ${w.unsupported}`,
        "# HELP filedeck_watcher_mount_aliases Current extra local mount paths sharing a device and filesystem identity",
        "# TYPE filedeck_watcher_mount_aliases gauge",
        `filedeck_watcher_mount_aliases ${w.aliases}`,
        "# HELP filedeck_watcher_mounts_unwatched Current mounts without native event coverage",
        "# TYPE filedeck_watcher_mounts_unwatched gauge",
        `filedeck_watcher_mounts_unwatched ${w.unwatched}`,
        "# HELP filedeck_watcher_mounts_excluded Current virtual or hidden mount-table entries excluded from file metadata coverage",
        "# TYPE filedeck_watcher_mounts_excluded gauge",
        `filedeck_watcher_mounts_excluded ${w.excluded}`,
        "# HELP filedeck_watcher_backlog Folders waiting for durable or in-memory reconciliation",
        "# TYPE filedeck_watcher_backlog gauge",
        `filedeck_watcher_backlog ${w.backlog}`,
        "# HELP filedeck_watcher_lost_events_total Native events lost to overflow",
        "# TYPE filedeck_watcher_lost_events_total counter",
        `filedeck_watcher_lost_events_total ${w.lostEvents}`,
        "# HELP filedeck_size_commits_total Size store commit rounds: one per interval (FILEDECK_SIZE_COMMIT_MS) with changed folders",
        "# TYPE filedeck_size_commits_total counter",
        `filedeck_size_commits_total ${sw.commits}`,
        "# HELP filedeck_size_commit_dirty_paths_total Changed folders handed to the size store, summed over all commit rounds",
        "# TYPE filedeck_size_commit_dirty_paths_total counter",
        `filedeck_size_commit_dirty_paths_total ${sw.dirtyPaths}`,
        "# HELP filedeck_size_commit_dirty_paths_last Changed folders of the latest commit round",
        "# TYPE filedeck_size_commit_dirty_paths_last gauge",
        `filedeck_size_commit_dirty_paths_last ${sw.lastDirtyPaths}`,
        "# HELP filedeck_size_commit_collapsed_total Subtrees whose changed folders were merged into one stale mark because the interval held too many",
        "# TYPE filedeck_size_commit_collapsed_total counter",
        `filedeck_size_commit_collapsed_total ${sw.collapsed}`,
        "# HELP filedeck_size_excluded_events_total Change events kept away from the size store by FILEDECK_SIZE_EXCLUDE (the event stream still has them)",
        "# TYPE filedeck_size_excluded_events_total counter",
        `filedeck_size_excluded_events_total ${sw.excludedEvents}`,
        "# HELP filedeck_size_commit_duration_seconds Time the commit rounds took to write and re-read the changed folders",
        "# TYPE filedeck_size_commit_duration_seconds summary",
        `filedeck_size_commit_duration_seconds_sum ${sw.commitSeconds.toFixed(3)}`,
        `filedeck_size_commit_duration_seconds_count ${sw.commits}`,
        "# HELP filedeck_size_store_write_transactions_total Write transactions sent to the size store writer",
        "# TYPE filedeck_size_store_write_transactions_total counter",
        `filedeck_size_store_write_transactions_total ${sizes.writeTransactions}`,
        ...storageGroups.metrics.lines(),
        ...eventMetrics(bus, (w as { helper?: Record<string, number> }).helper, (w as { caps?: string }).caps),
        ...(pressure ? pressureMetricLines(pressure) : []),
        "",
      ].join("\n"),
      200,
      { "content-type": "text/plain; version=0.0.4" },
    );
  });
  // main.ts starts the watcher once the server listens: its backlog work must never delay the port
  let socket: EventSocket | undefined;
  (app as unknown as { startWatcher: () => void }).startWatcher = () => {
    void fan.start();
    // the node-local socket for other services on this machine (off unless FILEDECK_EVENTS_SOCKET is set)
    if (cfg.eventsSocket && !socket)
      void startEventSocket(bus, { path: cfg.eventsSocket, group: cfg.eventsSocketGroup || undefined, log: (s) => console.error(s) }).then(
        (s) => (socket = s),
        (e: Error) => console.error(`event socket ${cfg.eventsSocket} not started: ${e.message}`),
      );
  };
  // On SIGTERM, at once (not after the connections drain): stop the jobs (their rows are handed to the next process), hand the watcher's events and watched time
  // to the store, and release the size store's writer lease, so the next process can write while this one is still answering its last requests.
  let leaving: Promise<void> | undefined;
  const leave = () =>
    (leaving ??= (async () => {
      // The slow steps have a limit, then the journal is closed whatever happened: it writes what is pending and the time the watching ended (the next
      // writer's coverage check reads it), and it must do that before the hard exit of the process. The bus is closed here once, and only here.
      await leaveBounded(
        async () => {
          await Promise.all([jobs.interrupt(), pool?.close()]);
          await specs?.close(); // (no worker runs any more)
          await fan.handover();
          await socket?.close();
        },
        () => bus.close(ownJournalDir),
        cfg.leaveStepsMs,
        (s) => console.error(s),
      );
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
    pressure?.close();
    await leave();
    files.close();
    dirs.close();
    sizes.close(); // (the bus was closed by leave(), once: a second close would write the journal's `meta.json` after the next process took the lease)
  };

  return app;
}
