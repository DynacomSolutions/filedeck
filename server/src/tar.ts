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
    // base-256 (GNU), big-endian two's complement without the marker bit
    let v = (b[off]! & 0x7f) as number;
    for (let i = 1; i < len; i++) v = v * 256 + b[off + i]!;
    if (!Number.isSafeInteger(v)) throw new TarError("entry size out of range");
    return v;
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
    name = pax.path ?? longName ?? name;
    const linkname = pax.linkpath ?? longLink ?? cstr(raw, 157, 100);
    if (pax.size !== undefined) {
      const s = Number(pax.size);
      if (!Number.isSafeInteger(s) || s < 0) throw new TarError("bad pax size");
      size = s;
    }
    pax = {};
    longName = longLink = undefined;
    const type: TarHeader["type"] =
      tf === "0" || tf === "7" ? "file" : tf === "5" ? "dir" : tf === "2" ? "symlink" : tf === "1" ? "hardlink" : "other";
    const dataSize = type === "file" || type === "other" ? size : 0;
    const h: TarHeader = { name, type, size: dataSize, mode: num(raw, 100, 8), mtime: num(raw, 136, 12), linkname };
    let consumed = false;
    const pad = (512 - (dataSize % 512)) % 512;
    yield {
      h,
      body: async function* () {
        consumed = true;
        yield* r.body(dataSize);
        if (pad) await r.skip(pad);
      },
      skipBody: async () => {
        if (consumed) return;
        consumed = true;
        await r.skip(dataSize + pad);
      },
    };
    if (!consumed) await r.skip(dataSize + pad);
  }
}
