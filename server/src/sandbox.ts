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
 *   auto            (the default of a plain start; the image and the chart set `require`) the program still runs, without kernel confinement, as the given uid/gid; the caller must then do its own
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
  /** Landlock ABI version the kernel offers (0 when unusable) and the rights the launcher handles there, as hexadecimal masks */
  abi: number;
  rights: { fs: string; net: string; scope: string } | null;
  /** the launcher's socket filter (seccomp) can be installed here: socket, connect, bind, listen, accept and io_uring are refused */
  seccomp: boolean;
  /** the launcher can clear capabilities here (it always does before it starts a program) */
  caps: boolean;
  /** "landlock" (confined), "fallback" (runs unconfined, the caller must check its input), "off", or "unavailable" (require, and no Landlock) */
  state: "landlock" | "fallback" | "off" | "unavailable";
}

/**
 * What the launcher does NOT restrict (see the comment in server/native/filedeck-sandbox.c for the table). It handles every
 * Landlock right the running kernel offers: all file system rights, TCP (and UDP where offered) bind and connect, abstract unix
 * sockets and signals to processes outside the sandbox. On an older kernel what is missing is what each ABI added: ABI 1
 * lacks cross-directory link/rename control and truncate control (ABI 2, 3), below ABI 4 the network is open, below ABI 5 device
 * ioctls are, below ABI 6 abstract unix sockets and signals are, below ABI 9 pathname unix sockets are. UDP: no Landlock ABI
 * this launcher knows controls UDP bind/connect before the kernel's newest one, so there UDP stays open to a confined program,
 * with one extra layer: unless `allowSockets` is set the launcher installs a seccomp filter that makes `socket()`,
 * `socketpair()`, `connect()`, `bind()`, `listen()`, `accept()` and io_uring fail with EACCES (x32 system call numbers end the
 * process), on every kernel, so a confined program can neither reach UDP nor connect to a pathname unix socket (such as a
 * container runtime's) under the served root; it uses the descriptors it was given. That layer is best effort: a kernel without
 * seccomp filters, or an architecture other than x86-64 and arm64, leaves it off, which `SandboxInfo.seccomp`, the start-up
 * log line and `/api/info` report. Landlock never restricts
 * a descriptor the program already holds: the launcher marks every descriptor above 2 close-on-exec (the root descriptors
 * included), and callers must not hand a confined program any descriptor it should not use through `stdio` either.
 * `uid`/`gid` 0 are refused by the launcher.
 * Capabilities: the launcher clears every capability of a confined program (also one that stays root) except those named in `keepCaps`, and its
 * seccomp filter refuses the privilege, mount, namespace and (unless `allowMetadata`) metadata calls; see the comment in the launcher.
 */

/** The user and group unprivileged helper programs run as when the agent is root (the same ones the media tools use). */
export const UNPRIVILEGED = { uid: 65534, gid: 65534 } as const;

/** The launcher's exit status for "Landlock is not available here"; the command was not run. */
export const EXIT_LANDLOCK_UNSUPPORTED = 70;

const DEFAULT_HELPER = "/usr/local/bin/filedeck-sandbox";
let cached: Promise<SandboxInfo> | null = null;

function modeFromEnv(): SandboxMode {
  const v = (process.env.FILEDECK_SANDBOX ?? "auto").trim().toLowerCase();
  return v === "require" || v === "off" ? v : "auto";
}

export interface Probe {
  ok: boolean;
  abi: number;
  rights: { fs: string; net: string; scope: string } | null;
  seccomp: boolean;
  caps: boolean;
}
const NO_PROBE: Probe = { ok: false, abi: 0, rights: null, seccomp: false, caps: false };

/** Does the launcher at `helper` report a usable Landlock (exit 0), which rights, and is its socket filter available? Exit 70: no. */
export function probeHelperInfo(helper: string): Promise<Probe> {
  return new Promise((resolve) => {
    const child = spawn(helper, ["--probe"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    child.on("error", () => (clearTimeout(timer), resolve(NO_PROBE)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(NO_PROBE);
      const m = /landlock abi (\d+) fs (0x[0-9a-f]+) net (0x[0-9a-f]+) scope (0x[0-9a-f]+)(?: seccomp (\d))?(?: caps (\d))?/.exec(out);
      resolve(m ? { ok: true, abi: Number(m[1]), rights: { fs: m[2]!, net: m[3]!, scope: m[4]! }, seccomp: m[5] === "1", caps: m[6] === "1" } : { ok: true, abi: 0, rights: null, seccomp: false, caps: false });
    });
  });
}
export const probeHelper = async (helper: string): Promise<boolean> => (await probeHelperInfo(helper)).ok;

/** What the sandbox is here, found once (the first sandboxed start, or `initSandbox` at start-up). */
export function sandboxInfo(): Promise<SandboxInfo> {
  cached ??= (async () => {
    const mode = modeFromEnv();
    if (mode === "off") return { mode, helper: null, landlock: false, abi: 0, rights: null, seccomp: false, caps: false, state: "off" as const };
    const helper = process.env.FILEDECK_SANDBOX_HELPER ?? DEFAULT_HELPER;
    const usable = await fs.access(helper, fs.constants.X_OK).then(() => true, () => false);
    const probe = usable ? await probeHelperInfo(helper) : NO_PROBE;
    const landlock = probe.ok;
    return { mode, helper: usable ? helper : null, landlock, abi: probe.abi, rights: probe.rights, seccomp: probe.seccomp, caps: probe.caps, state: landlock ? ("landlock" as const) : mode === "require" ? ("unavailable" as const) : ("fallback" as const) };
  })();
  return cached;
}

/** Forget the cached answer (tests change the environment; a launcher that reported "unsupported" at run time is probed again). */
export function resetSandbox(): void {
  cached = null;
}

/** Called once when the agent starts: finds the mode and says so, in lines, when programs are not confined by the kernel. */
export async function initSandbox(log: (msg: string) => void = (m) => console.warn(m)): Promise<SandboxInfo> {
  const info = await sandboxInfo();
  log(sandboxLine(info));
  if (info.state === "off") log("sandbox off (FILEDECK_SANDBOX=off): git, bsdtar and 7zz run with no kernel confinement and no launcher, only the agent's own path checks; for development only");
  else if (info.state === "fallback") log("sandbox unavailable (Landlock is not usable here): git, bsdtar and 7zz run without kernel confinement, only with the agent's own path checks (git is used only for repositories whose git directory has no symbolic links or include settings); set FILEDECK_SANDBOX=require to refuse instead");
  else if (info.state === "unavailable") log("sandbox unavailable (Landlock is not usable here) and FILEDECK_SANDBOX=require: the features that start git, bsdtar or 7zz (repositories, archives, zip downloads) answer an error");
  return info;
}

/** One line for the start-up log: the state, the Landlock ABI and rights, and whether the socket filter is on. */
export function sandboxLine(i: SandboxInfo): string {
  const r = i.rights ? ` rights fs=${i.rights.fs} net=${i.rights.net} scope=${i.rights.scope}` : "";
  return `sandbox: mode ${i.mode}, state ${i.state}, archive tools and git ${archiveToolsState(i)}, landlock ${i.landlock ? `abi ${i.abi}${r}` : "unavailable"}, socket filter ${i.seccomp ? "on" : "off (this kernel or architecture cannot install it)"}`;
}

/** Whether the helper programs (git, bsdtar, 7zz) are confined by the kernel, run unconfined, or refuse to run. */
export const archiveToolsState = (i: SandboxInfo): "confined" | "unconfined" | "disabled" => (i.state === "landlock" ? "confined" : i.state === "unavailable" ? "disabled" : "unconfined");

/** A summary that is safe to show an operator (/api/info): no paths. */
export async function sandboxSummary(): Promise<{ mode: SandboxMode; state: SandboxInfo["state"]; landlockAbi: number; socketFilter: boolean; archiveTools: "confined" | "unconfined" | "disabled" }> {
  const i = await sandboxInfo();
  return { mode: i.mode, state: i.state, landlockAbi: i.abi, socketFilter: i.seccomp, archiveTools: archiveToolsState(i) };
}

/** The error answered when the sandbox is required and not available. */
export const sandboxRequiredError = () => new FsError(503, "disabled: the sandbox is required (FILEDECK_SANDBOX=require) but Landlock is not available here");

/** A folder the program may use: a path (opened by the launcher when it starts), or an open directory descriptor of this process (the rule is attached to that directory itself, so renames and links swapped in afterwards change nothing). */
export type Root = string | number;

/** Who a tool runs as: the user and group, and the one capability it keeps (see `SandboxOpts.keepCaps`). */
export type Capability = "dac_read_search" | "dac_override";

export interface RunAs {
  uid: number;
  gid: number;
  keepCaps?: Capability[];
}

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
  /**
   * start the program in this directory, given as an open descriptor of this process (the launcher does `fchdir` on it, after every
   * descriptor is in place: a `/proc/self/fd/N` working folder can name the wrong descriptor). Use this, not `cwd`, for a pinned folder.
   * Without a launcher (mode `off`, or no launcher installed) the folder's current path is used.
   */
  cwdFd?: number;
  /**
   * descriptors of this process the program is meant to use (an archive opened read-only): they become its descriptors 3, 4, ... in this
   * order, in every mode, and stay open for it; every other descriptor above 2 is closed. Not folders to allow: Landlock does not restrict a
   * descriptor that is already open, so pass only what the program should read.
   */
  keepFds?: number[];
  /**
   * capabilities the program keeps (the launcher clears every other one, also for a program that stays root): `dac_read_search` lets it read
   * files and search folders regardless of their mode, `dac_override` does that and also writes (for a container without the first; Landlock still limits both to the roots). The caller must hold the capability
   * (`hasCapability`); with a user change the launcher keeps it across the change.
   */
  keepCaps?: Capability[];
  /** do not refuse the calls that change modes, owners, times and extended attributes (a program that extracts into a private folder sets them on what it creates) */
  allowMetadata?: boolean;
  /** let the program create sockets of any kind (see the UDP note above); TCP stays denied wherever the kernel's Landlock can deny it */
  allowSockets?: boolean;
  /** do not add the system folders, /etc files and /dev/null the launcher allows by default (the program must then be static) */
  noSystem?: boolean;
}

/** Most roots (folders and files the program may use) one start can carry; the launcher's own limit. More is an error, never a silent cut. */
export const MAX_ROOTS = 4096;

/** The launcher's exit statuses that mean the launcher failed and the program did NOT run (usage error, a step failed, Landlock unsupported). */
export const isLauncherFailure = (code: number | null, stderrText: string): boolean => (code === 64 || code === 70 || code === 71) && /filedeck-sandbox:/.test(stderrText);

async function helperPath(info: SandboxInfo): Promise<string | null> {
  if (info.helper) return info.helper;
  const h = process.env.FILEDECK_SANDBOX_HELPER ?? DEFAULT_HELPER;
  return (await fs.access(h, fs.constants.X_OK).then(() => true, () => false)) ? h : null;
}

/**
 * Starts `cmd args...` confined to the given roots (see the file comment for what is allowed besides them). Resolves with the
 * child. `stdio` defaults to `["ignore", "pipe", "pipe"]`; descriptor roots are passed to the launcher as extra inherited
 * descriptors after the three standard ones. Throws 503 when the sandbox is required and missing. When Landlock is not usable
 * (`sandboxInfo().state === "fallback"`) the program is started without confinement (still as `uid`/`gid`): check the input first.
 * If the launcher itself exits with `EXIT_LANDLOCK_UNSUPPORTED`, the program did not run: call `resetSandbox()` and treat it as unavailable.
 */
export async function spawnSandboxed(cmd: string, args: string[], opts: SandboxOpts = {}): Promise<ChildProcess> {
  const { readOnly = [], readExec = [], readWrite = [], uid, gid, noSystem, allowSockets, keepCaps = [], allowMetadata, cwdFd, keepFds = [], stdio, ...rest } = opts;
  const info = await sandboxInfo();
  if (info.state === "unavailable") throw sandboxRequiredError();
  if ((uid === 0 || gid === 0) && uid !== process.getuid?.()) throw new FsError(500, "refusing to run a confined program as root");
  if (readOnly.length + readExec.length + readWrite.length > MAX_ROOTS) throw new FsError(500, `the sandbox was given ${readOnly.length + readExec.length + readWrite.length} folders and files to allow; the limit is ${MAX_ROOTS}`);
  const owner = uid !== undefined && gid !== undefined && uid !== process.getuid?.() ? { uid, gid } : null;
  const std: SpawnOptions["stdio"] = stdio ?? ["ignore", "pipe", "pipe"];
  const fds: unknown[] = Array.isArray(std) ? [...std] : [std, std, std];
  while (fds.length < 3) fds.push("ignore");
  const addFd = (fd: number): number => (fds.push(fd), fds.length - 1);
  const kept = keepFds.map(addFd); // first, so the first is descriptor 3 whatever else follows
  // No Landlock rules (state off or fallback): the privilege drop and the working folder still must not depend on the mode, so the
  // launcher, when there is one, runs `--no-landlock` with them (it also clears the supplementary groups, which spawn's uid option does not).
  if (info.state === "off" || info.state === "fallback") {
    const helper = owner || cwdFd !== undefined || keepCaps.length ? await helperPath(info) : null;
    if (helper) {
      const flags = ["--no-landlock"];
      for (const k of kept) flags.push("--keep-fd", String(k));
      if (owner) flags.push("--uid", String(owner.uid), "--gid", String(owner.gid));
      if (cwdFd !== undefined) flags.push("--cwd-fd", String(addFd(cwdFd)));
      for (const c of keepCaps) flags.push("--keep-cap", c);
      if (allowMetadata) flags.push("--allow-metadata");
      return spawn(helper, [...flags, "--", cmd, ...args], { ...rest, stdio: fds as SpawnOptions["stdio"] });
    }
    // no launcher (a development start without the helper): the folder by its current path, and the drop by spawn's own uid and gid (Node/libuv
    // clears the supplementary groups itself when a gid is given; the root-only test in sandbox.test.ts checks `id -G`); the kept descriptors are inherited as they are
    const cwd = cwdFd !== undefined ? await fs.readlink(`/proc/self/fd/${cwdFd}`).catch(() => rest.cwd) : rest.cwd;
    return spawn(cmd, args, { ...rest, ...(cwd !== undefined ? { cwd } : {}), stdio: kept.length ? (fds as SpawnOptions["stdio"]) : std, ...(owner ? owner : {}) });
  }
  const flags: string[] = [];
  for (const k of kept) flags.push("--keep-fd", String(k));
  const add = (flag: string, roots: Root[]) => {
    for (const r of roots) {
      if (typeof r === "number") flags.push(flag, `fd:${addFd(r)}`);
      else flags.push(flag, r);
    }
  };
  add("--ro", readOnly);
  add("--rx", readExec);
  add("--rw", readWrite);
  if (cwdFd !== undefined) flags.push("--cwd-fd", String(addFd(cwdFd)));
  if (noSystem) flags.push("--no-system");
  if (allowSockets) flags.push("--allow-sockets");
  for (const c of keepCaps) flags.push("--keep-cap", c);
  if (allowMetadata) flags.push("--allow-metadata");
  if (owner) flags.push("--uid", String(owner.uid), "--gid", String(owner.gid));
  return spawn(info.helper!, [...flags, "--", cmd, ...args], { ...rest, stdio: fds as SpawnOptions["stdio"] });
}

/** Does this process hold the capability in its effective set? (A non-root agent, or a container that dropped it, does not.) Read from /proc/self/status. */
export async function hasCapability(name: Capability): Promise<boolean> {
  const bit = { dac_read_search: 2n, dac_override: 1n }[name];
  try {
    const m = /^CapEff:\s*([0-9a-f]+)/m.exec(await fs.readFile("/proc/self/status", "utf8"));
    return !!m && (BigInt("0x" + m[1]!) & (1n << bit)) !== 0n;
  } catch {
    return false;
  }
}

/** The capability a tool is given to read what only root can read: read-search where this process holds it, else override (container defaults hold that one); null when it holds neither. */
export async function readerCapability(): Promise<Capability | null> {
  if (await hasCapability("dac_read_search")) return "dac_read_search";
  if (await hasCapability("dac_override")) return "dac_override";
  return null;
}
