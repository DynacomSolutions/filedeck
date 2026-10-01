import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { networkKind, parseMounts, listMounts } from "../src/mounts.ts";
import { parseSources } from "../src/sources/registry.ts";
import { startSftp } from "./sftp-server.ts";
import { defineSourceSuite } from "./source-suite.ts";

const PASSWORD = "s3cret-pass-value";

defineSourceSuite("sftp", async (tmp, secrets) => {
  const remote = path.join(tmp, "remote");
  fs.mkdirSync(path.join(remote, "share"), { recursive: true });
  for (const n of ["nas", "badnas"]) {
    fs.mkdirSync(path.join(secrets, n), { recursive: true });
    fs.writeFileSync(path.join(secrets, n, "username"), "alice\n");
    fs.writeFileSync(path.join(secrets, n, "password"), (n === "nas" ? PASSWORD : "wrong-password-xyz") + "\n");
  }
  const sftp = await startSftp(remote, "alice", PASSWORD);
  return {
    sources: [
      { name: "nas", type: "sftp", host: `127.0.0.1:${sftp.port}`, root: "/share", secretRef: "nas-creds" },
      { name: "badnas", type: "sftp", host: `127.0.0.1:${sftp.port}`, root: "/share", secretRef: "badnas-creds" },
    ],
    diskRoot: path.join(remote, "share"),
    leaks: [PASSWORD, "wrong-password-xyz", "alice"],
    close: () => sftp.close(),
  };
});

const tmpd = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-mnt-")));
test("mounts: network filesystems are labelled", async () => {
  assert.equal(networkKind("nfs4"), "NFS");
  assert.equal(networkKind("cifs"), "SMB/CIFS");
  assert.equal(networkKind("fuse.sshfs"), "SSHFS");
  assert.equal(networkKind("fuse.something"), "FUSE");
  assert.equal(networkKind("fuse"), "FUSE");
  assert.equal(networkKind("ext4"), null);
  const tmp = tmpd();
  const proc = path.join(tmp, "mounts");
  fs.mkdirSync(path.join(tmp, "m1"));
  fs.writeFileSync(
    proc,
    ["/dev/sda1 /m1 ext4 rw 0 0", "nas:/export /m1 nfs4 rw 0 0", "//srv/share /smb cifs rw 0 0", "sshfs#u@h: /fuse fuse.sshfs rw 0 0"].join("\n"),
  );
  assert.deepEqual(parseMounts(fs.readFileSync(proc, "utf8")).map((m) => m.fstype), ["ext4", "cifs", "fuse.sshfs"]);
  fs.mkdirSync(path.join(tmp, "smb"));
  fs.mkdirSync(path.join(tmp, "fuse"));
  const ms = await listMounts(tmp, proc);
  assert.deepEqual(ms.map((m) => [m.mountpoint, m.network, m.netKind ?? null]), [["/fuse", true, "SSHFS"], ["/m1", false, null], ["/smb", true, "SMB/CIFS"]]);
});

test("source config parsing rejects bad names and duplicates", () => {
  assert.deepEqual(parseSources(""), []);
  assert.throws(() => parseSources(JSON.stringify([{ name: "Bad Name", type: "sftp", host: "h" }])));
  assert.throws(() => parseSources(JSON.stringify([{ name: "a", type: "sftp", host: "h" }, { name: "a", type: "sftp", host: "h" }])));
  assert.throws(() => parseSources(JSON.stringify([{ name: "a", type: "sftp", host: "h", root: "rel" }])));
  assert.throws(() => createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: "a=http://x", FILEDECK_SOURCES: JSON.stringify([{ name: "a", type: "sftp", host: "h" }]) } as never)));
  assert.throws(() => createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_SOURCES: JSON.stringify([{ name: "a", type: "carrier-pigeon", host: "h" }]) } as never)));
});
