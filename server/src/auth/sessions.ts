import { createHash, randomBytes } from "node:crypto";
import type { AuthDb, Accounts } from "./store.ts";

/**
 * Session store (hub). The cookie value is 32 random bytes as base64url. Only
 * its SHA-256 is kept, so a copy of the database cannot be used to sign in.
 * A session ends when it is idle too long, when it is older than the absolute
 * limit, or when its account epoch is raised.
 */

/** A lookup writes `last_used` at most this often. */
const TOUCH_MS = 60_000;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

interface SessionRow {
  kind: "sys" | "virt";
  name: string;
  created: number;
  last_used: number;
  epoch: number;
}

export class Sessions {
  private now: () => number;

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
  }

  private get db() {
    return this.store.db;
  }

  create(kind: "sys" | "virt", name: string): string {
    const raw = randomBytes(32).toString("base64url");
    const t = this.now();
    this.db
      .prepare("INSERT INTO sessions (id, kind, name, created, last_used, epoch) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha(raw), kind, name, t, t, this.acc.epochOf(kind, name));
    return raw;
  }

  lookup(raw: string): { kind: "sys" | "virt"; name: string } | undefined {
    const id = sha(raw);
    const r = this.db.prepare("SELECT kind, name, created, last_used, epoch FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!r) return undefined;
    const t = this.now();
    const gone = () => {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return undefined;
    };
    if (t - r.last_used > this.o.idleMs || t - r.created >= this.o.maxMs) return gone();
    if (r.kind === "virt" && !this.acc.get(r.name)) return gone();
    if (this.acc.epochOf(r.kind, r.name) > r.epoch) return gone();
    if (t - r.last_used >= TOUCH_MS) this.db.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").run(t, id);
    return { kind: r.kind, name: r.name };
  }

  destroy(raw: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(raw));
  }

  /** Raises the account epoch and deletes every session of the account. */
  endAll(kind: "sys" | "virt", name: string): void {
    if (kind === "sys" || this.acc.get(name)) this.acc.bumpEpoch(kind, name);
    this.db.prepare("DELETE FROM sessions WHERE kind = ? AND name = ?").run(kind, name);
  }
}
