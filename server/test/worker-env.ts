import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountResolver, LocalAccount } from "../src/local-accounts.ts";

/**
 * Helpers for the worker tests (sign-in part 2). A worker never runs as root, so a suite that runs as root starts its workers as
 * nobody (65534), and the folders those workers use must belong to that account.
 */

const IS_ROOT = process.getuid?.() === 0;

/** The account the test workers run as: the test's own user, or nobody (65534, groups `[65534]`) when the suite runs as root. */
export function testAccount(): LocalAccount {
  if (IS_ROOT) return { name: "nobody", uid: 65534, gid: 65534, groups: [65534], home: "/nonexistent" };
  const me = os.userInfo();
  const gid = process.getgid?.() ?? me.gid;
  const groups = [...new Set([gid, ...(process.getgroups?.() ?? [])])].filter((g) => g !== 0);
  return { name: me.username, uid: me.uid, gid, groups, home: me.homedir };
}

/** Gives `dir` and everything under it to `testAccount()` when the suite runs as root (else nothing to do). */
export function chownForTest(dir: string): void {
  if (!IS_ROOT) return;
  const { uid, gid } = testAccount();
  const walk = (p: string) => {
    fs.lchownSync(p, uid, gid);
    if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
}

/**
 * A resolver over a fixed map of names. Each named account is `testAccount()` with the given fields over it; a name that is not
 * in the map, and an entry with uid 0 or gid 0, resolve to null (as the real resolvers answer).
 */
export function fakeResolver(map: Record<string, Partial<LocalAccount>> = {}): AccountResolver {
  return {
    async resolve(name: string): Promise<LocalAccount | null> {
      if (!Object.hasOwn(map, name)) return null;
      const a: LocalAccount = { ...testAccount(), name, ...map[name] };
      if (a.uid === 0 || a.gid === 0) return null;
      return { ...a, groups: a.groups.filter((g) => g !== 0) };
    },
  };
}

/**
 * Points `TMPDIR` at a new folder for the rest of this test file, so the folders the agent makes there for its workers
 * (`filedeck-workers/`) go with it: the returned function removes it. The folder can be passed through (0755), as a worker that runs as
 * another account must reach its own folders below it.
 */
export function privateTmpdir(): () => void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-workertmp-")));
  fs.chmodSync(dir, 0o755);
  const old = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return () => {
    if (old === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
