import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { encryptPayload, makeVapidKeys, vapidAuth, type VapidKeys } from "../src/push/webpush.ts";

const b64u = (s: string) => Buffer.from(s, "base64url");

// RFC 8291, Appendix A
const A = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryption matches the RFC 8291 example", () => {
  const out = encryptPayload(Buffer.from(A.plaintext), { p256dh: A.uaPublic, auth: A.auth }, { salt: b64u(A.salt), senderPrivate: b64u(A.asPrivate) });
  assert.equal(out.toString("base64url"), A.body);
});

/** The receiving side of RFC 8291, written out from the RFC, independent of the sender code. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "last record ends with the 0x02 delimiter");
  return plain.subarray(0, plain.length - 1);
}

test("a payload made with fresh keys and salt decrypts on the receiving side", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  const msg = Buffer.from(JSON.stringify({ title: "Copy a finished", body: "12 done" }));
  const body = encryptPayload(msg, { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
  assert.deepEqual(decrypt(body, ua.getPrivateKey(), ua.getPublicKey(), auth), msg);
  // a new salt and a new sender key each time
  const again = encryptPayload(msg, { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
  assert.notDeepEqual(again.subarray(0, 16), body.subarray(0, 16));
});

test("a subscription with a bad key is refused", () => {
  assert.throws(() => encryptPayload(Buffer.from("x"), { p256dh: "AAAA", auth: "BTBZMqHH6r4Tts7J_aSIgg" }));
  assert.throws(() => encryptPayload(Buffer.from("x"), { p256dh: A.uaPublic, auth: "AA" }));
});

test("VAPID: a P-256 key pair, and an ES256 token for the push service's origin that the public key verifies", () => {
  const k: VapidKeys = makeVapidKeys();
  const pub = b64u(k.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  const h = vapidAuth(k, "https://fcm.googleapis.com/fcm/send/abc:def", "https://example.test/x", 1_000_000_000_000);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m![2], k.publicKey);
  const [hd, cl, sig] = m![1]!.split(".");
  assert.deepEqual(JSON.parse(b64u(hd!).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(b64u(cl!).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://example.test/x");
  assert.equal(claims.exp, 1_000_000_000 + 12 * 3600);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: "ieee-p1363" }, b64u(sig!)));
});
