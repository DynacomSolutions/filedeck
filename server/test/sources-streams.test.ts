import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { SftpBackend } from "../src/sources/sftp.ts";
import { WebdavBackend, davTimeouts } from "../src/sources/webdav.ts";
import { FsError } from "../src/fsops.ts";
import { startDav } from "./webdav-server.ts";
import { startSftp } from "./sftp-server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpdir = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;

async function drain(r: Readable): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of r) out.push(c as Buffer);
  return Buffer.concat(out);
}

test("an upload aborted half-way fails that request and does not crash the hub", async () => {
  const tmp = tmpdir("filedeck-ab-");
  fs.mkdirSync(path.join(tmp, "dav", "share"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "agent"));
  fs.mkdirSync(path.join(tmp, "secrets", "nas"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "username"), "bob\n");
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "password"), "pw\n");
  const dav = await startDav(path.join(tmp, "dav"), "bob", "pw");
  const agent = await open(createAgent(loadConfig({ FILEDECK_ROOT: path.join(tmp, "agent"), FILEDECK_NODE: "n1" } as never)) as never);
  const hubApp = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      NODES: `n1=http://127.0.0.1:${portOf(agent)}`,
      FILEDECK_STATIC: tmp,
      FILEDECK_SOURCES: JSON.stringify([{ name: "nas", type: "webdav", host: `http://127.0.0.1:${dav.port}/dav`, root: "/share", secretRef: "nas" }]),
      FILEDECK_SOURCE_SECRETS: path.join(tmp, "secrets"),
    } as never),
  );
  const hub = await open(hubApp as never);
  const crashes: Error[] = [];
  const onCrash = (e: Error) => crashes.push(e);
  process.on("uncaughtException", onCrash);
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        const req = http.request({ port: portOf(hub), method: "PUT", path: `/api/nodes/nas/api/fs/upload?dir=/&name=part${i}.bin`, headers: { "content-length": "1000000", "content-type": "application/octet-stream" } });
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.write(Buffer.alloc(1000));
        setTimeout(() => req.destroy(), 100);
      });
    }
    await sleep(500);
    assert.deepEqual(crashes.map((e) => e.message), []);
    const r = await fetch(`http://127.0.0.1:${portOf(hub)}/api/nodes/nas/api/fs/list?path=/`);
    assert.equal(r.status, 200);
    assert.deepEqual(fs.readdirSync(path.join(tmp, "dav", "share")).filter((n) => /^part\d\.bin$/.test(n)), []);
  } finally {
    process.off("uncaughtException", onCrash);
    await hubApp.close();
    hub.close();
    agent.close();
    await dav.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("webdav: transfers are not capped by a total time, a stalled upload is cut", async () => {
  const seen: number[] = [];
  const orig = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms: number) => (seen.push(ms), orig(ms));
  const saved = { ...davTimeouts };
  const tmp = tmpdir("filedeck-dt-");
  fs.mkdirSync(path.join(tmp, "r"));
  fs.writeFileSync(path.join(tmp, "r", "big.bin"), Buffer.alloc(300_000, 7));
  const dav = await startDav(tmp, "u", "p");
  const b = new WebdavBackend({ name: "x", type: "webdav", host: `http://127.0.0.1:${dav.port}/dav`, root: "/r" }, async () => ({ username: "u", password: "p" }));
  try {
    davTimeouts.headerMs = 5000;
    assert.equal((await drain(await b.read("/big.bin"))).length, 300_000);
    const slow = Readable.from(
      (async function* () {
        for (let i = 0; i < 4; i++) {
          await sleep(150);
          yield Buffer.alloc(1000, i);
        }
      })(),
    );
    davTimeouts.idleMs = 400; // longer than each gap, shorter than the whole upload
    assert.equal(await b.write("/slow.bin", slow, { overwrite: true, size: 4000 }), 4000);
    assert.equal(fs.statSync(path.join(tmp, "r", "slow.bin")).size, 4000);
    assert.ok(seen.every((ms) => ms <= 60_000), `no fixed long timeout is armed: ${seen.join(",")}`);

    davTimeouts.idleMs = 250;
    const stalled = Readable.from(
      (async function* () {
        yield Buffer.alloc(100);
        await sleep(3000);
        yield Buffer.alloc(100);
      })(),
    );
    const t0 = Date.now();
    await assert.rejects(b.write("/stalled.bin", stalled, { overwrite: true, size: 200 }), (e: unknown) => e instanceof FsError && e.status === 504);
    assert.ok(Date.now() - t0 < 2500, "cut by the idle timer, not by the end of the stream");
  } finally {
    Object.assign(davTimeouts, saved);
    AbortSignal.timeout = orig;
    await dav.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sftp: a symlinked file can be read, a broken link is 404", async () => {
  const tmp = tmpdir("filedeck-sl-");
  fs.mkdirSync(path.join(tmp, "remote", "share"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "agent"));
  fs.mkdirSync(path.join(tmp, "secrets", "nas"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "username"), "alice\n");
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "password"), "pw\n");
  fs.writeFileSync(path.join(tmp, "remote", "share", "real.txt"), "linked content");
  fs.symlinkSync("real.txt", path.join(tmp, "remote", "share", "link.txt"));
  fs.symlinkSync("missing.txt", path.join(tmp, "remote", "share", "broken.txt"));
  const sftp = await startSftp(path.join(tmp, "remote"), "alice", "pw");
  const agent = await open(createAgent(loadConfig({ FILEDECK_ROOT: path.join(tmp, "agent"), FILEDECK_NODE: "n1" } as never)) as never);
  const hubApp = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      NODES: `n1=http://127.0.0.1:${portOf(agent)}`,
      FILEDECK_STATIC: tmp,
      FILEDECK_SOURCES: JSON.stringify([{ name: "nas", type: "sftp", host: `127.0.0.1:${sftp.port}`, root: "/share", secretRef: "nas" }]),
      FILEDECK_SOURCE_SECRETS: path.join(tmp, "secrets"),
    } as never),
  );
  const hub = await open(hubApp as never);
  const u = (p: string, route: string) => `http://127.0.0.1:${portOf(hub)}/api/nodes/nas/api/fs/${route}?path=${encodeURIComponent(p)}`;
  try {
    const r = await fetch(u("/link.txt", "read"));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "linked content");
    const rr = await fetch(u("/link.txt", "read"), { headers: { range: "bytes=2-5" } });
    assert.equal(rr.status, 206);
    assert.equal(await rr.text(), "nked");
    const t = (await (await fetch(u("/link.txt", "text"))).json()) as { content: string };
    assert.equal(t.content, "linked content");
    assert.equal((await fetch(u("/broken.txt", "read"))).status, 404);
    // the listing still reports the link as a link
    const l = (await (await fetch(u("/", "list"))).json()) as { entries: { name: string; type: string }[] };
    assert.equal(l.entries.find((e) => e.name === "link.txt")?.type, "symlink");
  } finally {
    await hubApp.close();
    hub.close();
    agent.close();
    await sftp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sftp: a failed rename that is not a name clash keeps its own error", async () => {
  const tmp = tmpdir("filedeck-rn-");
  fs.mkdirSync(path.join(tmp, "share", "a"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "share", "f.txt"), "x");
  const sftp = await startSftp(tmp, "alice", "pw");
  const b = new SftpBackend({ name: "x", type: "sftp", host: `127.0.0.1:${sftp.port}`, root: "/share" }, async () => ({ username: "alice", password: "pw" }));
  try {
    // a folder cannot move into itself: the server answers with a generic failure and nothing exists at the destination
    await assert.rejects(b.rename("/a", "/a/inside", false), (e: unknown) => e instanceof FsError && e.status === 502 && !/exists/.test(e.message));
    // a real clash is still a 409
    fs.mkdirSync(path.join(tmp, "share", "b"));
    await assert.rejects(b.rename("/a", "/b", false), (e: unknown) => e instanceof FsError && e.status === 409);
  } finally {
    await b.close();
    await sftp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sftp: the first host key is remembered across restarts when a state folder exists", async () => {
  const tmp = tmpdir("filedeck-hs-");
  fs.mkdirSync(path.join(tmp, "share"));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state);
  const file = path.join(state, "sftp-hostkeys.json");
  const creds = async () => ({ username: "alice", password: "pw" });
  const cfg = (port: number) => ({ name: "x", type: "sftp", host: `127.0.0.1:${port}`, root: "/share" });
  const first = await startSftp(tmp, "alice", "pw");
  const port = first.port;
  const b1 = new SftpBackend(cfg(port), creds, { hostKeyFile: file });
  let second: Awaited<ReturnType<typeof startSftp>> | undefined;
  let b2: SftpBackend | undefined;
  try {
    await b1.ping();
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await b1.close();
    await first.close();
    second = await startSftp(tmp, "alice", "pw", port); // new key, new "process" (a fresh backend with no memory)
    b2 = new SftpBackend(cfg(port), creds, { hostKeyFile: file });
    await assert.rejects(b2.ping(), (e: unknown) => e instanceof FsError && /host key changed/.test(e.message));
    // without a state folder the behaviour is as before: trust whatever is presented first
    const b3 = new SftpBackend(cfg(port), creds, { hostKeyFile: path.join(tmp, "no-such-folder", "k.json") });
    await b3.ping();
    assert.equal(fs.existsSync(path.join(tmp, "no-such-folder")), false);
    await b3.close();
  } finally {
    await b1.close();
    await b2?.close();
    await second?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
