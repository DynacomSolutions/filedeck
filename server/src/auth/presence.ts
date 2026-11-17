/** How long an answer counts as fresh. */
export const PRESENCE_TTL_MS = 300_000;
/** A name is not asked again sooner than this when a node gave no answer (a node that is down is not asked on every request). */
export const PRESENCE_RETRY_MS = 10_000;
/** The most names the cache holds; the one asked longest ago is dropped first. */
export const PRESENCE_MAX_NAMES = 4096;

interface Entry {
  /** when the last refresh for this name started */
  asked: number;
  answers: Map<string, { exists: boolean; at: number }>;
}

/**
 * Which machines a system account exists on, as the agents said (hub, sign-in on). `check` asks one agent's lookup: true, false (also
 * for a name that is root there, or whose lookup failed on the agent), or undefined (no answer, a bad answer, too slow). Only true and
 * false are kept; the last one stays until a new answer replaces it. `known` is what the hub's access check (`canUseNode`) reads: false
 * hides the machine, true and undefined do not.
 *
 * One refresh per name runs at a time, and every caller shares it. The cache holds at most `maxNames` names.
 */
export class SysPresence {
  readonly maxNames: number;
  private readonly check: (node: string, name: string) => Promise<boolean | undefined>;
  private readonly nodes: string[];
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(o: { check: (node: string, name: string) => Promise<boolean | undefined>; nodes: string[]; ttlMs?: number; retryMs?: number; maxNames?: number; now?: () => number }) {
    this.check = o.check;
    this.nodes = [...o.nodes];
    this.ttlMs = o.ttlMs ?? PRESENCE_TTL_MS;
    this.retryMs = o.retryMs ?? PRESENCE_RETRY_MS;
    this.maxNames = o.maxNames ?? PRESENCE_MAX_NAMES;
    this.now = o.now ?? Date.now;
  }

  /** The last answer for `name` on `node`, or undefined when there is none. */
  known(name: string, node: string): boolean | undefined {
    return this.entries.get(name)?.answers.get(node)?.exists;
  }

  /**
   * Whether a caller should wait for a refresh: one is running, or some node has no fresh answer and the name was not asked within
   * `retryMs`.
   */
  due(name: string): boolean {
    if (this.running.has(name)) return true;
    const e = this.entries.get(name);
    if (!e) return true;
    const t = this.now();
    if (t - e.asked < this.retryMs) return false;
    return this.nodes.some((n) => {
      const a = e.answers.get(n);
      return !a || t - a.at >= this.ttlMs;
    });
  }

  /**
   * Asks every node in parallel and keeps the answers that come. A refresh already running for the name is shared. With `timeoutMs`
   * the caller waits no longer than that; the asks go on, and their answers are kept when they come. It never rejects.
   */
  async refresh(name: string, timeoutMs?: number): Promise<void> {
    let p = this.running.get(name);
    if (!p) {
      p = this.start(name);
      this.running.set(name, p);
      void p.finally(() => this.running.delete(name));
    }
    if (timeoutMs === undefined) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async start(name: string): Promise<void> {
    const old = this.entries.get(name);
    const e: Entry = { asked: this.now(), answers: old?.answers ?? new Map() };
    // newest last: re-inserted, and the oldest names dropped past the limit
    this.entries.delete(name);
    this.entries.set(name, e);
    this.trim();
    await Promise.all(
      this.nodes.map(async (node) => {
        try {
          const v = await this.check(node, name);
          if (typeof v === "boolean") e.answers.set(node, { exists: v, at: this.now() });
        } catch {
          /* no answer: the last one stays */
        }
      }),
    );
    // dropped (the cache was full) while the asks ran: put the answers back as the newest name
    if (!this.entries.has(name)) {
      this.entries.set(name, e);
      this.trim();
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxNames) this.entries.delete(this.entries.keys().next().value as string);
  }
}
