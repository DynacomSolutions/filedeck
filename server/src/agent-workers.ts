import { createHash } from "node:crypto";
import fsc from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { USER_HEADER, type UserClaim } from "./auth/identity.ts";
import { workerConfig, type Config } from "./config.ts";
import { type AccountResolver, type LocalAccount } from "./local-accounts.ts";
import { PoolFull, StaleEpoch, type WorkerPool, type WorkerSpec } from "./worker-pool.ts";
import { WorkerGone } from "./worker-proto.ts";
import {
  OPEN_DIR,
  UnsafeFolders,
  cacheDir,
  grantPath,
  inHeld,
  tightenTop,
  keyDir,
  keyFolder,
  landlockRoots,
  removeArea,
  removeOldIndexDirs,
  trashFolder,
  virtKeyDir,
  virtOwner,
  type AccountDirs,
  type Hook,
} from "./account-dirs.ts";
import { JOBS_HEADER } from "./worker.ts";

/**
 * With sign-in on, the agent's root process serves only its own routes (below) and sends every other request to the worker of the
 * account behind it (worker-pool.ts). The worker runs as that account, so the kernel checks each file access.
 */

/**
 * The routes the root process keeps: the probes, the node's own information, the folder sizes, and the job list (Task 9 merges it
 * with the workers' jobs). Part 2b adds `/api/auth/*`. Archive jobs (`POST /api/jobs/compress`, `/api/jobs/extract`) run as the
 * account, in its worker.
 */
export const ROOT_ROUTES: readonly RegExp[] = [/^\/healthz$/, /^\/metrics$/, /^\/api\/info$/, /^\/api\/du$/, /^\/api\/jobs$/, /^\/api\/jobs\/[^/]+(?:\/cancel)?$/];

/** Whether the root process answers this request itself. */
export function isRootRoute(method: string, p: string): boolean {
  if (method === "POST" && (p === "/api/jobs/compress" || p === "/api/jobs/extract")) return false;
  return ROOT_ROUTES.some((re) => re.test(p));
}

/** `sys:<name>`, or `virt:<name>:<hash>` where the hash covers `runAs` and the grants (sorted by path), so other grants get another worker. */
export function workerKey(claim: UserClaim): string {
  if (claim.kind === "sys") return `sys:${claim.name}`;
  const grants = [...(claim.grants ?? [])].map((g) => ({ path: g.path, write: g.write })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(a.write) - Number(b.write)));
  const hash = createHash("sha256").update(JSON.stringify({ runAs: claim.runAs, grants })).digest("hex").slice(0, 16);
  return `virt:${claim.name}:${hash}`;
}

/** Request headers the worker never gets: the agent token, the browser's cookies and the signed claim (the gate has used them). */
const DROP_REQUEST = ["authorization", "cookie", USER_HEADER];

/** Response headers a worker may not set: cookies, the hop-by-hop headers (they are for this connection only) and the pool's job count. */
const DROP_RESPONSE = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", JOBS_HEADER]);
const NULL_BODY = new Set([204, 205, 304]);

const json = (error: string, status: number, headers?: Record<string, string>) => Response.json({ error }, { status, headers });

/**
 * The worker's answer as the client gets it. A worker is not trusted: its status must be 200-599 (else 502), and the headers above
 * (also every header that its `connection` header names) are dropped, and so is a `content-length` that is not a plain number. A body that fails after the head ends with an error that holds
 * none of the worker's text; the text is logged (not when `signal`, the client's, has aborted: then the client ended it).
 */
export function clientResponse(res: Response, key: string, log: (s: string) => void, signal?: AbortSignal, method = "GET"): Response {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599) {
    void res.body?.cancel().catch(() => {});
    log(`worker ${key}: answer with status ${res.status}`);
    return json("bad answer from the worker", 502);
  }
  // a length the worker states is kept only when it is a plain number; the body is then held to it (more or less ends it with an error)
  const cl = res.headers.get("content-length");
  const length = cl !== null && /^\d{1,15}$/.test(cl) ? Number(cl) : undefined;
  const named = new Set((res.headers.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const headers = new Headers();
  for (const [k, v] of res.headers) if (!DROP_RESPONSE.has(k) && !k.startsWith("proxy-") && !named.has(k)) headers.append(k, v);
  if (length === undefined) headers.delete("content-length");
  // (an answer to HEAD has no body, whatever the stream says; its length is the one a GET would get)
  if (NULL_BODY.has(res.status) || !res.body || method === "HEAD") {
    void res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers });
  }
  const reader = res.body.getReader();
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return; // (the client cancelled while this read waited: the stream is closed already)
        if (!done) sent += value.length;
        if (length !== undefined && (done ? sent !== length : sent > length)) {
          void reader.cancel().catch(() => {});
          throw new Error(`the body has ${done ? "" : "more than "}${sent} bytes; it said ${length}`);
        }
        if (done) ctl.close();
        else ctl.enqueue(value);
      } catch (e) {
        // (a worker that went, or a client that went away, is not the worker's error)
        if (!(e instanceof WorkerGone) && !signal?.aborted) log(`worker ${key}: answer failed: ${e instanceof Error ? e.message : String(e)}`);
        ctl.error(new Error("worker error"));
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status: res.status, headers });
}

/**
 * Sends each signed-in request that is not a root route to the worker of its account. Mount it after `audit` (so a forwarded request
 * is in the audit log) and before the routes. Sign-in off: not mounted.
 *
 * The local account is `claim.name` for a system account and `claim.runAs` for a virtual one, looked up fresh when no worker runs for
 * the key. Epochs: the highest seen per `kind:name` is kept; a higher one first stops every worker of that account (a running worker
 * would otherwise keep serving the old account), a lower one is refused.
 *
 * Answers of its own: 401 `account changed`, 403 `no account on this machine` (unknown, or root), 503 `account lookup failed; try
 * again` (the lookup failed: never 403), 503 `too many people are using this machine; try again` with `Retry-After: 5` (`PoolFull`),
 * 503 `worker stopped` (`WorkerGone` before the head), 503 `worker folders are not safe` (`UnsafeFolders`), and 500 `worker error` for
 * any other failure (its text only in the log).
 *
 * The agent mounts it after `readOnlyGuard`, which runs as root before a request is forwarded. So with read-only prefixes set, a person
 * can learn whether a path they cannot reach (a folder they may not pass through) is on a read-only volume: a write there gets
 * `read-only volume` instead of the worker's `permission denied`. Accepted; the docs say so.
 */
export function workerGate(
  _cfg: Config,
  o: {
    pool: WorkerPool;
    accounts: AccountResolver;
    spec: (claim: UserClaim, account: LocalAccount) => Promise<WorkerSpec>;
    log?: (s: string) => void;
  },
): MiddlewareHandler {
  const log = o.log ?? ((s) => console.error(s));
  /** per `kind:name`, the highest epoch seen */
  const epochs = new Map<string, number>();
  /** per key, the fresh lookup in progress (one at a time per key; the requests that come meanwhile share it) */
  const fresh = new Map<string, Promise<LocalAccount | null>>();
  /** fresh when no worker runs for the key (a start then uses the account as it is now), else from the resolver's cache */
  const lookup = (key: string, name: string): Promise<LocalAccount | null> => {
    if (o.pool.list().some((w) => w.key === key)) return o.accounts.resolve(name, false);
    let p = fresh.get(key);
    if (!p) {
      p = o.accounts.resolve(name, true);
      fresh.set(key, p);
      const done = () => {
        if (fresh.get(key) === p) fresh.delete(key);
      };
      p.then(done, done);
    }
    return p;
  };
  return async (c, next) => {
    if (isRootRoute(c.req.method, c.req.path)) return next();
    const claim = c.get("user") as UserClaim | undefined;
    // (agentUser has refused a request without a claim already; this is the last line)
    if (!claim || (claim.kind !== "sys" && claim.kind !== "virt") || typeof claim.epoch !== "number") return json("no user", 401);
    const who = `${claim.kind}:${claim.name}`;
    const seen = epochs.get(who);
    if (seen !== undefined && claim.epoch < seen) return json("account changed", 401);
    if (seen === undefined || claim.epoch > seen) {
      epochs.set(who, claim.epoch); // (before the wait, so a second request at the new epoch does not stop the account again)
      // the pool takes the old workers out of its map at once, so this request cannot reach one; a new start waits for their exit
      // (with the epoch, so a request at the old one that already waits inside the pool for a start is refused there too)
      if (seen !== undefined) await o.pool.stopAccount(claim.kind, claim.name, claim.epoch);
    }
    const key = workerKey(claim);
    const name = claim.kind === "sys" ? claim.name : claim.runAs;
    let account: LocalAccount | null;
    try {
      account = typeof name === "string" ? await lookup(key, name) : null;
    } catch (e) {
      log(`worker ${key}: account lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return json("account lookup failed; try again", 503);
    }
    if (!account || account.uid === 0 || account.gid === 0) return json("no account on this machine", 403);
    let spec: WorkerSpec;
    try {
      spec = await o.spec(claim, account);
    } catch (e) {
      log(`worker ${key}: not started: ${e instanceof Error ? e.message : String(e)}`);
      return json(e instanceof UnsafeFolders ? "worker folders are not safe" : "worker failed to start", 503);
    }
    // the epoch may have risen while this request waited above: it must not start (or reach) a worker for the old one
    if (epochs.get(who) !== claim.epoch) return json("account changed", 401);
    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    for (const h of DROP_REQUEST) headers.delete(h);
    const hasBody = raw.method !== "GET" && raw.method !== "HEAD" && raw.body !== null;
    // the client's signal goes with it: a client that goes away ends the request in the worker and frees its slot
    const req = new Request(raw.url, { method: raw.method, headers, body: hasBody ? raw.body : null, signal: raw.signal, duplex: "half" } as RequestInit);
    let res: Response;
    try {
      res = await o.pool.fetch(spec, req);
    } catch (e) {
      if (e instanceof StaleEpoch) return json("account changed", 401);
      if (e instanceof PoolFull) return json("too many people are using this machine; try again", 503, { "retry-after": "5" });
      if (e instanceof WorkerGone) return json("worker stopped", 503);
      if (raw.signal.aborted) return new Response(null, { status: 499 });
      log(`worker ${key}: request failed: ${e instanceof Error ? e.message : String(e)}`);
      return json("worker error", 500);
    }
    return clientResponse(res, key, log, raw.signal, raw.method);
  };
}

export { UnsafeFolders };

export interface WorkerSpecs {
  /** the `spec` of `workerGate` */
  spec: (claim: UserClaim, account: LocalAccount) => Promise<WorkerSpec>;
  /** the workers' area of this agent */
  base: string;
  /** removes the area once no worker runs (see `removeArea`); what cannot be removed is logged and left */
  close(): Promise<void>;
}

/**
 * The specs of the workers: the start-up message from `workerConfig` (no secret), the account's folders (`accountDirs`) and, for a virtual
 * account, its Landlock roots (`landlockRoots`, opened only when a worker starts). The workers' area is made new for this agent (`mkdtemp`
 * in the temporary folder: root's and 0711 when the agent runs as root, else 0700), kept while it runs and removed by `close` (the agent
 * calls it in `leave`; see `removeArea`). An area that exists already is never used. The folders of a key are made once (also while
 * several requests wait for them) and made again only after a start with them failed. `live` gives the keys of the running workers: the
 * index folder of one of them is never removed as an old one.
 */
export function makeWorkerSpecs(
  cfg: Config,
  o: { afterMkdir?: Hook; log?: (s: string) => void; onRootList?: (dir: string) => void; onEmpty?: (dir: string) => void; live?: () => string[] } = {},
): WorkerSpecs {
  const log = o.log ?? ((s) => console.error(s));
  // (an area left by an agent that was killed stays: it is root's and 0711, and removing it safely would need its accounts)
  const base = fsc.mkdtempSync(path.join(os.tmpdir(), "filedeck-workers-"));
  // held from here on: the temporary folder may let others rename the area and put a link in its place, so the area is only used through this
  const areaFd = fsc.openSync(base, OPEN_DIR);
  fsc.fchmodSync(areaFd, process.getuid?.() === 0 ? 0o711 : 0o700);
  const area = inHeld({ fd: areaFd });
  // (as root: a cache folder on a volume made 0777 becomes 0755, so it can hold the accounts' folders)
  tightenTop(cfg.thumbDir, log);
  tightenTop(cfg.indexDir, log);
  /** per key folder and uid, the folders once made */
  const ready = new Map<string, Promise<AccountDirs & { removed?: string[] }>>();
  /** the index folder names being made now (not removed as old ones meanwhile) */
  const making = new Map<string, number>();
  const inUse = (name: string) => (making.get(name) ?? 0) > 0 || (o.live?.() ?? []).some((k) => virtKeyDir(k) === name);
  const prepare = (claim: UserClaim, account: LocalAccount, key: string) => {
    const name = keyDir(claim, account, key);
    const id = `${name}:${account.uid}`;
    let p = ready.get(id);
    if (!p) {
      making.set(name, (making.get(name) ?? 0) + 1);
      p = accountDirs(cfg, area, claim, account, key, { hook: o.afterMkdir, log, inUse }).finally(() => {
        const n = (making.get(name) ?? 1) - 1;
        if (n > 0) making.set(name, n);
        else making.delete(name);
      });
      ready.set(id, p);
      p.then(
        // an old index folder that was removed: a later request for its key makes it again
        (d) => {
          for (const gone of d.removed ?? []) for (const k of ready.keys()) if (k.startsWith(`${gone}:`)) ready.delete(k);
        },
        () => ready.get(id) === p && ready.delete(id), // a failure is tried again on the next request
      );
    }
    return { id, p };
  };
  const spec = async (claim: UserClaim, account: LocalAccount): Promise<WorkerSpec> => {
    const key = workerKey(claim);
    const { id, p } = prepare(claim, account, key);
    const d = await p;
    // the worker gets the paths; this process opens the folders through the held area
    const tmp = path.join(base, path.relative(area, d.tmp));
    const thumbs = d.thumbs.startsWith(area + "/") ? path.join(base, path.relative(area, d.thumbs)) : d.thumbs;
    const grants = claim.kind === "virt" ? (claim.grants ?? []).flatMap((g) => (validGrant(g.path) ? [{ path: grantPath(g.path), write: g.write === true }] : [])) : undefined;
    // A grant that does not allow writing is also a read-only prefix of the worker (a second layer under the worker's grant check, which
    // also covers what Landlock does not: modes, owners, times), unless a writable grant lies below it: a prefix has no exceptions, so
    // there the grant check alone decides (`mayChange`: the deepest grant over a path).
    const under = (a: string, b: string) => b === "/" || a === b || a.startsWith(b + "/");
    const readOnly = grants
      ? [...cfg.readOnly, ...grants.filter((g) => !g.write && !grants.some((w) => w.write && w.path !== g.path && under(w.path, g.path))).map((g) => g.path)]
      : cfg.readOnly;
    return {
      key,
      kind: claim.kind,
      name: claim.name,
      epoch: claim.epoch,
      account,
      init: {
        cfg: { ...workerConfig(cfg, { thumbs, index: d.index }), readOnly },
        account: { kind: claim.kind, name: claim.name, uid: account.uid },
        trashFolder: trashFolder(claim, account),
        ...(grants ? { grants } : {}),
      },
      tmp,
      // a virtual account is confined to its grants (Landlock, and the worker's own grant check); a system account's limit is its uid
      openLandlock: claim.kind === "virt" ? () => landlockRoots(cfg, claim, d, log) : undefined,
      // the folders may be what failed (removed, or changed): the next start makes and checks them again
      startFailed: () => {
        if (ready.get(id) === p) ready.delete(id);
      },
    };
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= removeArea(base, log, o.onRootList, o.onEmpty, areaFd).finally(() => {
      try {
        fsc.closeSync(areaFd);
      } catch {
        /* already closed */
      }
    }));
  return { spec, base, close };
}

/** A grant path that can be compared (no `..`, no NUL); others are left out. */
function validGrant(p: unknown): p is string {
  try {
    return typeof p === "string" && grantPath(p) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The folders of one key (see account-dirs.ts): `tmp` in the key folder below the workers' area `base` (the held area's path, as this
 * process uses it), `thumbs` = `<thumbDir>/accounts/u<uid>` (in `tmp` when there is no thumbnail folder), and `index` =
 * `<indexDir>/accounts/<key folder>` (empty without an index folder). For a
 * virtual account, the index folders of its earlier grants are then removed (`removed` names them), unless `inUse`.
 */
export async function accountDirs(
  cfg: Config,
  base: string,
  claim: UserClaim,
  account: LocalAccount,
  key: string,
  o: { hook?: Hook; log?: (s: string) => void; inUse?: (name: string) => boolean } = {},
): Promise<AccountDirs & { removed?: string[] }> {
  const log = o.log ?? ((s) => console.error(s));
  const name = keyDir(claim, account, key);
  const tmp = await keyFolder(path.join(base, name), account, o.hook);
  const thumbs = cfg.thumbDir ? await cacheDir(cfg.thumbDir, `u${account.uid}`, account, "thumbs", o.hook) : path.join(tmp, "thumbs");
  if (!cfg.indexDir) return { tmp, thumbs, index: "" };
  const index = await cacheDir(cfg.indexDir, name, account, "index", o.hook);
  const removed = claim.kind === "virt" ? await removeOldIndexDirs(cfg.indexDir, virtOwner(claim.name), name, o.inUse ?? (() => false), log) : [];
  return { tmp, thumbs, index, removed };
}
