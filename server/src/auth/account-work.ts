import { userContext } from "./context.ts";
import type { Identity } from "./identity.ts";

/** An agent call made as whoever the caller runs as (`userContext`): the hub's `agentCall` for a node name. */
export type AgentCall = (node: string, rest: string, init?: RequestInit) => Promise<Response>;

/** How long the hub waits for the agents when an account changes; a machine that has not answered by then is left (one log line). */
export const END_ACCOUNT_WORK_MS = 3_000;

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0] ?? "";

/**
 * Asks each of `nodes` for its jobs (`GET /api/jobs`) and cancels (`POST /api/jobs/<id>/cancel`) every queued or running one that
 * `pick` accepts. The calls go as whoever the caller runs as: it wraps this in `userContext.run` with the identity it wants. A list the
 * agent refuses cancels nothing there (0). A machine that fails or does not answer before `signal` ends counts as "unreachable" and
 * gives one `log(node, reason)` call. Returns the number cancelled per node.
 */
export async function cancelAgentJobs(o: {
  call: AgentCall;
  nodes: string[];
  pick: (job: Record<string, unknown>) => boolean;
  signal: AbortSignal;
  log: (node: string, reason: string) => void;
}): Promise<Record<string, number | "unreachable">> {
  const out: Record<string, number | "unreachable"> = {};
  await Promise.all(
    o.nodes.map(async (node) => {
      try {
        const r = await o.call(node, "/api/jobs", { signal: o.signal });
        if (!r.ok) {
          await r.body?.cancel().catch(() => undefined);
          out[node] = 0;
          return;
        }
        const v = (await r.json()) as { jobs?: unknown };
        const live = (Array.isArray(v?.jobs) ? v.jobs : []).filter(
          (j): j is Record<string, unknown> & { id: string } =>
            !!j && typeof j === "object" && typeof j.id === "string" && (j.state === "queued" || j.state === "running") && o.pick(j),
        );
        await Promise.all(
          live.map(async (j) => {
            const c = await o.call(node, `/api/jobs/${encodeURIComponent(j.id)}/cancel`, { method: "POST", signal: o.signal });
            await c.body?.cancel().catch(() => undefined);
          }),
        );
        out[node] = live.length;
      } catch (e) {
        out[node] = "unreachable";
        o.log(node, firstLine(e));
      }
    }),
  );
  return out;
}

/**
 * The work of an account that changed ends: its hub jobs and compares are cancelled (`ops`, `diffs`), then every live job of it on
 * `nodes`, asked as `id` (the account at its new epoch, so the agents also stop its workers). The agents get at most `timeoutMs`; a
 * machine that does not answer by then gives one log line.
 */
export async function endAccountWork(o: {
  id: Identity;
  nodes: string[];
  ops: { cancelOwner(kind: "sys" | "virt", name: string): number };
  diffs: { cancelOwner(kind: "sys" | "virt", name: string): number };
  call: AgentCall;
  timeoutMs?: number;
  log?: (s: string) => void;
}): Promise<void> {
  const { kind, name } = o.id;
  o.ops.cancelOwner(kind, name);
  o.diffs.cancelOwner(kind, name);
  if (o.nodes.length === 0) return;
  const log = o.log ?? ((s: string) => console.error(s));
  await userContext.run(o.id, () =>
    cancelAgentJobs({
      call: o.call,
      nodes: o.nodes,
      pick: () => true,
      signal: AbortSignal.timeout(o.timeoutMs ?? END_ACCOUNT_WORK_MS),
      log: (node, reason) => log(`account change: the jobs of ${kind}:${name} on ${node} were not cancelled (${reason})`),
    }),
  );
}
