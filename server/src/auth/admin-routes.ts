import type { Context, Hono } from "hono";
import type { Config } from "../config.ts";
import type { Vault } from "../vault.ts";
import type { Identity, NodeAccess } from "./identity.ts";
import { AccountError, hashPasswordAsync, type Accounts } from "./store.ts";
import type { Sessions, SessionInfo } from "./sessions.ts";
import type { SourceAccess, SourceGrants } from "./source-grants.ts";
import { currentUser } from "./context.ts";
import { sessionKeyOf } from "./routes.ts";
import { keyFingerprint } from "./sshkey.ts";
import { InputError, MAX_KEYS, accountName, newPassword, nodeAccess, publicKey, sourceAccess, systemName, tailnetLinks } from "./account-input.ts";
import { LinkTaken, type Link, type TailnetLinks } from "./tailnet-links.ts";

/**
 * The admin routes (`/api/admin/*`, hub, sign-in on only). A gate in front of them lets through only a caller with a session (never the
 * `du` API token) whose account is an administrator at that very moment: a system user named in FILEDECK_ADMINS, or a virtual account
 * whose stored `admin` flag is true. It reads both on every call, so a flag taken away ends access at the next call, without signing
 * in again. Every call, GET too, gets an audit line (audit.ts, `adminBody`). Every change to an account goes through `changed`.
 */

export interface AdminDeps {
  cfg: Config;
  accounts: Accounts;
  sessions: Sessions;
  sourceGrants: SourceGrants;
  vault: Pick<Vault, "forgetAll" | "countUnowned" | "forgetUnowned">;
  /** the configured machines, by name */
  nodes: string[];
  /** the network sources */
  sources: { name: string; type: string }[];
  /** The tailnet links (logins and tags) of every account. */
  links: TailnetLinks;
  /** The configured Tailscale source, or null when none is: decides whether a link counts for the last administrator (`lockOut`). */
  tailscale: "socket" | "headers" | null;
  /** Whether a system user exists on a machine: true, false, or undefined when the machine did not answer. */
  systemExists?: (node: string, name: string) => Promise<boolean | undefined>;
  /**
   * Called when an ended session held an act-as-root switch (the hub's `onAsRootEnd`, as at sign-out): the jobs started under that
   * switch are cancelled on the machines. A rejection is ignored.
   */
  onAsRootEnd?: (name: string, until: number) => Promise<void>;
  /** The hub's `accountChanged`: epoch raised, sessions and streams ended, hub and agent jobs cancelled. `before` is from before the change. */
  changed: (before: Identity) => Promise<void>;
}

/** Whether `id` is an administrator now: read from FILEDECK_ADMINS and the store, never from the identity's own `admin`. */
export function isAdmin(cfg: Config, accounts: Accounts, id: Identity | undefined): boolean {
  if (!id) return false;
  if (id.kind === "sys") return cfg.admins.includes(id.name);
  return accounts.get(id.name)?.admin === true;
}

const notFound = (c: Context) => c.json({ error: "not found" }, 404);

/** A virtual account as administrators see it: never its password hash, keys only as fingerprint, type and comment. */
export type AccountView = {
  name: string;
  admin: boolean;
  hasPassword: boolean;
  keys: { fingerprint: string; type: string; comment?: string }[];
  nodes: Record<string, NodeAccess>;
  sources: Record<string, SourceAccess>;
  sessions: number;
  /** its tailnet links, by subject */
  tailnet: Link[];
};

/** A system user the hub knows of: named in FILEDECK_ADMINS, given a source grant or a tailnet link, or signed in now. */
export type SystemView = { name: string; admin: boolean; sources: Record<string, SourceAccess>; sessions: number; tailnet: Link[] };

type TailnetMode = AdminDeps["tailscale"];

/** Whether a list of links holds one that can sign in with `mode`: as `TailnetLinks.counts`, on a list not yet written. */
const listCounts = (list: readonly Link[], mode: TailnetMode): boolean =>
  mode === "socket" ? list.length > 0 : mode === "headers" ? list.some((l) => l.kind === "login") : false;

const NO_ADMIN_LEFT = "this would leave no administrator who can sign in";

/**
 * Whether `change` to the virtual account `change.name` would leave no administrator who can sign in (a virtual account with the admin
 * flag and a password, a key, or a tailnet link that counts for `mode`: docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md,
 * decision 7; no link counts with no source, and only a login link with the headers source). Only when FILEDECK_ADMINS is empty: system
 * administrators come from there, and no screen can take them away. `password: null` removes the password, `keysLeft` is how many keys it
 * keeps, `links` the tailnet links it keeps, `deleted` removes the account. Read from the store as it is now, so the caller runs it in the
 * same store transaction as the write, with no `await` between them.
 */
export function lockOut(
  cfg: Config,
  accounts: Accounts,
  links: Pick<TailnetLinks, "counts">,
  mode: TailnetMode,
  change: { name: string; admin?: boolean; password?: null; keysLeft?: number; links?: readonly Link[]; deleted?: true },
): boolean {
  if (cfg.admins.length > 0) return false;
  return !accounts.list().some((a) => {
    if (a.name !== change.name) return a.admin && (a.passwordHash !== null || accounts.keys(a.name).length > 0 || links.counts("virt", a.name, mode));
    if (change.deleted) return false;
    const admin = change.admin ?? a.admin;
    const password = change.password === null ? false : a.passwordHash !== null;
    const keys = change.keysLeft ?? accounts.keys(a.name).length;
    const linked = change.links ? listCounts(change.links, mode) : links.counts("virt", a.name, mode);
    return admin && (password || keys > 0 || linked);
  });
}

/** A refusal decided inside a store transaction: thrown there (so it rolls back) and answered with this status and text. */
class Refused extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** A stored key line as administrators see it. */
function keyView(line: string): AccountView["keys"][number] | undefined {
  const fingerprint = keyFingerprint(line);
  const m = /^(\S+)\s+\S+(?:\s+(.*))?$/.exec(line.trim());
  if (!fingerprint || !m) return undefined;
  const comment = m[2]?.trim();
  return { fingerprint, type: m[1]!, ...(comment ? { comment } : {}) };
}

/** Sign-in off: there are no admin routes, and `/api/admin/*` is 404 (not the web app). */
export function registerAdminOff(app: Hono): void {
  app.all("/api/admin/*", notFound);
}

export function registerAdmin(app: Hono, deps: AdminDeps): void {
  const { cfg, accounts, sessions, vault } = deps;

  app.use("/api/admin/*", async (c, next) => {
    if (sessionKeyOf(c) === undefined || !isAdmin(cfg, accounts, currentUser())) return c.json({ error: "administrators only" }, 403);
    await next();
  });

  /** A JSON object body, or an InputError. */
  const objectBody = async (c: Context): Promise<Record<string, unknown>> => {
    const b = (await c.req.json().catch(() => undefined)) as unknown;
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new InputError("the body must be a JSON object");
    return b as Record<string, unknown>;
  };
  /**
   * Runs a route; an InputError becomes 400 with its text (which never repeats a password or a key), a `Refused` its own status, and the
   * store's "exists" and "no such account" 409 and 404.
   */
  const checked = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof InputError) return c.json({ error: e.message }, 400);
      if (e instanceof Refused) return c.json({ error: e.message }, e.status);
      // a login or tag linked to another account (the primary key decided it, inside the transaction, which rolled back)
      if (e instanceof LinkTaken) return c.json({ error: e.message }, 409);
      if (e instanceof AccountError && e.message === "exists") return c.json({ error: "exists" }, 409);
      if (e instanceof AccountError && e.message === "no such account") return notFound(c);
      throw e;
    }
  };

  app.get("/api/admin/overview", (c) =>
    c.json({ nodes: [...deps.nodes], sources: deps.sources.map((s) => ({ name: s.name, type: s.type })), systemAdmins: [...cfg.admins], unownedPasswords: vault.countUnowned(), tailscale: deps.tailscale }),
  );

  app.get("/api/admin/sessions", (c) => {
    const key = sessionKeyOf(c);
    const mine = key === undefined ? undefined : sessions.publicId(key);
    const list: (SessionInfo & { current?: true })[] = sessions.list().map((s) => (s.id === mine ? { ...s, current: true as const } : s));
    return c.json({ sessions: list });
  });

  // One session ends (its streams too); the account epoch stays and its jobs go on: they belong to the account, not the session. Its
  // act-as-root switch ends with it exactly as at sign-out: read first, then the session goes, then the switch's root jobs are cancelled.
  app.delete("/api/admin/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const s = sessions.list().find((x) => x.id === id);
    const was = s?.kind === "sys" && s.asRootUntil !== undefined ? { name: s.name, until: s.asRootUntil } : undefined;
    if (!sessions.endById(id)) return notFound(c);
    if (was && deps.onAsRootEnd) await deps.onAsRootEnd(was.name, was.until).catch(() => undefined);
    return c.json({ ok: true });
  });

  // Every session of one account ends: through `changed`, so its epoch rises and its jobs are cancelled too.
  app.post(
    "/api/admin/end-sessions",
    checked(async (c) => {
      const b = await objectBody(c);
      let before: Identity;
      if (b.kind === "virt") {
        if (typeof b.name !== "string") throw new InputError("name must be text");
        const id = accounts.identity("virt", b.name);
        if (!id) return notFound(c);
        before = id;
      } else if (b.kind === "sys") {
        const name = systemName(b.name);
        before = { kind: "sys", name, admin: cfg.admins.includes(name), epoch: accounts.epochOf("sys", name) };
      } else throw new InputError("kind must be sys or virt");
      await deps.changed(before);
      return c.json({ ok: true });
    }),
  );

  // Saved passwords from when sign-in was off have no owner and serve nobody now.
  app.delete("/api/admin/vault/unowned", (c) => c.json({ removed: vault.forgetUnowned() }));

  /* ------------------------------------------------------------------------------------------------------------- virtual accounts */

  const knownNodes = () => new Set(deps.nodes);
  const knownSources = () => new Set(deps.sources.map((x) => x.name));
  /** How many valid sessions each `kind:name` has now. */
  const sessionCounts = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of sessions.list()) m.set(`${s.kind}:${s.name}`, (m.get(`${s.kind}:${s.name}`) ?? 0) + 1);
    return m;
  };
  const view = (name: string, counts = sessionCounts()): AccountView | undefined => {
    const a = accounts.get(name);
    if (!a) return undefined;
    return {
      name: a.name,
      admin: a.admin,
      hasPassword: a.passwordHash !== null,
      keys: accounts.keys(a.name).flatMap((l) => keyView(l) ?? []),
      nodes: a.nodes,
      sources: deps.sourceGrants.forAccount("virt", a.name),
      sessions: counts.get(`virt:${a.name}`) ?? 0,
      tailnet: deps.links.forAccount("virt", a.name),
    };
  };
  /** A system user as administrators see it. */
  const systemView = (name: string, counts = sessionCounts()): SystemView => ({
    name,
    admin: cfg.admins.includes(name),
    sources: deps.sourceGrants.forAccount("sys", name),
    sessions: counts.get(`sys:${name}`) ?? 0,
    tailnet: deps.links.forAccount("sys", name),
  });
  /** The view after a change, or 404 when the account went meanwhile (another administrator deleted it). */
  const answer = (c: Context, name: string, status: 200 | 201 = 200) => {
    const v = view(name);
    return v ? c.json(v, status) : notFound(c);
  };
  /**
   * The gate's check again, inside the store transaction: a route that waited on the machines (or for the hash) may have outlived the
   * caller's admin flag or session. Either gone: `Refused` 403, and nothing is written.
   */
  const callerHolds = (c: Context): void => {
    const key = sessionKeyOf(c);
    if (key === undefined || !sessions.peek(key) || !isAdmin(cfg, accounts, currentUser())) throw new Refused(403, "administrators only");
  };
  /** The current virtual account `name`, or `Refused` 404. For use inside the store transaction. */
  const current = (name: string): Identity => {
    const id = accounts.identity("virt", name);
    if (!id) throw new Refused(404, "not found");
    return id;
  };

  /**
   * Asks the machines, before any store write (decision 8): a machine that knows `name` as a system user refuses it (409); a machine
   * that says a `runAs` does not exist (or is root there) refuses it (400). A machine that does not answer blocks nothing.
   */
  const askMachines = async (name: string | undefined, nodes: Record<string, NodeAccess>): Promise<void> => {
    const ask = deps.systemExists;
    if (!ask) return;
    const q = (node: string, user: string) => ask(node, user).catch(() => undefined);
    const runAs = Object.entries(nodes);
    const [clash, users] = await Promise.all([
      name === undefined ? Promise.resolve([]) : Promise.all(deps.nodes.map((node) => q(node, name))),
      Promise.all(runAs.map(([node, a]) => q(node, a.runAs))),
    ]);
    const at = clash.findIndex((v) => v === true);
    if (at >= 0) throw new Refused(409, `a system user has this name on ${deps.nodes[at]}`);
    const missing = users.findIndex((v) => v === false);
    if (missing >= 0) {
      const [node, a] = runAs[missing]!;
      throw new InputError(`run-as user ${a.runAs} does not exist on ${node}`);
    }
  };

  /** Checked key lines, each fingerprint once (a repeated one: 409 `key already added`). */
  const keyList = (v: unknown): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new InputError("keys must be a list");
    if (v.length > MAX_KEYS) throw new InputError(`at most ${MAX_KEYS} keys per account`);
    const lines = v.map(publicKey);
    const fps = lines.map(keyFingerprint);
    if (new Set(fps).size !== fps.length) throw new Refused(409, "key already added");
    return lines;
  };

  app.get("/api/admin/accounts", (c) => {
    const counts = sessionCounts();
    const list = accounts.list().flatMap((a) => view(a.name, counts) ?? []);
    const names = new Set<string>([...cfg.admins, ...deps.sourceGrants.accounts("sys"), ...deps.links.accounts("sys")]);
    for (const s of sessions.list()) if (s.kind === "sys") names.add(s.name);
    const system: SystemView[] = [...names].sort().map((name) => systemView(name, counts));
    return c.json({ accounts: list, system });
  });

  app.post(
    "/api/admin/accounts",
    checked(async (c) => {
      const b = await objectBody(c);
      const name = accountName(b.name, cfg.admins);
      const password = b.password === undefined || b.password === null ? undefined : newPassword(b.password);
      if (b.admin !== undefined && typeof b.admin !== "boolean") throw new InputError("admin must be true or false");
      const admin = b.admin === true;
      const nodes = b.nodes === undefined ? {} : nodeAccess(b.nodes, knownNodes());
      const sources = b.sources === undefined ? {} : sourceAccess(b.sources, knownSources());
      const keys = keyList(b.keys);
      const tailnet = b.tailnet === undefined ? [] : tailnetLinks(b.tailnet);
      if (accounts.get(name)) throw new Refused(409, "exists");
      await askMachines(name, nodes);
      // hashed before the transaction, so the write lock is not held for it
      const passwordHash = password === undefined ? undefined : await hashPasswordAsync(password);
      // a new account has no sessions and no work, so nothing to end: no `changed`
      accounts.tx(() => {
        callerHolds(c);
        accounts.create({ name, passwordHash, admin, nodes });
        for (const k of keys) accounts.addKey(name, k);
        deps.sourceGrants.setForAccount("virt", name, sources);
        // always, `[]` too: links left under the name (as source grants) are never the new account's
        deps.links.setForAccount("virt", name, tailnet);
        // Saved passwords left under the name (one a late request saved for the deleted account of that name) are not this account's.
        // Only after `create` has passed: a create that loses with "exists" leaves the live account's entries alone.
        vault.forgetAll("virt:" + name);
      });
      return answer(c, name, 201);
    }),
  );

  app.patch(
    "/api/admin/accounts/:name",
    checked(async (c) => {
      const name = c.req.param("name") ?? "";
      if (!accounts.get(name)) return notFound(c);
      const b = await objectBody(c);
      const patch: { password?: null; passwordHash?: string; admin?: boolean; nodes?: Record<string, NodeAccess> } = {};
      const password = b.password === null || b.password === undefined ? b.password : newPassword(b.password);
      if (password === null) patch.password = null;
      if (b.admin !== undefined) {
        if (typeof b.admin !== "boolean") throw new InputError("admin must be true or false");
        patch.admin = b.admin;
      }
      if (b.nodes !== undefined) patch.nodes = nodeAccess(b.nodes, knownNodes());
      const sources = b.sources === undefined ? undefined : sourceAccess(b.sources, knownSources());
      const tailnet = b.tailnet === undefined ? undefined : tailnetLinks(b.tailnet);
      if (Object.keys(patch).length === 0 && password === undefined && sources === undefined && tailnet === undefined) {
        throw new InputError("nothing to change: give password, admin, nodes, sources or tailnet");
      }
      if (patch.nodes) await askMachines(undefined, patch.nodes);
      // hashed before the transaction, so the write lock is not held for it
      if (typeof password === "string") patch.passwordHash = await hashPasswordAsync(password);
      // the check and every write in one transaction, no await between them; `changed` after the commit
      const before = accounts.tx(() => {
        callerHolds(c);
        const id = current(name);
        if (
          (patch.admin === false || patch.password === null || tailnet !== undefined) &&
          lockOut(cfg, accounts, deps.links, deps.tailscale, {
            name,
            ...(patch.admin === false ? { admin: false } : {}),
            ...(patch.password === null ? { password: null } : {}),
            ...(tailnet !== undefined ? { links: tailnet } : {}),
          })
        ) {
          throw new Refused(409, NO_ADMIN_LEFT);
        }
        accounts.update(name, patch);
        if (sources) deps.sourceGrants.setForAccount("virt", name, sources);
        if (tailnet) deps.links.setForAccount("virt", name, tailnet);
        accounts.bumpEpoch("virt", name);
        return id;
      });
      await deps.changed(before);
      return answer(c, name);
    }),
  );

  app.post(
    "/api/admin/accounts/:name/keys",
    checked(async (c) => {
      const name = c.req.param("name") ?? "";
      if (!accounts.get(name)) return notFound(c);
      const b = await objectBody(c);
      const line = publicKey(b.publicKey);
      const fp = keyFingerprint(line);
      const before = accounts.tx(() => {
        callerHolds(c);
        const id = current(name);
        const have = accounts.keys(name);
        // the store keys rows on the whole line, comment included: the same key with another comment would be a second row
        if (have.some((l) => keyFingerprint(l) === fp)) throw new Refused(409, "key already added");
        if (have.length >= MAX_KEYS) throw new Refused(409, `at most ${MAX_KEYS} keys per account`);
        accounts.addKey(name, line);
        accounts.bumpEpoch("virt", name);
        return id;
      });
      await deps.changed(before);
      return answer(c, name);
    }),
  );

  app.delete(
    "/api/admin/accounts/:name/keys/:fingerprint",
    checked(async (c) => {
      const name = c.req.param("name") ?? "";
      const fp = c.req.param("fingerprint") ?? "";
      const before = accounts.tx(() => {
        callerHolds(c);
        const id = current(name);
        const have = accounts.keys(name);
        const left = have.filter((l) => keyFingerprint(l) !== fp).length;
        if (left === have.length) throw new Refused(404, "no such key");
        if (lockOut(cfg, accounts, deps.links, deps.tailscale, { name, keysLeft: left })) throw new Refused(409, NO_ADMIN_LEFT);
        accounts.removeKey(name, fp);
        accounts.bumpEpoch("virt", name);
        return id;
      });
      await deps.changed(before);
      return answer(c, name);
    }),
  );

  app.delete(
    "/api/admin/accounts/:name",
    checked(async (c) => {
      const name = c.req.param("name") ?? "";
      // One store transaction (BEGIN IMMEDIATE, so two hubs of a rollout cannot both pass the check): the check, the source grants and tailnet links, the
      // epoch, then the account and its keys. The old sessions end without the epoch (a session of a missing virtual account is invalid).
      // `remove` keeps the epoch in retired_accounts one above the live one, so the retired epoch (two above the epoch before the delete,
      // with the raise here) is above every epoch an agent or a running job saw, and a name made again starts above it.
      const before = accounts.tx(() => {
        callerHolds(c);
        const id = current(name);
        if (lockOut(cfg, accounts, deps.links, deps.tailscale, { name, deleted: true })) throw new Refused(409, NO_ADMIN_LEFT);
        deps.sourceGrants.removeAccount("virt", name);
        deps.links.removeAccount("virt", name);
        accounts.bumpEpoch("virt", name);
        accounts.remove(name);
        return id;
      });
      // The saved passwords live in another database, so they go after the commit. A failure there is logged and never skips `changed`
      // (a new account of this name forgets them when it is made).
      try {
        vault.forgetAll("virt:" + name);
      } catch (e) {
        console.error(`account change: the saved passwords of virt:${name} were not forgotten (${(e as Error).message}); a new account of that name forgets them`);
      }
      // sessions, streams and jobs end (epochOf now reads the retired epoch)
      await deps.changed(before);
      return c.json({ ok: true });
    }),
  );

  /* ------------------------------------------------------------------------------------------------------------------- system users */

  // A system user's network sources, replaced as a whole (`{}` takes them all away). Never root. The change ends the user's sessions,
  // streams and jobs, as every account change does.
  app.put(
    "/api/admin/system/:name/sources",
    checked(async (c) => {
      const name = systemName(c.req.param("name") ?? "");
      const b = await objectBody(c);
      const sources = sourceAccess(b.sources, knownSources());
      // the check and every write in one transaction, the epoch raised last; `changed` after the commit
      const before = accounts.tx((): Identity => {
        callerHolds(c);
        const id: Identity = { kind: "sys", name, admin: cfg.admins.includes(name), epoch: accounts.epochOf("sys", name) };
        deps.sourceGrants.setForAccount("sys", name, sources);
        accounts.bumpEpoch("sys", name);
        return id;
      });
      await deps.changed(before);
      return c.json(systemView(name));
    }),
  );

  // A system user's tailnet links, replaced as a whole (`[]` removes them all). Never root (`systemName`). A list that is not empty is
  // first checked against the machines, outside the transaction: when at least one machine answers and none says the user exists (a root
  // account answers no), it is refused; a machine that does not answer blocks nothing, and every Tailscale sign-in asks again. Then the
  // check, the links and the epoch in one transaction; `changed` after the commit, so sessions signed in through a removed link end.
  app.put(
    "/api/admin/system/:name/tailnet",
    checked(async (c) => {
      const name = systemName(c.req.param("name") ?? "");
      const b = await objectBody(c);
      const list = tailnetLinks(b.links);
      const ask = deps.systemExists;
      if (list.length > 0 && ask) {
        const answers = await Promise.all(deps.nodes.map((node) => ask(node, name).catch(() => undefined)));
        if (answers.some((v) => v !== undefined) && !answers.includes(true)) throw new InputError(`no machine has a system user ${name}`);
      }
      const before = accounts.tx((): Identity => {
        callerHolds(c);
        const id: Identity = { kind: "sys", name, admin: cfg.admins.includes(name), epoch: accounts.epochOf("sys", name) };
        deps.links.setForAccount("sys", name, list);
        accounts.bumpEpoch("sys", name);
        return id;
      });
      await deps.changed(before);
      return c.json(systemView(name));
    }),
  );

  // Any other admin path is 404, also for a GET (not the web app). Routes added later go above this line.
  app.all("/api/admin/*", notFound);
}
