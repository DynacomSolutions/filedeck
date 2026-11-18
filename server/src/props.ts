import fs, { type FileHandle } from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import * as ops from "./fsops.ts";
import { direntsOf } from "./dirnames.ts";
import { parseMounts, networkKind, readMountTable } from "./mounts.ts";
import { PathError, assertNotReserved, cleanVirtual, isReservedName, openChecked, resolveRead, resolveWrite } from "./paths.ts";
import { MAX_DEPTH, assertMayChange, dirAt, openDir, pinParentW, tooDeep, walkGuard, withReadOnly } from "./pinwalk.ts";
import { hitsReadOnly, jobMayWrite, reachesReadOnly } from "./readonly.ts";
import type { JobCtl, JobOrigin, JobView, Jobs } from "./jobs.ts";
import type { Config } from "./config.ts";
import { stream } from "hono/streaming";
import { SizeStore, type DuEntry } from "./size-store.ts";
import { spillPath } from "./index-cache.ts";
import { requestJobMeta } from "./job-meta.ts";

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
  assertNotReserved(r.virtual);
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
  assertNotReserved(r.virtual);
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
 * being changed: it is left alone, owner and mode (`false` is returned and the caller counts it as skipped).
 */
async function applyFd(fh: FileHandle, kind: "file" | "dir", plan: PermsPlan): Promise<boolean> {
  const s = await fh.stat();
  if (kind === "dir" ? !s.isDirectory() : !s.isFile()) throw swapped();
  const owner = plan.uid !== undefined || plan.gid !== undefined;
  if (kind === "file" && s.nlink > 1) return false;
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

export function applyPerms(cfg: Config, plan: PermsPlan, ctl?: JobCtl): Promise<PermsResult> {
  // the pinned steps re-check the read-only prefixes of this agent wherever the job runs from
  return withReadOnly(cfg.root, cfg.readOnly, () => applyPermsIn(cfg, plan, ctl));
}

async function applyPermsIn(cfg: Config, plan: PermsPlan, ctl?: JobCtl): Promise<PermsResult> {
  const res: PermsResult = { path: plan.virtual, changed: 0, skipped: 0, errors: 0 };
  if (!plan.recursive) {
    const one = (at: string) => applyOne(at, plan.type, plan);
    const done = plan.virtual === "/" ? await one(plan.real) : await pinParentW(cfg.root, plan.real, one, false); // the root has no parent inside the root to pin
    if (done) res.changed = 1;
    else res.skipped = 1;
    return res;
  }
  assertMayChange(cfg.root, plan.real, true); // a prefix at or below the target: refuse before anything is changed
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
    await guard(dirAt(top, plan.real)); // where the folder really is, before it is changed
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
        if (isReservedName(n)) continue;
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
          sub = await openDir(child);
        } catch (err) {
          if ((err as Error).message === tooDeep().message) throw err;
          res.errors++; // swapped for something else since it was listed
          continue;
        }
        try {
          if ((await sub.stat()).dev !== dev) {
            res.skipped++; // another filesystem: not entered
            continue;
          }
          await guard(dirAt(sub, child)); // where the folder really is now: a read-only prefix is refused before the folder is changed
          await doDir(sub);
          await walk(sub, path.join(real, n), dev, depth + 1);
        } finally {
          await sub.close().catch(() => undefined);
        }
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EMFILE" || code === "ENFILE") throw tooDeep();
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

async function json<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad("invalid JSON body");
  }
}

/**
 * Sign-in on: how the size routes follow the person behind a request (agent-jobs.ts). The store and its scans are the machine's; what a
 * person gets of them is filtered here.
 */
export interface SizeAccess {
  /**
   * which of these folders (virtual paths) the person can open, resolved as the person resolves them; a false one is left out of an answer
   * (with everything below it), and refused when asked for. It is asked first, before this process looks at the path (no `lstat` as root
   * of a name the person cannot see: whether it is a link must not change the answer).
   */
  canList?: (c: Context, paths: string[]) => Promise<boolean[]>;
  /**
   * throws to refuse a path as the request names it (a virtual account outside its grants). `exact` false: by the path as written only
   * (the person cannot open it, so its links are not theirs to see); true: also with its links resolved.
   */
  inside?: (c: Context, path: string, exact: boolean) => void | Promise<void>;
  /** the owner a new size or du job gets */
  owner?: (c: Context) => string | undefined;
  /** the request is answered with a job to follow (one it joined may be another person's: they may follow it too) */
  follows?: (c: Context, id: string) => void;
  /** the job as the request's answer shows it (also calls `follows`) */
  view?: (c: Context, v: JobView) => JobView;
  /** where the real text of a failed scan goes (the job says only `size scan failed`) */
  log?: (s: string) => void;
}

/**
 * The folders that decide whether a du entry below `virtual` is shown: each one from below `virtual` down to the entry itself (a folder or
 * mount point) or its folder (a file, link or other). `[]` for `virtual` itself and a file directly in it; null for an entry that is not
 * below `virtual` (left out).
 */
export function entryChain(virtual: string, e: Pick<DuEntry, "path" | "type">): string[] | null {
  const f = e.type === "dir" || e.type === "mount" ? e.path : path.posix.dirname(e.path);
  if (f === virtual) return [];
  if (!f.startsWith(virtual === "/" ? "/" : virtual + "/")) return null;
  const out: string[] = [];
  let at = virtual === "/" ? "" : virtual;
  for (const part of f.slice(at.length + 1).split("/")) out.push((at = `${at}/${part}`));
  return out;
}

/** entries of a du answer checked with one `canList` call */
const FILTER_BATCH = 256;

/**
 * Folder sizes (`POST /api/jobs/size`, `GET /api/du`) and their jobs. The size store lives next to the compare index; its `du` is a bounded, cancellable walk
 * that reuses unchanged folders. It stays in the agent's root process (one store and one change watcher per machine). With `o` (sign-in on), see `SizeAccess`.
 */
export function registerSizeRoutes(app: Hono, cfg: Config, jobs: Jobs, o: SizeAccess = {}): SizeStore {
  jobs.abandonMs = cfg.duAbandonMs;
  const sizes = new SizeStore(cfg.indexDir ? path.join(cfg.indexDir, `sizes-${cfg.node}.db`) : spillPath("sizes"), { root: cfg.root, ttlMs: cfg.indexRevalidateMs, maxEntries: cfg.walkMaxEntries });

  // The job exists at once; it waits for the lock of its subtree (overlapping scans run one after the other) without a job slot.
  // `since`: when the job began. Rows written since are the job's own: when the job runs again after a restart (adopted), the walk keeps them instead of starting over.
  const scanParts = <T,>(kind: "size" | "du", virtual: string, fresh: boolean | number, since: number | undefined, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; untrusted: boolean; extra?: T }) => void) => {
    let release: (() => void) | undefined;
    return {
      run: async (ctl: JobCtl) => {
        let x: Awaited<ReturnType<typeof sizes.scanRead<T>>>;
        try {
          x = await sizes.scanRead(virtual, ctl, fresh, release, after, since);
        } catch (e) {
          // (sign-in on: the text may name what the walk met, which is the machine's, not the person's)
          if (!o.canList || ctl.signal.aborted) throw e;
          (o.log ?? ((t) => console.error(t)))(JSON.stringify({ sizeScan: virtual, failed: e instanceof Error ? e.message : String(e) }));
          throw new ops.FsError(500, "size scan failed");
        }
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
  const startScan = <T,>(kind: "size" | "du", virtual: string, fresh: boolean, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; untrusted: boolean; extra?: T }) => void, origin: JobOrigin = "ui", owner?: string) => {
    // a scan remembers when it began: a restart keeps the folders it already read (a rescan keeps only those)
    const since = Date.now();
    const freshSince = fresh ? since : undefined;
    const p = scanParts(kind, virtual, freshSince ?? false, since, after, done);
    return jobs.create(kind, `Size of ${path.posix.basename(virtual) || "/"}`, p.run, p.onDrop, p.gate, { params: { path: virtual, fresh, freshSince, since }, origin, owner });
  };
  // An adopted scan runs again under its id, confined again and without `after` (a du client repeats its request once the job is done).
  for (const kind of ["size", "du"] as const) {
    jobs.register(kind, async (p) => {
      const q = p as { path: string; fresh: boolean; freshSince?: number; since?: number };
      return scanParts(kind, resolveRead(cfg.root, q.path).virtual, q.fresh ? (q.freshSince ?? true) : false, q.since ?? q.freshSince);
    });
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
    let self = true;
    const asked = "/" + cleanVirtual(b.path).join("/");
    if (o.canList) {
      // a folder the person can open, or a file in one (whether a name there is a folder they cannot open is theirs to see)
      const [own, up] = await o.canList(c, asked === "/" ? ["/"] : [asked, path.posix.dirname(asked)]);
      self = own === true;
      if (!self && !up) {
        await o.inside?.(c, b.path, false);
        throw new ops.FsError(403, "permission denied");
      }
    }
    await o.inside?.(c, b.path, true);
    const r = resolveRead(cfg.root, b.path);
    if (o.canList) {
      // What this process resolved (as root, following a link at the end) is checked as the person too: their own link in a folder they can
      // open may lead to a file in one they cannot. A file's size needs the folder it really is in; a folder reached through a link, itself.
      if (!self && (await fs.stat(r.real)).isDirectory()) throw new ops.FsError(403, "permission denied");
      const check = !self ? [path.posix.dirname(r.virtual)] : r.virtual !== asked ? [r.virtual] : [];
      if (check.length && !(await o.canList(c, check))[0]) throw new ops.FsError(403, "permission denied");
    }
    await fs.stat(r.real);
    if (stopping()) throw leaving();
    // one live size job per path (while another process holds the store's writer lease the job waits for it: see the gate): a second request attaches to it
    const same = liveScan(r.virtual, b.fresh === true);
    const v = same ?? startScan("size", r.virtual, b.fresh === true, undefined, undefined, "ui", o.owner?.(c));
    if (o.view) return c.json(o.view(c, v), 202);
    o.follows?.(c, v.id);
    return c.json(v, 202);
  });

  // GET /api/du?path=&depth=&all=&fresh=&cachedOnly=: unchanged folders are validated (one lstat each), changed ones re-read, then the
  // answer is read from the store under the scan's lock. A scan longer than cfg.duWaitMs answers 202 {jobId} and keeps
  // running; poll GET /api/jobs/<id> until it is done, then repeat the request: for a minute it is answered from that scan.
  interface DuRun {
    id: string;
    detached: boolean;
    out?: { read: number; untrusted: boolean };
  }
  /**
   * The answer, streamed from the store as it is read (SizeStore.treeEach): an agent never holds a whole answer, whatever its size. The JSON is
   * {path, cached, watched, entries: [...], truncated, partial?, stale?, error?}; what is known only at the end comes after the entries. `recheck` runs after the
   * last entry (stale when it says no); `done` always runs once (a lock held for the read is released there). An error after the first byte cannot change the status: it ends the answer with `error`.
   * With `canList` (sign-in on), the entries go out in batches of `FILTER_BATCH`, without each entry below a folder the person cannot open (any folder
   * between `virtual` and the entry, the entry itself when it is a folder): a folder they may pass through but not list hides what is below it.
   * Each folder is asked once for the whole answer.
   */
  const answerTree = (c: Context, virtual: string, depth: number, all: boolean, head: { cached: boolean; watched: boolean; stale?: boolean }, t: { recheck?: () => Promise<boolean>; done?: () => void } = {}) => {
    c.header("Content-Type", "application/json; charset=UTF-8");
    let ended = false;
    const end = () => {
      if (!ended) (ended = true), t.done?.();
    };
    const canList = o.canList;
    return stream(c, async (s) => {
      s.onAbort(end);
      let buf = `{"path":${JSON.stringify(virtual)},"cached":${head.cached},"watched":${head.watched},"entries":[`;
      let first = true;
      let found = false;
      let tail: Record<string, unknown> = {};
      const put = async (e: DuEntry) => {
        buf += (first ? "" : ",") + JSON.stringify(e);
        first = false;
        if (buf.length >= 64 * 1024) {
          const b = buf;
          buf = "";
          await s.write(b);
          if (s.aborted) throw new ops.FsError(400, "canceled");
        }
      };
      let batch: DuEntry[] = [];
      /** per folder, whether the person can open it (asked once each for the whole answer; `virtual` was checked before: see the du route) */
      const listable = new Map<string, boolean>([[virtual, true]]);
      const flush = async () => {
        if (!canList || !batch.length) return;
        // (an entry that is not below the asked folder has no chain: it is left out)
        const out = batch.flatMap((e) => {
          const chain = entryChain(virtual, e);
          return chain ? [{ e, chain }] : [];
        });
        batch = [];
        const asked = [...new Set(out.flatMap((x) => x.chain))].filter((f) => !listable.has(f));
        if (asked.length) {
          const ok = await canList(c, asked);
          asked.forEach((f, i) => listable.set(f, ok[i] === true));
        }
        for (const x of out) if (x.chain.every((f) => listable.get(f) === true)) await put(x.e);
      };
      try {
        const r = await sizes.treeEach(virtual, depth, all, async (e) => {
          found = true;
          if (!canList) return put(e);
          batch.push(e);
          if (batch.length >= FILTER_BATCH) await flush();
        });
        await flush();
        // the folder's rows went between the check before the answer and its read (a change removed them): never an empty answer that looks complete
        if (!found) throw new ops.FsError(404, "the sizes of this folder were removed while the answer was read; ask again");
        const stale = head.stale || (t.recheck ? !(await t.recheck()) : false);
        tail = { truncated: r.truncated, ...(r.partial ? { partial: true } : {}), ...(stale ? { stale: true } : {}) };
      } catch (e) {
        tail = { truncated: true, error: e instanceof Error ? e.message : String(e) };
      } finally {
        end();
      }
      if (!s.aborted) await s.write(buf + "]," + JSON.stringify(tail).slice(1));
    });
  };
  const duRuns = new Map<string, DuRun>();
  const DETACHED_KEEP_MS = 60_000;
  app.get("/api/du", async (c) => {
    const arrived = Date.now();
    const q = c.req.query.bind(c.req);
    const depth = q("depth") === undefined ? 1 : Number(q("depth"));
    if (!Number.isInteger(depth) || depth < 0 || depth > 64) throw bad("depth must be an integer between 0 and 64");
    for (const k of ["all", "fresh", "cachedOnly"]) if (q(k) !== undefined && q(k) !== "0" && q(k) !== "1") throw bad(`${k} must be 0 or 1`);
    // (sign-in on: before this process looks at the path, and before anything about the folder is told)
    if (o.canList && !(await o.canList(c, ["/" + cleanVirtual(q("path") ?? "/").join("/")]))[0]) {
      await o.inside?.(c, q("path") ?? "/", false);
      throw new ops.FsError(403, "permission denied");
    }
    await o.inside?.(c, q("path") ?? "/", true);
    const r = resolveRead(cfg.root, q("path") ?? "/");
    // (the answer is for the folder this process resolved: when that is not the path the worker was asked about, it is asked about it too, so
    // the answer's own folder, which `answerTree` takes as checked, always is)
    if (o.canList && r.virtual !== "/" + cleanVirtual(q("path") ?? "/").join("/") && !(await o.canList(c, [r.virtual]))[0]) throw new ops.FsError(403, "permission denied");
    if (!(await fs.stat(r.real)).isDirectory()) throw bad("not a directory");
    const all = flag(q("all"));
    const fresh = flag(q("fresh"));
    // cachedOnly=1: answer from stored rows only. Never scans, never waits for a lock; 204 when the folder is not stored.
    if (flag(q("cachedOnly"))) {
      // `stale: true` unless the store can vouch for the rows (the same test as the fast path below). A folder a running scan has not finished is
      // answered with what it has counted so far (`partial`), not "not stored".
      if (!(await sizes.treeTop(r.virtual))) return c.body(null, 204);
      const vouched = !all && (await sizes.vouches(r.virtual));
      return answerTree(c, r.virtual, depth, all, { cached: sizes.persistent, watched: sizes.covers(r.virtual), stale: !vouched }, vouched ? { recheck: () => sizes.vouches(r.virtual) } : {});
    }
    if (!fresh) {
      // Watched, validated by a clean walk since the watcher became ready, and nothing pending or dirty on the folder, below it or above it: answer
      // from the store at once, no job (see SizeStore.freshTree). Only the writer vouches.
      // (checked again after the last entry: a change that arrived meanwhile makes the answer `stale`)
      if (!all && (await sizes.vouches(r.virtual)) && (await sizes.treeTop(r.virtual))) return answerTree(c, r.virtual, depth, all, { cached: sizes.persistent, watched: true }, { recheck: () => sizes.vouches(r.virtual) });
      // Not vouched for, and either another process holds the writer lease (a rolling deploy) or a scan of another overlapping folder is live (a job here would
      // queue behind it, possibly for hours): answer from the stored rows, flagged `stale: true`, and start nothing; the next request starts a job if it is still needed.
      const overlap = (p: { path: string }) => p.path !== r.virtual && (p.path === "/" || r.virtual === "/" || p.path.startsWith(r.virtual + "/") || r.virtual.startsWith(p.path + "/"));
      if ((!(await sizes.mayScan()) || jobs.findLive("du", overlap) || jobs.findLive("size", overlap)) && (await sizes.treeTop(r.virtual)))
        return answerTree(c, r.virtual, depth, all, { cached: sizes.persistent, watched: sizes.covers(r.virtual), stale: true });
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
      v = liveScan(r.virtual, fresh) ?? (stopping() ? (() => { throw leaving(); })() : startScan("du", r.virtual, fresh, undefined, (x) => (mine.out = { read: x.read, untrusted: x.untrusted }), "cli", o.owner?.(c)));
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
        o.follows?.(c, id);
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
      // The answer is read from the store under the folder's lock (never a half-written scan), streamed, and the lock released when the last entry is out.
      // The wait for the lock is bounded like the job wait: a later walk queued ahead can hold it.
      let rel: () => void;
      const mark = sizes.lockMark();
      const t0 = Date.now(); // before the lock: a stale mark made while it waits or while the top row is read is seen too
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.max(0, arrived + cfg.duWaitMs - Date.now()));
      signal.addEventListener("abort", () => ac.abort(), { once: true });
      try {
        rel = await sizes.lock(r.virtual, ac.signal, true);
        rel(); // no walk is half done now; one that starts while the answer is streamed makes it `stale` (a slow reader must never hold up a scan)
      } catch (e) {
        if (!ac.signal.aborted) throw e;
        run.detached = true; // the repeat request is answered from this finished scan
        keep = true;
        o.follows?.(c, id);
        return c.json({ jobId: id, state: "done" }, 202);
      } finally {
        clearTimeout(timer);
      }
      {
        if (!(await sizes.treeTop(r.virtual))) throw new ops.FsError(404, "not found");
        // cached: nothing was read from disk and the answer comes from the database (not from a degraded, uncached store)
        // `stale`: the walk reused rows on their age under a running watcher (they may have changed while no watcher saw it), or the repeat of a finished job
        // comes after a change the watcher has reported
        // (a stale mark made after the job ended: an overflow or a helper exit loses events and leaves only that)
        const stale = (run.out?.untrusted ?? jr.untrusted ?? false) || (replay && ((sizes.covers(r.virtual) && (await sizes.changesWaiting(r.virtual))) || sizes.markedSince(r.virtual, v!.startedAt ?? v!.createdAt)));
        const cached = (replay || (run.out ? run.out.read : jr.read ?? -1) === 0) && sizes.persistent;
        // stale too when, while the answer was read, a walk of an overlapping folder came or the watcher lost changes (an overflow leaves only a stale mark)
        return answerTree(c, r.virtual, depth, all, { cached, watched: sizes.covers(r.virtual), stale }, { recheck: async () => !sizes.lockedSince(r.virtual, mark) && !sizes.markedSince(r.virtual, t0) });
      }
    } finally {
      if (!keep) {
        if (!run.detached) forget();
        else if (replay) forget();
      }
    }
  });

  return sizes;
}

/**
 * The change a stored perms job asks for. The file owner to set is `fileOwner`; `owner` is the account the job belongs to
 * (`<kind>:<name>`, added by the job queue). A job stored before the rename has the file owner in `owner`: it is taken from there only
 * when it cannot be an account (a user name or id never holds a `:`).
 */
/** A stored perms job whose file owner was overwritten by its account (see `permsParams`) while its title says it changes the owner. */
export function lostFileOwner(p: unknown, title: string): boolean {
  const { fileOwner, owner } = (p && typeof p === "object" ? p : {}) as { fileOwner?: unknown; owner?: unknown };
  if (fileOwner !== undefined || typeof owner !== "string" || !/^(sys|virt):/.test(owner)) return false;
  const what = /^Set (.*) on /.exec(title)?.[1] ?? "";
  return what.split(" and ").includes("owner");
}

export function permsParams(p: unknown): PermsRequest {
  const { fileOwner, owner, ...rest } = (p && typeof p === "object" ? p : {}) as PermsRequest & { fileOwner?: string | number };
  const file = fileOwner ?? (typeof owner === "string" && /^(sys|virt):/.test(owner) ? undefined : owner);
  return { ...rest, ...(file !== undefined ? { owner: file } : {}) } as PermsRequest;
}

/** Properties (`GET /api/fs/props`) and permission changes (`POST /api/fs/perms`); a recursive change runs as a job of `jobs`. */
export function registerPropsRoutes(app: Hono, cfg: Config, jobs: Jobs): void {
  app.get("/api/fs/props", async (c) => c.json(await props(cfg, c.req.query("path") ?? "/")));

  // Immediate for one entry; recursive changes run as a job (202 + job view).
  app.post("/api/fs/perms", async (c) => {
    const req = await json<PermsRequest>(c);
    const plan = await planPerms(cfg, req);
    if (plan.recursive) {
      const what = [plan.mode !== undefined ? `mode ${plan.mode.toString(8)}` : "", plan.uid !== undefined || plan.gid !== undefined ? "owner" : ""].filter(Boolean).join(" and ");
      const { path: p, mode, owner, group, recursive, scope } = req; // allowlist, never the raw body
      // (the file owner to set is `fileOwner`: `owner` in a job's params is the account the job belongs to)
      const job = jobs.create("perms", `Set ${what} on ${path.posix.basename(plan.virtual)} recursively`, (ctl) => runPerms(plan, ctl), undefined, undefined, { params: { path: p, mode, fileOwner: owner, group, recursive, scope }, ...requestJobMeta(c) });
      return c.json(job, 202);
    }
    return c.json(await applyPerms(cfg, plan));
  });
  // A queued change is checked again when it starts, on where its target really is by then (a folder may have been swapped for a link meanwhile).
  const runPerms = (plan: PermsPlan, ctl: Parameters<typeof applyPerms>[2]) => {
    if (!jobMayWrite(cfg.root, cfg.readOnly, plan.real, { contains: plan.recursive, follow: plan.recursive })) return Promise.reject(new ops.FsError(403, "read-only volume"));
    return applyPerms(cfg, plan, ctl);
  };
  // Planned again, so confinement and read-only checks apply to the moment of the restart; a refusal fails the job with its message.
  jobs.register("perms", async (p, row) => {
    // stored before `fileOwner`, under act as root: the job's account took the file owner's key, so an owner change (its title says
    // so) has lost its target. A throw here fails the job as interrupted: it is started again by hand, never run without its owner.
    if (lostFileOwner(p, row.title)) throw new Error("the file owner to set was lost when the job was stored");
    try {
      const req = permsParams(p);
      // a recursive change reaches everything below: an ancestor of a read-only prefix is refused too (also for a job stored before the prefix was configured)
      if (hitsReadOnly(cfg.root, cfg.readOnly, req.path) || (req.recursive === true && reachesReadOnly(cfg.root, cfg.readOnly, req.path, true))) throw new ops.FsError(403, "read-only volume");
      const plan = await planPerms(cfg, req);
      return { run: (ctl) => runPerms(plan, ctl) };
    } catch (e) {
      return { run: async () => Promise.reject(e) };
    }
  });
}
