import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, workerConfig } from "../src/config.ts";
import { WorkerPool, type WorkerSpec } from "../src/worker-pool.ts";
import { makeWorkerSpecs } from "../src/agent-workers.ts";
import { useSandbox } from "./sandbox-env.ts";

/** Workers started as another user (needs root): the user, the groups and the confinement the kernel reports for the process. */

const IS_ROOT = process.getuid?.() === 0;
const ROOT_ONLY = IS_ROOT ? false : "worker live: skipped (not running as root)";
const temps: string[] = [];
let pool: WorkerPool | undefined;

before(async () => {
  if (!IS_ROOT) return;
  temps.push((await useSandbox()).dir);
});
after(async () => {
  await pool?.close();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

test("a worker runs as its account, with its groups, no capabilities, no new privileges and the socket filter", { skip: ROOT_ONLY }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-worker-live-")));
  temps.push(tmp);
  fs.chmodSync(tmp, 0o755);
  const state = path.join(tmp, "state");
  fs.mkdirSync(state);
  fs.chownSync(state, 1234, 1234);
  const account = { name: "live", uid: 1234, gid: 1234, groups: [1234, 2345], home: state };
  const spec: WorkerSpec = {
    key: "sys:live",
    kind: "sys",
    name: "live",
    epoch: 1,
    account,
    tmp: state,
    init: {
      cfg: workerConfig(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never), { thumbs: path.join(state, "thumbs"), index: path.join(state, "index") }),
      account: { kind: "sys", name: "live", uid: 1234 },
      trashFolder: "u1234",
    },
  };
  const lines: string[] = [];
  pool = new WorkerPool({ max: 2, idleMs: 60_000, log: (l) => lines.push(l) });
  const res = await pool.fetch(spec, new Request("http://agent/api/fs/stat?path=/"));
  assert.equal(res.status, 200, `${await res.clone().text()}\n${lines.join("\n")}`);
  await res.text();
  const pid = pool.list()[0]!.pid;
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1]?.trim();
  assert.equal(field("Uid")?.split(/\s+/)[0], "1234", status);
  assert.equal(field("Gid")?.split(/\s+/)[0], "1234", status);
  assert.equal(field("Groups"), "1234 2345", status);
  assert.equal(field("CapEff"), "0000000000000000", status);
  assert.equal(field("NoNewPrivs"), "1", status);
  assert.equal(field("Seccomp"), "2", status);
});

test("a worker for another user needs its own temporary folder", { skip: ROOT_ONLY }, async () => {
  let starts = 0;
  const p = new WorkerPool({ max: 2, idleMs: 60_000, log: () => {}, start: async () => { starts++; throw new Error("not reached"); } });
  try {
    const account = { name: "live2", uid: 1235, gid: 1235, groups: [1235], home: "/nonexistent" };
    const res = await p.fetch(
      { key: "sys:live2", kind: "sys", name: "live2", epoch: 1, account, init: {} as never },
      new Request("http://agent/api/fs/stat?path=/"),
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "worker has no temporary folder" });
    assert.equal(starts, 0);
  } finally {
    await p.close();
  }
});

test("an account's thumbnail folder is its own (0700), and files its worker extracts are owned by it", { skip: ROOT_ONLY }, async (t) => {
  if (spawnSync("bsdtar", ["--version"], { stdio: "ignore" }).status !== 0) throw new Error("the root pass needs bsdtar");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-worker-live-")));
  temps.push(tmp);
  fs.chmodSync(tmp, 0o755);
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "in.txt"), "extracted\n");
  assert.equal(spawnSync("bsdtar", ["-C", tmp, "--format", "zip", "-cf", path.join(root, "x/in.zip"), "in.txt"]).status, 0);
  fs.chmodSync(root, 0o755);
  for (const p of [path.join(root, "x"), path.join(root, "x/in.zip")]) fs.chownSync(p, 1234, 1234);
  const cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_THUMB_DIR: path.join(tmp, "thumbs"), FILEDECK_INDEX_DIR: path.join(tmp, "index") } as never);
  const specs = makeWorkerSpecs(cfg);
  const account = { name: "live3", uid: 1234, gid: 1234, groups: [1234], home: "/nonexistent" };
  const claim = { kind: "sys" as const, name: "live3", epoch: 1, iat: Date.now() };
  const p = new WorkerPool({ max: 2, idleMs: 60_000, log: () => {} });
  try {
    const spec = await specs.spec(claim, account);
    const thumbs = fs.lstatSync(path.join(tmp, "thumbs/u1234"));
    assert.equal(thumbs.uid, 1234);
    assert.equal(thumbs.mode & 0o7777, 0o700);
    const parent = fs.lstatSync(path.join(tmp, "thumbs"));
    assert.equal(parent.uid, 0);
    assert.equal(parent.mode & 0o7777, 0o711);
    const index = fs.lstatSync(path.join(tmp, "index/accounts/u1234"));
    assert.equal(index.uid, 1234);
    assert.equal(index.mode & 0o7777, 0o700);
    // a file the worker writes is the account's
    const w = await p.fetch(spec, new Request("http://agent/api/fs/write?path=/x/w.txt&create=1", { method: "PUT", body: "w\n" }));
    assert.equal(w.status, 200, await w.clone().text());
    assert.equal(fs.lstatSync(path.join(root, "x/w.txt")).uid, 1234);
    // Archive staging refuses a work folder below a folder that is neither root's nor the worker's own. In a user namespace (a fake root)
    // "/" belongs to an unmapped user, so every staging place is refused there; only a real root can run the extraction.
    if (fs.statSync("/").uid !== 0) {
      t.diagnostic("extraction not checked: / is not root's here (a user namespace)");
      return;
    }
    const r = await p.fetch(spec, new Request("http://agent/api/jobs/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/x/in.zip", destDir: "/x", subfolder: false }) }));
    assert.equal(r.status, 202, await r.clone().text());
    const { id } = (await r.json()) as { id: string };
    let job: { state?: string } = {};
    for (let i = 0; i < 400 && !["done", "failed", "canceled"].includes(job.state ?? ""); i++) {
      await new Promise((res) => setTimeout(res, 25));
      job = (await (await p.fetch(spec, new Request(`http://agent/api/jobs/${id}`))).json()) as { state: string };
    }
    assert.equal(job.state, "done", JSON.stringify(job));
    const out = fs.lstatSync(path.join(root, "x/in.txt"));
    assert.equal(out.uid, 1234);
    assert.equal(out.gid, 1234);
  } finally {
    await p.close();
    await specs.close();
  }
});
