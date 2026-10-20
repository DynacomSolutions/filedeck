import fs from "node:fs";
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
  private db: DatabaseSync | null = null;
  private q = new Map<string, StatementSync>();

  constructor(file: string) {
    for (let attempt = 0; attempt < 2 && !this.db; attempt++) {
      try {
        const db = openDb(file, 1024);
        if (!db) return;
        db.exec("PRAGMA busy_timeout=100");
        db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
          params TEXT, view TEXT NOT NULL, state TEXT NOT NULL, owner TEXT NOT NULL, beat INTEGER NOT NULL,
          cancel INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER)`);
        db.prepare("SELECT count(*) FROM jobs").get();
        this.db = db;
      } catch (e) {
        // A busy file belongs to another process (a surging pod) and is never touched; a damaged one is started afresh.
        const code = (e as { errcode?: number }).errcode;
        const contended = code === 5 || code === 6;
        console.error(contended ? "job store busy:" : "job store reset:", (e as Error).message);
        if (!contended && attempt === 0) for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });
        else return; // memory-only from here on
      }
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
       ON CONFLICT(id) DO UPDATE SET params=excluded.params, view=excluded.view, state=excluded.state, beat=excluded.beat, finished_at=excluded.finished_at WHERE owner=excluded.owner`,
      (s) => s.run(r.id, r.scope, r.kind, r.title, r.params, r.view, r.state, r.owner, r.beat, r.created_at, r.finished_at).changes > 0,
      false,
    );
  }

  /**
   * Heartbeat for all of the owner's live jobs in one transaction. Returns the ids that are no longer ours live,
   * or undefined when the database was busy (skip, no verdict).
   */
  beatAll(owner: string, items: { id: string; view: string }[], now: number): string[] | undefined {
    if (!items.length) return [];
    const db = this.db;
    if (!db) return undefined;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch {
      return undefined;
    }
    try {
      const s = db.prepare(`UPDATE jobs SET view=?, beat=? WHERE id=? AND owner=? AND ${LIVE}`);
      const lost = items.filter((i) => s.run(i.view, now, i.id, owner).changes === 0).map((i) => i.id);
      db.exec("COMMIT");
      return lost;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing open */
      }
      return undefined;
    }
  }

  get(id: string, scope: string): JobRow | undefined {
    return this.run("SELECT * FROM jobs WHERE id=? AND scope=?", (s) => s.get(id, scope) as unknown as JobRow | undefined, undefined);
  }

  list(scope: string): JobRow[] {
    return this.run("SELECT * FROM jobs WHERE scope=?", (s) => s.all(scope) as unknown as JobRow[], []);
  }

  /** Ask the owner to cancel a live job. */
  setCancel(id: string, scope: string): boolean {
    return this.run(`UPDATE jobs SET cancel=1 WHERE id=? AND scope=? AND ${LIVE}`, (s) => s.run(id, scope).changes > 0, false);
  }

  /** Ask the owner for pause (2) or resume (3); a pending cancel is never overwritten. */
  setFlag(id: string, scope: string, flag: 2 | 3): boolean {
    return this.run(`UPDATE jobs SET cancel=? WHERE id=? AND scope=? AND cancel<>1 AND ${LIVE}`, (s) => s.run(flag, id, scope).changes > 0, false);
  }

  /** This owner's live jobs with a pause (2) or resume (3) request. */
  flagged(owner: string): { id: string; cancel: number }[] {
    return this.run(`SELECT id, cancel FROM jobs WHERE owner=? AND cancel IN (2,3) AND ${LIVE}`, (s) => s.all(owner) as { id: string; cancel: number }[], []);
  }

  clearFlag(id: string) {
    this.run("UPDATE jobs SET cancel=0 WHERE id=? AND cancel IN (2,3)", (s) => s.run(id), undefined);
  }

  /** Ids of this owner's live jobs that others asked to cancel. */
  canceled(owner: string): string[] {
    return this.run(`SELECT id FROM jobs WHERE owner=? AND cancel=1 AND ${LIVE}`, (s) => (s.all(owner) as { id: string }[]).map((r) => r.id), []);
  }

  /** Live jobs whose owner's lease ran out (or who handed over with beat 0), and live rows of `me` (the caller skips those it holds). */
  orphans(scope: string, me: string, cutoff: number): JobRow[] {
    return this.run(`SELECT * FROM jobs WHERE scope=? AND ${LIVE} AND (owner=? OR beat<?)`, (s) => s.all(scope, me, cutoff) as unknown as JobRow[], []);
  }

  /** Claim and fail in one swap, so a busy database cannot leave a claimed row nobody runs. */
  failClaim(r: JobRow, me: string, view: string, now: number): boolean {
    return this.run(
      "UPDATE jobs SET owner=?, beat=?, state='failed', view=?, finished_at=? WHERE id=? AND owner=? AND beat=?",
      (s) => s.run(me, now, view, now, r.id, r.owner, r.beat).changes > 0,
      false,
    );
  }

  /** Compare and swap: only one process wins a given (owner, beat). */
  claim(id: string, from: string, beat: number, me: string, now: number): boolean {
    return this.run("UPDATE jobs SET owner=?, beat=? WHERE id=? AND owner=? AND beat=?", (s) => s.run(me, now, id, from, beat).changes > 0, false);
  }

  /** The owner is stopping: let another process adopt its live jobs at once. */
  release(owner: string) {
    this.run(`UPDATE jobs SET beat=0 WHERE owner=? AND ${LIVE}`, (s) => s.run(owner), undefined);
  }

  delete(id: string, scope: string) {
    this.run("DELETE FROM jobs WHERE id=? AND scope=?", (s) => s.run(id, scope), undefined);
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
