import assert from "node:assert/strict";
import test from "node:test";
import { ZipTickets } from "../src/zip-tickets.ts";

test("tickets are unguessable, work once and expire", () => {
  let t = 1000;
  const z = new ZipTickets(60_000, 3, () => t);
  const a = z.issue({ dir: "/d", names: ["x"] })!;
  const b = z.issue({ dir: "/d", names: ["x"] })!;
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
  assert.deepEqual(z.peek(a), { dir: "/d", names: ["x"] });
  assert.deepEqual(z.take(a), { dir: "/d", names: ["x"] });
  assert.equal(z.take(a), null, "second use");
  t += 60_001;
  assert.equal(z.take(b), null, "expired");
  assert.equal(z.take("nope"), null);
});

test("the number of outstanding tickets is bounded, and expired ones make room", () => {
  let t = 0;
  const z = new ZipTickets(1000, 2, () => t);
  assert.ok(z.issue({ dir: "/", names: ["a"] }));
  assert.ok(z.issue({ dir: "/", names: ["a"] }));
  assert.equal(z.issue({ dir: "/", names: ["a"] }), null);
  t = 2000;
  assert.ok(z.issue({ dir: "/", names: ["a"] }));
});
