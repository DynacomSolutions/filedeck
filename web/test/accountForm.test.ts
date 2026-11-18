import assert from "node:assert/strict";
import test from "node:test";
import { cleanLink, linksKey, anyLinkCounts, linkCounts, formChanged, formProblems, fromView, linkKind, notConfigured, toInput, type AccountForm } from "../src/accountForm.ts";
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
  tailnet: [],
});

test("toInput drops an empty password, a machine with no run-as user and no folders, and sources set to none", () => {
  assert.deepEqual(toInput(good()), {
    name: "guest",
    admin: false,
    nodes: { alpha: { runAs: "share", grants: [{ path: "/srv/share", write: true }, { path: "/", write: false }] } },
    sources: { s3: { write: false }, box: { write: true } },
    tailnet: [],
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
    tailnet: [],
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
    tailnet: [],
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

test("toInput lowercases and trims links, drops empty ones and merges duplicates", () => {
  const f = good();
  f.tailnet = ["  Alice@GitHub ", "", "   ", "TAG:CI", "alice@github"];
  assert.deepEqual(toInput(f).tailnet, ["alice@github", "tag:ci"]);
});

test("fromView then toInput keeps the links, in order", () => {
  const v: AccountView = {
    name: "guest",
    admin: false,
    hasPassword: false,
    keys: [],
    nodes: {},
    sources: {},
    sessions: 0,
    tailnet: [{ subject: "alice@github", kind: "login" }, { subject: "tag:ci", kind: "tag" }],
  };
  const f = fromView(v);
  assert.deepEqual(f.tailnet, ["alice@github", "tag:ci"]);
  assert.deepEqual(toInput(f).tailnet, ["alice@github", "tag:ci"]);
  assert.equal(formChanged(f, fromView(v)), false);
  assert.equal(formChanged(f, { ...f, tailnet: ["alice@github"] }), true);
});

test("linkKind tells a login from a tag and refuses the rest", () => {
  assert.equal(linkKind("alice@github"), "login");
  assert.equal(linkKind(" Alice@GitHub "), "login");
  assert.equal(linkKind("tag:ci"), "tag");
  assert.equal(linkKind("tag:a_b"), null);
  assert.equal(linkKind("tag:"), null);
  assert.equal(linkKind("alice"), null);
  assert.equal(linkKind(""), null);
  assert.equal(linkKind("a b@github"), null);
  assert.equal(linkKind("ali\u00e7e@github"), null);
});

test("formProblems names a bad link and a 17th link, and nothing for good ones", () => {
  const f = good();
  f.tailnet = ["alice@github", "tag:ci"];
  assert.deepEqual(formProblems(f), []);
  f.tailnet = ["tag:a_b"];
  assert.equal(formProblems(f).length, 1);
  assert.match(formProblems(f)[0]!, /tag:a_b/);
  f.tailnet = Array.from({ length: 17 }, (_, i) => `u${i}@github`);
  assert.equal(formProblems(f).length, 1);
  assert.match(formProblems(f)[0]!, /16/);
  f.tailnet = Array.from({ length: 16 }, (_, i) => `u${i}@github`);
  assert.deepEqual(formProblems(f), []);
});

test("linkCounts follows the hub's lock-out rule: socket any link, headers only logins, no source none", () => {
  for (const l of ["alice@github", "tag:ci"]) {
    assert.equal(linkCounts(l, "socket"), true, `socket ${l}`);
    assert.equal(linkCounts(l, null), false, `off ${l}`);
  }
  assert.equal(linkCounts("alice@github", "headers"), true);
  assert.equal(linkCounts("tag:ci", "headers"), false);
  assert.equal(anyLinkCounts(["tag:ci"], "headers"), false);
  assert.equal(anyLinkCounts(["tag:ci", "alice@github"], "headers"), true);
  assert.equal(anyLinkCounts([], "socket"), false);
});

test("the order of the links is not a change: removing one and adding it back leaves the form unchanged", () => {
  const start = { ...good(), tailnet: ["a@x.y", "b@x.y"] };
  assert.equal(formChanged(start, { ...good(), tailnet: ["b@x.y", "a@x.y"] }), false);
  assert.equal(formChanged(start, { ...good(), tailnet: ["a@x.y"] }), true);
  assert.equal(linksKey(["B@x.y", "a@x.y"]), linksKey(["a@x.y", "b@x.y", " "]));
});

test("a value that is not printable ASCII is never case folded into a link (the Kelvin sign is not a K)", () => {
  assert.equal(linkKind("\u212Aate@github"), null);
  assert.equal(linkKind("tag:\u212A"), null);
  assert.equal(cleanLink("\u212Aate@github"), "\u212Aate@github", "left as typed, so the hub refuses it too");
  assert.equal(linkKind("Kate@github"), "login", "plain ASCII is lowercased, as the hub does");
  const f = good();
  f.tailnet = ["\u212Aate@github"];
  assert.equal(formProblems(f).length, 1);
});
