import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesAccounts, HostAccounts, validSystemName } from "../src/local-accounts.ts";

/**
 * work-item: a sign-in name becomes the local account a worker runs as. The host helper's output is parsed strictly (anything
 * malformed is no account), root never resolves, and a name that is not a valid system name never reaches the helper.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-accounts-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Out = { code: number | null; stdout: string };
const fake = (answer: Out | ((name: string) => Out)) => {
  const calls: string[] = [];
  const run = async (name: string) => (calls.push(name), typeof answer === "function" ? answer(name) : answer);
  return { run, calls };
};

test("host lookup: the helper's four lines become the account", async () => {
  const f = fake({ code: 0, stdout: "1000\n1000\n/home/a b\n1000 27\n" });
  const r = await new HostAccounts({ run: f.run }).resolve("alice");
  assert.deepEqual(r, { name: "alice", uid: 1000, gid: 1000, home: "/home/a b", groups: [1000, 27] });
  assert.deepEqual(f.calls, ["alice"]);
});

test("host lookup: uid 0 or gid 0 give no account; malformed output is an error, not an unknown name", async () => {
  for (const stdout of ["0\n1000\n/root\n1000\n", "1000\n0\n/home/a\n0\n"]) {
    const f = fake({ code: 0, stdout });
    assert.equal(await new HostAccounts({ run: f.run }).resolve("alice"), null, JSON.stringify(stdout));
  }
  for (const stdout of [
    "1000\n1000\n/home/a\n", // three lines
    "1000\n1000\n/home/a\n1000\nextra\n", // five lines
    "1000\n1000\n/home/a\n1000", // no final newline
    "1000\n1000\nhome/a\n1000\n", // a home that is not absolute
    "1000\n1000\n\n1000\n", // an empty home
    "-5\n1000\n/home/a\n1000\n", // a negative uid
    "10x\n1000\n/home/a\n1000\n", // not a number
    "1000\n1000\n/home/a\n1000  27\n", // two spaces
    "1000\n1000\n/home/a\n1000 x\n", // a group that is not a number
    "4294967295\n1000\n/home/a\n1000\n", // (uid_t)-1
    "99999999999\n1000\n/home/a\n1000\n", // too big
    " 1000\n1000\n/home/a\n1000\n", // a space before the uid
    "1000\n1000\n/home/a\0b\n1000\n", // a NUL in the home
    "",
  ]) {
    const f = fake({ code: 0, stdout });
    await assert.rejects(new HostAccounts({ run: f.run }).resolve("alice"), /alice/, JSON.stringify(stdout));
  }
});

test("host lookup: a supplementary group 0 is dropped and said once per name, the account still resolves", async () => {
  const f = fake({ code: 0, stdout: "1000\n1000\n/home/a\n1000 0 27 27\n" });
  const logs: string[] = [];
  const h = new HostAccounts({ run: f.run, log: (s) => logs.push(s) });
  assert.deepEqual((await h.resolve("alice"))?.groups, [1000, 27]);
  assert.deepEqual((await h.resolve("alice", true))?.groups, [1000, 27]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /alice/);
  assert.match(logs[0]!, /group 0/);
});

test("host lookup: exit 2 with no output is an unknown name; another code, a killed helper or a failed start is an error", async () => {
  assert.equal(await new HostAccounts({ run: fake({ code: 2, stdout: "" }).run }).resolve("alice"), null);
  for (const r of [{ code: 2, stdout: "x\n" }, { code: 1, stdout: "" }, { code: 64, stdout: "" }, { code: null, stdout: "1000\n1000\n/home/a\n1000\n" }]) {
    await assert.rejects(new HostAccounts({ run: fake(r).run }).resolve("alice"), /alice/, JSON.stringify(r));
  }
  const failing = new HostAccounts({ run: async () => { throw new Error("launcher missing"); } });
  await assert.rejects(failing.resolve("alice"), /launcher missing/);
});

test("host lookup: an invalid name gives no account and the helper is never run", async () => {
  const f = fake({ code: 0, stdout: "1000\n1000\n/home/a\n1000\n" });
  const h = new HostAccounts({ run: f.run });
  for (const name of ["-x", "a/b", "a".repeat(65), "", ".x", "a b", "a\nb", "a:b", "ä"]) assert.equal(await h.resolve(name), null, name);
  assert.deepEqual(f.calls, []);
  assert.equal(validSystemName("a".repeat(64)), true);
  assert.equal(validSystemName("_svc.name@realm-1"), true);
});

test("host lookup: answers are cached for the TTL, also an unknown name; fresh skips the cache", async () => {
  let now = 1000;
  const f = fake((name) => (name === "alice" ? { code: 0, stdout: "1000\n1000\n/home/a\n1000\n" } : { code: 2, stdout: "" }));
  const h = new HostAccounts({ run: f.run, ttlMs: 5000, now: () => now });
  assert.equal((await h.resolve("alice"))?.uid, 1000);
  assert.equal((await h.resolve("alice"))?.uid, 1000);
  assert.equal(await h.resolve("ghost"), null);
  assert.equal(await h.resolve("ghost"), null);
  assert.deepEqual(f.calls, ["alice", "ghost"]);
  assert.equal((await h.resolve("alice", true))?.uid, 1000);
  assert.deepEqual(f.calls, ["alice", "ghost", "alice"]);
  now += 5001;
  await h.resolve("ghost");
  assert.deepEqual(f.calls, ["alice", "ghost", "alice", "ghost"]);
});

test("host lookup: a failed run is not cached", async () => {
  let code: number | null = null;
  const f = fake(() => ({ code, stdout: "1000\n1000\n/home/a\n1000\n" }));
  const h = new HostAccounts({ run: f.run });
  await assert.rejects(h.resolve("alice"));
  code = 0;
  assert.equal((await h.resolve("alice"))?.uid, 1000);
  assert.equal(f.calls.length, 2);
});

test("local files: groups come from the member lists, root and a uid 0 alias never resolve", async () => {
  const root = path.join(tmp, "files");
  fs.mkdirSync(path.join(root, "etc"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "etc/passwd"),
    [
      "root:x:0:0:root:/root:/bin/sh",
      "toor:x:0:0:alias:/root:/bin/sh",
      "wheelie:x:1003:0:primary group 0:/home/w:/bin/sh",
      "alice:x:1000:1000:Alice A:/home/a b:/bin/bash",
      "bob:x:1001:1001::/home/bob:/bin/sh",
      "broken:x:12x:1002::/home/broken:/bin/sh",
      "+nisuser::::::",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "etc/group"),
    ["root:x:0:alice", "alice:x:1000:", "bob:x:1001:", "wheel:x:10:bob,alice", "media:x:27:alice", "other:x:30:alicex,xalice", ""].join("\n"),
  );
  const f = new FilesAccounts(root);
  assert.deepEqual(await f.resolve("alice"), { name: "alice", uid: 1000, gid: 1000, home: "/home/a b", groups: [1000, 10, 27] });
  assert.deepEqual(await f.resolve("bob"), { name: "bob", uid: 1001, gid: 1001, home: "/home/bob", groups: [1001, 10] });
  for (const name of ["root", "toor", "wheelie", "broken", "ghost", "-x", "+nisuser"]) assert.equal(await f.resolve(name), null, name);
});

test("for sign-in: uid 0, gid 0 and group 0 are root (never signs in); unknown stays null; an error still rejects", async () => {
  const root = path.join(tmp, "files");
  const f = new FilesAccounts(root, () => {});
  for (const name of ["root", "toor", "wheelie", "alice"]) assert.equal(await f.forSignIn(name), "root", name); // (alice is in group root)
  assert.deepEqual(await f.forSignIn("bob"), { name: "bob", uid: 1001, gid: 1001, home: "/home/bob", groups: [1001, 10] });
  for (const name of ["ghost", "broken", "-x"]) assert.equal(await f.forSignIn(name), null, name);
  const host = (stdout: string) => new HostAccounts({ run: fake({ code: 0, stdout }).run, log: () => {} });
  assert.equal(await host("0\n0\n/root\n0\n").forSignIn("toor"), "root");
  assert.equal(await host("1000\n0\n/home/a\n0\n").forSignIn("alice"), "root");
  assert.equal(await host("1000\n1000\n/home/a\n1000 0\n").forSignIn("alice"), "root");
  assert.equal((await host("1000\n1000\n/home/a\n1000 0\n").resolve("alice"))?.uid, 1000, "a worker still runs without group 0");
  assert.equal((await host("1000\n1000\n/home/a\n1000\n").forSignIn("alice") as { uid: number }).uid, 1000);
  assert.equal(await new HostAccounts({ run: fake({ code: 2, stdout: "" }).run }).forSignIn("alice"), null);
  await assert.rejects(new HostAccounts({ run: fake({ code: 1, stdout: "" }).run }).forSignIn("alice"), /alice/);
});

test("local files: a missing or unreadable passwd file is an error, a missing group file means no extra groups", async () => {
  await assert.rejects(new FilesAccounts(path.join(tmp, "nothing")).resolve("alice"), /passwd/);
  const dirAsFile = path.join(tmp, "passwd-folder");
  fs.mkdirSync(path.join(dirAsFile, "etc/passwd"), { recursive: true }); // a folder where the file should be: reading fails
  await assert.rejects(new FilesAccounts(dirAsFile).resolve("alice"), /passwd/);
  const noGroup = path.join(tmp, "nogroup");
  fs.mkdirSync(path.join(noGroup, "etc"), { recursive: true });
  fs.writeFileSync(path.join(noGroup, "etc/passwd"), "alice:x:1000:1000::/home/a:/bin/sh\n");
  assert.deepEqual((await new FilesAccounts(noGroup).resolve("alice"))?.groups, [1000]);
  fs.mkdirSync(path.join(noGroup, "etc/group")); // a group file that exists but cannot be read is an error too
  await assert.rejects(new FilesAccounts(noGroup).resolve("alice"), /group/);
});
