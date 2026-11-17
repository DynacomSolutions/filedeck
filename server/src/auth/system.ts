import { validSystemName } from "../local-accounts.ts";
import type { SystemAuth } from "./routes.ts";

/** The most one agent may take to answer a sign-in call (connect, head and body). */
export const CALL_TIMEOUT_MS = 15_000;
/**
 * The most one system sign-in may take over all the agents it asks. A node that does not answer within its own limit is passed over,
 * but a hub whose nodes are all slow still answers within this time (plus the hub's own work): the person is not kept waiting
 * for minutes, and the limiter keeps the count of what these attempts cost.
 */
export const TOTAL_MS = 20_000;
/** The most an account lookup (`exists`) may take; no answer within it is "not known". */
export const EXISTS_TIMEOUT_MS = 2_000;
/** A node is not asked with less time than this left (timers can fire a little early, which would leave a sliver). */
const MIN_CALL_MS = 50;

/**
 * Posts `body` (JSON) to `path` on the agent of `node`, with the agent token and no user; `signal` ends the call. It rejects when the
 * node is unreachable or not known.
 */
export type SignInCall = (node: string, path: string, body: unknown, signal?: AbortSignal) => Promise<Response>;

/**
 * System sign-in through the agents (hub, sign-in on). The agents are asked one at a time in the sign-in order (`FILEDECK_AUTH_NODES`,
 * else the order of `NODES`): `ok` signs in, `fail` (a wrong password, or a key that is not listed) and `refused` (the name has uid 0, gid
 * 0 or group 0 on that machine) end the attempt, and every other
 * outcome goes on to the next node: `unknown` (no such account there), `unavailable`, an answer that is
 * not 200, a body that does not parse, no answer within `CALL_TIMEOUT_MS`, or a node that cannot be reached. All nodes passed over, or
 * `TOTAL_MS` gone: no.
 *
 * Only the name and what the agent route needs go to an agent; the caller (hub.ts) sends them with the agent token and nothing of the
 * client's. Nothing secret is logged.
 */
export class AgentSystemAuth implements SystemAuth {
  private readonly nodes: string[];
  private readonly call: SignInCall;
  private readonly callTimeoutMs: number;
  private readonly totalMs: number;
  private readonly existsTimeoutMs: number;
  private readonly log: (s: string) => void;

  constructor(o: { nodes: string[]; call: SignInCall; callTimeoutMs?: number; totalMs?: number; existsTimeoutMs?: number; log?: (s: string) => void }) {
    this.nodes = [...o.nodes];
    this.call = o.call;
    this.callTimeoutMs = o.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.totalMs = o.totalMs ?? TOTAL_MS;
    this.existsTimeoutMs = o.existsTimeoutMs ?? EXISTS_TIMEOUT_MS;
    this.log = o.log ?? ((s) => console.error(s));
  }

  password(name: string, pw: string): Promise<boolean> {
    return this.ask(name, "/api/auth/password", { name, password: pw });
  }

  /** `msg` is the login message the hub built itself (its own id, the name and the challenge it issued and took), never client bytes. */
  key(name: string, pub: string, msg: Buffer, sig: Buffer): Promise<boolean> {
    return this.ask(name, "/api/auth/key", { name, publicKey: pub, message: msg.toString("base64"), signature: sig.toString("base64") });
  }

  /** Whether `node` has a system account `name` (never one with uid 0); undefined when it does not answer within `EXISTS_TIMEOUT_MS`. */
  async exists(node: string, name: string): Promise<boolean | undefined> {
    if (!validSystemName(name)) return false;
    const v = await this.answer(node, "/api/auth/lookup", { name }, this.existsTimeoutMs);
    if (v.ok) {
      const e = (v.body as { exists?: unknown } | null)?.exists;
      if (typeof e === "boolean") return e;
    }
    return undefined;
  }

  private async ask(name: string, path: string, body: unknown): Promise<boolean> {
    if (!validSystemName(name)) return false; // (no agent could know it: the agents take only valid names)
    const end = performance.now() + this.totalMs;
    for (const node of this.nodes) {
      const left = end - performance.now();
      if (left < MIN_CALL_MS) {
        this.log(`system sign-in: no answer within ${this.totalMs / 1000} s in all; the nodes after ${node} were not asked`);
        return false;
      }
      const v = await this.answer(node, path, body, Math.min(this.callTimeoutMs, left));
      const result = v.ok ? (v.body as { result?: unknown } | null)?.result : undefined;
      if (result === "ok") return true;
      // (refused: the name is root on that machine, uid 0, gid 0 or group 0; it never signs in, so the search ends as for a wrong password)
      if (result === "fail" || result === "refused") return false;
      if (result === "unknown" || result === "unavailable") continue;
      this.log(`system sign-in: node ${node} passed over (${v.ok ? "an answer that is not a result" : v.why})`);
    }
    return false;
  }

  /** The parsed 200 answer of one call, or why there is none. The time limit covers the connection, the head and the whole body. */
  private async answer(node: string, path: string, body: unknown, ms: number): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ ok: false; why: string }>((res) => {
      timer = setTimeout(() => {
        ac.abort(new Error("timeout"));
        res({ ok: false, why: `no answer within ${Math.round(ms) / 1000} s` });
      }, ms);
    });
    const got = (async (): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> => {
      const r = await this.call(node, path, body, ac.signal);
      if (r.status !== 200) {
        await r.body?.cancel().catch(() => undefined);
        return { ok: false, why: `status ${r.status}` };
      }
      try {
        return { ok: true, body: JSON.parse(await r.text()) as unknown };
      } catch {
        return { ok: false, why: "a body that does not parse" };
      }
    })().catch((e: unknown): { ok: false; why: string } => ({ ok: false, why: `unreachable: ${String((e as Error)?.message ?? e).split("\n")[0]?.slice(0, 120)}` }));
    try {
      return await Promise.race([got, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
