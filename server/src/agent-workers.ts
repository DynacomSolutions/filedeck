import { createHash } from "node:crypto";
import fsc from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { USER_HEADER, type UserClaim } from "./auth/identity.ts";
import { workerConfig, type Config } from "./config.ts";
import { validSystemName, type AccountResolver, type LocalAccount } from "./local-accounts.ts";
import { PoolFull, type WorkerPool, type WorkerSpec } from "./worker-pool.ts";
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
 * (also every header that its `connection` header names) are dropped. A body that fails after the head ends with an error that holds
 * none of the worker's text; the text is logged (not when `signal`, the client's, has aborted: then the client ended it).
 */
export function clientResponse(res: Response, key: string, log: (s: string) => void, signal?: AbortSignal): Response {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599) {
    void res.body?.cancel().catch(() => {});
    log(`worker ${key}: answer with status ${res.status}`);
    return json("bad answer from the worker", 502);
  }
  const named = new Set((res.headers.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const headers = new Headers();
  for (const [k, v] of res.headers) if (!DROP_RESPONSE.has(k) && !k.startsWith("proxy-") && !named.has(k)) headers.append(k, v);
  if (NULL_BODY.has(res.status) || !res.body) {
    void res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers });
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
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
 * 503 `worker stopped` (`WorkerGone` before the head), and 500 `worker error` for any other failure (its text only in the log).
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
      if (seen !== undefined) await o.pool.stopAccount(claim.kind, claim.name);
    }
    const key = workerKey(claim);
    const name = claim.kind === "sys" ? claim.name : claim.runAs;
    let account: LocalAccount | null;
    try {
      account = typeof name === "string" ? await o.accounts.resolve(name, !o.pool.list().some((w) => w.key === key)) : null;
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
      return json("worker failed to start", 503);
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
      if (e instanceof PoolFull) return json("too many people are using this machine; try again", 503, { "retry-after": "5" });
      if (e instanceof WorkerGone) return json("worker stopped", 503);
      if (raw.signal.aborted) return new Response(null, { status: 499 });
      log(`worker ${key}: request failed: ${e instanceof Error ? e.message : String(e)}`);
      return json("worker error", 500);
    }
    return clientResponse(res, key, log, raw.signal);
  };
}

/**
 * Makes `<dir>` a folder (not a link) with `mode`, owned by `owner` when this process is root (else by this process, and one that
 * belongs to someone else is refused). Done through a descriptor opened without following a link, so a link put in its place is never
 * followed and something that is not a folder is refused.
 */
async function ownedDir(dir: string, mode: number, owner?: { uid: number; gid: number }): Promise<void> {
  await fs.mkdir(dir, { mode }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const fh = await fs.open(dir, fsc.constants.O_RDONLY | fsc.constants.O_DIRECTORY | fsc.constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    const me = process.getuid?.() ?? 0;
    // root gives the folder to the account, whoever has it now (only root can make entries in the area); anyone else must own it already
    const want = owner && me === 0 ? owner : { uid: me, gid: st.gid };
    if (me !== 0 && st.uid !== me) throw new Error(`${dir} belongs to uid ${st.uid}`);
    if (st.uid !== want.uid || st.gid !== want.gid) await fh.chown(want.uid, want.gid);
    if ((st.mode & 0o7777) !== mode) await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

/** The folder name of one key under the workers' area: `u<uid>` for a system account, `v-<name>-<grants hash>` for a virtual one. */
function keyDir(claim: UserClaim, account: LocalAccount, key: string): string {
  if (claim.kind === "sys") return `u${account.uid}`;
  const name = validSystemName(claim.name) ? claim.name : "x";
  return `v-${name}-${key.slice(key.lastIndexOf(":") + 1)}`;
}

/**
 * The `spec` of `workerGate`: the worker's start-up message from `workerConfig` (no secret) with its own temporary, thumbnail and index
 * folders under `<tmp>/filedeck-workers/<key folder>/` (the area itself 0711 and this process's own; each key's folders 0700 and the
 * account's). Task 7 replaces these folders (`accountDirs`) and adds Landlock for virtual accounts; until then no spec has Landlock.
 */
export function makeWorkerSpec(cfg: Config, o: { base?: string } = {}): (claim: UserClaim, account: LocalAccount) => Promise<WorkerSpec> {
  const base = o.base ?? path.join(os.tmpdir(), "filedeck-workers");
  return async (claim, account) => {
    const key = workerKey(claim);
    const dir = path.join(base, keyDir(claim, account, key));
    const owner = { uid: account.uid, gid: account.gid };
    await ownedDir(base, 0o711);
    await ownedDir(dir, 0o700, owner);
    const tmp = path.join(dir, "tmp");
    const thumbs = path.join(dir, "thumbs");
    const index = path.join(dir, "index");
    for (const d of [tmp, thumbs, index]) await ownedDir(d, 0o700, owner);
    return {
      key,
      kind: claim.kind,
      name: claim.name,
      epoch: claim.epoch,
      account,
      init: {
        cfg: workerConfig(cfg, { thumbs, index }),
        account: { kind: claim.kind, name: claim.name, uid: account.uid },
        trashFolder: claim.kind === "sys" ? `u${account.uid}` : `v-${claim.name}`,
      },
      tmp,
    };
  };
}
