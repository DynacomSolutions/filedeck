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
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The ends worth a push: done or failed (never canceled), started from the app, ended at or after `since` and in the last day. */
export function endsToSend(jobs: SourcedJob[], since: number, now: number): SourcedJob[] {
  return jobs.filter(
    (j) =>
      (j.state === "done" || j.state === "failed") &&
      (j.origin === undefined || j.origin === "ui") &&
      typeof j.finishedAt === "number" &&
      j.finishedAt >= since &&
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

export interface PushWatchDeps {
  store: PushStore;
  /** the VAPID contact */
  subject: string;
  signIn: boolean;
  /** sign-in on: whether the session kept under a key is still valid */
  sessionHolds?: (session: string) => boolean;
  /** sign-in on: the identity of `sys:<name>` / `virt:<name>` now, or undefined when the account is gone */
  identityOf: (owner: string) => Identity | undefined;
  /** the account's jobs from every list, asked as `id` (undefined: sign-in off) */
  listJobs: (id: Identity | undefined) => Promise<SourcedJob[]>;
  send?: (o: Parameters<typeof sendPush>[0]) => Promise<number>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class PushWatch {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly logged = new Set<string>();

  constructor(private readonly d: PushWatchDeps) {}

  start(everyMs = 15_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One pass over every account with a subscription; a pass still running is joined, never doubled. */
  tick(): Promise<void> {
    return (this.running ??= this.pass().finally(() => (this.running = undefined)));
  }

  private logOnce(key: string, msg: string) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    (this.d.log ?? console.error)(msg);
  }

  private async pass(): Promise<void> {
    const { store } = this.d;
    const now = this.d.now ?? Date.now;
    store.prune();
    for (const owner of store.owners()) {
      try {
        let subs = store.of(owner);
        if (this.d.signIn) {
          for (const s of subs) {
            if (!s.session) store.drop(s.endpoint);
            else if (!this.d.sessionHolds?.(s.session)) store.removeSession(s.session);
          }
          subs = store.of(owner);
          if (!subs.length) continue;
        }
        let id: Identity | undefined;
        if (this.d.signIn) {
          id = this.d.identityOf(owner);
          if (!id) {
            store.removeOwner(owner);
            continue;
          }
        }
        const since = Math.min(...subs.map((s) => s.created));
        const ends = endsToSend(await this.d.listJobs(id), since, now()).filter((j) => store.claim(`${owner}|${j.source}|${j.id}`));
        if (ends.length) await Promise.all(subs.map((s) => this.sendTo(s, ends)));
      } catch (e) {
        this.logOnce(`owner:${owner}`, `push: job watch for an account failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      }
    }
  }

  private async sendTo(s: PushSub, ends: SourcedJob[]): Promise<void> {
    const mine = ends.filter((j) => (j.finishedAt ?? 0) >= s.created);
    if (!mine.length) return;
    try {
      const status = await (this.d.send ?? sendPush)({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }, vapid: this.d.store.keys(), subject: this.d.subject, payload: payloadFor(mine) });
      if (status === 404 || status === 410) this.d.store.drop(s.endpoint);
      else if (status >= 400) this.logOnce(`status:${new URL(s.endpoint).host}:${status}`, `push: the push service ${new URL(s.endpoint).host} answered ${status}`);
    } catch (e) {
      this.logOnce(`send:${new URL(s.endpoint).host}`, `push: could not reach the push service ${new URL(s.endpoint).host}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    }
  }
}
