import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, type Subscriber } from "../src/events/bus.ts";
import { formatCursor, parseCursor } from "../src/events/cursor.ts";
import { Filter, filterFromParams } from "../src/events/filter.ts";
import { Journal, JournalGap, lineSeq } from "../src/events/journal.ts";
import { LabelRules } from "../src/events/labels.ts";
import type { Matchable } from "../src/events/types.ts";

const dirs: string[] = [];
const buses: EventBus[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "events-"));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const b of buses) await b.close().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(10);
};

function bus(o: Partial<ConstructorParameters<typeof EventBus>[0]> = {}) {
  const b = new EventBus({ node: "n1", journal: { dir: null }, ...o });
  buses.push(b);
  return b;
}
const ev = (kind: Matchable["kind"], p: string, extra: Record<string, unknown> = {}) => ({ kind, path: p, dir: false, ...extra }) as never;

/** Read lines from a subscriber until `n` lines came (or it ended); each line is parsed. */
async function take(sub: Subscriber, n: number, ms = 5000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const t0 = Date.now();
  while (out.length < n && Date.now() - t0 < ms) {
    const batch = await Promise.race([sub.next(), sleep(ms).then(() => undefined)]);
    if (batch === undefined || batch === null) break;
    for (const b of batch) out.push(JSON.parse(b.toString("utf8")));
  }
  return out;
}

// ---- cursor ----

test("cursor: formats, parses from the right (a node name may hold a colon) and refuses nonsense", () => {
  assert.equal(formatCursor("a", "k3j", 7), "a:k3j:7");
  assert.deepEqual(parseCursor("a:k3j:7"), { node: "a", epoch: "k3j", seq: 7 });
  assert.deepEqual(parseCursor("rack:1:b:k3j:12"), { node: "rack:1:b", epoch: "k3j", seq: 12 });
  for (const bad of ["", "a", "a:b", "a:b:c", "a:K:1", ":e:1", "a:e:-1", "a:e:1.5", "x".repeat(400)]) assert.equal(parseCursor(bad), null, bad);
});

// ---- labels ----

test("labels: segments only, the most specific template wins, the first of equals", () => {
  const l = new LabelRules("/srv/repos/{org}/{repo}\n/srv/repos/.worktrees/{org}/{task}/{repo}");
  assert.deepEqual(l.labels("/srv/repos/acme/app/src/x.ts"), { org: "acme", repo: "app" });
  assert.deepEqual(l.labels("/srv/repos/acme/app"), { org: "acme", repo: "app" });
  assert.deepEqual(l.labels("/srv/repos/.worktrees/acme/fix-1/app/a.txt"), { org: "acme", task: "fix-1", repo: "app" });
  assert.equal(l.labels("/srv/repos/acme"), undefined, "above the template depth");
  assert.equal(l.labels("/other/x"), undefined);
  assert.equal(l.labels("/"), undefined);
  assert.equal(new LabelRules().labels("/a"), undefined);
});

test("labels: a bad template is refused when it is read", () => {
  for (const bad of ["srv/{a}", "/{a}/{a}", "/a/{}", "/a/{b c}", "/a/x{b}", "/" + "{a}/".repeat(20), "/{1a}"]) assert.throws(() => new LabelRules(bad), bad);
  assert.throws(() => new LabelRules(Array.from({ length: 70 }, (_, i) => `/x${i}/{a}`)));
});

// ---- filters ----

const e = (kind: Matchable["kind"], p?: string, extra: Partial<Matchable> = {}): Matchable => ({ kind, dir: false, path: p, ...extra });

test("filter: prefix matches whole segments, a move matches by either place", () => {
  const f = new Filter({ prefix: ["/srv/a", "/srv/b/"] });
  assert.ok(f.match(e("create", "/srv/a")));
  assert.ok(f.match(e("create", "/srv/a/x/y")));
  assert.ok(f.match(e("create", "/srv/b/x")));
  assert.ok(!f.match(e("create", "/srv/ab/x")));
  assert.ok(!f.match(e("create", "/elsewhere")));
  assert.ok(f.match(e("move", "/elsewhere/new", { from: "/srv/a/old" })), "moved out of the prefix");
  assert.ok(f.match(e("move", "/srv/a/new", { from: "/elsewhere/old" })), "moved into it");
  assert.ok(new Filter({ prefix: ["/"] }).match(e("create", "/anything")));
});

test("filter: glob (base name at any depth, or a path with a slash), kind, type and label combine with AND", () => {
  assert.ok(new Filter({ glob: ["*.md"] }).match(e("create", "/a/b/readme.md")));
  assert.ok(!new Filter({ glob: ["*.md"] }).match(e("create", "/a/b/readme.txt")));
  assert.ok(new Filter({ glob: ["/srv/**/*.log"] }).match(e("modify", "/srv/x/y/app.log")));
  assert.ok(!new Filter({ glob: ["/srv/**/*.log"] }).match(e("modify", "/var/x/app.log")));
  assert.ok(new Filter({ glob: ["*.tmp", "*.md"] }).match(e("create", "/a/x.md")), "any glob");
  assert.ok(new Filter({ glob: ["*.md"] }).match(e("move", "/a/x.txt", { from: "/a/x.md" })), "the old name counts");
  const f = new Filter({ kind: ["create", "delete"], type: "file", glob: ["*.md"] });
  assert.ok(f.match(e("create", "/a/x.md")));
  assert.ok(!f.match(e("modify", "/a/x.md")));
  assert.ok(!f.match({ ...e("create", "/a/x.md"), dir: true }));
  const l = new Filter({ label: ["org:acme", "org:beta", "repo:app"] });
  assert.ok(l.match(e("create", "/x", { labels: { org: "beta", repo: "app" } })), "the same key twice means either value");
  assert.ok(!l.match(e("create", "/x", { labels: { org: "gamma", repo: "app" } })));
  assert.ok(!l.match(e("create", "/x", { labels: { org: "acme" } })), "every key must match");
  assert.ok(!l.match(e("create", "/x")), "no labels");
  assert.ok(new Filter({ label: ["u:a:b"] }).match(e("create", "/x", { labels: { u: "a:b" } })), "the value may hold a colon");
});

test("filter: control events always pass; an empty filter passes everything", () => {
  const f = new Filter({ prefix: ["/nowhere"], kind: ["create"], type: "dir" });
  for (const k of ["overflow", "reset", "ready"] as const) assert.ok(f.match(e(k)));
  assert.ok(new Filter().empty);
  assert.ok(new Filter().match(e("attrib", "/x")));
});

test("filter: bad input is a 400, limits hold, the query string round-trips", () => {
  const bad = (f: Record<string, unknown>) => assert.throws(() => new Filter(f as never), (x: { status?: number }) => x.status === 400, JSON.stringify(f));
  bad({ prefix: ["relative"] });
  bad({ kind: ["nope"] });
  bad({ type: "link" });
  bad({ label: ["nocolon"] });
  bad({ label: [":v"] });
  bad({ glob: [5] });
  bad({ prefix: Array.from({ length: 40 }, (_, i) => `/p${i}`) });
  bad({ prefix: ["/" + "x".repeat(5000)] });
  bad({ glob: Array.from({ length: 300 }, (_, i) => `a{b,c}${i}*`) }); // too many rules after brace expansion: the matcher refuses
  const f = new Filter({ prefix: ["/a"], glob: ["*.md"], kind: ["create", "move"], type: "file", label: ["org:acme"] });
  const g = filterFromParams(f.toParams());
  assert.deepEqual(g.spec, f.spec);
  assert.deepEqual(filterFromParams(new URLSearchParams("kind=create,delete&kind=modify")).spec.kind, ["create", "delete", "modify"]);
  assert.throws(() => filterFromParams(new URLSearchParams("type=file&type=dir")));
});

test("filter: a hostile glob is linear time (no regular expression from a user)", () => {
  const f = new Filter({ glob: ["*a*a*a*a*a*a*a*a*a*a*b"] });
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) f.match(e("create", "/" + "a".repeat(3000)));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

// ---- journal ----

const mk = (j: Journal, seqTime: (n: number) => number, n: number) => {
  for (let i = 0; i < n; i++) {
    const { seq, cursor } = j.next();
    j.write(seq, seqTime(seq), Buffer.from(JSON.stringify({ cursor, time: seqTime(seq), kind: "create", dir: false, path: `/f${seq}` }) + "\n"));
  }
};
const readAll = async (j: Journal, after: number, upTo: number) => {
  const out: number[] = [];
  for await (const chunk of j.read(after, upTo)) for (const l of chunk.toString("utf8").split("\n").filter(Boolean)) out.push((JSON.parse(l) as { time: number }).time);
  return out;
};

test("journal: lineSeq reads the sequence number from the start of a line", () => {
  assert.equal(lineSeq(Buffer.from('{"cursor":"a:b:12345","time":1}\n')), 12345);
  assert.equal(lineSeq(Buffer.from('{"cursor":"a:b:x"}\n')), -1);
  assert.equal(lineSeq(Buffer.from("garbage")), -1);
});

test("journal: lines survive a restart with the same epoch, and the sequence continues", async () => {
  const dir = tmp();
  const a = new Journal({ dir, node: "n1" });
  await a.open();
  mk(a, (n) => 1000 + n, 25);
  await a.close();
  const b = new Journal({ dir, node: "n1" });
  await b.open();
  assert.equal(b.epoch, a.epoch);
  assert.equal(b.head, 25);
  assert.ok(b.coveredUntil > 0, "the clean stop was noted");
  mk(b, (n) => 1000 + n, 5);
  assert.equal(b.head, 30);
  assert.deepEqual((await readAll(b, 20, 30)).length, 10);
  assert.deepEqual(await readAll(b, 27, 30), [1028, 1029, 1030]);
  await b.close();
});

test("journal: segments are closed when full and the oldest go by size and by age; a cursor older than what is left is a gap", async () => {
  const dir = tmp();
  let now = 100_000;
  const j = new Journal({ dir, node: "n1", maxBytes: 6000, segmentBytes: 1500, ringEvents: 2, flushMs: 5, maxAgeMs: 60_000, now: () => now });
  await j.open();
  for (let r = 0; r < 20; r++) {
    mk(j, (n) => now + n, 10);
    await j.flush();
  }
  const segs = fs.readdirSync(dir).filter((n) => n.startsWith("seg-"));
  assert.ok(segs.length > 1 && segs.length <= 6, `segments: ${segs.length}`);
  assert.ok(j.bytes <= 6000 + 1500 + 600, `bytes ${j.bytes}`);
  assert.ok(j.oldest > 1, "the oldest were trimmed");
  assert.equal(j.check(j.epoch, 1)?.why, "old");
  assert.equal(j.check(j.epoch, j.oldest - 1), null);
  assert.equal(j.check(j.epoch, j.head + 5)?.why, "future");
  assert.equal(j.check("other", 3)?.why, "epoch");
  const got = await readAll(j, j.oldest - 1, j.head);
  assert.equal(got.length, j.head - j.oldest + 1, "what is held reads without a hole");
  // age: everything but the newest segment is older than the limit
  now += 120_000;
  mk(j, (n) => now + n, 3);
  await j.flush();
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("seg-")).length, 1);
  await assert.rejects(readAll(j, 1, j.head), JournalGap);
  await j.close();
});

test("journal: a half-written last line is cut off; a lost or damaged journal starts a new epoch", async () => {
  const dir = tmp();
  const a = new Journal({ dir, node: "n1" });
  await a.open();
  mk(a, (n) => n, 5);
  await a.close();
  const seg = fs.readdirSync(dir).find((n) => n.startsWith("seg-"))!;
  fs.appendFileSync(path.join(dir, seg), '{"cursor":"n1:x:6","time"'); // a crash in the middle of a line
  const b = new Journal({ dir, node: "n1" });
  await b.open();
  assert.equal(b.epoch, a.epoch);
  assert.equal(b.head, 5);
  mk(b, (n) => n, 1);
  assert.deepEqual(await readAll(b, 4, 6), [5, 6]);
  await b.close();
  fs.rmSync(path.join(dir, seg)); // the segments are gone, the meta file is not
  const c = new Journal({ dir, node: "n1" });
  await c.open();
  assert.notEqual(c.epoch, a.epoch, "a journal without segments is a new journal");
  assert.equal(c.head, 0);
  await c.close();
  fs.writeFileSync(path.join(dir, "meta.json"), "{not json");
  const d = new Journal({ dir, node: "n1" });
  await d.open();
  assert.notEqual(d.epoch, c.epoch);
  await d.close();
});

test("journal: a directory that cannot be used leaves the events in memory, said once", async () => {
  const dir = tmp();
  const file = path.join(dir, "blocker");
  fs.writeFileSync(file, "x");
  const logs: string[] = [];
  const j = new Journal({ dir: path.join(file, "sub"), node: "n1", log: (s) => logs.push(s) });
  await j.open();
  assert.equal(j.persistent, false);
  mk(j, (n) => n, 3);
  assert.deepEqual(await readAll(j, 0, 3), [1, 2, 3]);
  assert.equal(logs.length, 1);
});

// ---- bus ----

test("bus: a subscriber gets what it asked for, the line is encoded once for all subscribers", async () => {
  const b = bus({ labels: new LabelRules("/srv/{org}") });
  const all = await b.subscribe(new Filter(), undefined, "internal");
  const md = await b.subscribe(new Filter({ glob: ["*.md"], kind: ["create"] }), undefined, "http");
  b.publish(ev("create", "/srv/acme/a.md"));
  b.publish(ev("modify", "/srv/acme/a.md"));
  b.publish(ev("create", "/srv/acme/b.txt", { dir: false }));
  const a = await take(all, 3);
  assert.deepEqual(a.map((x) => x.kind), ["create", "modify", "create"]);
  assert.deepEqual(a[0]!.labels, { org: "acme" });
  assert.equal(a[0]!.node, "n1");
  assert.match(a[0]!.cursor as string, /^n1:[0-9a-z]+:1$/);
  const m = await take(md, 1);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.path, "/srv/acme/a.md");
  // the very same buffer went to both
  b.publish(ev("create", "/srv/acme/c.md"));
  const [x] = (await all.next())!;
  const [y] = (await md.next())!;
  assert.equal(x, y);
  assert.deepEqual(b.subscribers(), { socket: 0, http: 1, internal: 1 });
});

test("bus: since=<cursor> gives the journal from there, then live events, with no gap and no repeat", async () => {
  const b = bus();
  for (let i = 1; i <= 5; i++) b.publish(ev("create", `/f${i}`));
  await b.whenServing();
  const since = b.cursorOf(2);
  const sub = await b.subscribe(new Filter(), since, "http");
  // events that come while the journal is read follow it
  b.publish(ev("create", "/f6"));
  b.publish(ev("create", "/f7"));
  const got = await take(sub, 5);
  assert.deepEqual(got.map((x) => x.path), ["/f3", "/f4", "/f5", "/f6", "/f7"]);
  b.publish(ev("delete", "/f8"));
  assert.equal((await take(sub, 1))[0]!.path, "/f8");
  // the filter applies to the replay as well
  const del = await b.subscribe(new Filter({ kind: ["delete"] }), b.cursorOf(0), "http");
  assert.deepEqual((await take(del, 1)).map((x) => x.path), ["/f8"]);
});

test("bus: replay from the files of a journal on disk, in order, then live", async () => {
  const dir = tmp();
  const b = bus({ journal: { dir, ringEvents: 3, flushMs: 5 } });
  for (let i = 1; i <= 40; i++) b.publish(ev("create", `/f${i}`));
  await b.whenServing();
  const sub = await b.subscribe(new Filter(), b.cursorOf(10), "http");
  b.publish(ev("create", "/f41"));
  const got = await take(sub, 31);
  assert.deepEqual(got.map((x) => x.path), Array.from({ length: 31 }, (_, i) => `/f${i + 11}`));
  assert.ok(b.replayed >= 30);
});

test("bus: a cursor of another epoch, or older than the journal, or from the future gets one reset first, then live events", async () => {
  const dir = tmp();
  const b = bus({ journal: { dir, maxBytes: 4000, segmentBytes: 1000, ringEvents: 2, flushMs: 5 } });
  for (let i = 1; i <= 80; i++) b.publish(ev("create", `/file-${i}`));
  await b.whenServing();
  await b.journal.flush();
  const epoch = b.journal.epoch;
  for (const since of [`n1:zzzz:3`, `n1:${epoch}:1`, `n1:${epoch}:99999`]) {
    const sub = await b.subscribe(new Filter({ kind: ["create"] }), since, "http");
    const [first] = await take(sub, 1);
    assert.equal(first!.kind, "reset", since);
    assert.equal(first!.scope, "node");
    assert.equal(first!.cursor, b.cursorOf(b.journal.head), "the reset's cursor is where to continue from");
    b.publish(ev("create", "/after"));
    const [next] = await take(sub, 1);
    assert.equal(next!.path, "/after");
    sub.close();
  }
  await assert.rejects(b.subscribe(new Filter(), "garbage", "http"), (x: { status?: number }) => x.status === 400);
  await assert.rejects(b.subscribe(new Filter(), "other:" + epoch + ":3", "http"), (x: { status?: number }) => x.status === 400, "a cursor of another node");
});

test("bus: a subscriber that does not read is ended with a lagged line and its last cursor, and never holds the others", async () => {
  const b = bus({ maxQueueBytes: 20_000 });
  const slow = await b.subscribe(new Filter(), undefined, "socket");
  const fast = await b.subscribe(new Filter(), undefined, "http");
  const seen: Record<string, unknown>[] = [];
  const reader = (async () => {
    for (;;) {
      const batch = await fast.next();
      if (!batch) return;
      for (const l of batch) seen.push(JSON.parse(l.toString("utf8")));
    }
  })();
  // the slow one takes the first batch, then stops reading
  b.publish(ev("create", "/first"));
  const first = await take(slow, 1);
  const t0 = Date.now();
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 100; i++) b.publish(ev("create", "/" + "x".repeat(50) + (round * 100 + i)));
    await sleep(5); // the fast one reads between the bursts
  }
  assert.ok(Date.now() - t0 < 2000, "publishing never waits for a subscriber");
  await until(() => seen.length >= 401);
  assert.equal(seen.length, 401, "the fast subscriber lost nothing");
  const rest = (await slow.next())!;
  const last = JSON.parse(rest.at(-1)!.toString("utf8")) as Record<string, unknown>;
  assert.equal(last.kind, "lagged");
  assert.equal(last.cursor, first[0]!.cursor, "it resumes from the last event it was given");
  assert.equal(await slow.next(), null, "and the stream ends");
  assert.equal(b.droppedLagged, 1);
  fast.close();
  await reader;
  // reconnecting with that cursor reads what was missed from the journal
  const again = await b.subscribe(new Filter(), last.cursor as string, "socket");
  const got = await take(again, 400);
  assert.equal(got.length, 400);
  assert.equal(got[0]!.path, "/" + "x".repeat(50) + 0);
});

test("bus: an idle subscriber gets a ping whose cursor lets a narrow filter move on", async () => {
  const b = bus({ pingMs: 30 });
  const sub = await b.subscribe(new Filter({ prefix: ["/watched"] }), undefined, "http");
  b.publish(ev("create", "/elsewhere/a"));
  b.publish(ev("create", "/elsewhere/b"));
  const [ping] = await take(sub, 1);
  assert.equal(ping!.kind, "ping");
  assert.equal(ping!.cursor, b.cursorOf(2));
});

test("bus: only the writer writes the journal; a process that is not yet the writer stages events and the subscriber waits", async () => {
  const dir = tmp();
  let writer = false;
  const b = bus({ journal: { dir, flushMs: 5 }, writer: () => writer, writerWaitMs: 5000 });
  b.publish(ev("ready", undefined as never, { scope: "node" }));
  b.publish(ev("create", "/a"));
  assert.equal(b.serving, false);
  assert.equal(fs.readdirSync(dir).length, 0, "nothing is written");
  const waiting = b.subscribe(new Filter(), undefined, "http");
  await sleep(50);
  writer = true;
  const sub = await waiting;
  assert.equal(b.serving, true);
  b.publish(ev("create", "/b"));
  const got = await take(sub, 1);
  assert.equal(got[0]!.path, "/b");
  // what was staged is in the journal
  const replay = await b.subscribe(new Filter(), b.cursorOf(0), "http");
  assert.deepEqual((await take(replay, 4)).map((x) => x.kind), ["ready", "create", "create"]);
});

test("bus: a subscriber waits at most the writer wait, then gets 503", async () => {
  const b = bus({ journal: { dir: tmp() }, writer: () => false, writerWaitMs: 60 });
  await assert.rejects(b.subscribe(new Filter(), undefined, "http"), (x: { status?: number }) => x.status === 503);
});

test("bus: losing the lease ends the subscribers; the journal is released and the next opener starts a new epoch", async () => {
  const dir = tmp();
  let writer = true;
  const b = bus({ journal: { dir, flushMs: 5 }, writer: () => writer });
  b.publish(ev("create", "/a"));
  const sub = await b.subscribe(new Filter(), undefined, "http");
  await take(sub, 1);
  const epoch = b.journal.epoch;
  writer = false;
  const end = await take(sub, 1);
  assert.equal(end[0]!.kind, "lagged");
  await until(() => !b.serving && b.journal.head === 0);
  assert.equal(b.journal.head, 0, "the journal let go of its state");
  await b.close();
  const b2 = bus({ journal: { dir, flushMs: 5 } });
  b2.publish({ kind: "ready", scope: "node" });
  assert.ok(await b2.whenServing());
  assert.notEqual(b2.journal.epoch, epoch, "a writer that lost its lease did not stop cleanly: the next one starts a new epoch");
});

test("bus: a gap between two writers that both stopped cleanly is a reset, in the same epoch", async () => {
  const dir = tmp();
  const b = bus({ journal: { dir, flushMs: 5 } });
  b.publish(ev("create", "/a"));
  await b.whenServing();
  await b.close();
  // a second process opens the same journal; the first stopped covering it long ago, and the second saw nothing before it started
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { covered: number; clean: boolean };
  assert.equal(meta.clean, true);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, covered: meta.covered - 60_000 }));
  const b2 = bus({ journal: { dir, flushMs: 5 } });
  b2.publish({ kind: "ready", scope: "node" });
  assert.ok(await b2.whenServing());
  assert.equal(b2.journal.epoch, b.journal.epoch, "the same journal goes on");
  const all = await b2.subscribe(new Filter({ kind: ["reset"] }), b2.cursorOf(0), "http");
  const reset = (await take(all, 1))[0]!;
  assert.equal(reset.kind, "reset");
  assert.match(String(reset.reason), /not seen/);
  assert.equal(typeof (reset.window as { from: number }).from, "number");
  assert.equal(typeof (reset.window as { to: number }).to, "number");
});

// ---- review fixes ----

test("journal: the ring replay does not skip events when new ones push old ones out while a chunk is being passed on", async () => {
  const j = new Journal({ dir: null, node: "n1", ringEvents: 12, ringBytes: 10 * 1024 * 1024 });
  await j.open();
  const big = (seq: number) => Buffer.from(`{"cursor":"n1:e:${seq}","pad":"${"x".repeat(100_000)}"}\n`);
  for (let i = 1; i <= 10; i++) j.write(j.next().seq, i, big(i));
  const got: number[] = [];
  for await (const chunk of j.read(0, 10)) {
    for (const l of chunk.toString("utf8").split("\n").filter(Boolean)) got.push(lineSeq(Buffer.from(l)));
    // while the reader holds a chunk, more events arrive and the ring drops its oldest
    for (let i = 0; i < 10; i++) j.write(j.next().seq, 100 + i, big(j.head + 1));
  }
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("journal: a journal that was not closed (a crash) is not continued in its epoch", async () => {
  const dir = tmp();
  const a = new Journal({ dir, node: "n1", flushMs: 5 });
  await a.open();
  mk(a, (n) => n, 5);
  await a.flush(); // on disk, but no close: no clean mark
  const b = new Journal({ dir, node: "n1" });
  await b.open();
  assert.notEqual(b.epoch, a.epoch, "a new epoch: readers hold cursors that the disk may not reach");
  assert.equal(b.head, 0);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("seg-")).length, 0, "the old epoch's segments are gone");
  await b.close();
  // a clean close is continued
  const c = new Journal({ dir, node: "n1" });
  await c.open();
  mk(c, (n) => n, 3);
  await c.close();
  const d = new Journal({ dir, node: "n1" });
  await d.open();
  assert.equal(d.epoch, c.epoch);
  assert.equal(d.head, 3);
  await d.close();
});

test("journal: a failed write starts a new epoch at the next open (the memory held events that the disk lacks)", async () => {
  const dir = tmp();
  const j = new Journal({ dir, node: "n1", flushMs: 5, segmentBytes: 1, log: () => {} });
  await j.open();
  mk(j, (n) => n, 2);
  await j.flush();
  const blocker = path.join(dir, "seg-000000000000003.jsonl");
  fs.mkdirSync(blocker); // the next segment cannot be made (also for root)
  mk(j, (n) => n, 2);
  await j.flush();
  assert.equal(j.persistent, false, "the journal went to memory only");
  assert.equal(j.head, 4, "readers were given events 3 and 4 from memory");
  const epoch = j.epoch;
  await j.close();
  fs.rmdirSync(blocker); // the fault is over, and the disk holds events 1 and 2 only
  const k = new Journal({ dir, node: "n1" });
  await k.open();
  assert.notEqual(k.epoch, epoch, "the disk is behind what readers were told: a new epoch");
  assert.equal(k.head, 0);
  await k.close();
});

test("bus: a demoted writer closes its files and forgets its state; when it is the writer again it reads the disk as the other writer left it", async () => {
  const dir = tmp();
  let writer = true;
  const b = bus({ journal: { dir, flushMs: 5 }, writer: () => writer });
  for (let i = 1; i <= 3; i++) b.publish(ev("create", `/a${i}`));
  await b.whenServing();
  await b.journal.flush(); // (what is still pending when the lease goes is dropped, so these three are written first)
  writer = false;
  b.publish(ev("create", "/during-demotion")); // a process that lost the lease writes nothing
  await until(() => b.journal.head === 0 && !b.serving);
  assert.equal(b.serving, false);
  const files = fs.readdirSync(dir).filter((n) => n.startsWith("seg-"));
  const lines = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("").split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "the three events before the loss are on disk and the fourth is not");
  // another process wrote the folder meanwhile: it stopped cleanly with a longer journal
  const other = new Journal({ dir, node: "n1", flushMs: 5 });
  await other.open();
  assert.notEqual(other.epoch, "");
  mk(other, (n) => 100 + n, 7);
  await other.close();
  writer = true;
  assert.ok(await b.whenServing());
  assert.equal(b.journal.epoch, other.epoch, "it continues the journal the other writer left");
  assert.equal(b.journal.head, 8, "its sequence comes from the disk (7), plus the one event that it staged meanwhile, not from what it held before");
  b.publish(ev("create", "/after"));
  const sub = await b.subscribe(new Filter(), b.cursorOf(6), "http");
  const got = await take(sub, 3);
  assert.deepEqual(got.map((x) => x.cursor), [b.cursorOf(7), b.cursorOf(8), b.cursorOf(9)]);
  assert.equal(got[1]!.path, "/during-demotion");
});

test("bus: the lease is checked at each event: a process that lost it does not write the next event, even before the timer notices", async () => {
  const dir = tmp();
  let writer = true;
  const b = bus({ journal: { dir, flushMs: 5 }, writer: () => writer });
  b.publish(ev("create", "/a"));
  await b.whenServing();
  await b.journal.flush();
  const sub = await b.subscribe(new Filter(), undefined, "http");
  writer = false;
  b.publish(ev("create", "/b")); // at once, with no wait for the 200 ms check
  const end = await take(sub, 1);
  assert.equal(end[0]!.kind, "lagged", "the subscriber was not given /b");
  await until(() => b.journal.head === 0);
  const text = fs.readdirSync(dir).filter((n) => n.startsWith("seg-")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  assert.ok(!text.includes("/b"), "nothing was written after the lease was lost");
});

test("bus: with no usable size store (no lease) the journal stays in memory, so two processes never write one folder", async () => {
  const dir = tmp();
  const a = bus({ journal: { dir, flushMs: 5 }, writer: () => true, disk: () => false });
  const c = bus({ journal: { dir, flushMs: 5 }, writer: () => true, disk: () => false });
  a.publish(ev("create", "/a"));
  c.publish(ev("create", "/c"));
  assert.ok(await a.whenServing());
  assert.ok(await c.whenServing());
  await a.journal.flush();
  await c.journal.flush();
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was written");
  assert.equal(a.journal.persistent, false);
});

test("bus: listeners hear every event also in a process that is not the writer", async () => {
  const b = bus({ journal: { dir: tmp() }, writer: () => false, writerWaitMs: 20 });
  const heard: string[] = [];
  b.listen((x) => heard.push(`${x.kind}:${x.path}`));
  b.publish(ev("create", "/a"));
  b.publish(ev("delete", "/b"));
  assert.equal(b.serving, false);
  assert.deepEqual(heard, ["create:/a", "delete:/b"]);
});

test("bus: a move carries the labels of the place it came from, and a label filter matches by either place", async () => {
  const b = bus({ labels: new LabelRules("/srv/{org}") });
  const sub = await b.subscribe(new Filter({ label: ["org:acme"] }), undefined, "http");
  b.publish(ev("move", "/elsewhere/new", { from: "/srv/acme/old" })); // out of a labelled place
  b.publish(ev("move", "/srv/acme/new", { from: "/elsewhere/old" })); // into one
  b.publish(ev("move", "/srv/beta/new", { from: "/srv/beta/old" })); // not acme
  b.publish(ev("create", "/elsewhere/x"));
  const got = await take(sub, 2);
  assert.deepEqual(got.map((x) => x.path), ["/elsewhere/new", "/srv/acme/new"]);
  assert.deepEqual(got[0]!.fromLabels, { org: "acme" });
  assert.equal(got[1]!.fromLabels, undefined);
});

test("bus: the watcher's events reach the journal as overflow and reset with their window; listeners see every event first", async () => {
  const b = bus();
  const heard: string[] = [];
  b.listen((x) => heard.push(x.kind));
  b.publish({ kind: "overflow", scope: "node", window: { from: 5, to: 9 } });
  b.publish({ kind: "reset", scope: "filesystem", path: "/mnt/x", reason: "no event covers this filesystem" });
  await b.whenServing();
  const sub = await b.subscribe(new Filter({ kind: ["create"] }), b.cursorOf(0), "http");
  const got = await take(sub, 2);
  assert.deepEqual(got.map((x) => x.kind), ["overflow", "reset"], "control events pass every filter");
  assert.deepEqual(got[0]!.window, { from: 5, to: 9 });
  assert.equal(got[1]!.path, "/mnt/x");
  assert.deepEqual(heard, ["overflow", "reset"]);
  assert.equal(b.overflows, 1);
});

test("journal: close() twice writes meta.json once; a close after the lease went to a new process leaves its folder alone", async () => {
  const dir = tmp();
  const a = new Journal({ dir, node: "n1", flushMs: 5 });
  await a.open();
  mk(a, (n) => n, 3);
  await a.close();
  const meta = path.join(dir, "meta.json");
  const mine = fs.readFileSync(meta, "utf8");
  // the next process took the lease and wrote its own meta
  fs.writeFileSync(meta, JSON.stringify({ epoch: "newer", node: "n1", clean: false, covered: 1 }));
  await a.close(); // (the second close of the bus, from the app's own close after leave())
  assert.equal(JSON.parse(fs.readFileSync(meta, "utf8")).epoch, "newer", `the second close did not rewrite meta.json (it held ${mine})`);
  // the bus too: closing it twice is one close
  const d2 = tmp();
  const b = bus({ journal: { dir: d2, flushMs: 5 } });
  b.publish(ev("create", "/a"));
  await b.whenServing();
  await b.close();
  fs.writeFileSync(path.join(d2, "meta.json"), JSON.stringify({ epoch: "newer", node: "n1", clean: false, covered: 1 }));
  await b.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2, "meta.json"), "utf8")).epoch, "newer");
});

test("journal: the temporary name of a meta write holds random bytes (two containers that are both process 1 do not share it)", async () => {
  const dir = tmp();
  const names = new Set<string>();
  const real = fs.promises.writeFile;
  const spy = async (f: unknown, ...rest: unknown[]) => {
    if (String(f).startsWith(path.join(dir, "meta.json."))) names.add(path.basename(String(f)));
    return (real as (...a: unknown[]) => Promise<void>)(f, ...rest);
  };
  (fs.promises as { writeFile: unknown }).writeFile = spy;
  try {
    const a = new Journal({ dir, node: "n1" });
    await a.open();
    await a.close();
    const b = new Journal({ dir, node: "n1" });
    await b.open();
    await b.close();
  } finally {
    (fs.promises as { writeFile: unknown }).writeFile = real;
  }
  assert.ok(names.size >= 4, `four writes, four names: ${[...names].join(",")}`);
  for (const n of names) assert.match(n, new RegExp(`^meta\\.json\\.${process.pid}\\.[0-9a-f]{12}$`));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("meta.json.")), [], "no temporary file is left");
});

test("journal: release() after the lease was lost drops the pending lines and the queued meta writes, and makes no new segment", async () => {
  const dir = tmp();
  let t = 1_000_000;
  const j = new Journal({ dir, node: "n1", flushMs: 5, now: () => t });
  await j.open();
  mk(j, (n) => n, 2);
  await j.flush();
  const files = () => fs.readdirSync(dir).sort().join(",");
  const before = files();
  const meta = fs.readFileSync(path.join(dir, "meta.json"), "utf8");
  const seg = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith("seg-"))!), "utf8");
  t += 60_000;
  mk(j, (n) => 2 + n, 3); // pending, not yet written
  j.cover(); // a meta write is queued
  await j.release();
  await sleep(50);
  assert.equal(files(), before, "no file was made or changed in the folder");
  assert.equal(fs.readFileSync(path.join(dir, "meta.json"), "utf8"), meta, "the queued meta write did not run");
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith("seg-"))!), "utf8"), seg, "the pending lines were not appended");
  // a segment of its own would be made at the next flush when the old one is full: none is
  const k = new Journal({ dir, node: "n1", flushMs: 5, segmentBytes: 1, now: () => t });
  await k.open();
  mk(k, (n) => n, 1);
  k.cover();
  await k.release();
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("seg-")).length, 0, "no new segment after the release (the unclean open also removed the old one)");
});

test("journal: an open that finds a journal its last writer did not close cleanly is counted", async () => {
  const dir = tmp();
  const a = new Journal({ dir, node: "n1", flushMs: 5 });
  await a.open();
  assert.equal(a.uncleanOpens, 0, "a new folder is not an unclean open");
  mk(a, (n) => n, 2);
  await a.flush(); // no close: a crash
  const b = new Journal({ dir, node: "n1" });
  await b.open();
  assert.equal(b.uncleanOpens, 1);
  await b.close();
  const c = new Journal({ dir, node: "n1" });
  await c.open();
  assert.equal(c.uncleanOpens, 0, "after a clean close it is not");
  await c.close();
  const { eventMetrics } = await import("../src/events/metrics.ts");
  const text = eventMetrics(bus({ journal: { dir: null } })).join("\n");
  assert.match(text, /^filedeck_events_journal_unclean_opens_total 0$/m);
});

test("leave: the slow steps have a limit, then the journal is closed anyway; a failing step does not stop the close", async () => {
  const { leaveBounded } = await import("../src/events/leave.ts");
  const order: string[] = [];
  const logs: string[] = [];
  const t0 = Date.now();
  await leaveBounded(() => new Promise<void>(() => {}), async () => void order.push("closed"), 100, (s) => logs.push(s));
  assert.deepEqual(order, ["closed"]);
  assert.ok(Date.now() - t0 < 2000, "it did not wait for the stuck step");
  assert.match(logs.join(), /journal is closed now/);
  order.length = 0;
  await leaveBounded(async () => void order.push("steps"), async () => void order.push("closed"), 5000);
  assert.deepEqual(order, ["steps", "closed"], "fast steps run first");
  order.length = 0;
  await leaveBounded(async () => { throw new Error("boom"); }, async () => void order.push("closed"), 5000, (s) => logs.push(s));
  assert.deepEqual(order, ["closed"]);
  assert.match(logs.join(), /boom/);
});

test("journal: a meta write that is running when release() starts does not replace meta.json, and a flush that is running does not append", async () => {
  // (1) a meta write that has written its temporary file and waits when the release starts
  const dir = tmp();
  let t = 1_000_000;
  const j = new Journal({ dir, node: "n1", flushMs: 5, now: () => t });
  await j.open();
  mk(j, (n) => n, 2);
  await j.flush();
  const metaFile = path.join(dir, "meta.json");
  const meta = fs.readFileSync(metaFile, "utf8");
  const realWrite = fs.promises.writeFile;
  let entered!: () => void;
  const inWrite = new Promise<void>((res) => (entered = res));
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  (fs.promises as { writeFile: unknown }).writeFile = async (f: unknown, ...rest: unknown[]) => {
    const r = await (realWrite as (...a: unknown[]) => Promise<void>)(f, ...rest);
    if (String(f).startsWith(path.join(dir, "meta.json."))) {
      entered();
      await gate;
    }
    return r;
  };
  try {
    t += 60_000;
    j.cover(); // the meta write starts, with the epoch of this journal
    await inWrite;
    const released = j.release(); // the lease is lost while the write waits
    await sleep(10);
    open();
    await released;
  } finally {
    (fs.promises as { writeFile: unknown }).writeFile = realWrite;
  }
  assert.equal(fs.readFileSync(metaFile, "utf8"), meta, "meta.json was not replaced after the release started");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("meta.json.")), [], "and its temporary file is gone");

  // (2) a flush that has opened the segment and waits when the release starts
  const dir2 = tmp();
  const k = new Journal({ dir: dir2, node: "n1", flushMs: 5000, now: () => t });
  await k.open();
  mk(k, (n) => n, 2);
  await k.close(); // (a clean mark, so the next journal continues the epoch and the segment)
  const segFile = path.join(dir2, fs.readdirSync(dir2).find((n) => n.startsWith("seg-"))!);
  // a second journal object continues that segment: its first flush opens the file again
  const k3 = new Journal({ dir: dir2, node: "n1", flushMs: 5000, now: () => t });
  await k3.open();
  const before = fs.readFileSync(segFile, "utf8");
  const realOpen = fs.promises.open;
  let entered2!: () => void;
  const inOpen = new Promise<void>((res) => (entered2 = res));
  let open2!: () => void;
  const gate2 = new Promise<void>((res) => (open2 = res));
  (fs.promises as { open: unknown }).open = async (f: unknown, ...rest: unknown[]) => {
    const r = await (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(f, ...rest);
    if (String(f) === segFile) {
      entered2();
      await gate2;
    }
    return r;
  };
  try {
    mk(k3, (n) => 10 + n, 2);
    const flushing = k3.flush();
    await inOpen;
    const released = k3.release();
    await sleep(10);
    open2();
    await released;
    await flushing;
  } finally {
    (fs.promises as { open: unknown }).open = realOpen;
  }
  assert.equal(fs.readFileSync(segFile, "utf8"), before, "no line was appended after the release started");
});

test("leave: a step that runs on after the bound publishes into a closed bus: its event is not written and nobody hears it", async () => {
  const { leaveBounded } = await import("../src/events/leave.ts");
  const dir = tmp();
  const b = bus({ journal: { dir, flushMs: 5 } });
  await b.whenServing();
  b.publish(ev("create", "/early"));
  const heard: string[] = [];
  b.listen((e) => void heard.push(e.path as string));
  let late!: () => void;
  const lateStep = new Promise<void>((res) => (late = res));
  // (1) the step publishes in the turn right after the bound fires: the close has started in the turn of the bound itself
  // (2) it also publishes long after, when the leave has ended
  let after!: Promise<void>;
  const keep = setInterval(() => {}, 1000); // (the bound's own timer does not keep the process alive)
  await leaveBounded(
    async () => {
      after = lateStep.then(() => b.publish(ev("create", "/after")));
      await lateStep;
    },
    () => b.close(),
    50,
    () => void Promise.resolve().then(() => b.publish(ev("create", "/at-the-bound"))),
  );
  late();
  await after;
  clearInterval(keep);
  await sleep(100);
  const lines = fs.readdirSync(dir).filter((n) => n.startsWith("seg-")).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("");
  assert.match(lines, /\/early/);
  assert.doesNotMatch(lines, /\/at-the-bound/);
  assert.doesNotMatch(lines, /\/after/);
  assert.deepEqual(heard, [], "a listener heard neither late event");
});

test("bus: a new subscriber is told the watcher's state first; stopped, it is told nothing", async () => {
  const b = bus();
  await b.whenServing();
  const none = await b.subscribe(new Filter(), undefined, "http");
  b.ready = true;
  b.setUnwatched(["/net"]);
  const sub = await b.subscribe(new Filter(), undefined, "http");
  const first = (await take(sub, 1))[0]!;
  assert.equal(first.kind, "ready");
  assert.equal(first.scope, "node");
  assert.deepEqual(first.unwatched, ["/net"]);
  assert.equal(first.node, "n1");
  b.ready = false;
  const stopped = await b.subscribe(new Filter(), undefined, "http");
  b.publish(ev("create", "/x"));
  assert.equal((await take(stopped, 1))[0]!.path, "/x", "no ready line while the watcher is not ready");
  assert.equal((await take(none, 1))[0]!.path, "/x", "a subscriber that came before the watcher is not told again");
  b.ready = true; // ready again, without unwatched
  const again = await b.subscribe(new Filter({ kind: ["create"] }), undefined, "http");
  assert.equal((await take(again, 1))[0]!.kind, "ready", "a control line passes any filter");
});

test("bus: when the journal is lost while a new reader replays it, `reset` comes before `ready`", async () => {
  const b = bus();
  await b.whenServing();
  b.ready = true;
  for (let i = 1; i <= 3; i++) b.publish(ev("create", `/f${i}`));
  // the replay fails as a journal does when its files are gone under the reader
  (b.journal as unknown as { read: () => AsyncGenerator<Buffer> }).read = async function* () {
    throw new JournalGap("lost");
  };
  const sub = await b.subscribe(new Filter(), b.cursorOf(0), "http");
  const got = await take(sub, 2);
  assert.deepEqual(got.map((x) => x.kind), ["reset", "ready"]);
  assert.match(String(got[0]!.reason), /lost/);
});
