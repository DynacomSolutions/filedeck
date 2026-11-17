import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import { Vault, normPath } from "../src/vault.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET = "vault-pw: s3cr3t / unicode!";
const KEY = "unit-test-vault-key-for-crypto-tests";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-vault-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function clocked(extra: Partial<ConstructorParameters<typeof Vault>[0]> = {}) {
  const c = { t: 1_000_000 };
  const v = new Vault({ ttlMs: 30 * MIN, maxMs: 24 * HOUR, now: () => c.t, ...extra });
  return { v, c };
}

test("normPath", () => {
  assert.equal(normPath("/a//b/./c/"), "/a/b/c");
  assert.equal(normPath(""), "/");
});

test("sliding TTL: each use refreshes the expiry", () => {
  const { v, c } = clocked();
  const e = v.put("n", "/f/a.zip", SECRET);
  assert.equal(e.remembered, false);
  assert.equal(e.expiresAt, c.t + 30 * MIN);
  c.t += 20 * MIN;
  assert.equal(v.get("n", "/f/a.zip")?.password, SECRET); // use at +20: now good until +50
  c.t += 20 * MIN; // +40: past the original 30 minutes, inside the refreshed window
  assert.equal(v.get("n", "/f/a.zip")?.password, SECRET);
  c.t += 31 * MIN; // idle longer than the TTL
  assert.equal(v.get("n", "/f/a.zip"), undefined);
  assert.equal(v.list().length, 0, "expired entries are purged");
});

test("settings extension refreshes idle expiry but cannot bypass the absolute cap", () => {
  const { v, c } = clocked({ ttlMs: 30 * MIN, maxMs: HOUR });
  const e = v.put("n", "/f/a.zip", SECRET);
  c.t += 20 * MIN;
  const extended = v.extend(e.id)!;
  assert.equal(extended.expiresAt, c.t + 30 * MIN);
  c.t = 1_000_000 + 40 * MIN; // renew before the current idle expiry at +50
  const capped = v.extend(e.id)!;
  assert.equal(capped.expiresAt, 1_000_000 + HOUR);
  c.t = 1_000_000 + HOUR + 1;
  assert.equal(v.extend(e.id), undefined, "the absolute cap cannot be extended");
});

test("settings extension cannot revive an entry after idle expiry", () => {
  const { v, c } = clocked({ ttlMs: 30 * MIN, maxMs: HOUR });
  const e = v.put("n", "/f/a.zip", SECRET);
  c.t += 31 * MIN;
  assert.equal(v.extend(e.id), undefined, "an expired entry cannot be renewed");
});

test("absolute cap: constant use cannot keep an expiring entry past 24 hours", () => {
  const { v, c } = clocked();
  const start = c.t;
  v.put("n", "/f/a.zip", SECRET);
  for (let i = 0; i < 49; i++) {
    c.t += 29 * MIN; // always inside the sliding window
    assert.ok(v.get("n", "/f/a.zip"), `still valid at ${i}`);
  }
  assert.ok(c.t - start < 24 * HOUR);
  const view = v.list()[0]!;
  assert.equal(view.expiresAt, start + 24 * HOUR, "expiry is clamped to created + 24h");
  c.t = start + 24 * HOUR + 1;
  assert.equal(v.get("n", "/f/a.zip"), undefined);
});

test("remember: kept indefinitely, no expiry, survives purge", () => {
  const { v, c } = clocked();
  const e = v.put("n", "/f/a.zip", SECRET, { remember: true });
  assert.equal(e.remembered, true);
  assert.equal(e.expiresAt, null);
  c.t += 400 * 24 * HOUR;
  assert.equal(v.purge(), 0);
  assert.equal(v.get("n", "/f/a.zip")?.password, SECRET);
  assert.equal(v.list()[0]!.expiresAt, null);
});

test("typing a password again replaces the entry and restarts its lifetime", () => {
  const { v, c } = clocked();
  v.put("n", "/a.zip", "old", { remember: true });
  c.t += HOUR;
  v.put("n", "/a.zip", "new");
  assert.equal(v.list().length, 1);
  assert.equal(v.list()[0]!.remembered, false);
  assert.equal(v.get("n", "/a.zip")?.password, "new");
});

test("folder scope covers files below it; the nearest folder wins; file entry wins over folder", () => {
  const { v } = clocked();
  v.put("n", "/docs", "folder-pw", { scope: "folder" });
  v.put("n", "/docs/deep", "deep-pw", { scope: "folder" });
  v.put("n", "/docs/deep/own.zip", "own-pw");
  assert.equal(v.get("n", "/docs/x.zip")?.password, "folder-pw");
  assert.equal(v.get("n", "/docs/deep/y.zip")?.password, "deep-pw");
  assert.equal(v.get("n", "/docs/deep/own.zip")?.password, "own-pw");
  assert.equal(v.get("n", "/other/x.zip"), undefined);
  assert.equal(v.get("m", "/docs/x.zip"), undefined, "scoped to the node");
});

test("file identity fallback: inode+size finds the entry after a rename", () => {
  const { v } = clocked();
  v.put("n", "/a/old name.zip", SECRET, { fid: "123:456" });
  assert.equal(v.get("n", "/b/new name.zip"), undefined);
  assert.equal(v.get("n", "/b/new name.zip", "123:456")?.password, SECRET);
  assert.equal(v.get("n", "/b/new name.zip", "999:456"), undefined);
});

test("forget by id, by path (covers beneath and above) and all", () => {
  const { v } = clocked();
  const a = v.put("n", "/a/1.zip", "1");
  v.put("n", "/a/2.zip", "2");
  v.put("n", "/a", "f", { scope: "folder" });
  v.put("n", "/z/3.zip", "3");
  assert.equal(v.forget(a.id), true);
  assert.equal(v.forget(a.id), false);
  // forgetting a file also drops the folder entry that would still unlock it
  assert.equal(v.forgetPath("n", "/a/2.zip"), 2);
  assert.deepEqual(v.list().map((e) => e.path), ["/z/3.zip"]);
  v.put("n", "/y/1.zip", "1");
  v.put("n", "/y/s/2.zip", "2");
  assert.equal(v.forgetPath("n", "/y"), 2, "a folder takes everything beneath it");
  assert.equal(v.forgetAll(), 1);
  assert.equal(v.list().length, 0);
});

test("list never exposes a password", () => {
  const { v } = clocked();
  v.put("n", "/a.zip", SECRET);
  assert.ok(!JSON.stringify(v.list()).includes(SECRET));
  assert.deepEqual(Object.keys(v.list()[0]!).sort(), ["createdAt", "expiresAt", "id", "lastUsed", "node", "path", "remembered", "scope"]);
});

test("encrypted at rest: the file holds no plaintext, survives a restart, and a different key cannot read it", () => {
  const file = path.join(dir, "v1", "vault.sqlite");
  const a = new Vault({ file, secret: KEY });
  assert.equal(a.persistent, true);
  a.put("n", "/secret/path.zip", SECRET, { remember: true });
  a.close();
  const raw = Buffer.concat(fs.readdirSync(path.dirname(file)).map((n) => fs.readFileSync(path.join(path.dirname(file), n))));
  assert.ok(!raw.includes(Buffer.from(SECRET)) && !raw.includes(Buffer.from(SECRET).toString("base64")), "no plaintext or base64 of the password in the db or its WAL");
  assert.ok(raw.includes(Buffer.from("/secret/path.zip")), "locations are not secret, passwords are");
  assert.equal(fs.statSync(file).mode & 0o077, 0, "db file is private");
  const b = new Vault({ file, secret: KEY });
  assert.equal(b.get("n", "/secret/path.zip")?.password, SECRET);
  b.close();
  const wrong = new Vault({ file, secret: KEY + "-rotated" });
  assert.equal(wrong.get("n", "/secret/path.zip"), undefined, "a rotated key cannot decrypt old rows");
  assert.equal(wrong.list().length, 0, "the unreadable row was dropped");
  wrong.close();
});

test("a tampered ciphertext (row moved to another id) is rejected", () => {
  const file = path.join(dir, "v2", "vault.sqlite");
  const a = new Vault({ file, secret: KEY });
  const e1 = a.put("n", "/one.zip", "pw-one", { remember: true });
  a.put("n", "/two.zip", "pw-two", { remember: true });
  a.close();
  const { DatabaseSync } = require_sqlite();
  const db = new DatabaseSync(file);
  const blob = (db.prepare("SELECT blob FROM entries WHERE id = ?").get(e1.id) as { blob: Uint8Array }).blob;
  db.prepare("UPDATE entries SET blob = ? WHERE path = '/two.zip'").run(blob);
  db.close();
  const b = new Vault({ file, secret: KEY });
  assert.equal(b.get("n", "/two.zip"), undefined);
  b.close();
});
function require_sqlite() {
  return process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
}

test("without a key the vault is memory only", () => {
  const v = new Vault({ file: path.join(dir, "never", "vault.sqlite") });
  assert.equal(v.persistent, false);
  v.put("n", "/a.zip", "x");
  assert.equal(fs.existsSync(path.join(dir, "never")), false);
  assert.throws(() => new Vault({ secret: "short" }));
});

test("owners: each account sees and uses only its own entries; ownerless entries serve nobody with an owner", () => {
  const { v } = clocked();
  const a = v.put("n", "/same.zip", "pw-a", { owner: "virt:a" });
  const b = v.put("n", "/same.zip", "pw-b", { owner: "sys:b" });
  v.put("n", "/same.zip", "pw-none"); // made with auth off
  v.put("n", "/dir", "pw-a-folder", { scope: "folder", owner: "virt:a" });
  assert.notEqual(a.id, b.id, "two accounts keep two entries for one file");
  assert.equal(v.get("n", "/same.zip", undefined, true, "virt:a")?.password, "pw-a");
  assert.equal(v.get("n", "/same.zip", undefined, true, "sys:b")?.password, "pw-b");
  assert.equal(v.get("n", "/dir/x.zip", undefined, true, "sys:b"), undefined, "another account's folder entry is not used");
  assert.equal(v.get("n", "/other.zip", undefined, true, "virt:c"), undefined);
  assert.equal(v.hasNode("n", "virt:c"), false);
  assert.equal(v.hasNode("n", "virt:a"), true);
  assert.deepEqual(v.list("sys:b").map((e) => e.id), [b.id]);
  assert.equal(v.list("virt:c").length, 0, "an ownerless entry is listed to no account");
  assert.equal(v.list().length, 4, "auth off: every entry, as before");
  assert.equal(v.extend(a.id, "sys:b"), undefined, "another account cannot extend it");
  assert.equal(v.forget(a.id, "sys:b"), false, "nor forget it");
  assert.equal(v.forgetPath("n", "/same.zip", "sys:b"), 1, "forget by path takes only the caller's own");
  assert.equal(v.get("n", "/same.zip", undefined, true, "virt:a")?.password, "pw-a");
  assert.equal(v.forgetAll("virt:a"), 2, "forget all takes only the caller's own");
  assert.deepEqual(v.list().map((e) => e.path), ["/same.zip"], "the ownerless entry is left");
  assert.equal(v.get("n", "/same.zip")?.password, "pw-none");
});

test("owners: a vault file made before owners existed is moved over, its entries kept without an owner", () => {
  const file = path.join(dir, "v-old", "vault.sqlite");
  const a = new Vault({ file, secret: KEY });
  a.put("n", "/old.zip", "old-pw", { remember: true });
  a.close();
  // turn the file back into the old layout: no owner column, one entry per node, scope and path
  const { DatabaseSync } = require_sqlite();
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE old_entries (id TEXT PRIMARY KEY, node TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, fid TEXT, remembered INTEGER NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, blob BLOB NOT NULL, UNIQUE (node, scope, path));
    INSERT INTO old_entries SELECT id, node, scope, path, fid, remembered, created, last_used, blob FROM entries;
    DROP TABLE entries;
    ALTER TABLE old_entries RENAME TO entries;
    CREATE INDEX entries_fid ON entries (node, fid);
  `);
  db.close();
  const b = new Vault({ file, secret: KEY });
  assert.equal(b.get("n", "/old.zip")?.password, "old-pw", "auth off still finds it");
  assert.equal(b.get("n", "/old.zip", undefined, true, "virt:a"), undefined, "no account owns it");
  b.put("n", "/old.zip", "a-pw", { owner: "virt:a" });
  assert.equal(b.get("n", "/old.zip", undefined, true, "virt:a")?.password, "a-pw");
  b.put("n", "/old.zip", "new-pw");
  assert.equal(b.list().length, 2, "auth off replaces the ownerless entry, not the account's");
  b.close();
  const c = new Vault({ file, secret: KEY });
  assert.equal(c.list().length, 2, "a second open changes nothing");
  c.close();
});

test("owners: a put that meets a row another process added replaces it, one row per owner and place", () => {
  const file = path.join(dir, "v-race", "vault.sqlite");
  const a = new Vault({ file, secret: KEY });
  const b = new Vault({ file, secret: KEY });
  a.put("n", "/r.zip", "from-a", { owner: "virt:a" });
  b.put("n", "/r.zip", "from-b", { owner: "virt:a" });
  a.put("n", "/r.zip", "none-a");
  b.put("n", "/r.zip", "none-b");
  assert.equal(a.list().length, 2, "one row for the owner, one without an owner");
  assert.equal(a.get("n", "/r.zip", undefined, true, "virt:a")?.password, "from-b");
  assert.equal(a.get("n", "/r.zip", undefined, true, "virt:b"), undefined);
  a.close();
  b.close();
});

test("owners: an old file opened after another process moved it over is not copied again", () => {
  const file = path.join(dir, "v-twice", "vault.sqlite");
  const a = new Vault({ file, secret: KEY });
  a.put("n", "/kept.zip", "pw", { owner: "virt:a" });
  a.close();
  const b = new Vault({ file, secret: KEY });
  assert.equal(b.get("n", "/kept.zip", undefined, true, "virt:a")?.password, "pw", "the owner survives a second open");
  b.close();
});

/* ------------------------------------------------------------ hub flow (live) */

const HAVE = spawnSync("bsdtar", ["--version"]).status === 0 && haveSevenZip();
const need = { skip: HAVE ? false : "bsdtar and 7zz needed" };

test("hub: a typed password is saved, reused without the client sending it, and forgotten on request", need, async () => {
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/hello.txt"), "hello vault");
  const open = (app: { fetch: unknown }) =>
    new Promise<ReturnType<typeof serve>>((res) => {
      const s: ReturnType<typeof serve> = serve({ fetch: app.fetch as never, port: 0 }, () => res(s));
    });
  const agentSrv = await open(createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never)));
  const audits: string[] = [];
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=http://127.0.0.1:${(agentSrv.address() as AddressInfo).port}`, FILEDECK_STATIC: dir, FILEDECK_VAULT_KEY: KEY, FILEDECK_VAULT_FILE: path.join(dir, "hub", "vault.sqlite") } as never), undefined, (l) => audits.push(l));
  const hubSrv = await open(hub);
  const base = `http://127.0.0.1:${(hubSrv.address() as AddressInfo).port}`;
  try {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const sz = process.env.FILEDECK_7Z || "7zz";
    const mk = (name: string) => {
      const r = spawnSync(sz, ["a", "-tzip", "-mem=AES256", "-p", "-spd", path.join(root, "docs", name), "hello.txt"], { cwd: path.join(root, "docs"), input: `${SECRET}\n${SECRET}\n` });
      assert.equal(r.status, 0);
    };
    mk("one.zip");
    mk("two.zip");
    mk("three.zip");
    const list = (p: string, h: Record<string, string> = {}) => fetch(`${base}/api/nodes/t/api/archive/list?path=${encodeURIComponent(p)}`, { headers: h });

    // nothing saved: no password still lists names (zip), extraction asks
    const ext = (p: string, h: Record<string, string> = {}, body: object = {}) =>
      fetch(`${base}/api/nodes/t/api/jobs/extract`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ path: p, destDir: "/docs", subfolder: true, ...body }) });
    assert.equal((await ext("/docs/one.zip")).status, 401);

    // wrong password: rejected and NOT saved
    const wrong = await ext("/docs/one.zip", { "x-filedeck-password": b64("nope") });
    assert.equal(wrong.status, 401);
    assert.equal((await hub.vault.list()).length, 0);

    // right password, default: saved with an expiry (sliding), never echoed
    const ok = await ext("/docs/one.zip", { "x-filedeck-password": b64(SECRET) });
    assert.equal(ok.status, 202);
    assert.equal(ok.headers.get("x-filedeck-pw"), null, "internal header is not leaked to the browser");
    const entries = (await (await fetch(`${base}/api/vault`)).json()) as { entries: { path: string; remembered: boolean; expiresAt: number | null; scope: string }[]; persistent: boolean };
    assert.equal(entries.persistent, true);
    assert.equal(entries.entries.length, 1);
    assert.equal(entries.entries[0]!.path, "/docs/one.zip");
    assert.equal(entries.entries[0]!.remembered, false);
    assert.ok(entries.entries[0]!.expiresAt! > Date.now());

    // later requests carry no password: the hub supplies it
    const again = await list("/docs/one.zip");
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("x-filedeck-pw-source"), "saved");
    const x2 = await ext("/docs/one.zip", {}, { destDir: "/docs", subfolder: true });
    assert.equal(x2.status, 202);
    // another file in the folder is not covered by a file-scope entry
    assert.equal((await ext("/docs/two.zip")).status, 401);

    // remember + folder scope
    const f = await ext("/docs/two.zip", { "x-filedeck-password": b64(SECRET), "x-filedeck-save": "forever", "x-filedeck-scope": "folder" });
    assert.equal(f.status, 202);
    const all = ((await (await fetch(`${base}/api/vault`)).json()) as { entries: { path: string; scope: string; remembered: boolean }[] }).entries;
    assert.ok(all.some((e) => e.scope === "folder" && e.path === "/docs" && e.remembered));
    assert.equal((await ext("/docs/three.zip")).status, 202, "folder entry unlocks the sibling");

    // never in responses, the vault listing, the audit log or the db
    const dump = JSON.stringify(all) + audits.join("\n");
    assert.ok(!dump.includes(SECRET) && !dump.includes(b64(SECRET)));
    const raw = fs.readdirSync(path.join(dir, "hub")).map((n) => fs.readFileSync(path.join(dir, "hub", n))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
    assert.ok(!raw.includes(Buffer.from(SECRET)));

    // Forget saved password (context menu): file and covering folder entry go
    const fr = await fetch(`${base}/api/vault/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: "t", path: "/docs/one.zip" }) });
    assert.deepEqual(await fr.json(), { removed: 2 });
    assert.equal((await ext("/docs/one.zip")).status, 401);
    assert.equal((await ext("/docs/three.zip")).status, 401);
    assert.equal((await fetch(`${base}/api/vault/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: "nope", path: "/x" }) })).status, 400);

    // "do not save": works once, nothing stored
    await ext("/docs/one.zip", { "x-filedeck-password": b64(SECRET), "x-filedeck-save": "no" });
    assert.equal(hub.vault.list().length, 0);

    // a saved password the archive no longer accepts is dropped, and the client is asked again
    hub.vault.put("t", "/docs/one.zip", "stale");
    const stale = await ext("/docs/one.zip");
    assert.equal(stale.status, 401);
    assert.equal(((await stale.json()) as { code: string }).code, "password_required"); // retried without the stale password
    assert.equal(hub.vault.list().length, 0);

    // a folder entry that does not open one particular file is kept (it still serves the rest of the folder)
    hub.vault.put("t", "/docs", "not-for-this-one", { scope: "folder" });
    const guess = await ext("/docs/one.zip");
    assert.equal(guess.status, 401);
    assert.equal(hub.vault.list().length, 1);
    // ...and a listing (names are visible without the password) still works instead of failing on the wrong guess
    assert.equal((await list("/docs/one.zip")).status, 200);
    hub.vault.forgetAll();

    // forget all + per-row
    hub.vault.put("t", "/docs/a.zip", "1");
    const row = hub.vault.put("t", "/docs/b.zip", "2");
    assert.equal((await fetch(`${base}/api/vault/${row.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/api/vault/${row.id}`, { method: "DELETE" })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/vault`, { method: "DELETE" })).json(), { removed: 1 });
  } finally {
    agentSrv.close();
    hubSrv.close();
    await hub.close();
  }
});
