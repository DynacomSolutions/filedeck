import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  InputError,
  MAX_GRANTS,
  MAX_KEYS,
  MAX_PASSWORD,
  MIN_PASSWORD,
  accountName,
  grants,
  newPassword,
  nodeAccess,
  publicKey,
  sourceAccess,
  systemName,
} from "../src/auth/account-input.ts";

const str = (b: Buffer | string) => {
  const d = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  return Buffer.concat([l, d]);
};
function edLine(pub: KeyObject, comment = ""): string {
  const raw = Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
  const blob = Buffer.concat([str("ssh-ed25519"), str(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")}${comment}`;
}

/** Runs `fn`, expects an `InputError` and returns its message. */
function inputError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof InputError, `expected InputError, got ${String(e)}`);
    return e.message;
  }
  assert.fail("expected an InputError");
}

test("limits", () => {
  assert.equal(MIN_PASSWORD, 12);
  assert.equal(MAX_PASSWORD, 1024);
  assert.equal(MAX_GRANTS, 64);
  assert.equal(MAX_KEYS, 32);
});

test("grant paths", () => {
  assert.deepEqual(grants([{ path: "/srv//data/", write: false }]), [{ path: "/srv/data", write: false }]);
  assert.deepEqual(grants([{ path: "/srv/./a", write: true }]), [{ path: "/srv/a", write: true }]);
  for (const path of ["srv", "/a/../b", "/a\0b", "/" + "a".repeat(4096), "/v/.filedeck-trash/x", "/v/.filedeck-work-1", "/v/.filedeck-work", ""]) {
    inputError(() => grants([{ path, write: false }]));
  }
  assert.deepEqual(
    grants([
      { path: "/a", write: false },
      { path: "/b", write: false },
      { path: "/a/", write: true },
    ]),
    [
      { path: "/a", write: true },
      { path: "/b", write: false },
    ],
  );
  assert.deepEqual(
    grants([
      { path: "/c", write: true },
      { path: "/b", write: false },
      { path: "/a", write: false },
    ]),
    [
      { path: "/c", write: true },
      { path: "/b", write: false },
      { path: "/a", write: false },
    ],
    "the given order is kept",
  );
  const many = Array.from({ length: 65 }, (_, i) => ({ path: `/g${i}`, write: false }));
  inputError(() => grants(many));
  assert.equal(grants(many.slice(0, 64)).length, 64);
  inputError(() => grants([{ path: "/a", write: "yes" }]));
  inputError(() => grants([{ path: "/a" }]));
  inputError(() => grants([{ path: 7, write: false }]));
  inputError(() => grants([null]));
  inputError(() => grants("/a"));
  assert.deepEqual(grants([{ path: "/a", write: false, extra: 1 }]), [{ path: "/a", write: false }], "only path and write come back");
});

test("node access", () => {
  const known = new Set(["a", "b"]);
  const good = { runAs: "guest", grants: [{ path: "/srv/share/", write: false }] };
  inputError(() => nodeAccess({ c: good }, known));
  inputError(() => nodeAccess({ a: { ...good, runAs: "root" } }, known));
  inputError(() => nodeAccess({ a: { ...good, runAs: "" } }, known));
  inputError(() => nodeAccess({ a: { ...good, runAs: "-x" } }, known));
  assert.match(inputError(() => nodeAccess({ a: { ...good, grants: [] } }, known)), /give at least one folder on a/);
  inputError(() => nodeAccess({ a: { runAs: "guest" } }, known));
  inputError(() => nodeAccess({ a: null }, known));
  inputError(() => nodeAccess([good], known));
  inputError(() => nodeAccess(null, known));
  assert.deepEqual(nodeAccess({ a: good, b: { runAs: "web.user@corp", grants: [{ path: "//x/./y", write: true }] } }, known), {
    a: { runAs: "guest", grants: [{ path: "/srv/share", write: false }] },
    b: { runAs: "web.user@corp", grants: [{ path: "/x/y", write: true }] },
  });
  assert.deepEqual(nodeAccess({}, known), {});
});

test("source access", () => {
  const known = new Set(["s1", "s2"]);
  assert.deepEqual(sourceAccess({ s1: { write: false }, s2: { write: true } }, known), { s1: { write: false }, s2: { write: true } });
  assert.deepEqual(sourceAccess({}, known), {});
  inputError(() => sourceAccess({ s3: { write: true } }, known));
  inputError(() => sourceAccess({ s1: { write: 1 } }, known));
  inputError(() => sourceAccess({ s1: true }, known));
  inputError(() => sourceAccess([], known));
  inputError(() => sourceAccess(null, known));
});

test("names", () => {
  assert.equal(accountName("guest", []), "guest");
  assert.equal(accountName("_a.b-c9", []), "_a.b-c9");
  assert.equal(accountName("a".repeat(32), []), "a".repeat(32));
  for (const n of ["root", "Alice", "a".repeat(33), "", "9a", "-a", "a b", 5, null]) inputError(() => accountName(n, []));
  inputError(() => accountName("alice", ["bob", "alice"]));
  assert.equal(systemName("Alice"), "Alice");
  assert.equal(systemName("d.user@corp"), "d.user@corp");
  for (const n of ["root", "", "-x", "a/b", "a".repeat(65), 0, undefined]) inputError(() => systemName(n));
});

test("passwords", () => {
  const eleven = "s3cret-pw-1";
  assert.equal(eleven.length, 11);
  const msg = inputError(() => newPassword(eleven));
  assert.ok(!msg.includes(eleven), "the message does not hold the password");
  assert.match(msg, /password/);
  assert.equal(newPassword("x".repeat(12)), "x".repeat(12));
  assert.equal(newPassword("y".repeat(1024)), "y".repeat(1024));
  const long = "z".repeat(1025);
  assert.ok(!inputError(() => newPassword(long)).includes("zzzzzzzzzzzz"));
  inputError(() => newPassword(undefined));
  inputError(() => newPassword(123456789012));
});

test("keys", () => {
  const { publicKey: pub } = generateKeyPairSync("ed25519");
  const line = edLine(pub, " me@laptop");
  const b64 = line.split(" ")[1]!;
  assert.equal(publicKey(line), line, "an Ed25519 line passes and keeps its comment");
  assert.equal(publicKey("  " + edLine(pub) + "  \n"), edLine(pub), "no comment, spaces trimmed");
  assert.equal(publicKey(edLine(pub, "\t  two  words ")), edLine(pub, " two  words"));
  assert.equal(publicKey(edLine(pub, " " + "c".repeat(300))), edLine(pub, " " + "c".repeat(128)), "the comment is cut to 128 characters");
  const withOptions = `command="x" ${line}`;
  const msg = inputError(() => publicKey(withOptions));
  assert.ok(!msg.includes(b64), "the message does not hold the key");
  assert.match(msg, /key/);
  const big = edLine(pub, " " + "k".repeat(9 * 1024));
  assert.ok(!inputError(() => publicKey(big)).includes(b64));
  inputError(() => publicKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ"));
  inputError(() => publicKey(42));
  inputError(() => publicKey(""));
});
