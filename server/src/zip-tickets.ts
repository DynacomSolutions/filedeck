import { randomBytes } from "node:crypto";

export interface ZipSelection {
  dir: string;
  names: string[];
}

/**
 * Short-lived, one-use download tickets for zips of long selections. The browser posts the name list,
 * gets an unguessable id and then downloads from a plain GET with that id, so its own download
 * manager streams the zip to disk instead of the page holding it in memory.
 */
export class ZipTickets {
  private readonly map = new Map<string, { sel: ZipSelection; expires: number }>();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly max = 200,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep() {
    const t = this.now();
    for (const [id, e] of this.map) if (e.expires <= t) this.map.delete(id);
  }

  /** Store a selection; returns the id, or null when too many tickets are outstanding. */
  issue(sel: ZipSelection): string | null {
    this.sweep();
    if (this.map.size >= this.max) return null;
    const id = randomBytes(24).toString("hex");
    this.map.set(id, { sel, expires: this.now() + this.ttlMs });
    return id;
  }

  /** Look at a ticket without using it (HEAD requests). */
  peek(id: string): ZipSelection | null {
    const e = this.map.get(id);
    return e && e.expires > this.now() ? e.sel : null;
  }

  /** Use a ticket: it works once. */
  take(id: string): ZipSelection | null {
    const sel = this.peek(id);
    this.map.delete(id);
    return sel;
  }
}
