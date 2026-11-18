import { createHash, randomBytes } from "node:crypto";
import type { AuthDb, Accounts } from "./store.ts";

/**
 * Session store (hub). The cookie value is 32 random bytes as base64url. Only
 * its SHA-256 is kept, so a copy of the database cannot be used to sign in.
 * A session ends when it is idle too long, when it is older than the absolute
 * limit, or when its account epoch is raised. `as_root_until` holds the end of a system administrator's "act as root"
 * switch (ms since the epoch), or NULL; it goes with the session (sign-out, `endAll` and an epoch rise end it too). `address` is
 * the client address at sign-in, or NULL, so administrators can see who is signed in from where. `method` is how the session was
 * started (`password`, `key` or `tailscale`; NULL for sessions made before it was kept). A Tailscale session also keeps the link subject
 * that matched (`tailnet_subject`: a login or a tag), the device's login (`tailnet_login`, when it had one) and, with the socket source,
 * the device's stable id (`tailnet_node`): the gate checks them again on every request (routes.ts). `tailnet_source` (`socket` or `headers`) and
 * `tailnet_device` (the device's cleaned name, when known) are kept only to show administrators how and from where it came in.
 */

export type SignInMethod = "password" | "key" | "tailscale";
/** How a session was started, as `create` takes it. */
export type SignInHow = { method: SignInMethod; tailnetSubject?: string; tailnetLogin?: string; tailnetNode?: string; tailnetSource?: "socket" | "headers"; tailnetDevice?: string };
/** A session as `lookup` gives it. */
export type SessionRecord = { kind: "sys" | "virt"; name: string; asRootUntil?: number } & Partial<SignInHow>;

const METHODS = new Set<string>(["password", "key", "tailscale"]);

/** A lookup writes `last_used` at most this often. */
const TOUCH_MS = 60_000;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** The key a session is kept under (the SHA-256 of the cookie value): the hub binds an act-as-root identity to it, never to the cookie. */
export const sessionKey = sha;

interface SessionRow {
  kind: "sys" | "virt";
  name: string;
  created: number;
  last_used: number;
  epoch: number;
  as_root_until: number | null;
  address: string | null;
  method: string | null;
  tailnet_subject: string | null;
  tailnet_login: string | null;
  tailnet_node: string | null;
  tailnet_source: string | null;
  tailnet_device: string | null;
}

/** The sign-in fields of a row, only those that are set. */
function howOf(r: Pick<SessionRow, "method" | "tailnet_subject" | "tailnet_login" | "tailnet_node">): Partial<SignInHow> {
  return {
    ...(r.method !== null && METHODS.has(r.method) ? { method: r.method as SignInMethod } : {}),
    ...(r.tailnet_subject !== null ? { tailnetSubject: r.tailnet_subject } : {}),
    ...(r.tailnet_login !== null ? { tailnetLogin: r.tailnet_login } : {}),
    ...(r.tailnet_node !== null ? { tailnetNode: r.tailnet_node } : {}),
  };
}

/** A session as administrators see it. `id` is `publicId` of its key, never the key. `asRootUntil` only while it is in the future. */
export type SessionInfo = {
  id: string;
  kind: "sys" | "virt";
  name: string;
  created: number;
  lastUsed: number;
  address?: string;
  asRootUntil?: number;
  /** how it was started, when known */
  method?: SignInMethod;
  /** a Tailscale session's link subject (the login or the tag that matched) */
  tailnet?: string;
  /** a Tailscale session's source: where the identity came from */
  tailnetSource?: "socket" | "headers";
  /** a Tailscale session's device name, when the source knew it */
  tailnetDevice?: string;
};

/** The id administrators see for the session kept under `key`: derived from the key, and no way back to it or to the cookie. */
export function publicId(key: string): string {
  return createHash("sha256").update("filedeck-session-id-v1:" + key).digest("hex").slice(0, 32);
}

/**
 * What `onEnd` hears: `key` when one session ended (sign-out, a sign-in that replaced it, or a lookup that found it expired), with
 * `asRoot` when only its act-as-root switch was set or cleared, `idle` (with `until`, its absolute end) when it ended by the idle limit
 * alone; `kind` and `name` when every session of an account was ended.
 */
export type SessionEnd = { key: string; asRoot?: true; idle?: true; until?: number } | { kind: "sys" | "virt"; name: string };

export class Sessions {
  private now: () => number;
  private ends: ((e: SessionEnd) => void)[] = [];

  constructor(
    private store: AuthDb,
    private acc: Accounts,
    private o: { idleMs: number; maxMs: number; now?: () => number },
  ) {
    this.now = o.now ?? Date.now;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        epoch INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_account ON sessions (kind, name);
    `);
    const cols = this.store.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "as_root_until")) this.store.db.exec("ALTER TABLE sessions ADD COLUMN as_root_until INTEGER");
    if (!cols.some((c) => c.name === "address")) this.store.db.exec("ALTER TABLE sessions ADD COLUMN address TEXT");
    for (const col of ["method", "tailnet_subject", "tailnet_login", "tailnet_node", "tailnet_source", "tailnet_device"]) {
      if (!cols.some((c) => c.name === col)) this.store.db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
    }
  }

  private get db() {
    return this.store.db;
  }

  /** Calls `fn` when a session (or its act-as-root switch) or every session of an account ends; see `SessionEnd`. */
  onEnd(fn: (e: SessionEnd) => void): void {
    this.ends.push(fn);
  }

  private ended(e: SessionEnd): void {
    for (const fn of this.ends) {
      try {
        fn(e);
      } catch {
        /* a listener never stops the session change itself */
      }
    }
  }

  /** The key a session is kept under for its cookie value (its SHA-256, hex). It stays inside the hub. */
  keyOf(raw: string): string {
    return sha(raw);
  }

  /** `publicId` of `key`: the id administrators see for that session. */
  publicId(key: string): string {
    return publicId(key);
  }

  /** The absolute end (sign-in time + the absolute limit, ms since the epoch) of the session kept under `key`, or undefined when there is none. */
  endsAt(key: string): number | undefined {
    const r = this.db.prepare("SELECT created FROM sessions WHERE id = ?").get(key) as Pick<SessionRow, "created"> | undefined;
    return r ? r.created + this.o.maxMs : undefined;
  }

  /**
   * Whether the session kept under `key` is valid now: by the idle and absolute limits, its account (a virtual one still exists) and its
   * epoch. Read only: it never writes `last_used` and never deletes (the hub asks it for each open event stream).
   */
  peek(key: string): boolean {
    const r = this.db.prepare("SELECT kind, name, created, last_used, epoch FROM sessions WHERE id = ?").get(key) as Pick<SessionRow, "kind" | "name" | "created" | "last_used" | "epoch"> | undefined;
    return r ? this.holds(r, this.now()) : false;
  }

  /**
   * The session kept under `key`: `valid` as `peek` finds it, `idle` when only the idle limit has passed (account and epoch still hold;
   * `until` its absolute end), else `gone`. Read only. Push subscriptions use it: a closed app goes idle, and its notifications go on.
   */
  state(key: string): { state: "valid" | "idle"; until: number } | { state: "gone" } {
    const r = this.db.prepare("SELECT kind, name, created, last_used, epoch FROM sessions WHERE id = ?").get(key) as Pick<SessionRow, "kind" | "name" | "created" | "last_used" | "epoch"> | undefined;
    if (!r) return { state: "gone" };
    const t = this.now();
    const until = r.created + this.o.maxMs;
    if (this.holds(r, t)) return { state: "valid", until };
    return t < until && this.holds({ ...r, last_used: t }, t) ? { state: "idle", until } : { state: "gone" };
  }

  /** `peek`'s test for one row. */
  private holds(r: Pick<SessionRow, "kind" | "name" | "created" | "last_used" | "epoch">, t: number): boolean {
    if (t - r.last_used > this.o.idleMs || t - r.created >= this.o.maxMs) return false;
    if (r.kind === "virt" && !this.acc.get(r.name)) return false;
    return this.acc.epochOf(r.kind, r.name) <= r.epoch;
  }

  /**
   * `address`: the client address at sign-in, kept to show administrators where a session came from. `how`: the sign-in method and, for
   * a Tailscale session, the identity it is bound to.
   */
  create(kind: "sys" | "virt", name: string, address?: string, how?: SignInHow): string {
    const raw = randomBytes(32).toString("base64url");
    const t = this.now();
    this.prune(t);
    this.db
      .prepare("INSERT INTO sessions (id, kind, name, created, last_used, epoch, address, method, tailnet_subject, tailnet_login, tailnet_node, tailnet_source, tailnet_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        sha(raw),
        kind,
        name,
        t,
        t,
        this.acc.epochOf(kind, name),
        address ?? null,
        how?.method ?? null,
        how?.tailnetSubject ?? null,
        how?.tailnetLogin ?? null,
        how?.tailnetNode ?? null,
        how?.tailnetSource ?? null,
        how?.tailnetDevice ?? null,
      );
    return raw;
  }

  /**
   * Deletes every session past the idle or absolute limit, by time alone (no account lookup), so ended sessions and their addresses
   * are not kept, and `endById` has few rows to look through. A valid session of a deleted account or an old epoch stays: `lookup`
   * deletes it and `list` leaves it out. Each one deleted is told to `onEnd`.
   */
  private prune(t: number): void {
    const gone = this.db.prepare("SELECT id, created FROM sessions WHERE ? - last_used > ? OR ? - created >= ?").all(t, this.o.idleMs, t, this.o.maxMs) as { id: string; created: number }[];
    if (gone.length === 0) return;
    const del = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const g of gone) del.run(g.id);
    for (const g of gone) {
      const until = g.created + this.o.maxMs;
      this.ended(t < until ? { key: g.id, idle: true, until } : { key: g.id });
    }
  }

  /** Every session that `peek` finds valid, newest `lastUsed` first. Read only, like `peek`. */
  list(): SessionInfo[] {
    const rows = this.db.prepare("SELECT id, kind, name, created, last_used, epoch, as_root_until, address, method, tailnet_subject, tailnet_login, tailnet_node, tailnet_source, tailnet_device FROM sessions ORDER BY last_used DESC, created DESC").all() as unknown as (SessionRow & { id: string })[];
    const t = this.now();
    return rows
      .filter((r) => this.holds(r, t))
      .map((r) => ({
        id: publicId(r.id),
        kind: r.kind,
        name: r.name,
        created: r.created,
        lastUsed: r.last_used,
        ...(r.address !== null ? { address: r.address } : {}),
        ...(typeof r.as_root_until === "number" && r.as_root_until > t ? { asRootUntil: r.as_root_until } : {}),
        ...(r.method !== null && METHODS.has(r.method) ? { method: r.method as SignInMethod } : {}),
        ...(r.method === "tailscale" && r.tailnet_subject !== null ? { tailnet: r.tailnet_subject } : {}),
        ...(r.method === "tailscale" && (r.tailnet_source === "socket" || r.tailnet_source === "headers") ? { tailnetSource: r.tailnet_source } : {}),
        ...(r.method === "tailscale" && r.tailnet_device !== null ? { tailnetDevice: r.tailnet_device } : {}),
      }));
  }

  /** How many valid sessions (as `list` counts them) one account has. */
  count(kind: "sys" | "virt", name: string): number {
    const rows = this.db.prepare("SELECT kind, name, created, last_used, epoch FROM sessions WHERE kind = ? AND name = ?").all(kind, name) as unknown as Pick<SessionRow, "kind" | "name" | "created" | "last_used" | "epoch">[];
    const t = this.now();
    return rows.filter((r) => this.holds(r, t)).length;
  }

  /** Ends the one session whose `publicId` is `id` (its streams end through `onEnd`). The account epoch stays. False when there is none. */
  endById(id: string): boolean {
    const keys = this.db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    const hit = keys.find((r) => publicId(r.id) === id);
    if (!hit) return false;
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(hit.id);
    this.ended({ key: hit.id });
    return true;
  }

  /** `asRootUntil` is the stored end of the act-as-root switch, as it is (the caller decides whether it still holds). */
  /**
   * `touch: false` leaves `last_used` as it is: the gate then calls `touch` only once it admits the request, so a request it refuses
   * (a Tailscale session used from outside the tailnet) does not keep the session alive.
   */
  lookup(raw: string, o: { touch?: boolean } = {}): SessionRecord | undefined {
    const id = sha(raw);
    const r = this.db
      .prepare("SELECT kind, name, created, last_used, epoch, as_root_until, method, tailnet_subject, tailnet_login, tailnet_node FROM sessions WHERE id = ?")
      .get(id) as Omit<SessionRow, "address"> | undefined;
    if (!r) return undefined;
    const t = this.now();
    const gone = (idle?: true) => {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.ended(idle ? { key: id, idle, until: r.created + this.o.maxMs } : { key: id });
      return undefined;
    };
    if (t - r.created >= this.o.maxMs) return gone();
    if (r.kind === "virt" && !this.acc.get(r.name)) return gone();
    if (this.acc.epochOf(r.kind, r.name) > r.epoch) return gone();
    if (t - r.last_used > this.o.idleMs) return gone(true);
    if (o.touch !== false && t - r.last_used >= TOUCH_MS) this.db.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").run(t, id);
    return { kind: r.kind, name: r.name, ...(typeof r.as_root_until === "number" ? { asRootUntil: r.as_root_until } : {}), ...howOf(r) };
  }

  /**
   * The session kept under `key` as `lookup` gives it, while `peek` finds it valid; undefined otherwise. Read only: it never writes
   * `last_used` and never deletes (the hub asks it for each open event stream of a Tailscale session).
   */
  recordOf(key: string): SessionRecord | undefined {
    const r = this.db
      .prepare("SELECT kind, name, created, last_used, epoch, as_root_until, method, tailnet_subject, tailnet_login, tailnet_node FROM sessions WHERE id = ?")
      .get(key) as Omit<SessionRow, "address"> | undefined;
    if (!r || !this.holds(r, this.now())) return undefined;
    return { kind: r.kind, name: r.name, ...(typeof r.as_root_until === "number" ? { asRootUntil: r.as_root_until } : {}), ...howOf(r) };
  }

  /** Ends the session kept under `key` (its streams end through `onEnd`), as `destroy` does for a cookie value. */
  endKey(key: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(key);
    this.ended({ key });
  }

  /** Writes the session's last use now (at most once a minute, as `lookup` does). An unknown session is left as it is. */
  touch(raw: string): void {
    const t = this.now();
    this.db.prepare("UPDATE sessions SET last_used = ? WHERE id = ? AND ? - last_used >= ?").run(t, sha(raw), t, TOUCH_MS);
  }

  /**
   * The act-as-root end stored for the session kept under `key` (`sessionKey`), while the session still holds by its idle and absolute
   * limits; undefined otherwise. Read only: it never writes `last_used` and never deletes (the hub asks it before each agent call).
   */
  asRootOf(key: string): number | undefined {
    const r = this.db.prepare("SELECT created, last_used, as_root_until FROM sessions WHERE id = ?").get(key) as Pick<SessionRow, "created" | "last_used" | "as_root_until"> | undefined;
    if (!r || typeof r.as_root_until !== "number") return undefined;
    const t = this.now();
    if (t - r.last_used > this.o.idleMs || t - r.created >= this.o.maxMs) return undefined;
    return r.as_root_until;
  }

  /**
   * The largest act-as-root end stored for the system account `name` in any of its sessions, live or not; undefined for none. Read only.
   * The hub starts its next switch end for the name above it, so a switch never gets an end a stored one has (also after a restart
   * with the clock stepped back).
   */
  lastAsRootUntil(name: string): number | undefined {
    const r = this.db.prepare("SELECT MAX(as_root_until) AS m FROM sessions WHERE kind = 'sys' AND name = ?").get(name) as { m: number | null } | undefined;
    return typeof r?.m === "number" ? r.m : undefined;
  }

  /**
   * The act-as-root switch ends still ahead in the sessions of system account `name`, each once, whatever the account's epoch now: an
   * account change raises the epoch first, and its switches then still have root jobs to cancel (the hub's `accountChanged`).
   */
  liveAsRootEnds(name: string): number[] {
    const rows = this.db.prepare("SELECT DISTINCT as_root_until AS u FROM sessions WHERE kind = 'sys' AND name = ? AND as_root_until > ?").all(name, this.now()) as { u: number }[];
    return rows.map((r) => r.u);
  }

  /**
   * Sets (or, with null, clears) the end of the act-as-root switch of a session. An unknown session is left as it is. Either way what
   * was opened under the old switch ends (`onEnd` with `asRoot`): a new end is a new switch.
   */
  setAsRoot(raw: string, until: number | null): void {
    this.db.prepare("UPDATE sessions SET as_root_until = ? WHERE id = ?").run(until, sha(raw));
    this.ended({ key: sha(raw), asRoot: true });
  }

  destroy(raw: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(raw));
    this.ended({ key: sha(raw) });
  }

  /** Raises the account epoch and deletes every session of the account. */
  endAll(kind: "sys" | "virt", name: string): void {
    if (kind === "sys" || this.acc.get(name)) this.acc.bumpEpoch(kind, name);
    this.db.prepare("DELETE FROM sessions WHERE kind = ? AND name = ?").run(kind, name);
    this.ended({ kind, name });
  }
}
