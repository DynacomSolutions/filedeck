import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { ProxyList } from "./auth/tailnet.ts";
import { parseBrand, type Brand } from "./brand.ts";
import { parseReadOnly } from "./readonly.ts";
import { parseSources } from "./sources/registry.ts";
import type { SourceConfig } from "./sources/types.ts";

export interface Config {
  mode: "agent" | "hub";
  port: number;
  root: string;
  node: string;
  procMounts: string;
  maxUpload: number;
  /** Largest text file the editor will open or save (bytes) */
  maxEdit: number;
  staticDir: string;
  /** archive extraction/compression caps and background-job concurrency */
  archiveMaxEntries: number;
  archiveMaxBytes: number;
  jobConcurrency: number;
  /** folder diff: agent-side concurrent hash streams and walk entry ceiling */
  hashConcurrency: number;
  walkMaxEntries: number;
  /** compare index: SQLite directory (empty = in memory), inotify watch budget, concurrent directory listings; hub: session spill dir */
  indexDir: string;
  indexWatches: number;
  /** agent: SQLite file that keeps background jobs visible across a restart or rollout (empty = in memory) */
  jobsFile: string;
  /** compare index: trust an unwatched listing with an unchanged directory mtime for this long */
  indexRevalidateMs: number;
  /** trash retention (agent): items deleted longer ago than this are purged (0 = never by age) */
  trashMaxAgeDays: number;
  /** per-volume trash cap: past it the oldest items are purged; percent of the volume's size and bytes (0 = no cap; with both set the smaller wins) */
  trashMaxPercent: number;
  trashMaxBytes: number;
  /** how often the agent applies the retention (0 = never) */
  trashSweepMs: number;
  /** fanotify helper binary that keeps folder sizes current; empty = off */
  fanwatch: string;
  /** `GET /api/du` answers 202 with a job id when its scan takes longer than this */
  duWaitMs: number;
  /** a CLI du job nobody waits on or polls for this long is dropped (0 = never) */
  duAbandonMs: number;
  /** on SIGTERM, how long the change watcher keeps running for a newer process to take over its watched time (ms) */
  handoverMs: number;
  listConcurrency: number;
  diffDir: string;
  /** search: concurrent searches per agent, per-file and total content bytes read */
  searchConcurrency: number;
  /** reverse proxies in front of this process whose X-Forwarded-For is believed (0 = none) */
  trustedProxies: number;
  searchMaxFileBytes: number;
  searchMaxBytes: number;
  /** thumbnails: cache dir (outside user data), cache ceiling in bytes, concurrent ffmpeg runs, binary */
  thumbDir: string;
  thumbCacheMax: number;
  thumbConcurrency: number;
  ffmpeg: string;
  /** concurrent on-the-fly media transcodes per agent */
  transcodeConcurrency: number;
  /** hub: name, logos, header links and theme key shown in the page */
  brand: Brand;
  /** agent: virtual path prefixes that are read-only */
  readOnly: string[];
  /** shared hub-to-agent secret; empty = agents are unauthenticated (NetworkPolicy only) */
  agentToken: string | undefined;
  /** Host header values the hub answers to (host or host:port); empty = any */
  allowedHosts: string[];
  /** hub: read-only token for the `filedeck du` CLI (FILEDECK_API_TOKEN or the file FILEDECK_API_TOKEN_FILE); unset = off */
  apiToken: string | undefined;
  /** hub: name -> agent base URL */
  nodes: { name: string; url: string }[];
  /** hub, sign-in on: the nodes asked for a system sign-in, in order (FILEDECK_AUTH_NODES); empty = the order of `nodes` */
  authNodes: string[];
  /** hub: network sources (SFTP, ...) declared in the chart values; credentials live in mounted Secrets */
  sources: SourceConfig[];
  sourceSecretDir: string;
  /** hub: saved-password vault. Without `vaultKey` it lives in memory only. */
  vaultFile: string;
  vaultKey: string | undefined;
  vaultTtlMs: number;
  vaultMaxMs: number;
  /** sign-in: off = every request is open, as before */
  auth: boolean;
  /** system account names that are administrators */
  admins: string[];
  /** hub: file that holds the first administrator's password for a first start; unset = none */
  bootstrapAdminFile: string | undefined;
  /** hub: SQLite file for accounts (`:memory:` when no vault volume is configured) */
  authFile: string;
  /** hub: job notifications by Web Push (FILEDECK_PUSH, on unless "off") */
  push: boolean;
  /** hub: SQLite file for the push key pair and subscriptions (`:memory:` when no vault volume is configured) */
  pushFile: string;
  /** hub: the VAPID contact the push services see (FILEDECK_PUSH_SUBJECT, a mailto: or https: URL) */
  pushSubject: string;
  /** hub: push service hosts allowed besides the browsers' own (FILEDECK_PUSH_HOSTS) */
  pushHosts: string[];
  sessionIdleMs: number;
  sessionMaxMs: number;
  /** hub: account the `filedeck du` API token acts as; unset = none */
  apiTokenAccount: string | undefined;
  /** agent, sign-in on: folder that holds the host helpers (`filedeck-id`); unset = the image's folder, else the built one (host-helpers.ts) */
  hostHelpers: string | undefined;
  /** agent, sign-in on: the PAM service `filedeck-pam` uses for system users' passwords (FILEDECK_PAM_SERVICE: /etc/pam.d/<name> on the machine) */
  pamService: string;
  /** this process is a worker that serves one signed-in account (worker.ts); never set from the environment */
  worker: boolean;
  /** agent, sign-in on: most worker processes at once; past it the least recently used idle one is stopped */
  maxWorkers: number;
  /** agent, sign-in on: a worker with nothing to do for this long is stopped */
  workerIdleMs: number;
  /** hub, sign-in on: path of tailscaled's LocalAPI socket (FILEDECK_TAILSCALE_SOCKET); turns the socket source on. Never logged. */
  tailscaleSocket: string | undefined;
  /** hub, sign-in on: FILEDECK_TAILSCALE_HEADERS=on turns the Tailscale Serve headers source on (ignored when the socket is set) */
  tailscaleHeaders: boolean;
  /** hub, sign-in on: IP addresses and CIDR ranges of the proxies that carry only tailnet traffic (FILEDECK_TAILSCALE_PROXIES) */
  tailscaleProxies: string[];
  /**
   * hub, sign-in on: FILEDECK_TAILSCALE_LISTEN, the address and port of the identity listener. When set, a tailnet identity is read only
   * on connections this listener accepted (still from a listed proxy); the ordinary listener never gives one.
   */
  tailscaleListen?: { host: string; port: number };
}

/** NODES="node-a=http://filedeck-agent-node-a:8080,node-b=http://..." */
export function parseNodes(s: string | undefined) {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("=");
      if (i < 1) throw new Error(`bad NODES entry: ${x}`);
      return { name: x.slice(0, i), url: x.slice(i + 1).replace(/\/$/, "") };
    });
}

/** A secret from `<name>` or the contents of the file named by `<name>_FILE` (a mounted Secret). Never logged. */
function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Mount table of the host. /proc/mounts is /proc/self/mounts, so under a host root mounted in a container it would be the
 * container's own table; PID 1 of the host's mount namespace is what we want.
 */
export function defaultProcMounts(root: string): string {
  return root === "/" ? "/proc/mounts" : `${root}/proc/1/mounts`;
}

/** A setting that must be a whole number of at least 1: unset or empty gives `fallback`, anything else is refused at start-up. */
function wholeSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  if (!/^[0-9]+$/.test(v) || Number(v) < 1) throw new Error(`${name} must be a whole number of at least 1, not "${v.slice(0, 40)}"`);
  return Number(v);
}

/** The Tailscale settings: read only by a hub with sign-in on; a bad proxy entry or listen address stops the start. */
function tailscaleSettings(env: NodeJS.ProcessEnv, read: boolean, port: number): Pick<Config, "tailscaleSocket" | "tailscaleHeaders" | "tailscaleProxies" | "tailscaleListen"> {
  if (!read) return { tailscaleSocket: undefined, tailscaleHeaders: false, tailscaleProxies: [] };
  const tailscaleProxies = (env.FILEDECK_TAILSCALE_PROXIES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  new ProxyList(tailscaleProxies); // throws `FILEDECK_TAILSCALE_PROXIES: "<entry>" is not an IP address or range`
  const tailscaleListen = listenSetting(env.FILEDECK_TAILSCALE_LISTEN, port);
  return { tailscaleSocket: env.FILEDECK_TAILSCALE_SOCKET || undefined, tailscaleHeaders: env.FILEDECK_TAILSCALE_HEADERS === "on", tailscaleProxies, ...(tailscaleListen ? { tailscaleListen } : {}) };
}

/**
 * FILEDECK_TAILSCALE_LISTEN: `<IPv4>:<port>` or `[<IPv6>]:<port>`. Never an address tailscaled in userspace mode forwards a tailnet
 * connection to (127.0.0.1, ::1; it dials them for any port Serve does not take) or an unspecified one (which listens on those too), and
 * never the hub's own port.
 */
function listenSetting(raw: string | undefined, port: number): { host: string; port: number } | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const bad = () => new Error(`FILEDECK_TAILSCALE_LISTEN: "${v.slice(0, 80)}" is not an IP address and a port (for example 127.0.0.2:8081)`);
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):([0-9]{1,5})$/.exec(v);
  if (!m) throw bad();
  const host = (m[1] ?? m[2])!.toLowerCase();
  const family = isIP(host);
  const p = Number(m[3]);
  if (family === 0 || (m[1] !== undefined) !== (family === 6) || p < 1 || p > 65535) throw bad();
  const forwarded = new BlockList();
  forwarded.addAddress("127.0.0.1", "ipv4");
  forwarded.addAddress("0.0.0.0", "ipv4");
  forwarded.addAddress("::1", "ipv6");
  forwarded.addAddress("::", "ipv6");
  forwarded.addAddress("::ffff:127.0.0.1", "ipv6");
  forwarded.addAddress("::ffff:0.0.0.0", "ipv6");
  if (forwarded.check(host, family === 6 ? "ipv6" : "ipv4"))
    throw new Error(`FILEDECK_TAILSCALE_LISTEN: "${v.slice(0, 80)}" is an address tailscaled forwards tailnet connections to; use another one, for example 127.0.0.2`);
  if (p === port) throw new Error(`FILEDECK_TAILSCALE_LISTEN: the port must not be PORT (${port})`);
  return { host, port: p };
}

/**
 * What a hub says about its Tailscale settings at start, and whether it must stop (`stop`: the message). With sign-in off a set value gives one
 * line and nothing else; with a source on the proxy list is needed. No line holds the socket path.
 */
export function tailscaleStartup(cfg: Config, env: NodeJS.ProcessEnv = process.env): { lines: string[]; stop?: string } {
  if (cfg.mode !== "hub") return { lines: [] };
  if (!cfg.auth) {
    const set = ["FILEDECK_TAILSCALE_SOCKET", "FILEDECK_TAILSCALE_HEADERS", "FILEDECK_TAILSCALE_PROXIES", "FILEDECK_TAILSCALE_LISTEN"].some((k) => !!env[k]);
    return { lines: set ? ["tailscale: sign-in is off, so FILEDECK_TAILSCALE_* is ignored"] : [] };
  }
  const source = cfg.tailscaleSocket ? "socket" : cfg.tailscaleHeaders ? "headers" : null;
  if (!source) return { lines: cfg.tailscaleListen ? ["tailscale: no source is set, so FILEDECK_TAILSCALE_LISTEN is ignored"] : [] };
  if (cfg.tailscaleProxies.length === 0) return { lines: [], stop: "FILEDECK_TAILSCALE_PROXIES is needed when FILEDECK_TAILSCALE_SOCKET or FILEDECK_TAILSCALE_HEADERS is set" };
  // A listed loopback proxy is reached by more than the proxy: tailscaled in userspace mode forwards a tailnet connection to a port Serve
  // does not take to 127.0.0.1, and any local process can connect too. Each of them could write the X-Forwarded-For the socket source
  // trusts, so the identity is then read only on the identity listener, which neither ever reaches.
  const proxies = new ProxyList(cfg.tailscaleProxies);
  if (!cfg.tailscaleListen && (proxies.has("127.0.0.1") || proxies.has("::1")))
    return {
      lines: [],
      stop: 'FILEDECK_TAILSCALE_PROXIES lists a loopback address, so FILEDECK_TAILSCALE_LISTEN is needed: tailscaled in userspace mode, and any process on this host, reaches the hub from loopback (docs/security.md, "Tailscale sign-in")',
    };
  const lines = [`tailscale: sign-in with Tailscale through the ${source} source, from ${cfg.tailscaleProxies.join(",")}`];
  if (cfg.tailscaleListen) lines.push(`tailscale: identities are read only on connections to ${listenLabel(cfg.tailscaleListen)}`);
  if (cfg.tailscaleSocket && cfg.tailscaleHeaders) lines.push("tailscale: FILEDECK_TAILSCALE_SOCKET is set, so FILEDECK_TAILSCALE_HEADERS is ignored");
  return { lines };
}

/** `host:port`, an IPv6 host in brackets. */
export const listenLabel = (l: { host: string; port: number }): string => (l.host.includes(":") ? `[${l.host}]:${l.port}` : `${l.host}:${l.port}`);

export function loadConfig(env = process.env): Config {
  const vaultFile = env.FILEDECK_VAULT_FILE ?? "/var/lib/filedeck-vault/vault.sqlite";
  const mode = env.FILEDECK_MODE === "hub" ? "hub" : "agent";
  const root = (env.FILEDECK_ROOT ?? "/host").replace(/\/+$/, "") || "/";
  return {
    mode,
    port: Number(env.PORT ?? 8080),
    root,
    node: env.FILEDECK_NODE ?? "local",
    procMounts: env.FILEDECK_PROC_MOUNTS ?? defaultProcMounts(root),
    maxUpload: Number(env.FILEDECK_MAX_UPLOAD ?? 1024 ** 4),
    maxEdit: Number(env.FILEDECK_MAX_EDIT ?? 5 * 1024 * 1024),
    staticDir: env.FILEDECK_STATIC ?? "/app/web",
    archiveMaxEntries: Number(env.FILEDECK_ARCHIVE_MAX_ENTRIES ?? 1_000_000),
    archiveMaxBytes: Number(env.FILEDECK_ARCHIVE_MAX_BYTES ?? 1024 ** 4),
    jobConcurrency: Number(env.FILEDECK_JOB_CONCURRENCY ?? 2),
    hashConcurrency: Number(env.FILEDECK_HASH_CONCURRENCY ?? 4),
    walkMaxEntries: Number(env.FILEDECK_WALK_MAX_ENTRIES ?? 500_000),
    indexDir: env.FILEDECK_INDEX_DIR ?? "",
    // the hub keeps its jobs next to the vault (a volume that survives a restart); an agent next to its index
    jobsFile:
      env.FILEDECK_JOBS_FILE ??
      (mode === "hub"
        ? env.FILEDECK_VAULT_FILE // only where the vault volume is configured (production), so tests never touch /var/lib
          ? path.join(path.dirname(env.FILEDECK_VAULT_FILE), "jobs.sqlite")
          : ""
        : env.FILEDECK_INDEX_DIR
          ? path.join(env.FILEDECK_INDEX_DIR, `jobs-${env.FILEDECK_NODE ?? "local"}.db`)
          : ""),
    indexWatches: Number(env.FILEDECK_INDEX_WATCHES ?? 32768),
    indexRevalidateMs: Number(env.FILEDECK_INDEX_REVALIDATE_MS ?? 30 * 60_000),
    trashMaxAgeDays: Number(env.FILEDECK_TRASH_MAX_AGE_DAYS ?? 7),
    trashMaxPercent: Number(env.FILEDECK_TRASH_MAX_PERCENT ?? 10),
    trashMaxBytes: Number(env.FILEDECK_TRASH_MAX_BYTES ?? 0),
    trashSweepMs: Number(env.FILEDECK_TRASH_SWEEP_MS ?? 3_600_000),
    fanwatch: env.FILEDECK_FANWATCH ?? "",
    duWaitMs: Number(env.FILEDECK_DU_WAIT_MS ?? 10_000),
    duAbandonMs: Number(env.FILEDECK_DU_ABANDON_MS ?? 120_000),
    handoverMs: Number(env.FILEDECK_HANDOVER_MS ?? 6000),
    listConcurrency: Number(env.FILEDECK_LIST_CONCURRENCY ?? 16),
    diffDir: env.FILEDECK_DIFF_DIR ?? path.join(os.tmpdir(), `filedeck-diff-${process.pid}`),
    searchConcurrency: Number(env.FILEDECK_SEARCH_CONCURRENCY ?? 3),
    trustedProxies: Math.max(0, Math.min(8, Math.floor(Number(env.FILEDECK_TRUSTED_PROXIES ?? 0)) || 0)),
    searchMaxFileBytes: Number(env.FILEDECK_SEARCH_MAX_FILE ?? 8 * 1024 * 1024),
    searchMaxBytes: Number(env.FILEDECK_SEARCH_MAX_BYTES ?? 512 * 1024 * 1024),
    thumbDir: env.FILEDECK_THUMB_DIR ?? path.join(os.tmpdir(), "filedeck-thumbs"),
    thumbCacheMax: Number(env.FILEDECK_THUMB_CACHE_MAX ?? 256 * 1024 * 1024),
    thumbConcurrency: Number(env.FILEDECK_THUMB_CONCURRENCY ?? 2),
    ffmpeg: env.FILEDECK_FFMPEG ?? "ffmpeg",
    transcodeConcurrency: Number(env.FILEDECK_TRANSCODE_CONCURRENCY ?? 2),
    brand: parseBrand(env.FILEDECK_BRAND),
    readOnly: parseReadOnly(env.FILEDECK_READONLY),
    agentToken: env.FILEDECK_AGENT_TOKEN || undefined,
    allowedHosts: (env.FILEDECK_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    apiToken: mode === "hub" ? readSecret(env, "FILEDECK_API_TOKEN") : undefined,
    nodes: parseNodes(env.NODES),
    authNodes: [...new Set((env.FILEDECK_AUTH_NODES ?? "").split(",").map((n) => n.trim()).filter(Boolean))],
    sources: parseSources(env.FILEDECK_SOURCES),
    sourceSecretDir: env.FILEDECK_SOURCE_SECRETS ?? "/var/run/filedeck/sources",
    vaultFile,
    vaultKey: readSecret(env, "FILEDECK_VAULT_KEY"),
    vaultTtlMs: Number(env.FILEDECK_VAULT_TTL_SECONDS ?? 30 * 60) * 1000,
    vaultMaxMs: Number(env.FILEDECK_VAULT_MAX_HOURS ?? 24) * 3600_000,
    auth: env.FILEDECK_AUTH === "on",
    admins: (env.FILEDECK_ADMINS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    bootstrapAdminFile: env.FILEDECK_BOOTSTRAP_ADMIN_FILE || undefined,
    // next to the vault, only where the vault volume is configured, so tests never touch /var/lib
    authFile: env.FILEDECK_AUTH_FILE || (env.FILEDECK_VAULT_FILE ? path.join(path.dirname(env.FILEDECK_VAULT_FILE), "auth.sqlite") : ":memory:"),
    push: env.FILEDECK_PUSH !== "off",
    pushFile: env.FILEDECK_PUSH_FILE || (env.FILEDECK_VAULT_FILE ? path.join(path.dirname(env.FILEDECK_VAULT_FILE), "push.sqlite") : ":memory:"),
    pushSubject: env.FILEDECK_PUSH_SUBJECT || "https://github.com/DynacomSolutions/filedeck",
    pushHosts: (env.FILEDECK_PUSH_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    sessionIdleMs: Number(env.FILEDECK_SESSION_IDLE_SECONDS ?? 8 * 3600) * 1000,
    sessionMaxMs: Number(env.FILEDECK_SESSION_MAX_SECONDS ?? 7 * 86400) * 1000,
    apiTokenAccount: env.FILEDECK_API_TOKEN_ACCOUNT || undefined,
    hostHelpers: env.FILEDECK_HOST_HELPERS || undefined,
    pamService: env.FILEDECK_PAM_SERVICE || "filedeck",
    worker: false,
    maxWorkers: wholeSetting(env, "FILEDECK_MAX_WORKERS", 6),
    workerIdleMs: wholeSetting(env, "FILEDECK_WORKER_IDLE_SECONDS", 600) * 1000,
    ...tailscaleSettings(env, mode === "hub" && env.FILEDECK_AUTH === "on", Number(env.PORT ?? 8080)),
  };
}

/**
 * The most one account's thumbnail cache may hold (sign-in on): the thumbnail limit (`FILEDECK_THUMB_CACHE_MAX`) shared by twice the workers
 * that may run at once (`FILEDECK_MAX_WORKERS`): while new workers run, stopped ones may still be exiting with their caches. At least 1 MiB
 * (never 0). The cache of an account whose worker has stopped is emptied (agent-workers.ts), so the caches together stay within the limit.
 */
export function accountThumbMax(cfg: Pick<Config, "thumbCacheMax" | "maxWorkers">): number {
  return Math.max(1024 * 1024, Math.floor(cfg.thumbCacheMax / (2 * Math.max(1, cfg.maxWorkers))));
}

/**
 * The settings a worker gets in its start-up message: the agent's own, without any secret (a worker runs as a person's account, so whatever it holds that
 * person could read), and without what only the root process does: the shared job file, the change watcher, trash retention and sign-in checks.
 * `dirs` are the account's own thumbnail cache and index folders.
 */
export function workerConfig(cfg: Config, dirs: { thumbs: string; index: string }): Config {
  return {
    ...cfg,
    worker: true,
    auth: false,
    agentToken: undefined,
    apiToken: undefined,
    apiTokenAccount: undefined,
    vaultKey: undefined,
    bootstrapAdminFile: undefined,
    // whatever a worker holds, its account can read: hub settings (network sources and the folder of their credentials, the administrators, the hub's
    // account and vault files) are dropped, an agent never uses them
    admins: [],
    authFile: "",
    push: false,
    pushFile: "",
    pushHosts: [],
    vaultFile: "",
    nodes: [],
    authNodes: [],
    tailscaleSocket: undefined,
    tailscaleHeaders: false,
    tailscaleProxies: [],
    tailscaleListen: undefined,
    sources: [],
    sourceSecretDir: "",
    jobsFile: "",
    fanwatch: "",
    trashSweepMs: 0,
    // the account's own folders: a worker never shares the root process's index or thumbnail cache
    thumbDir: dirs.thumbs,
    thumbCacheMax: accountThumbMax(cfg),
    indexDir: dirs.index,
  };
}
