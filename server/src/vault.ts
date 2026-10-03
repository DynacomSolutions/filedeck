import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Password vault (hub). Filedeck has no user accounts, so a password someone
 * typed for an encrypted archive or PDF is kept on the server, encrypted at
 * rest, and handed to the agent only when a request for that file needs it.
 * Clients can list entries (location, scope, expiry) and forget them, but the
 * password itself is never part of any response.
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
  /** inode/size identity of the file, used when the path no longer matches */
  fid?: string;
}

interface Row {
  id: string;
  node: string;
  scope: Scope;
  path: string;
  fid: string | null;
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
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        node TEXT NOT NULL,
        scope TEXT NOT NULL,
        path TEXT NOT NULL,
        fid TEXT,
        remembered INTEGER NOT NULL,
        created INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        blob BLOB NOT NULL,
        UNIQUE (node, scope, path)
      );
      CREATE INDEX IF NOT EXISTS entries_fid ON entries (node, fid);
    `);
    this.purge();
  }

  close() {
    this.db.close();
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
    const prev = this.db.prepare("SELECT * FROM entries WHERE node = ? AND scope = ? AND path = ?").get(node, scope, pth) as Row | undefined;
    const id = prev?.id ?? randomUUID();
    const remembered = o.remember ? 1 : 0;
    const created = t; // typing a password again starts a fresh lifetime (and replaces a remembered one when Remember is off)
    const blob = this.seal(id, password);
    const fid = scope === "file" ? o.fid ?? null : null;
    this.db
      .prepare(
        `INSERT INTO entries (id, node, scope, path, fid, remembered, created, last_used, blob) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (node, scope, path) DO UPDATE SET fid = excluded.fid, remembered = excluded.remembered, created = excluded.created, last_used = excluded.last_used, blob = excluded.blob`,
      )
      .run(id, node, scope, pth, fid, remembered, created, t, blob);
    return this.view({ id, node, scope, path: pth, fid, remembered, created, last_used: t, blob });
  }

  /**
   * The password for this file: its own entry, else the same inode+size under
   * another path (renamed or moved), else the nearest folder entry above it.
   * A use refreshes the sliding TTL (never past the absolute cap); `touch: false` peeks without counting as a use.
   */
  get(node: string, p: string, fid?: string, touch = true): { password: string; id: string; remembered: boolean; scope: Scope } | undefined {
    this.purge();
    const pth = normPath(p);
    let row = this.db.prepare("SELECT * FROM entries WHERE node = ? AND scope = 'file' AND path = ?").get(node, pth) as Row | undefined;
    if (!row && fid) row = this.db.prepare("SELECT * FROM entries WHERE node = ? AND scope = 'file' AND fid = ? ORDER BY last_used DESC LIMIT 1").get(node, fid) as Row | undefined;
    for (let dir = parentOf(pth); !row; dir = parentOf(dir)) {
      row = this.db.prepare("SELECT * FROM entries WHERE node = ? AND scope = 'folder' AND path = ?").get(node, dir) as Row | undefined;
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

  /** True if any entry exists for the node (lets the hub skip an inode lookup when there is nothing to find). */
  hasNode(node: string): boolean {
    return this.db.prepare("SELECT 1 FROM entries WHERE node = ? LIMIT 1").get(node) !== undefined;
  }

  list(): VaultEntryView[] {
    this.purge();
    return (this.db.prepare("SELECT * FROM entries ORDER BY last_used DESC").all() as unknown as Row[]).map((r) => this.view(r));
  }

  forget(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM entries WHERE id = ?").run(id).changes) > 0;
  }

  /**
   * "Forget saved password" for a file or folder: removes its own entry, every
   * entry beneath it, and any folder entry above it that would still unlock it.
   */
  forgetPath(node: string, p: string): number {
    const pth = normPath(p);
    const rows = this.db.prepare("SELECT id, scope, path FROM entries WHERE node = ?").all(node) as unknown as Pick<Row, "id" | "scope" | "path">[];
    let n = 0;
    for (const r of rows) {
      const below = r.path === pth || r.path.startsWith(pth === "/" ? "/" : pth + "/");
      const covers = r.scope === "folder" && (r.path === "/" || pth.startsWith(r.path + "/"));
      if ((below || covers) && this.forget(r.id)) n++;
    }
    return n;
  }

  forgetAll(): number {
    return Number(this.db.prepare("DELETE FROM entries").run().changes);
  }
}
