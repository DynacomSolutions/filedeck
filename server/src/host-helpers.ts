import { createHash, randomBytes } from "node:crypto";
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BUILT_NATIVE_DIR, executable } from "./native.ts";
import { spawnSandboxed, type Capability } from "./sandbox.ts";

/**
 * The host helpers (server/native/host: `filedeck-id`, and in a later part `filedeck-pam`) run against the machine's own libc,
 * NSS and PAM, not the agent's. The agent copies them into a private folder under the machine's `/run` (seen at `FILEDECK_ROOT`)
 * and starts them through the launcher's `--chroot` into that root. Nothing from the machine loads into the agent's own process.
 */

/** Where the image installs the host helpers (Dockerfile, stage hostbuild). */
export const INSTALLED_HOST_HELPERS = "/usr/local/lib/filedeck/host";

/**
 * The folder that holds the host helpers: `fromEnv` (FILEDECK_HOST_HELPERS) as given when set, else the image's folder, else the
 * one `npm run build` makes beside the code. Null when that folder has no `filedeck-id` that can be run.
 */
export async function hostHelperDir(fromEnv: string | undefined = process.env.FILEDECK_HOST_HELPERS || undefined): Promise<string | null> {
  const has = (d: string) => executable(path.join(d, "filedeck-id"));
  if (fromEnv !== undefined) return (await has(fromEnv)) ? fromEnv : null;
  for (const d of [INSTALLED_HOST_HELPERS, path.join(BUILT_NATIVE_DIR, "host")]) if (await has(d)) return d;
  return null;
}

/** Opens a folder without following a link at its last step and checks it is a real folder owned by root; then sets mode 0700. */
async function privateDir(p: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(p, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const fh = await fs.open(p, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    throw new Error(e.code === "ELOOP" || e.code === "ENOTDIR" ? `${p} is not a folder (a link or a file)` : `${p}: ${e.message}`);
  });
  try {
    const st = await fh.stat();
    if (!st.isDirectory()) throw new Error(`${p} is not a folder`);
    if (st.uid !== 0) throw new Error(`${p} is not owned by root (uid ${st.uid})`);
    if (create && (st.mode & 0o7777) !== 0o700) await fh.chmod(0o700);
  } finally {
    await fh.close();
  }
  // the check above went through the descriptor; this one makes sure the name still leads to a real folder (no link swapped in)
  const l = await fs.lstat(p);
  if (!l.isDirectory() || l.isSymbolicLink() || l.uid !== 0) throw new Error(`${p} changed while it was checked`);
}

/**
 * Copies every file of `from` into `<root>/run/filedeck/host-<first 16 hex digits of the files' sha256>/` (folders 0700 and files
 * 0500, all owned by root; a link or a folder that root does not own anywhere on that path is refused). Returns the folder as the
 * machine sees it (`/run/filedeck/host-...`), for `runHostHelper`. Run again with the same files it gives the same folder and
 * writes back any file that was changed there.
 */
export async function installHostHelpers(root: string, from: string): Promise<{ dir: string } | { error: string }> {
  try {
    const names = (await fs.readdir(from, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
    if (!names.length) return { error: `no host helpers in ${from}` };
    const files = await Promise.all(names.map(async (n) => ({ name: n, body: await fs.readFile(path.join(from, n)) })));
    const h = createHash("sha256");
    for (const f of files) h.update(`${f.name}\0${f.body.length}\0`).update(f.body);
    const leaf = `host-${h.digest("hex").slice(0, 16)}`;

    const run = path.join(root, "run");
    await privateDir(run, false); // the machine's own /run: a real folder owned by root, left as it is
    const base = path.join(run, "filedeck");
    await privateDir(base, true);
    const dir = path.join(base, leaf);
    await privateDir(dir, true);
    for (const f of files) {
      const target = path.join(dir, f.name);
      const cur = await fs.lstat(target).catch(() => null);
      if (cur?.isFile() && cur.uid === 0 && (cur.mode & 0o7777) === 0o500 && (await fs.readFile(target)).equals(f.body)) continue;
      // a fresh file beside it, then a rename over the old name (which replaces a link itself, never what it leads to); the name is
      // unique, so an old and a new agent that install at the same time (a hand-over) do not write into each other's file
      const tmp = path.join(dir, `.${f.name}.${process.pid}.${randomBytes(6).toString("hex")}`);
      const fh = await fs.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o500);
      try {
        await fh.writeFile(f.body);
        await fh.chmod(0o500);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, target);
    }
    return { dir: path.posix.join("/run/filedeck", leaf) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const MAX_OUTPUT = 64 * 1024;
const MAX_STDERR = 4 * 1024;

/**
 * Runs the host helper `name` from `dir` (as `installHostHelpers` returned it) inside `root`, through the launcher: chroot, no
 * Landlock (its rules would not fit the machine's root), sockets allowed (NSS may ask SSSD or nscd over a unix socket), every
 * capability cleared except `keepCaps`, and an environment with only `PATH`. It stays uid 0 inside the machine's root. Killed
 * after `timeoutMs` (default 10 s) or when it writes more than 64 KiB; `code` is then null. `stderr` (at most 4 KiB) is for logs only.
 */
export async function runHostHelper(
  root: string,
  dir: string,
  name: string,
  args: string[],
  o: { stdin?: Buffer; timeoutMs?: number; keepCaps?: Capability[]; allowMetadata?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!/^\/run\/filedeck\/host-[0-9a-f]{16}$/.test(dir)) throw new Error(`not a host helper folder: ${dir}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`not a host helper name: ${name}`);
  const child = await spawnSandboxed(path.posix.join(dir, name), args, {
    chroot: root,
    landlock: false,
    allowSockets: true,
    keepCaps: o.keepCaps ?? [],
    allowMetadata: o.allowMetadata,
    env: { PATH: "/usr/bin:/bin" },
    stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let killed = false;
    const kill = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(kill, o.timeoutMs ?? 10_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (killed) return;
      if (outLen + d.length > MAX_OUTPUT) {
        out.push(d.subarray(0, MAX_OUTPUT - outLen));
        outLen = MAX_OUTPUT;
        return kill();
      }
      out.push(d);
      outLen += d.length;
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < MAX_STDERR) err = (err + d.toString("utf8")).slice(0, MAX_STDERR);
    });
    if (o.stdin) {
      child.stdin!.on("error", () => {}); // a helper that exits before it reads its input
      child.stdin!.end(o.stdin);
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, stdout: Buffer.concat(out).toString("utf8"), stderr: err });
    });
  });
}
