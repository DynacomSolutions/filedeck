import net from "node:net";
import { Mux } from "../src/worker-proto.ts";

/**
 * A stand-in worker for the pool tests (worker-pool.test.ts): it speaks the worker protocol on descriptor 3 like `worker.ts`, but its
 * answers are made for the test. The start-up message chooses what it does: `{ fail: true }` exits 1 with a `worker:` line, as a worker
 * whose start fails does. Requests:
 *   /jobs?n=K[&ms=T] sets the number of live jobs it reports (`x-filedeck-jobs`, on every answer); with `ms`, back to 0 after T ms
 *   /api/jobs       the job list (empty)
 *   /root?path=P    asks the root process for P and answers with its status and text
 *   /stderr?n=K     writes K lines to stderr, then answers
 */

let jobs = 0;
const sock = new net.Socket({ fd: 3, readable: true, writable: true });
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { "x-filedeck-jobs": String(jobs) } });
const mux: Mux = new Mux(sock, "worker", {
  onRequest: async (req): Promise<Response> => {
    const u = new URL(req.url);
    if (u.pathname === "/jobs") {
      jobs = Number(u.searchParams.get("n"));
      const ms = u.searchParams.get("ms");
      if (ms) setTimeout(() => (jobs = 0), Number(ms)); // the jobs end by themselves, as real ones do
      return answer({ ok: true });
    }
    if (u.pathname === "/api/jobs") return answer({ jobs: [] });
    if (u.pathname === "/root") {
      const r = await mux.fetch(new Request(`http://root${u.searchParams.get("path")}`));
      return answer({ status: r.status, text: await r.text() });
    }
    if (u.pathname === "/stderr") {
      for (let i = 0; i < Number(u.searchParams.get("n")); i++) process.stderr.write(`line ${i}\n`);
      return answer({ ok: true });
    }
    return answer({ error: "not found" }, 404);
  },
});
mux.onHello((init) => {
  if ((init as { fail?: boolean }).fail) {
    process.stderr.write("worker: Error: start-up failed on purpose\n");
    process.exit(1);
  }
  mux.ready();
});
await mux.closed;
process.exit(0);
