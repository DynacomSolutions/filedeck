import path from "node:path";
import { BUILT_NATIVE_DIR, executable } from "./native.ts";
import { spawnSandboxed, UNPRIVILEGED, type Capability } from "./sandbox.ts";

/**
 * The host helpers (server/native/host: `filedeck-id`, and in a later part `filedeck-pam`) run against the machine's own libc, NSS
 * and PAM, not the agent's. They stay in the image: the launcher opens one by its path here, changes the root to the machine's
 * (`FILEDECK_ROOT`) and runs it from that descriptor (`--exec-outside`), so its dynamic loader and libraries are the machine's.
 * Nothing is written on the machine, and nothing from the machine loads into the agent's own process.
 */

/** Where the image installs the host helpers (Dockerfile, stage hostbuild). */
export const INSTALLED_HOST_HELPERS = "/usr/local/lib/filedeck/host";

/**
 * The folder that holds the host helpers: `configured` (FILEDECK_HOST_HELPERS, `Config.hostHelpers`) as given when set, else the
 * image's folder, else the one `npm run build` makes beside the code. Null when that folder has no `filedeck-id` that can be run.
 */
export async function hostHelperDir(configured: string | undefined): Promise<string | null> {
  const has = (d: string) => executable(path.join(d, "filedeck-id"));
  if (configured !== undefined) return (await has(configured)) ? configured : null;
  for (const d of [INSTALLED_HOST_HELPERS, path.join(BUILT_NATIVE_DIR, "host")]) if (await has(d)) return d;
  return null;
}

const MAX_OUTPUT = 64 * 1024;
const MAX_STDERR = 4 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Runs the host helper `name` from `dir` (a folder of this process, from `hostHelperDir`) inside `root`, through the launcher: chroot,
 * the program by descriptor, no Landlock (its rules would not fit the machine's root), sockets allowed (NSS may ask SSSD or nscd over a
 * unix socket), every capability cleared except `keepCaps`, and an environment with only `PATH`. It runs as uid and gid 65534 with no
 * supplementary groups, or as root with `asRoot` (PAM needs it). Killed after `timeoutMs` (default 10 s) or when it writes more than
 * 64 KiB; `code` is then null. Output that is not valid UTF-8 is an error. `stderr` (at most 4 KiB) is for logs only.
 */
export async function runHostHelper(
  root: string,
  dir: string,
  name: string,
  args: string[],
  o: { stdin?: Buffer; timeoutMs?: number; keepCaps?: Capability[]; allowMetadata?: boolean; asRoot?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!path.isAbsolute(dir)) throw new Error(`not a host helper folder (not absolute): ${dir}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`not a host helper name: ${name}`);
  const child = await spawnSandboxed(path.join(dir, name), args, {
    chroot: root,
    execOutside: true,
    landlock: false,
    allowSockets: true,
    ...(o.asRoot ? {} : { uid: UNPRIVILEGED.uid, gid: UNPRIVILEGED.gid }),
    keepCaps: o.keepCaps ?? [],
    allowMetadata: o.allowMetadata,
    env: { PATH: "/usr/bin:/bin" },
    stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const r = await new Promise<{ code: number | null; out: Buffer; stderr: string }>((resolve) => {
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
      resolve({ code: null, out: Buffer.alloc(0), stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, out: Buffer.concat(out), stderr: err });
    });
  });
  // a killed helper's output is cut anywhere and only shown in a message; a finished one's must be valid UTF-8
  if (r.code === null) return { code: null, stdout: r.out.toString("utf8"), stderr: r.stderr };
  let stdout: string;
  try {
    stdout = utf8.decode(r.out);
  } catch {
    throw new Error(`host helper ${name}: its output is not valid UTF-8`);
  }
  return { code: r.code, stdout, stderr: r.stderr };
}
