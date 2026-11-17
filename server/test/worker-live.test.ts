import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, workerConfig } from "../src/config.ts";
import { WorkerPool, type WorkerSpec } from "../src/worker-pool.ts";
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
