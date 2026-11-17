import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { parsePrivateKey, signLogin, KeyFileError } from "../src/sshkey.ts";
import * as keys from "./fixtures/keys.ts";

// The "<type> <base64>" part of a .pub line. The comment sits in the private part, which is encrypted for a protected key.
const pubPart = (line: string) => line.split(" ").slice(0, 2).join(" ");

// The bytes the hub checks (server/src/auth/sshkey.ts loginMessage): four SSH-wire strings. Built here so the web
// package does not import server code.
function field(b: Uint8Array | string): Buffer {
  const d = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  return Buffer.concat([len, d]);
}
const loginMessage = (hubId: string, name: string, challenge: Uint8Array) =>
  Buffer.concat([field("filedeck-login-v1"), field(hubId), field(name), field(challenge)]);

// The same checks as the hub's verifyLogin: Ed25519 with verify(null, ...), ECDSA P-256 SHA-256 with raw r||s.
function serverVerify(publicLine: string, msg: Buffer, sig: Uint8Array): boolean {
  const [type, b64] = publicLine.split(" ");
  const blob = Buffer.from(b64 ?? "", "base64");
  const fields: Buffer[] = [];
  for (let at = 0; at < blob.length; ) {
    const len = blob.readUInt32BE(at);
    fields.push(blob.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  if (sig.length !== 64) return false;
  if (type === "ssh-ed25519") {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: fields[1]!.toString("base64url") }, format: "jwk" });
    return verify(null, msg, key, sig);
  }
  const pt = fields[2]!;
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pt.subarray(1, 33).toString("base64url"), y: pt.subarray(33).toString("base64url") }, format: "jwk" });
  return verify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig);
}

const cases = [
  { name: "ed25519", k: keys.ed25519, type: "ssh-ed25519", encrypted: false },
  { name: "ed25519 with passphrase", k: keys.ed25519Enc, type: "ssh-ed25519", encrypted: true },
  { name: "ed25519 with passphrase (aes256-gcm)", k: keys.ed25519Gcm, type: "ssh-ed25519", encrypted: true },
  { name: "ecdsa", k: keys.ecdsa, type: "ecdsa-sha2-nistp256", encrypted: false },
  { name: "ecdsa with passphrase", k: keys.ecdsaEnc, type: "ecdsa-sha2-nistp256", encrypted: true },
] as const;

for (const c of cases) {
  test(`parse ${c.name}`, () => {
    const p = parsePrivateKey(c.k.key);
    assert.equal(p.type, c.type);
    assert.equal(p.encrypted, c.encrypted);
    assert.equal(p.publicLine, pubPart(c.k.pub));
  });

  test(`sign verifies on the server side: ${c.name}`, async () => {
    const challenge = new Uint8Array(randomBytes(32));
    const out = await signLogin(c.k.key, c.encrypted ? "pw" : undefined, "hub-1", "alice", challenge);
    assert.equal(out.publicKey, pubPart(c.k.pub));
    assert.ok(serverVerify(out.publicKey, loginMessage("hub-1", "alice", challenge), out.signature));
    // bound to every field: another name or hub does not verify
    assert.ok(!serverVerify(out.publicKey, loginMessage("hub-1", "bob", challenge), out.signature));
    assert.ok(!serverVerify(out.publicKey, loginMessage("hub-2", "alice", challenge), out.signature));
  });
}

test("parse refuses an RSA key", () => {
  assert.throws(() => parsePrivateKey(keys.rsa.key), (e: unknown) => e instanceof KeyFileError && e.message === "RSA keys are not supported yet");
});

test("parse refuses text that is not an OpenSSH private key", () => {
  for (const t of ["", "hello", keys.ed25519.pub, "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"]) {
    assert.throws(() => parsePrivateKey(t), (e: unknown) => e instanceof KeyFileError && e.message === "not an OpenSSH private key", JSON.stringify(t));
  }
});

test("wrong passphrase", async () => {
  for (const k of [keys.ed25519Enc, keys.ecdsaEnc, keys.ed25519Gcm]) {
    await assert.rejects(signLogin(k.key, "nope", "hub-1", "alice", new Uint8Array(32)), (e: unknown) => e instanceof KeyFileError && e.message === "wrong passphrase");
  }
  await assert.rejects(signLogin(keys.ed25519Enc.key, undefined, "hub-1", "alice", new Uint8Array(32)), (e: unknown) => e instanceof KeyFileError && e.message === "wrong passphrase");
});
