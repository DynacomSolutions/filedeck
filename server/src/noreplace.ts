import { spawn } from "node:child_process";
import { executable, locateHelper } from "./native.ts";

/**
 * rename(2) that never replaces what is at the destination: renameat2 with RENAME_NOREPLACE, which plain Node cannot call, through
 * the small native helper `filedeck-rename` (server/native). `FILEDECK_RENAME_HELPER` names it; when it is not set the helper is
 * /usr/local/bin/filedeck-rename (the image), or else the one `npm run build` compiled into server/dist/native (`locateHelper`,
 * the same order as the sandbox launcher; `PATH` is never searched).
 *
 * The callers hold the two parent folders pinned and name the entries as `/proc/self/fd/<n>/<name>` (see paths.ts). The helper
 * gets those very descriptors, `<n>` of each side, as its descriptors 3 and 4, and the two names as arguments: what it renames
 * is decided by the descriptors this process holds, and no path text is resolved again in the child (there `/proc/self/fd/<n>`
 * would name the child's own descriptors). A path of any other form (a deeper path, or a plain path where descriptors cannot be
 * named) is answered "absent" and the caller keeps its own steps.
 *
 * The child is started directly: not through a shell and not through the sandbox launcher (it needs the agent's own rights on the
 * two folders, as the agent's rename would have). It gets an empty environment, `/` as its working folder, no input, and nothing
 * but the two folders besides its standard streams: every descriptor Node opens is close-on-exec, and only the ones listed in
 * `stdio` are handed over. A descriptor the agent's own process was started with (Node marks only the low ones close-on-exec)
 * would still pass, so the helper closes everything above 4 before it does anything else.
 *
 * One start of the helper per call.
 */
export type NoReplace = "done" | "exists" | "xdev" | "unsupported" | "absent";

/** The helper's exit statuses (see server/native/filedeck-rename.c). */
const EXIT = { done: 0, other: 1, usage: 2, exists: 3, unsupported: 4, xdev: 5 } as const;

let located: Promise<string | null> | null = null;
/** The kernel has no renameat2 at all for this process (ENOSYS): that cannot change while it runs, so the helper is not started again. */
let noSyscall = false;

/** Forget the located helper and what was learnt about the kernel (tests change the environment). */
export function resetNoReplace(): void {
  located = null;
  noSyscall = false;
}

/** The helper that is used here, or null when there is none (not Linux, not built, not installed, or the named one cannot be run). */
export function noReplaceHelper(): Promise<string | null> {
  located ??= (async () => {
    if (process.platform !== "linux") return null;
    const h = await locateHelper("filedeck-rename", process.env.FILEDECK_RENAME_HELPER);
    return (await executable(h)) ? h : null;
  })();
  return located;
}

/** One line for the start-up log when the helper is missing, or null when it is there. */
export async function noReplaceWarning(): Promise<string | null> {
  if ((await noReplaceHelper()) !== null) return null;
  return "no-replace rename helper (filedeck-rename) not found: a move or copy without overwrite places a folder with a check followed by a rename, so an empty folder created at the destination in between can be replaced";
}

/** `/proc/self/fd/<n>/<name>`: an entry directly in a folder this process holds open. */
const PINNED_ENTRY = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/;

function pinnedEntry(p: string): { fd: number; name: string } | null {
  const m = PINNED_ENTRY.exec(p);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { fd: Number(m[1]), name: m[2]! };
}

/**
 * Move `from` to `to` (both of the form `/proc/self/fd/<n>/<name>`, the folders still held by the caller) only if nothing is at
 * `to`. Answers "done", "exists" (something is there, of any kind, also when it appeared an instant ago), "xdev" (different
 * devices), "unsupported" (the kernel or the filesystem does not have the flag: nothing was done), or "absent" (no helper here,
 * a helper that could not be started, or a path of another form: nothing was done). Any other failure throws an error whose `code` is the errno name the helper
 * printed (ENOENT, EACCES, ENOSPC, ...), as rename(2) would have thrown.
 *
 * "unsupported" is asked again on the next call (the same answer, EINVAL, is also what a folder moved into itself gets, so it
 * says nothing lasting about the filesystem); only a kernel without the call is remembered.
 */
export async function renameNoReplace(from: string, to: string): Promise<NoReplace> {
  const [a, b] = [pinnedEntry(from), pinnedEntry(to)];
  if (!a || !b) return "absent";
  const helper = await noReplaceHelper();
  if (!helper) return "absent";
  if (noSyscall) return "unsupported";
  return run(helper, a.name, b.name, a.fd, b.fd);
}

function run(helper: string, fromName: string, toName: string, fromFd: number, toFd: number): Promise<NoReplace> {
  return new Promise((resolve, reject) => {
    // stdin and stdout are /dev/null, stderr is a pipe for the one error line, 3 and 4 are the two folders
    const child = spawn(helper, [fromName, toName], { stdio: ["ignore", "ignore", "pipe", fromFd, toFd], env: {}, cwd: "/", shell: false });
    let err = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      if (err.length < 512) err += d;
    });
    // The helper could not be started (removed since it was located, or no process could be made): nothing was done, and the
    // caller keeps its own steps, as where there is no helper. It is located again on the next call.
    child.on("error", () => {
      located = null;
      resolve("absent");
    });
    child.on("close", (code) => {
      if (code === EXIT.done) return resolve("done");
      if (code === EXIT.exists) return resolve("exists");
      if (code === EXIT.xdev) return resolve("xdev");
      const name = /^filedeck-rename: (E[A-Z0-9]+)$/m.exec(err)?.[1];
      if (code === EXIT.unsupported) {
        if (name === "ENOSYS") noSyscall = true;
        return resolve("unsupported");
      }
      const errno = name && name !== "EUNKNOWN" ? name : "EIO";
      reject(Object.assign(new Error(`${errno}: rename without replace failed (${code === null ? "helper killed" : `helper status ${code}`})`), { code: errno }));
    });
  });
}
