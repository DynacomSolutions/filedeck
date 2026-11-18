import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts, AuthDb } from "../src/auth/store.ts";
import { LinkTaken, TailnetLinks, resolve } from "../src/auth/tailnet-links.ts";

function fresh(now?: () => number) {
  const store = new AuthDb(":memory:");
  return { store, links: new TailnetLinks(store, now), accounts: new Accounts(store) };
}

test("set, look up and list the links of one account", () => {
  const { links } = fresh();
  links.setForAccount("virt", "guest", [
    { subject: "tag:server", kind: "tag" },
    { subject: "alice@github", kind: "login" },
  ]);
  assert.deepEqual(links.owner("tag:server"), { kind: "virt", name: "guest" });
  assert.deepEqual(links.owner("alice@github"), { kind: "virt", name: "guest" });
  assert.equal(links.owner("bob@github"), undefined);
  assert.deepEqual(links.forAccount("virt", "guest"), [
    { subject: "alice@github", kind: "login" },
    { subject: "tag:server", kind: "tag" },
  ]);
  assert.deepEqual(links.forAccount("sys", "guest"), [], "a system user of the same name has its own links");
});

test("a subject linked to another account throws LinkTaken and changes nothing", () => {
  const { links } = fresh();
  links.setForAccount("virt", "guest", [
    { subject: "alice@github", kind: "login" },
    { subject: "tag:server", kind: "tag" },
  ]);
  links.setForAccount("sys", "guest", [{ subject: "bob@github", kind: "login" }]);
  assert.throws(
    () => links.setForAccount("sys", "guest", [{ subject: "carol@github", kind: "login" }, { subject: "tag:server", kind: "tag" }]),
    (e: unknown) => {
      assert.ok(e instanceof LinkTaken);
      assert.equal(e.subject, "tag:server");
      assert.equal(e.kind, "tag");
      assert.equal(e.accountKind, "virt");
      assert.equal(e.name, "guest");
      assert.match(e.message, /virt:guest/);
      return true;
    },
  );
  assert.deepEqual(links.forAccount("sys", "guest"), [{ subject: "bob@github", kind: "login" }], "the old links of the writer stay");
  assert.equal(links.owner("carol@github"), undefined);
  assert.deepEqual(links.owner("tag:server"), { kind: "virt", name: "guest" });
});

test("an empty list removes every link of the account", () => {
  const { links } = fresh();
  links.setForAccount("virt", "guest", [
    { subject: "alice@github", kind: "login" },
    { subject: "tag:server", kind: "tag" },
  ]);
  links.setForAccount("virt", "guest", []);
  assert.deepEqual(links.forAccount("virt", "guest"), []);
  assert.equal(links.owner("alice@github"), undefined);
  assert.equal(links.owner("tag:server"), undefined);
});

test("a link that is kept keeps its created time; a duplicate in the list is one link", () => {
  let t = 1000;
  const { store, links } = fresh(() => t);
  links.setForAccount("virt", "guest", [{ subject: "alice@github", kind: "login" }]);
  t = 5000;
  links.setForAccount("virt", "guest", [
    { subject: "alice@github", kind: "login" },
    { subject: "tag:server", kind: "tag" },
    { subject: "tag:server", kind: "tag" },
  ]);
  const rows = store.db.prepare("SELECT subject, created FROM tailnet_links ORDER BY subject").all() as { subject: string; created: number }[];
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { subject: "alice@github", created: 1000 },
      { subject: "tag:server", created: 5000 },
    ],
  );
});

test("accounts lists only names with links, per kind; removeAccount touches only that account", () => {
  const { links } = fresh();
  links.setForAccount("sys", "bob", [{ subject: "bob@github", kind: "login" }]);
  links.setForAccount("sys", "alice", [{ subject: "tag:a", kind: "tag" }]);
  links.setForAccount("sys", "carol", []);
  links.setForAccount("virt", "bob", [{ subject: "tag:b", kind: "tag" }]);
  assert.deepEqual(links.accounts("sys"), ["alice", "bob"]);
  assert.deepEqual(links.accounts("virt"), ["bob"]);
  links.removeAccount("sys", "bob");
  assert.deepEqual(links.accounts("sys"), ["alice"]);
  assert.deepEqual(links.forAccount("virt", "bob"), [{ subject: "tag:b", kind: "tag" }]);
});

test("inside an outer transaction that throws, nothing of setForAccount is kept", () => {
  const { links, accounts } = fresh();
  links.setForAccount("virt", "guest", [{ subject: "alice@github", kind: "login" }]);
  assert.throws(
    () =>
      accounts.tx(() => {
        links.setForAccount("virt", "guest", [{ subject: "tag:server", kind: "tag" }]);
        throw new Error("later check failed");
      }),
    /later check failed/,
  );
  assert.deepEqual(links.forAccount("virt", "guest"), [{ subject: "alice@github", kind: "login" }]);
  assert.equal(links.owner("tag:server"), undefined);
});

test("a LinkTaken inside an outer transaction undoes only the links, and the caller decides", () => {
  const { links, accounts } = fresh();
  links.setForAccount("virt", "a", [{ subject: "tag:server", kind: "tag" }]);
  links.setForAccount("virt", "b", [{ subject: "bob@github", kind: "login" }]);
  accounts.tx(() => {
    links.setForAccount("virt", "c", [{ subject: "carol@github", kind: "login" }]);
    assert.throws(() => links.setForAccount("virt", "b", [{ subject: "tag:server", kind: "tag" }]), LinkTaken);
  });
  assert.deepEqual(links.forAccount("virt", "b"), [{ subject: "bob@github", kind: "login" }]);
  assert.deepEqual(links.forAccount("virt", "c"), [{ subject: "carol@github", kind: "login" }]);
});

test("counts: a login link for socket and headers, a tag link only for socket, nothing with no source", () => {
  const { links } = fresh();
  links.setForAccount("virt", "l", [{ subject: "alice@github", kind: "login" }]);
  links.setForAccount("virt", "t", [{ subject: "tag:server", kind: "tag" }]);
  assert.equal(links.counts("virt", "l", "socket"), true);
  assert.equal(links.counts("virt", "l", "headers"), true);
  assert.equal(links.counts("virt", "l", null), false);
  assert.equal(links.counts("virt", "t", "socket"), true);
  assert.equal(links.counts("virt", "t", "headers"), false);
  assert.equal(links.counts("virt", "t", null), false);
  assert.equal(links.counts("virt", "none", "socket"), false);
  assert.equal(links.counts("sys", "l", "socket"), false);
});

test("resolve: a linked login wins; else one account among the linked tags; else a refusal", () => {
  const { links } = fresh();
  links.setForAccount("virt", "a", [{ subject: "alice@github", kind: "login" }]);
  links.setForAccount("virt", "b", [
    { subject: "tag:web", kind: "tag" },
    { subject: "tag:ci", kind: "tag" },
  ]);
  links.setForAccount("sys", "c", [{ subject: "tag:db", kind: "tag" }]);

  assert.deepEqual(resolve({ login: "alice@github", tags: ["tag:web"], source: "socket" }, links), {
    ok: true,
    kind: "virt",
    name: "a",
    subject: "alice@github",
    match: "login",
  });
  assert.deepEqual(resolve({ login: "bob@github", tags: ["tag:ci", "tag:web"], source: "socket" }, links), {
    ok: true,
    kind: "virt",
    name: "b",
    subject: "tag:ci",
    match: "tag",
  });
  assert.deepEqual(resolve({ tags: ["tag:web", "tag:ci"], source: "socket" }, links), {
    ok: true,
    kind: "virt",
    name: "b",
    subject: "tag:ci",
    match: "tag",
  }, "tags are taken in sorted order whatever order they come in");
  assert.deepEqual(resolve({ tags: ["tag:db", "tag:web"], source: "socket" }, links), {
    ok: false,
    reason: "tag-conflict",
    accounts: ["sys:c", "virt:b"],
  });
  assert.deepEqual(resolve({ tags: ["tag:x"], source: "socket" }, links), { ok: false, reason: "unlinked" });
  assert.deepEqual(resolve({ login: "bob@github", tags: [], source: "headers" }, links), { ok: false, reason: "unlinked" });
  assert.deepEqual(resolve({ tags: ["tag:x", "tag:web"], source: "socket" }, links), {
    ok: true,
    kind: "virt",
    name: "b",
    subject: "tag:web",
    match: "tag",
  }, "an unlinked tag beside a linked one does not refuse");
});
