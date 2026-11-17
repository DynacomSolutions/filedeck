import { createHash, randomBytes } from "node:crypto";
import type { AuthDb, Accounts } from "./store.ts";

/**
 * Session store (hub). The cookie value is 32 random bytes as base64url. Only
 * its SHA-256 is kept, so a copy of the database cannot be used to sign in.
 * A session ends when it is idle too long, when it is older than the absolute
 * limit, or when its account epoch is raised. `as_root_until` holds the end of a system administrator's "act as root"
 * switch (ms since the epoch), or NULL; it goes with the session (sign-out, `endAll` and an epoch rise end it too).
 */

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
}

/**
 * What `onEnd` hears: `key` when one session ended (sign-out, a sign-in that replaced it, or a lookup that found it expired), with
 * `asRoot` when only its act-as-root switch was set or cleared; `kind` and `name` when every session of an account was ended.
 */
export type SessionEnd = { key: string; asRoot?: true } | { kind: "sys" | "virt"; name: string };

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

  /**
   * Whether the session kept under `key` is valid now: by the idle and absolute limits, its account (a virtual one still exists) and its
   * epoch. Read only: it never writes `last_used` and never deletes (the hub asks it for each open event stream).
   */
  peek(key: string): boolean {
    const r = this.db.prepare("SELECT kind, name, created, last_used, epoch FROM sessions WHERE id = ?").get(key) as Omit<SessionRow, "as_root_until"> | undefined;
    if (!r) return false;
    const t = this.now();
    if (t - r.last_used > this.o.idleMs || t - r.created >= this.o.maxMs) return false;
    if (r.kind === "virt" && !this.acc.get(r.name)) return false;
    return this.acc.epochOf(r.kind, r.name) <= r.epoch;
  }

  create(kind: "sys" | "virt", name: string): string {
    const raw = randomBytes(32).toString("base64url");
    const t = this.now();
    this.db
      .prepare("INSERT INTO sessions (id, kind, name, created, last_used, epoch) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha(raw), kind, name, t, t, this.acc.epochOf(kind, name));
    return raw;
  }

  /** `asRootUntil` is the stored end of the act-as-root switch, as it is (the caller decides whether it still holds). */
  lookup(raw: string): { kind: "sys" | "virt"; name: string; asRootUntil?: number } | undefined {
    const id = sha(raw);
    const r = this.db.prepare("SELECT kind, name, created, last_used, epoch, as_root_until FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!r) return undefined;
    const t = this.now();
    const gone = () => {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.ended({ key: id });
      return undefined;
    };
    if (t - r.last_used > this.o.idleMs || t - r.created >= this.o.maxMs) return gone();
    if (r.kind === "virt" && !this.acc.get(r.name)) return gone();
    if (this.acc.epochOf(r.kind, r.name) > r.epoch) return gone();
    if (t - r.last_used >= TOUCH_MS) this.db.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").run(t, id);
    return { kind: r.kind, name: r.name, ...(typeof r.as_root_until === "number" ? { asRootUntil: r.as_root_until } : {}) };
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
