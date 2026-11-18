import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthDb } from "../src/auth/store.ts";
import { SourceGrants } from "../src/auth/source-grants.ts";

test("set, get and replace the grants of one account", () => {
  const g = new SourceGrants(new AuthDb(":memory:"));
  g.setForAccount("virt", "a", { s1: { write: false }, s2: { write: true } });
  assert.deepEqual(g.get("s2", "virt", "a"), { write: true });
  assert.deepEqual(g.get("s1", "virt", "a"), { write: false });
  assert.equal(g.get("s1", "sys", "a"), undefined, "a system user of the same name has no grant");
  assert.equal(g.get("s3", "virt", "a"), undefined);
  assert.deepEqual(g.forAccount("virt", "a"), { s1: { write: false }, s2: { write: true } });
  g.setForAccount("virt", "a", { s2: { write: false } });
  assert.deepEqual(g.forAccount("virt", "a"), { s2: { write: false } }, "set replaces every row of the account");
  g.setForAccount("virt", "a", {});
  assert.equal(g.get("s1", "virt", "a"), undefined);
  assert.equal(g.get("s2", "virt", "a"), undefined);
  assert.deepEqual(g.forAccount("virt", "a"), {});
});

test("accounts lists only names with a row, per kind", () => {
  const g = new SourceGrants(new AuthDb(":memory:"));
  g.setForAccount("sys", "bob", { s1: { write: true } });
  g.setForAccount("sys", "alice", { s1: { write: false }, s2: { write: true } });
  g.setForAccount("sys", "carol", {});
  g.setForAccount("virt", "guest", { s1: { write: true } });
  assert.deepEqual(g.accounts("sys"), ["alice", "bob"]);
  assert.deepEqual(g.accounts("virt"), ["guest"]);
});

test("removeAccount touches only that account", () => {
  const g = new SourceGrants(new AuthDb(":memory:"));
  g.setForAccount("virt", "a", { s1: { write: true } });
  g.setForAccount("sys", "a", { s1: { write: false } });
  g.setForAccount("virt", "b", { s1: { write: true } });
  g.removeAccount("virt", "a");
  assert.deepEqual(g.forAccount("virt", "a"), {});
  assert.deepEqual(g.forAccount("sys", "a"), { s1: { write: false } });
  assert.deepEqual(g.forAccount("virt", "b"), { s1: { write: true } });
});

test("a failed set changes nothing", () => {
  const g = new SourceGrants(new AuthDb(":memory:"));
  g.setForAccount("virt", "a", { s1: { write: true } });
  assert.throws(() => g.setForAccount("virt", "a", { s2: { write: true }, s3: null as unknown as { write: boolean } }));
  assert.deepEqual(g.forAccount("virt", "a"), { s1: { write: true } });
});

test("two stores on one database see the same grants", () => {
  const db = new AuthDb(":memory:");
  new SourceGrants(db).setForAccount("virt", "a", { s1: { write: true } });
  assert.deepEqual(new SourceGrants(db).get("s1", "virt", "a"), { write: true });
});
