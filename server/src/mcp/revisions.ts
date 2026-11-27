/**
 * The revision of a resource body. A client that reconnects reads each resource again and compares the revision with the one it kept: equal means
 * nothing it follows changed. A revision never goes down for a URI, also across a hub restart: when the stable content of a resource differs from the last
 * one seen, the new revision is the larger of the old one plus one and the hub clock in milliseconds. The first sight of a URI in a new process also takes
 * the clock, so a restart can make a client read once more, and never makes it miss a change. Compare for equality only; the number is not a counter.
 *
 * The "stable content" is what a notification announces (a job state, a scanned root, a node state), not the values that move all the time (sample time,
 * journal size, scan progress).
 */
export class RevisionBook {
  private readonly rows = new Map<string, { key: string; revision: number; updatedAt: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly max = 5000) {}

  /** The stable content last stamped for a URI. */
  keyOf(uri: string): string | undefined {
    return this.rows.get(uri)?.key;
  }

  stamp(uri: string, key: string): { revision: number; updatedAt: number } {
    const t = this.now();
    const row = this.rows.get(uri);
    if (row && row.key === key) {
      this.rows.delete(uri); // most recently used last
      this.rows.set(uri, row);
      return { revision: row.revision, updatedAt: row.updatedAt };
    }
    const next = { key, revision: Math.max((row?.revision ?? 0) + 1, t), updatedAt: t };
    this.rows.delete(uri);
    this.rows.set(uri, next);
    // an old row is forgotten only when the book is full; the clock keeps the revision above any forgotten one
    if (this.rows.size > this.max) this.rows.delete(this.rows.keys().next().value as string);
    return { revision: next.revision, updatedAt: next.updatedAt };
  }
}
