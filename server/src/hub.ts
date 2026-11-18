import type { FsError } from "./fsops.ts";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { registerHubDiff } from "./diff-hub.ts";
import { registerOps } from "./ops-routes.ts";
import type { OpQueue } from "./ops-queue.ts";
import { JobStore } from "./job-store.ts";
import type { Config } from "./config.ts";
import { makeThumbnailer } from "./thumbs.ts";
import { createSourceApp } from "./sources/source-app.ts";
import { buildSources } from "./sources/registry.ts";
import type { SourceBackend } from "./sources/types.ts";
import { canUseNode, isAgentAuthPath, isOpenProbe, NoAccessError, withAgentToken } from "./agent-auth.ts";
import { agentFetch, type AgentFetchInit } from "./agent-fetch.ts";
import { ChildListError, listChildren } from "./child-list.ts";
import { apiTokenAuth } from "./api-token.ts";
import { renderIndex } from "./brand.ts";
import { shellCsp, staticCacheControl, textCompression, webHeaders } from "./hub-web.ts";
import { isBodyTooLarge, matchesHostList, requestGuard, stripBrowserContext } from "./request-guard.ts";
import { audit, auditRefusal, clientOf, isAdminPath, trustProxies, type AuditSink } from "./audit.ts";
import { Vault } from "./vault.ts";
import { isPasswordRoute, proxyWithVault, registerVaultRoutes } from "./vault-proxy.ts";
import { Accounts, AuthDb, bootstrapAdmin } from "./auth/store.ts";
import { Sessions } from "./auth/sessions.ts";
import { Challenges } from "./auth/sshkey.ts";
import { LoginLimiter } from "./auth/limiter.ts";
import { ProxyList, readTailnet, stripTailnetHeaders, TailnetSource } from "./auth/tailnet.ts";
import { TailnetLinks } from "./auth/tailnet-links.ts";
import { currentUser, userContext } from "./auth/context.ts";
import { USER_HEADER } from "./auth/identity.ts";
import { LiveStreams } from "./auth/streams.ts";
import { markArrival, registerAuth, registerAuthOff, sessionKeyOf, sessionMethodOf, tokenIdentity, unavailableSystemAuth, type SystemAuth } from "./auth/routes.ts";
import type { Identity } from "./auth/identity.ts";
import { AgentSystemAuth } from "./auth/system.ts";
import { cancelAgentJobs, endAccountWork } from "./auth/account-work.ts";
import { SysPresence } from "./auth/presence.ts";
import { SOURCE_READ_ONLY, SourceGrants, type SourceAccess } from "./auth/source-grants.ts";
import { isAdmin, registerAdmin, registerAdminOff } from "./auth/admin-routes.ts";
import { AccountCalls, closableBody, cuttableResponse, cuttableTarget, type AccountCall } from "./auth/account-calls.ts";

/** The sign-in state of a hub with auth on (tests reach it as `app.auth`). */
export interface HubAuth {
  db: AuthDb;
  accounts: Accounts;
  sessions: Sessions;
  challenges: Challenges;
  limiter: LoginLimiter;
  /** The tailnet identity source (mode null when no Tailscale source is configured) and the tailnet links. */
  tailnet: TailnetSource;
  links: TailnetLinks;
}

/** Where a request for a node or a network source goes. Agents are HTTP; sources run inside the hub. */
export interface Target {
  fetch(rest: string, init?: RequestInit): Promise<Response>;
}

/** The header the hub sets for the agent with the client address it saw itself; any copy a client sends is dropped. */
export const CLIENT_HEADER = "x-filedeck-client";
/** The client's copies of these are dropped: the hub sets its own (the user header is signed per node, see withAgentToken). */
const HOP = new Set([CLIENT_HEADER, USER_HEADER, "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);

/** A copy of `init` without a Cookie header. */
function withoutCookie(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete("cookie");
  return { ...init, headers };
}

function clean(h: Headers, keepLength: boolean): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (HOP.has(k.toLowerCase()) && !(keepLength && k.toLowerCase() === "content-length")) return;
    out.set(k, v);
  });
  return out;
}

/**
 * Whether a proxied call starts an agent job that the end of an act-as-root switch cancels (one the agent makes with the switch's end,
 * `asRootUntil`): compress, extract and a permission change (a job when recursive). Found from the agent routes that call `jobs.create`
 * with that end, not by path prefix. Such a call under the switch is not cut when the switch ends (see `startCall` in `createHub`): the
 * hub waits for it and cancels the job it made. The size scan (`POST /api/jobs/size`) and `GET /api/du` make jobs without that end, so
 * the switch's cancel never reaches them: those calls are cut like any other. The hub cannot see a streamed body, so every
 * `POST /api/fs/perms` counts, also one that is not recursive: such a request still arriving when the switch ends is not cut, and its
 * one change can still run as root. `rest` may carry a query string.
 */
export function startsAgentJob(method: string, rest: string): boolean {
  const p = rest.split("?")[0];
  return method === "POST" && (p === "/api/jobs/compress" || p === "/api/jobs/extract" || p === "/api/fs/perms");
}

/** The most the hub waits for the agents when act as root is turned off early and it cancels the account's root jobs there. */
const END_ROOT_JOBS_MS = 3_000;
/** Of that, the most it waits for the account's agent calls made under the switch that are still in flight (a job being started). */
const ROOT_CALLS_WAIT_MS = 2_000;
/** How long, after the answer, it still waits for such calls before it lists the jobs once more; the agents' own end covers the rest. */
const ROOT_CALLS_LATE_MS = 5 * 60_000;
/** The longest an event stream of a Tailscale session stays open before the browser has to reconnect through the gate (its binding check). */
const TAILNET_STREAM_MS = 60_000;

/**
 * The agent calls made under act as root that have not settled yet (no answer head, no error), per switch: the account and the
 * switch's own end (`asRootUntil`, unique per switch), so a new switch's calls never hold or start the relist of one that ended.
 */
class RootCalls {
  private readonly open = new Map<string, { n: number; idle: (() => void)[] }>();
  static key(name: string, until: number): string {
    return `${name}\n${until}`;
  }
  track(key: string, p: Promise<unknown>): void {
    let e = this.open.get(key);
    if (!e) this.open.set(key, (e = { n: 0, idle: [] }));
    const entry = e;
    entry.n++;
    const done = () => {
      if (--entry.n > 0) return;
      this.open.delete(key);
      for (const f of entry.idle.splice(0)) f();
    };
    p.then(done, done);
  }
  /** Resolves true once none of the calls under `key` (`RootCalls.key`) is in flight, or false when `ms` pass first. */
  settled(key: string, ms: number): Promise<boolean> {
    const e = this.open.get(key);
    if (!e) return Promise.resolve(true);
    return new Promise((resolve) => {
      const go = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = e.idle.indexOf(go);
        if (at >= 0) e.idle.splice(at, 1);
        resolve(false);
      }, ms);
      timer.unref();
      e.idle.push(go);
    });
  }
}

export function createHub(cfg: Config, injected?: Record<string, SourceBackend>, auditSink?: AuditSink, opts?: { now?: () => number; system?: SystemAuth; nodesWaitMs?: number; streamCheckMs?: number }) {
  const app = new Hono() as Hono & { close(): Promise<void>; vault: Vault; auth?: HubAuth; streams?: LiveStreams; systemAuth?: AgentSystemAuth; presence?: SysPresence; nodeTargets: ReadonlyMap<string, Target>; accountChanged(before: Identity): Promise<void>; accountCalls: AccountCalls };
  // Sign-in state, only with auth on (off, nothing is opened or created).
  let auth: HubAuth | undefined;
  // the signed user header is keyed on the agent token, so there is no auth without one (main.ts says so first)
  if (cfg.auth && !cfg.agentToken) throw new Error("FILEDECK_AUTH=on needs FILEDECK_AGENT_TOKEN");
  if (cfg.auth) for (const n of cfg.authNodes) if (!cfg.nodes.some((x) => x.name === n)) throw new Error(`FILEDECK_AUTH_NODES names an unknown node: ${n}`);
  if (cfg.auth) {
    const db = new AuthDb(cfg.authFile);
    const accounts = new Accounts(db);
    bootstrapAdmin(accounts, cfg.bootstrapAdminFile);
    auth = {
      db,
      accounts,
      sessions: new Sessions(db, accounts, { idleMs: cfg.sessionIdleMs, maxMs: cfg.sessionMaxMs, now: opts?.now }),
      challenges: new Challenges(opts?.now),
      limiter: new LoginLimiter(opts?.now),
      tailnet: new TailnetSource({ socket: cfg.tailscaleSocket, headers: cfg.tailscaleHeaders, proxies: new ProxyList(cfg.tailscaleProxies), now: opts?.now }),
      links: new TailnetLinks(db, opts?.now),
    };
    app.auth = auth;
    // Event streams end with their session (auth/streams.ts): told to by the session store, or found out by the check every minute.
    const sessions = auth.sessions;
    const streams = new LiveStreams({ peek: (key) => sessions.peek(key), checkMs: opts?.streamCheckMs, now: opts?.now });
    sessions.onEnd((e) => {
      if ("key" in e) {
        if (e.asRoot) streams.endAsRoot(e.key);
        else streams.endSession(e.key);
      } else streams.endAccount(e.kind, e.name);
    });
    app.streams = streams;
    // first, so the floor on failed sign-ins counts from when the request arrived
    app.use("*", markArrival());
  }
  // Optional allowlist of Host values (DNS-rebinding guard); /healthz stays open for probes that use the pod address.
  if (cfg.allowedHosts.length) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/healthz") return next();
      const host = (c.req.header("host") ?? "").toLowerCase();
      if (matchesHostList(host, cfg.allowedHosts)) return next();
      // an admin call is written even when refused here, before the audit middleware (other paths stay unwritten, as before)
      if (isAdminPath(c.req.path)) auditRefusal("hub", c, 421, auditSink);
      return c.json({ error: "unknown host" }, 421);
    });
  }
  app.use("*", trustProxies(cfg.trustedProxies));
  // Sign-in on: the tailnet identity is read once (auth/tailnet.ts), and then the Tailscale Serve headers are removed, so no route, agent
  // or network source ever sees one. Both come before anything that reads the body or the signal: either makes the node server build its
  // full Request, which would keep a copy of the headers.
  if (auth) {
    app.use("*", readTailnet(auth.tailnet));
    app.use("*", stripTailnetHeaders());
  }
  app.use("*", webHeaders());
  app.use("*", textCompression());
  // editor saves are limited by the agent that takes them (its own maxEdit), not here
  app.use("*", requestGuard({ forward: true, allowedHosts: cfg.allowedHosts, audit: { who: "hub", sink: auditSink } }));
  app.use("*", audit("hub", auditSink));
  app.use("*", apiTokenAuth(cfg.apiToken, auth ? () => tokenIdentity(cfg, auth.accounts) : undefined));
  // System sign-in asks the agents in the sign-in order (auth/system.ts). Each call carries the agent token and nothing else of the
  // request: no user (nobody is signed in yet), no cookie, no client header; the body is built here.
  const signInCall = (node: string, rest: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const n = cfg.nodes.find((x) => x.name === node);
    if (!n) return Promise.reject(new Error(`unknown node ${node}`));
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal };
    return userContext.exit(() => agentFetch(n.url + rest, withAgentToken(init, cfg.agentToken, n.name)));
  };
  if (auth && cfg.nodes.length > 0) {
    app.systemAuth = new AgentSystemAuth({ nodes: cfg.authNodes.length > 0 ? cfg.authNodes : cfg.nodes.map((n) => n.name), call: signInCall });
  }
  // Which machines a system account exists on (auth/presence.ts): asked through the same lookup call as above (agent token only), and
  // read by `mayUse` below, so a machine where the account does not exist is hidden from every route that decides access.
  const sysAuth = app.systemAuth;
  const presence = sysAuth ? new SysPresence({ check: (node, name) => sysAuth.exists(node, name), nodes: cfg.nodes.map((n) => n.name), now: opts?.now }) : undefined;
  app.presence = presence;
  // started at sign-in without waiting: /api/nodes, usually the next request, then shares it. Every sign-in asks again on purpose (an
  // account added or removed on a machine shows at once); the sign-in limiter caps how often that can happen.
  const onSignIn = (kind: "sys" | "virt", name: string) => {
    if (kind === "sys" && presence) void presence.refresh(name);
  };
  /**
   * Act as root was turned off early (or its session signed out): every machine is asked, as the plain system user, for the account's
   * jobs, and each live one started under the switch (`asRootUntil` in its view: it runs as root in the agent's root process) is
   * cancelled through the usual cancel route. The agents also cancel such jobs on their own at the switch's end; this covers the time
   * before it. The account's agent calls made under the switch that are still in flight (a job still being started) are waited for first,
   * at most `ROOT_CALLS_WAIT_MS`. The whole takes at most `END_ROOT_JOBS_MS`; a machine that does not answer is left to that end (one log
   * line). Calls still in flight then do not hold the answer: once they settle, the jobs are listed and cancelled once more.
   */
  const rootCalls = new RootCalls();
  /** Each account's proxied requests and transfers in flight (sign-in on), cut when the account changes (auth/account-calls.ts). */
  const calls = new AccountCalls(opts?.now);
  app.accountCalls = calls; // (tests count them)
  const endRootJobs = async (name: string, until: number): Promise<void> => {
    if (!auth) return;
    const t0 = Date.now();
    // a call made under the switch may still be starting a job (the switch is off now, so no new one starts): wait for it first
    const key = RootCalls.key(name, until);
    // the proxied requests and transfers made under the switch are cut now (the account's other calls go on)
    calls.endRoot(name, key);
    const settled = await rootCalls.settled(key, ROOT_CALLS_WAIT_MS);
    await cancelRootJobs(name, until, Math.max(500, END_ROOT_JOBS_MS - (Date.now() - t0)));
    // still in flight: the answer does not wait any longer, but the jobs are listed again once those calls have settled (not when they
    // are still in flight at the late limit, nor after the hub has closed: the agents' own end covers those)
    if (!settled)
      void rootCalls
        .settled(key, ROOT_CALLS_LATE_MS)
        .then((late) => (late && !closed ? cancelRootJobs(name, until, END_ROOT_JOBS_MS) : undefined))
        .catch(() => undefined);
  };
  /** Cancels the live jobs of `name` started under the switch that ended at `until` (their `asRootUntil` is that very value). */
  const cancelRootJobs = async (name: string, until: number, ms: number): Promise<void> => {
    if (!auth) return;
    const id: Identity = { kind: "sys", name, admin: cfg.admins.includes(name), epoch: auth.accounts.epochOf("sys", name) };
    await userContext.run(id, () =>
      cancelAgentJobs({
        call: callNode,
        nodes: cfg.nodes.map((n) => n.name),
        pick: (j) => j.asRootUntil === until,
        signal: AbortSignal.timeout(ms),
        log: (node, reason) => console.error(`act as root: the root jobs of ${name} on ${node} were not cancelled (${reason}); they stop at the switch's end`),
      }),
    );
  };
  /** An agent call by node name, as whoever the caller runs as (the agent-work helpers in auth/account-work.ts). */
  const callNode = (node: string, rest: string, init?: RequestInit): Promise<Response> => {
    const n = cfg.nodes.find((x) => x.name === node);
    return n ? agentCall(n, rest, init) : Promise.reject(new Error(`unknown node ${node}`));
  };
  if (auth) registerAuth(app, { cfg, ...auth, system: opts?.system ?? app.systemAuth ?? unavailableSystemAuth, now: opts?.now, onSignIn, onAsRootEnd: endRootJobs });
  else registerAuthOff(app);
  const vault = new Vault({ file: cfg.vaultFile, secret: cfg.vaultKey, ttlMs: cfg.vaultTtlMs, maxMs: cfg.vaultMaxMs });
  app.vault = vault;
  // with sign-in on, passwords saved while it was off (no owner) serve nobody: said once at start, while there are any
  if (auth) {
    const unowned = vault.countUnowned();
    if (unowned > 0) console.log(`vault: ${unowned} saved passwords from before sign-in was on are kept but not used; an administrator can forget them in Accounts`);
  }
  let opq: OpQueue | undefined;
  let closed = false;
  app.close = async () => {
    closed = true;
    app.streams?.close();
    await opq?.interrupt(); // stop at an item boundary and hand the running jobs over
    vault.close();
    auth?.db.close();
    await Promise.all([...sources.values()].map((s) => s.backend.close().catch(() => undefined)));
  };
  /**
   * Act as root, checked again before each agent call (also a job's, whose owner was stored when it started, maybe before a restart): the
   * session the switch belongs to still holds it with the same end, the name is still in FILEDECK_ADMINS, the account epoch has not
   * risen, and the end is still ahead. Otherwise the call goes as the plain system user.
   */
  const asRootOk = (id: Identity & { kind: "sys" }): boolean => {
    if (!auth || !id.asRootSession || id.asRootUntil === undefined) return false;
    const now = (opts?.now ?? Date.now)();
    return (
      auth.sessions.asRootOf(id.asRootSession) === id.asRootUntil && cfg.admins.includes(id.name) && auth.accounts.epochOf("sys", id.name) === id.epoch && now < id.asRootUntil
    );
  };
  // Every call to an agent names the person behind it (with auth on, a call with nobody behind it throws). Only the open
  // probes go out without a user header: they carry no data and are made for nobody in particular.
  // With auth on the client's cookie (its session) never goes to an agent, whatever path built the headers.
  // The agents' sign-in routes are the hub's alone (signInCall above): no person's request ever reaches them through here.
  const agentCall = (n: { name: string; url: string }, rest: string, init?: RequestInit) => {
    if (cfg.auth && isAgentAuthPath(rest)) return Promise.reject(new Error("the agents' sign-in routes are not forwarded"));
    if (cfg.auth) init = withoutCookie(init);
    if (isOpenProbe(rest)) return userContext.exit(() => agentFetch(n.url + rest, withAgentToken(init, cfg.agentToken, n.name)));
    const p = agentFetch(n.url + rest, withAgentToken(init, cfg.agentToken, n.name, cfg.auth, asRootOk));
    // (a call under act as root is counted until it settles, so switching off can wait for a job that is still being started)
    const id = currentUser();
    if (id?.kind === "sys" && id.asRootUntil !== undefined && asRootOk(id)) rootCalls.track(RootCalls.key(id.name, id.asRootUntil), p);
    return p;
  };
  const agents = new Map<string, Target>(cfg.nodes.map((n) => [n.name, { fetch: async (rest, init) => agentCall(n, rest, init) }]));
  app.nodeTargets = agents; // (tests reach the agent calls through it)
  const sources = buildSources(cfg);
  for (const [name, backend] of Object.entries(injected ?? {})) {
    sources.set(name, { config: { name, type: backend.type, host: "test", root: "/" }, backend });
  }
  /**
   * What an account may do on a network source (sign-in on): read-write for an administrator now (FILEDECK_ADMINS or the stored flag,
   * read at each call, never the identity's own `admin`), else its source grant; undefined without a grant or without an identity.
   * An identity whose epoch is not the account's epoch in the store now has no access at all, administrator or not: a job that
   * outlived a change of its account (a deleted name reads its retired epoch, a name made again starts above it) never uses the
   * grants of what the account is now.
   */
  const sourceGrants = auth ? new SourceGrants(auth.db) : undefined;
  const sourceAccessOf = (id: Identity | undefined, source: string): SourceAccess | undefined => {
    if (!auth || !sourceGrants || !id) return undefined;
    if (auth.accounts.epochOf(id.kind, id.name) !== id.epoch) return undefined;
    if (isAdmin(cfg, auth.accounts, id)) return { write: true };
    return sourceGrants.get(source, id.kind, id.name);
  };
  const sourceOpts = { maxUpload: cfg.maxUpload, maxEdit: cfg.maxEdit, hashConcurrency: cfg.hashConcurrency, walkMaxEntries: cfg.walkMaxEntries, searchConcurrency: cfg.searchConcurrency, searchMaxFileBytes: cfg.searchMaxFileBytes, searchMaxBytes: cfg.searchMaxBytes, thumbs: makeThumbnailer(cfg) };
  for (const [name, s] of sources) {
    if (agents.has(name)) throw new Error(`source ${name} collides with a node of the same name`);
    const sapp = createSourceApp(name, s.backend, { ...sourceOpts, indexFile: cfg.indexDir ? path.join(cfg.indexDir, `source-${name}.db`) : "" });
    // With sign-in on, every call is checked here against the account behind it (a hub job runs as its owner), so the proxy, hub jobs,
    // transfers, compares and the vault routes are all covered, and a grant taken away stops a running job at its next call. A
    // read-only grant lets only GET and HEAD through; a change is refused before the source app sees it.
    agents.set(name, {
      fetch: (rest, init) => {
        if (cfg.auth) {
          const access = sourceAccessOf(currentUser(), name);
          if (!access) return Promise.reject(new NoAccessError());
          const method = (init?.method ?? "GET").toUpperCase();
          if (!access.write && method !== "GET" && method !== "HEAD") return Promise.resolve(Response.json({ error: SOURCE_READ_ONLY }, { status: 403 }));
        }
        return Promise.resolve(sapp.fetch(new Request("http://source" + rest, init)));
      },
    });
  }
  const nodeNames = new Set(cfg.nodes.map((n) => n.name));
  /**
   * What the presence cache says of a system account on a node. A stale answer still counts; a refresh is started in the background
   * when one is due, and no request waits for it here (only /api/nodes waits, at most 2 s).
   */
  const present = (name: string, node: string): boolean | undefined => {
    // a name that is not a machine answers as a hidden one (403, not 404), so a system account cannot learn hidden names by trying
    if (!nodeNames.has(node)) return false;
    // act as root: every configured machine is open, also one without the account (the agent then needs no account)
    const id = currentUser();
    if (id?.kind === "sys" && id.name === name && asRootOk(id)) return true;
    if (!presence) return undefined;
    if (presence.due(name)) void presence.refresh(name);
    return presence.known(name, node);
  };
  /**
   * Whether the person behind the current request may use a node or source. A network source needs a grant (or an administrator,
   * `sourceAccessOf`). With auth off everything is open, as before.
   */
  const mayUse = (name: string) => !cfg.auth || (sources.has(name) ? sourceAccessOf(currentUser(), name) !== undefined : canUseNode(currentUser(), name, present));
  /**
   * Whether the person behind the current request may change things on a node or source: false only for a network source the caller
   * has read-only. Checked up front where a request would remove from or rename on it (a move, trash, delete), so a move out of it is
   * refused before anything is copied. Access as such is `mayUse`'s question.
   */
  const mayChange = (name: string) => !cfg.auth || !sources.has(name) || sourceAccessOf(currentUser(), name)?.write !== false;
  const noAccess = (c: import("hono").Context) => c.json({ error: "no access to this machine" }, 403);

  // Reachability of a source is cached briefly so the sidebar poll does not open a connection per request.
  const pingCache = new Map<string, { at: number; ok: boolean; reason?: string }>();
  const sourceOnline = async (name: string) => {
    const hit = pingCache.get(name);
    if (hit && Date.now() - hit.at < 10_000) return hit;
    let ok = false;
    let reason: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (sources.get(name) as { backend: SourceBackend }).backend.ping(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("timeout")), 4000);
        }),
      ]);
      ok = true;
    } catch (e) {
      ok = false;
      // Only a fixed code is reported, never the error text (hosts, users and key details stay out of the API).
      if ((e as FsError | undefined)?.extra?.reason === "hostkey") reason = "host-key-changed";
    } finally {
      clearTimeout(timer);
    }
    const res = { at: Date.now(), ok, ...(reason ? { reason } : {}) };
    pingCache.set(name, res);
    return res;
  };

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/api/nodes", async (c) => {
    // a system account sees only the machines where it exists: wait (at most 2 s) for answers that are missing or old
    const id = currentUser();
    if (presence && id?.kind === "sys" && presence.due(id.name)) await presence.refresh(id.name, opts?.nodesWaitMs ?? 2000);
    // a virtual account's grant paths on each machine, in stored order (the gate reads the identity from the store on every call); the
    // web app opens the machine at the first one
    const rootsOf = (node: string) => (cfg.auth && id?.kind === "virt" && Object.hasOwn(id.nodes, node) ? { roots: id.nodes[node]!.grants.map((g) => g.path) } : {});
    const nodes = await Promise.all(
      cfg.nodes.filter((n) => mayUse(n.name)).map(async (n) => {
        try {
          const r = await fetch(`${n.url}/healthz`, { signal: AbortSignal.timeout(2000) }); // open probe: no token needed
          return { name: n.name, online: r.ok, ...rootsOf(n.name) };
        } catch {
          return { name: n.name, online: false, ...rootsOf(n.name) };
        }
      }),
    );
    // with sign-in on, only the sources the caller has access to; one it may only read says so
    const srcs = await Promise.all(
      [...sources.values()]
        .flatMap(({ config }) => {
          if (!cfg.auth) return [{ config, readOnly: false }];
          const access = sourceAccessOf(id, config.name);
          return access ? [{ config, readOnly: !access.write }] : [];
        })
        .map(async ({ config, readOnly }) => {
          const s = await sourceOnline(config.name);
          return { name: config.name, type: config.type, host: config.host, online: s.ok, ...(s.reason ? { offlineReason: s.reason } : {}), ...(readOnly ? { readOnly: true } : {}) };
        }),
    );
    return c.json({ nodes, sources: srcs });
  });

  // Folder diff jobs run here: the hub reads both agents' listings and asks each agent to hash its own files.
  const diffs = registerHubDiff(app, agents, cfg.mode === "hub" ? cfg.diffDir : "", { mayUse });
  // Bulk copy/move/trash/delete/sync run as hub jobs (survive the browser closing, pausable, conflict policy).
  opq = registerOps(app, agents, (n) => sources.has(n), cfg.jobsFile ? { store: new JobStore(cfg.jobsFile), leaseMs: 30_000 } : undefined, mayUse, mayChange);
  const ops = opq;
  /**
   * An account changed (password, keys, admin flag, machines, grants, sources, deletion, "end all sessions"): its epoch rises, which ends
   * its sessions and their streams; its hub jobs and compares are cancelled; and each machine is asked, as the account at its new epoch
   * (so the agent also stops its workers), to cancel its jobs there. `before` is the identity from before the change, so a machine the
   * change took away is still asked. A system account is asked on every machine.
   */
  /**
   * A call of the current account starts: undefined with sign-in off or nobody behind the request. One made under a live act-as-root
   * switch is tagged with it, so the switch's end cuts it (and only it) as well; but not a call that starts an agent job (`jobRoute`,
   * `startsAgentJob`): cutting it would not keep the agent from starting the job, and it would end the wait in `endRootJobs` early, so
   * its listing could miss that job. Those calls are short, and that wait and the late relist cover them.
   */
  const startCall = (jobRoute = false): AccountCall | undefined => {
    const id = cfg.auth ? currentUser() : undefined;
    if (!id) return undefined;
    const root = !jobRoute && id.kind === "sys" && id.asRootUntil !== undefined && asRootOk(id) ? { key: RootCalls.key(id.name, id.asRootUntil), until: id.asRootUntil } : undefined;
    return calls.start(id.kind, id.name, root, { jobStart: jobRoute });
  };
  app.accountChanged = async (before: Identity): Promise<void> => {
    if (!auth) return;
    // a system administrator's act-as-root switches still on: read before the sessions go, their root jobs are cancelled below
    const roots = before.kind === "sys" ? auth.sessions.liveAsRootEnds(before.name) : [];
    auth.sessions.endAll(before.kind, before.name);
    // its proxied requests and transfers in flight, to machines and sources alike, are cut now (uploads fail, downloads stop); calls
    // that start an agent job are left to settle, so the waits below see the job they make
    calls.endAccount(before.kind, before.name);
    const id: Identity = { ...before, epoch: auth.accounts.epochOf(before.kind, before.name) };
    const nodes = before.kind === "sys" ? cfg.nodes.map((n) => n.name) : Object.keys(before.nodes).filter((x) => nodeNames.has(x));
    await endAccountWork({ id, nodes, ops, diffs, call: callNode });
    // a root job runs in the agent's root process, so the raised epoch does not stop it, and one still being started was not in the
    // listing above: each switch ends as Stop ends it (its calls settle, at most 2 s; its jobs are listed and cancelled; a late relist).
    // The switches end together, so they add at most 3 s to the change however many there are.
    await Promise.all(roots.map((until) => endRootJobs(before.name, until)));
  };
  // The admin routes (auth/admin-routes.ts): only with sign-in on; off, /api/admin/* is 404. `changed` is read at each call, so tests
  // can wrap app.accountChanged.
  if (auth && sourceGrants)
    registerAdmin(app, {
      cfg,
      accounts: auth.accounts,
      sessions: auth.sessions,
      sourceGrants,
      vault,
      nodes: cfg.nodes.map((n) => n.name),
      sources: [...sources.values()].map(({ config }) => ({ name: config.name, type: config.type })),
      onAsRootEnd: endRootJobs,
      // the account lookup the sign-in uses (2 s; no answer is undefined): a name a machine knows, or a run-as user it does not
      systemExists: sysAuth ? (node, name) => sysAuth.exists(node, name) : undefined,
      changed: (before) => app.accountChanged(before),
    });
  else registerAdminOff(app);
  for (const f of cfg.jobsFile ? [cfg.jobsFile, cfg.jobsFile + "-wal", cfg.jobsFile + "-shm"] : []) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* not created */
    }
  }

  // Cross-node / cross-source transfer: the hub streams src -> dst. Files and folders; both ends are
  // agents or network sources. Moving removes the source afterwards (node trash, permanent on sources).
  class TransferError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const q = encodeURIComponent;
  const failed = async (r: Response, what: string): Promise<TransferError> => {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    return new TransferError(r.status >= 400 && r.status < 600 ? r.status : 502, `${what}: ${msg}`);
  };
  interface StatLite {
    type: string;
    mtime?: number;
    linkDir?: boolean;
    broken?: boolean;
  }
  /** Links and special files met inside folders: not transferred, counted so a move keeps its source. */
  interface Tally {
    skipped: number;
  }
  const statOf = async (t: Target, p: string): Promise<StatLite | null> => {
    const r = await t.fetch(`/api/fs/stat?path=${q(p)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw await failed(r, "stat");
    return (await r.json()) as StatLite;
  };
  const joinP = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
  interface TOpts {
    overwrite: boolean;
    preserveTimes: boolean;
    move: boolean;
  }
  async function transferFile(src: Target, sp: string, st: StatLite, dst: Target, dir: string, name: string, o: TOpts) {
    const down = await src.fetch(`/api/fs/download?path=${q(sp)}`);
    if (!down.ok) throw await failed(down, "source read");
    const headers: Record<string, string> = {};
    const len = down.headers.get("content-length");
    if (len !== null) headers["content-length"] = len;
    // the download goes up through a body this function can always close: when the destination fails before reading it (unreachable,
    // a refusal) or after reading part of it, the source's read stream is closed, whoever holds the body's reader
    const body = down.body ? closableBody(down.body) : undefined;
    let up: Response;
    try {
      up = await dst.fetch(
        `/api/fs/upload?dir=${q(dir)}&name=${q(name)}` + (o.overwrite ? "&overwrite=1" : "") + (o.preserveTimes && st.mtime ? `&mtime=${Math.floor(st.mtime)}` : ""),
        { method: "PUT", body: body?.stream ?? "", duplex: "half", headers } as RequestInit,
      );
    } catch (e) {
      body?.close();
      throw e;
    }
    if (!up.ok) {
      body?.close();
      throw await failed(up, "destination write");
    }
    return (await up.json()) as { path: string };
  }
  async function transferTree(src: Target, sp: string, dst: Target, dir: string, o: TOpts, tally: Tally, depth = 0): Promise<{ path: string }> {
    const st = await statOf(src, sp);
    if (!st) throw new TransferError(404, "source not found");
    if (st.type === "symlink" && depth === 0) {
      // a link chosen by name is followed to what it points at; links inside folders are not
      if (st.broken) throw new TransferError(400, "the link points at nothing");
      // a move would copy what the link points at and remove only the link: the data would exist twice
      if (o.move) throw new TransferError(400, "a link cannot be moved; copy it, or move what it points at");
      st.type = st.linkDir ? "dir" : "file";
    }
    const name = path.posix.basename(sp);
    if (st.type === "file") return transferFile(src, sp, st, dst, dir, name, o);
    if (st.type !== "dir") throw new TransferError(400, "only files and folders can be transferred");
    if (depth > 64) throw new TransferError(400, "folder nesting too deep");
    const dp = joinP(dir, name);
    const cur = await statOf(dst, dp);
    if (cur && (cur.type !== "dir" || !o.overwrite)) throw new TransferError(409, "destination exists");
    if (!cur) {
      const mk = await dst.fetch("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dp }) });
      if (!mk.ok) throw await failed(mk, "destination mkdir");
    }
    // every child, not the page the browser gets (that one stops at 20 000 entries)
    const ls = await listChildren((rest, init) => src.fetch(rest, init), sp, undefined, (r) => failed(r, "source list")).catch((e) => {
      if (e instanceof ChildListError) throw new TransferError(502, `source list: ${sp}: ${e.message}`);
      throw e;
    });
    if (ls.truncated) throw new TransferError(502, `source list: ${sp} has more entries than the node lists in one walk`);
    for (const e of ls.entries) {
      if (e.type === "symlink" || e.type === "other") {
        tally.skipped++;
        continue;
      }
      await transferTree(src, e.path, dst, dp, o, tally, depth + 1);
    }
    return { path: dp };
  }

  app.post("/api/transfer", async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      src?: { node: string; path: string };
      dst?: { node: string; dir: string };
      op?: "copy" | "move";
      /** replace an existing file of the same name at the destination (folders are merged) */
      overwrite?: boolean;
      /** give the destination file the source's modification time */
      preserveTimes?: boolean;
    } | null;
    // a node the caller may not use and one that does not exist look the same, so hidden node names stay hidden
    for (const end of [b?.src, b?.dst]) if (typeof end?.node === "string" && !mayUse(end.node)) return noAccess(c);
    // a move removes the source at the end: out of a read-only source it is refused before anything is copied
    if (b?.op === "move" && typeof b.src?.node === "string" && !mayChange(b.src.node)) return c.json({ error: SOURCE_READ_ONLY }, 403);
    const srcTarget = b?.src && agents.get(b.src.node);
    const dstTarget = b?.dst && agents.get(b.dst.node);
    if (!b?.src || !b.dst || !srcTarget || !dstTarget) return c.json({ error: "unknown node" }, 404);
    if (typeof b.src.path !== "string" || typeof b.dst.dir !== "string" || !b.src.path.startsWith("/") || b.src.path === "/") {
      return c.json({ error: "invalid path" }, 400);
    }
    // cut when the account changes: the call in flight fails (a file being written fails, not cut short) and no further call is made
    const call = startCall();
    const src = call ? cuttableTarget(srcTarget, call.signal) : srcTarget;
    const dst = call ? cuttableTarget(dstTarget, call.signal) : dstTarget;
    try {
      const tally: Tally = { skipped: 0 };
      const res = await transferTree(src, b.src.path, dst, b.dst.dir, { overwrite: b.overwrite === true, preserveTimes: b.preserveTimes === true, move: b.op === "move" }, tally);
      if (b.op === "move" && tally.skipped > 0) {
        throw new TransferError(409, `copied, but ${tally.skipped} link${tally.skipped === 1 ? "" : "s"} or special file${tally.skipped === 1 ? " was" : "s were"} not transferred; the source was kept`);
      }
      if (b.op === "move") {
        const isSource = sources.has(b.src.node);
        const rm = await src.fetch(isSource ? "/api/fs/delete" : "/api/fs/trash", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: [b.src.path] }),
        });
        if (!rm.ok) throw await failed(rm, "copied, but removing the source failed");
      }
      return c.json(tally.skipped > 0 ? { ...res, skipped: tally.skipped } : res, 201);
    } catch (e) {
      if (e instanceof TransferError) return c.json({ error: e.message }, e.status as 400);
      if (e instanceof NoAccessError) return noAccess(c);
      if ((e as Error)?.name === "AbortError") return new Response(null, { status: 499 });
      return c.json({ error: "transfer failed" }, 502);
    } finally {
      call?.done();
    }
  });

  // With auth on each account has its own saved passwords: the owner is the signed-in account.
  // A call with nobody behind it would see every entry, so it fails instead (the gate makes this unreachable).
  const vaultOwner = () => {
    const id = currentUser();
    if (!id) throw new Error("vault use without an identity");
    return `${id.kind}:${id.name}`;
  };
  /**
   * Whether the account a request began as is still the same account (it exists, at the epoch read when the request began). A password
   * typed in a request that waited on its agent is saved only then: an account deleted, made again or changed meanwhile gets nothing.
   */
  const ownerHoldsFor = (id: Identity | undefined): (() => boolean) | undefined => {
    if (!auth || !id) return undefined;
    return () => (id.kind === "sys" || auth.accounts.get(id.name) !== undefined) && auth.accounts.epochOf(id.kind, id.name) === id.epoch;
  };
  registerVaultRoutes(app, vault, (n) => cfg.nodes.some((x) => x.name === n), cfg.auth ? { owner: vaultOwner, mayUse } : undefined);

  // Reverse proxy: /api/nodes/<node>/<rest> -> <agent>/<rest>
  app.all("/api/nodes/:node/*", async (c) => {
    // a node the caller may not use and one that does not exist look the same, so hidden node names stay hidden
    if (!mayUse(c.req.param("node"))) return noAccess(c);
    const base = agents.get(c.req.param("node"));
    if (!base) return c.json({ error: "unknown node" }, 404);
    const url = new URL(c.req.url);
    // the node segment is matched as sent: its decoded form can have another length
    const rest = /^\/api\/nodes\/[^/]+(\/.*)$/.exec(url.pathname)?.[1] ?? "/";
    // the agents' sign-in routes answer only the hub (they would be a way past its limiter)
    if (cfg.auth && isAgentAuthPath(rest)) return c.json({ error: "not found" }, 404);
    // a request without a body (content-length 0 and no transfer-encoding) is sent as such, so it uses a pooled connection like a GET; only a real body is streamed on a connection of its own
    const len0 = c.req.header("content-length");
    const hasBody = !["GET", "HEAD"].includes(c.req.method) && (c.req.header("transfer-encoding") !== undefined || (len0 === undefined ? c.req.raw.body !== null : len0 !== "0"));
    // with auth on, any GET made with a session may answer an event stream, which must be cut off at the agent when its session ends.
    // The answer's type decides, not the request's Accept header: a client (a script with a stolen cookie) could leave that out.
    const session = app.streams && c.req.method === "GET" ? sessionKeyOf(c) : undefined;
    const upstream = session !== undefined ? new AbortController() : undefined;
    const init: AgentFetchInit & { duplex?: string } = {
      method: c.req.method,
      headers: clean(c.req.raw.headers, false),
      signal: upstream ? AbortSignal.any([c.req.raw.signal, upstream.signal]) : c.req.raw.signal,
      redirect: "manual",
      // the zip download that redeems a one-use ticket must not be sent twice
      ...(c.req.method === "GET" && rest === "/api/fs/zip" && url.searchParams.has("ticket") ? { replay: false } : {}),
    };
    stripBrowserContext(init.headers as Headers); // judged above; the agent sees a hub call
    if (cfg.auth) (init.headers as Headers).delete("cookie"); // the session stays with the hub (network sources too)
    // who is asking, as this hub saw it (the last hop of the forwarded chain behind a proxy, else the socket's peer: what the audit log records)
    const who = clientOf(c).ip;
    if (who) (init.headers as Headers).set(CLIENT_HEADER, who.slice(0, 64));
    if (hasBody) {
      init.body = c.req.raw.body;
      init.duplex = "half";
      const len = c.req.header("content-length");
      if (len) (init.headers as Headers).set("content-length", len);
    }
    // With sign-in on, every proxied request is the account's until its answer body is over, whatever its method: when the account
    // changes it is cut (a body on its way up fails, so the agent or source drops a partial upload; the answer stops).
    const call = startCall(startsAgentJob(c.req.method, rest));
    const target = call ? cuttableTarget(base, call.signal) : base;
    const cut = (res: Response) => (call ? cuttableResponse(res, call.signal, call.done) : res);
    try {
      if (isPasswordRoute(c.req.method, rest)) {
        // encrypted archives / PDFs: the vault supplies (and saves) the password
        const r = await proxyWithVault({ vault, owner: cfg.auth ? vaultOwner() : undefined, ownerHolds: ownerHoldsFor(currentUser()), node: c.req.param("node"), target, method: c.req.method, rest, search: url.search, headers: init.headers as Headers, body: c.req.raw.body, signal: c.req.raw.signal });
        return cut(new Response(r.body, { status: r.status, headers: clean(r.headers, true) }));
      }
      const r = await target.fetch(rest + url.search, init);
      const out = cut(new Response(r.body, { status: r.status, headers: clean(r.headers, true) }));
      const id = currentUser();
      if (app.streams && session !== undefined && upstream && id && (r.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
        // a stream opened under the act-as-root switch ends with the switch too (turned off, its end passed, or no longer held). The gate
        // gave the identity the switch, so the agent call may have carried it: the stream counts as one, and track ends it at once if the
        // switch is already gone.
        const asRoot = id.kind === "sys" && id.asRootUntil !== undefined ? { until: id.asRootUntil, ok: () => asRootOk(id) } : undefined;
        // a Tailscale session's binding is checked only by the gate: its stream ends within a minute, and the browser's reconnect goes
        // through the gate again (a tag taken off the device, say, then ends the session)
        const absolute = auth?.sessions.endsAt(session);
        const endsAt = sessionMethodOf(c) === "tailscale" ? Math.min(absolute ?? Infinity, (opts?.now ?? Date.now)() + TAILNET_STREAM_MS) : absolute;
        return app.streams.track(session, id.kind, id.name, out, { abort: () => upstream.abort(), asRoot, endsAt });
      }
      return out;
    } catch (e) {
      call?.done();
      if ((e as Error).name === "AbortError") return new Response(null, { status: 499 });
      if (e instanceof NoAccessError) return noAccess(c);
      if (isBodyTooLarge(e)) return c.json({ error: "request body too large" }, 413);
      return c.json({ error: "agent unreachable" }, 502);
    }
  });

  // SPA
  const index = path.join(cfg.staticDir, "index.html");
  const page = async (c: import("hono").Context) => {
    try {
      const html = renderIndex(await readFile(index, "utf8"), cfg.brand);
      return c.html(html, 200, { "Cache-Control": "no-cache", "Content-Security-Policy": shellCsp(html, cfg.brand), "X-Frame-Options": "DENY" });
    } catch {
      return c.text("web UI not built", 503);
    }
  };
  app.get("/", page);
  app.get("/index.html", page);
  app.use(
    "/*",
    serveStatic({
      root: path.relative(process.cwd(), cfg.staticDir) || ".",
      onFound: (_p, c) => {
        const cc = staticCacheControl(c.req.path);
        if (cc) c.header("Cache-Control", cc);
      },
    }),
  );
  // a missing build file is a 404, never the app shell (an old tab asking for a chunk of a previous build must see the failure)
  app.all("/assets/*", (c) => c.text("not found", 404));
  app.get("*", page);
  return app;
}
