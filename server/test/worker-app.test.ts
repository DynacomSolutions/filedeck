import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig, workerConfig } from "../src/config.ts";
import { createWorkerApp, type WorkerInit } from "../src/worker.ts";
import { Mux } from "../src/worker-proto.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tree(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-worker-app-")));
  dirs.push(tmp);
  fs.writeFileSync(path.join(tmp, "a.txt"), "alpha\n");
  fs.mkdirSync(path.join(tmp, "sub"));
  return tmp;
}

test("worker app routes", async () => {
  const tmp = tree();
  const app = createWorkerApp({ ...loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), worker: true });
  try {
    const list = await app.request("/api/fs/list?path=/");
    assert.equal(list.status, 200);
    assert.ok(((await list.json()) as { entries: { name: string }[] }).entries.some((e) => e.name === "a.txt"));
    // no socket behind the request: the client key must not need one
    const search = await app.request("/api/fs/search?path=/&q=a");
    assert.equal(search.status, 200);
    await search.text();
    assert.equal((await app.request("/api/jobs")).status, 200); // the worker's own (in-memory) jobs
    // what stays in the root process
    assert.equal((await app.request("/api/du?path=/")).status, 404);
    assert.equal((await app.request("/api/jobs/size", { method: "POST", body: JSON.stringify({ path: "/" }), headers: { "content-type": "application/json" } })).status, 404);
    assert.equal((await app.request("/healthz")).status, 404);
    assert.equal((await app.request("/metrics")).status, 404);
    assert.equal((await app.request("/api/info")).status, 404);
  } finally {
    await (app as unknown as { close: () => Promise<void> }).close();
  }
});

test("worker config holds no secret", () => {
  const cfg = {
    ...loadConfig({ FILEDECK_ROOT: "/srv", FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: "t0k3n-agent", FILEDECK_VAULT_KEY: "v4ult-key", FILEDECK_INDEX_DIR: "/var/idx", FILEDECK_FANWATCH: "/bin/fanwatch", FILEDECK_AUTH: "on" } as never),
    apiToken: "4pi-token", // only a hub reads it from its settings; set here so the test covers it anyway
    apiTokenAccount: "admin",
    admins: ["root-admin"],
  };
  const w = workerConfig(cfg, { thumbs: "/var/thumbs/u1000", index: "/var/idx/accounts/u1000" });
  const sent = JSON.stringify(w);
  for (const secret of ["t0k3n-agent", "v4ult-key", "4pi-token"]) assert.ok(!sent.includes(secret), `${secret} reaches the worker`);
  // any setting whose name says it holds a secret is dropped, also ones added later
  for (const [k, v] of Object.entries(w)) if (/token|secret|key|password/i.test(k)) assert.ok(!v, `${k} reaches the worker`);
  assert.equal(w.worker, true);
  assert.equal(w.auth, false);
  assert.equal(w.jobsFile, ""); // the root-owned shared job file is the root process's alone
  assert.equal(w.fanwatch, "");
  assert.equal(w.trashSweepMs, 0);
  assert.equal(w.thumbDir, "/var/thumbs/u1000");
  assert.equal(w.indexDir, "/var/idx/accounts/u1000");
  assert.equal(w.root, "/srv");
  assert.deepEqual(w.admins, []); // whatever a worker holds, its account can read
  assert.equal(w.vaultFile, "");
  assert.equal(w.authFile, "");
  assert.equal(cfg.agentToken, "t0k3n-agent"); // the agent's own settings are left as they are
});

/** a worker process from the source, with a root `Mux` on its descriptor 3 */
function startWorker() {
  // a worker checks that its TMPDIR is its own 0700 folder with no link on its path: give it a fresh one (never the shared /tmp)
  const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-worker-tmp-")));
  fs.chmodSync(own, 0o700);
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/worker.ts")], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: own, HOME: own },
  });
  const out = { stderr: "" };
  child.stderr!.on("data", (d) => (out.stderr += d));
  const exited = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));
  void exited.then(() => fs.rmSync(own, { recursive: true, force: true }));
  const mux = new Mux(child.stdio[3] as Duplex, "root");
  /** the exit code, or "timeout" (the child is then killed) */
  const exit = async (ms: number) => {
    const code = await Promise.race([exited, new Promise<string>((res) => setTimeout(() => res("timeout"), ms).unref())]);
    if (code === "timeout") child.kill("SIGKILL");
    return code;
  };
  return { child, out, mux, exit };
}
const initFor = (tmp: string, index = path.join(tmp, ".idx")): WorkerInit => ({
  cfg: workerConfig(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), { thumbs: path.join(tmp, ".thumbs"), index }),
  account: { kind: "sys", name: "tester", uid: process.getuid?.() ?? 1000 },
  trashFolder: "u1000",
});
const workerLines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("worker:"));

test("worker process", async () => {
  const tmp = tree();
  const w = startWorker();
  try {
    w.mux.hello(initFor(tmp));
    await w.mux.whenReady();
    const r = await w.mux.fetch(new Request("http://worker/api/fs/stat?path=/"));
    assert.equal(r.status, 200, w.out.stderr);
    assert.equal(((await r.json()) as { type: string }).type, "dir");
  } finally {
    w.mux.close();
  }
  assert.equal(await w.exit(2000), 0, w.out.stderr);
  assert.deepEqual(workerLines(w.out.stderr), []);
});

// (other lines, such as the index cache saying it starts over, may come too: only the worker's own line is counted)
test("worker start-up failure exits 1", async () => {
  const tmp = tree();
  const w = startWorker();
  w.mux.hello(initFor(tmp, path.join(tmp, "a.txt", "idx"))); // the index folder under a regular file
  await assert.rejects(w.mux.whenReady());
  assert.equal(await w.exit(5000), 1, w.out.stderr);
  assert.equal(workerLines(w.out.stderr).length, 1, w.out.stderr);
});

test("a second HELLO exits 1", async () => {
  const tmp = tree();
  const w = startWorker();
  w.mux.hello(initFor(tmp));
  await w.mux.whenReady();
  w.mux.hello(initFor(tmp));
  assert.equal(await w.exit(5000), 1, w.out.stderr);
  assert.equal(workerLines(w.out.stderr).length, 1, w.out.stderr);
});
