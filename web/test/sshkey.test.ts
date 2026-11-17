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

// Damaged files: the bytes of a fixture, changed, and armoured again.
const rawOf = (text: string) => Buffer.from(text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
const armour = (b: Buffer) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${b.toString("base64").replace(/(.{70})/g, "$1\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
const mutate = (text: string, f: (b: Buffer) => Buffer | void) => {
  const b = Buffer.from(rawOf(text));
  return armour(f(b) ?? b);
};
const isKeyError = (msg?: string) => (e: unknown) => e instanceof KeyFileError && (msg === undefined || e.message === msg);
const sign = (text: string, pass?: string) => signLogin(text, pass, "hub-1", "alice", new Uint8Array(32));
const MAGIC_LEN = 15;

test("damaged files throw KeyFileError", async () => {
  const damaged: [string, string, string | undefined, string?][] = [
    ["truncated", mutate(keys.ed25519.key, (b) => b.subarray(0, b.length - 10)), "not an OpenSSH private key"],
    ["truncated to the header", mutate(keys.ecdsa.key, (b) => b.subarray(0, 40)), "not an OpenSSH private key"],
    ["oversized cipher name length", mutate(keys.ed25519.key, (b) => void b.writeUInt32BE(0xffffffff, MAGIC_LEN)), "not an OpenSSH private key"],
    ["oversized private section length", mutate(keys.ecdsa.key, (b) => {
      // magic, cipher "none", kdf "none", empty kdf options, key count, public blob, then the private section length
      let at = MAGIC_LEN + 8 + 8 + 4 + 4;
      at += 4 + b.readUInt32BE(at);
      b.writeUInt32BE(b.length, at);
    }), "not an OpenSSH private key"],
    ["oversized field inside the private section", mutate(keys.ed25519.key, (b) => {
      let at = MAGIC_LEN + 8 + 8 + 4 + 4;
      at += 4 + b.readUInt32BE(at);
      b.writeUInt32BE(0x7fffffff, at + 4 + 8); // the key type string, after the check numbers
    }), "not an OpenSSH private key"],
    ["check numbers differ (no passphrase)", mutate(keys.ed25519.key, (b) => {
      let at = MAGIC_LEN + 8 + 8 + 4 + 4;
      at += 4 + b.readUInt32BE(at);
      b[at + 4] ^= 1;
    }), "not an OpenSSH private key"],
    ["bad padding", mutate(keys.ed25519.key, (b) => void (b[b.length - 1] ^= 0x40)), "not an OpenSSH private key"],
    ["Ed25519 secret does not end with the public key", mutate(keys.ed25519.key, (b) => {
      const pub = rawOf(keys.ed25519.pub.split(" ")[1]!).subarray(19); // after the type string and the length
      b[b.lastIndexOf(pub) + 5] ^= 1;
    }), "not an OpenSSH private key"],
    ["ECDSA point does not match", mutate(keys.ecdsa.key, (b) => {
      const blob = rawOf(keys.ecdsa.pub.split(" ")[1]!);
      const pt = blob.subarray(blob.length - 65);
      b[b.lastIndexOf(pt) + 40] ^= 1;
    }), "not an OpenSSH private key"],
    ["too many bcrypt rounds", mutate(keys.ed25519Enc.key, (b) => {
      // magic, "aes256-ctr", "bcrypt", kdf options length, salt string, then the rounds
      const at = MAGIC_LEN + 4 + 10 + 4 + 6 + 4;
      b.writeUInt32BE(1_000_000, at + 4 + b.readUInt32BE(at));
    }), "key encryption not supported", "pw"],
    ["unknown cipher", mutate(keys.ed25519Enc.key, (b) => void b.write("aes128-ctr", MAGIC_LEN + 4, "latin1")), "key encryption not supported", "pw"],
  ];
  for (const [what, text, msg, pass] of damaged) {
    await assert.rejects(sign(text, pass), isKeyError(msg), what);
  }
});
