// Web Push for the hub, on node:crypto alone: message encryption (RFC 8291, aes128gcm per RFC 8188) and the VAPID token (RFC 8292).
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** The hub's VAPID key pair: `publicKey` the uncompressed P-256 point, `privateKey` the scalar, both base64url. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** A browser's push subscription keys, base64url as `PushSubscription.toJSON()` gives them. */
export interface SubKeys {
  p256dh: string;
  auth: string;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
/** the record size written in the header; one record holds any payload Filedeck sends (well under 4 KB) */
const RS = 4096;

export function makeVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: pub.toString("base64url"), privateKey: jwk.d };
}

/**
 * The encrypted body for one subscription. `fixed` (tests only) gives the salt and the sender's key; otherwise both are new for each
 * message, as the RFC requires.
 */
export function encryptPayload(plain: Buffer, sub: SubKeys, fixed?: { salt: Buffer; senderPrivate: Buffer }): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, "base64url");
  const auth = Buffer.from(sub.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh key");
  if (auth.length !== 16) throw new Error("bad auth secret");
  if (plain.length > RS - 17 - 86) throw new Error("payload too large");
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RS, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, ct]);
}

/** The `Authorization` header for a push to `endpoint`: an ES256 token for its origin, valid 12 hours from `now`. */
export function vapidAuth(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): string {
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${data}.${sig}, k=${keys.publicKey}`;
}

/** Sends one push; resolves to the push service's status (201 sent, 404 or 410 the subscription is gone). */
export async function sendPush(o: {
  endpoint: string;
  keys: SubKeys;
  vapid: VapidKeys;
  subject: string;
  payload: unknown;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<number> {
  const body = encryptPayload(Buffer.from(JSON.stringify(o.payload)), o.keys);
  const r = await (o.fetch ?? fetch)(o.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuth(o.vapid, o.endpoint, o.subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body: new Uint8Array(body),
    redirect: "error",
    signal: o.signal ?? AbortSignal.timeout(15_000),
  });
  await r.body?.cancel().catch(() => undefined);
  return r.status;
}
