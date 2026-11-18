import type { Context, Hono } from "hono";
import type { Config } from "../config.ts";
import type { Vault } from "../vault.ts";
import type { Identity } from "./identity.ts";
import type { Accounts } from "./store.ts";
import type { Sessions, SessionInfo } from "./sessions.ts";
import type { SourceGrants } from "./source-grants.ts";
import { currentUser } from "./context.ts";
import { sessionKeyOf } from "./routes.ts";
import { InputError, systemName } from "./account-input.ts";

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
  /** Runs a route; an InputError becomes 400 with its text (which never repeats a password or a key). */
  const checked = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof InputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };

  app.get("/api/admin/overview", (c) =>
    c.json({ nodes: [...deps.nodes], sources: deps.sources.map((s) => ({ name: s.name, type: s.type })), systemAdmins: [...cfg.admins], unownedPasswords: vault.countUnowned() }),
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

  // Any other admin path is 404, also for a GET (not the web app). Routes added later go above this line.
  app.all("/api/admin/*", notFound);
}
