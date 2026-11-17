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
