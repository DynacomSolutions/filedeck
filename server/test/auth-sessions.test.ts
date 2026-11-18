import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthDb, Accounts } from "../src/auth/store.ts";
import { Sessions } from "../src/auth/sessions.ts";

const H = 3600_000;

function setup(idleMs = 8 * H, maxMs = 7 * 24 * H) {
  const db = new AuthDb(":memory:");
  const acc = new Accounts(db);
  acc.create({ name: "guest", password: "p", admin: false, nodes: {} });
  let t = 1_000_000;
  const s = new Sessions(db, acc, { idleMs, maxMs, now: () => t });
  return { db, acc, s, at: (n: number) => (t = n), now: () => t };
}

test("lookup after create", () => {
  const { s } = setup();
  const raw = s.create("virt", "guest");
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(s.lookup(raw), { kind: "virt", name: "guest" });
  assert.equal(s.lookup("nonsense"), undefined);
});

test("idle expiry and sliding", () => {
  const { s, at, now } = setup();
  const t0 = now();
  const a = s.create("sys", "alice");
  const b = s.create("sys", "bob");
  at(t0 + 8 * H + 1);
  assert.equal(s.lookup(a), undefined);
  at(t0 + 8 * H - 1);
  assert.ok(s.lookup(b));
  at(t0 + 16 * H - 2);
  assert.ok(s.lookup(b), "the earlier lookup slid the window");
  at(t0 + 24 * H);
  assert.equal(s.lookup(b), undefined);
});

test("absolute expiry despite sliding", () => {
  const { s, at, now } = setup();
  const t0 = now();
  const raw = s.create("sys", "alice");
  for (let h = 1; h < 7 * 24; h++) {
    at(t0 + h * H);
    assert.ok(s.lookup(raw), `hour ${h}`);
  }
  at(t0 + 7 * 24 * H + 1);
  assert.equal(s.lookup(raw), undefined);
});

test("endAll cancels earlier sessions only", () => {
  const { s, at, now } = setup();
  const old = s.create("virt", "guest");
  const other = s.create("sys", "alice");
  s.endAll("virt", "guest");
  at(now() + 1);
  assert.equal(s.lookup(old), undefined);
  const fresh = s.create("virt", "guest");
  assert.ok(s.lookup(fresh));
  assert.ok(s.lookup(other));
});

test("epoch bump elsewhere also cancels", () => {
  const { s, acc } = setup();
  const raw = s.create("virt", "guest");
  acc.bumpEpoch("virt", "guest");
  assert.equal(s.lookup(raw), undefined);
});

test("session of a removed virtual account is invalid and deleted", () => {
  const { s, db } = setup();
  const raw = s.create("virt", "ghost");
  assert.equal(s.lookup(raw), undefined);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 0);
});

test("endAll of an unknown virtual account does not throw", () => {
  const { s } = setup();
  assert.doesNotThrow(() => s.endAll("virt", "ghost"));
});

test("destroy", () => {
  const { s } = setup();
  const raw = s.create("sys", "alice");
  s.destroy(raw);
  assert.equal(s.lookup(raw), undefined);
});

test("last_used is written at most once a minute", () => {
  const { s, db, at, now } = setup();
  const t0 = now();
  const raw = s.create("sys", "alice");
  const lu = () => (db.db.prepare("SELECT last_used FROM sessions").get() as { last_used: number }).last_used;
  at(t0 + 30_000);
  s.lookup(raw);
  assert.equal(lu(), t0);
  at(t0 + 61_000);
  s.lookup(raw);
  assert.equal(lu(), t0 + 61_000);
});

test("stored hash only", () => {
  const { s, db } = setup();
  const raw = s.create("sys", "alice");
  const rows = db.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  for (const v of Object.values(rows[0]!)) assert.notEqual(v, raw);
  assert.match(String(rows[0]!.id), /^[0-9a-f]{64}$/);
});

test("list shows valid sessions with a public id and the address", () => {
  const { s, at, now } = setup();
  const t0 = now();
  const raw = s.create("virt", "guest", "192.0.2.7");
  at(t0 + 61_000);
  const other = s.create("sys", "alice");
  s.lookup(other);
  const l = s.list();
  assert.equal(l.length, 2);
  assert.equal(l[0]?.name, "alice", "newest lastUsed first");
  const g = l[1]!;
  assert.match(g.id, /^[0-9a-f]{32}$/);
  assert.equal(g.id, s.publicId(s.keyOf(raw)));
  assert.notEqual(g.id, s.keyOf(raw));
  assert.ok(!s.keyOf(raw).startsWith(g.id), "the id is not a prefix of the key");
  assert.deepEqual(g, { id: g.id, kind: "virt", name: "guest", created: t0, lastUsed: t0, address: "192.0.2.7" });
  assert.equal(l[0]?.address, undefined);
  assert.equal(s.count("virt", "guest"), 1);
  assert.equal(s.count("sys", "alice"), 1);
  assert.equal(s.count("sys", "guest"), 0);
});

test("list leaves out expired sessions and those of a raised epoch, and writes nothing", () => {
  const { s, acc, db, at, now } = setup();
  const t0 = now();
  s.create("sys", "alice", "192.0.2.1");
  at(t0 + 8 * H);
  const fresh = s.create("sys", "bob", "192.0.2.2");
  s.create("virt", "guest", "192.0.2.3");
  acc.bumpEpoch("virt", "guest");
  at(t0 + 8 * H + 1);
  assert.deepEqual(
    s.list().map((x) => x.name),
    ["bob"],
  );
  assert.equal(s.count("sys", "alice"), 0);
  assert.equal(s.count("virt", "guest"), 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 3, "list is read only");
  assert.ok(s.lookup(fresh));
});

test("list shows the act-as-root end only while it is in the future", () => {
  const { s, at, now } = setup();
  const t0 = now();
  const raw = s.create("sys", "alice");
  s.setAsRoot(raw, t0 + 5_000);
  assert.equal(s.list()[0]?.asRootUntil, t0 + 5_000);
  at(t0 + 5_000);
  assert.equal("asRootUntil" in s.list()[0]!, false);
});

test("endById removes one session and onEnd hears its key", () => {
  const { s } = setup();
  const heard: unknown[] = [];
  s.onEnd((e) => heard.push(e));
  const raw = s.create("virt", "guest", "192.0.2.7");
  const keep = s.create("virt", "guest");
  const id = s.publicId(s.keyOf(raw));
  assert.equal(s.endById(id), true);
  assert.deepEqual(heard, [{ key: s.keyOf(raw) }]);
  assert.equal(s.lookup(raw), undefined);
  assert.ok(s.lookup(keep), "the other session of the account stays");
  assert.equal(s.endById(id), false);
  assert.equal(s.endById("nope"), false);
  assert.equal(heard.length, 1);
});

test("the address column is added to an older table", () => {
  const db = new AuthDb(":memory:");
  db.db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, epoch INTEGER NOT NULL)");
  const acc = new Accounts(db);
  const s = new Sessions(db, acc, { idleMs: H, maxMs: 2 * H });
  s.create("sys", "alice", "198.51.100.1");
  assert.equal(s.list()[0]?.address, "198.51.100.1");
});
