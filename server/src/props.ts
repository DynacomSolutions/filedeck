import fs from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import * as ops from "./fsops.ts";
import { parseMounts, networkKind } from "./mounts.ts";
import { TRASH_DIR, assertNotTrash, resolveRead, resolveWrite } from "./paths.ts";
import type { JobCtl, Jobs } from "./jobs.ts";
import type { Config } from "./config.ts";

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
    const mounts = parseMounts(await fs.readFile(cfg.procMounts, "utf8")).filter((m) => r.virtual === m.mountpoint || r.virtual.startsWith(m.mountpoint === "/" ? "/" : m.mountpoint + "/"));
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

/**
 * Bounded, cancellable `du`: never follows symlinks, never crosses into another
 * device, skips the trash store, caps the number of entries, and yields to the
 * event loop between batches so it stays gentle on the disk.
 */
export async function folderSize(root: string, p: string, maxEntries: number, ctl: JobCtl): Promise<SizeResult> {
  const start = resolveRead(root, p);
  const st = await fs.stat(start.real);
  const res: SizeResult = { path: start.virtual, files: 0, dirs: 0, symlinks: 0, other: 0, bytes: 0, diskBytes: 0, truncated: false, mountsSkipped: 0, errors: 0 };
  if (!st.isDirectory()) {
    res.files = 1;
    res.bytes = st.size;
    res.diskBytes = Number(st.blocks) * 512;
    return res;
  }
  const dev = st.dev;
  const stack = [start.real];
  let seen = 0;
  while (stack.length) {
    if (ctl.signal.aborted) throw bad("canceled");
    const dir = stack.pop()!;
    ctl.progress.current = dir.slice(root === "/" ? 0 : root.length) || "/";
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      res.errors++;
      continue;
    }
    for (let i = 0; i < names.length; i += 32) {
      if (ctl.signal.aborted) throw bad("canceled");
      const got = await Promise.all(
        names.slice(i, i + 32).map(async (n) => {
          if (n === TRASH_DIR) return null;
          const real = path.join(dir, n);
          try {
            return { real, s: await fs.lstat(real) };
          } catch {
            res.errors++;
            return null;
          }
        }),
      );
      for (const g of got) {
        if (!g) continue;
        if (seen >= maxEntries) {
          res.truncated = true;
          stack.length = 0;
          return finish(res, ctl);
        }
        seen++;
        const size = Number(g.s.size);
        const disk = Number(g.s.blocks) * 512;
        if (g.s.isDirectory()) {
          res.dirs++;
          res.diskBytes += disk;
          if (g.s.dev !== dev) res.mountsSkipped++;
          else stack.push(g.real);
        } else if (g.s.isSymbolicLink()) {
          res.symlinks++;
          res.diskBytes += disk;
        } else if (g.s.isFile()) {
          res.files++;
          res.bytes += size;
          res.diskBytes += disk;
        } else res.other++;
      }
      ctl.progress.entries = seen;
      ctl.progress.bytes = res.bytes;
      await tick();
    }
  }
  return finish(res, ctl);
}
function finish(res: SizeResult, ctl: JobCtl) {
  ctl.progress.bytes = res.bytes;
  ctl.progress.entries = res.files + res.dirs + res.symlinks + res.other;
  return res;
}

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
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      res.errors++;
      continue;
    }
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
  if (ctl) ctl.progress.entries = seen;
  return res;
}

export function registerPropsRoutes(app: Hono, cfg: Config, jobs: Jobs): void {
  const json = async <T,>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw bad("invalid JSON body");
    }
  };
  app.get("/api/fs/props", async (c) => c.json(await props(cfg, c.req.query("path") ?? "/")));

  app.post("/api/jobs/size", async (c) => {
    const b = await json<{ path?: string }>(c);
    if (typeof b.path !== "string") throw bad("path must be a string");
    const r = resolveRead(cfg.root, b.path);
    await fs.stat(r.real);
    const job = jobs.create("size", `Size of ${path.posix.basename(r.virtual) || "/"}`, (ctl) => folderSize(cfg.root, r.virtual, cfg.walkMaxEntries, ctl));
    return c.json(job, 202);
  });

  // Immediate for one entry; recursive changes run as a job (202 + job view).
  app.post("/api/fs/perms", async (c) => {
    const plan = await planPerms(cfg, await json<PermsRequest>(c));
    if (plan.recursive) {
      const what = [plan.mode !== undefined ? `mode ${plan.mode.toString(8)}` : "", plan.uid !== undefined || plan.gid !== undefined ? "owner" : ""].filter(Boolean).join(" and ");
      const job = jobs.create("perms", `Set ${what} on ${path.posix.basename(plan.virtual)} recursively`, (ctl) => applyPerms(cfg, plan, ctl));
      return c.json(job, 202);
    }
    return c.json(await applyPerms(cfg, plan));
  });
}
