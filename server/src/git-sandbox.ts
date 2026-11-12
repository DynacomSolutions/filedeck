import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { FsError } from "./fsops.ts";
import { UNPRIVILEGED, hasCapability, sandboxInfo, spawnSandboxed, type RunAs } from "./sandbox.ts";

const said = new Set<string>();
const sayOnce = (m: string) => {
  if (!said.has(m)) {
    said.add(m);
    console.warn(m);
  }
};

/**
 * Git on top of the general sandbox (sandbox.ts): every Git command runs read-only beneath the served root. When Landlock is
 * not usable (`sandboxInfo().state === "fallback"`) the git directory itself is checked instead: `plainGitDir`, run again
 * immediately before every Git command.
 *
 * Who Git runs as, when the agent is root: the owner of the git directory; for a root-owned git directory the unprivileged
 * user (the one the media tools use) when that user can read the repository (the directory and the work tree are
 * world-readable and searchable); for a root-owned repository that user cannot read, that same user with the read-search capability
 * only (Landlock still limits it to the served root), and without that capability the agent's own user; never with root's other
 * capabilities (the launcher clears them all). It is refused without Landlock. An agent that is not root changes nothing.
 */

export interface Launch {
  /** the served root (real path) the git directory belongs to; read access is limited to it */
  root: string | null;
  /** the validated git directory: its owner is the identity Git runs as when the agent is root */
  gitDir: string | null;
  /** the validated common git directory (the same as `gitDir` unless a linked worktree) */
  commonDir?: string | null;
}

/** Can any user read `target` (a folder)? It and every folder above it must be searchable by others, and it readable. */
async function worldReadableDir(target: string): Promise<boolean> {
  let d = path.resolve(target);
  const first = await fs.stat(d).catch(() => null);
  if (!first || (first.mode & 0o005) !== 0o005) return false;
  for (;;) {
    const parent = path.dirname(d);
    if (parent === d) return true;
    const st = await fs.stat(parent).catch(() => null);
    if (!st || (st.mode & 0o001) === 0) return false;
    d = parent;
  }
}

/** Starts `git <gitArgs>` confined to the root; see `spawnSandboxed`. */
export async function launchGit(cwd: string, gitArgs: string[], env: NodeJS.ProcessEnv, spawnOpts: SpawnOptions, where: Launch): Promise<ChildProcess> {
  const info = await sandboxInfo();
  if (info.state === "fallback" && where.gitDir) {
    // no kernel confinement: look at the git directory again now, not only when the repository was first accepted
    const ok = (await plainGitDir(where.gitDir)) && (!where.commonDir || where.commonDir === where.gitDir || (await plainGitDir(where.commonDir)));
    if (!ok) throw new FsError(403, "this git directory cannot be used safely here");
  }
  let owner: RunAs | null = null;
  if (process.getuid?.() === 0 && where.gitDir) {
    const st = await fs.stat(where.gitDir).catch(() => null);
    if (!st) throw new FsError(404, "git directory not found");
    if (st.uid !== 0) owner = { uid: st.uid, gid: st.gid };
    else if ((await worldReadableDir(where.gitDir)) && (await worldReadableDir(cwd))) owner = { ...UNPRIVILEGED };
    else if (info.state === "fallback") throw new FsError(403, "this git directory cannot be used safely here");
    else if (await hasCapability("dac_read_search")) owner = { ...UNPRIVILEGED, keepCaps: ["dac_read_search"] }; // root-owned and not readable by that user: only the read-search capability
    else {
      sayOnce("git: this process lacks the read-search capability, so git runs as the agent's own user (with no capabilities) for repositories the unprivileged user cannot read");
    }
  }
  return spawnSandboxed("git", gitArgs, { ...spawnOpts, cwd, env, readOnly: where.root ? [where.root] : [], ...(owner ?? {}) });
}

const WALK_CAP = 50_000;
const CONFIG_CAP = 1024 * 1024;
const INCLUDE = /^\s*\[\s*include(?:if)?\b/im;

/**
 * Fallback check (no Landlock): a git directory is used only when nothing in it, at any depth, is a symbolic link, and
 * none of its configuration files has an `include` or `includeIf` section. The walk is bounded: more than `WALK_CAP`
 * entries is a refusal, not a pass.
 */
export async function plainGitDir(dir: string): Promise<boolean> {
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (++seen > WALK_CAP) return false;
      if (e.isSymbolicLink()) return false;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (d === dir && (e.name === "config" || e.name === "config.worktree") && e.isFile()) {
        const fh = await fs.open(full, "r").catch(() => null);
        if (!fh) return false;
        try {
          const { buffer, bytesRead } = await fh.read(Buffer.alloc(CONFIG_CAP + 1), 0, CONFIG_CAP + 1, 0);
          if (bytesRead > CONFIG_CAP || INCLUDE.test(buffer.subarray(0, bytesRead).toString("utf8"))) return false;
        } finally {
          await fh.close();
        }
      } else if (!e.isFile() && !e.isDirectory()) return false; // sockets, devices and the like have no place in a git directory
    }
  }
  return true;
}
