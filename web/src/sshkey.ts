import bcrypt from "bcrypt-pbkdf";

/**
 * OpenSSH private key files, read and used only in the browser. The key text and the passphrase never leave this
 * module: the hub gets the public key line and a signature over `loginMessage` (server/src/auth/sshkey.ts).
 * Only ssh-ed25519 and ecdsa-sha2-nistp256 keys sign. A protected key is decrypted with bcrypt-pbkdf and AES-256
 * (CTR, as ssh-keygen makes it, or GCM) through WebCrypto. The app loads this module only on the key-file path.
 */
export class KeyFileError extends Error {
  override name = "KeyFileError";
}

type Bytes = Uint8Array<ArrayBuffer>;
type KeyType = "ssh-ed25519" | "ecdsa-sha2-nistp256";
const TYPES: readonly string[] = ["ssh-ed25519", "ecdsa-sha2-nistp256"];
const MAGIC = "openssh-key-v1\0";
/** IV and tag length for each cipher ssh-keygen can protect a key with that we can undo; the key is always 32 bytes */
const CIPHERS: Record<string, { iv: number; tag: number }> = { "aes256-ctr": { iv: 16, tag: 0 }, "aes256-gcm@openssh.com": { iv: 12, tag: 16 } };
/** ssh-keygen uses 16 rounds; a file asking for many more would hold the page for minutes */
const MAX_ROUNDS = 1024;

const notOpenSsh = () => new KeyFileError("not an OpenSSH private key");
const wrongPassphrase = () => new KeyFileError("wrong passphrase");
const notSupported = () => new KeyFileError("key encryption not supported");

/** Reads SSH-wire fields; any overrun means the file is damaged. */
class Reader {
  at = 0;
  constructor(readonly b: Bytes) {}
  u32(): number {
    if (this.at + 4 > this.b.length) throw notOpenSsh();
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return v;
  }
  bytes(): Bytes {
    const n = this.u32();
    if (n > this.b.length - this.at) throw notOpenSsh();
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  text(): string {
    return new TextDecoder("latin1").decode(this.bytes());
  }
  rest(): Bytes {
    return this.b.subarray(this.at);
  }
}

interface Parsed {
  type: KeyType;
  cipher: string;
  kdf: string;
  kdfOptions: Bytes;
  publicBlob: Bytes;
  /** the private section, still encrypted for a protected key */
  privateSection: Bytes;
  /** what follows it: the GCM tag, if any */
  tail: Bytes;
}

const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const base64url = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decode(text: string): Parsed {
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(text)) throw new KeyFileError("RSA keys are not supported yet");
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!m) throw notOpenSsh();
  let raw: Bytes;
  try {
    raw = Uint8Array.from(atob(m[1]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw notOpenSsh();
  }
  if (new TextDecoder("latin1").decode(raw.subarray(0, MAGIC.length)) !== MAGIC) throw notOpenSsh();
  const r = new Reader(raw);
  r.at = MAGIC.length;
  const cipher = r.text();
  const kdf = r.text();
  const kdfOptions = r.bytes();
  if (r.u32() !== 1) throw new KeyFileError("key type not supported"); // files with several keys
  const publicBlob = r.bytes();
  const privateSection = r.bytes();
  const tail = r.rest();
  const type = new Reader(publicBlob).text();
  if (type === "ssh-rsa") throw new KeyFileError("RSA keys are not supported yet");
  if (!TYPES.includes(type)) throw new KeyFileError("key type not supported");
  return { type: type as KeyType, cipher, kdf, kdfOptions, publicBlob, privateSection, tail };
}

/** What the file holds, without the passphrase. `publicLine` is "<type> <base64>", the first two fields of the .pub line. */
export function parsePrivateKey(text: string): { encrypted: boolean; type: KeyType; publicLine: string } {
  const p = decode(text);
  return { encrypted: p.cipher !== "none", type: p.type, publicLine: `${p.type} ${toBase64(p.publicBlob)}` };
}

/** The private section in plain bytes, in a buffer of its own that the caller zeroes. */
async function decrypt(p: Parsed, passphrase: string | undefined): Promise<Bytes> {
  if (p.cipher === "none") return p.privateSection.slice();
  const c = CIPHERS[p.cipher];
  if (!c || p.kdf !== "bcrypt") throw notSupported();
  const o = new Reader(p.kdfOptions);
  const salt = o.bytes();
  const rounds = o.u32();
  if (rounds < 1 || rounds > MAX_ROUNDS || salt.length === 0) throw notSupported();
  if (p.privateSection.length % 16 !== 0 || p.tail.length < c.tag) throw notOpenSsh();
  if (!passphrase) throw wrongPassphrase();
  const pass = new TextEncoder().encode(passphrase);
  const km = new Uint8Array(32 + c.iv);
  const ok = bcrypt.pbkdf(pass, pass.length, salt, salt.length, km, km.length, rounds) === 0;
  pass.fill(0);
  try {
    if (!ok) throw notSupported();
    // WebCrypto takes views, so the key material is never copied; it is zeroed below.
    const key = km.subarray(0, 32);
    const iv = km.subarray(32);
    if (c.tag) {
      const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
      const sealed = new Uint8Array(p.privateSection.length + c.tag);
      sealed.set(p.privateSection);
      sealed.set(p.tail.subarray(0, c.tag), p.privateSection.length);
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, k, sealed));
      } catch {
        throw wrongPassphrase(); // the tag does not match
      }
    }
    const k = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 128 }, k, p.privateSection));
  } finally {
    km.fill(0);
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The private key as a WebCrypto key, checked against the public key in the file. */
async function privateKey(p: Parsed, plain: Bytes): Promise<CryptoKey> {
  const r = new Reader(plain);
  // Two equal check numbers. For a protected key anything else means the passphrase was wrong.
  let check: boolean;
  try {
    check = r.u32() === r.u32();
  } catch {
    check = false;
  }
  if (!check) throw p.cipher === "none" ? notOpenSsh() : wrongPassphrase();
  const pub = new Reader(p.publicBlob);
  if (r.text() !== pub.text()) throw notOpenSsh();
  let key: Promise<CryptoKey>;
  if (p.type === "ssh-ed25519") {
    const a = r.bytes();
    const secret = r.bytes(); // seed || public key
    if (a.length !== 32 || secret.length !== 64 || !same(a, pub.bytes()) || !same(secret.subarray(32), a)) throw notOpenSsh();
    // PKCS#8 for Ed25519 is a fixed prefix and the 32-byte seed. Zeroed once imported.
    const der = new Uint8Array(48);
    der.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
    der.set(secret.subarray(0, 32), 16);
    key = crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]).finally(() => der.fill(0));
  } else {
    pub.text(); // curve name
    const q = pub.bytes();
    if (r.text() !== "nistp256") throw notOpenSsh();
    const point = r.bytes();
    const mp = r.bytes(); // mpint: big-endian, a leading zero byte when the top bit is set
    if (point.length !== 65 || point[0] !== 4 || !same(point, q)) throw notOpenSsh();
    let s = mp;
    while (s.length > 32 && s[0] === 0) s = s.subarray(1);
    if (s.length > 32) throw notOpenSsh();
    const d = new Uint8Array(32);
    d.set(s, 32 - s.length);
    // A JWK holds the scalar as a string, which cannot be zeroed; the byte copy is.
    const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33)), d: base64url(d), ext: false };
    d.fill(0);
    key = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  r.bytes(); // comment
  // Padding to the cipher block size: 1, 2, 3, ... as OpenSSH writes it.
  const pad = r.rest();
  if (pad.length >= 16 || !pad.every((x, i) => x === i + 1)) {
    void key.catch(() => {});
    throw notOpenSsh();
  }
  return key;
}

function field(b: Uint8Array): Bytes {
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}

/** The bytes the hub checks: four SSH-wire strings (the same layout as the server's `loginMessage`). */
export function loginMessage(hubId: string, name: string, challenge: Uint8Array): Bytes {
  const te = new TextEncoder();
  const parts = [te.encode("filedeck-login-v1"), te.encode(hubId), te.encode(name), challenge].map(field);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

/**
 * Signs the sign-in message with the key in `text`. Ed25519 signatures are 64 bytes; ECDSA signatures are raw r||s
 * (64 bytes), which is what WebCrypto gives and what the hub's ieee-p1363 check takes.
 */
export async function signLogin(text: string, passphrase: string | undefined, hubId: string, name: string, challenge: Uint8Array): Promise<{ publicKey: string; signature: Uint8Array }> {
  const p = decode(text);
  const plain = await decrypt(p, passphrase);
  let key: CryptoKey;
  try {
    key = await privateKey(p, plain);
  } finally {
    plain.fill(0);
  }
  const alg = p.type === "ssh-ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  const signature = new Uint8Array(await crypto.subtle.sign(alg, key, loginMessage(hubId, name, challenge)));
  return { publicKey: `${p.type} ${toBase64(p.publicBlob)}`, signature };
}

export { toBase64 };
