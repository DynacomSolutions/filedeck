import type { Config } from "../config.ts";
import type { Identity } from "../auth/identity.ts";
import { runAs } from "../auth/context.ts";
import type { Accounts } from "../auth/store.ts";
import { identityFor } from "../auth/routes.ts";

/** An error a tool reports to its client as a result with `isError`. The message is safe to show. */
export class ToolError extends Error {}

/**
 * Calls into the hub app itself, as the account of the MCP token. Every read goes through the same routes, access checks and agent calls as a
 * browser or `filedeck du` request, so no rule is written twice: a node the account may not use is refused by the hub, as it is for the account
 * anywhere else. Only GET is made. With sign-in on, the request runs as the account's identity (the gate then lets it pass, as it does for the API
 * token). With sign-in off there is no account, and the request is as open as the hub is without sign-in.
 */
export interface HubCaller {
  /** The identity of the account now, or why there is none (sign-in on). Undefined: sign-in is off. */
  identity(): Identity | { error: string } | undefined;
  /** A GET whose answer is read as JSON (an empty body gives `body: undefined`). */
  json(path: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
  /** A GET whose answer is a stream; the caller reads or cancels it. */
  stream(path: string, signal?: AbortSignal): Promise<Response>;
}

export interface HubCallerOptions {
  cfg: Config;
  fetch: (req: Request) => Response | Promise<Response>;
  accounts?: Accounts;
  /** the account the calls run as (sign-in on) */
  account?: string;
  /** longest wait for one answer head */
  timeoutMs?: number;
}

export function makeHubCaller(o: HubCallerOptions): HubCaller {
  const host = o.cfg.allowedHosts[0] ?? "mcp.internal";
  const identity = () => {
    if (!o.cfg.auth || !o.accounts) return undefined;
    const name = o.account;
    if (!name) return { error: "sign-in is on: name an account on the grant, or set FILEDECK_MCP_ACCOUNT" };
    if (name === "root") return { error: "the account may not be root" };
    return identityFor(o.cfg, o.accounts, name);
  };
  const send = async (path: string, accept: string, signal: AbortSignal | undefined): Promise<Response> => {
    const id = identity();
    if (id && "error" in id) throw new ToolError(`forbidden: ${id.error}`);
    const req = new Request(`http://${host}${path}`, {
      method: "GET",
      headers: { host, accept },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(o.timeoutMs ?? 20_000)]),
    });
    return id ? runAs(id, () => Promise.resolve(o.fetch(req))) : Promise.resolve(o.fetch(req));
  };
  return {
    identity,
    async json(path, signal) {
      const res = await send(path, "application/json", signal);
      const text = await res.text();
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: text.slice(0, 200) };
        }
      }
      return { status: res.status, body };
    },
    stream: (path, signal) => send(path, "application/x-ndjson", signal),
  };
}

/** What a failed hub answer means to a client. */
export function failure(what: string, status: number, body: unknown): ToolError {
  const msg = (body as { error?: unknown } | undefined)?.error;
  const text = typeof msg === "string" ? msg : `HTTP ${status}`;
  if (status === 404) return new ToolError(`not found: ${what}${typeof msg === "string" ? ` (${msg})` : ""}`);
  if (status === 403 || status === 401) return new ToolError(`forbidden: ${what} (${text})`);
  if (status === 502 || status === 503 || status === 504) return new ToolError(`unavailable: ${what} (${text})`);
  return new ToolError(`${what} failed (${text})`);
}
