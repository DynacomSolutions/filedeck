import type { Identity } from "../auth/identity.ts";
import type { PushStore, PushSub } from "./store.ts";
import { sendPush } from "./webpush.ts";

/**
 * The hub's job watch for Web Push. For each account with a push subscription it lists that account's jobs (hub operations, compares,
 * each machine's jobs, asked as the account) and sends a push for each job started from the app that finished or failed. A
 * subscription whose session no longer holds, or whose account is gone, is removed before anything is sent.
 */

/** A job from one of the account's job lists; `source` names the list (`ops`, `diff`, `node:<name>`). */
export interface SourcedJob {
  source: string;
  id: string;
  title: string;
  state: string;
  origin?: string;
  finishedAt?: number;
  error?: string;
}

/** how far back a job end is looked for, whatever the subscription's age */
const LOOK_BACK_MS = 24 * 3600_000;
/** a machine's clock may be this far behind the hub's: an end stamped this much before the subscription still counts */
const CLOCK_SLACK_MS = 60_000;
/** accounts looked at side by side in one pass */
const PARALLEL = 4;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The ends worth a push: done or failed (never canceled), started from the app, ended at or after `since` and in the last day. */
export function endsToSend(jobs: SourcedJob[], since: number, now: number): SourcedJob[] {
  return jobs.filter(
    (j) =>
      (j.state === "done" || j.state === "failed") &&
      (j.origin === undefined || j.origin === "ui") &&
      typeof j.finishedAt === "number" &&
      j.finishedAt >= since - CLOCK_SLACK_MS &&
      now - j.finishedAt <= LOOK_BACK_MS,
  );
}

const line = (j: SourcedJob) => `${cut(j.title, 120)} ${j.state === "failed" ? "failed" : "finished"}`;

/** The notification: one end as its title and outcome (the first line of its error), several as one count. */
export function payloadFor(ends: SourcedJob[]): { title: string; body: string; tag: string } {
  if (ends.length === 1) {
    const j = ends[0]!;
    return { title: line(j), body: cut((j.error ?? "").split("\n")[0] ?? "", 300), tag: `filedeck-job:${j.source}:${j.id}` };
  }
  const failed = ends.filter((j) => j.state === "failed").length;
  return {
    title: failed ? `${ends.length} jobs ended, ${failed} failed` : `${ends.length} jobs finished`,
    body: cut(ends.map(line).join("\n"), 300),
    tag: "filedeck-jobs",
  };
}

export type SessionState = { state: "valid" | "idle"; until: number } | { state: "gone" };

export interface PushWatchDeps {
  store: PushStore;
  /** the VAPID contact */
  subject: string;
  signIn: boolean;
  /** sign-in on: the session kept under a key (sessions.ts `state`) */
  sessionState?: (session: string) => SessionState;
  /** sign-in on: the identity of `sys:<name>` / `virt:<name>` now, or undefined when the account is gone */
  identityOf: (owner: string) => Identity | undefined;
  /** the account's jobs from every list, asked as `id` (undefined: sign-in off); `signal` ends the wait when the hub stops */
  listJobs: (id: Identity | undefined, signal?: AbortSignal) => Promise<SourcedJob[]>;
  send?: (o: Parameters<typeof sendPush>[0]) => Promise<number>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class PushWatch {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly logged = new Set<string>();
  private readonly stopping = new AbortController();

  constructor(private readonly d: PushWatchDeps) {}

  start(everyMs = 15_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  /** Ends a pass at once: its waits are cut and the claims of sends not made are given back, for the next hub to send. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.stopping.abort();
    await this.running;
  }

  /** One pass over every account with a subscription; a pass still running is joined, never doubled. */
  tick(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    return (this.running ??= this.pass().finally(() => (this.running = undefined)));
  }

  private logOnce(key: string, msg: string) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    (this.d.log ?? console.error)(msg);
  }

  /**
   * The subscriptions of `owner` that may get a push now. Sign-in on: a valid session; a session gone idle (the app was closed) keeps
   * its subscriptions, without it, until its absolute end; anything else is removed. Rows of the other sign-in mode are removed.
   */
  private live(owner: string): PushSub[] {
    const { store } = this.d;
    const now = (this.d.now ?? Date.now)();
    if (!this.d.signIn) {
      if (owner !== "") store.removeOwner(owner);
      return owner === "" ? store.of(owner) : [];
    }
    if (owner === "") {
      store.removeOwner(owner);
      return [];
    }
    for (const s of store.of(owner)) {
      if (s.session) {
        const st = this.d.sessionState?.(s.session) ?? { state: "gone" };
        if (st.state === "idle") store.detach(s.session, st.until);
        else if (st.state === "gone") store.removeSession(s.session);
      } else if (s.until === null || s.until <= now) store.drop(s.endpoint);
    }
    return store.of(owner);
  }

  private async pass(): Promise<void> {
    const { store } = this.d;
    store.prune();
    const owners = store.owners();
    const next = async () => {
      for (let o = owners.shift(); o !== undefined && !this.stopping.signal.aborted; o = owners.shift()) await this.forOwner(o);
    };
    await Promise.all(Array.from({ length: PARALLEL }, next));
  }

  private async forOwner(owner: string): Promise<void> {
    const { store } = this.d;
    const now = this.d.now ?? Date.now;
    try {
      const subs = this.live(owner);
      if (!subs.length) return;
      let id: Identity | undefined;
      if (this.d.signIn) {
        id = this.d.identityOf(owner);
        if (!id) return void store.removeOwner(owner);
      }
      const since = Math.min(...subs.map((s) => s.created));
      const ends = endsToSend(await this.d.listJobs(id, this.stopping.signal), since, now());
      if (!ends.length || this.stopping.signal.aborted) return;
      // the sessions are looked at again: one may have ended while the jobs were listed
      const still = new Set(this.live(owner).map((s) => s.endpoint));
      await Promise.all(subs.filter((s) => still.has(s.endpoint)).map((s) => this.sendTo(s, ends)));
    } catch (e) {
      if (!this.stopping.signal.aborted) this.logOnce(`owner:${owner}`, `push: job watch for an account failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    }
  }

  /** Each subscription claims each end for itself (shared by the hub pods), so a failed send is tried again and a delivered one never. */
  private async sendTo(s: PushSub, ends: SourcedJob[]): Promise<void> {
    const { store } = this.d;
    const keys = new Map<string, SourcedJob>();
    for (const j of endsToSend(ends, s.created, (this.d.now ?? Date.now)())) {
      const k = `${s.endpoint}|${j.source}|${j.id}`;
      if (store.claim(k)) keys.set(k, j);
    }
    if (!keys.size) return;
    const giveBack = () => keys.forEach((_, k) => store.unclaim(k));
    const host = new URL(s.endpoint).host;
    try {
      const status = await (this.d.send ?? sendPush)({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
        vapid: store.keys(),
        subject: this.d.subject,
        payload: payloadFor([...keys.values()]),
        signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(15_000)]),
      });
      if (status === 404 || status === 410) store.drop(s.endpoint);
      else if (status === 429 || status >= 500) {
        giveBack();
        this.logOnce(`status:${host}:${status}`, `push: the push service ${host} answered ${status}; tried again at the next pass`);
      } else if (status >= 400) this.logOnce(`status:${host}:${status}`, `push: the push service ${host} answered ${status}`);
    } catch (e) {
      giveBack();
      if (!this.stopping.signal.aborted) this.logOnce(`send:${host}`, `push: could not reach the push service ${host}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    }
  }
}
