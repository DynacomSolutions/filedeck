import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { AuthDb, Accounts, AccountError, bootstrapAdmin, checkPassword, hashPassword } from "../src/auth/store.ts";
import { keyFingerprint } from "../src/auth/sshkey.ts";

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

const wire = (b: Buffer | string) => {
  const d = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  return Buffer.concat([l, d]);
};
function edKey(comment = ""): { line: string; blob: Buffer } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const blob = Buffer.concat([wire("ssh-ed25519"), wire(raw)]);
  return { line: `ssh-ed25519 ${blob.toString("base64")}${comment}`, blob };
}

test("keyFingerprint: SHA256 and unpadded base64 of the blob, as OpenSSH prints it", () => {
  const k = edKey(" me@example");
  const want = "SHA256:" + createHash("sha256").update(k.blob).digest("base64").replace(/=+$/, "");
  assert.equal(keyFingerprint(k.line), want);
  assert.doesNotMatch(want, /=/);
  assert.equal(keyFingerprint(k.line.replace(" me@example", " other")), want, "the comment does not count");
  assert.equal(keyFingerprint("ssh-ed25519 AAAA one"), null);
  assert.equal(keyFingerprint("not a key"), null);
});

test("list returns accounts in name order", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  assert.deepEqual(acc.list(), []);
  acc.create({ name: "zed", password: "p", admin: true, nodes: {} });
  acc.create({ name: "amy", admin: false, nodes: { n1: { runAs: "u", grants: [{ path: "/a", write: false }] } } });
  const l = acc.list();
  assert.deepEqual(
    l.map((a) => a.name),
    ["amy", "zed"],
  );
  assert.equal(l[0]?.passwordHash, null);
  assert.equal(l[0]?.nodes.n1?.runAs, "u");
  assert.equal(l[1]?.admin, true);
  assert.equal(checkPassword("p", l[1]?.passwordHash ?? null), true);
});

test("update: password, admin flag and machines; the epoch stays", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  acc.create({ name: "guest", password: "old password", admin: false, nodes: {} });
  acc.update("guest", { password: null });
  assert.equal(acc.get("guest")?.passwordHash, null);
  acc.update("guest", { password: "a new password" });
  assert.equal(checkPassword("a new password", acc.get("guest")?.passwordHash ?? null), true);
  assert.equal(checkPassword("old password", acc.get("guest")?.passwordHash ?? null), false);
  const nodes = { n1: { runAs: "u", grants: [{ path: "/b", write: true }, { path: "/a", write: false }] } };
  acc.update("guest", { admin: true, nodes });
  const a = acc.get("guest");
  assert.equal(a?.admin, true);
  assert.deepEqual(a?.nodes, nodes);
  assert.equal(checkPassword("a new password", a?.passwordHash ?? null), true, "a patch without password keeps it");
  acc.update("guest", {});
  assert.equal(acc.get("guest")?.admin, true);
  assert.equal(acc.epochOf("virt", "guest"), 0);
  assert.throws(() => acc.update("ghost", { admin: true }), (e: unknown) => e instanceof AccountError && e.message === "no such account");
});

test("removeKey by fingerprint", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  acc.create({ name: "k1", admin: false, nodes: {} });
  const one = edKey(" one");
  const two = edKey(" two");
  acc.addKey("k1", one.line);
  acc.addKey("k1", two.line);
  assert.equal(acc.removeKey("k1", keyFingerprint(two.line)!), true);
  assert.deepEqual(acc.keys("k1"), [one.line]);
  assert.equal(acc.removeKey("k1", keyFingerprint(two.line)!), false);
  assert.equal(acc.removeKey("ghost", keyFingerprint(one.line)!), false);
  assert.equal(acc.removeKey("k1", "SHA256:nope"), false);
  assert.deepEqual(acc.keys("k1"), [one.line]);
});

test("retired epoch", () => {
  const acc = new Accounts(new AuthDb(":memory:"));
  acc.create({ name: "guest", password: "p", admin: true, nodes: {} });
  acc.addKey("guest", edKey().line);
  acc.bumpEpoch("virt", "guest");
  acc.bumpEpoch("virt", "guest");
  acc.remove("guest");
  assert.equal(acc.get("guest"), undefined);
  assert.deepEqual(acc.keys("guest"), []);
  assert.deepEqual(acc.list(), []);
  // a delete raises the epoch once more, so agents see a higher one and stop the old account's workers
  assert.equal(acc.epochOf("virt", "guest"), 3);
  acc.create({ name: "guest", admin: false, nodes: {} });
  // the new account starts above every epoch the old one had, also the one after the delete
  assert.equal(acc.epochOf("virt", "guest"), 4);
  assert.deepEqual(acc.keys("guest"), []);
  assert.equal(acc.get("guest")?.passwordHash, null);
  assert.equal(acc.get("guest")?.admin, false);
  // removed again at once: the next name starts above the epoch kept after that delete
  acc.remove("guest");
  assert.equal(acc.epochOf("virt", "guest"), 5);
  acc.create({ name: "guest", admin: false, nodes: {} });
  assert.equal(acc.epochOf("virt", "guest"), 6);
  assert.throws(() => acc.remove("ghost"), (e: unknown) => e instanceof AccountError && e.message === "no such account");
  assert.equal(acc.epochOf("virt", "ghost"), 0, "a name never made has epoch 0");
});

test("retired epoch survives a restart", () => {
  const d = tmp();
  const file = path.join(d, "auth.db");
  const db1 = new AuthDb(file);
  const a1 = new Accounts(db1);
  a1.create({ name: "guest", admin: false, nodes: {} });
  a1.bumpEpoch("virt", "guest");
  a1.remove("guest");
  db1.close();
  const db2 = new AuthDb(file);
  const a2 = new Accounts(db2);
  assert.equal(a2.epochOf("virt", "guest"), 2);
  a2.create({ name: "guest", admin: false, nodes: {} });
  assert.equal(a2.epochOf("virt", "guest"), 3);
  db2.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test("remove and create inside an open transaction roll back with it", () => {
  const db = new AuthDb(":memory:");
  const acc = new Accounts(db);
  acc.create({ name: "guest", password: "p", admin: false, nodes: {} });
  acc.addKey("guest", edKey().line);
  db.db.exec("BEGIN IMMEDIATE");
  acc.remove("guest");
  acc.create({ name: "other", admin: false, nodes: {} });
  assert.equal(db.db.isTransaction, true, "the caller's transaction is still open");
  db.db.exec("ROLLBACK");
  assert.ok(acc.get("guest"), "the account is still there");
  assert.equal(acc.keys("guest").length, 1);
  assert.equal(acc.get("other"), undefined);
  assert.equal(acc.epochOf("virt", "guest"), 0);
  // and committed, the change stands
  db.db.exec("BEGIN IMMEDIATE");
  acc.remove("guest");
  db.db.exec("COMMIT");
  assert.equal(acc.get("guest"), undefined);
});

test("a failed remove inside an open transaction leaves the caller's earlier writes", () => {
  const db = new AuthDb(":memory:");
  const acc = new Accounts(db);
  db.db.exec("BEGIN IMMEDIATE");
  acc.create({ name: "first", admin: false, nodes: {} });
  assert.throws(() => acc.remove("ghost"), AccountError);
  assert.equal(db.db.isTransaction, true);
  db.db.exec("COMMIT");
  assert.ok(acc.get("first"));
});
