import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, humanSize, blocks, run, type RunIo, UsageError } from "../src/du-cli.ts";

test("flags: combined short flags, attached depth, long forms, operands", () => {
  const o = parseArgs(["-sh", "--apparent-size", "--fresh", "--json", "a:/x", "b:/y z"]);
  assert.deepEqual([o.summarize, o.human, o.apparent, o.fresh, o.json, o.depth], [true, true, true, true, true, 0]);
  assert.deepEqual(o.targets, [{ node: "a", path: "/x" }, { node: "b", path: "/y z" }]);
  assert.equal(parseArgs(["-d2", "a:/"]).depth, 2);
  assert.equal(parseArgs(["-d", "3", "-a", "a:/"]).depth, 3);
  assert.equal(parseArgs(["--max-depth=1", "a:/"]).depth, 1);
  assert.equal(parseArgs(["--max-depth", "4", "--all", "a:/"]).all, true);
});

test("flags: errors", () => {
  for (const bad of [[], ["a"], ["-x", "a:/"], ["-d", "x", "a:/"], ["--nope", "a:/"], ["-s", "-d", "2", "a:/"], ["-d", "65", "a:/"]]) {
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad));
  }
});

test("humanSize rounds up like GNU du -h", () => {
  const cases: [number, string][] = [
    [0, "0"], [500, "500"], [1023, "1023"], [1024, "1.0K"], [1025, "1.1K"], [1536, "1.5K"], [10239, "10K"], [10240, "10K"], [10241, "11K"],
    [1024 * 1024, "1.0M"], [1024 * 1024 + 1, "1.1M"], [1024 ** 2 * 1023 + 1, "1.0G"], [1024 ** 3 * 5, "5.0G"], [1024 ** 4, "1.0T"],
  ];
  for (const [n, s] of cases) assert.equal(humanSize(n), s, String(n));
  assert.equal(blocks(1), 1);
  assert.equal(blocks(1025), 2);
  assert.equal(blocks(0), 0);
});

const E = (path: string, diskBytes: number, bytes = diskBytes, type = "dir") => ({ path, type, bytes, diskBytes });
function harness(responses: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: RunIo = {
    fetch: (async (u: string, init?: RequestInit) => {
      calls.push(u);
      assert.equal((init?.headers as Record<string, string>)["x-filedeck-token"], "tok");
      assert.equal((init?.headers as Record<string, string>).authorization, undefined);
      return responses(u);
    }) as never,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    sleep: async () => undefined,
    now: () => 10_000_000,
  };
  return { io, calls, out, err };
}
const env = { FILEDECK_URL: "https://hub.example/", FILEDECK_TOKEN: "tok" };
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

test("output: children before parent, 1K blocks, apparent size, -h, node prefix", async () => {
  const entries = [E("/d", 4096 + 100, 3000), E("/d/b", 2048, 10), E("/d/a", 1, 1), E("/d/a/x", 1025, 5), E("/d/f", 7, 7, "file")];
  const h = harness(() => j({ path: "/d", entries, cached: false, truncated: false, watched: false }));
  assert.equal(await run(["-a", "n:/d"], env, h.io), 0);
  assert.equal(h.out.join(""), "2\tn:/d/a/x\n1\tn:/d/a\n2\tn:/d/b\n1\tn:/d/f\n5\tn:/d\n");
  assert.match(h.calls[0]!, /^https:\/\/hub\.example\/api\/nodes\/n\/api\/du\?path=%2Fd&depth=64&all=1$/);
  const h2 = harness(() => j({ path: "/d", entries: [E("/d", 4196, 3000)], cached: false, truncated: false, watched: false }));
  await run(["-sh", "--apparent-size", "--fresh", "n:/d"], env, h2.io);
  assert.equal(h2.out.join(""), "3.0K\tn:/d\n");
  assert.match(h2.calls[0]!, /depth=0&fresh=1$/);
});

test("-d N is sent as depth", async () => {
  const h = harness(() => j({ path: "/", entries: [E("/", 1)], cached: false, truncated: false, watched: false }));
  await run(["-d", "2", "n:/"], env, h.io);
  assert.match(h.calls[0]!, /depth=2/);
});

test("202 polls the job with progress on stderr, then repeats the request without a cache note", async () => {
  let polls = 0;
  const h = harness((u) => {
    if (u.includes("/jobs/J1")) return j(++polls < 3 ? { state: "running", progress: { entries: 5, totalEntries: 0, bytes: 2048, current: "/d" } } : { state: "done" });
    return h.calls.filter((c) => c.includes("/du?")).length === 1 ? j({ jobId: "J1", state: "running" }, 202) : j({ path: "/d", entries: [E("/d", 1024)], cached: true, truncated: false, watched: false });
  });
  assert.equal(await run(["-s", "n:/d"], env, h.io), 0);
  assert.equal(h.out.join(""), "1\tn:/d\n");
  assert.equal(h.err.filter((l) => l.includes("running, 5 entries, 2.0K")).length, 2);
  assert.ok(!h.err.join("").includes("stored sizes"));
});

test("cached answer says so on stderr; truncated warns", async () => {
  const h = harness(() => j({ path: "/d", entries: [{ ...E("/d", 1024), scannedAt: 10_000_000 - 5 * 60_000 }], cached: true, truncated: true, watched: false }));
  assert.equal(await run(["n:/d"], env, h.io), 0);
  const e = h.err.join("");
  assert.match(e, /answered from stored sizes \(oldest folder scanned 5 min ago\); changes since may be missing, use --fresh/);
  assert.match(e, /partial/);
});

test("errors: failed job, HTTP error, 401, network, missing env; other targets still run", async () => {
  const h = harness((u) => (u.includes("path=%2Fbad") ? j({ error: "not a directory" }, 400) : j({ path: "/ok", entries: [E("/ok", 1)], cached: false, truncated: false, watched: false })));
  assert.equal(await run(["-s", "n:/bad", "n:/ok"], env, h.io), 1);
  assert.equal(h.out.join(""), "1\tn:/ok\n");
  assert.match(h.err.join(""), /n:\/bad: HTTP 400: not a directory/);
  const u = harness(() => j({ error: "unauthorized" }, 401));
  assert.equal(await run(["n:/"], env, u.io), 1);
  assert.match(u.err.join(""), /rejected FILEDECK_TOKEN/);
  const f = harness((x) => (x.includes("/jobs/") ? j({ state: "failed", error: "boom" }) : j({ jobId: "J", state: "queued" }, 202)));
  assert.equal(await run(["n:/"], env, f.io), 1);
  assert.match(f.err.join(""), /scan failed: boom/);
  const n = harness(() => Promise.reject(new Error("ECONNREFUSED")));
  let nt = 0;
  n.io.now = () => (nt += 40_000);
  assert.equal(await run(["--timeout", "100", "n:/"], env, n.io), 1);
  assert.match(n.err.join(""), /timed out after 100 s \(cannot reach https:\/\/hub\.example: ECONNREFUSED\)/);
  const m = harness(() => j({}));
  assert.equal(await run(["n:/"], {}, m.io), 2);
  assert.equal(await run(["--bogus", "n:/"], env, m.io), 2);
});

test("--json prints the answer with the node", async () => {
  const h = harness(() => j({ path: "/", entries: [E("/", 1)], cached: false, truncated: false, watched: false }));
  await run(["--json", "n:/"], env, h.io);
  assert.equal(JSON.parse(h.out.join("")).node, "n");
});

test("--timeout gives up while polling", async () => {
  let t = 0;
  const h = harness((u) => (u.includes("/jobs/") ? j({ state: "running" }) : j({ jobId: "J", state: "running" }, 202)));
  h.io.now = () => (t += 40_000);
  assert.equal(await run(["--timeout", "100", "n:/"], env, h.io), 1);
  assert.match(h.err.join(""), /timed out after 100 s/);
  assert.equal(parseArgs(["--timeout=5", "n:/"]).timeout, 5);
  assert.throws(() => parseArgs(["--timeout", "0", "n:/"]), UsageError);
});

const ok = () => j({ path: "/", entries: [E("/", 1)], cached: false, truncated: false, watched: false });

test("transient 503 on the first request and on a poll is waited out, one notice per streak", async () => {
  const seq = [503, 503, "202", "job503", "job503", "jobdone", "ok"];
  const sleeps: number[] = [];
  const h = harness(() => {
    const s = seq.shift();
    if (s === 503 || s === "job503") return j({}, 503);
    if (s === "202") return j({ jobId: "J", state: "queued" }, 202);
    return s === "jobdone" ? j({ state: "done" }) : ok();
  });
  h.io.sleep = async (ms) => void sleeps.push(ms);
  assert.equal(await run(["n:/"], env, h.io), 0);
  assert.equal(h.out.join(""), "1\tn:/\n");
  assert.deepEqual(sleeps, [1000, 2000, 1000, 2000]);
  assert.equal(h.err.join("").match(/HTTP 503, retrying/g)?.length, 2);
});

test("network error mid-poll is retried", async () => {
  let polls = 0;
  const h = harness((u) => {
    if (!u.includes("/jobs/")) return polls < 2 ? j({ jobId: "J", state: "queued" }, 202) : ok();
    if (polls++ === 0) return Promise.reject(new Error("ECONNRESET"));
    return j({ state: "done" });
  });
  assert.equal(await run(["n:/"], env, h.io), 0);
  assert.match(h.err.join(""), /cannot reach .*ECONNRESET, retrying/);
});

test("404 on a poll re-requests du once; a second 404 fails", async () => {
  let dus = 0;
  const h = harness((u) => {
    if (!u.includes("/jobs/")) return ++dus < 3 ? j({ jobId: `J${dus}`, state: "queued" }, 202) : ok();
    return u.endsWith("/J1") ? j({}, 404) : j({ state: "done" });
  });
  assert.equal(await run(["n:/"], env, h.io), 0);
  assert.equal(dus, 3);
  const g = harness((u) => (u.includes("/jobs/") ? j({}, 404) : j({ jobId: "J", state: "queued" }, 202)));
  assert.equal(await run(["n:/"], env, g.io), 1);
  assert.match(g.err.join(""), /job J: HTTP 404/);
});

test("500 still fails at once; 503 past the deadline times out", async () => {
  const a = harness(() => j({ error: "boom" }, 500));
  assert.equal(await run(["n:/"], env, a.io), 1);
  assert.match(a.err.join(""), /HTTP 500: boom/);
  const b = harness((u) => (u.includes("/jobs/") ? j({}, 503) : j({ jobId: "J", state: "queued" }, 202)));
  let t = 0;
  b.io.now = () => (t += 40_000);
  assert.equal(await run(["--timeout", "100", "n:/"], env, b.io), 1);
  assert.match(b.err.join(""), /timed out after 100 s/);
});
