import { DatabaseSync } from "node:sqlite";
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Identity, NodeAccess } from "./identity.ts";
import { keyFingerprint } from "./sshkey.ts";
import { inTransaction } from "./tx.ts";

/**
 * Account store (hub). Virtual accounts, their public keys and the epochs that
 * let the hub cancel every session of one account. System accounts have no row
 * of their own: only their epoch is kept, in `sys_users`. A deleted virtual
 * account leaves its epoch, raised by one, in `retired_accounts`: agents that
 * see it stop the old account's workers, and a new account of the same name
 * starts above it, so no agent takes it for the old one.
 */

export class AccountError extends Error {}

const HASH_RE = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/;
const NAME_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;

export class AuthDb {
  readonly db: DatabaseSync;
  readonly hubId: string;

  constructor(file: string) {
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
      CREATE TABLE IF NOT EXISTS meta (hub_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        name TEXT PRIMARY KEY,
        password_hash TEXT,
        admin INTEGER NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        nodes TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_keys (
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        PRIMARY KEY (name, public_key)
      );
      CREATE TABLE IF NOT EXISTS sys_users (
        name TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS retired_accounts (
        name TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_flags (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const row = this.db.prepare("SELECT hub_id FROM meta LIMIT 1").get() as { hub_id: string } | undefined;
    if (row) this.hubId = row.hub_id;
    else {
      this.hubId = randomBytes(16).toString("hex");
      this.db.prepare("INSERT INTO meta (hub_id) VALUES (?)").run(this.hubId);
    }
  }

  close() {
    this.db.close();
  }
}

/* ------------------------------------------------------------- passwords */

const LOG_N = 15;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

function derive(pw: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
  return scryptSync(pw, salt, 32, { N: 2 ** logN, r, p, maxmem: MAXMEM });
}

const stored = (salt: Buffer, hash: Buffer) => `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;

/** `scrypt$15$8$1$<salt b64>$<hash b64>` */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return stored(salt, derive(pw, salt, LOG_N, R, P));
}

/**
 * The same as `hashPassword` (same parameters, same stored form), off the main thread: the admin routes hash before their store
 * transaction, so the write lock is not held while it runs.
 */
export function hashPasswordAsync(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, 32, { N: 2 ** LOG_N, r: R, p: P, maxmem: MAXMEM }, (e, hash) => (e ? reject(e) : resolve(stored(salt, hash))));
  });
}

let dummy: string | undefined;

/** Same work whether or not a hash is stored. With no stored hash it hashes against a fixed dummy, then answers false. */
export function checkPassword(pw: string, stored: string | null): boolean {
  const ok = verify(pw, stored ?? (dummy ??= hashPassword("filedeck dummy password")));
  return stored !== null && ok;
}

function verify(pw: string, stored: string): boolean {
  try {
    const [tag, n, r, p, salt, hash] = stored.split("$");
    if (tag !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    const logN = Number(n);
    if (!Number.isInteger(logN) || logN < 1 || logN > 20) return false;
    const want = Buffer.from(hash, "base64");
    const got = derive(pw, Buffer.from(salt, "base64"), logN, Number(r), Number(p));
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- accounts */

export interface AccountRecord {
  name: string;
  admin: boolean;
  epoch: number;
  nodes: Record<string, NodeAccess>;
  passwordHash: string | null;
}

interface AccountRow {
  name: string;
  password_hash: string | null;
  admin: number;
  epoch: number;
  nodes: string;
}

function record(r: AccountRow): AccountRecord {
  return {
    name: r.name,
    admin: r.admin === 1,
    epoch: r.epoch,
    nodes: JSON.parse(r.nodes) as Record<string, NodeAccess>,
    passwordHash: r.password_hash,
  };
}

export class Accounts {
  constructor(private store: AuthDb) {}

  private get db() {
    return this.store.db;
  }

  /**
   * Runs `fn` in one transaction, or in a savepoint of the caller's (`inTransaction`). The admin routes use it to hold a check and every
   * write of one change together, with no `await` inside `fn`. That covers the source grants (and sessions) only because `SourceGrants`
   * and `Sessions` are built on the same `AuthDb` and so share this connection; a store on another connection would not be part of it.
   */
  tx<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  /** Whether `FILEDECK_BOOTSTRAP_ADMIN_FILE` has been used on this store (`bootstrapAdmin`). */
  bootstrapUsed(): boolean {
    return this.db.prepare("SELECT 1 FROM hub_flags WHERE name = 'bootstrap_used'").get() !== undefined;
  }

  /** Records that the bootstrap file has been used, with the time. */
  markBootstrapUsed(): void {
    this.db.prepare("INSERT OR IGNORE INTO hub_flags (name, value) VALUES ('bootstrap_used', ?)").run(new Date().toISOString());
  }

  create(a: { name: string; password?: string; passwordHash?: string; admin: boolean; nodes: Record<string, NodeAccess> }): void {
    if (!NAME_RE.test(a.name) || a.name === "root") throw new AccountError("invalid name");
    if (this.get(a.name)) throw new AccountError("exists");
    const hash = a.passwordHash ?? (a.password !== undefined ? hashPassword(a.password) : null);
    try {
      // A name that was deleted starts above the epoch it had, and the retired row goes.
      this.tx(() => {
        const old = this.db.prepare("SELECT epoch FROM retired_accounts WHERE name = ?").get(a.name) as { epoch: number } | undefined;
        this.db
          .prepare("INSERT INTO accounts (name, password_hash, admin, epoch, nodes) VALUES (?, ?, ?, ?, ?)")
          .run(a.name, hash, a.admin ? 1 : 0, old ? old.epoch + 1 : 0, JSON.stringify(a.nodes));
        this.db.prepare("DELETE FROM retired_accounts WHERE name = ?").run(a.name);
      });
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new AccountError("exists");
      throw e;
    }
  }

  get(name: string): AccountRecord | undefined {
    const r = this.db.prepare("SELECT name, password_hash, admin, epoch, nodes FROM accounts WHERE name = ?").get(name) as AccountRow | undefined;
    return r ? record(r) : undefined;
  }

  /** Every virtual account, ordered by name. */
  list(): AccountRecord[] {
    const rows = this.db.prepare("SELECT name, password_hash, admin, epoch, nodes FROM accounts ORDER BY name").all() as unknown as AccountRow[];
    return rows.map(record);
  }

  /**
   * Changes what the patch names. `password: null` removes the password; a string is hashed; `passwordHash` (made by `hashPassword` or
   * `hashPasswordAsync`) is stored as it is and wins over `password`. It does not raise the epoch: the caller does (`bumpEpoch`, and
   * `accountChanged` in the hub), so sessions, streams and jobs end with it.
   */
  update(name: string, patch: { password?: string | null; passwordHash?: string; admin?: boolean; nodes?: Record<string, NodeAccess> }): void {
    if (!this.get(name)) throw new AccountError("no such account");
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.passwordHash !== undefined) {
      if (!HASH_RE.test(patch.passwordHash)) throw new AccountError("not a scrypt hash");
      sets.push("password_hash = ?");
      args.push(patch.passwordHash);
    } else if (patch.password !== undefined) {
      sets.push("password_hash = ?");
      args.push(patch.password === null ? null : hashPassword(patch.password));
    }
    if (patch.admin !== undefined) {
      sets.push("admin = ?");
      args.push(patch.admin ? 1 : 0);
    }
    if (patch.nodes !== undefined) {
      sets.push("nodes = ?");
      args.push(JSON.stringify(patch.nodes));
    }
    if (sets.length === 0) return;
    const r = this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE name = ?`).run(...args, name);
    if (r.changes === 0) throw new AccountError("no such account");
  }

  addKey(name: string, publicKeyLine: string): void {
    if (!this.get(name)) throw new AccountError("no such account");
    this.db.prepare("INSERT OR IGNORE INTO account_keys (name, public_key) VALUES (?, ?)").run(name, publicKeyLine);
  }

  keys(name: string): string[] {
    const rows = this.db.prepare("SELECT public_key FROM account_keys WHERE name = ? ORDER BY rowid").all(name) as { public_key: string }[];
    return rows.map((r) => r.public_key);
  }

  /** Removes the key of the account whose fingerprint (`keyFingerprint`) is `fingerprint`. False when it has no such key. */
  removeKey(name: string, fingerprint: string): boolean {
    let removed = false;
    for (const line of this.keys(name)) {
      if (keyFingerprint(line) !== fingerprint) continue;
      this.db.prepare("DELETE FROM account_keys WHERE name = ? AND public_key = ?").run(name, line);
      removed = true;
    }
    return removed;
  }

  /**
   * Deletes the account and its keys, and keeps its epoch raised by one in `retired_accounts` (or the one kept there, when larger), so
   * `epochOf` is higher after the delete. Its sessions end by themselves (a session of a virtual account that no longer exists is
   * invalid). Unknown name: `AccountError`.
   */
  remove(name: string): void {
    this.tx(() => {
      const r = this.db.prepare("SELECT epoch FROM accounts WHERE name = ?").get(name) as { epoch: number } | undefined;
      if (!r) throw new AccountError("no such account");
      this.db
        .prepare("INSERT INTO retired_accounts (name, epoch) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET epoch = max(epoch, excluded.epoch)")
        .run(name, r.epoch + 1);
      this.db.prepare("DELETE FROM account_keys WHERE name = ?").run(name);
      this.db.prepare("DELETE FROM accounts WHERE name = ?").run(name);
    });
  }

  bumpEpoch(kind: "sys" | "virt", name: string): number {
    if (kind === "sys") {
      this.epochOf("sys", name);
      this.db.prepare("UPDATE sys_users SET epoch = epoch + 1 WHERE name = ?").run(name);
    } else {
      const r = this.db.prepare("UPDATE accounts SET epoch = epoch + 1 WHERE name = ?").run(name);
      if (r.changes === 0) throw new AccountError("no such account");
    }
    return this.epochOf(kind, name);
  }

  epochOf(kind: "sys" | "virt", name: string): number {
    if (kind === "sys") {
      this.db.prepare("INSERT OR IGNORE INTO sys_users (name, epoch) VALUES (?, 0)").run(name);
      return (this.db.prepare("SELECT epoch FROM sys_users WHERE name = ?").get(name) as { epoch: number }).epoch;
    }
    const r = this.db.prepare("SELECT epoch FROM accounts WHERE name = ?").get(name) as { epoch: number } | undefined;
    if (r) return r.epoch;
    // a deleted name keeps the epoch it was retired at
    const old = this.db.prepare("SELECT epoch FROM retired_accounts WHERE name = ?").get(name) as { epoch: number } | undefined;
    return old?.epoch ?? 0;
  }

  identity(kind: "virt", name: string): Identity | undefined {
    const a = this.get(name);
    if (!a) return undefined;
    return { kind, name: a.name, admin: a.admin, epoch: a.epoch, nodes: a.nodes };
  }
}

/**
 * Creates the first admin from a JSON file, only when that name is free, and only once per store: the store records that the file was
 * used, so a first administrator deleted later is not made again at the next start. Never changes an existing account. `log` gets one
 * line when the file is set but was used already.
 */
export function bootstrapAdmin(acc: Accounts, file: string | undefined, log: (s: string) => void = (s) => console.log(s)): void {
  if (!file) return;
  // used once: after that the file is not read again (it may be gone), and a first administrator deleted since is not made again
  if (acc.bootstrapUsed()) {
    log("FILEDECK_BOOTSTRAP_ADMIN_FILE is set but was already used; it is ignored and can be removed");
    return;
  }
  let j: { name?: unknown; passwordHash?: unknown };
  try {
    j = JSON.parse(fs.readFileSync(file, "utf8")) as typeof j;
  } catch (e) {
    // the parser's message quotes the file, and the file holds a password hash
    if (e instanceof SyntaxError) throw new Error("FILEDECK_BOOTSTRAP_ADMIN_FILE is not valid JSON");
    throw e;
  }
  if (!j || typeof j !== "object") throw new Error("admin bootstrap file needs name and passwordHash");
  if (typeof j.name !== "string" || typeof j.passwordHash !== "string") throw new Error("admin bootstrap file needs name and passwordHash");
  if (!HASH_RE.test(j.passwordHash)) throw new Error("admin bootstrap passwordHash is not a scrypt hash");
  const name = j.name;
  const passwordHash = j.passwordHash;
  // the account and the marker in one transaction; an account that exists already (a store from a build without the marker) is
  // left as it is, and only the marker is written
  acc.tx(() => {
    if (acc.bootstrapUsed()) return;
    if (!acc.get(name)) acc.create({ name, passwordHash, admin: true, nodes: {} });
    acc.markBootstrapUsed();
  });
}
