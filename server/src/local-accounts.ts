import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { hostHelperDir, runHostHelper } from "./host-helpers.ts";

/** A local account of this machine that a worker runs as. Never uid 0 or gid 0, and `groups` never holds 0. */
export interface LocalAccount {
  name: string;
  uid: number;
  gid: number;
  /** every group id of the account, the primary one included (as getgrouplist gives them), without duplicates */
  groups: number[];
  home: string;
}

export interface AccountResolver {
  /** The account, or null for an unknown name, a name that is not a valid system name, and uid 0 or gid 0. `fresh` skips any cache. */
  resolve(name: string, fresh?: boolean): Promise<LocalAccount | null>;
}

/** A system account name Filedeck accepts: what the usual tools allow, with `@` and `.` for directory accounts, never a leading `-`. */
export const validSystemName = (name: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/.test(name);

/** The largest id an account can have; 4294967295 is (uid_t)-1, which means "no change" to the kernel. */
const MAX_ID = 4294967294;
const id = (s: string): number | null => {
  if (!/^[0-9]{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_ID ? n : null;
};

/**
 * Builds the account, or null for uid 0 or gid 0. A supplementary group 0 is dropped (never handed to a worker) and said once per name
 * through `dropped`.
 */
function account(name: string, uid: number, gid: number, home: string, groups: number[], dropped: (name: string) => void): LocalAccount | null {
  if (uid === 0 || gid === 0) return null;
  if (groups.includes(0)) dropped(name);
  return { name, uid, gid, home, groups: [...new Set(groups)].filter((g) => g !== 0) };
}

/** A logger that says each name's dropped group 0 once. */
function droppedOnce(log: (s: string) => void): (name: string) => void {
  const said = new Set<string>();
  return (name) => {
    if (said.has(name) || said.size >= 4096) return;
    said.add(name);
    log(`system accounts: ${name} is a member of group 0; that group is left out of its workers`);
  };
}

/**
 * Parses what `filedeck-id` printed: exactly four lines, each ended by a newline (uid, gid, home, group ids separated by single
 * spaces). Anything else is refused. Exported for the start-up check, which needs root's own answer (uid 0) to prove the helper works.
 */
export function parseIdOutput(stdout: string): { uid: number; gid: number; home: string; groups: number[] } | null {
  if (!stdout.endsWith("\n")) return null;
  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length !== 4) return null;
  const [u, g, home, list] = lines as [string, string, string, string];
  const uid = id(u);
  const gid = id(g);
  if (uid === null || gid === null) return null;
  if (!home.startsWith("/") || home.includes("\0")) return null;
  const groups: number[] = [];
  if (list !== "") {
    for (const part of list.split(" ")) {
      const n = id(part);
      if (n === null) return null;
      groups.push(n);
    }
  }
  return { uid, gid, home, groups };
}

type Run = (name: string) => Promise<{ code: number | null; stdout: string }>;

/**
 * Accounts from the machine's own NSS through the `filedeck-id` host helper (`run`). Null means only "no such account" (exit 2 with
 * no output) or an account that is root (uid 0 or gid 0); every other outcome (another exit code, a killed helper, malformed output, a
 * start that failed) rejects with an error, so that a caller can answer "unavailable" rather than "no account". Answers are kept for
 * `ttlMs` (default 60 s), also "no such account"; errors are not kept. A worker start always asks with `fresh`, so a change of groups is
 * picked up when a worker starts.
 */
export class HostAccounts implements AccountResolver {
  private readonly run: Run;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly dropped: (name: string) => void;
  private readonly cache = new Map<string, { at: number; value: LocalAccount | null }>();
  private static readonly MAX_CACHED = 1024;

  constructor(o: { run: Run; ttlMs?: number; now?: () => number; log?: (s: string) => void }) {
    this.run = o.run;
    this.ttlMs = o.ttlMs ?? 60_000;
    this.now = o.now ?? Date.now;
    this.dropped = droppedOnce(o.log ?? ((s) => console.error(s)));
  }

  async resolve(name: string, fresh = false): Promise<LocalAccount | null> {
    if (!validSystemName(name)) return null;
    const hit = this.cache.get(name);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const r = await this.run(name);
    let value: LocalAccount | null;
    if (r.code === 2 && r.stdout === "") value = null;
    else {
      if (r.code !== 0) throw new Error(`account lookup for ${name} failed: ${r.code === null ? "the helper was stopped" : `exit ${r.code}`}`);
      const p = parseIdOutput(r.stdout);
      if (!p) throw new Error(`account lookup for ${name} failed: the helper's answer is malformed`);
      value = account(name, p.uid, p.gid, p.home, p.groups, this.dropped);
    }
    this.cache.delete(name);
    if (this.cache.size >= HostAccounts.MAX_CACHED) this.cache.delete(this.cache.keys().next().value!); // the oldest answer
    this.cache.set(name, { at: this.now(), value });
    return value;
  }
}

/**
 * Accounts from `<root>/etc/passwd` and `<root>/etc/group` only (no LDAP or SSSD), for a machine where the host helper cannot run:
 * a virtual account's `runAs` then still resolves when it is a local account. The groups are the primary one and every group whose
 * member list names the account. The files are read again on every call (they are small, and this way a change is seen at once). A
 * passwd file that cannot be read rejects; a missing group file means no groups beyond the primary one.
 */
export class FilesAccounts implements AccountResolver {
  private readonly dropped: (name: string) => void;

  constructor(
    private readonly root: string,
    log: (s: string) => void = (s) => console.error(s),
  ) {
    this.dropped = droppedOnce(log);
  }

  async resolve(name: string): Promise<LocalAccount | null> {
    if (!validSystemName(name)) return null;
    // an account file that cannot be read is an error (the caller answers "unavailable"), never "no such account"
    const passwd = await fs.readFile(path.join(this.root, "etc/passwd"), "utf8").catch((e: Error) => {
      throw new Error(`account lookup for ${name} failed: etc/passwd: ${e.message}`);
    });
    let entry: string[] | undefined;
    for (const line of passwd.split("\n")) {
      const f = line.split(":");
      if (f[0] === name) {
        entry = f;
        break;
      }
    }
    if (!entry || entry.length < 7) return null;
    const uid = id(entry[2]!);
    const gid = id(entry[3]!);
    if (uid === null || gid === null) return null;
    const groups = [gid];
    // no group file at all: no groups beyond the primary one; one that exists and cannot be read is an error
    const group = await fs.readFile(path.join(this.root, "etc/group"), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw new Error(`account lookup for ${name} failed: etc/group: ${e.message}`);
    });
    for (const line of group.split("\n")) {
      const f = line.split(":");
      if (f.length < 4) continue;
      const g = id(f[2]!);
      if (g !== null && f[3]!.split(",").includes(name)) groups.push(g);
    }
    const home = entry[5]!;
    if (!home.startsWith("/")) return null;
    return account(name, uid, gid, home, groups, this.dropped);
  }
}

/**
 * The account lookup of an agent with sign-in on. It finds the host helpers in the image and asks `filedeck-id` for root once, inside
 * the machine's root: when that works, accounts come from the machine's NSS and `helpers` says where the helpers are (a later part
 * starts PAM with it). Otherwise only the local files resolve, and the log says why.
 */
export async function makeResolver(cfg: Config, log: (s: string) => void): Promise<{ resolver: AccountResolver; helpers?: { root: string; dir: string } }> {
  const found = await (async (): Promise<string | { dir: string }> => {
    const dir = await hostHelperDir(cfg.hostHelpers);
    if (!dir) return cfg.hostHelpers ? `no filedeck-id in ${cfg.hostHelpers}` : "filedeck-id is not installed";
    try {
      const r = await runHostHelper(cfg.root, dir, "filedeck-id", ["root"]);
      const p = r.code === 0 ? parseIdOutput(r.stdout) : null;
      if (p?.uid === 0) return { dir };
      const detail = r.stderr.trim().split("\n")[0];
      return `filedeck-id root: ${r.code === null ? "killed" : `exit ${r.code}`}${r.code === 0 ? ", unexpected answer" : ""}${detail ? `: ${detail}` : ""}`;
    } catch (e) {
      return (e as Error).message;
    }
  })();
  if (typeof found !== "string") {
    log("system accounts: resolved through the host (NSS)");
    const helpers = { root: cfg.root, dir: found.dir };
    return { resolver: new HostAccounts({ run: (name) => runHostHelper(helpers.root, helpers.dir, "filedeck-id", [name]), log }), helpers };
  }
  log(`system accounts: host lookup unavailable (${found}); only local /etc/passwd accounts resolve, and system sign-in is refused`);
  return { resolver: new FilesAccounts(cfg.root, log) };
}
