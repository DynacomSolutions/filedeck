import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BAD_NAME, SmbBackend, parseLs, smbLimits, smbOptionArgs } from "../src/sources/smb.ts";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-smbclient.mjs");
const KNOBS = ["FILEDECK_SMBCLIENT", "FAKE_SMB_ROOT", "FAKE_SMB_USER", "FAKE_SMB_PASSWORD", "FAKE_SMB_LOG", "FAKE_SMB_FAIL_RENAME_TO", "FAKE_SMB_NO_F", "FAKE_SMB_APPLY_THEN_FAIL", "FAKE_SMB_FAIL_RESTORE", "FAKE_SMB_FAIL_DEL_OLD", "FAKE_SMB_RENAME_STATUS"];
const saved: Record<string, string | undefined> = {};
let tmp = "";
let share = "";
let log = "";

before(() => {
  for (const k of KNOBS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smb-unit-"));
  share = path.join(tmp, "share");
  log = path.join(tmp, "calls.log");
  fs.mkdirSync(share);
  Object.assign(process.env, { FILEDECK_SMBCLIENT: fake, FAKE_SMB_ROOT: share, FAKE_SMB_USER: "u", FAKE_SMB_PASSWORD: "p", FAKE_SMB_LOG: log });
});
after(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const backend = () => new SmbBackend({ name: "n", type: "smb", host: "h", root: "/", options: { share: "s" } } as never, async () => ({ username: "u", password: "p" }));
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cmds: string }) : []);
const resetLog = () => fs.rmSync(log, { force: true });

test("name filter rejects the command separator and the other forbidden characters", () => {
  for (const bad of ["a;b", "x; del *", ";", 'q"q', "a\\b", "a*b", "a?b", "a<b", "a>b", "a|b", "a:b", "a\nb", "a\x00b"]) assert.ok(BAD_NAME.test(bad), JSON.stringify(bad));
  for (const ok of ["plain.txt", "naïve café", "日本語", "a b", "a,b", "a'b", "a&b", "a#b", "-dash"]) assert.ok(!BAD_NAME.test(ok), ok);
});

test("a name with a semicolon never reaches smbclient", async () => {
  const b = backend();
  resetLog();
  const evil = "/x; mkdir pwned";
  await assert.rejects(b.mkdir(evil), { status: 400 });
  await assert.rejects(b.list(evil), { status: 400 });
  await assert.rejects(b.stat(evil), { status: 400 });
  await assert.rejects(b.read(evil), { status: 400 });
  await assert.rejects(b.remove(evil, false), { status: 400 });
  await assert.rejects(b.rename("/ok", evil, false), { status: 400 });
  await assert.rejects(b.write(evil, Readable.from([Buffer.from("x")]), { overwrite: false }), { status: 400 });
  assert.deepEqual(calls(), []);
  assert.equal(fs.existsSync(path.join(share, "pwned")), false);
});

test("a share or root containing a semicolon is refused at construction", () => {
  assert.throws(() => new SmbBackend({ name: "n", type: "smb", host: "h", root: "/", options: { share: "s;x" } } as never, async () => ({})));
  assert.throws(() => new SmbBackend({ name: "n", type: "smb", host: "h", root: "/a;b", options: { share: "s" } } as never, async () => ({})));
});

test("commands are quoted and the charset options are passed", async () => {
  const b = backend();
  fs.mkdirSync(path.join(share, "dir one"), { recursive: true });
  fs.writeFileSync(path.join(share, "dir one", "f.txt"), "hi");
  resetLog();
  await b.list("/dir one");
  await b.stat("/dir one/f.txt");
  const c = calls();
  assert.equal(c[0]?.cmds, 'ls "dir one\\*"');
  assert.equal(c[1]?.cmds, 'ls "dir one\\f.txt"');
  assert.ok(c[0]?.argv.includes("--option=unix charset=UTF-8"));
  assert.ok(!c[0]?.argv.some((a) => a.includes("display charset")), "not an option the real client accepts");
  assert.ok(c[0]?.argv.includes("//h/s"));
  assert.ok(!c[0]?.argv.some((a) => a.includes("p") && a === "p"), "password stays out of argv");
});

test("parseLs keeps non-ASCII names and skips headers", () => {
  const out = [
    "  .                                   D        0  Tue Nov 10 10:00:00 2026",
    "  naïve café 日本語.txt                N       12  Tue Nov 10 10:00:00 2026",
    "  Ünïcode folder                      D        0  Tue Nov 10 10:00:00 2026",
    "",
    "\t\t1000 blocks of size 1024. 500 blocks available",
  ].join("\n");
  const e = parseLs(out);
  assert.deepEqual(e.map((x) => [x.name, x.type]), [[".", "dir"], ["naïve café 日本語.txt", "file"], ["Ünïcode folder", "dir"]]);
});

test("non-ASCII names round-trip through listing and stat", async () => {
  const b = backend();
  const dir = path.join(share, "uni");
  fs.mkdirSync(dir);
  const names = ["naïve café.txt", "日本語のファイル.txt", "Ünï"];
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  const got = (await b.list("/uni")).map((e) => e.name).sort();
  assert.deepEqual(got, [...names].sort());
  assert.equal((await b.stat("/uni/日本語のファイル.txt"))?.type, "file");
});

test("a listing longer than 1 MiB of output is returned whole", async () => {
  const b = backend();
  const dir = path.join(share, "big");
  fs.mkdirSync(dir);
  const N = 14_000;
  const pad = "é".repeat(40);
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dir, `${pad}-${String(i).padStart(6, "0")}`), "");
  const list = await b.list("/big");
  assert.equal(list.length, N);
  assert.ok(list.some((e) => e.name === `${pad}-${String(N - 1).padStart(6, "0")}`), "last entry present");
});

test("a failed overwrite keeps the old file and leaves no helper files", async () => {
  const b = backend();
  const f = path.join(share, "keep.txt");
  fs.writeFileSync(f, "old content");
  process.env.FAKE_SMB_FAIL_RENAME_TO = "keep.txt";
  try {
    await assert.rejects(b.write("/keep.txt", Readable.from([Buffer.from("new content")]), { overwrite: true }), { status: 403 });
  } finally {
    delete process.env.FAKE_SMB_FAIL_RENAME_TO;
  }
  assert.equal(fs.readFileSync(f, "utf8"), "old content");
  assert.deepEqual(fs.readdirSync(share).filter((n) => n.startsWith(".keep.txt")), []);
});

test("a successful overwrite replaces the content and removes helper files", async () => {
  const b = backend();
  const f = path.join(share, "swap.txt");
  fs.writeFileSync(f, "old");
  assert.equal(await b.write("/swap.txt", Readable.from([Buffer.from("new content")]), { overwrite: true }), 11);
  assert.equal(fs.readFileSync(f, "utf8"), "new content");
  assert.deepEqual(fs.readdirSync(share).filter((n) => n.startsWith(".swap.txt")), []);
});

test("a failed rename over an existing file keeps both files", async () => {
  const b = backend();
  fs.writeFileSync(path.join(share, "src.txt"), "source");
  fs.writeFileSync(path.join(share, "dst.txt"), "destination");
  process.env.FAKE_SMB_FAIL_RENAME_TO = "dst.txt";
  try {
    await assert.rejects(b.rename("/src.txt", "/dst.txt", true), { status: 403 });
  } finally {
    delete process.env.FAKE_SMB_FAIL_RENAME_TO;
  }
  assert.equal(fs.readFileSync(path.join(share, "src.txt"), "utf8"), "source");
  assert.equal(fs.readFileSync(path.join(share, "dst.txt"), "utf8"), "destination");
  await b.rename("/src.txt", "/dst.txt", true);
  assert.equal(fs.readFileSync(path.join(share, "dst.txt"), "utf8"), "source");
  assert.deepEqual(fs.readdirSync(share).filter((n) => n.startsWith(".dst.txt")), []);
});

const hasReal = spawnSync("smbclient", ["--version"]).status === 0;
// the image build sets FILEDECK_REQUIRE_SMBCLIENT=1 so that this check can never be skipped against the client that ships
const required = process.env.FILEDECK_REQUIRE_SMBCLIENT === "1";
test("the real smbclient accepts the option arguments the backend builds", { skip: !hasReal && !required && "smbclient not installed" }, () => {
  assert.ok(hasReal || !required, "FILEDECK_REQUIRE_SMBCLIENT=1 but smbclient is not installed");
  // port 1 refuses at once, so this needs no server; a rejected option would stop smbclient before it connects
  const r = spawnSync("smbclient", ["//127.0.0.1/s", "-s", "/dev/null", ...smbOptionArgs(), "-d", "1", "-p", "1", "-N", "-c", "ls"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/tmp", LANG: "C" }, timeout: 20_000 });
  const text = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(text, /Unknown option|Unknown parameter|Error setting option|Can't load/, text);
  assert.match(text, /NT_STATUS_[A-Z_]+/, text); // it got as far as connecting
});

const SNAP = (dir: string) => fs.readdirSync(dir).sort();
const hidden = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith(".fd"));
const put = (b: SmbBackend, p: string, text: string) => b.write(p, Readable.from([Buffer.from(text)]), { overwrite: true });

test("overwrite uses the one-step replace and leaves no helper files", async () => {
  const b = backend();
  fs.writeFileSync(path.join(share, "one.txt"), "old");
  resetLog();
  await put(b, "/one.txt", "new");
  assert.equal(fs.readFileSync(path.join(share, "one.txt"), "utf8"), "new");
  assert.deepEqual(hidden(share), []);
  assert.ok(calls().some((c) => / -f$/.test(c.cmds)), "rename -f was used");
  assert.ok(!calls().some((c) => c.cmds.startsWith("rename") && c.cmds.endsWith(".old\"")), "no move-aside needed");
});

test("a server that refuses -f gets the move-aside sequence", async () => {
  const b = backend();
  fs.writeFileSync(path.join(share, "nof.txt"), "old");
  process.env.FAKE_SMB_NO_F = "1";
  try {
    await put(b, "/nof.txt", "new");
  } finally {
    delete process.env.FAKE_SMB_NO_F;
  }
  assert.equal(fs.readFileSync(path.join(share, "nof.txt"), "utf8"), "new");
  assert.deepEqual(hidden(share), []);
});

test("a rename that is applied but reported as failed ends with the new content and nothing lost", async () => {
  const b = backend();
  const f = path.join(share, "applied.txt");
  // (a) the one-step replace is applied, then the connection drops
  fs.writeFileSync(f, "old");
  process.env.FAKE_SMB_APPLY_THEN_FAIL = "applied.txt";
  try {
    await put(b, "/applied.txt", "new-a");
    assert.equal(fs.readFileSync(f, "utf8"), "new-a");
    // (b) fallback path, the move-aside is applied then reported failed
    process.env.FAKE_SMB_NO_F = "1";
    process.env.FAKE_SMB_APPLY_THEN_FAIL = ".old";
    await put(b, "/applied.txt", "new-b");
    assert.equal(fs.readFileSync(f, "utf8"), "new-b");
    // (c) fallback path, the move-in is applied then reported failed
    process.env.FAKE_SMB_APPLY_THEN_FAIL = "applied.txt";
    await put(b, "/applied.txt", "new-c");
    assert.equal(fs.readFileSync(f, "utf8"), "new-c");
  } finally {
    delete process.env.FAKE_SMB_APPLY_THEN_FAIL;
    delete process.env.FAKE_SMB_NO_F;
  }
  assert.deepEqual(hidden(share), []);
});

test("when the old file cannot be put back the error says so and both copies stay", async () => {
  const b = backend();
  const f = path.join(share, "stuck.txt");
  fs.writeFileSync(f, "old-content");
  Object.assign(process.env, { FAKE_SMB_NO_F: "1", FAKE_SMB_FAIL_RENAME_TO: "stuck.txt", FAKE_SMB_FAIL_RESTORE: "1" });
  try {
    await assert.rejects(put(b, "/stuck.txt", "new-content"), (e: unknown) => (e as { status?: number }).status === 502 && /hidden \.old name/.test((e as Error).message));
  } finally {
    for (const k of ["FAKE_SMB_NO_F", "FAKE_SMB_FAIL_RENAME_TO", "FAKE_SMB_FAIL_RESTORE"]) delete process.env[k];
  }
  const contents = hidden(share).map((n) => fs.readFileSync(path.join(share, n), "utf8")).sort();
  assert.deepEqual(contents, ["new-content", "old-content"]);
  for (const n of hidden(share)) fs.rmSync(path.join(share, n));
});

test("a backup that cannot be deleted is reported, not ignored", async () => {
  const b = backend();
  const f = path.join(share, "bak.txt");
  fs.writeFileSync(f, "old");
  Object.assign(process.env, { FAKE_SMB_NO_F: "1", FAKE_SMB_FAIL_DEL_OLD: "1" });
  try {
    await assert.rejects(put(b, "/bak.txt", "new"), (e: unknown) => /could not be removed/.test((e as Error).message));
  } finally {
    for (const k of ["FAKE_SMB_NO_F", "FAKE_SMB_FAIL_DEL_OLD"]) delete process.env[k];
  }
  assert.equal(fs.readFileSync(f, "utf8"), "new");
  for (const n of hidden(share)) fs.rmSync(path.join(share, n));
});

test("overwriting a file with a very long name works", async () => {
  const b = backend();
  const name = "n".repeat(240) + ".txt";
  fs.writeFileSync(path.join(share, name), "old");
  await put(b, "/" + name, "new");
  assert.equal(fs.readFileSync(path.join(share, name), "utf8"), "new");
  assert.deepEqual(hidden(share), []);
});

test("names SMB commands cannot carry are left out of a listing, the rest stays", async () => {
  const b = backend();
  const dir = path.join(share, "semi");
  fs.mkdirSync(dir);
  for (const n of ["fine.txt", "bad;name.txt", "q?.txt"]) fs.writeFileSync(path.join(dir, n), "x");
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (m: string) => void said.push(String(m));
  try {
    assert.deepEqual((await b.list("/semi")).map((e) => e.name), ["fine.txt"]);
  } finally {
    console.warn = warn;
  }
  assert.equal(said.length, 1);
  assert.match(said[0]!, /2 entries/);
  assert.ok(!said[0]!.includes("bad;name"), "names stay out of the log");
});

test("a listing is parsed as it streams: multi-byte names split across reads stay whole", async () => {
  const b = backend();
  const dir = path.join(share, "chunks");
  fs.mkdirSync(dir);
  const names = Array.from({ length: 3000 }, (_, i) => `日本語-${String(i).padStart(5, "0")}-é`);
  for (const n of names) fs.writeFileSync(path.join(dir, n), "");
  assert.deepEqual((await b.list("/chunks")).map((e) => e.name).sort(), [...names].sort());
});

test("a refusal of the one-step replace is reported and nothing is moved aside", async () => {
  for (const [status, http] of [["NT_STATUS_ACCESS_DENIED", 403], ["NT_STATUS_DISK_FULL", 507]] as const) {
    const b = backend();
    const f = path.join(share, `refuse-${http}.txt`);
    fs.writeFileSync(f, "protected");
    Object.assign(process.env, { FAKE_SMB_FAIL_RENAME_TO: `refuse-${http}.txt`, FAKE_SMB_RENAME_STATUS: status });
    resetLog();
    try {
      await assert.rejects(put(b, `/refuse-${http}.txt`, "new"), { status: http });
    } finally {
      delete process.env.FAKE_SMB_FAIL_RENAME_TO;
      delete process.env.FAKE_SMB_RENAME_STATUS;
    }
    assert.equal(fs.readFileSync(f, "utf8"), "protected");
    assert.deepEqual(hidden(share), [], "the upload copy is cleaned up and no aside copy exists");
    assert.ok(!calls().some((c) => /^rename .*\.fd[0-9a-f]{8}.*\.old"$/.test(c.cmds)), "the old file was never moved aside");
  }
});

const drainOf = async (r: Readable) => {
  const out: Buffer[] = [];
  for await (const c of r) out.push(c as Buffer);
  return Buffer.concat(out);
};
const aged = (f: string, hours: number) => {
  const t = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(f, t, t);
};

test("recovery: an orphaned .old is restored when its target name is missing, on list, read and write", async () => {
  for (const how of ["list", "read", "write"] as const) {
    const dir = path.join(share, `rec-${how}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".fd0a1b2c3d~lost.txt.old"), "precious");
    fs.writeFileSync(path.join(dir, "other.txt"), "o");
    const b = backend();
    if (how === "list") await b.list(`/rec-${how}`);
    else if (how === "read") assert.equal((await drainOf(await b.read(`/rec-${how}/other.txt`))).toString(), "o");
    else await b.write(`/rec-${how}/new.txt`, Readable.from([Buffer.from("x")]), { overwrite: false });
    assert.equal(fs.readFileSync(path.join(dir, "lost.txt"), "utf8"), "precious", how);
    assert.deepEqual(hidden(dir), [], how);
  }
});

test("recovery never replaces a file and never matches names that are not exactly the helper pattern", async () => {
  const dir = path.join(share, "rec-strict");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "here.txt"), "current");
  fs.writeFileSync(path.join(dir, ".fd0a1b2c3d~here.txt.old"), "stale aside"); // target exists: left alone
  const userNames = [".fd123~gone.old", ".fdzzzzzzzz~gone.old", ".fd0a1b2c3d.old", ".fd0a1b2c3d~gone.txt", "fd0a1b2c3d~gone.old", ".fd0a1b2c3d~gone.OLDX"];
  for (const n of userNames) fs.writeFileSync(path.join(dir, n), "mine");
  await backend().list("/rec-strict");
  assert.equal(fs.readFileSync(path.join(dir, "here.txt"), "utf8"), "current");
  assert.equal(fs.readFileSync(path.join(dir, ".fd0a1b2c3d~here.txt.old"), "utf8"), "stale aside");
  for (const n of userNames) assert.equal(fs.readFileSync(path.join(dir, n), "utf8"), "mine", n);
  assert.equal(fs.existsSync(path.join(dir, "gone")), false);
});

test("recovery removes a .part only when it is old and its target exists", async () => {
  const dir = path.join(share, "rec-part");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "done.txt"), "final");
  const mk = (n: string, hours: number) => {
    fs.writeFileSync(path.join(dir, n), "partial");
    aged(path.join(dir, n), hours);
  };
  mk(".fd11111111~done.txt.part", 72); // old, target exists: removed
  mk(".fd22222222~done.txt.part", 1); // recent (maybe still uploading): kept
  mk(".fd33333333~pending.txt.part", 72); // old but the target does not exist: kept
  await backend().list("/rec-part");
  assert.deepEqual(hidden(dir).sort(), [".fd22222222~done.txt.part", ".fd33333333~pending.txt.part"]);
  assert.equal(fs.readFileSync(path.join(dir, "done.txt"), "utf8"), "final");
});

test("a replace names its helper files so they can be recovered", async () => {
  const b = backend();
  fs.writeFileSync(path.join(share, "named.txt"), "old");
  resetLog();
  process.env.FAKE_SMB_NO_F = "1";
  try {
    await put(b, "/named.txt", "new");
  } finally {
    delete process.env.FAKE_SMB_NO_F;
  }
  const cmds = calls().map((c) => c.cmds).join("\n");
  assert.match(cmds, /\.fd[0-9a-f]{8}~named\.txt\.part/);
  assert.match(cmds, /\.fd[0-9a-f]{8}~named\.txt\.old/);
});

test("a folder over the listing cap fails with a plain message", async () => {
  const dir = path.join(share, "cap");
  fs.mkdirSync(dir);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `f${i}`), "");
  const saved = smbLimits.maxEntries;
  smbLimits.maxEntries = 50;
  try {
    await assert.rejects(backend().list("/cap"), (e: unknown) => (e as { status?: number }).status === 502 && /more than 50 entries/.test((e as Error).message));
  } finally {
    smbLimits.maxEntries = saved;
  }
  assert.equal((await backend().list("/cap")).length, 60);
});
