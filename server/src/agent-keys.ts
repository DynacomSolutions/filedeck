import path from "node:path";
import { parsePublicKey, verifyLogin } from "./auth/sshkey.ts";
import { validSystemName, type AccountResolver, type LocalAccount } from "./local-accounts.ts";
import { spawnSandboxed } from "./sandbox.ts";

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
export type KeyResult = "ok" | "fail" | "unknown";

/** The most of `authorized_keys` that is read; a larger file is not used at all. */
export const MAX_AUTHORIZED_KEYS = 256 * 1024;
const TIMEOUT_MS = 5_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads `file` (a path in `root`, the machine's root) as `account`, with the machine's `/bin/cat` run inside `root` through the launcher.
 * Resolves with the text; rejects with the reason on a non-zero exit, a start that failed, more than `maxBytes`, no end within 5 seconds
 * (the reader is then killed) or output that is not UTF-8. Never runs as root.
 */
export async function readAsUser(root: string, account: LocalAccount, file: string, maxBytes: number): Promise<string> {
  if (account.uid === 0 || account.gid === 0 || account.groups.includes(0)) throw new Error("refusing to read as root");
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || file.includes("\0")) throw new Error(`not an absolute path: ${file}`);
  const child = await spawnSandboxed("/bin/cat", ["--", file], {
    chroot: root,
    landlock: false,
    uid: account.uid,
    gid: account.gid,
    groups: [...new Set([account.gid, ...account.groups])], // (the launcher sets exactly these; a list that is too long refuses the start)
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    const timer = setTimeout(() => finish(new Error(`no end within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    child.stdout!.on("data", (d: Buffer) => {
      len += d.length;
      if (len > maxBytes) return finish(new Error(`larger than ${maxBytes / 1024} KiB`));
      out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < 1024) err += d.toString("utf8");
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const detail = err.trim().split("\n")[0]!.slice(0, 200);
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

  constructor(o: { root: string; accounts: AccountResolver; read?: typeof readAsUser; log?: (s: string) => void }) {
    this.root = o.root;
    this.accounts = o.accounts;
    this.read = o.read ?? readAsUser;
    this.log = o.log ?? ((s) => console.error(s));
  }

  /**
   * `unknown` for a name that is not a system account here or has uid or gid 0 (nothing is read); `ok` when the key is listed without
   * options and the signature over `message` is good; else `fail`. Rejects only when the account lookup fails (the caller answers
   * "unavailable").
   */
  async check(name: string, publicKey: string, message: Buffer, signature: Buffer): Promise<KeyResult> {
    if (!validSystemName(name)) return "unknown";
    const account = await this.accounts.resolve(name);
    if (!account || account.uid === 0 || account.gid === 0) return "unknown";
    const pub = parsePublicKey(publicKey);
    if (!pub || !verifyLogin(pub, message, signature)) return "fail"; // (no file is read for a key or signature that cannot pass)
    if (!path.isAbsolute(account.home)) return "fail";
    let text: string;
    try {
      text = await this.read(this.root, account, path.posix.join(account.home, ".ssh/authorized_keys"), MAX_AUTHORIZED_KEYS);
    } catch (e) {
      this.log(`keys: the authorized_keys of ${name} could not be read (${(e as Error)?.message ?? String(e)})`);
      return "fail";
    }
    return keyListed(text, publicKey) ? "ok" : "fail";
  }
}
