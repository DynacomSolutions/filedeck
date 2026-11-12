import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { FsError } from "./fsops.ts";
import { spawnSandboxed } from "./sandbox.ts";

/**
 * Git on top of the general sandbox (sandbox.ts): every Git command runs read-only beneath the served root and, when the
 * agent is root, as the owner of the git directory. When Landlock is not usable (`sandboxInfo().state === "fallback"`) the
 * git directory itself is checked instead: `plainGitDir`.
 */

export interface Launch {
  /** the served root (real path) the git directory belongs to; read access is limited to it */
  root: string | null;
  /** the validated git directory: its owner is the identity Git runs as when the agent is root */
  gitDir: string | null;
}

/** Starts `git <gitArgs>` confined to the root; see `spawnSandboxed`. */
export async function launchGit(cwd: string, gitArgs: string[], env: NodeJS.ProcessEnv, spawnOpts: SpawnOptions, where: Launch): Promise<ChildProcess> {
  // the repository's owner, when this process is root and the owner is not
  let owner: { uid: number; gid: number } | null = null;
  if (process.getuid?.() === 0 && where.gitDir) {
    const st = await fs.stat(where.gitDir).catch(() => null);
    if (!st) throw new FsError(404, "git directory not found");
    if (st.uid !== 0) owner = { uid: st.uid, gid: st.gid };
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
