import type { Readable } from "node:stream";

/**
 * Minimal streaming tar reader (ustar + pax + GNU long names). Archives of any
 * format are first converted to a pax tar stream by bsdtar, so this is the one
 * parser every extraction goes through and the one place that sees entry names.
 */
export interface TarHeader {
  name: string;
  /** "file" | "dir" | "symlink" | "hardlink" | "other" */
  type: "file" | "dir" | "symlink" | "hardlink" | "other";
  size: number;
  mode: number;
  mtime: number;
  linkname: string;
}

export class TarError extends Error {}

const MAX_META = 1024 * 1024;

export class Reader {
  private it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(src: Readable) {
    this.it = (src[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  }
  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.it.next();
    if (r.done) {
      this.ended = true;
      return false;
    }
    const chunk = r.value as Buffer;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }
  /** Exactly n bytes, or null on clean EOF before the first byte. */
  async take(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        throw new TarError("truncated archive stream");
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async *body(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) throw new TarError("truncated archive stream");
      const k = Math.min(left, this.buf.length);
      const out = this.buf.subarray(0, k);
      this.buf = this.buf.subarray(k);
      left -= k;
      yield out;
    }
  }
  async skip(n: number): Promise<void> {
    for await (const _ of this.body(n)) void _;
  }
  async drain(): Promise<void> {
    this.buf = Buffer.alloc(0);
    while (await this.fill()) this.buf = Buffer.alloc(0);
  }
}

function cstr(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString("utf8");
}

function num(b: Buffer, off: number, len: number): number {
  if (b[off]! & 0x80) {
    // base-256 (GNU): big-endian two's complement of the bytes after the marker bit,
    // so a negative value (a date before 1970) has bit 6 of the first byte set
    let v = BigInt(b[off]! & 0x7f);
    if (b[off]! & 0x40) v -= 0x80n;
    for (let i = 1; i < len; i++) v = v * 256n + BigInt(b[off + i]!);
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new TarError("entry size out of range");
    return Number(v);
  }
  const s = cstr(b, off, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError("corrupt tar header");
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === num(h, 148, 8);
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.subarray(i, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= sp - i + 1 || i + len > buf.length) throw new TarError("corrupt pax header");
    const rec = buf.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

async function readMeta(r: Reader, size: number): Promise<Buffer> {
  if (size > MAX_META) throw new TarError("metadata header too large");
  const parts: Buffer[] = [];
  for await (const c of r.body(size)) parts.push(c);
  const pad = (512 - (size % 512)) % 512;
  if (pad) await r.skip(pad);
  return Buffer.concat(parts);
}

interface SparseInfo {
  name: string;
  realSize: number;
  /** GNU 1.0: the map is the first part of the stored data; 0.1: it came in the pax header */
  map: [number, number][] | null;
}

/** GNU sparse files as bsdtar writes them in pax form (formats 0.1 and 1.0); anything else sparse is refused rather than extracted wrongly. */
function sparseOf(pax: Record<string, string>): SparseInfo | undefined {
  const major = pax["GNU.sparse.major"];
  const minor = pax["GNU.sparse.minor"];
  const mapText = pax["GNU.sparse.map"];
  if (major === undefined && mapText === undefined && pax["GNU.sparse.numblocks"] === undefined && pax["GNU.sparse.name"] === undefined) return undefined;
  const real = Number(pax["GNU.sparse.realsize"] ?? pax["GNU.sparse.size"]);
  if (!Number.isSafeInteger(real) || real < 0) throw new TarError("corrupt sparse file header");
  const name = pax["GNU.sparse.name"] ?? pax.path;
  if (name === undefined) throw new TarError("corrupt sparse file header");
  if (major === "1" && minor === "0") return { name, realSize: real, map: null };
  if (mapText !== undefined) {
    const nums = mapText === "" ? [] : mapText.split(",").map(Number);
    if (nums.length % 2 || nums.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new TarError("corrupt sparse map");
    const map: [number, number][] = [];
    for (let i = 0; i < nums.length; i += 2) map.push([nums[i]!, nums[i + 1]!]);
    return { name, realSize: real, map };
  }
  throw new TarError("unsupported sparse file format");
}

const ZEROS = Buffer.alloc(64 * 1024);
async function* zeros(n: number): AsyncGenerator<Buffer> {
  for (let left = n; left > 0; left -= ZEROS.length) yield left >= ZEROS.length ? ZEROS : ZEROS.subarray(0, left);
}

/** The real content of a sparse file: holes as zeros, data read from the packed stream. */
async function* sparseBody(r: Reader, sp: SparseInfo, stored: number): AsyncGenerator<Buffer> {
  let map = sp.map;
  let left = stored;
  if (!map) {
    // format 1.0: "<count>\n" then count pairs of "<offset>\n<length>\n", padded to a 512-byte block
    let text = "";
    let used = 0;
    const lines = (): string[] => text.split("\n");
    const need = (): number => {
      const l = lines();
      const count = Number(l[0]);
      if (l.length < 2 || !Number.isSafeInteger(count) || count < 0) return l.length < 2 ? 1 : -1;
      return l.length - 1 >= 1 + count * 2 ? 0 : 1;
    };
    for (;;) {
      const n = need();
      if (n < 0) throw new TarError("corrupt sparse map");
      if (n === 0) break;
      if (used + 512 > left || used >= MAX_META) throw new TarError("corrupt sparse map");
      const blk = await r.take(512);
      if (!blk) throw new TarError("truncated archive stream");
      used += 512;
      text += blk.toString("latin1");
      if (!text.includes("\n")) throw new TarError("corrupt sparse map");
    }
    const parts = lines();
    const count = Number(parts[0]);
    map = [];
    for (let i = 0; i < count; i++) map.push([Number(parts[1 + i * 2]), Number(parts[2 + i * 2])]);
    left -= used;
  }
  let pos = 0;
  let packed = 0;
  for (const [off, len] of map) {
    if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < pos || len < 0 || off + len > sp.realSize) throw new TarError("corrupt sparse map");
    yield* zeros(off - pos);
    yield* r.body(len);
    pos = off + len;
    packed += len;
  }
  if (packed > left) throw new TarError("corrupt sparse map");
  if (packed < left) await r.skip(left - packed);
  yield* zeros(sp.realSize - pos);
}

/**
 * Yields each entry header; the caller MUST either consume `body()` fully or
 * call `skipBody()` before asking for the next entry.
 */
export async function* readTar(src: Readable): AsyncGenerator<{ h: TarHeader; body: () => AsyncGenerator<Buffer>; skipBody: () => Promise<void> }> {
  const r = new Reader(src);
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    const raw = await r.take(512);
    if (!raw) return;
    if (raw.every((x) => x === 0)) {
      await r.drain();
      return;
    }
    if (!checksumOk(raw)) throw new TarError("corrupt tar header");
    const tf = String.fromCharCode(raw[156] === 0 ? 48 : raw[156]!);
    let size = num(raw, 124, 12);
    if (size < 0) throw new TarError("entry size out of range");
    if (tf === "x") {
      pax = { ...pax, ...parsePax(await readMeta(r, size)) };
      continue;
    }
    if (tf === "g") {
      await readMeta(r, size);
      continue;
    }
    if (tf === "L") {
      longName = cstr(await readMeta(r, size), 0, size);
      continue;
    }
    if (tf === "K") {
      longLink = cstr(await readMeta(r, size), 0, size);
      continue;
    }
    const ustar = cstr(raw, 257, 5) === "ustar";
    let name = cstr(raw, 0, 100);
    const prefix = ustar ? cstr(raw, 345, 155) : "";
    if (prefix) name = prefix + "/" + name;
    const sparse = sparseOf(pax);
    name = sparse?.name ?? pax.path ?? longName ?? name;
    const linkname = pax.linkpath ?? longLink ?? cstr(raw, 157, 100);
    if (pax.size !== undefined) {
      const s = Number(pax.size);
      if (!Number.isSafeInteger(s) || s < 0) throw new TarError("bad pax size");
      size = s;
    }
    // a pax mtime keeps the fraction and the sign that the 12-byte header field cannot
    const paxTime = pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : NaN;
    pax = {};
    longName = longLink = undefined;
    const type: TarHeader["type"] =
      tf === "0" || tf === "7" ? "file" : tf === "5" ? "dir" : tf === "2" ? "symlink" : tf === "1" ? "hardlink" : "other";
    // the bytes stored after the header; for a sparse file that is the packed data (and, in format 1.0, its map)
    const stored = type === "file" || type === "other" ? size : 0;
    const dataSize = sparse && type === "file" ? sparse.realSize : stored;
    const h: TarHeader = { name, type, size: dataSize, mode: num(raw, 100, 8), mtime: Number.isSafeInteger(paxTime) ? paxTime : num(raw, 136, 12), linkname };
    let consumed = false;
    const pad = (512 - (stored % 512)) % 512;
    yield {
      h,
      body: async function* () {
        consumed = true;
        if (sparse && type === "file") yield* sparseBody(r, sparse, stored);
        else yield* r.body(stored);
        if (pad) await r.skip(pad);
      },
      skipBody: async () => {
        if (consumed) return;
        consumed = true;
        await r.skip(stored + pad);
      },
    };
    if (!consumed) await r.skip(stored + pad);
  }
}
