import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { FsError } from "./fsops.ts";

/**
 * Confinement of the helper programs the agent starts (git today; archive tools next).
 *
 * Input that belongs to somebody else (a repository, an archive) can hold links that lead anywhere, and no check made
 * before a program starts can say what the program opens afterwards. So the process itself is confined: it runs through
 * the native launcher `filedeck-sandbox` (server/native), which drops to a given uid/gid, sets no-new-privileges and applies
 * a Linux Landlock ruleset (kernel 5.13 or newer) that allows only the listed roots, plus the system folders a program
 * needs to start. A link that leads outside the roots then fails at open time, whatever was checked earlier.
 *
 * `FILEDECK_SANDBOX` chooses what happens when Landlock is not usable (old kernel, not enabled, blocked by a seccomp
 * profile, launcher missing):
 *   auto (default)  the program still runs, without kernel confinement, as the given uid/gid; the caller must then do its own
 *                   checks (`sandboxInfo().state === "fallback"`); logged once at start-up
 *   require         `spawnSandboxed` throws 503
 *   off             no launcher, no confinement, nothing extra: only the caller's own checks (development)
 * `FILEDECK_SANDBOX_HELPER` names the launcher (default /usr/local/bin/filedeck-sandbox).
 */

export type SandboxMode = "auto" | "require" | "off";
export interface SandboxInfo {
  mode: SandboxMode;
  helper: string | null;
  /** Landlock works here: confined programs are confined by the kernel */
  landlock: boolean;
  /** "landlock" (confined), "fallback" (runs unconfined, the caller must check its input), "off", or "unavailable" (require, and no Landlock) */
  state: "landlock" | "fallback" | "off" | "unavailable";
}

/** The launcher's exit status for "Landlock is not available here"; the command was not run. */
export const EXIT_LANDLOCK_UNSUPPORTED = 70;

const DEFAULT_HELPER = "/usr/local/bin/filedeck-sandbox";
let cached: Promise<SandboxInfo> | null = null;

function modeFromEnv(): SandboxMode {
  const v = (process.env.FILEDECK_SANDBOX ?? "auto").trim().toLowerCase();
  return v === "require" || v === "off" ? v : "auto";
}

/** Does the launcher at `helper` report a usable Landlock? Exit 0 yes, 70 no. */
export function probeHelper(helper: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(helper, ["--probe"], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    child.on("error", () => (clearTimeout(timer), resolve(false)));
    child.on("close", (code) => (clearTimeout(timer), resolve(code === 0)));
  });
}

/** What the sandbox is here, found once (the first sandboxed start, or `initSandbox` at start-up). */
export function sandboxInfo(): Promise<SandboxInfo> {
  cached ??= (async () => {
    const mode = modeFromEnv();
    if (mode === "off") return { mode, helper: null, landlock: false, state: "off" as const };
    const helper = process.env.FILEDECK_SANDBOX_HELPER ?? DEFAULT_HELPER;
    const usable = await fs.access(helper, fs.constants.X_OK).then(() => true, () => false);
    const landlock = usable && (await probeHelper(helper));
    return { mode, helper: usable ? helper : null, landlock, state: landlock ? ("landlock" as const) : mode === "require" ? ("unavailable" as const) : ("fallback" as const) };
  })();
  return cached;
}

/** Forget the cached answer (tests change the environment; a launcher that reported "unsupported" at run time is probed again). */
export function resetSandbox(): void {
  cached = null;
}

/** Called once when the agent starts: finds the mode and says so, in a line, when programs are not confined by the kernel. */
export async function initSandbox(log: (msg: string) => void = (m) => console.warn(m)): Promise<SandboxInfo> {
  const info = await sandboxInfo();
  if (info.state === "fallback") log("sandbox unavailable (Landlock is not usable here): helper programs run without kernel confinement; Git is used only for repositories whose git directory has no symbolic links or include settings");
  else if (info.state === "unavailable") log("sandbox unavailable (Landlock is not usable here) and FILEDECK_SANDBOX=require: the features that start helper programs answer an error");
  return info;
}

/** The error answered when the sandbox is required and not available. */
export const sandboxRequiredError = () => new FsError(503, "disabled: the sandbox is required (FILEDECK_SANDBOX=require) but Landlock is not available here");

/** A folder the program may use: a path (opened by the launcher when it starts), or an open directory descriptor of this process (the rule is attached to that directory itself, so renames and links swapped in afterwards change nothing). */
export type Root = string | number;

export interface SandboxOpts extends Omit<SpawnOptions, "uid" | "gid"> {
  /** read files and list folders beneath these */
  readOnly?: Root[];
  /** the same, and execute files */
  readExec?: Root[];
  /** the same, and write, create, remove, rename and link (not execute) */
  readWrite?: Root[];
  /** run as this user and group, supplementary groups cleared (applied before the program starts) */
  uid?: number;
  gid?: number;
  /** do not add the system folders, /etc files and /dev/null the launcher allows by default (the program must then be static) */
  noSystem?: boolean;
}

/**
 * Starts `cmd args...` confined to the given roots (see the file comment for what is allowed besides them). Resolves with the
 * child. `stdio` defaults to `["ignore", "pipe", "pipe"]`; descriptor roots are passed to the launcher as extra inherited
 * descriptors after the three standard ones. Throws 503 when the sandbox is required and missing. When Landlock is not usable
 * (`sandboxInfo().state === "fallback"`) the program is started without confinement (still as `uid`/`gid`): check the input first.
 * If the launcher itself exits with `EXIT_LANDLOCK_UNSUPPORTED`, the program did not run: call `resetSandbox()` and treat it as unavailable.
 */
export async function spawnSandboxed(cmd: string, args: string[], opts: SandboxOpts = {}): Promise<ChildProcess> {
  const { readOnly = [], readExec = [], readWrite = [], uid, gid, noSystem, stdio, ...rest } = opts;
  const info = await sandboxInfo();
  if (info.state === "unavailable") throw sandboxRequiredError();
  const owner = uid !== undefined && gid !== undefined && uid !== process.getuid?.() ? { uid, gid } : null;
  const std: SpawnOptions["stdio"] = stdio ?? ["ignore", "pipe", "pipe"];
  if (info.state === "off") return spawn(cmd, args, { ...rest, stdio: std });
  if (info.state === "fallback") {
    if (owner && info.helper) return spawn(info.helper, ["--no-landlock", "--uid", String(owner.uid), "--gid", String(owner.gid), "--", cmd, ...args], { ...rest, stdio: std });
    return spawn(cmd, args, { ...rest, stdio: std, ...(owner ? owner : {}) });
  }
  const fds: unknown[] = Array.isArray(std) ? [...std] : [std, std, std];
  while (fds.length < 3) fds.push("ignore");
  const flags: string[] = [];
  const add = (flag: string, roots: Root[]) => {
    for (const r of roots) {
      if (typeof r === "number") {
        fds.push(r);
        flags.push(flag, `fd:${fds.length - 1}`);
      } else flags.push(flag, r);
    }
  };
  add("--ro", readOnly);
  add("--rx", readExec);
  add("--rw", readWrite);
  if (noSystem) flags.push("--no-system");
  if (owner) flags.push("--uid", String(owner.uid), "--gid", String(owner.gid));
  return spawn(info.helper!, [...flags, "--", cmd, ...args], { ...rest, stdio: fds as SpawnOptions["stdio"] });
}
