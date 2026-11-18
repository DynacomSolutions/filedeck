import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeVapidKeys, type VapidKeys } from "./webpush.ts";

/**
 * The hub's push store: its VAPID key pair, the browsers' push subscriptions (each with the account and the session it was made in),
 * and which job ends were already sent. One file, shared by the hub pods of a rollout: the key pair and each sent job are written with
 * INSERT OR IGNORE, so both pods use the same key and never both send one end.
 */

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** `sys:<name>` or `virt:<name>`; `` with sign-in off */
  owner: string;
  /** the session key (the hash the session store keys on); null with sign-in off, or after the session went idle (see `until`) */
  session: string | null;
  /** sign-in on, the session went idle (the app was closed): kept until this time, the session's absolute end; else null */
  until: number | null;
  created: number;
}

/** sent-job claims are kept this long: well past the 24 h a job end is looked back on */
const CLAIM_KEEP_MS = 2 * 86_400_000;

/** Push services of the browsers Filedeck supports: these hosts exactly (Chrome and Android, Firefox) ... */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
/** ... and hosts under these (Safari, Edge) */
const PUSH_DOMAINS = ["push.apple.com", "notify.windows.com"];

/** Whether the hub may post to `endpoint`: https, the default port, no user info, and a host that is (or is under) a push service host. */
export function pushHostAllowed(endpoint: string, extra: string[]): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return [...PUSH_HOSTS, ...extra.map((x) => x.toLowerCase())].includes(h) || PUSH_DOMAINS.some((d) => h.endsWith("." + d));
}

export class PushStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly now: () => number = Date.now) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* a volume that does not support modes */
      }
    }
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public TEXT NOT NULL, private TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, owner TEXT NOT NULL, session TEXT, until INTEGER, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS subs_owner ON subs(owner);
      CREATE INDEX IF NOT EXISTS subs_session ON subs(session);
      CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  /** The key pair, made on first use; a pair another pod wrote first wins. */
  keys(): VapidKeys {
    const read = () => this.db.prepare("SELECT public, private FROM vapid WHERE id = 1").get() as { public: string; private: string } | undefined;
    let r = read();
    if (!r) {
      const k = makeVapidKeys();
      this.db.prepare("INSERT OR IGNORE INTO vapid (id, public, private) VALUES (1, ?, ?)").run(k.publicKey, k.privateKey);
      r = read()!;
    }
    return { publicKey: r.public, privateKey: r.private };
  }

  /** Keeps a subscription; the same browser again for the same account keeps its start time, so no end is lost between two pages. */
  add(s: Omit<PushSub, "created" | "until">): void {
    this.db
      .prepare(
        "INSERT INTO subs (endpoint, p256dh, auth, owner, session, until, created) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, session = excluded.session, until = NULL, created = CASE WHEN subs.owner = excluded.owner THEN subs.created ELSE excluded.created END, owner = excluded.owner",
      )
      .run(s.endpoint, s.p256dh, s.auth, s.owner, s.session, this.now());
  }

  /** The session went idle (the app is closed): its subscriptions stay, without the session, until `until` (its absolute end). */
  detach(session: string, until: number): number {
    return Number(this.db.prepare("UPDATE subs SET session = NULL, until = ? WHERE session = ?").run(until, session).changes);
  }

  owners(): string[] {
    return (this.db.prepare("SELECT DISTINCT owner FROM subs").all() as { owner: string }[]).map((r) => r.owner);
  }

  of(owner: string): PushSub[] {
    return this.db.prepare("SELECT endpoint, p256dh, auth, owner, session, until, created FROM subs WHERE owner = ? ORDER BY created").all(owner) as unknown as PushSub[];
  }

  /** The caller's own subscription only. */
  remove(endpoint: string, owner: string): number {
    return Number(this.db.prepare("DELETE FROM subs WHERE endpoint = ? AND owner = ?").run(endpoint, owner).changes);
  }
  /** The push service said the subscription is gone (404, 410). */
  drop(endpoint: string): number {
    return Number(this.db.prepare("DELETE FROM subs WHERE endpoint = ?").run(endpoint).changes);
  }
  removeSession(session: string): number {
    return Number(this.db.prepare("DELETE FROM subs WHERE session = ?").run(session).changes);
  }
  removeOwner(owner: string): number {
    return Number(this.db.prepare("DELETE FROM subs WHERE owner = ?").run(owner).changes);
  }

  /** True for the first caller (any pod) to claim `key`, so each job end is sent once. */
  claim(key: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)").run(key, this.now()).changes) === 1;
  }
  /** The send failed: the next pass tries it again. */
  unclaim(key: string): void {
    this.db.prepare("DELETE FROM sent WHERE key = ?").run(key);
  }
  prune(): void {
    this.db.prepare("DELETE FROM sent WHERE at < ?").run(this.now() - CLAIM_KEEP_MS);
  }

  close(): void {
    this.db.close();
  }
}
