import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthDb, Accounts, AccountError, bootstrapAdmin, checkPassword, hashPassword } from "../src/auth/store.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fd-authstore-"));

test("hash and check", () => {
  const h = hashPassword("pw");
  assert.match(h, /^scrypt\$15\$8\$1\$[^$]+\$[^$]+$/);
  assert.equal(checkPassword("pw", h), true);
  assert.equal(checkPassword("nope", h), false);
  assert.equal(checkPassword("x", null), false);
  assert.equal(checkPassword("x", "garbage"), false);
});

test("names", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  for (const n of ["Root", "root", "a b", "x".repeat(33)]) {
    assert.throws(() => acc.create({ name: n, password: "p", admin: false, nodes: {} }), (e: unknown) => e instanceof AccountError && e.message === "invalid name");
  }
  acc.create({ name: "guest1", password: "p", admin: false, nodes: { n1: { runAs: "u", grants: [{ path: "/a", write: true }] } } });
  assert.throws(() => acc.create({ name: "guest1", password: "p", admin: false, nodes: {} }), (e: unknown) => e instanceof AccountError && e.message === "exists");
  const a = acc.get("guest1");
  assert.equal(a?.admin, false);
  assert.equal(a?.nodes.n1?.runAs, "u");
  assert.equal(checkPassword("p", a?.passwordHash ?? null), true);
  assert.equal(acc.get("nobody"), undefined);
});

test("epoch", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  acc.create({ name: "guest1", password: "p", admin: false, nodes: {} });
  assert.equal(acc.bumpEpoch("virt", "guest1"), 1);
  assert.equal(acc.bumpEpoch("virt", "guest1"), 2);
  assert.equal(acc.epochOf("virt", "guest1"), 2);
  assert.equal(acc.epochOf("sys", "alice"), 0);
  assert.equal(acc.bumpEpoch("sys", "alice"), 1);
  assert.equal(acc.epochOf("sys", "alice"), 1);
  assert.deepEqual(acc.identity("virt", "guest1"), { kind: "virt", name: "guest1", admin: false, epoch: 2, nodes: {} });
  assert.equal(acc.identity("virt", "none"), undefined);
});

test("keys", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  acc.create({ name: "k1", admin: false, nodes: {} });
  assert.deepEqual(acc.keys("k1"), []);
  acc.addKey("k1", "ssh-ed25519 AAAA one");
  assert.deepEqual(acc.keys("k1"), ["ssh-ed25519 AAAA one"]);
  assert.equal(acc.get("k1")?.passwordHash, null);
});

test("hubId stable and file mode", () => {
  const dir = path.join(tmp(), "sub");
  const file = path.join(dir, "auth.db");
  const a = new AuthDb(file);
  const id = a.hubId;
  assert.match(id, /^[0-9a-f]{32}$/);
  a.close();
  const b = new AuthDb(file);
  assert.equal(b.hubId, id);
  b.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.notEqual(new AuthDb(":memory:").hubId, id);
});

test("bootstrap", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  const f = path.join(tmp(), "admin.json");
  fs.writeFileSync(f, JSON.stringify({ name: "admin", passwordHash: hashPassword("pw") }));
  bootstrapAdmin(acc, undefined);
  bootstrapAdmin(acc, f);
  const a = acc.get("admin");
  assert.equal(a?.admin, true);
  assert.deepEqual(a?.nodes, {});
  assert.equal(checkPassword("pw", a?.passwordHash ?? null), true);
  acc.bumpEpoch("virt", "admin");
  bootstrapAdmin(acc, f);
  assert.equal(acc.epochOf("virt", "admin"), 1);
});

test("missing account", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  assert.throws(() => acc.addKey("ghost", "ssh-ed25519 AAAA x"), (e: unknown) => e instanceof AccountError && e.message === "no such account");
  assert.throws(() => acc.bumpEpoch("virt", "ghost"), (e: unknown) => e instanceof AccountError && e.message === "no such account");
});

test("bootstrap refuses a bad hash", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  const f = path.join(tmp(), "admin.json");
  fs.writeFileSync(f, JSON.stringify({ name: "admin", passwordHash: "plaintext" }));
  assert.throws(() => bootstrapAdmin(acc, f), /not a scrypt hash/);
  assert.equal(acc.get("admin"), undefined);
});

test("bootstrap: a file that is not JSON gives a fixed message without its content", () => {
  const d = tmp();
  const f = path.join(d, "admin.json");
  fs.writeFileSync(f, '{"name":"admin","passwordHash":"secret-ish-content');
  const acc = new Accounts(new AuthDb(":memory:"));
  assert.throws(
    () => bootstrapAdmin(acc, f),
    (e: unknown) => e instanceof Error && e.message === "FILEDECK_BOOTSTRAP_ADMIN_FILE is not valid JSON" && !String(e.stack).includes("secret-ish"),
  );
  fs.rmSync(d, { recursive: true, force: true });
});
