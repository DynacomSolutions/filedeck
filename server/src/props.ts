import fs from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import * as ops from "./fsops.ts";
import { namesOf } from "./dirnames.ts";
import { parseMounts, networkKind, readMountTable } from "./mounts.ts";
import { TRASH_DIR, assertNotTrash, resolveRead, resolveWrite } from "./paths.ts";
import { hitsReadOnly } from "./readonly.ts";
import type { JobCtl, Jobs } from "./jobs.ts";
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

/** Change one entry through an fd opened with O_NOFOLLOW, so a link swapped in at the last moment is never followed. */
async function applyOne(real: string, type: Props["type"], plan: PermsPlan): Promise<void> {
  if (type === "symlink") {
    if (plan.uid !== undefined || plan.gid !== undefined) await fs.lchown(real, plan.uid ?? -1, plan.gid ?? -1);
    return;
  }
  const fh = await fs.open(real, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const s = await fh.stat();
    if (!s.isFile() && !s.isDirectory()) return;
    if (plan.uid !== undefined || plan.gid !== undefined) await fh.chown(plan.uid ?? -1, plan.gid ?? -1);
    if (plan.mode !== undefined) await fh.chmod(plan.mode);
  } finally {
    await fh.close();
  }
}

export async function applyPerms(cfg: Config, plan: PermsPlan, ctl?: JobCtl): Promise<PermsResult> {
  const res: PermsResult = { path: plan.virtual, changed: 0, skipped: 0, errors: 0 };
  if (!plan.recursive) {
    await applyOne(plan.real, plan.type, plan);
    res.changed = 1;
    return res;
  }
  const stat0 = await fs.lstat(plan.real);
  const dev = stat0.dev;
  const stack = [plan.real];
  let seen = 0;
  const wants = (t: Props["type"]) => plan.scope === "all" || (plan.scope === "files" ? t !== "dir" : t === "dir");
  const doOne = async (real: string, t: Props["type"]) => {
    if (!wants(t)) return void res.skipped++;
    // The mode of links and special files is not changed; ownership of links is (lchown).
    const mode = t === "symlink" || t === "other" ? undefined : plan.mode;
    if (t === "other" || (mode === undefined && plan.uid === undefined && plan.gid === undefined)) return void res.skipped++;
    if (mode !== undefined && t === "dir" && (mode & 0o500) !== 0o500) throw bad("a folder must keep owner read and execute, otherwise even its owner is locked out");
    try {
      await applyOne(real, t, { ...plan, mode });
      res.changed++;
    } catch (e) {
      if ((e as Error).message.includes("locked out")) throw e;
      res.errors++;
    }
  };
  await doOne(plan.real, "dir");
  while (stack.length) {
    if (ctl?.signal.aborted) throw bad("canceled");
    const dir = stack.pop()!;
    if (ctl) ctl.progress.current = dir.slice(cfg.root === "/" ? 0 : cfg.root.length) || "/";
    for await (const batch of namesOf(dir, 256, undefined, () => res.errors++)) await visit(dir, batch);
  }
  if (ctl) ctl.progress.entries = seen;
  return res;

  async function visit(dir: string, names: string[]) {
    for (const n of names) {
      if (n === TRASH_DIR) continue;
      if (ctl?.signal.aborted) throw bad("canceled");
      if (seen >= cfg.walkMaxEntries) throw bad("too many entries for one recursive change");
      seen++;
      const real = path.join(dir, n);
      let s;
      try {
        s = await fs.lstat(real);
      } catch {
        res.errors++;
        continue;
      }
      const t = kindOf(s);
      if (t === "dir") {
        if (s.dev !== dev) {
          res.skipped++;
          continue;
        }
        stack.push(real);
      }
      await doOne(real, t);
      if (ctl && seen % 64 === 0) {
        ctl.progress.entries = seen;
        await tick();
      }
    }
  }
}

const flag = (v: string | undefined) => v === "1";

/** The size store lives next to the compare index; its `du` is a bounded, cancellable walk that reuses unchanged folders. */
export function registerPropsRoutes(app: Hono, cfg: Config, jobs: Jobs): SizeStore {
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
  const scanParts = <T,>(kind: "size" | "du", virtual: string, fresh: boolean, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; extra?: T }) => void) => {
    let release: (() => void) | undefined;
    return {
      run: async (ctl: JobCtl) => {
        const x = await sizes.scanRead(virtual, ctl, fresh, release, after);
        done?.(x);
        return kind === "size" ? x.res : { res: x.res, read: x.read };
      },
      onDrop: () => release?.(),
      gate: async (signal: AbortSignal) => void (release = await sizes.lock(virtual, signal)),
    };
  };
  const startScan = <T,>(kind: "size" | "du", virtual: string, fresh: boolean, after?: () => Promise<T>, done?: (x: { res: SizeResult; read: number; extra?: T }) => void) => {
    const p = scanParts(kind, virtual, fresh, after, done);
    return jobs.create(kind, `Size of ${path.posix.basename(virtual) || "/"}`, p.run, p.onDrop, p.gate, { params: { path: virtual, fresh } });
  };
  // An adopted scan runs again under its id, confined again and without `after` (a du client repeats its request once the job is done).
  for (const kind of ["size", "du"] as const) {
    jobs.register(kind, async (p) => scanParts(kind, resolveRead(cfg.root, (p as { path: string }).path).virtual, (p as { fresh: boolean }).fresh));
  }

  // "Calculate" in the properties dialog: exact, so every folder is re-read unless the caller says otherwise.
  app.post("/api/jobs/size", async (c) => {
    const b = await json<{ path?: string; fresh?: boolean }>(c);
    if (typeof b.path !== "string") throw bad("path must be a string");
    const r = resolveRead(cfg.root, b.path);
    await fs.stat(r.real);
    return c.json(startScan("size", r.virtual, b.fresh !== false), 202);
  });

  // GET /api/du?path=&depth=&all=&fresh=&cachedOnly=: unchanged folders are validated (one lstat each), changed ones re-read, then the
  // answer is read from the store under the scan's lock. A scan longer than cfg.duWaitMs answers 202 {jobId} and keeps
  // running; poll GET /api/jobs/<id> until it is done, then repeat the request: for a minute it is answered from that scan.
  interface DuRun {
    id: string;
    detached: boolean;
    out?: { tree: { entries: DuEntry[]; truncated: boolean } | undefined; read: number };
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
      const t = await sizes.tree(r.virtual, depth, all);
      if (!t.entries.length) return c.body(null, 204);
      return c.json({ path: r.virtual, entries: t.entries, cached: sizes.persistent, truncated: t.truncated, watched: sizes.covers(r.virtual) });
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
      v = startScan("du", r.virtual, fresh, () => sizes.tree(r.virtual, depth, all), (x) => (mine.out = { tree: x.extra, read: x.read }));
      mine.id = v.id;
      duRuns.set(key, mine);
    }
    const id = run.id;
    const forget = () => {
      if (duRuns.get(key) === run) duRuns.delete(key);
    };
    try {
      const signal = c.req.raw.signal;
      while ((v!.state === "queued" || v!.state === "running") && Date.now() < arrived + cfg.duWaitMs && !signal.aborted) {
        await new Promise((res) => setTimeout(res, 20));
        v = jobs.get(id) ?? { ...v!, state: "failed", error: "job lost" };
      }
      if (v!.state === "queued" || v!.state === "running") {
        // keep the entry for the repeat request; the job goes on whether or not this client is still there
        run.detached = true;
        return c.json({ jobId: id, state: v!.state }, 202);
      }
      if (v!.state === "canceled") throw new ops.FsError(409, "canceled");
      if (v!.state === "failed") throw new ops.FsError(500, v!.error ?? "failed");
      const { res } = v!.result as { res: SizeResult };
      if (res.truncated) {
        // A capped scan is never stored: answer with the partial totals of the folder alone.
        return c.json({ path: r.virtual, entries: [{ path: r.virtual, type: "dir", bytes: res.bytes, diskBytes: res.diskBytes, files: res.files, dirs: res.dirs }], cached: false, truncated: true, watched: false });
      }
      const t = run.out?.tree;
      if (!t?.entries.length) throw new ops.FsError(404, "not found");
      // cached: nothing was read from disk and the answer comes from the database (not from a degraded, uncached store)
      return c.json({ path: r.virtual, entries: t.entries, cached: (replay || run.out!.read === 0) && sizes.persistent, truncated: t.truncated, watched: sizes.covers(r.virtual) });
    } finally {
      if (!run.detached) forget();
      else if (replay) forget();
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
