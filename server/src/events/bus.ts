import { FsError } from "../fsops.ts";
import { formatCursor, parseCursor } from "./cursor.ts";
import { Filter } from "./filter.ts";
import { Journal, JournalGap, lineSeq, type JournalOptions } from "./journal.ts";
import { LabelRules } from "./labels.ts";
import { CONTROL_KINDS, encodeEvent, laggedLine, pingLine, type ChangeEvent, type Encoded, type Matchable, type NewEvent } from "./types.ts";

/**
 * The agent's event bus: one in-process point where the watcher's events enter (`publish`), get a cursor, are encoded once, are kept in the
 * journal, and are handed to every subscriber whose filter accepts them. A subscriber is a bounded queue: one that does not read fast enough
 * is ended with a `lagged` line and reads the journal when it comes back, so a slow reader never holds the bus or the watcher.
 *
 * Only the process that holds the agent's writer lease writes the journal and serves subscribers (`writer`). Another process (a new one during a rolling
 * deploy) only stages what it sees, and when it becomes the writer it appends what the process before it did not see (see `adopt`).
 */

export type Transport = "socket" | "http" | "internal";

export interface BusOptions {
  node: string;
  journal: Omit<JournalOptions, "node" | "now" | "log">;
  labels?: LabelRules;
  /** may this process write the journal and serve readers? (the size store's lease). Default: always. Only asked when the journal is on disk. */
  writer?: () => boolean;
  /**
   * may this process use the journal's folder? Asked when the journal is opened. False (the size store is unusable, so there is no lease to say who writes):
   * the journal stays in memory, so two processes never write the same files. Default: yes.
   */
  disk?: () => boolean;
  now?: () => number;
  /** the most bytes one subscriber may have queued before it is ended as lagged (default 1 MiB) */
  maxQueueBytes?: number;
  /** a subscriber that has nothing to read for this long gets a `ping` line (default 15 s) */
  pingMs?: number;
  /** events a process that is not the writer keeps for the time it becomes one (default 100000) */
  stageMax?: number;
  /** how long a subscriber waits for this process to become the writer (default 15 s) */
  writerWaitMs?: number;
  log?: (s: string) => void;
}

/** An event as it was published, with its labels, waiting for the journal. */
type Staged = NewEvent & { time: number; labels?: Record<string, string>; fromLabels?: Record<string, string> };

/** Seen again after the previous writer's last event: the overlap that makes a hand-over lose nothing (a repeat is allowed, a gap is not). */
const ADOPT_SLACK_MS = 2000;

export class Subscriber {
  private q: Buffer[] = [];
  private qSeq: number[] = [];
  private qBytes = 0;
  private waiter: (() => void) | null = null;
  private room: (() => void) | null = null;
  private live: Encoded[] = [];
  private liveBytes = 0;
  state: "replay" | "live" | "closing" | "closed" = "live";
  /** the newest sequence number handed to the transport (or evaluated, for a ping): the point to resume from */
  delivered = 0;
  sent = 0;

  constructor(
    readonly bus: EventBus,
    readonly filter: Filter,
    readonly transport: Transport,
  ) {}

  /** The bus offers each new event. */
  offer(e: Encoded): void {
    if (this.state === "closed" || this.state === "closing") return;
    if (!this.filter.match(e)) {
      // nothing is queued for an event the filter refuses; the resume point still moves when nothing is waiting before it
      if (this.state === "live" && !this.q.length) this.delivered = e.seq;
      return;
    }
    if (this.state === "replay") {
      this.live.push(e);
      this.liveBytes += e.line.length;
      if (this.liveBytes > this.bus.maxQueueBytes) this.lag();
      return;
    }
    this.enqueue(e.line, e.seq);
    if (this.qBytes > this.bus.maxQueueBytes) this.lag();
  }

  private enqueue(line: Buffer, seq: number) {
    this.q.push(line);
    this.qSeq.push(seq);
    this.qBytes += line.length;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The queue filled: drop it, say so, end the stream once that line is read. */
  private lag() {
    this.bus.droppedLagged++;
    this.q = [laggedLine(this.bus.node, this.delivered ? this.bus.cursorOf(this.delivered) : undefined)];
    this.qSeq = [0];
    this.qBytes = this.q[0]!.length;
    this.live = [];
    this.liveBytes = 0;
    this.state = "closing";
    this.room?.();
    this.wake();
  }

  /** Called by the bus: this subscriber starts at the journal position `since` (or live when none). */
  async start(since: { epoch: string; seq: number } | null, head: number): Promise<void> {
    if (!since) {
      this.state = "live";
      return;
    }
    this.state = "replay";
    this.delivered = since.seq;
    try {
      const gap = this.bus.journal.check(since.epoch, since.seq);
      if (gap) this.queueReset(gap.why);
      else {
        for await (const chunk of this.bus.journal.read(since.seq, head)) {
          if (this.state !== "replay") return;
          let start = 0;
          const out: Buffer[] = [];
          while (start < chunk.length) {
            let end = chunk.indexOf(0x0a, start);
            end = end < 0 ? chunk.length : end + 1;
            const line = chunk.subarray(start, end);
            start = end;
            if (this.accepts(line)) {
              out.push(line);
            }
          }
          for (const l of out) this.enqueue(l, lineSeq(l));
          this.bus.replayed += out.length;
          // flow control: the reader takes what is queued before more is read
          while (this.state === "replay" && this.qBytes > this.bus.maxQueueBytes / 2) await new Promise<void>((r) => (this.room = r));
        }
      }
    } catch (e) {
      if (!(e instanceof JournalGap)) throw e;
      this.queueReset(e.why);
    }
    if (this.state !== "replay") return;
    // events that came while the journal was read follow, in order, with nothing between
    this.state = "live";
    const live = this.live;
    this.live = [];
    this.liveBytes = 0;
    for (const e of live) this.offer(e);
  }

  private accepts(line: Buffer): boolean {
    if (this.filter.empty) return true;
    try {
      return this.filter.match(JSON.parse(line.toString("utf8")) as Matchable);
    } catch {
      return false;
    }
  }

  /** The cursor asked for cannot be continued from: one `reset` line (its cursor is the journal's head), then live events. */
  private queueReset(why: string) {
    const head = this.bus.journal.head;
    const line = Buffer.from(
      JSON.stringify({ cursor: this.bus.cursorOf(head), time: this.bus.now(), node: this.bus.node, kind: "reset", dir: false, scope: "node", reason: `cursor not usable (${why}): look at everything again` }) + "\n",
    );
    this.bus.resets++;
    this.delivered = head;
    this.enqueue(line, 0);
  }

  /** The next lines to send, or null once the stream is over. A `ping` comes when nothing happened for the ping time. */
  async next(): Promise<Buffer[] | null> {
    for (;;) {
      if (this.q.length) {
        const batch = this.q;
        const seqs = this.qSeq;
        this.q = [];
        this.qSeq = [];
        this.qBytes = 0;
        for (const s of seqs) if (s > this.delivered) this.delivered = s;
        this.sent += batch.length;
        this.room?.();
        return batch;
      }
      if (this.state === "closing" || this.state === "closed") return null;
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          this.waiter = null;
          // all that came so far was looked at: the ping's cursor lets a client with a narrow filter resume from here
          if (this.state === "live") this.enqueue(this.bus.pingLine(), this.bus.journal.head);
          res();
        }, this.bus.pingMs);
        t.unref();
        this.waiter = () => {
          clearTimeout(t);
          res();
        };
      });
    }
  }

  /** End the stream after `line`: what is queued is dropped. */
  endWith(line: Buffer): void {
    if (this.state === "closed") return;
    this.q = [line];
    this.qSeq = [0];
    this.qBytes = line.length;
    this.live = [];
    this.liveBytes = 0;
    this.state = "closing";
    this.room?.();
    this.wake();
  }

  /** The client is gone (or the stream is over): nothing more is queued. */
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.q = [];
    this.qSeq = [];
    this.live = [];
    this.bus.remove(this);
    this.room?.();
    this.wake();
  }
}

export class EventBus {
  readonly node: string;
  readonly journal: Journal;
  readonly labels: LabelRules;
  readonly maxQueueBytes: number;
  readonly pingMs: number;
  now: () => number;
  private subs = new Set<Subscriber>();
  private listeners = new Set<(e: Matchable) => void>();
  private stopListeners = new Set<() => void>();
  private releasing: Promise<void> | undefined;
  private stage: Staged[] = [];
  private stageLost = false;
  private state: "staging" | "opening" | "serving" | "demoting" | "closed" = "staging";
  private timer: NodeJS.Timeout | undefined;
  private waiters: ((ok: boolean) => void)[] = [];
  private readonly o: BusOptions;
  private _ready = false;
  // counters for /metrics (counts only)
  events: Record<string, number> = {};
  overflows = 0;
  resets = 0;
  droppedLagged = 0;
  replayed = 0;
  lastEventAt = 0;
  /** ms between an event's arrival from the helper and its hand-over to the subscribers (the larger of the last few) */
  lagMs = 0;

  constructor(o: BusOptions) {
    this.o = o;
    this.node = o.node;
    this.now = o.now ?? Date.now;
    this.labels = o.labels ?? new LabelRules();
    this.maxQueueBytes = o.maxQueueBytes ?? 1024 * 1024;
    this.pingMs = o.pingMs ?? 15_000;
    this.journal = new Journal({ ...o.journal, node: o.node, now: this.now, log: o.log });
    this.timer = setInterval(() => void this.advance(), 200);
    this.timer.unref();
  }

  /** `<node>:<epoch>:<seq>` of the journal as it is now */
  cursorOf(seq: number): string {
    return formatCursor(this.node, this.journal.epoch, seq);
  }

  /** true while the kernel watcher runs and has every mark in place (set by the watcher). When it turns false, `onStopped` listeners are told at once. */
  get ready(): boolean {
    return this._ready;
  }

  set ready(v: boolean) {
    const was = this._ready;
    this._ready = v;
    if (was && !v) for (const f of [...this.stopListeners]) this.safely(f);
  }

  /** Told when the watcher stops: what is held in memory about folders (the folder feed) is no longer kept current. */
  onStopped(fn: () => void): () => void {
    this.stopListeners.add(fn);
    return () => void this.stopListeners.delete(fn);
  }

  private safely(f: () => void) {
    try {
      f();
    } catch {
      /* a listener's fault is its own */
    }
  }

  get serving(): boolean {
    return this.state === "serving";
  }

  pingLine(): Buffer {
    const seq = this.journal.head;
    const b = pingLine(this.node);
    const o = JSON.parse(b.toString("utf8")) as Record<string, unknown>;
    return Buffer.from(JSON.stringify({ ...o, cursor: this.cursorOf(seq) }) + "\n");
  }

  /** Does this process write the journal? Always when the journal is in memory only. */
  private mayWrite(): boolean {
    return !this.journal.dir || !this.o.writer || this.o.writer();
  }

  /**
   * A listener sees every event the watcher publishes, at once and whether or not this process writes the journal (the folder feed of the compare index and
   * the live feed need the events of the kernel watcher also while another process is the writer). It runs before the filters of the subscribers.
   */
  listen(fn: (e: Matchable) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The watcher saw a change. Never throws, never waits. */
  publish(ev: NewEvent): void {
    if (this.state === "closed") return;
    const time = ev.time ?? this.now();
    const control = CONTROL_KINDS.has(ev.kind);
    const labels = ev.path !== undefined && !control ? this.labels.labels(ev.path) : undefined;
    const fromLabels = ev.from !== undefined ? this.labels.labels(ev.from) : undefined;
    const s: Staged = { ...ev, time, ...(labels ? { labels } : {}), ...(fromLabels && fromLabels !== labels ? { fromLabels } : {}) };
    if (this.listeners.size) {
      const m: Matchable = { kind: s.kind, dir: !!s.dir, path: s.path, from: s.from, labels: s.labels, fromLabels: s.fromLabels };
      for (const l of this.listeners) this.safely(() => l(m));
    }
    if (this.state === "serving") {
      // the lease is checked at each event: a process that lost it writes nothing more
      if (this.mayWrite()) return this.commit(s);
      this.demote("this process is no longer the writer");
    }
    this.stage.push(s);
    if (this.stage.length > (this.o.stageMax ?? 100_000)) {
      this.stage.splice(0, this.stage.length - (this.o.stageMax ?? 100_000) + 1000);
      this.stageLost = true;
    }
    void this.advance();
  }

  /** Becomes the writer when the lease allows (or at once without a journal on disk). */
  private async advance(): Promise<void> {
    if (this.state === "serving") {
      if (!this.mayWrite()) this.demote("this process is no longer the writer");
      else this.journal.cover();
      return;
    }
    if (this.state !== "staging" || !this.mayWrite()) return;
    this.state = "opening";
    try {
      await this.journal.open(this.o.disk ? this.o.disk() : true);
      const last = this.journal.lastTime;
      const covered = this.journal.coveredUntil;
      // Where did this process start to watch? Its first `ready` event, else its first event. A journal that was covered up to then (the process
      // before this one watched until a newer one was ready) has no gap; a journal that stopped being covered earlier has one.
      const watchStart = (this.stage.find((s) => s.kind === "ready") ?? this.stage[0])?.time ?? this.now();
      const adopt = last ? this.stage.filter((s) => s.time > last - ADOPT_SLACK_MS) : this.stage;
      if (this.stageLost || (covered > 0 && watchStart > covered + ADOPT_SLACK_MS)) {
        // what happened in between is unknown: subscribers look at everything again
        this.state = "serving";
        this.commit({ kind: "reset", time: this.now(), scope: "node", window: { from: covered || last || watchStart, to: watchStart }, reason: "events between two watchers were not seen" });
      }
      this.state = "serving";
      this.stage = [];
      this.stageLost = false;
      for (const s of adopt) this.commit(s);
      for (const w of this.waiters.splice(0)) w(true);
    } catch (e) {
      this.state = "staging";
      this.o.log?.(`event bus: ${(e as Error).message}`);
    }
  }

  /**
   * This process lost the writer lease: its subscribers are told to come back, the journal writes what it holds and lets go of its files and its state, and
   * the events that come meanwhile are staged. Re-promotion opens the journal again and reads the disk as the new writer left it.
   */
  private demote(why: string) {
    this.state = "demoting";
    for (const s of [...this.subs]) s.endWith(laggedLine(this.node, s.delivered ? this.cursorOf(s.delivered) : undefined));
    this.o.log?.(`event bus: ${why}`);
    const done = () => {
      if (this.state === "demoting") this.state = "staging";
    };
    this.releasing = this.journal.release().catch(() => {}).then(done);
  }

  private commit(s: Staged): void {
    const { seq, cursor } = this.journal.next();
    const ev: ChangeEvent = { ...s, cursor, time: s.time, node: this.node, dir: !!s.dir };
    const line = encodeEvent(ev);
    this.journal.write(seq, ev.time, line);
    const enc: Encoded = { seq, time: ev.time, kind: ev.kind, dir: ev.dir, path: ev.path, from: ev.from, labels: ev.labels, fromLabels: ev.fromLabels, line };
    this.events[ev.kind] = (this.events[ev.kind] ?? 0) + 1;
    if (ev.kind === "overflow") this.overflows++;
    if (ev.kind === "reset") this.resets++;
    this.lastEventAt = ev.time;
    const t0 = performance.now();
    for (const sub of this.subs) sub.offer(enc);
    this.lagMs = Math.max(this.lagMs * 0.9, performance.now() - t0);
  }

  /** Wait until this process may serve (it is the writer), at most `ms`. */
  whenServing(ms = this.o.writerWaitMs ?? 15_000): Promise<boolean> {
    if (this.state === "serving") return Promise.resolve(true);
    void this.advance();
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        res(false);
      }, ms);
      const done = (ok: boolean) => {
        clearTimeout(t);
        res(ok);
      };
      this.waiters.push(done);
    });
  }

  /**
   * A new subscriber. `since` is a cursor the client holds: the journal from there is sent first, then live events, with nothing between. A bad cursor
   * is a 400; one that cannot be continued (another epoch, older than the journal) is answered with one `reset` line. 503 when this process is not the writer.
   */
  async subscribe(filter: Filter, since: string | undefined, transport: Transport): Promise<Subscriber> {
    let cur: { epoch: string; seq: number } | null = null;
    if (since) {
      const c = parseCursor(since);
      if (!c || c.node !== this.node) throw new FsError(400, "since is not a cursor of this node");
      cur = { epoch: c.epoch, seq: c.seq };
    }
    if (!(await this.whenServing())) throw new FsError(503, "this process does not write the event journal yet, try again");
    const sub = new Subscriber(this, filter, transport);
    // registered and the head read in one step: an event is either at or below `head` (read from the journal) or offered to the subscriber
    const head = this.journal.head;
    sub.state = cur ? "replay" : "live";
    this.subs.add(sub);
    sub.start(cur, head).catch(() => sub.close());
    return sub;
  }

  remove(s: Subscriber) {
    this.subs.delete(s);
  }

  subscribers(): Record<Transport, number> {
    const n: Record<Transport, number> = { socket: 0, http: 0, internal: 0 };
    for (const s of this.subs) n[s.transport]++;
    return n;
  }

  close(removeJournal = false): Promise<void> {
    return (this.closing ??= this.doClose(removeJournal));
  }

  private closing: Promise<void> | undefined;

  private async doClose(removeJournal: boolean): Promise<void> {
    this.state = "closed";
    if (this.timer) clearInterval(this.timer);
    for (const s of [...this.subs]) s.close();
    for (const w of this.waiters.splice(0)) w(false);
    this.listeners.clear();
    this.stopListeners.clear();
    await this.releasing;
    await this.journal.close(removeJournal);
  }
}
