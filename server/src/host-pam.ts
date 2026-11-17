import type { Config } from "./config.ts";
import { runHostHelper } from "./host-helpers.ts";
import { validSystemName } from "./local-accounts.ts";

/**
 * A system user's password, checked by the machine's own PAM (sign-in on). `filedeck-pam` (server/native/host) runs once per attempt
 * inside the machine's root, like `filedeck-id`, so libpam and its modules never load into this process. The password goes to it
 * on its stdin pipe only: never in its arguments, its environment, a log line or an error.
 *
 * - `ok`: PAM accepted the password and the account.
 * - `fail`: a wrong password, an account PAM refuses, or a PAM stack that asks more than the one password question.
 * - `unknown`: no such account here, or one with uid 0 (it never signs in).
 * - `unavailable`: PAM cannot be used here (no helper, no library, no service file, a crash or a timeout).
 */
export type PamResult = "ok" | "fail" | "unknown" | "unavailable";

/** The helper's exit codes (filedeck-pam.c). */
const RESULTS: Record<number, PamResult> = { 0: "ok", 1: "fail", 2: "fail", 3: "fail", 4: "unknown" };

export const SECOND_PROMPT_LOG = "pam: the service asked more than one question; only one password prompt is supported";

/** How long one attempt may take (a slow directory server, PAM's own delay after a wrong password) before it counts as unavailable. */
const TIMEOUT_MS = 12_000;

export type PamRun = (name: string, stdin: Buffer) => Promise<{ code: number | null; stderr?: string }>;

export class HostPam {
  private readonly run: PamRun;
  private readonly log: (s: string) => void;
  private readonly timeoutMs: number;

  constructor(o: { run: PamRun; log?: (s: string) => void; timeoutMs?: number }) {
    this.run = o.run;
    this.log = o.log ?? ((s) => console.error(s));
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  async check(name: string, password: string): Promise<PamResult> {
    if (!validSystemName(name)) return "unknown";
    let timer: NodeJS.Timeout | undefined;
    let r: { code: number | null; stderr?: string };
    try {
      r = await Promise.race([
        this.run(name, Buffer.from(password, "utf8")),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${this.timeoutMs} ms`)), this.timeoutMs))),
      ]);
    } catch (e) {
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
}

/**
 * The machine's PAM through `filedeck-pam` in `helpers.dir` (the image's helper folder), inside `helpers.root`, with the service
 * `cfg.pamService`. It runs as root (pam_unix reads /etc/shadow) with only `CAP_DAC_READ_SEARCH` kept: on some distributions the
 * shadow file has mode 0000, and pam_unix's setuid fallback does not work under no-new-privileges. `runner` is for tests.
 */
export function hostPam(cfg: Config, helpers: { root: string; dir: string }, o: { log?: (s: string) => void; runner?: typeof runHostHelper } = {}): HostPam {
  const runner = o.runner ?? runHostHelper;
  return new HostPam({
    run: (name, stdin) => runner(helpers.root, helpers.dir, "filedeck-pam", [cfg.pamService, name], { stdin, asRoot: true, keepCaps: ["dac_read_search"], allowMetadata: true, timeoutMs: TIMEOUT_MS - 1000 }),
    log: o.log,
  });
}
