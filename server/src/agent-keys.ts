import path from "node:path";
import { parseLoginMessage, parsePublicKey, verifyLogin } from "./auth/sshkey.ts";
import { signInAccount, validSystemName, type AccountResolver, type LocalAccount } from "./local-accounts.ts";
import { spawnSandboxed } from "./sandbox.ts";
import type { ChildProcess } from "node:child_process";

/**
 * A system user's SSH key sign-in (sign-in on): the key must be listed in the user's own `<home>/.ssh/authorized_keys`, without options,
 * and the signature must be good. Only that one file counts: not `authorized_keys2`, and not sshd's `AuthorizedKeysFile`.
 *
 * The file is read by the machine's own `/bin/cat`, started through the launcher inside the machine's root (`--chroot`) as the user:
 * their uid, gid and groups, no capabilities, no-new-privileges and the launcher's seccomp filter. So a link in the home (also an absolute
 * one, such as `/etc/ssh/keys/alice`) resolves in the machine's root with the user's own rights, and root never opens or follows anything
 * in the user's home. A file the user cannot read, a missing file, a missing or odd `cat`, more than 256 KiB, no end within 5 seconds (a
 * FIFO, a hung network home) or output that is not UTF-8 gives `fail`, and one log line with the reason (never the key or the signature).
 */
export type KeyResult = "ok" | "fail" | "unknown" | "refused";

/** The most of `authorized_keys` that is read; a larger file is not used at all. */
export const MAX_AUTHORIZED_KEYS = 256 * 1024;
const TIMEOUT_MS = 5_000;
/**
 * Readers that may run at once. A place is given back only when the reader's process has closed, not when its answer is sent: a reader
 * stuck in the kernel after its kill (a hung NFS home in uninterruptible sleep) keeps its place, so stuck readers cannot pile up. The
 * cost: four such readers stop key sign-in on this machine (every attempt answers `unavailable`) until the server answers again.
 */
export const MAX_READERS = 4;
/** One line of a reader's error output for a log line: the first line, control characters made spaces, at most 200 characters. */
export const logLine = (s: string): string => (s.split("\n")[0] ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads `file` (a path in `root`, the machine's root) as `account`, with the machine's `/bin/cat` run inside `root` through the launcher.
 * Resolves with the text; rejects with the reason on a non-zero exit, a start that failed, more than `maxBytes`, no end within
 * `o.timeoutMs` (the reader is then killed) or output that is not UTF-8. Never runs as root. `o.closed` is called once, when the reader's
 * process has closed (or never started), which can be after the answer.
 */
export async function readAsUser(root: string, account: LocalAccount, file: string, maxBytes: number, o: { timeoutMs: number; closed: () => void }): Promise<string> {
  let gone = false;
  const closed = () => {
    if (gone) return;
    gone = true;
    o.closed();
  };
  let child: ChildProcess;
  try {
    if (account.uid === 0 || account.gid === 0 || account.groups.includes(0)) throw new Error("refusing to read as root");
    if (!path.isAbsolute(root) || !path.isAbsolute(file) || file.includes("\0")) throw new Error(`not an absolute path: ${file}`);
    child = await spawnSandboxed("/bin/cat", ["--", file], {
      chroot: root,
      landlock: false,
      uid: account.uid,
      gid: account.gid,
      groups: [...new Set([account.gid, ...account.groups])], // (the launcher sets exactly these; a list that is too long refuses the start)
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    closed();
    throw e;
  }
  return new Promise<string>((resolve, reject) => {
    const out: Buffer[] = [];
    let len = 0;
    let err = "";
    let done = false;
    const finish = (e: Error | null, text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) {
        child.kill("SIGKILL");
        reject(e);
      } else resolve(text!);
    };
    // (answered at once: a reader stuck in the kernel may take a while to go after the kill)
    const timer = setTimeout(() => finish(new Error(`no end within the ${TIMEOUT_MS / 1000} s limit`)), Math.max(0, o.timeoutMs));
    child.stdout!.on("data", (d: Buffer) => {
      len += d.length;
      if (len > maxBytes) return finish(new Error(`larger than ${maxBytes / 1024} KiB`));
      out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < 1024) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (child.pid === undefined) closed(); // (never started: no close follows)
      finish(e);
    });
    child.on("close", (code, signal) => {
      closed();
      if (code !== 0) {
        const detail = logLine(err.trim());
        return finish(new Error(`${code === null ? `stopped by ${signal}` : `exit ${code}`}${detail ? `: ${detail}` : ""}`));
      }
      let text: string;
      try {
        text = utf8.decode(Buffer.concat(out));
      } catch {
        return finish(new Error("not valid UTF-8"));
      }
      finish(null, text);
    });
  });
}

/** Is `publicKey` listed in `authorizedKeys`? Only lines that are a key without options count (`parsePublicKey` refuses options). */
export function keyListed(authorizedKeys: string, publicKey: string): boolean {
  const want = parsePublicKey(publicKey);
  if (!want) return false;
  for (const line of authorizedKeys.split("\n")) {
    const k = parsePublicKey(line);
    if (k && k.type === want.type && k.blob.equals(want.blob)) return true;
  }
  return false;
}

export class KeyCheck {
  private readonly root: string;
  private readonly accounts: AccountResolver;
  private readonly read: typeof readAsUser;
  private readonly log: (s: string) => void;
  private readonly timeoutMs: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(o: { root: string; accounts: AccountResolver; read?: typeof readAsUser; log?: (s: string) => void; timeoutMs?: number }) {
    this.root = o.root;
    this.accounts = o.accounts;
    this.read = o.read ?? readAsUser;
    this.log = o.log ?? ((s) => console.error(s));
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * `unknown` for a name that is not a system account here, `refused` for one with uid 0, gid 0 or group 0 (nothing is read); `ok` when `message` is
   * a login message for this very name, its signature is good and the key is listed without options; else `fail`. Rejects when the
   * account lookup fails, or when no reader place comes free within the time limit (5 s from the call): the caller answers "unavailable".
   */
  async check(name: string, publicKey: string, message: Buffer, signature: Buffer): Promise<KeyResult> {
    const deadline = Date.now() + this.timeoutMs;
    if (!validSystemName(name)) return "unknown";
    const account = await signInAccount(this.accounts, name);
    if (account === "root") return "refused";
    if (!account) return "unknown";
    // only a login message for this name counts: any other bytes the key signed (a signed commit, say) must not sign in
    const login = parseLoginMessage(message);
    if (!login || login.name !== name) return "fail";
    const pub = parsePublicKey(publicKey);
    if (!pub || !verifyLogin(pub, message, signature)) return "fail"; // (no file is read for a key or signature that cannot pass)
    if (!path.isAbsolute(account.home)) {
      this.log(`keys: the home of ${name} is not an absolute path`);
      return "fail";
    }
    if (!(await this.place(deadline))) throw new Error(`keys: no reader free within ${this.timeoutMs / 1000} s`);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      this.leave();
    };
    let text: string;
    try {
      text = await this.read(this.root, account, path.posix.join(account.home, ".ssh/authorized_keys"), MAX_AUTHORIZED_KEYS, { timeoutMs: deadline - Date.now(), closed: leave });
    } catch (e) {
      this.log(`keys: the authorized_keys of ${name} could not be read (${(e as Error)?.message ?? String(e)})`);
      return "fail";
    }
    return keyListed(text, publicKey) ? "ok" : "fail";
  }

  /** A reader place, waiting in order until `deadline`; false when the time ran out first. */
  private place(deadline: number): Promise<boolean> {
    if (this.running < MAX_READERS) {
      this.running++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const go = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(false);
      }, Math.max(0, deadline - Date.now()));
      this.waiting.push(go);
    });
  }

  /** Gives a place back (its reader's process has closed); the first waiting call takes it over. */
  private leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
