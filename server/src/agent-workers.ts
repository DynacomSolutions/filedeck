import { createHash } from "node:crypto";
import fsc from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { USER_HEADER, type UserClaim } from "./auth/identity.ts";
import { workerConfig, type Config } from "./config.ts";
import { type AccountResolver, type LocalAccount } from "./local-accounts.ts";
import { PoolFull, StaleEpoch, type WorkerPool, type WorkerSpec } from "./worker-pool.ts";
import { WorkerGone } from "./worker-proto.ts";
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
export function clientResponse(res: Response, key: string, log: (s: string) => void, signal?: AbortSignal): Response {
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
  if (NULL_BODY.has(res.status) || !res.body) {
    void res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers });
  }
  const reader = res.body.getReader();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
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
    return clientResponse(res, key, log, raw.signal);
  };
}

/** A worker folder that this process did not make just now is not the account's own and private, or is not a folder at all. */
export class UnsafeFolders extends Error {
  constructor(why: string) {
    super(why);
    this.name = "UnsafeFolders";
  }
}

const OPEN_DIR = fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY | fsc.constants.O_NOFOLLOW;

/**
 * One folder of an account below the workers' area, mode 0700 and owned by the account. A folder this call makes is given to the account
 * (as root) through a descriptor. One that is already there is never changed: it must be the account's own and not writable by group or
 * others, else `UnsafeFolders`. This is enough because the area is root's alone (0711), so the account cannot replace its own key folder;
 * it can replace only the last part of a path in its own folder, and the open without following a link (`O_NOFOLLOW`, `O_DIRECTORY`)
 * refuses a link or a file there.
 */
async function accountDir(dir: string, account: LocalAccount): Promise<void> {
  let made = true;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    made = false;
  }
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(dir, OPEN_DIR);
  } catch (e) {
    throw new UnsafeFolders(`${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    const st = await fh.stat();
    if (made) {
      if (process.getuid?.() === 0 && (st.uid !== account.uid || st.gid !== account.gid)) await fh.chown(account.uid, account.gid);
      await fh.chmod(0o700);
    } else if (st.uid !== account.uid || (st.mode & 0o022) !== 0) {
      throw new UnsafeFolders(`${dir} has owner ${st.uid} and mode ${(st.mode & 0o7777).toString(8)}; the account is ${account.uid}`);
    }
  } finally {
    await fh.close();
  }
}

/**
 * The owner part of a virtual account's folder names (`v-<this>`, also its trash folder): its name when it fits the folder name rule
 * (Task 8's `TRASH_OWNER`), else `h` and 16 hex of its hash.
 */
function virtOwner(name: string): string {
  return /^[a-z_][a-z0-9_.-]{0,31}$/.test(name) ? name : `h${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

/** The trash folder of an account: `u<uid>` for a system account, `v-<owner>` for a virtual one. */
function trashFolder(claim: UserClaim, account: LocalAccount): string {
  return claim.kind === "sys" ? `u${account.uid}` : `v-${virtOwner(claim.name)}`;
}

/**
 * The folder of one key under the workers' area: the trash folder name, and for a virtual account its grants hash as well. Two system
 * names with one uid share `u<uid>` (they are the same user to the kernel).
 */
function keyDir(claim: UserClaim, account: LocalAccount, key: string): string {
  const owner = trashFolder(claim, account);
  return claim.kind === "sys" ? owner : `${owner}-${key.slice(key.lastIndexOf(":") + 1)}`;
}

export interface WorkerSpecs {
  /** the `spec` of `workerGate` */
  spec: (claim: UserClaim, account: LocalAccount) => Promise<WorkerSpec>;
  /** the workers' area of this agent */
  base: string;
  /** removes the area (once no worker runs) */
  close(): void;
}

/**
 * The specs of the workers: the start-up message from `workerConfig` (no secret), and per key a temporary, a thumbnail and an index
 * folder in `<key folder>/` below an area made new for this agent (`mkdtemp` in the temporary folder: root's and 0711 when the agent
 * runs as root, else 0700), kept while it runs and removed by `close`. An area that exists already is never used. The folders of a key
 * are made once (also while several requests wait for them) and made again only after a start with them failed. Task 7 replaces these
 * folders (`accountDirs`, which must follow the same rules) and adds Landlock for virtual accounts; until then no spec has Landlock.
 */
export function makeWorkerSpecs(cfg: Config): WorkerSpecs {
  const base = fsc.mkdtempSync(path.join(os.tmpdir(), "filedeck-workers-"));
  fsc.chmodSync(base, process.getuid?.() === 0 ? 0o711 : 0o700);
  /** per key folder and uid, the folders once made */
  const ready = new Map<string, Promise<{ tmp: string; thumbs: string; index: string }>>();
  const prepare = (dir: string, account: LocalAccount) => {
    const id = `${dir}:${account.uid}`;
    let p = ready.get(id);
    if (!p) {
      p = (async () => {
        await accountDir(dir, account);
        const d = { tmp: path.join(dir, "tmp"), thumbs: path.join(dir, "thumbs"), index: path.join(dir, "index") };
        for (const sub of [d.tmp, d.thumbs, d.index]) await accountDir(sub, account);
        return d;
      })();
      ready.set(id, p);
      p.catch(() => ready.get(id) === p && ready.delete(id)); // a failure is tried again on the next request
    }
    return { id, p };
  };
  const spec = async (claim: UserClaim, account: LocalAccount): Promise<WorkerSpec> => {
    const key = workerKey(claim);
    const { id, p } = prepare(path.join(base, keyDir(claim, account, key)), account);
    const d = await p;
    return {
      key,
      kind: claim.kind,
      name: claim.name,
      epoch: claim.epoch,
      account,
      init: {
        cfg: workerConfig(cfg, { thumbs: d.thumbs, index: d.index }),
        account: { kind: claim.kind, name: claim.name, uid: account.uid },
        trashFolder: trashFolder(claim, account),
      },
      tmp: d.tmp,
      // the folders may be what failed (removed, or changed): the next start makes and checks them again
      startFailed: () => {
        if (ready.get(id) === p) ready.delete(id);
      },
    };
  };
  return { spec, base, close: () => fsc.rmSync(base, { recursive: true, force: true }) };
}
