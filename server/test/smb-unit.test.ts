import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { BAD_NAME, SmbBackend, parseLs } from "../src/sources/smb.ts";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-smbclient.mjs");
const KNOBS = ["FILEDECK_SMBCLIENT", "FAKE_SMB_ROOT", "FAKE_SMB_USER", "FAKE_SMB_PASSWORD", "FAKE_SMB_LOG", "FAKE_SMB_FAIL_RENAME_TO"];
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
  assert.ok(c[0]?.argv.includes("--option=display charset=UTF-8"));
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
