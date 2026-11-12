import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/**
 * fetch() for the hub's calls to an agent, without the client's built-in waits (300 s for the response headers and for
 * silence in the body). An agent runs one call for as long as the work takes (a rename or a copy of a huge folder, the hash
 * of a very large file) and the job queue has its own cancel and pause, so a call ends when the agent answers, the caller
 * aborts, or the connection breaks. Keep-alive is on so the short calls of a listing reuse connections.
 */
/**
 * A pooled connection the server has just closed fails the next request with a reset. That race is made rare in two ways: the servers keep an idle connection
 * longer than this (see `SERVER_KEEP_ALIVE_MS`), and this side drops an idle one after `CLIENT_IDLE_MS`, or sooner when the server announces a shorter
 * `Keep-Alive: timeout=` (Node's agent honours the announced value when it is below its own). Neither closes the race completely, so a read is also repeated (below).
 */
export const CLIENT_IDLE_MS = 30_000;
export const SERVER_KEEP_ALIVE_MS = 65_000;
const plain = new http.Agent({ keepAlive: true, timeout: CLIENT_IDLE_MS });
const secure = new https.Agent({ keepAlive: true, timeout: CLIENT_IDLE_MS });

const RESET = new Set(["ECONNRESET", "EPIPE"]);

/**
 * `replay: false` for a GET that has an effect on the agent (the one-use zip ticket): it is never repeated.
 * A request with a body of its own kind is never repeated either; see `agentFetch`.
 */
export type AgentFetchInit = RequestInit & { replay?: boolean };

/**
 * Fetch for the hub's calls to an agent.
 *
 * Only a GET or HEAD is repeated, once, on a new connection, when it fails with a reset on a reused pooled connection before any answer. From this side "the
 * server had already closed the idle connection" and "the server read the request, started the work and the connection was cut" look the same (a write to a
 * socket the peer closed succeeds), so a request that changes something (POST, PUT, DELETE, PATCH) could be carried out twice: it is never repeated, and the
 * caller sees the error. A streamed body cannot be sent again at all, and so it does not use the pool: it gets a connection of its own (a request without a
 * body, which is how the proxy forwards a bodiless POST, uses the pool like a GET).
 */
export async function agentFetch(url: string, init?: AgentFetchInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  try {
    return await agentFetchOnce(url, init, false);
  } catch (e) {
    const err = e as { code?: string; message?: string; reusedSocket?: boolean };
    const reset = RESET.has(err.code ?? "") || err.message === "socket hang up";
    const safe = (method === "GET" || method === "HEAD") && init?.replay !== false && (init?.body === undefined || init.body === null);
    if (safe && reset && err.reusedSocket === true && !init?.signal?.aborted) return agentFetchOnce(url, init, true);
    throw e;
  }
}

function agentFetchOnce(url: string, init: RequestInit | undefined, fresh: boolean): Promise<Response> {
  const u = new URL(url);
  const signal = init?.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body;
    if (typeof body === "string" && headers["content-length"] === undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const lib = u.protocol === "https:" ? https : http;
    // a streamed body cannot be sent twice, so it never rides a pooled connection that may have just been closed: it gets a connection of its own
    const streamed = body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array);
    const pool = fresh || streamed ? false : u.protocol === "https:" ? secure : plain;
    const req = lib.request(u, { method: init?.method ?? "GET", headers, agent: pool }, (res) => {
      signal?.removeEventListener("abort", onAbort);
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, x);
      const status = res.statusCode ?? 502;
      const noBody = status === 204 || status === 205 || status === 304 || req.method === "HEAD";
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: h }));
      if (signal) {
        const cut = () => res.destroy(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
        if (signal.aborted) cut();
        else signal.addEventListener("abort", cut, { once: true });
        res.once("close", () => signal.removeEventListener("abort", cut));
      }
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    // the agent's idle timeout belongs to a connection waiting in the pool; a call in progress may stay silent as long as the work takes
    req.on("socket", (socket) => socket.setTimeout(0));
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      if (!signal?.aborted && req.reusedSocket) (e as { reusedSocket?: boolean }).reusedSocket = true;
      reject(signal?.aborted ? (signal.reason ?? e) : e);
    });
    if (body === undefined || body === null) req.end();
    else if (typeof body === "string" || body instanceof Uint8Array) req.end(body);
    else if (body instanceof ReadableStream) {
      const src = Readable.fromWeb(body as never);
      src.on("error", (e) => req.destroy(e));
      src.pipe(req);
    } else {
      req.destroy(new TypeError("unsupported request body"));
    }
  });
}
