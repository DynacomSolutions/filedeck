import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Password vault (hub). A password someone
 * typed for an encrypted archive or PDF is kept on the server, encrypted at
 * rest, and handed to the agent only when a request for that file needs it.
 * Clients can list entries (location, scope, expiry) and forget them, but the
 * password itself is never part of any response.
 *
 * Owners: with sign-in on, each entry belongs to the account that saved it
 * (`kind:name`), and every call that names an owner sees only that owner's
 * entries. Entries saved with sign-in off have no owner; they serve calls that
 * name no owner (sign-in off) and nobody else.
 *
 * Lifetime: by default an entry has a sliding TTL (each use pushes the expiry
 * out by `ttlMs`) capped at `maxMs` after it was created, then it must be
 * typed again. A "remembered" entry never expires until forgotten.
 *
 * At rest: AES-256-GCM, a fresh 96-bit IV per row, the row id as additional
 * authenticated data (a ciphertext cannot be moved to another row). The key is
 * derived (HKDF-SHA256) from a secret supplied out of band; with no secret the
 * vault is memory only under a throw-away key and says so (`persistent: false`).
 */

export interface VaultOptions {
  /** sqlite file; ":memory:" or undefined keeps everything in memory */
  file?: string;
  /** secret the AES key is derived from (any length >= 16 bytes); undefined = ephemeral random key */
  secret?: string | Buffer;
  ttlMs?: number;
  maxMs?: number;
  now?: () => number;
}

export type Scope = "file" | "folder";

/** What a client may see: never the password. */
export interface VaultEntryView {
  id: string;
  node: string;
  scope: Scope;
  path: string;
  remembered: boolean;
  createdAt: number;
  lastUsed: number;
  /** null when remembered */
  expiresAt: number | null;
}

export interface PutOptions {
  remember?: boolean;
  scope?: Scope;
  /** device:inode:size identity of the file, used when the path no longer matches (older entries hold inode:size and simply stop matching by identity) */
  fid?: string;
  /** the account that saves it (`kind:name`); none with sign-in off */
  owner?: string;
}

/**
 * Whose entries a call may see: an account (`kind:name`), or undefined for every entry (sign-in off, as before).
 * An entry without an owner never matches an account.
 */
export type Owner = string | undefined;

interface Row {
  id: string;
  node: string;
  scope: Scope;
  path: string;
  fid: string | null;
  owner: string | null;
  remembered: number;
  created: number;
  last_used: number;
  blob: Uint8Array;
}

const HOUR = 3600_000;
export const DEFAULT_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_MS = 24 * HOUR;

/** Normalise a virtual path: leading slash, no trailing slash, no empty or dot segments. */
export function normPath(p: string): string {
  const out: string[] = [];
  for (const s of p.split("/")) if (s && s !== ".") out.push(s);
  return "/" + out.join("/");
}
const parentOf = (p: string) => normPath(p.slice(0, Math.max(0, p.lastIndexOf("/"))));

export class Vault {
  readonly persistent: boolean;
  readonly ttlMs: number;
  readonly maxMs: number;
  private db: DatabaseSync;
  private key: Buffer;
  private now: () => number;

  constructor(o: VaultOptions = {}) {
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.maxMs = o.maxMs ?? DEFAULT_MAX_MS;
    this.now = o.now ?? Date.now;
    const secret = o.secret === undefined ? undefined : Buffer.from(o.secret);
    if (secret && secret.length < 16) throw new Error("vault key must be at least 16 bytes");
    this.persistent = !!(secret && o.file && o.file !== ":memory:");
    this.key = Buffer.from(hkdfSync("sha256", secret ?? randomBytes(32), "filedeck-vault", "aes-256-gcm key v1", 32));
    const file = this.persistent ? o.file! : ":memory:";
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
    `);
    this.migrate();
    this.purge();
  }

  close() {
    this.db.close();
  }

  /**
   * Creates the table, or moves a table from before owners existed over to the current one. The old table allowed
   * one entry per node, scope and path; now each owner may have one, so the table is copied rather than altered.
   * Old entries keep their ids (the ciphertext is bound to the id) and get no owner.
   */
  private migrate() {
    const table = (name: string) => `
      CREATE TABLE ${name} (
        id TEXT PRIMARY KEY,
        node TEXT NOT NULL,
        scope TEXT NOT NULL,
        path TEXT NOT NULL,
        fid TEXT,
        owner TEXT,
        remembered INTEGER NOT NULL,
        created INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        blob BLOB NOT NULL
      )`;
    const indexes = `
      CREATE UNIQUE INDEX IF NOT EXISTS entries_key ON entries (ifnull(owner, ''), node, scope, path);
      CREATE INDEX IF NOT EXISTS entries_fid ON entries (node, fid);
    `;
    const columns = () => (this.db.prepare("PRAGMA table_info(entries)").all() as { name: string }[]).map((c) => c.name);
    const cols = columns();
    if (cols.length === 0) {
      this.db.exec(table("entries") + ";" + indexes);
      return;
    }
    if (cols.includes("owner")) {
      this.db.exec(indexes);
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have moved the table over while this one waited for the lock; copying again would drop
      // the owners of the entries saved since.
      if (columns().includes("owner")) {
        this.db.exec("COMMIT");
        this.db.exec(indexes);
        return;
      }
      this.db.exec(`
        ${table("entries_new")};
        INSERT INTO entries_new (id, node, scope, path, fid, owner, remembered, created, last_used, blob)
          SELECT id, node, scope, path, fid, NULL, remembered, created, last_used, blob FROM entries;
        DROP TABLE entries;
        ALTER TABLE entries_new RENAME TO entries;
        ${indexes}
      `);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** SQL and arguments that limit a query to one owner's entries (nothing for undefined). */
  private mine(owner: Owner): [string, string[]] {
    return owner === undefined ? ["", []] : [" AND owner = ?", [owner]];
  }

  /* ---------------------------------------------------------------- crypto */

  private seal(id: string, password: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(id));
    const ct = Buffer.concat([c.update(password, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  private open(id: string, blob: Uint8Array): string | undefined {
    try {
      const b = Buffer.from(blob);
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAAD(Buffer.from(id));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    } catch {
      return undefined; // wrong key (rotated secret) or tampered row: treated as absent
    }
  }

  /* ---------------------------------------------------------------- expiry */

  private expiresAt(r: Pick<Row, "remembered" | "created" | "last_used">): number | null {
    if (r.remembered) return null;
    return Math.min(r.last_used + this.ttlMs, r.created + this.maxMs);
  }
  private alive(r: Row): boolean {
    const e = this.expiresAt(r);
    return e === null || e > this.now();
  }
  /** Delete every expired entry; returns how many. */
  purge(): number {
    const t = this.now();
    const res = this.db
      .prepare("DELETE FROM entries WHERE remembered = 0 AND MIN(last_used + ?, created + ?) <= ?")
      .run(this.ttlMs, this.maxMs, t);
    return Number(res.changes);
  }

  private view(r: Row): VaultEntryView {
    return { id: r.id, node: r.node, scope: r.scope, path: r.path, remembered: !!r.remembered, createdAt: r.created, lastUsed: r.last_used, expiresAt: this.expiresAt(r) };
  }

  /* ------------------------------------------------------------------- API */

  /**
   * Save (or replace) the password for a file, or for a folder and everything
   * below it. For `scope: "folder"`, `path` is the folder.
   */
  put(node: string, p: string, password: string, o: PutOptions = {}): VaultEntryView {
    this.purge();
    const scope: Scope = o.scope === "folder" ? "folder" : "file";
    const pth = normPath(p);
    const t = this.now();
    const owner = o.owner ?? null;
    const prev = this.db.prepare("SELECT id FROM entries WHERE node = ? AND scope = ? AND path = ? AND owner IS ?").get(node, scope, pth, owner) as Pick<Row, "id"> | undefined;
    const id = prev?.id ?? randomUUID();
    const remembered = o.remember ? 1 : 0;
    const created = t; // typing a password again starts a fresh lifetime (and replaces a remembered one when Remember is off)
    const blob = this.seal(id, password);
    const fid = scope === "file" ? o.fid ?? null : null;
    // One statement, so a row another process added meanwhile is replaced, not a UNIQUE error. The id goes with the
    // blob (it is the blob's authenticated data); it changes only when such a row came in between.
    this.db
      .prepare(
        `INSERT INTO entries (id, node, scope, path, fid, owner, remembered, created, last_used, blob) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (ifnull(owner, ''), node, scope, path) DO UPDATE SET id = excluded.id, fid = excluded.fid, remembered = excluded.remembered, created = excluded.created, last_used = excluded.last_used, blob = excluded.blob`,
      )
      .run(id, node, scope, pth, fid, owner, remembered, created, t, blob);
    return this.view({ id, node, scope, path: pth, fid, owner, remembered, created, last_used: t, blob });
  }

  /**
   * The password for this file: its own entry, else the same device+inode+size under
   * another path (renamed or moved), else the nearest folder entry above it.
   * A use refreshes the sliding TTL (never past the absolute cap); `touch: false` peeks without counting as a use.
   * Only `owner`'s entries are looked at.
   */
  get(node: string, p: string, fid?: string, touch = true, owner?: Owner): { password: string; id: string; remembered: boolean; scope: Scope } | undefined {
    this.purge();
    const pth = normPath(p);
    const [w, a] = this.mine(owner);
    let row = this.db.prepare(`SELECT * FROM entries WHERE node = ? AND scope = 'file' AND path = ?${w} ORDER BY last_used DESC LIMIT 1`).get(node, pth, ...a) as Row | undefined;
    if (!row && fid) row = this.db.prepare(`SELECT * FROM entries WHERE node = ? AND scope = 'file' AND fid = ?${w} ORDER BY last_used DESC LIMIT 1`).get(node, fid, ...a) as Row | undefined;
    for (let dir = parentOf(pth); !row; dir = parentOf(dir)) {
      row = this.db.prepare(`SELECT * FROM entries WHERE node = ? AND scope = 'folder' AND path = ?${w} ORDER BY last_used DESC LIMIT 1`).get(node, dir, ...a) as Row | undefined;
      if (dir === "/") break;
    }
    if (!row || !this.alive(row)) return undefined;
    const password = this.open(row.id, row.blob);
    if (password === undefined) {
      this.forget(row.id);
      return undefined;
    }
    if (touch) this.touch(row.id);
    return { password, id: row.id, remembered: !!row.remembered, scope: row.scope };
  }

  /** Record a use: pushes the sliding expiry out (never past the absolute cap). */
  touch(id: string) {
    this.db.prepare("UPDATE entries SET last_used = ? WHERE id = ?").run(this.now(), id);
  }

  /** Extend an entry from the settings page, while preserving its absolute lifetime cap. */
  extend(id: string, owner?: Owner): VaultEntryView | undefined {
    this.purge();
    const [w, a] = this.mine(owner);
    const row = this.db.prepare(`SELECT * FROM entries WHERE id = ?${w}`).get(id, ...a) as Row | undefined;
    if (!row || !this.alive(row)) return undefined;
    this.touch(id);
    const updated = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Row | undefined;
    return updated ? this.view(updated) : undefined;
  }

  /** True if any entry exists for the node (lets the hub skip an inode lookup when there is nothing to find). */
  hasNode(node: string, owner?: Owner): boolean {
    const [w, a] = this.mine(owner);
    return this.db.prepare(`SELECT 1 FROM entries WHERE node = ?${w} LIMIT 1`).get(node, ...a) !== undefined;
  }

  list(owner?: Owner): VaultEntryView[] {
    this.purge();
    const [w, a] = this.mine(owner);
    return (this.db.prepare(`SELECT * FROM entries WHERE 1${w} ORDER BY last_used DESC`).all(...a) as unknown as Row[]).map((r) => this.view(r));
  }

  forget(id: string, owner?: Owner): boolean {
    const [w, a] = this.mine(owner);
    return Number(this.db.prepare(`DELETE FROM entries WHERE id = ?${w}`).run(id, ...a).changes) > 0;
  }

  /**
   * "Forget saved password" for a file or folder: removes its own entry, every
   * entry beneath it, and any folder entry above it that would still unlock it.
   */
  forgetPath(node: string, p: string, owner?: Owner): number {
    const pth = normPath(p);
    const [w, a] = this.mine(owner);
    const rows = this.db.prepare(`SELECT id, scope, path FROM entries WHERE node = ?${w}`).all(node, ...a) as unknown as Pick<Row, "id" | "scope" | "path">[];
    let n = 0;
    for (const r of rows) {
      const below = r.path === pth || r.path.startsWith(pth === "/" ? "/" : pth + "/");
      const covers = r.scope === "folder" && (r.path === "/" || pth.startsWith(r.path + "/"));
      if ((below || covers) && this.forget(r.id)) n++;
    }
    return n;
  }

  forgetAll(owner?: Owner): number {
    const [w, a] = this.mine(owner);
    return Number(this.db.prepare(`DELETE FROM entries WHERE 1${w}`).run(...a).changes);
  }

  /**
   * How many live entries have no owner: saved with sign-in off. With sign-in on they serve nobody; the hub says how many at start and
   * an administrator can forget them (`forgetUnowned`).
   */
  countUnowned(): number {
    this.purge();
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE owner IS NULL").get() as { n: number };
    return Number(r.n);
  }

  /** Deletes every entry without an owner (saved with sign-in off); returns how many. Entries of accounts stay. */
  forgetUnowned(): number {
    return Number(this.db.prepare("DELETE FROM entries WHERE owner IS NULL").run().changes);
  }
}
