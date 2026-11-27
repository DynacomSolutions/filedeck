import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { formatCursor } from "./cursor.ts";

/**
 * The event journal of one agent: a bounded, append-only record of the encoded event lines, so a subscriber that was away can read what it
 * missed. Lines are kept as they were sent (JSON, one per line, the cursor first), in segment files `seg-<first seq>.jsonl` next to a `meta.json` that
 * holds the epoch. Whole segments are removed from the old end when the journal is older than `maxAgeMs` or larger than `maxBytes`.
 * The last events are also kept in memory (the ring), so a client that is close behind reads no file.
 *
 * Only the process that holds the agent's writer lease appends (the Bus asks, see bus.ts). The cursor is `<node>:<epoch>:<seq>`; a new epoch starts
 * when the journal is lost or started over (no segment left, an unreadable `meta.json`), and whenever the last writer did not stop cleanly: `meta.json` says
 * `clean` only after `close()` wrote every event, and `open()` clears it. A crash, a failed write or a lost lease leaves it cleared, so a restart never
 * continues an epoch from a disk that is behind what readers were told (sequence numbers would then mean other events).
 * Without a directory (`dir` null) the journal lives in memory only, with a new epoch at every start.
 */

export interface JournalOptions {
  /** where the segments live; null = memory only */
  dir: string | null;
  node: string;
  /** keep at most this many bytes on disk (default 2 GiB) */
  maxBytes?: number;
  /** drop segments whose last event is older than this (default 24 h) */
  maxAgeMs?: number;
  /** a segment is closed once it holds this many bytes (default: a quarter of the limit, at most 64 MiB) */
  segmentBytes?: number;
  /** events kept in memory (default 8192) and their bytes (default 8 MiB) */
  ringEvents?: number;
  ringBytes?: number;
  /** pending lines are written at least this often (default 50 ms) */
  flushMs?: number;
  now?: () => number;
  log?: (s: string) => void;
}

/** The cursor asked for is not in the journal any more (older than its start, from another epoch, or from after its end). */
export class JournalGap extends Error {
  constructor(public why: "epoch" | "old" | "future" | "lost") {
    super(`journal gap: ${why}`);
  }
}

interface Segment {
  first: number;
  last: number;
  bytes: number;
  /** time of the segment's last event */
  lastTime: number;
  /** time of the segment's first event (0 = not known) */
  firstTime: number;
  file: string;
}

const SEG = /^seg-(\d{15})\.jsonl$/;
const segName = (first: number) => `seg-${String(first).padStart(15, "0")}.jsonl`;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_AGE = 24 * 3600_000;
const FLUSH_BYTES = 256 * 1024;
const READ_CHUNK = 256 * 1024;

/** The sequence number in a line that starts `{"cursor":"<node>:<epoch>:<seq>"`. */
export function lineSeq(line: Buffer, from = 0): number {
  const end = line.indexOf(0x22, from + 11); // the quote that ends the cursor
  if (end < 0) return -1;
  const colon = line.lastIndexOf(0x3a, end);
  if (colon < 0) return -1;
  let n = 0;
  for (let i = colon + 1; i < end; i++) {
    const d = line[i]! - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
}

export class Journal {
  epoch = "";
  private seq = 0;
  private segs: Segment[] = [];
  private ring: { seq: number; time: number; line: Buffer }[] = [];
  private ringBytes = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private pendingFirst = 0;
  private pendingLastTime = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private fh: fsp.FileHandle | null = null;
  private opened = false;
  private failed = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  /** true while `release()` runs: what is queued is dropped, and nothing more is written (the lease is gone) */
  private dropping = false;
  /** how many times `open()` found a journal that its last writer had not closed cleanly (a crash, a failed write, a lost lease) */
  uncleanOpens = 0;
  /** false when the directory must not be used by this process (it has no lease on the shared state): the journal is then in memory only */
  private disk = true;
  appended = 0;
  /** until when the writer before this one watched (its last heartbeat or clean stop); 0 = unknown or a new journal */
  coveredUntil = 0;
  private lastCover = 0;
  private o: Required<Pick<JournalOptions, "maxBytes" | "maxAgeMs" | "ringEvents" | "ringBytes" | "flushMs">> & JournalOptions & { segmentBytes: number; now: () => number };

  constructor(o: JournalOptions) {
    const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
    this.o = {
      ...o,
      maxBytes,
      maxAgeMs: o.maxAgeMs ?? DEFAULT_MAX_AGE,
      segmentBytes: o.segmentBytes ?? Math.max(4096, Math.min(64 * 1024 * 1024, Math.floor(maxBytes / 4))),
      ringEvents: o.ringEvents ?? 8192,
      ringBytes: o.ringBytes ?? 8 * 1024 * 1024,
      flushMs: o.flushMs ?? 50,
      now: o.now ?? Date.now,
    };
    this.epoch = newEpoch();
  }

  get dir(): string | null {
    return this.o.dir;
  }

  /** The newest sequence number (0 = none yet). */
  get head(): number {
    return this.seq;
  }

  /** The oldest sequence number a reader can still get (head + 1 when the journal is empty). */
  get oldest(): number {
    if (this.segs.length) return this.segs[0]!.first;
    if (this.pending.length) return this.pendingFirst; // (written but for the flush that is due)
    return this.ring.length ? this.ring[0]!.seq : this.seq + 1;
  }

  /** Time of the newest event on disk or in the ring (0 = none). */
  get lastTime(): number {
    return Math.max(this.pendingLastTime, this.ring.at(-1)?.time ?? 0, this.segs.at(-1)?.lastTime ?? 0);
  }

  get bytes(): number {
    return this.segs.reduce((n, s) => n + s.bytes, 0) + this.pendingBytes;
  }

  /** Age in ms of the oldest event still held (0 = none). */
  get oldestAgeMs(): number {
    const t = this.segs[0]?.firstTime || this.ring[0]?.time || 0;
    return t ? Math.max(0, this.o.now() - t) : 0;
  }

  /** false when the directory could not be used: the journal then lives in memory only */
  get persistent(): boolean {
    return this.o.dir !== null && !this.failed && this.disk;
  }

  /** Read what is on disk: the epoch, the segments and where the sequence continues. A directory that cannot be used leaves the journal in memory. */
  async open(disk = true): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    this.disk = disk;
    const dir = this.o.dir;
    if (!dir || !disk) return;
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const names = (await fsp.readdir(dir)).filter((n) => SEG.test(n)).sort();
      let epoch = "";
      let clean = false;
      this.coveredUntil = 0;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8")) as { epoch?: unknown; node?: unknown; clean?: unknown; covered?: unknown };
        if (typeof m.epoch === "string" && /^[0-9a-z]{1,16}$/.test(m.epoch) && m.node === this.o.node) epoch = m.epoch;
        clean = m.clean === true;
        if (!clean) this.uncleanOpens++;
        this.coveredUntil = typeof m.covered === "number" ? m.covered : 0;
      } catch {
        /* no meta, or damaged: a new epoch below */
      }
      const segs: Segment[] = [];
      for (const n of names) {
        const file = path.join(dir, n);
        const st = await fsp.stat(file);
        segs.push({ first: Number(SEG.exec(n)![1]), last: Number(SEG.exec(n)![1]) - 1, bytes: st.size, lastTime: st.mtimeMs, firstTime: 0, file });
      }
      // the tail of the newest segment tells where the sequence continues; a half-written last line is cut off
      const lastSeg = segs.at(-1);
      let ok = !!epoch && clean && segs.length > 0;
      if (ok && lastSeg) ok = await this.scanTail(lastSeg);
      if (ok) {
        for (let i = 0; i < segs.length - 1; i++) segs[i]!.last = segs[i + 1]!.first - 1;
        this.segs = segs.filter((s) => s.last >= s.first - 1);
        this.seq = lastSeg!.last;
        this.epoch = epoch;
        const first = this.segs[0];
        if (first) first.firstTime = await this.firstTimeOf(first);
      } else {
        // not stopped cleanly, lost or damaged: nothing on disk is trusted, the epoch changes, and old cursors get a reset
        for (const s of segs) await fsp.rm(s.file, { force: true });
        this.segs = [];
        this.seq = 0;
        this.epoch = newEpoch();
        this.coveredUntil = 0;
      }
      await this.writeMeta(false); // (the clean mark is cleared while this process writes)
    } catch (e) {
      this.failed = true;
      this.segs = [];
      this.seq = 0;
      this.epoch = newEpoch();
      this.o.log?.(`event journal: ${dir} cannot be used (${(e as Error).message}); events are kept in memory only`);
    }
  }

  private async writeMeta(clean: boolean): Promise<void> {
    const dir = this.o.dir!;
    // (two containers of one volume may both be process 1: the name holds random bytes, not only the process number)
    const tmp = path.join(dir, `meta.json.${process.pid}.${randomBytes(6).toString("hex")}`);
    try {
      await fsp.writeFile(tmp, JSON.stringify({ epoch: this.epoch, node: this.o.node, clean, covered: this.o.now() }), { mode: 0o600 });
      // (a release that started while the file was written: the lease is gone, so `meta.json` is not replaced, it belongs to the next writer)
      if (this.dropping) {
        await fsp.rm(tmp, { force: true });
        return;
      }
      await fsp.rename(tmp, path.join(dir, "meta.json"));
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /** The writer is watching now: noted in `meta.json` (at most every 5 s), so the process after this one can tell whether anything went unseen between the two. */
  cover(): void {
    if (!this.persistent || this.closed || this.dropping || this.o.now() - this.lastCover < 5000) return;
    this.lastCover = this.o.now();
    this.chain = this.chain.then(() => (this.dropping ? undefined : this.writeMeta(false))).catch((e) => this.fail(e));
  }

  /** Last complete line of a segment: sets its `last` and `lastTime`, cuts a partial line. False when the segment holds nothing readable. */
  private async scanTail(s: Segment): Promise<boolean> {
    const fh = await fsp.open(s.file, "r+");
    try {
      const size = (await fh.stat()).size;
      if (size === 0) return false;
      const len = Math.min(size, 128 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const nl = buf.lastIndexOf(0x0a);
      if (nl < 0) return false;
      if (nl !== len - 1) {
        await fh.truncate(size - len + nl + 1);
        s.bytes = size - len + nl + 1;
      }
      const start = buf.lastIndexOf(0x0a, nl - 1) + 1;
      const last = buf.subarray(start, nl);
      const seq = lineSeq(last);
      if (seq < s.first) return false;
      s.last = seq;
      try {
        s.lastTime = (JSON.parse(last.toString("utf8")) as { time?: number }).time ?? s.lastTime;
      } catch {
        return false;
      }
      return true;
    } finally {
      await fh.close();
    }
  }

  private async firstTimeOf(s: Segment): Promise<number> {
    try {
      const fh = await fsp.open(s.file, "r");
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
        return nl > 0 ? ((JSON.parse(buf.subarray(0, nl).toString("utf8")) as { time?: number }).time ?? 0) : 0;
      } finally {
        await fh.close();
      }
    } catch {
      return 0;
    }
  }

  /** The cursor and sequence the next event gets. */
  next(): { seq: number; cursor: string } {
    const seq = this.seq + 1;
    return { seq, cursor: formatCursor(this.o.node, this.epoch, seq) };
  }

  /** Keep an event (the line the bus encoded with `next()`'s cursor). */
  write(seq: number, time: number, line: Buffer): void {
    if (seq !== this.seq + 1) throw new Error("journal: events must be written in order");
    this.seq = seq;
    this.appended++;
    this.ring.push({ seq, time, line });
    this.ringBytes += line.length;
    while (this.ring.length > this.o.ringEvents || this.ringBytes > this.o.ringBytes) this.ringBytes -= this.ring.shift()!.line.length;
    if (!this.persistent || this.closed || this.dropping) return;
    if (!this.pending.length) this.pendingFirst = seq;
    this.pending.push(line);
    this.pendingBytes += line.length;
    this.pendingLastTime = time;
    if (this.pendingBytes >= FLUSH_BYTES) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.o.flushMs);
      this.timer.unref();
    }
  }

  /** Write the pending lines; resolves when they are on disk (and older segments are trimmed). Never rejects. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.chain = this.chain.then(() => (this.dropping ? undefined : this.doFlush())).catch((e) => this.fail(e));
    return this.chain;
  }

  private fail(e: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.o.log?.(`event journal: writing failed (${(e as Error).message}); events are kept in memory only from now on`);
  }

  private async doFlush(): Promise<void> {
    if (!this.pending.length || !this.o.dir || this.dropping) return;
    const lines = this.pending;
    const first = this.pendingFirst;
    const bytes = this.pendingBytes;
    const lastTime = this.pendingLastTime;
    this.pending = [];
    this.pendingBytes = 0;
    const data = lines.length === 1 ? lines[0]! : Buffer.concat(lines);
    let cur = this.segs.at(-1);
    // Each step below checks `dropping` again: a `release()` can start while an earlier step waits on the disk, and after it started nothing may be
    // written (the lease is gone, the next writer owns the folder). A file handle that was opened meanwhile is closed again.
    if (!this.fh && cur && cur.bytes < this.o.segmentBytes) {
      const fh = await fsp.open(cur.file, "a"); // (the first flush after open continues the last segment)
      if (this.dropping) return void (await fh.close().catch(() => {}));
      this.fh = fh;
    }
    if (!cur || cur.bytes >= this.o.segmentBytes) {
      await this.fh?.close();
      this.fh = null;
      if (this.dropping) return;
      const file = path.join(this.o.dir, segName(first));
      const fh = await fsp.open(file, "a", 0o600);
      if (this.dropping) return void (await fh.close().catch(() => {}));
      this.fh = fh;
      cur = { first, last: first - 1, bytes: 0, lastTime, firstTime: 0, file };
      this.segs.push(cur);
    }
    cur = this.segs.at(-1)!;
    if (this.dropping) return;
    await this.fh!.write(data);
    cur.bytes += bytes;
    cur.last = first + lines.length - 1;
    cur.lastTime = lastTime;
    if (!cur.firstTime) cur.firstTime = this.ring.find((r) => r.seq === first)?.time ?? lastTime;
    await this.trim();
  }

  private async trim() {
    const now = this.o.now();
    while (this.segs.length > 1) {
      const s = this.segs[0]!;
      const total = this.segs.reduce((n, x) => n + x.bytes, 0);
      if (total <= this.o.maxBytes && s.lastTime >= now - this.o.maxAgeMs) break;
      if (this.dropping) return;
      this.segs.shift();
      await fsp.rm(s.file, { force: true });
    }
  }

  /** Start over: a new epoch, nothing kept. Subscribers with an old cursor get a reset. */
  async reset(): Promise<void> {
    await this.flush();
    await this.fh?.close();
    this.fh = null;
    for (const s of this.segs) await fsp.rm(s.file, { force: true });
    this.segs = [];
    this.ring = [];
    this.ringBytes = 0;
    this.seq = 0;
    this.epoch = newEpoch();
    if (this.persistent) await this.writeMeta(false).catch((e) => this.fail(e));
  }

  /** Can a reader holding `since` (a parsed cursor's epoch and sequence) continue from here? Else why not. */
  check(epoch: string, seq: number): JournalGap | null {
    if (epoch !== this.epoch) return new JournalGap("epoch");
    if (seq > this.seq) return new JournalGap("future");
    if (seq + 1 < this.oldest) return new JournalGap("old");
    return null;
  }

  /**
   * The lines with a sequence above `after` and up to `upTo`, as chunks that hold whole lines. Starts from the ring when it reaches back far enough,
   * else from the files (after the pending lines were written). Throws JournalGap when the start is no longer held (a segment was trimmed meanwhile).
   */
  async *read(after: number, upTo: number): AsyncGenerator<Buffer> {
    if (after >= upTo) return;
    const r0 = this.ring[0];
    if (r0 && after + 1 >= r0.seq) {
      // a copy of what is wanted, taken at once: `write()` may shift the ring while a chunk is being passed on, and an index into the live ring would skip events
      const first = Math.max(0, after + 1 - r0.seq);
      const wanted = this.ring.slice(first, Math.max(first, upTo - r0.seq + 1));
      let batch: Buffer[] = [];
      let n = 0;
      let expect = after + 1;
      for (const r of wanted) {
        if (r.seq !== expect) throw new JournalGap("lost"); // (the ring is in order: this cannot happen, and a hole is never passed on silently)
        expect++;
        batch.push(r.line);
        n += r.line.length;
        if (n >= READ_CHUNK) {
          yield Buffer.concat(batch);
          batch = [];
          n = 0;
        }
      }
      if (batch.length) yield Buffer.concat(batch);
      return;
    }
    if (!this.persistent) throw new JournalGap("old");
    await this.flush();
    if (after + 1 < this.oldest) throw new JournalGap("old");
    let expect = after + 1;
    for (const s of [...this.segs]) {
      if (s.last < expect) continue;
      if (s.first > expect) throw new JournalGap("lost");
      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(s.file, "r");
      } catch {
        throw new JournalGap("lost"); // trimmed while this read waited
      }
      try {
        let carry: Buffer = Buffer.alloc(0);
        let pos = 0;
        const buf = Buffer.alloc(READ_CHUNK);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          let chunk: Buffer = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
          const nl = chunk.lastIndexOf(0x0a);
          if (nl < 0) {
            carry = chunk;
            continue;
          }
          carry = Buffer.from(chunk.subarray(nl + 1));
          chunk = chunk.subarray(0, nl + 1);
          // cut the lines at or below `after` from the front, and the ones above `upTo` from the end
          let start = 0;
          while (start < chunk.length && lineSeq(chunk, start) <= after) {
            const e = chunk.indexOf(0x0a, start);
            start = e < 0 ? chunk.length : e + 1;
          }
          let end = start;
          let stop = false;
          while (end < chunk.length) {
            if (lineSeq(chunk, end) > upTo) {
              stop = true;
              break;
            }
            const e = chunk.indexOf(0x0a, end);
            end = e < 0 ? chunk.length : e + 1;
          }
          if (end > start) yield chunk.subarray(start, end);
          if (stop) return;
        }
      } finally {
        await fh.close();
      }
      expect = s.last + 1;
    }
  }

  /**
   * Write what is pending and close the file. A journal that wrote every event notes `clean` in `meta.json`, so the next process continues its epoch; one
   * that failed to write, or that gave up its place (`release`), does not. With `remove`, delete the journal's directory (a journal made in a temporary place).
   */
  close(remove = false): Promise<void> {
    // (once only: a second call, after the lease went to a new process, must not write `meta.json` again with this journal's old epoch)
    return (this.closing ??= this.doClose(remove));
  }

  private async doClose(remove: boolean): Promise<void> {
    await this.flush();
    if (this.opened && this.persistent && !remove) await this.writeMeta(true).catch(() => {});
    this.closed = true;
    await this.fh?.close().catch(() => {});
    this.fh = null;
    if (remove && this.o.dir) fs.rmSync(this.o.dir, { recursive: true, force: true });
  }

  /**
   * This process is no longer the writer: write what is pending, close the file, and forget everything held (sequence, segments, ring), so a later `open()`
   * reads the disk as the next writer left it. The `clean` mark is not set: the next opener, this process included, starts a new epoch.
   */
  async release(): Promise<void> {
    // the lease is gone: the lines that are pending and the meta writes that are queued are dropped, and nothing more is written (the new writer owns the folder)
    this.dropping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
    this.pendingBytes = 0;
    // (a write that is already running is not stopped half way: it ends at its next check of `dropping`, and this waits for that, so nothing runs after this returns)
    await this.chain;
    await this.fh?.close().catch(() => {});
    this.fh = null;
    this.segs = [];
    this.ring = [];
    this.ringBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.seq = 0;
    this.epoch = newEpoch();
    this.coveredUntil = 0;
    this.lastCover = 0;
    this.failed = false;
    this.disk = true;
    this.opened = false;
    this.dropping = false;
  }
}

function newEpoch(): string {
  return Date.now().toString(36) + randomBytes(2).toString("hex");
}
