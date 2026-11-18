import type { AuthDb } from "./store.ts";
import { inTransaction } from "./tx.ts";

/**
 * Source grants (hub). A grant gives one account a whole network source, read-only or read-write. A system user and a virtual account
 * of the same name are different accounts, so each row names its kind. Administrators need no grant (the hub decides that, not this
 * store).
 */

export type SourceAccess = { write: boolean };

/** The answer to a change asked of a network source by an account with a read-only grant. */
export const SOURCE_READ_ONLY = "this network source is read-only for you";

type Kind = "sys" | "virt";

export class SourceGrants {
  constructor(private store: AuthDb) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS source_grants (
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        write INTEGER NOT NULL,
        PRIMARY KEY (source, kind, name)
      );
      CREATE INDEX IF NOT EXISTS source_grants_account ON source_grants (kind, name);
    `);
  }

  private get db() {
    return this.store.db;
  }

  get(source: string, kind: Kind, name: string): SourceAccess | undefined {
    const r = this.db.prepare("SELECT write FROM source_grants WHERE source = ? AND kind = ? AND name = ?").get(source, kind, name) as { write: number } | undefined;
    return r ? { write: r.write === 1 } : undefined;
  }

  /** Every grant of one account, by source. */
  forAccount(kind: Kind, name: string): Record<string, SourceAccess> {
    const rows = this.db.prepare("SELECT source, write FROM source_grants WHERE kind = ? AND name = ? ORDER BY source").all(kind, name) as { source: string; write: number }[];
    const out: Record<string, SourceAccess> = {};
    for (const r of rows) out[r.source] = { write: r.write === 1 };
    return out;
  }

  /** Replaces every grant of one account with `grants`, in one transaction (or a savepoint of the caller's): on any error nothing of it changes. `{}` removes them all. */
  setForAccount(kind: Kind, name: string, grants: Record<string, SourceAccess>): void {
    inTransaction(this.db, () => {
      this.db.prepare("DELETE FROM source_grants WHERE kind = ? AND name = ?").run(kind, name);
      const ins = this.db.prepare("INSERT INTO source_grants (source, kind, name, write) VALUES (?, ?, ?, ?)");
      for (const [source, a] of Object.entries(grants)) ins.run(source, kind, name, a.write ? 1 : 0);
    });
  }

  /** The names of one kind that hold at least one grant, in name order. */
  accounts(kind: Kind): string[] {
    const rows = this.db.prepare("SELECT DISTINCT name FROM source_grants WHERE kind = ? ORDER BY name").all(kind) as { name: string }[];
    return rows.map((r) => r.name);
  }

  removeAccount(kind: Kind, name: string): void {
    this.db.prepare("DELETE FROM source_grants WHERE kind = ? AND name = ?").run(kind, name);
  }
}
