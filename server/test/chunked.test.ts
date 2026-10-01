import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { STALE_MS } from "../src/chunked.ts";

const srvs: ReturnType<typeof serve>[] = [];
let R: string, agent: string, hub: string;
const open = (app: { fetch: never }) => new Promise<ReturnType<typeof serve>>((res) => { const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s)); });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;
const ID = "a".repeat(32);

before(async () => {
  R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-chunk-")));
  fs.mkdirSync(path.join(R, "up"));
  const sa = await open(createAgent(loadConfig({ FILEDECK_ROOT: R, FILEDECK_NODE: "A", FILEDECK_MAX_UPLOAD: String(10 * 1024 * 1024) } as never)) as never);
  const sh = await open(createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: R, NODES: `A=http://127.0.0.1:${portOf(sa)}` } as never)) as never);
  srvs.push(sa, sh);
  agent = `http://127.0.0.1:${portOf(sa)}`;
  hub = `http://127.0.0.1:${portOf(sh)}`;
});
after(() => {
  for (const s of srvs) s.close();
  if (R) fs.rmSync(R, { recursive: true, force: true });
});

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const status = async (base: string, name: string, id = ID) => (await fetch(`${base}/api/upload/status?${q({ dir: "/up", name, id })}`)).json() as Promise<{ offset: number; exists: boolean }>;
const chunk = (base: string, name: string, offset: number, total: number, data: Buffer, extra: Record<string, string | number> = {}, id = ID) =>
  fetch(`${base}/api/upload/chunk?${q({ dir: "/up", name, id, offset, total, ...extra })}`, { method: "PATCH", body: new Uint8Array(data) });

test("chunks arrive in order, resume from the stored offset, and the last one commits atomically", async () => {
  const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
  const name = "movie.bin";
  assert.deepEqual(await status(agent, name), { offset: 0, exists: false });
  let r = await chunk(agent, name, 0, data.length, data.subarray(0, 1000));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { done: false, offset: 1000 });
  assert.ok(!fs.existsSync(path.join(R, "up", name)), "nothing at the real name until the end");
  assert.ok(fs.readdirSync(path.join(R, "up")).some((n) => n.endsWith(".part")));

  // a client that lost track resyncs: wrong offset answers 409 with the truth
  r = await chunk(agent, name, 0, data.length, data.subarray(0, 1000));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { offset: number }).offset, 1000);
  r = await chunk(agent, name, 5000, data.length, data.subarray(0, 10));
  assert.equal(r.status, 409);
  assert.equal((await status(agent, name)).offset, 1000);

  r = await chunk(agent, name, 1000, data.length, data.subarray(1000, 2000));
  assert.deepEqual(await r.json(), { done: false, offset: 2000 });
  const mtime = Math.floor(Date.now() / 1000 - 9000) * 1000;
  r = await chunk(agent, name, 2000, data.length, data.subarray(2000), { mtime });
  assert.equal(r.status, 201);
  const done = (await r.json()) as { done: boolean; path: string; size: number };
  assert.deepEqual([done.done, done.path, done.size], [true, "/up/movie.bin", 3000]);
  assert.ok(createHash("sha256").update(fs.readFileSync(path.join(R, "up", name))).digest().equals(createHash("sha256").update(data).digest()));
  assert.equal(Math.floor(fs.statSync(path.join(R, "up", name)).mtimeMs), mtime);
  assert.ok(!fs.readdirSync(path.join(R, "up")).some((n) => n.endsWith(".part")));
  assert.equal((await status(agent, name)).exists, true);
});

test("an existing destination is refused unless overwrite is set; empty files work", async () => {
  fs.writeFileSync(path.join(R, "up", "taken.txt"), "old");
  let r = await chunk(agent, "taken.txt", 0, 3, Buffer.from("new"));
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(R, "up", "taken.txt"), "utf8"), "old");
  r = await chunk(agent, "taken.txt", 0, 3, Buffer.from("new"), { overwrite: 1 });
  assert.equal(r.status, 201);
  assert.equal(fs.readFileSync(path.join(R, "up", "taken.txt"), "utf8"), "new");
  r = await chunk(agent, "empty.txt", 0, 0, Buffer.alloc(0));
  assert.equal(r.status, 201);
  assert.equal(fs.statSync(path.join(R, "up", "empty.txt")).size, 0);
});

test("overrun, bad ids and names, size cap, trash and traversal are rejected; abort removes the part", async () => {
  let r = await chunk(agent, "over.bin", 0, 4, Buffer.from("123456"));
  assert.equal(r.status, 400);
  assert.equal((await status(agent, "over.bin")).offset, 0, "overrun leaves nothing behind");
  assert.equal((await chunk(agent, "x.bin", 0, 1, Buffer.from("x"), {}, "nothex!")).status, 400);
  assert.equal((await chunk(agent, "../evil", 0, 1, Buffer.from("x"))).status, 400);
  assert.equal((await chunk(agent, "a/b", 0, 1, Buffer.from("x"))).status, 400);
  assert.equal((await chunk(agent, "big.bin", 0, 20 * 1024 * 1024, Buffer.from("x"))).status, 413);
  assert.equal((await fetch(`${agent}/api/upload/status?${q({ dir: "/up/../..", name: "x", id: ID })}`)).status, 400);
  assert.equal((await fetch(`${agent}/api/upload/status?${q({ dir: "/.filedeck-trash", name: "x", id: ID })}`)).status, 403);
  await chunk(agent, "half.bin", 0, 100, Buffer.from("half"));
  assert.equal((await status(agent, "half.bin")).offset, 4);
  r = await fetch(`${agent}/api/upload?${q({ dir: "/up", name: "half.bin", id: ID })}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal((await status(agent, "half.bin")).offset, 0);
});

test("a different file identity (id) never shares a part file; stale parts are swept", async () => {
  await chunk(agent, "same.bin", 0, 10, Buffer.from("AAAA"), {}, "1".repeat(16));
  assert.equal((await status(agent, "same.bin", "2".repeat(16))).offset, 0);
  const old = path.join(R, "up", `.ghost.bin.filedeck-up-${"3".repeat(16)}.part`);
  fs.writeFileSync(old, "abandoned");
  const t = new Date(Date.now() - STALE_MS - 60_000);
  fs.utimesSync(old, t, t);
  await status(agent, "same.bin", "2".repeat(16));
  assert.ok(!fs.existsSync(old), "stale part removed");
  assert.ok(fs.existsSync(path.join(R, "up", `.same.bin.filedeck-up-${"1".repeat(16)}.part`)), "fresh part kept");
});

test("through the hub: same protocol over the proxy, including a resumed upload", async () => {
  const data = Buffer.alloc(5 * 1024 * 1024, 9);
  const base = `${hub}/api/nodes/A`;
  let r = await chunk(base, "viahub.bin", 0, data.length, data.subarray(0, 2 * 1024 * 1024), {}, "4".repeat(20));
  assert.equal(r.status, 200);
  // "browser restart": ask the server where to continue
  const st = await status(base, "viahub.bin", "4".repeat(20));
  assert.equal(st.offset, 2 * 1024 * 1024);
  r = await chunk(base, "viahub.bin", st.offset, data.length, data.subarray(st.offset), {}, "4".repeat(20));
  assert.equal(r.status, 201);
  assert.equal(fs.statSync(path.join(R, "up", "viahub.bin")).size, data.length);
});
