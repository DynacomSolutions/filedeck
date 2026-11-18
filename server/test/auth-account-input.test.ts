import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  InputError,
  MAX_GRANTS,
  MAX_KEYS,
  MAX_PASSWORD,
  MAX_TAILNET_LINKS,
  MIN_PASSWORD,
  accountName,
  grants,
  newPassword,
  nodeAccess,
  publicKey,
  sourceAccess,
  systemName,
  tailnetLink,
  tailnetLinks,
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
  // the grants travel in a signed header, which the agent takes up to 16 KiB: one machine's grants are bounded
  const long = (c: string) => ({ path: "/" + c.repeat(4095), write: false });
  assert.equal(grants([long("x"), long("y"), long("z")]).length, 3, "each path is allowed on its own");
  assert.match(inputError(() => nodeAccess({ a: { runAs: "guest", grants: [long("x"), long("y"), long("z")] } }, known)), /folders on a/);
  const many = Array.from({ length: 64 }, (_, i) => ({ path: `/${String(i).padStart(2, "0")}` + "p".repeat(150), write: true }));
  inputError(() => nodeAccess({ a: { runAs: "guest", grants: many } }, known));
  const fits = [
    { path: "/" + "f".repeat(4069), write: false },
    { path: "/" + "g".repeat(4068), write: false },
  ];
  assert.equal(JSON.stringify(fits).length, 8192);
  assert.equal(nodeAccess({ a: { runAs: "guest", grants: fits } }, known).a!.grants.length, 2, "up to the limit passes");
  fits[1]!.path += "g";
  inputError(() => nodeAccess({ a: { runAs: "guest", grants: fits } }, known));
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
  const keys6 = "\u{1F511}".repeat(6);
  assert.equal(keys6.length, 12, "twelve UTF-16 units");
  inputError(() => newPassword(keys6));
  assert.equal(newPassword("\u{1F511}".repeat(12)), "\u{1F511}".repeat(12), "length counts characters");
  inputError(() => newPassword("\u{1F511}".repeat(1025)));
  assert.equal(newPassword("\u{1F511}".repeat(1024)).length, 2048);
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
  assert.equal(
    publicKey(edLine(pub, " a\x01b\x7fc\x85d\u202Ee\u200Bf\uFEFFg\u2066h\u00ADi\x9Bj")),
    edLine(pub, " abcdefghij"),
    "C0, DEL, C1 and format (bidi, zero-width, BOM, soft hyphen) characters are dropped",
  );
  assert.equal(publicKey(edLine(pub, " x\t\u202Ey")), edLine(pub, " xy"), "a tab inside the comment is dropped too");
  assert.equal(
    publicKey(edLine(pub, " " + "\u202E".repeat(20) + "d".repeat(140))),
    edLine(pub, " " + "d".repeat(128)),
    "dropped characters do not count towards the 128",
  );
  assert.equal(publicKey(edLine(pub, " x \u200B")), edLine(pub, " x"), "trimmed after dropping");
  assert.equal(publicKey(edLine(pub, " \u200B x")), edLine(pub, " x"), "no leading space is left after dropping");
  const astral = publicKey(edLine(pub, " " + "e".repeat(127) + "\u{1F511}\u{1F511}"));
  assert.equal(astral, edLine(pub, " " + "e".repeat(127) + "\u{1F511}"), "a cut at 128 keeps whole characters");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astral), "no lone surrogate");
  assert.equal(publicKey(edLine(pub, " \u202E\u2066\x01")), edLine(pub), "a comment of nothing but such characters goes");
  assert.equal(publicKey(edLine(pub, " caf\u00E9 \u{1F511} \u05D0")), edLine(pub, " caf\u00E9 \u{1F511} \u05D0"), "other text is kept");
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

test("tailnetLink: a login or a tag, trimmed and lowercased, with its kind", () => {
  assert.deepEqual(tailnetLink(" Alice@GitHub "), { subject: "alice@github", kind: "login" });
  assert.deepEqual(tailnetLink("TAG:Server"), { subject: "tag:server", kind: "tag" });
  assert.deepEqual(tailnetLink(" tag:web-1 "), { subject: "tag:web-1", kind: "tag" });
  assert.deepEqual(tailnetLink("bob@passkey"), { subject: "bob@passkey", kind: "login" });
  const longest = "a@" + "b".repeat(249) + ".io";
  assert.deepEqual(tailnetLink(longest), { subject: longest, kind: "login" }, "254 characters pass");
  for (const bad of ["\u212aelly@github", "kelly@github\u00a0", "\ufefftag:server", "tag:\u212a8s", "tagged-devices", "tag:", "tag:a_b", "tag:a.b", "alice", "@github", "alice@", "a\n@github", "", "a@" + "b".repeat(250) + ".io", 5, null, undefined, ["a@x"]]) {
    const msg = inputError(() => tailnetLink(bad));
    assert.match(msg, /tailnet link/, `${JSON.stringify(bad)} is refused with the link message`);
  }
});

test("tailnetLinks: a list, each cleaned, duplicates merged, at most 16", () => {
  assert.equal(MAX_TAILNET_LINKS, 16);
  assert.deepEqual(tailnetLinks(["a@x", "A@X", " Tag:S "]), [
    { subject: "a@x", kind: "login" },
    { subject: "tag:s", kind: "tag" },
  ]);
  assert.deepEqual(tailnetLinks([]), []);
  const sixteen = Array.from({ length: 16 }, (_, i) => `u${i}@x`);
  assert.equal(tailnetLinks(sixteen).length, 16);
  assert.match(inputError(() => tailnetLinks([...sixteen, "u16@x"])), /16/);
  assert.equal(tailnetLinks([...sixteen, "U0@X"]).length, 16, "a duplicate does not count towards the 16");
  inputError(() => tailnetLinks("a@x"));
  inputError(() => tailnetLinks({ 0: "a@x" }));
  inputError(() => tailnetLinks(["a@x", "nope"]));
});
