import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomBytes, type KeyObject } from "node:crypto";
import { parsePublicKey, loginMessage, verifyLogin, Challenges } from "../src/auth/sshkey.ts";

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
function ecLine(pub: KeyObject, o: { curve?: string; type?: string; point?: Buffer } = {}): string {
  const j = pub.export({ format: "jwk" });
  const point = o.point ?? Buffer.concat([Buffer.from([4]), Buffer.from(j.x as string, "base64url"), Buffer.from(j.y as string, "base64url")]);
  const blob = Buffer.concat([str("ecdsa-sha2-nistp256"), str(o.curve ?? "nistp256"), str(point)]);
  return `${o.type ?? "ecdsa-sha2-nistp256"} ${blob.toString("base64")}`;
}

test("ed25519 good", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = parsePublicKey(edLine(publicKey, " me@host"));
  assert.ok(pub);
  assert.equal(pub.type, "ssh-ed25519");
  const msg = loginMessage("hub1", "alice", randomBytes(32));
  assert.equal(verifyLogin(pub, msg, sign(null, msg, privateKey)), true);
});

test("ecdsa good", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = parsePublicKey(ecLine(publicKey));
  assert.ok(pub);
  const msg = loginMessage("hub1", "alice", randomBytes(32));
  const sig = sign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
  assert.equal(sig.length, 64);
  assert.equal(verifyLogin(pub, msg, sig), true);
});

test("wrong name, bad length and garbage fail without throwing", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = parsePublicKey(edLine(publicKey));
  const c = randomBytes(32);
  const sig = sign(null, loginMessage("hub1", "bob", c), privateKey);
  assert.equal(verifyLogin(pub, loginMessage("hub1", "alice", c), sig), false);
  assert.equal(verifyLogin(pub, loginMessage("hub1", "bob", c), sig.subarray(1)), false);
  assert.equal(verifyLogin(pub, loginMessage("hub1", "bob", c), Buffer.alloc(0)), false);
  assert.equal(verifyLogin(null, loginMessage("hub1", "bob", c), sig), false);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const epub = parsePublicKey(ecLine(ec.publicKey));
  assert.equal(verifyLogin(epub, c, Buffer.alloc(64, 1)), false);
  assert.equal(verifyLogin(epub, c, Buffer.alloc(10)), false);
});

test("loginMessage layout", () => {
  const m = loginMessage("h", "n", Buffer.from([1, 2]));
  assert.deepEqual(m, Buffer.concat([str("filedeck-login-v1"), str("h"), str("n"), str(Buffer.from([1, 2]))]));
});

test("options refused, other types refused", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const line = edLine(publicKey);
  assert.equal(parsePublicKey(`command="x" ${line}`), null);
  assert.equal(parsePublicKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC"), null);
  assert.equal(parsePublicKey(""), null);
  assert.equal(parsePublicKey("ssh-ed25519"), null);
  assert.equal(parsePublicKey("ssh-ed25519 !!!notbase64"), null);
});

test("type word must match type in blob; ecdsa curve and point checked", () => {
  const ed = generateKeyPairSync("ed25519").publicKey;
  assert.equal(parsePublicKey(edLine(ed).replace("ssh-ed25519", "ecdsa-sha2-nistp256")), null);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
  assert.ok(parsePublicKey(ecLine(ec)));
  assert.equal(parsePublicKey(ecLine(ec, { type: "ssh-ed25519" })), null);
  assert.equal(parsePublicKey(ecLine(ec, { curve: "nistp384" })), null);
  const j = ec.export({ format: "jwk" });
  const xy = Buffer.concat([Buffer.from(j.x as string, "base64url"), Buffer.from(j.y as string, "base64url")]);
  assert.equal(parsePublicKey(ecLine(ec, { point: Buffer.concat([Buffer.from([2]), xy]) })), null);
  assert.equal(parsePublicKey(ecLine(ec, { point: xy })), null);
  // A point not on the curve is refused, not thrown.
  assert.equal(parsePublicKey(ecLine(ec, { point: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]) })), null);
});

test("challenge once, expiry, binding and failed take keeps it", () => {
  let t = 1_000_000;
  const ch = new Challenges(() => t);
  const c = ch.issue("alice");
  assert.equal(c.length, 32);
  assert.equal(ch.take("bob", c), false);
  assert.equal(ch.take("alice", randomBytes(32)), false);
  assert.equal(ch.take("alice", c.subarray(1)), false);
  assert.equal(ch.take("alice", c), true);
  assert.equal(ch.take("alice", c), false);
  const d = ch.issue("alice");
  t += 60_000;
  assert.equal(ch.take("alice", d), true);
  const e = ch.issue("alice");
  t += 60_001;
  assert.equal(ch.take("alice", e), false);
});

test("each name keeps at most 5 outstanding challenges", () => {
  const ch = new Challenges();
  const cs = Array.from({ length: 6 }, () => ch.issue("alice"));
  const other = ch.issue("bob");
  assert.equal(ch.take("alice", cs[0]!), false);
  assert.equal(ch.take("alice", cs[1]!), true);
  assert.equal(ch.take("bob", other), true);
});

test("outstanding challenges are capped, oldest dropped first", () => {
  let t = 0;
  const ch = new Challenges(() => t++);
  const first = ch.issue("a0");
  const second = ch.issue("a1");
  for (let i = 0; i < 9_997; i++) ch.issue("n" + i);
  // Exactly at the cap: nothing dropped yet.
  const last = ch.issue("z");
  // One over the cap: only the oldest goes.
  ch.issue("extra");
  assert.equal(ch.take("a0", first), false);
  assert.equal(ch.take("a1", second), true);
  assert.equal(ch.take("z", last), true);
});

test("ecdsa wrong name and wrong key fail", () => {
  const a = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const b = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubA = parsePublicKey(ecLine(a.publicKey));
  const pubB = parsePublicKey(ecLine(b.publicKey));
  const c = randomBytes(32);
  const msg = loginMessage("hub1", "alice", c);
  const sig = sign("sha256", msg, { key: a.privateKey, dsaEncoding: "ieee-p1363" });
  assert.equal(verifyLogin(pubA, msg, sig), true);
  assert.equal(verifyLogin(pubA, loginMessage("hub1", "bob", c), sig), false);
  assert.equal(verifyLogin(pubB, msg, sig), false);
});
