import { isIP } from "node:net";
import type { Config } from "./config.ts";
import { runHostHelper } from "./host-helpers.ts";
import { validSystemName } from "./local-accounts.ts";

/**
 * A system user's password, checked by the machine's own PAM (sign-in on). `filedeck-pam` (server/native/host) runs once per attempt
 * inside the machine's root, like `filedeck-id`, so libpam and its modules never load into this process. The password goes to it
 * on its stdin pipe only: never in its arguments, its environment, a log line or an error. PAM sees the TTY as "filedeck" and the
 * client's address (`address`, the hub's view of who signs in) as PAM_RHOST, so pam_access treats the attempt as a remote login.
 *
 * - `ok`: PAM accepted the password and the account.
 * - `fail`: a wrong password, an account PAM refuses, or a PAM stack that asks more than the one password question.
 * - `unknown`: no such account here.
 * - `refused`: the helper found uid 0 or gid 0 (exit 6); such a name never signs in, and the hub stops.
 * - `unavailable`: PAM cannot be used here (no helper, no library, no service file, a crash or a timeout).
 *
 * At most 4 helpers run at once; a call over that waits for a place, and its time limit counts from the call, so it never waits for long.
 * An attempt that gives up kills its helper; the helper's place comes free when it has exited.
 */
export type PamResult = "ok" | "fail" | "unknown" | "refused" | "unavailable";

/** The helper's exit codes (filedeck-pam.c). */
const RESULTS: Record<number, PamResult> = { 0: "ok", 1: "fail", 2: "fail", 3: "fail", 4: "unknown", 6: "refused" };

export const SECOND_PROMPT_LOG = "pam: the service asked more than one question; only one password prompt is supported";

/** How long one attempt may take (a slow directory server, PAM's own delay after a wrong password) before it counts as unavailable. */
const TIMEOUT_MS = 12_000;

/**
 * Runs the helper once. `signal` aborts when the attempt gives up (its time ran out): the helper must then be killed, and the promise
 * settle only once it has exited, since its place is held until then.
 */
export type PamRun = (name: string, stdin: Buffer, o: { address?: string; signal?: AbortSignal }) => Promise<{ code: number | null; stderr?: string }>;

/**
 * A client address the helper takes for PAM_RHOST: an IPv4 or IPv6 address (`net.isIP`) of hex digits, '.' and ':' only (no zone
 * id), at most 45 characters.
 */
export const validClientAddress = (s: unknown): s is string => typeof s === "string" && /^[0-9A-Fa-f.:]{2,45}$/.test(s) && isIP(s) !== 0;

/** How many helpers may run at once; more calls wait for a place (within their time limit). */
const MAX_RUNNING = 4;

export class HostPam {
  private readonly run: PamRun;
  private readonly log: (s: string) => void;
  private readonly timeoutMs: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(o: { run: PamRun; log?: (s: string) => void; timeoutMs?: number }) {
    this.run = o.run;
    this.log = o.log ?? ((s) => console.error(s));
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** `address`: the client's address, for PAM_RHOST; one that is not valid fails at once, and nothing runs. */
  async check(name: string, password: string, address?: string): Promise<PamResult> {
    if (!validSystemName(name)) return "unknown";
    if (address !== undefined && !validClientAddress(address)) return "fail";
    let timer: NodeJS.Timeout | undefined;
    let r: { code: number | null; stderr?: string };
    // aborted when the attempt gives up: a helper that runs is killed, one that waits never starts
    const giveUp = new AbortController();
    const attempt = (async () => {
      await this.place();
      if (giveUp.signal.aborted) {
        this.leave();
        return { code: null }; // (its time ran out while it waited: it never starts, and the caller has had its answer)
      }
      try {
        // (the place is left when the helper has exited, also after a kill: the runner settles only then)
        return await this.run(name, Buffer.from(password, "utf8"), { ...(address === undefined ? {} : { address }), signal: giveUp.signal });
      } finally {
        this.leave();
      }
    })();
    attempt.catch(() => undefined);
    try {
      r = await Promise.race([
        attempt,
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${this.timeoutMs} ms`)), this.timeoutMs))),
      ]);
    } catch (e) {
      giveUp.abort();
      this.log(`pam: unavailable (${(e as Error)?.message ?? String(e)})`);
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
    const result = r.code === null ? undefined : RESULTS[r.code];
    if (r.code === 3) this.log(SECOND_PROMPT_LOG);
    if (result) return result;
    const detail = (r.stderr ?? "").trim().split("\n")[0];
    this.log(`pam: unavailable (${r.code === null ? "killed" : `exit ${r.code}`}${detail ? `: ${detail}` : ""})`);
    return "unavailable";
  }

  /** A place among the `MAX_RUNNING` helpers that may run at once; the waiting calls get theirs in order as places are left. */
  private place(): Promise<void> {
    if (this.running < MAX_RUNNING) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve)); // (`leave` hands its place on)
  }

  private leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}

/**
 * The machine's PAM through `filedeck-pam` in `helpers.dir` (the image's helper folder), inside `helpers.root`, with the service
 * `cfg.pamService`, and the client's address as its last argument when there is one. It runs as root (pam_unix reads /etc/shadow) with only `CAP_DAC_READ_SEARCH` kept: on some distributions the
 * shadow file has mode 0000, and pam_unix's setuid fallback does not work under no-new-privileges. `runner` is for tests.
 */
export function hostPam(cfg: Config, helpers: { root: string; dir: string }, o: { log?: (s: string) => void; runner?: typeof runHostHelper; timeoutMs?: number } = {}): HostPam {
  const runner = o.runner ?? runHostHelper;
  return new HostPam({
    timeoutMs: o.timeoutMs,
    run: (name, stdin, r) => runner(helpers.root, helpers.dir, "filedeck-pam", [cfg.pamService, name, ...(r.address === undefined ? [] : [r.address])], { stdin, asRoot: true, keepCaps: ["dac_read_search"], allowMetadata: true, timeoutMs: TIMEOUT_MS - 1000, signal: r.signal }),
    log: o.log,
  });
}
