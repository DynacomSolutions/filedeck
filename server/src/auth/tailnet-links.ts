import type { AuthDb } from "./store.ts";
import type { TailnetIdentity } from "./tailnet.ts";
import { inTransaction } from "./tx.ts";

/**
 * Tailnet links (hub; docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md, decisions 3, 4 and 7). An administrator links a tailnet
 * login (`alice@github`) or a tag (`tag:server`) to one account. The subject is the primary key, so a login or a tag belongs to at most one
 * account, whatever two writers do at the same moment. A system user and a virtual account of the same name are different accounts. The
 * values are already cleaned (`account-input.ts` `tailnetLink`); this store does not check them again, but it works out each link's kind
 * from its subject, never from the caller.
 */

export type LinkKind = "login" | "tag";
export type AccountKind = "sys" | "virt";
export type Link = { subject: string; kind: LinkKind };

/** A subject that `setForAccount` was asked to link is linked to another account. The message is the admin route's 409 answer. */
export class LinkTaken extends Error {
  constructor(
    readonly subject: string,
    readonly kind: LinkKind,
    readonly accountKind: AccountKind,
    readonly name: string,
  ) {
    super(`${kind === "tag" ? "this tag" : "this tailnet login"} is linked to ${accountKind}:${name}`);
  }
}

/** The kind of a cleaned subject: tags start with `tag:`, logins hold an `@`, so the two never share a subject. */
const linkKind = (subject: string): LinkKind => (subject.startsWith("tag:") ? "tag" : "login");

export class TailnetLinks {
  private now: () => number;

  constructor(
    private store: AuthDb,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS tailnet_links (
        subject TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        account_kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tailnet_links_account ON tailnet_links (account_kind, name);
    `);
  }

  private get db() {
    return this.store.db;
  }

  /** The account a login or a tag is linked to. */
  owner(subject: string): { kind: AccountKind; name: string } | undefined {
    const r = this.db.prepare("SELECT account_kind, name FROM tailnet_links WHERE subject = ?").get(subject) as { account_kind: AccountKind; name: string } | undefined;
    return r ? { kind: r.account_kind, name: r.name } : undefined;
  }

  /** Every link of one account, by subject. */
  forAccount(kind: AccountKind, name: string): Link[] {
    const rows = this.db.prepare("SELECT subject, kind FROM tailnet_links WHERE account_kind = ? AND name = ? ORDER BY subject").all(kind, name) as Link[];
    return rows.map((r) => ({ subject: r.subject, kind: r.kind }));
  }

  /**
   * Replaces every link of one account with `links`, in one transaction (or a savepoint of the caller's): on any error nothing of it
   * changes. A link that stays keeps its `created` time; a subject given twice is one link. A subject linked to another account throws
   * `LinkTaken`; the primary key decides that, so of two writers that link one subject at the same moment only one can win. `[]` removes
   * every link.
   */
  setForAccount(kind: AccountKind, name: string, links: Link[]): void {
    inTransaction(this.db, () => {
      const kept = new Map<string, number>();
      for (const r of this.db.prepare("SELECT subject, created FROM tailnet_links WHERE account_kind = ? AND name = ?").all(kind, name) as { subject: string; created: number }[]) {
        kept.set(r.subject, r.created);
      }
      this.db.prepare("DELETE FROM tailnet_links WHERE account_kind = ? AND name = ?").run(kind, name);
      const ins = this.db.prepare("INSERT INTO tailnet_links (subject, kind, account_kind, name, created) VALUES (?, ?, ?, ?, ?)");
      const t = this.now();
      const seen = new Set<string>();
      for (const l of links) {
        if (seen.has(l.subject)) continue;
        seen.add(l.subject);
        try {
          ins.run(l.subject, linkKind(l.subject), kind, name, kept.get(l.subject) ?? t);
        } catch (e) {
          if (!/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw e;
          const o = this.owner(l.subject);
          throw o ? new LinkTaken(l.subject, linkKind(l.subject), o.kind, o.name) : e;
        }
      }
    });
  }

  /** The names of one kind that hold at least one link, in name order. */
  accounts(kind: AccountKind): string[] {
    const rows = this.db.prepare("SELECT DISTINCT name FROM tailnet_links WHERE account_kind = ? ORDER BY name").all(kind) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** Removes every link of one account; the admin routes call it inside their delete transaction. */
  removeAccount(kind: AccountKind, name: string): void {
    this.db.prepare("DELETE FROM tailnet_links WHERE account_kind = ? AND name = ?").run(kind, name);
  }

  /**
   * Whether the account has a link that can sign in with the configured source (decision 7): none with no source; any link with the
   * socket; only a login link with the headers, which never carry tags.
   */
  counts(kind: AccountKind, name: string, mode: "socket" | "headers" | null): boolean {
    if (mode === null) return false;
    const sql =
      mode === "socket"
        ? "SELECT 1 FROM tailnet_links WHERE account_kind = ? AND name = ? LIMIT 1"
        : "SELECT 1 FROM tailnet_links WHERE account_kind = ? AND name = ? AND kind = 'login' LIMIT 1";
    return this.db.prepare(sql).get(kind, name) !== undefined;
  }
}

export type Resolution =
  | { ok: true; kind: AccountKind; name: string; subject: string; match: LinkKind }
  | { ok: false; reason: "unlinked" | "tag-conflict"; accounts?: string[] };

/**
 * Turns a tailnet identity into one account (decision 3). A linked login wins. Otherwise the device's linked tags, in sorted order: none
 * refuses (`unlinked`); all of one account give that account, with the first matching tag as subject; two or more accounts refuse
 * (`tag-conflict`, with `kind:name` of each, sorted). Pure: the sign-in route and the gate run the same code.
 */
export function resolve(id: TailnetIdentity, links: Pick<TailnetLinks, "owner">): Resolution {
  if (id.login !== undefined) {
    const o = links.owner(id.login);
    if (o) return { ok: true, kind: o.kind, name: o.name, subject: id.login, match: "login" };
  }
  let first: { subject: string; kind: AccountKind; name: string } | undefined;
  const found = new Set<string>();
  for (const tag of [...id.tags].sort()) {
    const o = links.owner(tag);
    if (!o) continue;
    first ??= { subject: tag, kind: o.kind, name: o.name };
    found.add(`${o.kind}:${o.name}`);
  }
  if (!first) return { ok: false, reason: "unlinked" };
  if (found.size > 1) return { ok: false, reason: "tag-conflict", accounts: [...found].sort() };
  return { ok: true, kind: first.kind, name: first.name, subject: first.subject, match: "tag" };
}
