import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/**
 * fetch() for the hub's calls to an agent, without the client's built-in waits (300 s for the response headers and for
 * silence in the body). An agent runs one call for as long as the work takes (a rename or a copy of a huge folder, the hash
 * of a very large file) and the job queue has its own cancel and pause, so a call ends when the agent answers, the caller
 * aborts, or the connection breaks. Keep-alive is on so the short calls of a listing reuse connections.
 */
const plain = new http.Agent({ keepAlive: true });
const secure = new https.Agent({ keepAlive: true });

export function agentFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const signal = init?.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body;
    if (typeof body === "string" && headers["content-length"] === undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: init?.method ?? "GET", headers, agent: u.protocol === "https:" ? secure : plain }, (res) => {
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
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
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
