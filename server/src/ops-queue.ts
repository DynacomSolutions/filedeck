import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Target } from "./hub.ts";

/**
 * Hub-side queue for bulk file operations (copy, move, trash, delete, folder-diff sync).
 * Jobs live in hub memory, so they keep running when the browser closes. Each job
 * processes its items one after another; files between nodes or network sources are
 * streamed through the hub with byte counting, pause and cancel.
 */

export type ConflictPolicy = "ask" | "skip" | "overwrite" | "rename";
export type Choice = "skip" | "overwrite" | "rename";
export interface Loc {
  node: string;
  path: string;
}
export type SyncStep =
  | { kind: "mkdir"; node: string; path: string }
  | { kind: "trash"; node: string; path: string }
  | { kind: "copy"; src: Loc; dst: { node: string; dir: string }; bytes?: number };
export type OpSpec =
  | { op: "copy" | "move"; items: Loc[]; dst: { node: string; dir: string }; conflict: ConflictPolicy; preserveTimes?: boolean }
  | { op: "trash" | "delete"; items: Loc[] }
  | { op: "sync"; steps: SyncStep[]; title?: string };

export type OpState = "queued" | "running" | "paused" | "waiting" | "done" | "failed" | "canceled";
export type ItemState = "pending" | "running" | "done" | "skipped" | "failed";

export interface ItemView {
  label: string;
  state: ItemState;
  bytes: number;
  size: number;
  note?: string;
  error?: string;
}
export interface PendingConflict {
  /** the destination that is in the way, as node:path */
  target: string;
  name: string;
  srcType: string;
  dstType: string;
  srcSize: number;
  dstSize: number;
}
export interface OpView {
  id: string;
  kind: "ops";
  op: OpSpec["op"];
  title: string;
  state: OpState;
  conflictPolicy?: ConflictPolicy;
  progress: { bytes: number; totalBytes: number; entries: number; totalEntries: number; current: string };
  /** bytes per second, smoothed */
  speed: number;
  counts: { total: number; done: number; skipped: number; failed: number };
  conflict?: PendingConflict;
  items?: ItemView[];
  itemsTruncated?: boolean;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export class OpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}
class Aborted extends Error {
  constructor() {
    super("canceled");
  }
}

interface TreeRes {
  errors: number;
  skipped: number;
  firstError?: string;
}

interface StatLite {
  type: string;
  size?: number;
  mtime?: number;
}

interface Job {
  id: string;
  spec: OpSpec;
  title: string;
  state: "queued" | "running" | "done" | "failed" | "canceled";
  paused: boolean;
  waiting?: { conflict: PendingConflict; resolve: (c: { action: Choice; all: boolean }) => void };
  policy: ConflictPolicy;
  progress: OpView["progress"];
  speed: number;
  items: ItemView[];
  counts: OpView["counts"];
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  abort: AbortController;
  gate?: { promise: Promise<void>; open: () => void };
  /** a pause happened during the current file, so one failure is retried */
  pausedDuring: boolean;
}

const q = encodeURIComponent;
const joinP = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
const MAX_ITEMS_VIEW = 2000;

/** "name (1).ext", "name (2).ext", ... first that is not in `taken`. */
export function freeName(name: string, taken: (n: string) => boolean | Promise<boolean>): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return (async () => {
    for (let i = 1; i < 10000; i++) {
      const cand = `${base} (${i})${ext}`;
      if (!(await taken(cand))) return cand;
    }
    throw new OpError(409, "cannot find a free name");
  })();
}

export interface OpQueueDeps {
  agents: Map<string, Target>;
  isSource: (node: string) => boolean;
  concurrency?: number;
  keep?: number;
}

export class OpQueue {
  private jobs = new Map<string, Job>();
  private running = 0;
  constructor(private d: OpQueueDeps) {}

  create(spec: OpSpec): OpView {
    const items: ItemView[] =
      spec.op === "sync"
        ? spec.steps.map((s) => ({
            label: s.kind === "copy" ? `copy ${s.src.node}:${s.src.path} -> ${s.dst.node}:${s.dst.dir}` : `${s.kind} ${s.node}:${s.path}`,
            state: "pending" as const,
            bytes: 0,
            size: s.kind === "copy" ? (s.bytes ?? 0) : 0,
          }))
        : spec.items.map((i) => ({ label: `${i.node}:${i.path}`, state: "pending" as const, bytes: 0, size: 0 }));
    const job: Job = {
      id: randomUUID(),
      spec,
      title: titleOf(spec),
      state: "queued",
      paused: false,
      policy: spec.op === "copy" || spec.op === "move" ? spec.conflict : "overwrite",
      progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" },
      speed: 0,
      items,
      counts: { total: items.length, done: 0, skipped: 0, failed: 0 },
      createdAt: Date.now(),
      abort: new AbortController(),
      pausedDuring: false,
    };
    this.jobs.set(job.id, job);
    this.prune();
    this.pump();
    return this.view(job, false);
  }

  private view(j: Job, withItems: boolean): OpView {
    const state: OpState = j.state === "running" ? (j.waiting ? "waiting" : j.paused ? "paused" : "running") : j.state === "queued" && j.paused ? "paused" : j.state;
    const v: OpView = {
      id: j.id,
      kind: "ops",
      op: j.spec.op,
      title: j.title,
      state,
      progress: { ...j.progress },
      speed: Math.round(j.speed),
      counts: { ...j.counts },
      createdAt: j.createdAt,
    };
    if (j.spec.op === "copy" || j.spec.op === "move") v.conflictPolicy = j.policy;
    if (j.waiting) v.conflict = j.waiting.conflict;
    if (j.error) v.error = j.error;
    if (j.startedAt) v.startedAt = j.startedAt;
    if (j.finishedAt) v.finishedAt = j.finishedAt;
    if (withItems) {
      v.items = j.items.slice(0, MAX_ITEMS_VIEW).map((i) => ({ ...i }));
      if (j.items.length > MAX_ITEMS_VIEW) v.itemsTruncated = true;
    }
    return v;
  }

  list(): OpView[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => this.view(j, false));
  }
  get(id: string): OpView | undefined {
    const j = this.jobs.get(id);
    return j && this.view(j, true);
  }

  cancel(id: string): OpView | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.state === "queued") {
      j.state = "canceled";
      j.finishedAt = Date.now();
    } else if (j.state === "running") {
      j.abort.abort();
      j.gate?.open();
    }
    return this.view(j, false);
  }

  pause(id: string): OpView | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if ((j.state === "queued" || j.state === "running") && !j.paused) {
      j.paused = true;
      if (j.state === "running") j.pausedDuring = true;
      let open!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      j.gate = { promise, open };
    }
    return this.view(j, false);
  }

  resume(id: string): OpView | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.paused) {
      j.paused = false;
      j.gate?.open();
      j.gate = undefined;
    }
    return this.view(j, false);
  }

  /** Answer a pending conflict question. `all` applies the answer to the rest of the job. */
  resolve(id: string, action: Choice, all: boolean): OpView | undefined | "none" {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (!j.waiting) return "none";
    j.waiting.resolve({ action, all });
    return this.view(j, false);
  }

  dismiss(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state === "queued" || j.state === "running") return false;
    return this.jobs.delete(id);
  }

  private prune() {
    const keep = this.d.keep ?? 50;
    const finished = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const j of finished.slice(0, Math.max(0, finished.length - keep))) this.jobs.delete(j.id);
  }

  private pump() {
    for (const j of this.jobs.values()) {
      if (this.running >= (this.d.concurrency ?? 2)) return;
      if (j.state !== "queued") continue;
      this.running++;
      j.state = "running";
      j.startedAt = Date.now();
      void this.exec(j)
        .catch((e) => {
          if (j.abort.signal.aborted || e instanceof Aborted) j.state = "canceled";
          else {
            j.state = "failed";
            j.error = e instanceof OpError ? e.message : "operation failed";
          }
        })
        .finally(() => {
          j.finishedAt = Date.now();
          j.progress.current = "";
          this.running--;
          this.prune();
          this.pump();
        });
    }
  }

  // ---------------------------------------------------------------- execution

  private async exec(j: Job) {
    const sig = j.abort.signal;
    // Smoothed throughput, sampled once a second while the job is moving.
    let last = 0;
    const ticker = setInterval(() => {
      const delta = j.progress.bytes - last;
      last = j.progress.bytes;
      j.speed = j.paused || j.waiting ? 0 : j.speed * 0.5 + delta * 0.5;
    }, 1000);
    try {
      const ctx = this.ctx(j);
      await ctx.checkpoint();
      const spec = j.spec;
      if (spec.op === "copy" || spec.op === "move") await this.runTransfer(j, ctx, spec);
      else if (spec.op === "sync") await this.runSync(j, ctx, spec);
      else if (spec.op === "trash" || spec.op === "delete") await this.runRemove(j, ctx, spec);
      if (sig.aborted) throw new Aborted();
      j.state = j.counts.total > 0 && j.counts.failed === j.counts.total ? "failed" : "done";
      if (j.state === "failed") j.error = j.items.find((i) => i.error)?.error ?? "every item failed";
      j.speed = 0;
    } finally {
      clearInterval(ticker);
    }
  }

  private target(node: string): Target {
    const t = this.d.agents.get(node);
    if (!t) throw new OpError(404, `unknown node ${node}`);
    return t;
  }

  private ctx(j: Job) {
    const sig = j.abort.signal;
    const checkpoint = async () => {
      if (sig.aborted) throw new Aborted();
      while (j.paused && j.gate) {
        await j.gate.promise;
        if (sig.aborted) throw new Aborted();
      }
    };
    const ask = async (c: PendingConflict): Promise<Choice> => {
      if (j.policy !== "ask") return j.policy as Choice;
      await checkpoint();
      const answer = await new Promise<{ action: Choice; all: boolean }>((resolve, reject) => {
        j.waiting = { conflict: c, resolve };
        sig.addEventListener("abort", () => reject(new Aborted()), { once: true });
      }).finally(() => {
        j.waiting = undefined;
      });
      if (answer.all) j.policy = answer.action;
      return answer.action;
    };
    return { sig, checkpoint, ask };
  }

  private async failed(r: Response, what: string): Promise<OpError> {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    return new OpError(r.status === 404 ? 404 : r.status === 409 ? 409 : r.status >= 400 && r.status < 500 ? 400 : 502, `${what}: ${msg}`);
  }

  private async statOf(t: Target, p: string, signal: AbortSignal): Promise<StatLite | null> {
    const r = await t.fetch(`/api/fs/stat?path=${q(p)}`, { signal });
    if (r.status === 404) return null;
    if (!r.ok) throw await this.failed(r, "stat");
    return (await r.json()) as StatLite;
  }

  private async json(t: Target, p: string, body: unknown, signal: AbortSignal, what: string) {
    const r = await t.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!r.ok) throw await this.failed(r, what);
    return r;
  }

  private async listDir(t: Target, p: string, signal: AbortSignal, what: string) {
    const r = await t.fetch(`/api/fs/list?path=${q(p)}&hidden=1`, { signal });
    if (!r.ok) throw await this.failed(r, what);
    return ((await r.json()) as { entries: { name: string; path: string; type: string; size: number; mtime: number }[] }).entries;
  }

  /** Remove one path: node trash, or permanent on a network source (which has no trash). */
  private async removePath(node: string, p: string, signal: AbortSignal, permanent: boolean) {
    const t = this.target(node);
    const perm = permanent || this.d.isSource(node);
    await this.json(t, perm ? "/api/fs/delete" : "/api/fs/trash", { paths: [p] }, signal, perm ? "delete" : "trash");
  }

  /** Files and total bytes below a path (a file counts as itself). Best effort: 0/0 when the walk fails. */
  private async measure(t: Target, p: string, st: StatLite, signal: AbortSignal): Promise<{ files: number; bytes: number }> {
    if (st.type === "file") return { files: 1, bytes: st.size ?? 0 };
    if (st.type !== "dir") return { files: 0, bytes: 0 };
    try {
      const r = await t.fetch(`/api/fs/walk?path=${q(p)}&depth=64&max=500000&hidden=1`, { signal });
      if (!r.ok || !r.body) return { files: 0, bytes: 0 };
      let files = 0;
      let bytes = 0;
      const dec = new TextDecoder();
      let buf = "";
      const eat = (line: string) => {
        if (!line) return;
        const m = JSON.parse(line) as { e?: { t: string; s: number }[] };
        for (const e of m.e ?? []) if (e.t === "file") (files++, (bytes += e.s));
      };
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          eat(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      eat(buf);
      return { files, bytes };
    } catch (e) {
      if (signal.aborted) throw new Aborted();
      return { files: 0, bytes: 0 };
    }
  }

  private async runRemove(j: Job, ctx: ReturnType<OpQueue["ctx"]>, spec: Extract<OpSpec, { op: "trash" | "delete" }>) {
    j.progress.totalEntries = spec.items.length;
    for (let i = 0; i < spec.items.length; i++) {
      await ctx.checkpoint();
      const it = spec.items[i]!;
      const iv = j.items[i]!;
      iv.state = "running";
      j.progress.current = it.path;
      try {
        await this.removePath(it.node, it.path, ctx.sig, spec.op === "delete");
        iv.state = "done";
        j.counts.done++;
      } catch (e) {
        if (ctx.sig.aborted) throw new Aborted();
        iv.state = "failed";
        iv.error = (e as Error).message;
        j.counts.failed++;
      }
      j.progress.entries++;
    }
  }

  private async runSync(j: Job, ctx: ReturnType<OpQueue["ctx"]>, spec: Extract<OpSpec, { op: "sync" }>) {
    j.progress.totalEntries = spec.steps.length;
    j.progress.totalBytes = spec.steps.reduce((n, s) => n + (s.kind === "copy" ? (s.bytes ?? 0) : 0), 0);
    for (let i = 0; i < spec.steps.length; i++) {
      await ctx.checkpoint();
      const s = spec.steps[i]!;
      const iv = j.items[i]!;
      iv.state = "running";
      try {
        if (s.kind === "mkdir") {
          j.progress.current = `mkdir ${s.path}`;
          const r = await this.target(s.node).fetch("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: s.path }), signal: ctx.sig });
          if (!r.ok && r.status !== 409) throw await this.failed(r, "mkdir");
        } else if (s.kind === "trash") {
          j.progress.current = `trash ${s.path}`;
          await this.removePath(s.node, s.path, ctx.sig, false);
        } else {
          j.progress.current = s.src.path;
          const before = j.progress.bytes;
          await this.copyOne(j, ctx, s.src, s.dst, { overwrite: true, preserveTimes: true, move: false });
          iv.bytes = j.progress.bytes - before;
          // keep the byte total honest when the plan's size was off
          if (j.progress.bytes > j.progress.totalBytes) j.progress.totalBytes = j.progress.bytes;
        }
        iv.state = "done";
        j.counts.done++;
      } catch (e) {
        if (ctx.sig.aborted) throw new Aborted();
        iv.state = "failed";
        iv.error = (e as Error).message;
        j.counts.failed++;
      }
      j.progress.entries++;
    }
  }

  private async runTransfer(j: Job, ctx: ReturnType<OpQueue["ctx"]>, spec: Extract<OpSpec, { op: "copy" | "move" }>) {
    // Totals first, so progress has a denominator.
    j.progress.current = "scanning";
    const sizes: StatLite[] = [];
    for (const it of spec.items) {
      await ctx.checkpoint();
      const t = this.target(it.node);
      const st = await this.statOf(t, it.path, ctx.sig).catch((e) => {
        if (ctx.sig.aborted) throw new Aborted();
        throw e;
      });
      sizes.push(st ?? { type: "missing" });
      if (st) {
        const m = await this.measure(t, it.path, st, ctx.sig);
        j.progress.totalBytes += m.bytes;
        j.progress.totalEntries += m.files;
        j.items[sizes.length - 1]!.size = m.bytes;
      }
    }
    const preserveTimes = spec.preserveTimes === true;
    for (let i = 0; i < spec.items.length; i++) {
      await ctx.checkpoint();
      const it = spec.items[i]!;
      const iv = j.items[i]!;
      iv.state = "running";
      j.progress.current = it.path;
      const before = j.progress.bytes;
      try {
        const r = await this.copyOne(j, ctx, it, spec.dst, { overwrite: false, preserveTimes, move: spec.op === "move" }, iv);
        iv.state = r === "skipped" ? "skipped" : "done";
        if (r === "skipped") j.counts.skipped++;
        else j.counts.done++;
      } catch (e) {
        if (ctx.sig.aborted) throw new Aborted();
        iv.state = "failed";
        iv.error = (e as Error).message;
        j.counts.failed++;
      }
      iv.bytes = j.progress.bytes - before;
    }
  }

  /**
   * Copy or move one top-level item into `dst.dir`. `o.overwrite` forces replacement without asking
   * (sync); otherwise the job's conflict policy decides when the name is taken.
   */
  private async copyOne(
    j: Job,
    ctx: ReturnType<OpQueue["ctx"]>,
    src: Loc,
    dst: { node: string; dir: string },
    o: { overwrite: boolean; preserveTimes: boolean; move: boolean },
    iv?: ItemView,
  ): Promise<"done" | "skipped"> {
    if (!src.path.startsWith("/") || src.path === "/") throw new OpError(400, "invalid source path");
    const srcT = this.target(src.node);
    const dstT = this.target(dst.node);
    const st = await this.statOf(srcT, src.path, ctx.sig);
    if (!st) throw new OpError(404, "source not found");
    if (st.type !== "file" && st.type !== "dir") throw new OpError(400, "only files and folders can be copied");
    const name = path.posix.basename(src.path);
    const same = src.node === dst.node;
    if (same && st.type === "dir" && (dst.dir === src.path || dst.dir.startsWith(src.path + "/"))) throw new OpError(400, "cannot copy a folder into itself");
    const target = joinP(dst.dir, name);
    if (same && target === src.path && o.move) {
      if (iv) iv.note = "already in this folder";
      await this.accountMeasure(j, srcT, src.path, st, ctx.sig);
      return "skipped";
    }
    const cur = await this.statOf(dstT, target, ctx.sig);

    let useName = name;
    let free = !cur; // nothing at the destination name
    let merge = false; // folder into folder
    let force = false; // same-named files inside a merge are replaced without asking
    let replaceFile = false;
    if (cur) {
      const bothDirs = cur.type === "dir" && st.type === "dir";
      let choice: Choice;
      if (o.overwrite) choice = "overwrite";
      else if (bothDirs && j.policy === "skip") choice = "overwrite"; // merge; clashing files are skipped below
      else choice = await ctx.ask({ target: `${dst.node}:${target}`, name, srcType: st.type, dstType: cur.type, srcSize: st.size ?? 0, dstSize: cur.size ?? 0 });
      if (choice === "skip") {
        if (iv) iv.note = "skipped, name already exists";
        await this.accountMeasure(j, srcT, src.path, st, ctx.sig);
        return "skipped";
      }
      if (choice === "rename") {
        useName = await freeName(name, async (n) => (await this.statOf(dstT, joinP(dst.dir, n), ctx.sig)) !== null);
        free = true;
        if (iv) iv.note = `kept both as ${useName}`;
      } else {
        if (same && target === src.path) throw new OpError(400, "source and destination are the same");
        if (bothDirs) {
          merge = true;
          force = o.overwrite || j.policy !== "skip";
        } else if (cur.type !== st.type) {
          await this.removePath(dst.node, target, ctx.sig, false);
          free = true;
        } else replaceFile = true;
      }
    }

    // Fast native path: same node and nothing in the way (or an in-place file replace by move).
    if (same && (free || (replaceFile && o.move))) {
      const m = await this.measure(srcT, src.path, st, ctx.sig).catch(() => ({ files: 0, bytes: 0 }));
      const finalTarget = joinP(dst.dir, useName);
      if (o.move) await this.json(srcT, "/api/fs/rename", { from: src.path, to: finalTarget, overwrite: replaceFile }, ctx.sig, "move");
      else if (useName === name) await this.json(srcT, "/api/fs/copy", { from: [src.path], toDir: dst.dir, preserveTimes: o.preserveTimes }, ctx.sig, "copy");
      else return this.viaStream(j, ctx, src, st, dst, useName, false, force, o, iv);
      j.progress.bytes += m.bytes;
      j.progress.entries += m.files;
      return "done";
    }
    return this.viaStream(j, ctx, src, st, dst, useName, replaceFile, force, o, iv);
  }

  /** Count a skipped item's size as processed so the bar still reaches 100%. */
  private async accountMeasure(j: Job, t: Target, p: string, st: StatLite, signal: AbortSignal) {
    const m = await this.measure(t, p, st, signal).catch(() => ({ files: 0, bytes: 0 }));
    j.progress.bytes += m.bytes;
    j.progress.entries += m.files;
  }

  private async viaStream(
    j: Job,
    ctx: ReturnType<OpQueue["ctx"]>,
    src: Loc,
    st: StatLite,
    dst: { node: string; dir: string },
    useName: string,
    overwriteFile: boolean,
    force: boolean,
    o: { overwrite: boolean; preserveTimes: boolean; move: boolean },
    iv?: ItemView,
  ): Promise<"done" | "skipped"> {
    const res: TreeRes = { errors: 0, skipped: 0 };
    await this.tree(j, ctx, this.target(src.node), src.path, st, this.target(dst.node), dst.dir, useName, overwriteFile || force, o, res, 0);
    if (res.errors > 0) throw new OpError(502, `${res.errors} item${res.errors === 1 ? "" : "s"} failed${res.firstError ? `, first: ${res.firstError}` : ""}${o.move ? "; the source was kept" : ""}`);
    if (res.skipped > 0) {
      if (iv) iv.note = `${res.skipped} item${res.skipped === 1 ? "" : "s"} skipped${o.move ? "; the source was kept" : ""}`;
      return o.move ? "skipped" : "done";
    }
    if (o.move) await this.removePath(src.node, src.path, ctx.sig, false);
    return "done";
  }

  /** Copy a file or a folder tree. `forceOverwrite` replaces same-named files; otherwise nested clashes follow the job policy. */
  private async tree(
    j: Job,
    ctx: ReturnType<OpQueue["ctx"]>,
    src: Target,
    sp: string,
    st: StatLite,
    dst: Target,
    dir: string,
    name: string,
    forceOverwrite: boolean,
    o: { overwrite: boolean; preserveTimes: boolean },
    res: TreeRes,
    depth: number,
  ): Promise<void> {
    await ctx.checkpoint();
    if (st.type === "file") {
      await this.file(j, ctx, src, sp, st, dst, dir, name, forceOverwrite, o);
      return;
    }
    if (depth > 64) throw new OpError(400, "folder nesting too deep");
    const dp = joinP(dir, name);
    const existing = new Map<string, StatLite>();
    const cur = await this.statOf(dst, dp, ctx.sig);
    if (cur && cur.type !== "dir") throw new OpError(409, "destination exists and is not a folder");
    if (!cur) {
      await this.json(dst, "/api/fs/mkdir", { path: dp }, ctx.sig, "destination mkdir");
    } else {
      for (const e of await this.listDir(dst, dp, ctx.sig, "destination list")) existing.set(e.name, e);
    }
    const entries = await this.listDir(src, sp, ctx.sig, "source list");
    for (const e of entries) {
      if (e.type === "symlink" || e.type === "other") continue; // links and special files are not transferred
      await ctx.checkpoint();
      const hit = existing.get(e.name);
      let childName = e.name;
      let childForce = o.overwrite || forceOverwrite;
      if (hit) {
        if (hit.type === "dir" && e.type === "dir") {
          // folders merge without asking
        } else if (o.overwrite || forceOverwrite) {
          if (hit.type !== e.type) await this.removeOn(dst, joinP(dp, e.name), ctx.sig);
        } else {
          const choice = await ctx.ask({ target: `${joinP(dp, e.name)}`, name: e.name, srcType: e.type, dstType: hit.type, srcSize: e.size, dstSize: hit.size ?? 0 });
          if (choice === "skip") {
            res.skipped++;
            const m = await this.measure(src, e.path, e, ctx.sig).catch(() => ({ files: 0, bytes: 0 }));
            j.progress.bytes += m.bytes;
            j.progress.entries += m.files;
            continue;
          }
          if (choice === "rename") {
            childName = await freeName(e.name, async (n) => existing.has(n) || (await this.statOf(dst, joinP(dp, n), ctx.sig)) !== null);
            childForce = false;
          } else {
            childForce = true;
            if (hit.type !== e.type) await this.removeOn(dst, joinP(dp, e.name), ctx.sig);
          }
        }
      }
      try {
        await this.tree(j, ctx, src, e.path, e, dst, dp, childName, childForce, o, res, depth + 1);
      } catch (err) {
        if (ctx.sig.aborted) throw new Aborted();
        res.errors++;
        res.firstError ??= `${e.path}: ${(err as Error).message}`;
        // a failed file does not stop its siblings; count it as processed so the bar still completes
        const m = e.type === "file" ? { files: 1, bytes: e.size } : { files: 0, bytes: 0 };
        j.progress.bytes += m.bytes;
        j.progress.entries += m.files;
      }
    }
  }

  private async removeOn(t: Target, p: string, signal: AbortSignal) {
    await this.json(t, "/api/fs/trash", { paths: [p] }, signal, "replace").catch(async () => {
      await this.json(t, "/api/fs/delete", { paths: [p] }, signal, "replace");
    });
  }

  private async file(
    j: Job,
    ctx: ReturnType<OpQueue["ctx"]>,
    src: Target,
    sp: string,
    st: StatLite,
    dst: Target,
    dir: string,
    name: string,
    overwrite: boolean,
    o: { preserveTimes: boolean },
  ) {
    j.progress.current = sp;
    const attempt = async () => {
      await ctx.checkpoint();
      const down = await src.fetch(`/api/fs/download?path=${q(sp)}`, { signal: ctx.sig });
      if (!down.ok) throw await this.failed(down, "source read");
      const headers: Record<string, string> = {};
      const len = down.headers.get("content-length");
      if (len !== null) headers["content-length"] = len;
      const reader = down.body?.getReader();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(ctl) {
          await ctx.checkpoint();
          const r = reader ? await reader.read() : { done: true as const, value: undefined };
          if (r.done) return ctl.close();
          sent += r.value.length;
          j.progress.bytes += r.value.length;
          ctl.enqueue(r.value);
        },
        cancel(reason) {
          return reader?.cancel(reason);
        },
      });
      try {
        const up = await dst.fetch(
          `/api/fs/upload?dir=${q(dir)}&name=${q(name)}` + (overwrite ? "&overwrite=1" : "") + (o.preserveTimes && st.mtime ? `&mtime=${Math.floor(st.mtime)}` : ""),
          { method: "PUT", body, duplex: "half", headers, signal: ctx.sig } as RequestInit,
        );
        if (!up.ok) {
          await reader?.cancel().catch(() => undefined);
          throw await this.failed(up, "destination write");
        }
      } catch (e) {
        j.progress.bytes -= sent; // the file will be retried or reported; do not count it twice
        throw e;
      }
    };
    j.pausedDuring = false;
    try {
      await attempt();
    } catch (e) {
      if (ctx.sig.aborted) throw new Aborted();
      // A long pause can time out the idle connection; one retry after a pause is safe (uploads are atomic).
      if (j.pausedDuring && !(e instanceof OpError && e.status < 500 && e.status !== 400)) await attempt();
      else throw e;
    }
    j.progress.entries++;
  }
}

function titleOf(s: OpSpec): string {
  const n = s.op === "sync" ? s.steps.length : s.items.length;
  const what = s.op === "sync" ? `${n} step${n === 1 ? "" : "s"}` : n === 1 ? path.posix.basename(s.items[0]!.path) || s.items[0]!.path : `${n} items`;
  switch (s.op) {
    case "copy":
      return `Copy ${what} to ${s.dst.node}:${s.dst.dir}`;
    case "move":
      return `Move ${what} to ${s.dst.node}:${s.dst.dir}`;
    case "trash":
      return `Trash ${what}`;
    case "delete":
      return `Delete ${what}`;
    case "sync":
      return s.title ?? `Sync ${what}`;
  }
}
