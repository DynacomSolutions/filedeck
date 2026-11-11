import fs, { type FileHandle } from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import * as ops from "./fsops.ts";
import { direntsOf } from "./dirnames.ts";
import { parseMounts, networkKind, readMountTable } from "./mounts.ts";
import { PathError, TRASH_DIR, assertNotTrash, openChecked, resolveRead, resolveWrite } from "./paths.ts";
import { MAX_DEPTH, dirAt, pinParentW, walkGuard } from "./pinwalk.ts";
import { hitsReadOnly } from "./readonly.ts";
import type { JobCtl, JobOrigin, Jobs } from "./jobs.ts";
import type { Config } from "./config.ts";
import { SizeStore, type DuEntry } from "./size-store.ts";
import { spillPath } from "./index-cache.ts";

const bad = (m: string) => new ops.FsError(400, m);

/** id -> name from the host's own passwd/group (read through the confined resolver, never the container's). */
async function nameTable(root: string, file: "passwd" | "group"): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  try {
    const text = await fs.readFile(resolveRead(root, `/etc/${file}`).real, "utf8");
    for (const line of text.split("\n")) {
      const f = line.split(":");
      if (f.length < 3 || line.startsWith("#")) continue;
      const id = Number(f[2]);
      if (Number.isInteger(id) && !m.has(id)) m.set(id, f[0]!);
    }
  } catch {
    /* no table: ids only */
  }
  return m;
}
const idOf = (t: Map<number, string>, name: string) => [...t].find(([, n]) => n === name)?.[0];

export interface Props {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  /** bytes allocated on disk (st_blocks * 512) */
  diskBytes: number;
  mtime: number;
  atime: number;
  ctime: number;
  /** permission bits including setuid, setgid and sticky */
  mode: number;
  uid: number;
  gid: number;
  owner: string | null;
  group: string | null;
  nlink: number;
  ino: number;
  linkTarget?: string;
  linkDir?: boolean;
  volume?: { mountpoint: string; device: string; fstype: string; network: boolean; netKind?: string; total: number; free: number };
}

const kindOf = (st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Props["type"] =>
  st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";

export async function props(cfg: Config, p: string): Promise<Props> {
  const r = resolveWrite(cfg.root, p); // lstat semantics for the final component
  const st = await fs.lstat(r.real);
  const [users, groups] = await Promise.all([nameTable(cfg.root, "passwd"), nameTable(cfg.root, "group")]);
  const out: Props = {
    name: r.virtual === "/" ? "/" : path.basename(r.real),
    path: r.virtual,
    type: kindOf(st),
    size: st.size,
    diskBytes: Number(st.blocks) * 512,
    mtime: st.mtimeMs,
    atime: st.atimeMs,
    ctime: st.ctimeMs,
    mode: Number(st.mode) & 0o7777,
    uid: Number(st.uid),
    gid: Number(st.gid),
    owner: users.get(Number(st.uid)) ?? null,
    group: groups.get(Number(st.gid)) ?? null,
    nlink: Number(st.nlink),
    ino: Number(st.ino),
  };
  if (out.type === "symlink") {
    out.linkTarget = await fs.readlink(r.real).catch(() => "");
    try {
      out.linkDir = (await fs.stat(resolveRead(cfg.root, r.virtual).real)).isDirectory();
    } catch {
      out.linkDir = false;
    }
  }
  // The mount the item lives on: longest mount point that is a prefix of its virtual path.
  try {
    const mounts = parseMounts(await readMountTable(cfg.root, cfg.procMounts)).filter((m) => r.virtual === m.mountpoint || r.virtual.startsWith(m.mountpoint === "/" ? "/" : m.mountpoint + "/"));
    mounts.sort((a, b) => b.mountpoint.length - a.mountpoint.length);
    const m = mounts[0];
    if (m) {
      const kind = networkKind(m.fstype);
      const real = resolveRead(cfg.root, m.mountpoint).real;
      const s = await Promise.race([fs.statfs(real), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), kind ? 3000 : 10000).unref())]);
      out.volume = { mountpoint: m.mountpoint, device: m.device, fstype: m.fstype, network: !!kind, ...(kind ? { netKind: kind } : {}), total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    }
  } catch {
    /* mount table or statfs unavailable */
  }
  return out;
}

// ---- recursive size ----

export interface SizeResult {
  path: string;
  files: number;
  dirs: number;
  symlinks: number;
  other: number;
  /** sum of apparent file sizes */
  bytes: number;
  /** sum of allocated blocks */
  diskBytes: number;
  /** stopped at the entry cap */
  truncated: boolean;
  /** directories on other devices that were not entered (like `du -x`) */
  mountsSkipped: number;
  /** directories or entries that could not be read */
  errors: number;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ---- permissions ----

export interface PermsRequest {
  path: string;
  mode?: number;
  owner?: string | number;
  group?: string | number;
  recursive?: boolean;
  scope?: "all" | "files" | "dirs";
}
export interface PermsPlan {
  real: string;
  virtual: string;
  mode?: number;
  uid?: number;
  gid?: number;
  recursive: boolean;
  scope: "all" | "files" | "dirs";
  type: Props["type"];
}
export interface PermsResult {
  path: string;
  changed: number;
  skipped: number;
  errors: number;
}

const ID_MAX = 4294967294;
async function resolveId(table: Map<number, string>, v: string | number | undefined, what: string): Promise<number | undefined> {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "number" || /^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > ID_MAX) throw bad(`${what} id out of range`);
    return n;
  }
  const id = idOf(table, v);
  if (id === undefined) throw bad(`unknown ${what} "${v}"`);
  return id;
}

/** A directory the owner can no longer read or enter would lock everyone but root out of the tree. */
export function modeGuard(mode: number, type: Props["type"]): void {
  if (type === "dir" && (mode & 0o500) !== 0o500) throw bad("a folder must keep owner read and execute, otherwise even its owner is locked out");
}

export async function planPerms(cfg: Config, b: PermsRequest): Promise<PermsPlan> {
  if (typeof b.path !== "string") throw bad("path must be a string");
  const r = resolveWrite(cfg.root, b.path);
  assertNotTrash(r.virtual);
  if (r.virtual === "/") throw bad("refusing to change permissions of the root");
  if (b.mode === undefined && b.owner === undefined && b.group === undefined) throw bad("nothing to change");
  if (b.mode !== undefined && (!Number.isInteger(b.mode) || b.mode < 0 || b.mode > 0o7777)) throw bad("mode must be an integer between 0 and 07777");
  const st = await fs.lstat(r.real);
  const type = kindOf(st);
  if (type === "other") throw bad("special files are not changed");
  if (type === "symlink" && b.mode !== undefined) throw bad("the mode of a symbolic link cannot be changed (change the target instead)");
  const scope = b.scope ?? "all";
  if (!["all", "files", "dirs"].includes(scope)) throw bad("unknown scope");
  if (b.mode !== undefined) {
    if (!(b.recursive && scope === "files")) modeGuard(b.mode, type === "dir" ? "dir" : type);
  }
  const [users, groups] = await Promise.all([b.owner !== undefined ? nameTable(cfg.root, "passwd") : new Map<number, string>(), b.group !== undefined ? nameTable(cfg.root, "group") : new Map<number, string>()]);
  return {
    real: r.real,
    virtual: r.virtual,
    mode: b.mode,
    uid: await resolveId(users, b.owner, "user"),
    gid: await resolveId(groups, b.group, "group"),
    recursive: b.recursive === true && type === "dir",
    scope,
    type,
  };
}

/** The entry that was listed was swapped for something of another kind. */
const swapped = () => new ops.FsError(409, "an entry changed while it was being processed");

/**
 * Change one open entry (a file or a folder held by a descriptor). It must be of the kind that was listed, so a folder
 * swapped in for a file never gets a file mode. A file with more than one name is also reachable from outside the tree
 * being changed: its owner is not touched (`false` is returned and the caller counts it as skipped).
 */
async function applyFd(fh: FileHandle, kind: "file" | "dir", plan: PermsPlan): Promise<boolean> {
  const s = await fh.stat();
  if (kind === "dir" ? !s.isDirectory() : !s.isFile()) throw swapped();
  const owner = plan.uid !== undefined || plan.gid !== undefined;
  if (kind === "file" && owner && s.nlink > 1) return false;
  if (owner) await fh.chown(plan.uid ?? -1, plan.gid ?? -1);
  if (plan.mode !== undefined) await fh.chmod(plan.mode);
  return true;
}

/** Change one entry through an fd opened with O_NOFOLLOW (never a link, never blocking on a pipe). `real` must have a pinned parent. */
async function applyOne(real: string, type: Props["type"], plan: PermsPlan): Promise<boolean> {
  if (type === "symlink") {
    if (plan.uid !== undefined || plan.gid !== undefined) await fs.lchown(real, plan.uid ?? -1, plan.gid ?? -1);
    return true;
  }
  if (type === "other") return false; // devices, pipes and sockets are never opened
  const fh = await fs.open(real, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | (type === "dir" ? C.O_DIRECTORY : 0));
  try {
    return await applyFd(fh, type, plan);
  } finally {
    await fh.close();
  }
}

export async function applyPerms(cfg: Config, plan: PermsPlan, ctl?: JobCtl): Promise<PermsResult> {
  const res: PermsResult = { path: plan.virtual, changed: 0, skipped: 0, errors: 0 };
  if (!plan.recursive) {
    const one = (at: string) => applyOne(at, plan.type, plan);
    const done = plan.virtual === "/" ? await one(plan.real) : await pinParentW(cfg.root, plan.real, one); // the root has no parent inside the root to pin
    if (done) res.changed = 1;
    else res.skipped = 1;
    return res;
  }
  let seen = 0;
  const guard = walkGuard(cfg.root);
  const wants = (t: Props["type"]) => plan.scope === "all" || (plan.scope === "files" ? t !== "dir" : t === "dir");
  // The mode of links and special files is not changed; ownership of links is (lchown); devices, pipes and sockets are left alone and not opened.
  const modeFor = (t: Props["type"]) => (t === "symlink" || t === "other" ? undefined : plan.mode);
  const nothing = (t: Props["type"]) => t === "other" || (modeFor(t) === undefined && plan.uid === undefined && plan.gid === undefined);
  const check = (t: Props["type"]) => {
    const mode = modeFor(t);
    if (mode !== undefined && t === "dir" && (mode & 0o500) !== 0o500) throw bad("a folder must keep owner read and execute, otherwise even its owner is locked out");
  };
  const count = (ok: boolean) => void (ok ? res.changed++ : res.skipped++);
  // A file or link at `child` (a path with a pinned parent); never throws for one entry.
  const doPath = async (child: string, t: Props["type"]) => {
    if (!wants(t) || nothing(t)) return void res.skipped++;
    try {
      count(await applyOne(child, t, { ...plan, mode: modeFor(t) }));
    } catch {
      res.errors++;
    }
  };
  // The folder held by `fh`.
  const doDir = async (fh: FileHandle) => {
    if (!wants("dir") || nothing("dir")) return void res.skipped++;
    check("dir");
    try {
      count(await applyFd(fh, "dir", { ...plan, mode: modeFor("dir") }));
    } catch {
      res.errors++;
    }
  };
  // Every folder is entered through a descriptor opened without following links (and so is a folder, as listed), and its
  // children are reached through that descriptor: a folder swapped for a link mid-walk is never entered. Kinds come from the listing.
  const top = await openChecked(cfg.root, plan.real, C.O_RDONLY | C.O_DIRECTORY);
  try {
    const dev = (await top.stat()).dev;
    await doDir(top);
    await walk(top, plan.real, dev, 0);
  } finally {
    await top.close().catch(() => undefined);
  }
  if (ctl) ctl.progress.entries = seen;
  return res;

  async function walk(fh: FileHandle, real: string, dev: number, depth: number) {
    if (depth > MAX_DEPTH) throw bad("folders nested too deeply for one recursive change");
    if (ctl?.signal.aborted) throw bad("canceled");
    const at = dirAt(fh, real);
    await guard(at); // a folder that now resolves into a read-only prefix is refused
    if (ctl) ctl.progress.current = real.slice(cfg.root === "/" ? 0 : cfg.root.length) || "/";
    let batch: Promise<void>[] = [];
    const flush = async () => {
      await Promise.all(batch);
      batch = [];
      if (ctl) {
        ctl.progress.entries = seen;
        await tick();
      }
    };
    try {
      for await (const e of direntsOf(at)) {
        const n = e.name;
        if (n === TRASH_DIR) continue;
        if (ctl?.signal.aborted) throw bad("canceled");
        if (seen >= cfg.walkMaxEntries) throw bad("too many entries for one recursive change");
        seen++;
        const child = path.join(at, n);
        const known = e.isDirectory() || e.isFile() || e.isSymbolicLink();
        let t: Props["type"] = e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other";
        if (!known && !(e.isFIFO() || e.isSocket() || e.isBlockDevice() || e.isCharacterDevice())) {
          try {
            t = kindOf(await fs.lstat(child)); // the filesystem did not give a kind
          } catch {
            res.errors++;
            continue;
          }
        }
        if (t !== "dir") {
          batch.push(doPath(child, t));
          if (batch.length >= 32) await flush();
          continue;
        }
        await flush();
        let sub: FileHandle;
        try {
          sub = await fs.open(child, C.O_RDONLY | C.O_NOFOLLOW | C.O_DIRECTORY);
        } catch {
          res.errors++; // swapped for something else since it was listed
          continue;
        }
        try {
          if ((await sub.stat()).dev !== dev) {
            res.skipped++; // another filesystem: not entered
            continue;
          }
          await doDir(sub);
          await walk(sub, path.join(real, n), dev, depth + 1);
        } finally {
          await sub.close().catch(() => undefined);
        }
      }
    } catch (e) {
      if (!(e instanceof ops.FsError || e instanceof PathError)) {
        res.errors++; // the folder could not be listed or read
      } else throw e;
    } finally {
      await Promise.all(batch).catch(() => undefined);
    }
    await flush();
  }
}

const flag = (v: string | undefined) => v === "1";

/** The size store lives next to the compare index; its `du` is a bounded, cancellable walk that reuses unchanged folders. */
export function registerPropsRoutes(app: Hono, cfg: Config, jobs: Jobs): SizeStore {
  jobs.abandonMs = cfg.duAbandonMs;
  const sizes = new SizeStore(cfg.indexDir ? path.join(cfg.indexDir, `sizes-${cfg.node}.db`) : spillPath("sizes"), { root: cfg.root, ttlMs: cfg.indexRevalidateMs, maxEntries: cfg.walkMaxEntries });
  const json = async <T,>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw bad("invalid JSON body");
    }
  };
  app.get("/api/fs/props", async (c) => c.json(await props(cfg, c.req.query("path") ?? "/")));

  // The job exists at once; it waits for the lock of its subtree (overlapping scans run one after the other) without a job slot.
  const scanParts = <T,>(kind: "size" | "du", virtual: string, fresh: boolean | number, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; untrusted: boolean; extra?: T }) => void) => {
    let release: (() => void) | undefined;
    return {
      run: async (ctl: JobCtl) => {
        const x = await sizes.scanRead(virtual, ctl, fresh, release, after);
        done?.(x);
        // (`untrusted` also in a size job's result: a du that joins it answers from it)
        return kind === "size" ? { ...x.res, untrusted: x.untrusted } : { res: x.res, read: x.read, untrusted: x.untrusted };
      },
      onDrop: () => release?.(),
      gate: async (signal: AbortSignal, self: { id: string; createdAt: number }) => {
        // an adopted job waits here while another process holds the store's writer lease (a rolling deploy): only the writer walks
        await sizes.whenWriter(signal);
        release = await sizes.lock(virtual, signal);
        // Compatibility with 0.3.31 (removable once no such process can share the store file, together with Jobs.foreignAhead): its lock is per process, and it walks without the
        // writer lease, so during a rollout wait for its overlapping walks too.
        const overlaps = (p: { path: string }) => p.path === virtual || p.path === "/" || virtual === "/" || p.path.startsWith(virtual + "/") || virtual.startsWith(p.path + "/");
        try {
          while (jobs.foreignAhead(["size", "du"], self, overlaps)) {
            await new Promise((res) => setTimeout(res, 250));
            if (signal.aborted) throw new ops.FsError(400, "canceled");
          }
        } catch (e) {
          release();
          throw e;
        }
      },
    };
  };
  const startScan = <T,>(kind: "size" | "du", virtual: string, fresh: boolean, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; untrusted: boolean; extra?: T }) => void, origin: JobOrigin = "ui") => {
    // a rescan remembers when it began: a restart keeps the folders it already read
    const freshSince = fresh ? Date.now() : undefined;
    const p = scanParts(kind, virtual, freshSince ?? false, after, done);
    return jobs.create(kind, `Size of ${path.posix.basename(virtual) || "/"}`, p.run, p.onDrop, p.gate, { params: { path: virtual, fresh, freshSince }, origin });
  };
  // An adopted scan runs again under its id, confined again and without `after` (a du client repeats its request once the job is done).
  for (const kind of ["size", "du"] as const) {
    jobs.register(kind, async (p) => scanParts(kind, resolveRead(cfg.root, (p as { path: string }).path).virtual, (p as { fresh: boolean }).fresh ? ((p as { freshSince?: number }).freshSince ?? true) : false));
  }

  // The live size or du job of a path, own, adopted or only in the shared store: a second request joins it instead of queuing another walk.
  // A rescan (`fresh`) only joins a rescan: a cached job would answer it with stale rows.
  const liveScan = (virtual: string, fresh: boolean) => {
    const m = (p: { path: string; fresh?: boolean }) => p.path === virtual && (!fresh || p.fresh === true);
    return jobs.findLive("du", m) ?? jobs.findLive("size", m);
  };

  // This process is stopping (SIGTERM): a job started now would never be run here nor saved for the next process. The client retries (the du CLI waits through 503).
  const stopping = () => jobs.isStopping || sizes.stopping; // (jobs stop first on SIGTERM; the lease goes after the hand-over)
  const leaving = () => new ops.FsError(503, "this process is shutting down; try again");
  // "Calculate" in the properties dialog: answered from the store (unchanged folders cost one lstat); `fresh: true` is the explicit rescan.
  app.post("/api/jobs/size", async (c) => {
    const b = await json<{ path?: string; fresh?: boolean }>(c);
    if (typeof b.path !== "string") throw bad("path must be a string");
    const r = resolveRead(cfg.root, b.path);
    await fs.stat(r.real);
    if (stopping()) throw leaving();
    // one live size job per path (while another process holds the store's writer lease the job waits for it: see the gate): a second request attaches to it
    const same = liveScan(r.virtual, b.fresh === true);
    return c.json(same ?? startScan("size", r.virtual, b.fresh === true), 202);
  });

  // GET /api/du?path=&depth=&all=&fresh=&cachedOnly=: unchanged folders are validated (one lstat each), changed ones re-read, then the
  // answer is read from the store under the scan's lock. A scan longer than cfg.duWaitMs answers 202 {jobId} and keeps
  // running; poll GET /api/jobs/<id> until it is done, then repeat the request: for a minute it is answered from that scan.
  interface DuRun {
    id: string;
    detached: boolean;
    out?: { tree: { entries: DuEntry[]; truncated: boolean } | undefined; read: number; untrusted: boolean };
  }
  const duRuns = new Map<string, DuRun>();
  const DETACHED_KEEP_MS = 60_000;
  app.get("/api/du", async (c) => {
    const arrived = Date.now();
    const q = c.req.query.bind(c.req);
    const depth = q("depth") === undefined ? 1 : Number(q("depth"));
    if (!Number.isInteger(depth) || depth < 0 || depth > 64) throw bad("depth must be an integer between 0 and 64");
    for (const k of ["all", "fresh", "cachedOnly"]) if (q(k) !== undefined && q(k) !== "0" && q(k) !== "1") throw bad(`${k} must be 0 or 1`);
    const r = resolveRead(cfg.root, q("path") ?? "/");
    if (!(await fs.stat(r.real)).isDirectory()) throw bad("not a directory");
    const all = flag(q("all"));
    const fresh = flag(q("fresh"));
    // cachedOnly=1: answer from stored rows only. Never scans, never waits for a lock; 204 when the folder is not stored.
    if (flag(q("cachedOnly"))) {
      // `stale: true` unless the store can vouch for the rows (the same test as the fast path below)
      const f = await sizes.freshTree(r.virtual, depth, all);
      const t = f ?? (await sizes.tree(r.virtual, depth, all));
      if (!t.entries.length) return c.body(null, 204);
      return c.json({ path: r.virtual, entries: t.entries, cached: sizes.persistent, truncated: t.truncated, watched: sizes.covers(r.virtual), ...(f ? {} : { stale: true }) });
    }
    if (!fresh) {
      // Watched, validated by a clean walk since the watcher became ready, and nothing pending or dirty on the folder, below it or above it: answer
      // from the store at once, no job (see SizeStore.freshTree). Only the writer vouches.
      const t = await sizes.freshTree(r.virtual, depth, all);
      if (t) return c.json({ path: r.virtual, entries: t.entries, cached: sizes.persistent, truncated: t.truncated, watched: true });
      // Not vouched for, and either another process holds the writer lease (a rolling deploy) or a scan of another overlapping folder is live (a job here would
      // queue behind it, possibly for hours): answer from the stored rows, flagged `stale: true`, and start nothing; the next request starts a job if it is still needed.
      const overlap = (p: { path: string }) => p.path !== r.virtual && (p.path === "/" || r.virtual === "/" || p.path.startsWith(r.virtual + "/") || r.virtual.startsWith(p.path + "/"));
      if (!(await sizes.mayScan()) || jobs.findLive("du", overlap) || jobs.findLive("size", overlap)) {
        const s = await sizes.tree(r.virtual, depth, all);
        if (s.entries.length) return c.json({ path: r.virtual, entries: s.entries, cached: sizes.persistent, truncated: s.truncated, watched: sizes.covers(r.virtual), stale: true });
      }
    }
    const key = [r.virtual, depth, all, fresh].join("\0");
    // A detached run is kept while its job is queued or running and for a minute after it ends (not after the 202).
    for (const [k, d] of duRuns) {
      const j = jobs.get(d.id);
      if (!j || (j.state !== "queued" && j.state !== "running" && Date.now() - (j.finishedAt ?? 0) > DETACHED_KEEP_MS)) duRuns.delete(k);
    }
    // an identical request joins the scan already running (or the one that got 202 within the last minute)
    let run = duRuns.get(key);
    let v = run && jobs.get(run.id);
    const replay = !!run?.detached && v?.state === "done";
    if (!run || !v || (v.state !== "queued" && v.state !== "running" && !replay)) {
      const mine: DuRun = { id: "", detached: false };
      run = mine;
      // joined: the reply tree is read once that job is done. While stopping, only a new job is refused: the answer of a finished or running one is still good
      // (refusing it would send the repeat to the next process, which walks the whole tree again).
      v = liveScan(r.virtual, fresh) ?? (stopping() ? (() => { throw leaving(); })() : startScan("du", r.virtual, fresh, () => sizes.tree(r.virtual, depth, all), (x) => (mine.out = { tree: x.extra, read: x.read, untrusted: x.untrusted }), "cli"));
      mine.id = v.id;
      duRuns.set(key, mine);
    }
    const id = run.id;
    jobs.touch(id);
    const forget = () => {
      if (duRuns.get(key) === run) duRuns.delete(key);
    };
    let keep = false; // the entry stays for the repeat request (a replay that could not get the lock in time)
    try {
      const signal = c.req.raw.signal;
      while ((v!.state === "queued" || v!.state === "running") && Date.now() < arrived + cfg.duWaitMs && !signal.aborted) {
        await new Promise((res) => setTimeout(res, 20));
        jobs.touch(id);
        v = jobs.get(id) ?? { ...v!, state: "failed", error: "job lost" };
      }
      if (v!.state === "queued" || v!.state === "running") {
        // keep the entry for the repeat request; the job goes on whether or not this client is still there
        run.detached = true;
        return c.json({ jobId: id, state: v!.state }, 202);
      }
      // (a job the shutdown interrupted is not cancelled: the client retries against the next process)
      if (v!.state === "canceled") throw jobs.isStopping ? leaving() : new ops.FsError(409, "canceled");
      if (v!.state === "failed") throw new ops.FsError(500, v!.error ?? "failed");
      const jr = v!.result as SizeResult & { res?: SizeResult; read?: number; untrusted?: boolean }; // a du job answers {res, read}, a joined size job the result itself
      const res = jr.res ?? jr;
      if (res.truncated) {
        // A capped scan is never stored: answer with the partial totals of the folder alone.
        return c.json({ path: r.virtual, entries: [{ path: r.virtual, type: "dir", bytes: res.bytes, diskBytes: res.diskBytes, files: res.files, dirs: res.dirs }], cached: false, truncated: true, watched: false });
      }
      // The repeat of a finished job re-reads the tree from the store: what was applied since the job ended is in it. (A fresh answer comes from the job's own result.)
      let t = replay ? undefined : run.out?.tree;
      if (!t) {
        // never a half-written scan; the wait is bounded like the job wait, a later walk queued ahead can hold the lock
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), Math.max(0, arrived + cfg.duWaitMs - Date.now()));
        signal.addEventListener("abort", () => ac.abort(), { once: true });
        try {
          const rel = await sizes.lock(r.virtual, ac.signal);
          try {
            t = await sizes.tree(r.virtual, depth, all);
          } finally {
            rel();
          }
        } catch (e) {
          if (!ac.signal.aborted) throw e;
          run.detached = true; // the repeat request is answered from this finished scan
          keep = true;
          return c.json({ jobId: id, state: "done" }, 202);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!t?.entries.length) throw new ops.FsError(404, "not found");
      // cached: nothing was read from disk and the answer comes from the database (not from a degraded, uncached store)
      // `stale`: the walk reused rows on their age under a running watcher (they may have changed while no watcher saw it), or the repeat of a finished job
      // comes after a change the watcher has reported
      // (a stale mark made after the job ended: an overflow or a helper exit loses events and leaves only that)
      const stale = (run.out?.untrusted ?? jr.untrusted ?? false) || (replay && ((sizes.covers(r.virtual) && (await sizes.changesWaiting(r.virtual))) || sizes.markedSince(r.virtual, v!.startedAt ?? v!.createdAt)));
      return c.json({ path: r.virtual, entries: t.entries, cached: (replay || (run.out ? run.out.read : jr.read ?? -1) === 0) && sizes.persistent, truncated: t.truncated, watched: sizes.covers(r.virtual), ...(stale ? { stale: true } : {}) });
    } finally {
      if (!keep) {
        if (!run.detached) forget();
        else if (replay) forget();
      }
    }
  });

  // Immediate for one entry; recursive changes run as a job (202 + job view).
  app.post("/api/fs/perms", async (c) => {
    const req = await json<PermsRequest>(c);
    const plan = await planPerms(cfg, req);
    if (plan.recursive) {
      const what = [plan.mode !== undefined ? `mode ${plan.mode.toString(8)}` : "", plan.uid !== undefined || plan.gid !== undefined ? "owner" : ""].filter(Boolean).join(" and ");
      const { path: p, mode, owner, group, recursive, scope } = req; // allowlist, never the raw body
      const job = jobs.create("perms", `Set ${what} on ${path.posix.basename(plan.virtual)} recursively`, (ctl) => applyPerms(cfg, plan, ctl), undefined, undefined, { params: { path: p, mode, owner, group, recursive, scope } });
      return c.json(job, 202);
    }
    return c.json(await applyPerms(cfg, plan));
  });
  // Planned again, so confinement and read-only checks apply to the moment of the restart; a refusal fails the job with its message.
  jobs.register("perms", async (p) => {
    try {
      if (hitsReadOnly(cfg.root, cfg.readOnly, (p as PermsRequest).path)) throw new ops.FsError(403, "read-only volume");
      const plan = await planPerms(cfg, p as PermsRequest);
      return { run: (ctl) => applyPerms(cfg, plan, ctl) };
    } catch (e) {
      return { run: async () => Promise.reject(e) };
    }
  });
  return sizes;
}
