import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { signClaim, USER_HEADER, type UserClaim } from "../src/auth/identity.ts";
import { rootRequests } from "../src/agent-workers.ts";
import { virtOwner } from "../src/account-dirs.ts";
import * as ops from "../src/fsops.ts";
import { applyRetention, deleteItems, listTrash, restoreItems } from "../src/trash.ts";
import { TRASH_DIR, TRASH_OWNER } from "../src/paths.ts";
import { withReadOnly, withoutReadOnly } from "../src/pinwalk.ts";
import { sandboxInfo } from "../src/sandbox.ts";
import type { WorkerSpec } from "../src/worker-pool.ts";
import { useSandboxOrOff } from "./sandbox-env.ts";
import { chownForTest, fakeResolver, privateTmpdir, testAccount } from "./worker-env.ts";

/**
 * One trash folder per account (sign-in part 2, Task 8): a worker moves deleted items into `.filedeck-trash/u<uid>/` (a system account)
 * or `.filedeck-trash/v-<name>/` (a virtual account), which the root process makes for it; it lists and restores only its own folder.
 * The root process (no scope) sees every folder, and its retention covers every folder without walking an account's folder itself.
 */

await useSandboxOrOff();
const IS_ROOT = process.getuid?.() === 0;
const ROOT_ONLY = IS_ROOT ? false : "worker live: skipped (not running as root)";
const landlock = (await sandboxInfo()).state === "landlock";
const NEED = landlock ? false : "sandbox live: skipped (no Landlock on this kernel)";

const T = "agent-secret-trash-owners";
const day = 86_400_000;
const me = testAccount();
let work = "";
let root = "";
let dropTmp = () => {};
let legacyId = "";
type Agent = ReturnType<typeof createAgent>;
let app: Agent;
let cfg: Config;
const BOB = 1234;

before(async () => {
  dropTmp = privateTmpdir();
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-trash-owners-")));
  root = path.join(work, "root");
  for (const d of ["a", "g1", "g2", "c"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["a/x", "a/y", "g1/one", "g2/two", "legacy.txt"]) fs.writeFileSync(path.join(root, f), `${f}\n`);
  fs.chmodSync(work, 0o755);
  chownForTest(root);
  // an item trashed while sign-in was off (by the agent, as root in a root pass): at the top of the trash store
  legacyId = (await withoutReadOnly(() => ops.trash(root, "/legacy.txt"))).id;
  if (IS_ROOT) {
    fs.mkdirSync(path.join(root, "bob"));
    fs.writeFileSync(path.join(root, "bob/f"), "bob\n");
    fs.chownSync(path.join(root, "bob"), BOB, BOB);
    fs.chownSync(path.join(root, "bob/f"), BOB, BOB);
  }
  cfg = loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t", FILEDECK_AGENT_TOKEN: T, FILEDECK_AUTH: "on", FILEDECK_TRASH_SWEEP_MS: "0" } as never);
  app = createAgent(cfg, () => {}, { accounts: fakeResolver({ alice: {}, guest: {}, bob: { uid: BOB, gid: BOB, groups: [BOB] } }) });
});
after(async () => {
  await (app as unknown as { close(): Promise<void> } | undefined)?.close();
  fs.rmSync(work, { recursive: true, force: true });
  dropTmp();
});

const sys = (name = "alice"): UserClaim => ({ kind: "sys", name, epoch: 1, iat: Date.now() });
const virt = (name: string, grant: string): UserClaim => ({ kind: "virt", name, epoch: 1, runAs: "guest", grants: [{ path: grant, write: true }], iat: Date.now() });
const headers = (claim: UserClaim) => ({ authorization: `Bearer ${T}`, [USER_HEADER]: signClaim({ ...claim, iat: Date.now() }, T), "content-type": "application/json" });
const post = (p: string, body: unknown, claim: UserClaim) => app.request(p, { method: "POST", headers: headers(claim), body: JSON.stringify(body) });
const list = async (claim: UserClaim) => {
  const r = await app.request("/api/trash/list", { headers: headers(claim) });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { volumes: { volume: string; items: { id: string; name: string }[] }[] }).volumes;
};
const names = async (claim: UserClaim) => (await list(claim)).flatMap((v) => v.items.map((i) => i.name)).sort();
const trashOf = (folder = "") => path.join(root, TRASH_DIR, folder);
const mode = (p: string) => fs.statSync(p).mode & 0o7777;
const trashIt = async (p: string, claim: UserClaim) => {
  const r = await post("/api/fs/trash", { paths: [p] }, claim);
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { items: { id: string }[] }).items[0]!.id;
};

test("the folder name rule: every name a virtual account's folders get fits the trash owner test", () => {
  for (const n of ["guest1", "a.b-c_d", "Guest One", "x".repeat(40), "élan", "..", "1abc", ""]) assert.ok(TRASH_OWNER.test(`v-${virtOwner(n)}`), n);
  for (const n of ["u0", "u1234", "v-guest1"]) assert.ok(TRASH_OWNER.test(n), n);
  for (const n of ["u", "u-1", "v-", "v-Guest", "v-.x", "x1", "u12345678901", "v-a/b"]) assert.ok(!TRASH_OWNER.test(n), n);
});

test("own folder: a system account's items go to u<uid>, 0700, in a 0711 store; it lists and restores them", async () => {
  const id = await trashIt("/a/x", sys());
  const own = trashOf(`u${me.uid}`);
  assert.ok(fs.statSync(path.join(own, id, "data")).isFile());
  assert.ok(!fs.existsSync(path.join(root, "a/x")));
  assert.equal(mode(trashOf()), 0o711);
  assert.equal(mode(own), 0o700);
  assert.equal(fs.statSync(own).uid, me.uid);
  assert.equal(fs.statSync(trashOf()).uid, process.getuid!());
  const vols = await list(sys());
  assert.deepEqual(vols.map((v) => v.volume), ["/"]);
  assert.deepEqual(vols[0]!.items.map((i) => i.id), [id]);
  const r = await post("/api/trash/restore", { volume: "/", ids: [id] }, sys());
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { results: { ok: boolean }[] }).results[0]!.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "a/x"), "utf8"), "a/x\n");
  assert.deepEqual(await names(sys()), []);
});

test("legacy items: an item trashed with sign-in off moves to u0 and is not listed for an account", async () => {
  await trashIt("/a/y", sys());
  assert.ok(!fs.existsSync(trashOf(legacyId)), "no longer at the top");
  assert.ok(fs.existsSync(path.join(trashOf("u0"), legacyId, "data")));
  assert.equal(mode(trashOf("u0")), 0o700);
  assert.equal(fs.statSync(trashOf("u0")).uid, process.getuid!());
  assert.deepEqual(await names(sys()), ["y"]);
});

test("virtual accounts sharing a runAs: each has its own folder, sees only its items and cannot reach the other's", { skip: NEED }, async () => {
  const g1 = virt("guest1", "/g1");
  const g2 = virt("guest2", "/g2");
  const id1 = await trashIt("/g1/one", g1);
  const id2 = await trashIt("/g2/two", g2);
  assert.ok(fs.existsSync(path.join(trashOf("v-guest1"), id1, "data")));
  assert.ok(fs.existsSync(path.join(trashOf("v-guest2"), id2, "data")));
  assert.equal(mode(trashOf("v-guest1")), 0o700);
  assert.deepEqual(await names(g1), ["one"]);
  assert.deepEqual(await names(g2), ["two"]);
  // the other account's id is not in its own folder
  const r = await post("/api/trash/restore", { volume: "/", ids: [id1] }, g2);
  assert.equal(r.status, 200, await r.clone().text());
  const res = ((await r.json()) as { results: { ok: boolean; error?: string }[] }).results[0]!;
  assert.equal(res.ok, false, "guest2 cannot restore guest1's item");
  // an id that names a folder, and a volume that holds none of its grants, are refused before the routes
  assert.equal((await post("/api/trash/restore", { volume: "/", ids: [`v-guest1/${id1}`] }, g2)).status, 403);
  assert.equal((await post("/api/trash/delete", { volume: "/", ids: [`v-guest1/${id1}`] }, g2)).status, 403);
  assert.equal((await post("/api/trash/empty", { volume: "/c" }, g2)).status, 403);
  assert.ok(fs.existsSync(path.join(trashOf("v-guest1"), id1, "data")));
  // where a restore puts an item comes from its meta.json, which the account can write: outside its grants it is refused
  const meta = path.join(trashOf("v-guest1"), id1, "meta.json");
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), originalPath: "/c/evil" }));
  const e = await post("/api/trash/restore", { volume: "/", ids: [id1] }, g1);
  const er = ((await e.json()) as { results: { ok: boolean; error?: string }[] }).results[0]!;
  assert.equal(er.ok, false);
  assert.match(er.error ?? "", /outside your folders/);
  assert.ok(!fs.existsSync(path.join(root, "c/evil")));
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), originalPath: "/g1/one" }));
  // a system account cannot name another folder either
  const s = await post("/api/trash/delete", { volume: "/", ids: [`v-guest1/${id1}`] }, sys());
  assert.equal(s.status, 400);
  assert.ok(fs.existsSync(path.join(trashOf("v-guest1"), id1, "data")));
});

test("root view: without a scope every folder is listed with <folder>/<id> ids, and retention covers every folder", async () => {
  const fresh = await trashIt("/a/x", sys());
  const vols = await withoutReadOnly(() => listTrash(root, ""));
  const ids = vols.flatMap((v) => v.items.map((i) => i.id));
  assert.ok(ids.includes(`u0/${legacyId}`), ids.join(" "));
  assert.ok(ids.includes(`u${me.uid}/${fresh}`), ids.join(" "));
  if (!NEED) {
    assert.ok(ids.some((i) => i.startsWith("v-guest1/")), ids.join(" "));
    assert.ok(ids.some((i) => i.startsWith("v-guest2/")), ids.join(" "));
  }
  assert.ok(ids.every((i) => /^(u\d+|v-[a-z0-9_.-]+)\/[0-9a-f-]{36}$/.test(i)), ids.join(" "));
  // every item but the fresh one is made old; the sweep removes them in every folder (the accounts' as their owner)
  const age = (folder: string, id: string) => {
    const f = path.join(trashOf(folder), id, "meta.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), deletedAt: Date.now() - 30 * day }));
  };
  for (const i of ids) if (i !== `u${me.uid}/${fresh}`) age(...(i.split("/") as [string, string]));
  const r = await withReadOnly(root, [], () => applyRetention(root, "", { maxAgeDays: 7, maxPercent: 0, maxBytes: 0 }));
  assert.deepEqual(r.map((x) => [x.volume, x.removed, x.failed]), [["/", ids.length - 1, 0]]);
  const left = (await withoutReadOnly(() => listTrash(root, ""))).flatMap((v) => v.items.map((i) => i.id));
  assert.deepEqual(left, [`u${me.uid}/${fresh}`]);
  for (const f of fs.readdirSync(trashOf())) assert.ok(TRASH_OWNER.test(f), `only owner folders at the top: ${f}`);
  for (const f of fs.readdirSync(trashOf())) if (f !== `u${me.uid}`) assert.deepEqual(fs.readdirSync(trashOf(f)), [], `${f} is empty`);
});

test("root view: an account's item is restored and deleted without a scope; what is left of it is removed as its owner", async () => {
  fs.writeFileSync(path.join(root, "a/z"), "a/z\n");
  chownForTest(path.join(root, "a/z"));
  const id = await trashIt("/a/z", sys());
  const own = `u${me.uid}`;
  const [res] = await withoutReadOnly(() => restoreItems(root, "/", [`${own}/${id}`]));
  assert.equal(res!.ok, true, res!.error);
  assert.equal(res!.id, `${own}/${id}`);
  assert.equal(fs.readFileSync(path.join(root, "a/z"), "utf8"), "a/z\n");
  assert.ok(!fs.existsSync(path.join(trashOf(own), id)));
  const id2 = await trashIt("/a/z", sys());
  const [del] = await withoutReadOnly(() => deleteItems(root, "/", [`${own}/${id2}`]));
  assert.equal(del!.ok, true, del!.error);
  assert.ok(!fs.existsSync(path.join(trashOf(own), id2)));
  // ids of a folder that is not an owner folder, or with a path in them, are refused
  await assert.rejects(withoutReadOnly(() => deleteItems(root, "/", [`../${id2}`])), /trash ids/);
  await assert.rejects(withoutReadOnly(() => deleteItems(root, "/", [`u0/x/${id2}`])), /trash ids/);
});

test("retention: the size cap is for the whole store, oldest first across folders", async () => {
  const big = "z".repeat(64 * 1024);
  const made: [string, string][] = [];
  for (const [n, days] of [["c1", 3], ["c2", 2], ["c3", 1]] as const) {
    fs.writeFileSync(path.join(root, "a", n), big);
    chownForTest(path.join(root, "a", n));
    const id = await trashIt(`/a/${n}`, sys());
    const f = path.join(trashOf(`u${me.uid}`), id, "meta.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), deletedAt: Date.now() - days * day }));
    made.push([n, id]);
  }
  const before = (await withoutReadOnly(() => listTrash(root, ""))).flatMap((v) => v.items.map((i) => i.name));
  // two big items and the small ones the earlier tests left fit (each big one takes a little over 64 KiB with its folder and meta.json), so only the oldest goes
  const r = await withReadOnly(root, [], () => applyRetention(root, "", { maxAgeDays: 0, maxPercent: 0, maxBytes: 200 * 1024 }));
  assert.equal(r[0]?.failed, 0);
  assert.equal(r[0]?.removed, 1);
  const after = (await withoutReadOnly(() => listTrash(root, ""))).flatMap((v) => v.items.map((i) => i.name));
  assert.ok(before.includes("c1") && !after.includes("c1"), after.join(" "));
  assert.ok(after.includes("c2") && after.includes("c3"), after.join(" "));
});

test("the root request: the account comes from the worker's spec, the volume must be a real volume root", async () => {
  const handler = rootRequests(cfg, () => {});
  const spec = (kind: "sys" | "virt", folder: string, grants?: { path: string; write: boolean }[]) =>
    ({ key: "k", kind, name: "n", epoch: 1, account: me, init: { cfg, account: { kind, name: "n", uid: me.uid }, trashFolder: folder, ...(grants ? { grants } : {}) } }) as WorkerSpec;
  const ask = (s: WorkerSpec, body: unknown, p = "/_root/trash-dir") => handler(s, new Request(`http://root${p}`, { method: "POST", body: JSON.stringify(body) }));
  // the body's own folder or uid is not used
  const ok = await ask(spec("sys", `u${me.uid}`), { volume: root, folder: "u0", trashFolder: "u0", uid: 0 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { dir: trashOf(`u${me.uid}`) });
  // not a volume root, not a real path, outside the root
  assert.equal((await ask(spec("sys", `u${me.uid}`), { volume: path.join(root, "a") })).status, 400);
  assert.equal((await ask(spec("sys", `u${me.uid}`), { volume: root + "/a/.." })).status, 400);
  assert.equal((await ask(spec("sys", `u${me.uid}`), { volume: work })).status, 400);
  assert.equal((await ask(spec("sys", `u${me.uid}`), {})).status, 400);
  // a virtual account needs a write grant on the volume
  assert.equal((await ask(spec("virt", "v-nogrant", [{ path: "/g1", write: false }]), { volume: root })).status, 403);
  assert.ok(!fs.existsSync(trashOf("v-nogrant")));
  // a folder name the spec cannot have, and other routes
  assert.equal((await ask(spec("sys", "u0"), { volume: root })).status, 403);
  assert.equal((await ask(spec("sys", `u${me.uid}`), { volume: root }, "/_root/other")).status, 404);
  // the route is the worker's only: a client that asks for it reaches the worker, which has no such route
  const r = await app.request("/_root/trash-dir", { method: "POST", headers: headers(sys()), body: JSON.stringify({ volume: root }) });
  assert.equal(r.status, 404);
});

test("the root request: a trash store or account folder that is not safe is refused and left as it is", async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(work, "vol-")));
  const c2 = { ...cfg, root: other };
  const handler = rootRequests(c2, () => {});
  const spec = { key: "k", kind: "sys", name: "n", epoch: 1, account: me, init: { cfg: c2, account: { kind: "sys", name: "n", uid: me.uid }, trashFolder: `u${me.uid}` } } as WorkerSpec;
  const ask = () => handler(spec, new Request("http://root/_root/trash-dir", { method: "POST", body: JSON.stringify({ volume: other }) }));
  try {
    // a link in place of the store
    fs.mkdirSync(path.join(work, "elsewhere"));
    fs.symlinkSync(path.join(work, "elsewhere"), path.join(other, TRASH_DIR));
    const a = await ask();
    assert.equal(a.status, 503);
    assert.match(await a.text(), /trash folder is not safe/);
    assert.deepEqual(fs.readdirSync(path.join(work, "elsewhere")), []);
    fs.unlinkSync(path.join(other, TRASH_DIR));
    // a sticky store is never changed
    fs.mkdirSync(path.join(other, TRASH_DIR));
    fs.chmodSync(path.join(other, TRASH_DIR), 0o1777);
    assert.equal((await ask()).status, 503);
    assert.equal(mode(path.join(other, TRASH_DIR)), 0o1777);
    // a store of our own made 0777 is tightened; an account folder open to others is refused and not changed
    fs.chmodSync(path.join(other, TRASH_DIR), 0o777);
    fs.mkdirSync(path.join(other, TRASH_DIR, `u${me.uid}`));
    fs.chmodSync(path.join(other, TRASH_DIR, `u${me.uid}`), 0o755);
    if (IS_ROOT) fs.chownSync(path.join(other, TRASH_DIR, `u${me.uid}`), me.uid, me.gid);
    const b = await ask();
    assert.equal(b.status, 503);
    assert.match(await b.text(), /trash folder is not safe/);
    assert.equal(mode(path.join(other, TRASH_DIR)), 0o711);
    assert.equal(mode(path.join(other, TRASH_DIR, `u${me.uid}`)), 0o755);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("u<uid> is owned by its account", { skip: ROOT_ONLY }, async () => {
  const id = await trashIt("/bob/f", sys("bob"));
  const own = trashOf(`u${BOB}`);
  assert.equal(fs.statSync(own).uid, BOB);
  assert.equal(mode(own), 0o700);
  assert.equal(fs.statSync(path.join(own, id)).uid, BOB);
  assert.deepEqual(await names(sys("bob")), ["f"]);
});
