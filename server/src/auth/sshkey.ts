import { createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * SSH public-key sign-in check. A stored key is an `authorized_keys`-style line with no options. Only ssh-ed25519 and
 * ecdsa-sha2-nistp256 are accepted. The client signs `loginMessage(...)`; the web app builds the same bytes.
 */
export type PublicKey = { type: "ssh-ed25519" | "ecdsa-sha2-nistp256"; key: KeyObject; blob: Buffer };

const ED = "ssh-ed25519";
const EC = "ecdsa-sha2-nistp256";

/** Reads SSH-wire `string` fields (uint32 big-endian length, then bytes). Returns null on any overrun. */
function readFields(blob: Buffer): Buffer[] | null {
  const out: Buffer[] = [];
  let at = 0;
  while (at < blob.length) {
    if (at + 4 > blob.length) return null;
    const len = blob.readUInt32BE(at);
    at += 4;
    if (len > blob.length - at) return null;
    out.push(blob.subarray(at, at + len));
    at += len;
  }
  return out;
}

export function parsePublicKey(line: string): PublicKey | null {
  // "<type> <base64> [comment]". Anything before the type (options) means the first word is not a type, so it is refused.
  const m = /^(ssh-ed25519|ecdsa-sha2-nistp256)[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t].*)?$/.exec(line.trim());
  if (!m) return null;
  const type = m[1] as PublicKey["type"];
  const blob = Buffer.from(m[2] ?? "", "base64");
  const f = readFields(blob);
  const [inner, a, b] = f ?? [];
  if (!f || !inner || inner.toString("latin1") !== type || !a) return null;
  try {
    if (type === ED) {
      if (f.length !== 2 || a.length !== 32) return null;
      return { type, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: a.toString("base64url") }, format: "jwk" }), blob };
    }
    if (f.length !== 3 || !b || a.toString("latin1") !== "nistp256") return null;
    const pt = b;
    if (pt.length !== 65 || pt[0] !== 4) return null;
    const jwk = { kty: "EC", crv: "P-256", x: pt.subarray(1, 33).toString("base64url"), y: pt.subarray(33).toString("base64url") };
    return { type, key: createPublicKey({ key: jwk, format: "jwk" }), blob };
  } catch {
    return null; // for example a point that is not on the curve
  }
}

const field = (b: Buffer | string): Buffer => {
  const d = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  return Buffer.concat([len, d]);
};

/** The bytes the client signs: four SSH-wire strings. */
export function loginMessage(hubId: string, name: string, challenge: Buffer): Buffer {
  return Buffer.concat([field("filedeck-login-v1"), field(hubId), field(name), field(challenge)]);
}

/** True only for a valid signature. Never throws. ECDSA signatures are raw r||s (64 bytes), as WebCrypto makes them. */
export function verifyLogin(pub: PublicKey | null, msg: Buffer, sig: Buffer): boolean {
  if (!pub) return false;
  try {
    if (pub.type === ED) return sig.length === 64 && verify(null, msg, pub.key, sig);
    return sig.length === 64 && verify("sha256", msg, { key: pub.key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

const TTL_MS = 60_000;
const MAX_OUTSTANDING = 10_000;

type Entry = { name: string; c: Buffer; exp: number };

/** One-use sign-in challenges, bound to a name. A failed take does not consume the challenge. */
export class Challenges {
  private byId = new Map<number, Entry>(); // insertion order = age
  private byName = new Map<string, Set<number>>();
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  issue(name: string): Buffer {
    const c = randomBytes(32);
    const id = this.seq++;
    this.byId.set(id, { name, c, exp: this.now() + TTL_MS });
    let set = this.byName.get(name);
    if (!set) this.byName.set(name, (set = new Set()));
    set.add(id);
    for (let old = this.byId.keys().next(); this.byId.size > MAX_OUTSTANDING && !old.done; old = this.byId.keys().next()) this.drop(old.value);
    return c;
  }

  take(name: string, c: Buffer): boolean {
    const ids = this.byName.get(name);
    if (!ids) return false;
    const now = this.now();
    let hit: number | undefined;
    for (const id of [...ids]) {
      const e = this.byId.get(id)!;
      if (now > e.exp) {
        this.drop(id);
        continue;
      }
      // Compare every live challenge so timing does not show which one matched.
      if (e.c.length === c.length && timingSafeEqual(e.c, c)) hit = id;
    }
    if (hit === undefined) return false;
    this.drop(hit);
    return true;
  }

  private drop(id: number): void {
    const e = this.byId.get(id);
    if (!e) return;
    this.byId.delete(id);
    const set = this.byName.get(e.name);
    set?.delete(id);
    if (set?.size === 0) this.byName.delete(e.name);
  }
}
