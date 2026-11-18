import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { hashPassword } from "../src/auth/store.ts";
import { SourceGrants } from "../src/auth/source-grants.ts";
import { FsError } from "../src/fsops.ts";
import type { SystemAuth } from "../src/auth/routes.ts";
import type { Identity } from "../src/auth/identity.ts";
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
    return Readable.from([range ? e.data.subarray(range.start, range.end + 1) : e.data]);
  }
  async write(p: string, body: Readable, o: { overwrite: boolean; mtime?: number }): Promise<number> {
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
function world(): World {
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
      NODES: "",
      FILEDECK_ADMINS: "sadmin",
      FILEDECK_AUTH_FILE: path.join(tmp, `auth-${n}.db`),
      FILEDECK_DIFF_DIR: path.join(tmp, `diff-${n}`),
      FILEDECK_VAULT_FILE: path.join(tmp, `vault-${n}.db`),
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
