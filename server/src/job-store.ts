import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openDb } from "./index-cache.ts";

export interface JobRow {
  id: string;
  scope: string;
  kind: string;
  title: string;
  /** JSON of an explicit allowlist, null = the job cannot be rebuilt */
  params: string | null;
  /** JobView JSON */
  view: string;
  state: string;
  owner: string;
  beat: number;
  cancel: number;
  created_at: number;
  finished_at: number | null;
}

const LIVE = "state IN ('queued','running')";
const WEEK = 7 * 24 * 3600_000;

/**
 * Jobs in SQLite, shared by every process that opens the file (two pods overlap during a rollout). Every call is best effort:
 * a busy or failing database is skipped (never waited on), because a stalled disk once blocked /healthz.
 */
export class JobStore {
  private db: DatabaseSync | null;
  private q = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = openDb(file, 1024);
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA busy_timeout=100");
      this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        params TEXT, view TEXT NOT NULL, state TEXT NOT NULL, owner TEXT NOT NULL, beat INTEGER NOT NULL,
        cancel INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER)`);
    } catch {
      this.db = null;
    }
  }

  private run<T>(sql: string, fn: (s: StatementSync) => T, fallback: T): T {
    if (!this.db) return fallback;
    try {
      let s = this.q.get(sql);
      if (!s) this.q.set(sql, (s = this.db.prepare(sql)));
      return fn(s);
    } catch {
      return fallback;
    }
  }

  /** Insert, or update the row while `r.owner` still owns it. Returns false when someone else owns it (or the database is busy). */
  put(r: Omit<JobRow, "cancel">): boolean {
    return this.run(
      `INSERT INTO jobs (id,scope,kind,title,params,view,state,owner,beat,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET view=excluded.view, state=excluded.state, beat=excluded.beat, finished_at=excluded.finished_at WHERE owner=excluded.owner`,
      (s) => s.run(r.id, r.scope, r.kind, r.title, r.params, r.view, r.state, r.owner, r.beat, r.created_at, r.finished_at).changes > 0,
      false,
    );
  }

  /** Heartbeat: false = the row is no longer ours live; undefined = the database was busy (skip, no verdict). */
  beat(id: string, owner: string, view: string, now: number): boolean | undefined {
    return this.run<boolean | undefined>(`UPDATE jobs SET view=?, beat=? WHERE id=? AND owner=? AND ${LIVE}`, (s) => s.run(view, now, id, owner).changes > 0, undefined);
  }

  get(id: string): JobRow | undefined {
    return this.run("SELECT * FROM jobs WHERE id=?", (s) => s.get(id) as unknown as JobRow | undefined, undefined);
  }

  list(scope: string): JobRow[] {
    return this.run("SELECT * FROM jobs WHERE scope=?", (s) => s.all(scope) as unknown as JobRow[], []);
  }

  /** Ask the owner to cancel a live job. */
  setCancel(id: string): boolean {
    return this.run(`UPDATE jobs SET cancel=1 WHERE id=? AND ${LIVE}`, (s) => s.run(id).changes > 0, false);
  }

  /** Ids of this owner's live jobs that others asked to cancel. */
  canceled(owner: string): string[] {
    return this.run(`SELECT id FROM jobs WHERE owner=? AND cancel=1 AND ${LIVE}`, (s) => (s.all(owner) as { id: string }[]).map((r) => r.id), []);
  }

  /** Live jobs of other owners whose lease ran out (or who handed over with beat 0). */
  orphans(scope: string, me: string, cutoff: number): JobRow[] {
    return this.run(`SELECT * FROM jobs WHERE scope=? AND owner<>? AND ${LIVE} AND beat<?`, (s) => s.all(scope, me, cutoff) as unknown as JobRow[], []);
  }

  /** Compare and swap: only one process wins a given (owner, beat). */
  claim(id: string, from: string, beat: number, me: string, now: number): boolean {
    return this.run("UPDATE jobs SET owner=?, beat=? WHERE id=? AND owner=? AND beat=?", (s) => s.run(me, now, id, from, beat).changes > 0, false);
  }

  /** The owner is stopping: let another process adopt its live jobs at once. */
  release(owner: string) {
    this.run(`UPDATE jobs SET beat=0 WHERE owner=? AND ${LIVE}`, (s) => s.run(owner), undefined);
  }

  delete(id: string) {
    this.run("DELETE FROM jobs WHERE id=?", (s) => s.run(id), undefined);
  }

  /** Keep the newest `keep` finished rows of the scope; drop anything finished over a week ago. */
  prune(scope: string, keep: number, now: number) {
    this.run(
      `DELETE FROM jobs WHERE scope=? AND finished_at IS NOT NULL AND (finished_at<? OR id NOT IN
        (SELECT id FROM jobs WHERE scope=? AND finished_at IS NOT NULL ORDER BY finished_at DESC, id LIMIT ?))`,
      (s) => s.run(scope, now - WEEK, scope, keep),
      undefined,
    );
  }
}
