import assert from "node:assert/strict";
import test from "node:test";
import { formChanged, formProblems, fromView, notConfigured, toInput, type AccountForm } from "../src/accountForm.ts";
import type { AccountView } from "../src/admin.ts";

const good = (): AccountForm => ({
  name: "guest",
  password: "",
  admin: false,
  machines: [
    { node: "alpha", runAs: "share", grants: [{ path: "/srv/share", write: true }, { path: "/", write: false }] },
    { node: "beta", runAs: "", grants: [] },
  ],
  sources: { s3: "read", web: "none", box: "write" },
});

test("toInput drops an empty password, a machine with no run-as user and no folders, and sources set to none", () => {
  assert.deepEqual(toInput(good()), {
    name: "guest",
    admin: false,
    nodes: { alpha: { runAs: "share", grants: [{ path: "/srv/share", write: true }, { path: "/", write: false }] } },
    sources: { s3: { write: false }, box: { write: true } },
  });
});

test("toInput trims the name, the run-as user and the folder paths, and keeps a typed password as it is", () => {
  const f = good();
  f.name = "  guest ";
  f.password = " a password with spaces ";
  f.machines[0]!.runAs = " share ";
  f.machines[0]!.grants[0]!.path = " /srv/share ";
  const input = toInput(f);
  assert.equal(input.name, "guest");
  assert.equal(input.password, " a password with spaces ");
  assert.equal(input.nodes.alpha!.runAs, "share");
  assert.equal(input.nodes.alpha!.grants[0]!.path, "/srv/share");
});

test("fromView then toInput keeps the machines and sources", () => {
  const v: AccountView = {
    name: "guest",
    admin: true,
    hasPassword: true,
    keys: [{ fingerprint: "SHA256:abc", type: "ssh-ed25519", comment: "laptop" }],
    nodes: { alpha: { runAs: "share", grants: [{ path: "/srv/b", write: false }, { path: "/srv/a", write: true }] } },
    sources: { s3: { write: false }, box: { write: true } },
    sessions: 2,
  };
  const f = fromView(v);
  assert.equal(f.password, "", "a stored password is never put in the form");
  assert.equal(f.name, "guest");
  assert.equal(f.admin, true);
  assert.deepEqual(f.sources, { s3: "read", box: "write" });
  const back = toInput(f);
  assert.deepEqual(back.nodes, v.nodes, "the folders keep their order");
  assert.deepEqual(back.sources, v.sources);
  assert.equal(back.admin, true);
  assert.equal("password" in back, false);
});

test("formProblems names a bad name, a short password, a machine with folders and no run-as user, and a relative folder", () => {
  const long = good();
  long.name = "a".repeat(33);
  assert.equal(formProblems(long).length, 1);
  assert.match(formProblems(long)[0]!, /name/i);
  for (const bad of ["Alice", "9lives", "root", "a b", ""]) {
    const f = good();
    f.name = bad;
    assert.equal(formProblems(f).length, 1, bad);
    assert.match(formProblems(f)[0]!, /name/i, bad);
  }

  const short = good();
  short.password = "a".repeat(11);
  assert.equal(formProblems(short).length, 1);
  assert.match(formProblems(short)[0]!, /password/i);
  assert.ok(!formProblems(short)[0]!.includes("aaaaaaaaaaa"), "the message does not repeat the password");
  // counted in characters, not UTF-16 units: 11 emoji are 22 units and still too short
  short.password = "\u{1F600}".repeat(11);
  assert.equal(formProblems(short).length, 1);

  const noRunAs = good();
  noRunAs.machines[0]!.runAs = " ";
  assert.equal(formProblems(noRunAs).length, 1);
  assert.match(formProblems(noRunAs)[0]!, /alpha/);
  assert.match(formProblems(noRunAs)[0]!, /run-as/i);

  const relative = good();
  relative.machines[0]!.grants[0]!.path = "srv/x";
  assert.equal(formProblems(relative).length, 1);
  assert.match(formProblems(relative)[0]!, /srv\/x/);
});

test("a source or machine that is no longer configured is named, and toInput leaves it out so the account can still be saved", () => {
  const v: AccountView = {
    name: "guest",
    admin: false,
    hasPassword: true,
    keys: [],
    nodes: { alpha: { runAs: "share", grants: [{ path: "/srv", write: false }] }, gone: { runAs: "share", grants: [{ path: "/old", write: true }] } },
    sources: { s3: { write: false }, retired: { write: true } },
    sessions: 0,
  };
  const known = { nodes: ["alpha", "beta"], sources: ["s3"] };
  const f = fromView(v);
  assert.deepEqual(notConfigured(f, known), { machines: ["gone"], sources: ["retired"] });
  const input = toInput(f, known);
  assert.deepEqual(Object.keys(input.nodes), ["alpha"]);
  assert.deepEqual(input.sources, { s3: { write: false } });
  // without the configured lists nothing is left out
  assert.deepEqual(Object.keys(toInput(f).nodes).sort(), ["alpha", "gone"]);
  assert.deepEqual(notConfigured(good(), { nodes: ["alpha", "beta"], sources: ["s3", "web", "box"] }), { machines: [], sources: [] });
});

test("formChanged: a typed password or any field that differs from the start counts; the same form does not", () => {
  const start = good();
  assert.equal(formChanged(start, good()), false);
  assert.equal(formChanged(start, { ...good(), password: "x" }), true);
  assert.equal(formChanged(start, { ...good(), admin: true }), true);
  const g = good();
  g.machines[0]!.grants[1]!.write = true;
  assert.equal(formChanged(start, g), true);
  assert.equal(formChanged(start, { ...good(), sources: { ...good().sources, web: "read" } }), true);
});

test("formProblems gives nothing for a good form", () => {
  assert.deepEqual(formProblems(good()), []);
  const f = good();
  f.password = "a".repeat(12);
  f.name = "a".repeat(32);
  assert.deepEqual(formProblems(f), []);
});
