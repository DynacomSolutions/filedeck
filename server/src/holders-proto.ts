/**
 * The records that `filedeck-holders` writes to its stdout (server/native/filedeck-holders.h): a fixed part of 48 bytes and `nchain` 64-bit numbers,
 * little endian, `len` the whole size. A start failure is one line of JSON before any record (a record never starts with the byte "{").
 */

export const HT = {
  FD: 1,
  CLOSE: 2,
  CWD: 3,
  ROOT: 4,
  EXECBEG: 5,
  EXE: 6,
  MMAP: 7,
  FORK: 8,
  EXIT: 9,
  MOVED: 10,
  DIRTY: 11,
  SFD: 21,
  SCWD: 23,
  SROOT: 24,
  SEXE: 26,
  SMMAP: 27,
  SNAPBEG: 30,
  SNAPEND: 31,
  SEEDEND: 32,
  STATS: 40,
  HELLO: 41,
} as const;

export const HF_TRUNCATED = 1;
export const HF_SHARED = 2;
export const HF_VANISHED = 4;
export const HF_ERROR = 8;

export const HDR_BYTES = 48;
const MAX_RECORD = HDR_BYTES + 8 * 256;

export interface HolderRec {
  type: number;
  pid: number;
  aux: number;
  /** the kernel's device number of the superblock: (major << 20) | minor */
  dev: number;
  flags: number;
  ino: number;
  comm: string;
  /** the inode numbers of the folders above the entry, up to the root of its superblock */
  chain: Float64Array;
}

/** What a stream is: not yet known, a failure line, or records. */
export type Decoded = { failure: string } | { recs: HolderRec[] };

const TWO32 = 4294967296;
/** The flag bit that this decoder adds to a record that holds a number above 2^53 (it cannot be told apart from others exactly). */
export const HF_LOSSY = 1 << 8;

function u64(buf: Buffer, off: number): { v: number; lossy: boolean } {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return { v: hi * TWO32 + lo, lossy: hi >= 0x200000 };
}

/** Reads the stream in pieces of any size. `push` returns the records that are complete now. */
export class HolderDecoder {
  #buf: Buffer = Buffer.alloc(0);
  #mode: "start" | "records" | "failed" = "start";
  /** the number of records, and of bytes, that were read */
  records = 0;

  push(chunk: Buffer): Decoded {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    if (this.#mode === "failed") return { recs: [] };
    if (this.#mode === "start") {
      if (this.#buf.length === 0) return { recs: [] };
      if (this.#buf[0] === 0x7b) {
        const nl = this.#buf.indexOf(0x0a);
        if (nl < 0) return { recs: [] }; // the line is not complete yet
        this.#mode = "failed";
        return { failure: failureText(this.#buf.subarray(0, nl).toString("utf8")) };
      }
      this.#mode = "records";
    }
    const recs: HolderRec[] = [];
    let off = 0;
    const b = this.#buf;
    while (b.length - off >= 4) {
      const len = b.readUInt32LE(off);
      if (len < HDR_BYTES || len > MAX_RECORD || len % 8 !== 0) {
        this.#mode = "failed";
        return { failure: `the helper wrote a record of ${len} bytes` };
      }
      if (b.length - off < len) break;
      const nchain = b.readUInt16LE(off + 6);
      if (HDR_BYTES + nchain * 8 !== len) {
        this.#mode = "failed";
        return { failure: `the helper wrote a record with ${nchain} chain numbers in ${len} bytes` };
      }
      const ino = u64(b, off + 24);
      let flags = b.readUInt32LE(off + 20);
      if (ino.lossy) flags |= HF_LOSSY | HF_TRUNCATED;
      const chain = new Float64Array(nchain);
      for (let i = 0; i < nchain; i++) {
        const n = u64(b, off + HDR_BYTES + i * 8);
        chain[i] = n.v;
        if (n.lossy) flags |= HF_LOSSY | HF_TRUNCATED;
      }
      const commEnd = b.indexOf(0, off + 32);
      const end = commEnd >= 0 && commEnd < off + 48 ? commEnd : off + 48;
      recs.push({
        type: b.readUInt16LE(off + 4),
        pid: b.readUInt32LE(off + 8),
        aux: b.readUInt32LE(off + 12),
        dev: b.readUInt32LE(off + 16),
        flags,
        ino: ino.v,
        comm: b.toString("latin1", off + 32, end),
        chain,
      });
      off += len;
    }
    this.records += recs.length;
    this.#buf = off === b.length ? Buffer.alloc(0) : b.subarray(off);
    return { recs };
  }
}

function failureText(line: string): string {
  try {
    const j = JSON.parse(line) as { ok?: boolean; error?: unknown };
    if (j.ok === false && typeof j.error === "string") return j.error.slice(0, 400);
  } catch {
    // not JSON: the line itself
  }
  return line.slice(0, 400);
}

/** A record as the helper writes it (used by the tests and by the recorded fixtures). */
export function encodeRecord(r: { type: number; pid?: number; aux?: number; dev?: number; flags?: number; ino?: number; comm?: string; chain?: number[] }): Buffer {
  const chain = r.chain ?? [];
  const b = Buffer.alloc(HDR_BYTES + chain.length * 8);
  b.writeUInt32LE(b.length, 0);
  b.writeUInt16LE(r.type, 4);
  b.writeUInt16LE(chain.length, 6);
  b.writeUInt32LE(r.pid ?? 0, 8);
  b.writeUInt32LE(r.aux ?? 0, 12);
  b.writeUInt32LE(r.dev ?? 0, 16);
  b.writeUInt32LE(r.flags ?? 0, 20);
  const put = (n: number, off: number) => {
    b.writeUInt32LE(n % TWO32, off);
    b.writeUInt32LE(Math.floor(n / TWO32), off + 4);
  };
  put(r.ino ?? 0, 24);
  b.write(r.comm ?? "", 32, 15, "latin1");
  chain.forEach((n, i) => put(n, HDR_BYTES + i * 8));
  return b;
}

/** The kernel's device number of a `stat` device (the number that Node gives): (major << 20) | minor. */
export function kernelDev(statDev: bigint | number): number {
  const d = BigInt(statDev);
  const major = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn & 0xffffffffn));
  const minor = Number((d & 0xffn) | ((d >> 12n) & ~0xffn & 0xfffffn));
  return ((major << 20) | (minor & 0xfffff)) >>> 0;
}
