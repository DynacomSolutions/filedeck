import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { createHub } from "../src/hub.ts";
import { createSourceApp } from "../src/sources/source-app.ts";
import { loadConfig } from "../src/config.ts";
import { hashPassword } from "../src/auth/store.ts";
import { SourceGrants } from "../src/auth/source-grants.ts";
import { FsError } from "../src/fsops.ts";
import { AccountCalls } from "../src/auth/account-calls.ts";
import type { SystemAuth } from "../src/auth/routes.ts";
import { USER_HEADER, verifyClaim, type Identity } from "../src/auth/identity.ts";
import type { SourceBackend, SourceEntry, SourceStat } from "../src/sources/types.ts";

/**
 * Network sources need a grant (part 3, Task 6). With sign-in on, an account uses a source only with a grant, read-only or read-write;
 * administrators (system and virtual) use every source read-write without one. The check runs inside the source's target on every call,
 * so the proxy, hub jobs and transfers are all covered, and a grant taken away stops a running job at its next call.
 */

const T = "agent-secret-source-access";
const PW = "a-long-password-1";
const READ_ONLY = "this network source is read-only for you";
const NO_ACCESS = "no access to this machine";
let tmp = "";
const hubs: { close(): Promise<void> }[] = [];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-source-access-")));
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
});
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A network source in memory. `writeMs` slows every file write down (a long copy). */
class MemSource implements SourceBackend {
  readonly type = "sftp";
  readonly entries = new Map<string, { type: "file" | "dir"; data: Buffer; mtime: number }>([["/", { type: "dir", data: Buffer.alloc(0), mtime: 0 }]]);
  writeMs = 0;
  /** slows every file read down (a long download) */
  readMs = 0;
  /** read streams handed out, and those closed since (a stream left open holds the backend, as an smbclient child) */
  readsOpened = 0;
  /** reads begun (before the stream exists), and a delay before each stream is opened */
  opening = 0;
  openMs = 0;
  readsClosed = 0;
  /** how many file writes have begun */
  started = 0;
  /** how many file writes have finished */
  writes = 0;
  private parent(p: string): string {
    const d = path.posix.dirname(p);
    return d;
  }
  private mustDir(p: string): void {
    const e = this.entries.get(p);
    if (!e) throw new FsError(404, "not found");
    if (e.type !== "dir") throw new FsError(409, "not a folder");
  }
  /** Adds a file (and its folders) directly, as a test fixture. */
  put(p: string, text: string): void {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const d = "/" + parts.slice(0, i).join("/");
      if (!this.entries.has(d)) this.entries.set(d, { type: "dir", data: Buffer.alloc(0), mtime: 0 });
    }
    this.entries.set(p, { type: "file", data: Buffer.from(text), mtime: 1_700_000_000_000 });
  }
  paths(): string[] {
    return [...this.entries.keys()].sort();
  }
  async ping(): Promise<void> {}
  async list(p: string): Promise<SourceEntry[]> {
    this.mustDir(p);
    const out: SourceEntry[] = [];
    for (const [k, e] of this.entries) {
      if (k === "/" || this.parent(k) !== p) continue;
      out.push({ name: path.posix.basename(k), type: e.type, size: e.data.length, mtime: e.mtime, mode: e.type === "dir" ? 0o755 : 0o644 });
    }
    return out;
  }
  async stat(p: string): Promise<SourceStat | null> {
    const e = this.entries.get(p);
    return e ? { type: e.type, size: e.data.length, mtime: e.mtime, mode: e.type === "dir" ? 0o755 : 0o644 } : null;
  }
  async read(p: string, range?: { start: number; end: number }): Promise<Readable> {
    const e = this.entries.get(p);
    if (!e || e.type !== "file") throw new FsError(404, "not found");
    const data = range ? e.data.subarray(range.start, range.end + 1) : e.data;
    this.opening++;
    if (this.openMs) await sleep(this.openMs);
    // a slow download: 16 KiB at a time, `readMs` apart
    const ms = this.readMs;
    const out = !ms
      ? Readable.from([data])
      : Readable.from(
          (async function* () {
            for (let at = 0; at < data.length; at += 16_384) {
              yield data.subarray(at, at + 16_384);
              await sleep(ms);
            }
          })(),
        );
    this.readsOpened++;
    out.on("close", () => this.readsClosed++);
    return out;
  }
  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number }): Promise<number> {
    this.started++;
    this.mustDir(this.parent(p));
    if (this.entries.has(p) && !o.overwrite) throw new FsError(409, "already exists");
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    if (this.writeMs) await sleep(this.writeMs);
    const data = Buffer.concat(chunks);
    this.entries.set(p, { type: "file", data, mtime: o.mtime ?? Date.now() });
    this.writes++;
    return data.length;
  }
  async mkdir(p: string): Promise<void> {
    this.mustDir(this.parent(p));
    if (this.entries.has(p)) throw new FsError(409, "already exists");
    this.entries.set(p, { type: "dir", data: Buffer.alloc(0), mtime: Date.now() });
  }
  async rename(from: string, to: string): Promise<void> {
    const e = this.entries.get(from);
    if (!e) throw new FsError(404, "not found");
    this.entries.delete(from);
    this.entries.set(to, e);
  }
  async remove(p: string): Promise<void> {
    if (!this.entries.delete(p)) throw new FsError(404, "not found");
  }
  async close(): Promise<void> {}
}

/** System sign-in: `sadmin` (in FILEDECK_ADMINS) and `alice`, both with PW. */
const system: SystemAuth = {
  password: async (name, pw) => ["sadmin", "alice"].includes(name) && pw === PW,
  key: async () => false,
};

type Hub = ReturnType<typeof createHub>;
interface World {
  h: Hub;
  s1: MemSource;
  s2: MemSource;
  grants: SourceGrants;
  changed: Identity[];
}
let n = 0;
/** A hub with sources s1 and s2; `nodes` is its NODES (none by default). */
function world(nodes = ""): World {
  n++;
  const s1 = new MemSource();
  const s2 = new MemSource();
  s1.put("/in-s1.txt", "one");
  s2.put("/f.txt", "file in s2");
  s2.put("/d/inner.txt", "inner");
  const h = createHub(
    loadConfig({
      FILEDECK_MODE: "hub",
      FILEDECK_AUTH: "on",
      FILEDECK_AGENT_TOKEN: T,
      FILEDECK_STATIC: tmp,
      NODES: nodes,
      FILEDECK_ADMINS: "sadmin",
      FILEDECK_AUTH_FILE: path.join(tmp, `auth-${n}.db`),
      FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
      FILEDECK_VAULT_FILE: path.join(tmp, `vault-${n}.db`),
      // its own job store (the default sits next to the vault file and would be shared by every hub in this file)
      FILEDECK_JOBS_FILE: path.join(tmp, `jobs-${n}.db`),
    } as never),
    { s1, s2 },
    () => {},
    { system, streamCheckMs: 60_000 },
  );
  hubs.push(h);
  const changed: Identity[] = [];
  const orig = h.accountChanged;
  h.accountChanged = async (b) => {
    changed.push(structuredClone(b));
    return orig(b);
  };
  const accounts = h.auth!.accounts;
  accounts.create({ name: "guest", passwordHash: hashPassword(PW), admin: false, nodes: {} });
  accounts.create({ name: "vadmin", passwordHash: hashPassword(PW), admin: true, nodes: {} });
  return { h, s1, s2, grants: new SourceGrants(h.auth!.db), changed };
}

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } };
interface Res {
  status: number;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function send(h: Hub, method: string, p: string, cookie?: string, body?: unknown, raw?: string): Promise<Res> {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  let payload: string | undefined = raw;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await h.request("https://localhost" + p, { method, headers, ...(payload === undefined ? {} : { body: payload }) }, peer as never);
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}
async function signIn(h: Hub, name: string): Promise<string> {
  const r = await h.request("https://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: PW }) }, peer as never);
  assert.equal(r.status, 200, `sign-in of ${name}: ${await r.clone().text()}`);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}
/** The sources `/api/nodes` lists for the caller, as name and the read-only flag. */
async function sourcesSeen(h: Hub, cookie: string): Promise<{ name: string; readOnly?: boolean }[]> {
  const r = await send(h, "GET", "/api/nodes", cookie);
  assert.equal(r.status, 200, r.text);
  return (r.json.sources as { name: string; readOnly?: boolean }[]).map((s) => ({ name: s.name, ...(s.readOnly !== undefined ? { readOnly: s.readOnly } : {}) }));
}
/** Waits for a hub job to end and gives its view. */
async function jobEnd(h: Hub, cookie: string, id: string, ms = 10_000): Promise<{ state: string; error?: string }> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await send(h, "GET", `/api/ops/jobs/${id}`, cookie);
    assert.equal(r.status, 200, r.text);
    if (!["queued", "running", "paused", "waiting"].includes(r.json.state)) return r.json;
    assert.ok(Date.now() < end, `job ${id} still ${r.json.state}`);
    await sleep(20);
  }
}
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(10);
  }
}
const mkdir = (h: Hub, cookie: string, src: string, p: string) => send(h, "POST", `/api/nodes/${src}/api/fs/mkdir`, cookie, { path: p });
const upload = (h: Hub, cookie: string, src: string, name: string) => send(h, "PUT", `/api/nodes/${src}/api/fs/upload?dir=/&name=${name}`, cookie, undefined, "uploaded");

test("no grant, no source: a virtual account without a grant sees and uses no source; administrators use every one without a grant", async () => {
  const { h, s1, s2 } = world();
  const guest = await signIn(h, "guest");
  assert.deepEqual(await sourcesSeen(h, guest), []);
  const list = await send(h, "GET", "/api/nodes/s1/api/fs/list?path=/", guest);
  assert.equal(list.status, 403);
  assert.deepEqual(list.json, { error: NO_ACCESS });
  // not through a job or a transfer either
  const job = await send(h, "POST", "/api/ops/jobs", guest, { op: "copy", items: [{ node: "s2", path: "/f.txt" }], dst: { node: "s1", dir: "/" }, conflict: "skip" });
  assert.equal(job.status, 403, job.text);
  const tr = await send(h, "POST", "/api/transfer", guest, { src: { node: "s2", path: "/f.txt" }, dst: { node: "s1", dir: "/" } });
  assert.equal(tr.status, 403, tr.text);
  assert.deepEqual(tr.json, { error: NO_ACCESS });
  // a system administrator and a virtual administrator: every source, read-write, no grant
  for (const name of ["sadmin", "vadmin"]) {
    const admin = await signIn(h, name);
    assert.deepEqual(await sourcesSeen(h, admin), [{ name: "s1" }, { name: "s2" }], name);
    const ls = await send(h, "GET", "/api/nodes/s1/api/fs/list?path=/", admin);
    assert.equal(ls.status, 200, ls.text);
    assert.equal((await mkdir(h, admin, "s1", `/made-by-${name}`)).status, 201);
  }
  assert.ok(s1.entries.has("/made-by-sadmin") && s1.entries.has("/made-by-vadmin"));
  assert.deepEqual(s2.paths(), ["/", "/d", "/d/inner.txt", "/f.txt"]);
});

test("read-only: listing and download work; every change is 403 and reaches nothing", async () => {
  const { h, s1, grants } = world();
  grants.setForAccount("virt", "guest", { s1: { write: false } });
  const guest = await signIn(h, "guest");
  assert.deepEqual(await sourcesSeen(h, guest), [{ name: "s1", readOnly: true }]);
  const ls = await send(h, "GET", "/api/nodes/s1/api/fs/list?path=/", guest);
  assert.equal(ls.status, 200, ls.text);
  const down = await send(h, "GET", "/api/nodes/s1/api/fs/download?path=/in-s1.txt", guest);
  assert.equal(down.status, 200);
  assert.equal(down.text, "one");
  const head = await h.request("https://localhost/api/nodes/s1/api/fs/download?path=/in-s1.txt", { method: "HEAD", headers: { cookie: guest } }, peer as never);
  assert.notEqual(head.status, 403);
  const before = s1.paths();
  for (const r of [
    await mkdir(h, guest, "s1", "/new"),
    await upload(h, guest, "s1", "up.txt"),
    await send(h, "POST", "/api/nodes/s1/api/fs/delete", guest, { paths: ["/in-s1.txt"] }),
    await send(h, "POST", "/api/nodes/s1/api/fs/rename", guest, { from: "/in-s1.txt", to: "/renamed.txt" }),
  ]) {
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(r.json, { error: READ_ONLY });
  }
  assert.deepEqual(s1.paths(), before);
  // the other source is not granted at all
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", guest)).status, 403);
});

test("read-only through a job: a hub job and a transfer into a read-only source fail with 403 and write nothing", async () => {
  const { h, s1, grants } = world();
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  const guest = await signIn(h, "guest");
  const before = s1.paths();
  const job = await send(h, "POST", "/api/ops/jobs", guest, {
    op: "copy",
    items: [
      { node: "s2", path: "/f.txt" },
      { node: "s2", path: "/d" },
    ],
    dst: { node: "s1", dir: "/" },
    conflict: "skip",
  });
  assert.equal(job.status, 202, job.text);
  const end = await jobEnd(h, guest, job.json.id);
  assert.equal(end.state, "failed");
  assert.match(end.error ?? "", new RegExp(READ_ONLY));
  for (const body of [
    { src: { node: "s2", path: "/f.txt" }, dst: { node: "s1", dir: "/" } },
    { src: { node: "s2", path: "/d" }, dst: { node: "s1", dir: "/" } },
  ]) {
    const tr = await send(h, "POST", "/api/transfer", guest, body);
    assert.equal(tr.status, 403, tr.text);
    assert.match(tr.json.error, new RegExp(READ_ONLY));
  }
  assert.deepEqual(s1.paths(), before);
  // the read-write source takes the same copy
  const ok = await send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/in-s1.txt" }, dst: { node: "s2", dir: "/" } });
  assert.equal(ok.status, 201, ok.text);
});

/** A folder of `count` files in s1, for a copy that takes a while. */
function bigFolder(s: MemSource, count: number): void {
  for (let i = 0; i < count; i++) s.put(`/big/f${String(i).padStart(2, "0")}.txt`, `file ${i}`);
}

test("taken away mid-job: removing the grant through the admin route ends the running job, and the next proxy call is 403", async () => {
  const { h, s1, s2, changed } = world();
  bigFolder(s1, 30);
  s2.writeMs = 50;
  const admin = await signIn(h, "sadmin");
  const set = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { sources: { s1: { write: false }, s2: { write: true } } });
  assert.equal(set.status, 200, set.text);
  const guest = await signIn(h, "guest");
  const job = await send(h, "POST", "/api/ops/jobs", guest, { op: "copy", items: [{ node: "s1", path: "/big" }], dst: { node: "s2", dir: "/" }, conflict: "skip" });
  assert.equal(job.status, 202, job.text);
  await until("the copy to start writing", () => s2.writes >= 2);
  const off = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { sources: {} });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json.sources, {});
  assert.equal(changed.at(-1)?.name, "guest");
  // the job is the account's: an administrator sees it end as canceled
  const end = await jobEnd(h, admin, job.json.id);
  assert.equal(end.state, "canceled");
  const written = s2.writes;
  assert.ok(written < 30, `the copy went on: ${written} files`);
  await sleep(200);
  assert.ok(s2.writes <= written + 1, `the copy went on after it ended: ${s2.writes} files`);
  const again = await signIn(h, "guest");
  const r = await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", again);
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: NO_ACCESS });
});

test("taken away mid-job without an account change: the check on every call stops the job at its next call", async () => {
  const { h, s1, s2, grants } = world();
  bigFolder(s1, 30);
  s2.writeMs = 50;
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  const guest = await signIn(h, "guest");
  const job = await send(h, "POST", "/api/ops/jobs", guest, { op: "copy", items: [{ node: "s1", path: "/big" }], dst: { node: "s2", dir: "/" }, conflict: "skip" });
  assert.equal(job.status, 202, job.text);
  await until("the copy to start writing", () => s2.writes >= 2);
  // straight in the store: no epoch rise, no `changed`, the session stays
  grants.setForAccount("virt", "guest", { s1: { write: false } });
  const written = s2.writes;
  const end = await jobEnd(h, guest, job.json.id);
  assert.equal(end.state, "failed");
  assert.match(end.error ?? "", new RegExp(NO_ACCESS));
  assert.ok(s2.writes <= written + 1, `the copy went on: ${s2.writes} files, ${written} when the grant went`);
  // the account's own requests lose s2 at once too, with the same session
  const r = await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", guest);
  assert.equal(r.status, 403);
});

test("system user grants: PUT /api/admin/system/:name/sources gives a system user a source; root and bad input are 400", async () => {
  const { h, s1, changed } = world();
  const admin = await signIn(h, "sadmin");
  const old = await signIn(h, "alice");
  assert.deepEqual(await sourcesSeen(h, old), []);
  const r = await send(h, "PUT", "/api/admin/system/alice/sources", admin, { sources: { s1: { write: true } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { name: "alice", admin: false, sources: { s1: { write: true } }, sessions: 0 });
  // through `changed`, with the identity from before: alice's sessions ended
  assert.deepEqual(
    changed.map((x) => [x.kind, x.name, x.epoch]),
    [["sys", "alice", 0]],
  );
  assert.equal((await send(h, "GET", "/api/nodes", old)).status, 401);
  const alice = await signIn(h, "alice");
  assert.deepEqual(await sourcesSeen(h, alice), [{ name: "s1" }]);
  assert.equal((await mkdir(h, alice, "s1", "/by-alice")).status, 201);
  assert.ok(s1.entries.has("/by-alice"));
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", alice)).status, 403);
  const list = await send(h, "GET", "/api/admin/accounts", admin);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.system.find((x: { name: string }) => x.name === "alice"),
    { name: "alice", admin: false, sources: { s1: { write: true } }, sessions: 1 },
  );
  for (const [p, body] of [
    ["/api/admin/system/root/sources", { sources: { s1: { write: true } } }],
    ["/api/admin/system/Bad%20Name/sources", { sources: {} }],
    ["/api/admin/system/alice/sources", { sources: { nope: { write: true } } }],
    ["/api/admin/system/alice/sources", { sources: { s1: { write: "yes" } } }],
    ["/api/admin/system/alice/sources", {}],
  ] as const) {
    const bad = await send(h, "PUT", p, admin, body);
    assert.equal(bad.status, 400, `${p} ${JSON.stringify(body)}: ${bad.text}`);
  }
  assert.equal(changed.length, 1);
  // only administrators
  const guest = await signIn(h, "guest");
  assert.equal((await send(h, "PUT", "/api/admin/system/alice/sources", guest, { sources: {} })).status, 403);
  // taken away again: alice no longer sees it
  const off = await send(h, "PUT", "/api/admin/system/alice/sources", admin, { sources: {} });
  assert.equal(off.status, 200);
  const alice2 = await signIn(h, "alice");
  assert.deepEqual(await sourcesSeen(h, alice2), []);
});

test("a move, trash or delete out of a read-only source is refused up front: nothing is copied and nothing is removed", async () => {
  const { h, s1, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  const guest = await signIn(h, "guest");
  const before1 = s1.paths();
  const before2 = s2.paths();
  for (const body of [
    { op: "move", items: [{ node: "s1", path: "/in-s1.txt" }], dst: { node: "s2", dir: "/" }, conflict: "skip" },
    { op: "move", items: [{ node: "s1", path: "/in-s1.txt" }], dst: { node: "s1", dir: "/" }, conflict: "rename" },
    { op: "trash", items: [{ node: "s1", path: "/in-s1.txt" }] },
    { op: "delete", items: [{ node: "s1", path: "/in-s1.txt" }] },
    { op: "sync", steps: [{ kind: "trash", node: "s1", path: "/in-s1.txt" }] },
  ]) {
    const r = await send(h, "POST", "/api/ops/jobs", guest, body);
    assert.equal(r.status, 403, `${JSON.stringify(body)}: ${r.text}`);
    assert.deepEqual(r.json, { error: READ_ONLY });
  }
  const tr = await send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/in-s1.txt" }, dst: { node: "s2", dir: "/" }, op: "move" });
  assert.equal(tr.status, 403, tr.text);
  assert.deepEqual(tr.json, { error: READ_ONLY });
  assert.deepEqual(s1.paths(), before1);
  assert.deepEqual(s2.paths(), before2);
  assert.deepEqual((await send(h, "GET", "/api/ops/jobs", guest)).json.jobs, []);
  // a copy out of it still works, and a move out of the read-write source too
  assert.equal((await send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/in-s1.txt" }, dst: { node: "s2", dir: "/" } })).status, 201);
  assert.equal((await send(h, "POST", "/api/transfer", guest, { src: { node: "s2", path: "/f.txt" }, dst: { node: "s2", dir: "/d" }, op: "move" })).status, 201);
  assert.ok(s2.entries.has("/d/f.txt") && !s2.entries.has("/f.txt"));
  // an administrator may move out of it
  const admin = await signIn(h, "sadmin");
  assert.equal((await send(h, "POST", "/api/transfer", admin, { src: { node: "s1", path: "/in-s1.txt" }, dst: { node: "s2", dir: "/d" }, op: "move" })).status, 201);
  assert.ok(!s1.entries.has("/in-s1.txt"));
});

/** Starts a copy of s1's `/big` into s2 as `cookie` and waits until it is writing. */
async function longCopy(h: Hub, cookie: string, s2: MemSource): Promise<string> {
  const job = await send(h, "POST", "/api/ops/jobs", cookie, { op: "copy", items: [{ node: "s1", path: "/big" }], dst: { node: "s2", dir: "/" }, conflict: "skip" });
  assert.equal(job.status, 202, job.text);
  const at = s2.writes;
  await until("the copy to start writing", () => s2.writes >= at + 2);
  return job.json.id as string;
}

test("an old epoch has no access: a job of a deleted name, made again with the same grants, stops at its next call", async () => {
  const { h, s1, s2, grants } = world();
  bigFolder(s1, 30);
  s2.writeMs = 50;
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  const guest = await signIn(h, "guest");
  const id = await longCopy(h, guest, s2);
  // deleted and made again straight in the store (no `changed`: as if the cancel had not reached the hub that holds the job)
  const accounts = h.auth!.accounts;
  accounts.tx(() => {
    grants.removeAccount("virt", "guest");
    accounts.bumpEpoch("virt", "guest");
    accounts.remove("guest");
  });
  accounts.create({ name: "guest", passwordHash: hashPassword(PW), admin: false, nodes: {} });
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  const written = s2.writes;
  const admin = await signIn(h, "sadmin");
  const end = await jobEnd(h, admin, id);
  assert.equal(end.state, "failed");
  assert.match(end.error ?? "", new RegExp(NO_ACCESS));
  assert.ok(s2.writes <= written + 1, `the copy went on: ${s2.writes} files, ${written} at the delete`);
  // the new account, at its own epoch, has its grants
  const fresh = await signIn(h, "guest");
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", fresh)).status, 200);
});

test("a matching epoch is unaffected: system users, also administrators, run jobs to the end; a raised epoch stops an administrator's job too", async () => {
  const { h, s1, s2, grants } = world();
  bigFolder(s1, 6);
  grants.setForAccount("sys", "alice", { s1: { write: false }, s2: { write: true } });
  const alice = await signIn(h, "alice");
  const admin = await signIn(h, "sadmin");
  for (const [cookie, dir] of [
    [alice, "/by-alice"],
    [admin, "/by-sadmin"],
  ] as const) {
    assert.equal((await mkdir(h, cookie, "s2", dir)).status, 201);
    const job = await send(h, "POST", "/api/ops/jobs", cookie, { op: "copy", items: [{ node: "s1", path: "/big" }], dst: { node: "s2", dir }, conflict: "skip" });
    assert.equal(job.status, 202, job.text);
    assert.equal((await jobEnd(h, cookie, job.json.id)).state, "done");
    assert.ok(s2.entries.has(`${dir}/big/f05.txt`));
  }
  // the system administrator's epoch rises in the store (no `changed`): its running job stops at the next call
  bigFolder(s1, 30);
  s2.writeMs = 50;
  const id = await longCopy(h, admin, s2);
  h.auth!.accounts.bumpEpoch("sys", "sadmin");
  const written = s2.writes;
  const again = await signIn(h, "sadmin");
  const end = await jobEnd(h, again, id);
  assert.equal(end.state, "failed");
  assert.match(end.error ?? "", new RegExp(NO_ACCESS));
  assert.ok(s2.writes <= written + 1, `the copy went on: ${s2.writes} files, ${written} at the rise`);
  // signed in again, at the new epoch, the administrator uses every source
  assert.equal((await mkdir(h, again, "s1", "/after-rise")).status, 201);
});

/** A request body that sends `first`, then holds until `release()`, then sends `rest` and ends. `cancelled` turns true when its reader gives up. */
function heldBody(first: Uint8Array, rest: Uint8Array): { body: ReadableStream<Uint8Array>; release: () => void; cancelled: () => boolean } {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let sent = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(first),
    pull: async (c) => {
      if (sent) return;
      sent = true;
      await held;
      c.enqueue(rest);
      c.close();
    },
    cancel: () => {
      cancelled = true;
    },
  });
  return { body, release, cancelled: () => cancelled };
}
/** A proxied request with a streamed body, not awaited. */
function streamed(h: Hub, method: string, p: string, cookie: string, body: ReadableStream<Uint8Array>, type = "application/octet-stream"): Promise<Response> {
  return Promise.resolve(h.request("https://localhost" + p, { method, headers: { cookie, "content-type": type }, body, duplex: "half" } as RequestInit, peer as never));
}

test("an upload to a source in flight when the grant goes fails, and nothing of it stays on the source", async () => {
  const { h, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s2: { write: true } });
  const guest = await signIn(h, "guest");
  const admin = await signIn(h, "sadmin");
  const b = heldBody(new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2));
  const up = streamed(h, "PUT", "/api/nodes/s2/api/fs/upload?dir=/&name=up.bin", guest, b.body);
  await until("the upload to reach the source", () => s2.started === 1);
  const off = await send(h, "PATCH", "/api/admin/accounts/guest", admin, { sources: {} });
  assert.equal(off.status, 200, off.text);
  b.release();
  const r = await up;
  await r.body?.cancel().catch(() => undefined);
  assert.notEqual(r.status, 201, "the upload finished after the grant went");
  await sleep(50);
  assert.equal(s2.writes, 0);
  assert.deepEqual(s2.paths(), ["/", "/d", "/d/inner.txt", "/f.txt"]);
});

test("a download from a source in flight when the account changes is cut", async () => {
  const { h, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s2: { write: false } });
  const size = 1024 * 1024;
  s2.put("/big.bin", "x".repeat(size));
  s2.readMs = 20;
  const guest = await signIn(h, "guest");
  const admin = await signIn(h, "sadmin");
  const r = await h.request("https://localhost/api/nodes/s2/api/fs/download?path=/big.bin", { headers: { cookie: guest } }, peer as never);
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  let got = (await reader.read()).value?.length ?? 0;
  assert.ok(got > 0);
  assert.equal((await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "guest" })).status, 200);
  let failed = false;
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      got += c.value.length;
    }
  } catch {
    failed = true;
  }
  assert.ok(got < size, `the whole file came through: ${got} bytes`);
  assert.ok(failed, "the cut download ended as if complete");
});

/** A fake agent: answers the lookups and the job list; an upload is read slowly and recorded as finished or cut. */
async function fakeAgent(): Promise<{ url: string; uploads: { started: number; finished: number; cut: number }; close: () => void }> {
  const uploads = { started: 0, finished: 0, cut: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/healthz") return void res.end("ok");
    if (u.pathname === "/api/auth/lookup") return void res.end(JSON.stringify({ exists: true }));
    if (u.pathname === "/api/jobs") return void res.end(JSON.stringify({ jobs: [] }));
    if (u.pathname === "/api/fs/upload") {
      uploads.started++;
      req.on("data", () => undefined);
      req.on("end", () => {
        uploads.finished++;
        res.statusCode = 201;
        res.end(JSON.stringify({ path: "/up.bin" }));
      });
      req.on("close", () => {
        if (!req.complete) uploads.cut++;
      });
      return;
    }
    res.end(JSON.stringify({ entries: [] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    uploads,
    close: () => {
      srv.close();
      srv.closeAllConnections();
    },
  };
}

test("an upload to a machine in flight when the account changes is cut at the hub, at once", async () => {
  const agent = await fakeAgent();
  try {
    const { h } = world(`a=${agent.url}`);
    h.auth!.accounts.update("guest", { nodes: { a: { runAs: "nobody", grants: [{ path: "/", write: true }] } } });
    const guest = await signIn(h, "guest");
    const admin = await signIn(h, "sadmin");
    const b = heldBody(new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2));
    const up = streamed(h, "PUT", "/api/nodes/a/api/fs/upload?dir=/&name=up.bin", guest, b.body);
    await until("the upload to reach the machine", () => agent.uploads.started === 1);
    assert.equal((await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "guest" })).status, 200);
    await until("the machine to see the upload cut", () => agent.uploads.cut === 1, 2_000);
    b.release();
    const r = await up;
    await r.body?.cancel().catch(() => undefined);
    assert.notEqual(r.status, 201);
    assert.equal(agent.uploads.finished, 0);
  } finally {
    agent.close();
  }
});

test("system user sources: an administrator demoted while the request runs is refused, also just before the transaction", async () => {
  const { h, grants } = world();
  const accounts = h.auth!.accounts;
  const vadmin = await signIn(h, "vadmin");
  // a slow body: the request guard reads a JSON body before the admin gate, so the gate sees the flag gone
  const text = new TextEncoder().encode(JSON.stringify({ sources: { s1: { write: true } } }));
  const b = heldBody(text.subarray(0, 5), text.subarray(5));
  const put = streamed(h, "PUT", "/api/admin/system/alice/sources", vadmin, b.body, "application/json");
  await sleep(100);
  // the flag goes straight in the store: no epoch rise, so the session itself stays valid
  accounts.update("vadmin", { admin: false });
  b.release();
  const r = await put;
  assert.equal(r.status, 403, await r.text());
  assert.deepEqual(grants.forAccount("sys", "alice"), {});
  // past the gate, the flag goes just before the route's store transaction (as another hub could take it away): the check inside it refuses
  accounts.update("vadmin", { admin: true });
  const tx = accounts.tx.bind(accounts);
  accounts.tx = <T>(fn: () => T): T => {
    accounts.tx = tx;
    accounts.update("vadmin", { admin: false });
    return tx(fn);
  };
  const late = await send(h, "PUT", "/api/admin/system/alice/sources", vadmin, { sources: { s1: { write: true } } });
  accounts.tx = tx;
  assert.equal(late.status, 403, late.text);
  assert.deepEqual(late.json, { error: "administrators only" });
  assert.deepEqual(grants.forAccount("sys", "alice"), {});
});

test("system user sources: the epoch rises in the transaction, so the old sessions end even when accountChanged fails after it", async () => {
  const { h, grants } = world();
  const admin = await signIn(h, "sadmin");
  const alice = await signIn(h, "alice");
  h.accountChanged = async () => {
    throw new Error("the hub stopped after the commit");
  };
  const r = await send(h, "PUT", "/api/admin/system/alice/sources", admin, { sources: { s1: { write: true } } });
  assert.notEqual(r.status, 200);
  assert.deepEqual(grants.forAccount("sys", "alice"), { s1: { write: true } });
  assert.equal((await send(h, "GET", "/api/nodes", alice)).status, 401);
});

test("a transfer in flight when the account changes is cut: the file being written fails and nothing of it stays", async () => {
  const { h, s1, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  s1.put("/big.bin", "y".repeat(1024 * 1024));
  s1.readMs = 20;
  const guest = await signIn(h, "guest");
  const admin = await signIn(h, "sadmin");
  const tr = send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/big.bin" }, dst: { node: "s2", dir: "/" } });
  await until("the transfer to reach the destination", () => s2.started === 1);
  assert.equal((await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "guest" })).status, 200);
  const r = await tr;
  assert.notEqual(r.status, 201, r.text);
  await sleep(50);
  assert.equal(s2.writes, 0);
  assert.ok(!s2.entries.has("/big.bin"));
});

test("calls that end on their own are forgotten: none stays tracked", async () => {
  const { h, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s2: { write: true } });
  const guest = await signIn(h, "guest");
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/list?path=/", guest)).status, 200);
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/download?path=/f.txt", guest)).text, "file in s2");
  assert.equal((await send(h, "PUT", "/api/nodes/s2/api/fs/upload?dir=/&name=ok.txt", guest, undefined, "fine")).status, 201);
  assert.equal((await send(h, "GET", "/api/nodes/s2/api/fs/stat?path=/missing", guest)).status, 404);
  assert.equal((await send(h, "POST", "/api/transfer", guest, { src: { node: "s2", path: "/f.txt" }, dst: { node: "s2", dir: "/d" } })).status, 201);
  // a download whose reader gives up early
  const r = await h.request("https://localhost/api/nodes/s2/api/fs/download?path=/f.txt", { headers: { cookie: guest } }, peer as never);
  await r.body?.cancel();
  await sleep(20);
  assert.equal(h.accountCalls.size(), 0);
  assert.equal(s2.entries.get("/ok.txt")?.data.toString(), "fine");
});

test("a transfer the destination refuses without reading closes the source's read stream (read-only, missing folder)", async () => {
  const { h, s1, grants } = world();
  s1.put("/big.bin", "z".repeat(1024 * 1024));
  s1.readMs = 5;
  const guest = await signIn(h, "guest");
  for (const [access, dir, status] of [
    [{ s1: { write: false }, s2: { write: false } }, "/", 403],
    [{ s1: { write: false }, s2: { write: true } }, "/nope", 404],
  ] as const) {
    grants.setForAccount("virt", "guest", access);
    const opened = s1.readsOpened;
    const closed = s1.readsClosed;
    const r = await send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/big.bin" }, dst: { node: "s2", dir } });
    assert.equal(r.status, status, r.text);
    assert.equal(s1.readsOpened, opened + 1);
    await until(`the read stream of the transfer into ${dir} to close`, () => s1.readsClosed === closed + 1, 2_000);
  }
});

test("act as root: switching off cuts the calls made under the switch, and only those", async () => {
  const agent = await fakeAgent();
  try {
    const { h } = world(`a=${agent.url}`);
    const root = await signIn(h, "sadmin");
    const plain = await signIn(h, "sadmin");
    const on = await send(h, "POST", "/api/auth/as-root", root, { password: PW });
    assert.equal(on.status, 200, on.text);
    const b1 = heldBody(new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2));
    const asRoot = streamed(h, "PUT", "/api/nodes/a/api/fs/upload?dir=/&name=root.bin", root, b1.body);
    await until("the root upload to reach the machine", () => agent.uploads.started === 1);
    const b2 = heldBody(new Uint8Array(1000).fill(3), new Uint8Array(1000).fill(4));
    const mine = streamed(h, "PUT", "/api/nodes/a/api/fs/upload?dir=/&name=plain.bin", plain, b2.body);
    await until("the plain upload to reach the machine", () => agent.uploads.started === 2);
    assert.equal((await send(h, "DELETE", "/api/auth/as-root", root)).status, 200);
    await until("the root upload to be cut", () => agent.uploads.cut === 1, 2_000);
    b1.release();
    const r1 = await asRoot;
    await r1.body?.cancel().catch(() => undefined);
    assert.notEqual(r1.status, 201);
    // the same administrator's call without the switch goes on
    b2.release();
    const r2 = await mine;
    assert.equal(r2.status, 201, await r2.text());
    assert.equal(agent.uploads.finished, 1);
    assert.equal(agent.uploads.cut, 1);
  } finally {
    agent.close();
  }
});

test("AccountCalls.endAccount gives how many calls it cut, also when each call forgets itself as it is cut", () => {
  const calls = new AccountCalls();
  for (let i = 0; i < 3; i++) {
    const c = calls.start("virt", "guest");
    c.signal.addEventListener("abort", c.done, { once: true });
  }
  const other = calls.start("virt", "other");
  assert.equal(calls.endAccount("virt", "guest"), 3);
  assert.equal(calls.endAccount("virt", "guest"), 0);
  assert.equal(other.signal.aborted, false);
  assert.equal(calls.size(), 1);
});

test("AccountCalls: a call under an act-as-root switch is cut by endRoot with its key, and at the switch's end at the latest", async () => {
  const calls = new AccountCalls();
  const ends = Date.now() + 80;
  const a = calls.start("sys", "sadmin", { key: "sadmin\n1", until: ends + 60_000 });
  const b = calls.start("sys", "sadmin", { key: "sadmin\n2", until: ends });
  const plain = calls.start("sys", "sadmin");
  assert.equal(calls.endRoot("sadmin", "sadmin\n1"), 1);
  assert.ok(a.signal.aborted);
  assert.ok(!b.signal.aborted && !plain.signal.aborted);
  await until("the switch's end", () => b.signal.aborted, 1_000);
  assert.ok(!plain.signal.aborted);
  for (const c of [a, b, plain]) c.done();
  assert.equal(calls.size(), 0);
});

test("a cut while the source download is still opening: the read stream is closed as soon as it exists", async () => {
  const { h, s1, s2, grants } = world();
  grants.setForAccount("virt", "guest", { s1: { write: false }, s2: { write: true } });
  s1.put("/big.bin", "o".repeat(1024 * 1024));
  s1.readMs = 5;
  s1.openMs = 300;
  const guest = await signIn(h, "guest");
  const admin = await signIn(h, "sadmin");
  const tr = send(h, "POST", "/api/transfer", guest, { src: { node: "s1", path: "/big.bin" }, dst: { node: "s2", dir: "/" } });
  await until("the download to start opening", () => s1.opening === 1);
  assert.equal((await send(h, "POST", "/api/admin/end-sessions", admin, { kind: "virt", name: "guest" })).status, 200);
  const r = await tr;
  assert.notEqual(r.status, 201, r.text);
  await until("the read stream to be opened", () => s1.readsOpened === 1, 2_000);
  await until("the read stream to be closed", () => s1.readsClosed === s1.readsOpened, 2_000);
  assert.equal(s2.started, 0);
});

/**
 * A fake agent with jobs: `POST /api/fs/perms` answers after `permsMs`, and only then makes its job (with the switch's end from the
 * claim, as a real agent does); the job list and the cancel route work on those jobs.
 */
async function jobsAgent(permsMs: number): Promise<{ url: string; asked: () => number; jobs: { id: string; state: string; asRootUntil?: number }[]; cancelled: string[]; close: () => void }> {
  const jobs: { id: string; state: string; asRootUntil?: number }[] = [];
  const cancelled: string[] = [];
  let asked = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", async () => {
      if (u.pathname === "/healthz") return void res.end("ok");
      if (u.pathname === "/api/auth/lookup") return void res.end(JSON.stringify({ exists: true }));
      if (u.pathname === "/api/jobs" && req.method === "GET") return void res.end(JSON.stringify({ jobs }));
      const m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(u.pathname);
      if (m && req.method === "POST") {
        cancelled.push(m[1]!);
        const j = jobs.find((x) => x.id === m[1]);
        if (j) j.state = "canceled";
        return void res.end(JSON.stringify({ id: m[1], state: "canceled" }));
      }
      if (u.pathname === "/api/fs/perms" && req.method === "POST") {
        asked++;
        const claim = verifyClaim(String(req.headers[USER_HEADER] ?? ""), T, Date.now());
        await sleep(permsMs);
        // the job exists whether or not the hub still waits for the answer (a cut call does not stop the agent)
        const id = `perms-${asked}`;
        jobs.push({ id, state: "running", ...(claim?.asRootUntil !== undefined ? { asRootUntil: claim.asRootUntil } : {}) });
        if (!res.destroyed) res.end(JSON.stringify({ job: id }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    asked: () => asked,
    jobs,
    cancelled,
    close: () => {
      srv.close();
      srv.closeAllConnections();
    },
  };
}

test("act as root: a recursive permission change in flight at Stop is waited for, and the job it starts is cancelled", async () => {
  const agent = await jobsAgent(400);
  try {
    const { h } = world(`a=${agent.url}`);
    const root = await signIn(h, "sadmin");
    assert.equal((await send(h, "POST", "/api/auth/as-root", root, { password: PW })).status, 200);
    const perms = send(h, "POST", "/api/nodes/a/api/fs/perms", root, { path: "/srv", mode: "755", recursive: true });
    await until("the change to reach the machine", () => agent.asked() === 1);
    assert.equal((await send(h, "DELETE", "/api/auth/as-root", root)).status, 200);
    await perms;
    assert.equal(agent.jobs.length, 1);
    await until("the root job to be cancelled", () => agent.cancelled.includes("perms-1"), 3_000);
    assert.equal(agent.jobs[0]!.state, "canceled");
  } finally {
    agent.close();
  }
});

test("hub: the calls that start an agent job are known by route", async () => {
  const { startsAgentJob } = (await import("../src/hub.ts")) as unknown as { startsAgentJob: (method: string, rest: string) => boolean };
  for (const [method, rest] of [
    ["POST", "/api/jobs/compress"],
    ["POST", "/api/jobs/extract"],
    ["POST", "/api/jobs/size"],
    ["POST", "/api/fs/perms"],
    ["GET", "/api/du"],
    ["GET", "/api/du?path=/srv"],
  ] as const) assert.equal(startsAgentJob(method, rest), true, `${method} ${rest}`);
  for (const [method, rest] of [
    ["PUT", "/api/fs/upload"],
    ["GET", "/api/fs/download"],
    ["GET", "/api/jobs"],
    ["GET", "/api/fs/perms"],
    ["POST", "/api/fs/mkdir"],
    ["GET", "/api/dux"],
  ] as const) assert.equal(startsAgentJob(method, rest), false, `${method} ${rest}`);
});

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("sign-in off: a transfer or a hub job whose destination fails before reading the body closes the source's read stream", async () => {
  const refusing = http.createServer((req, res) => {
    // answers an upload at once, without reading it
    res.statusCode = req.url?.startsWith("/api/fs/upload") ? 403 : 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(res.statusCode === 403 ? { error: "read-only volume" } : {}));
  });
  await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", r));
  // answers a stat with 404 (nothing there yet) and drops the connection on an upload, unread: the upload call itself fails
  const dropping = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/fs/upload")) return void req.socket.destroy();
    res.statusCode = req.url?.startsWith("/api/fs/stat") ? 404 : 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(res.statusCode === 404 ? { error: "not found" } : {}));
  });
  await new Promise<void>((r) => dropping.listen(0, "127.0.0.1", r));
  try {
    n++;
    const s1 = new MemSource();
    s1.put("/big.bin", "q".repeat(1024 * 1024));
    s1.readMs = 5;
    const h = createHub(
      loadConfig({
        FILEDECK_MODE: "hub",
        FILEDECK_STATIC: tmp,
        NODES: `dead=http://127.0.0.1:${await deadPort()},refusing=http://127.0.0.1:${(refusing.address() as AddressInfo).port},dropping=http://127.0.0.1:${(dropping.address() as AddressInfo).port}`,
        FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
        FILEDECK_VAULT_FILE: path.join(tmp, `vault-${n}.db`),
        FILEDECK_JOBS_FILE: path.join(tmp, `jobs-${n}.db`),
      } as never),
      { s1 },
    );
    hubs.push(h);
    for (const node of ["dead", "refusing", "dropping"]) {
      const closed = s1.readsClosed;
      const r = await h.request("http://localhost/api/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: { node: "s1", path: "/big.bin" }, dst: { node, dir: "/" } }) }, peer as never);
      assert.ok(r.status >= 400, `${node}: ${r.status}`);
      await r.body?.cancel();
      await until(`the read stream of the transfer to ${node} to close`, () => s1.readsClosed === closed + 1, 5_000);
    }
    // a hub job copying to the machine that drops the upload: its read stream is closed too
    const closed = s1.readsClosed;
    const opened = s1.readsOpened;
    const job = await h.request("http://localhost/api/ops/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "copy", items: [{ node: "s1", path: "/big.bin" }], dst: { node: "dropping", dir: "/" }, conflict: "skip" }) }, peer as never);
    assert.equal(job.status, 202);
    const id = ((await job.json()) as { id: string }).id;
    for (const end = Date.now() + 10_000; ; ) {
      const v = (await (await h.request(`http://localhost/api/ops/jobs/${id}`, {}, peer as never)).json()) as { state: string };
      if (!["queued", "running", "paused", "waiting"].includes(v.state)) break;
      assert.ok(Date.now() < end, "the job did not end");
      await sleep(20);
    }
    assert.ok(s1.readsOpened > opened, "the job's copy read the source");
    await until("the read streams of the job's copy to close", () => s1.readsClosed - closed === s1.readsOpened - opened, 5_000);
  } finally {
    for (const srv of [refusing, dropping]) {
      srv.close();
      srv.closeAllConnections();
    }
  }
});

test("source app: a download aborted while the backend is still opening it destroys the stream at once (and a hash too)", async () => {
  const s = new MemSource();
  s.put("/big.bin", "w".repeat(1024 * 1024));
  s.readMs = 5;
  s.openMs = 200;
  const app = createSourceApp("mem", s, { maxUpload: 1 << 30, maxEdit: 1 << 20, hashConcurrency: 2, walkMaxEntries: 1000 });
  for (const rest of ["/api/fs/download?path=/big.bin", "/api/fs/hash?path=/big.bin"]) {
    const ac = new AbortController();
    const opening = s.opening;
    const r = Promise.resolve(app.fetch(new Request("http://source" + rest, { signal: ac.signal }))).catch(() => undefined);
    await until("the read to start opening", () => s.opening === opening + 1);
    ac.abort();
    await r; // (the answer, if any, is never read)
    await until(`the read stream of ${rest} to close`, () => s.readsClosed === s.readsOpened, 2_000);
  }
});
