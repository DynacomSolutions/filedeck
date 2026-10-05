import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { HOST_KEY_CHANGED, SftpBackend } from "../src/sources/sftp.ts";
import { FsError } from "../src/fsops.ts";
import { startSftp } from "./sftp-server.ts";

const open = (app: { fetch: never }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
const portOf = (s: ReturnType<typeof serve>) => (s.address() as AddressInfo).port;

/** Fingerprint a server presents, as the hub pins it (base64 sha256 of the host key blob, no padding). */
function fingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client();
    c.on("error", () => undefined);
    c.connect({
      host: "127.0.0.1",
      port,
      username: "alice",
      password: "pw",
      hostHash: "sha256",
      hostVerifier: (h: string) => {
        resolve(Buffer.from(h, "hex").toString("base64").replace(/=+$/, ""));
        c.destroy();
        return false;
      },
    });
    setTimeout(() => reject(new Error("timeout")), 5000).unref();
  });
}

async function setup(sources: (port: number, fp: string) => Record<string, unknown>[]) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hk-")));
  fs.mkdirSync(path.join(tmp, "remote", "share"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "agent"));
  fs.mkdirSync(path.join(tmp, "secrets", "nas"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "username"), "alice\n");
  fs.writeFileSync(path.join(tmp, "secrets", "nas", "password"), "pw\n");
  const sftp = await startSftp(path.join(tmp, "remote"), "alice", "pw");
  const fp = await fingerprint(sftp.port);
  const agent = await open(createAgent(loadConfig({ FILEDECK_ROOT: path.join(tmp, "agent"), FILEDECK_NODE: "n1" } as never)) as never);
  const hubApp = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      NODES: `n1=http://127.0.0.1:${portOf(agent)}`,
      FILEDECK_STATIC: tmp,
      FILEDECK_SOURCES: JSON.stringify(sources(sftp.port, fp)),
      FILEDECK_SOURCE_SECRETS: path.join(tmp, "secrets"),
    } as never),
  );
  const hub = await open(hubApp as never);
  const nodes = async () => ((await (await fetch(`http://127.0.0.1:${portOf(hub)}/api/nodes`)).json()) as { sources: { online: boolean; offlineReason?: string }[] }).sources[0]!;
  const done = async () => {
    await hubApp.close();
    hub.close();
    agent.close();
    await sftp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { sftp, nodes, done, tmp };
}

const nas = (port: number, hostKeySha256?: string) => ({ name: "nas", type: "sftp", host: `127.0.0.1:${port}`, root: "/share", secretRef: "nas", ...(hostKeySha256 ? { options: { hostKeySha256 } } : {}) });

test("sftp: a matching pinned host key is online", async () => {
  const t = await setup((port, fp) => [nas(port, fp)]);
  try {
    const s = await t.nodes();
    assert.equal(s.online, true);
    assert.equal(s.offlineReason, undefined);
  } finally {
    await t.done();
  }
});

test("sftp: a pinned host key that does not match is reported as a host-key change in /api/nodes", async () => {
  const t = await setup((port) => [nas(port, "A".repeat(43))]);
  try {
    const s = await t.nodes();
    assert.equal(s.online, false);
    assert.equal(s.offlineReason, "host-key-changed");
  } finally {
    await t.done();
  }
});

test("sftp: without a pin a changed host key is refused and named", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-hk-")));
  fs.mkdirSync(path.join(tmp, "share"));
  const first = await startSftp(tmp, "alice", "pw");
  const port = first.port;
  const backend = new SftpBackend({ name: "x", type: "sftp", host: `127.0.0.1:${port}`, root: "/share" }, async () => ({ username: "alice", password: "pw" }));
  let second: Awaited<ReturnType<typeof startSftp>> | undefined;
  try {
    await backend.ping(); // first key seen and remembered
    await first.close();
    await new Promise((r) => setTimeout(r, 200)); // let the dropped connection be noticed
    second = await startSftp(tmp, "alice", "pw", port); // same address, new key: what a restarted rclone serve sftp does
    await assert.rejects(backend.ping(), (e: unknown) => e instanceof FsError && e.message === HOST_KEY_CHANGED && e.extra?.reason === "hostkey");
  } finally {
    await backend.close();
    await second?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
