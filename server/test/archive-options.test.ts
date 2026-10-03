import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { haveSevenZip, passwordFromHeader, scrub, validPassword } from "../src/sevenzip.ts";
import { levelOptions, selector } from "../src/archive.ts";

const HAVE_BSDTAR = spawnSync("bsdtar", ["--version"]).status === 0;
const needTool = { skip: HAVE_BSDTAR ? false : "bsdtar not installed" };
const needSz = { skip: HAVE_BSDTAR && haveSevenZip() ? false : "7-Zip (7zz) not installed" };

let work: string;
let tmp: string;
let srv: ReturnType<typeof serve>;
let base: string;
const audit: string[] = [];
const SECRET = "Tr0ub4dor&3-correct horse";

const j = async (r: Response) => (await r.json()) as Record<string, any>;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const post = (p: string, body: unknown, pw?: string) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(pw ? { "x-filedeck-password": b64(pw) } : {}) }, body: JSON.stringify(body) });
async function waitJob(id: string) {
  for (let i = 0; i < 800; i++) {
    const v = await j(await fetch(`${base}/api/jobs/${id}`));
    if (["done", "failed", "canceled"].includes(v.state)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not finish");
}
async function compress(body: Record<string, unknown>, pw?: string) {
  const r = await post("/api/jobs/compress", { dir: "/src", names: ["a.txt", "sub", "big.bin", "skip.log"], ...body }, pw);
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  return waitJob((await j(r)).id);
}
const listOf = async (p: string, pw?: string) => fetch(`${base}/api/archive/list?path=${encodeURIComponent(p)}`, { headers: pw ? { "x-filedeck-password": b64(pw) } : {} });
const names = async (p: string, pw?: string) => ((await j(await listOf(p, pw))).entries as { name: string }[]).map((e) => e.name).sort();

before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-archopt-")));
  tmp = path.join(work, "root");
  fs.mkdirSync(path.join(tmp, "src/sub/deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/a.txt"), "alpha-plain-text-marker");
  fs.writeFileSync(path.join(tmp, "src/skip.log"), "log");
  fs.writeFileSync(path.join(tmp, "src/sub/b c.txt"), "bravo");
  fs.writeFileSync(path.join(tmp, "src/sub/deep/d.txt"), "delta");
  fs.writeFileSync(path.join(tmp, "src/sub/e.log"), "elog");
  fs.writeFileSync(path.join(tmp, "src/big.bin"), Buffer.from(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251)));
  fs.mkdirSync(path.join(tmp, "out"));
  fs.mkdirSync(path.join(tmp, "elsewhere"));
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const app = createAgent(cfg, (l) => audit.push(l));
  srv = await new Promise((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => {
  srv.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("levelOptions maps 0-9 per format", () => {
  assert.equal(levelOptions("zip", 0), "zip:compression=store");
  assert.equal(levelOptions("zip", 9), "zip:compression=deflate,zip:compression-level=9");
  assert.equal(levelOptions("tar.gz", 0), "gzip:compression-level=1");
  assert.equal(levelOptions("tar.zst", 9), "zstd:compression-level=19");
  assert.equal(levelOptions("tar.xz", 6), "xz:compression-level=6");
  assert.equal(levelOptions("7z", 0), "7zip:compression=copy");
  assert.equal(levelOptions("7z", undefined), undefined);
});

test("selector matches entries and everything below selected folders", () => {
  const s = selector(["a.txt", "sub/deep/", "./x"])!;
  assert.ok(s("a.txt") && s("sub/deep/d.txt") && s("sub/deep") && s("x/y/z"));
  assert.ok(!s("sub/b.txt") && !s("a.txt.bak") && !s("sub"));
  assert.equal(selector([]), undefined);
});

test("password helpers: header decoding, validation and scrubbing", () => {
  assert.equal(passwordFromHeader(b64("pä ss")), "pä ss");
  assert.equal(passwordFromHeader(undefined), undefined);
  assert.throws(() => passwordFromHeader("not base64!!"));
  assert.throws(() => validPassword("two\nlines"));
  assert.throws(() => validPassword("x".repeat(300)));
  const s = scrub(`failed for ${SECRET} and ${encodeURIComponent(SECRET)} and ${JSON.stringify(SECRET)} ${b64(SECRET)}`, SECRET);
  assert.ok(!s.includes(SECRET) && !s.includes(encodeURIComponent(SECRET)) && !s.includes(b64(SECRET)), s);
});

for (const [format, level] of [["zip", 0], ["zip", 9], ["tar.gz", 1], ["tar.zst", 9], ["tar.xz", 3], ["7z", 0], ["7z", 9]] as const) {
  test(`level ${level} ${format} round trips`, needTool, async () => {
    const name = `lv${level}-${format.replace(".", "")}`;
    const job = await compress({ format, level, name });
    assert.equal(job.state, "done", JSON.stringify(job));
    assert.ok(await names(job.result.path).then((n) => n.includes("sub/b c.txt")));
    const x = await waitJob((await j(await post("/api/jobs/extract", { path: job.result.path, destDir: "/out", subfolder: true }))).id);
    assert.equal(x.state, "done", JSON.stringify(x));
    assert.equal(fs.readFileSync(path.join(tmp, "out", x.result.path.split("/").pop(), "sub/deep/d.txt"), "utf8"), "delta");
  });
}

test("level changes the output size (store vs maximum)", needTool, async () => {
  const stored = await compress({ format: "zip", level: 0, name: "size-store" });
  const best = await compress({ format: "zip", level: 9, name: "size-best" });
  assert.ok(stored.result.size > best.result.size, `${stored.result.size} vs ${best.result.size}`);
});

test("exclude patterns apply to bsdtar and 7-Zip builds", needTool, async () => {
  const z = await compress({ format: "tar.gz", name: "ex-tar", exclude: ["*.log", "deep"] });
  assert.equal(z.state, "done", JSON.stringify(z));
  const n = await names(z.result.path);
  assert.ok(!n.some((x) => x.endsWith(".log")) && !n.some((x) => x.includes("deep")) && n.includes("a.txt"), n.join(","));
});

test("exclude with 7-Zip (split path) and a destination folder", needSz, async () => {
  const z = await compress({ format: "zip", name: "ex-sz", exclude: ["*.log"], destDir: "/elsewhere", splitBytes: 1024 * 1024 });
  assert.equal(z.state, "done", JSON.stringify(z));
  assert.equal(z.result.path, "/elsewhere/ex-sz.zip.001");
  assert.ok(!(await names(z.result.path)).some((x) => x.endsWith(".log")));
  assert.ok((await names(z.result.path)).includes("a.txt"));
});

test("archive cannot be written inside the items being archived; bad options are 400", needTool, async () => {
  const bad = async (body: Record<string, unknown>, pw?: string) => (await post("/api/jobs/compress", { dir: "/src", names: ["sub"], format: "zip", ...body }, pw)).status;
  assert.equal(await bad({ destDir: "/src/sub/deep" }), 400);
  assert.equal(await bad({ level: 12 }), 400);
  assert.equal(await bad({ exclude: ["ok", "bad\nline"] }), 400);
  assert.equal(await bad({ format: "tar.gz" }, "pw"), 400); // tar cannot encrypt
  assert.equal(await bad({ format: "tar.gz", splitBytes: 1_000_000 }), 400);
  assert.equal(await bad({ format: "zip", encryptHeaders: true }, "pw"), 400); // headers: 7z only
  assert.equal(await bad({}, "line\nbreak"), 400);
  assert.equal(await bad({ splitBytes: 10 }), 400);
});

test("zip AES-256: password required, wrong rejected, right extracts; nothing leaks", needSz, async () => {
  const job = await compress({ format: "zip", name: "aes", level: 5 }, SECRET);
  assert.equal(job.state, "done", JSON.stringify(job));
  const real = path.join(tmp, "src/aes.zip");
  const raw = fs.readFileSync(real);
  assert.ok(!raw.includes("alpha-plain-text-marker"), "file contents must be encrypted");
  assert.ok(raw.includes("a.txt"), "zip keeps names visible (no header encryption)");
  // listing works without a password and flags the entries
  const l = await j(await listOf("/src/aes.zip"));
  assert.equal(l.encrypted, true);
  assert.ok(l.entries.find((e: any) => e.name === "a.txt").encrypted);
  // extract: no password, wrong password, right password
  const none = await post("/api/jobs/extract", { path: "/src/aes.zip", destDir: "/out" });
  assert.equal(none.status, 401);
  assert.equal((await j(none)).code, "password_required");
  const wrong = await post("/api/jobs/extract", { path: "/src/aes.zip", destDir: "/out" }, "nope");
  assert.equal(wrong.status, 401);
  assert.equal((await j(wrong)).code, "password_incorrect");
  const ok = await post("/api/jobs/extract", { path: "/src/aes.zip", destDir: "/out", subfolder: true }, SECRET);
  assert.equal(ok.status, 202);
  const xj = await waitJob((await j(ok)).id);
  assert.equal(xj.state, "done", JSON.stringify(xj));
  assert.equal(fs.readFileSync(path.join(tmp, "out/aes/a.txt"), "utf8"), "alpha-plain-text-marker");
  assert.equal(fs.statSync(path.join(tmp, "out/aes/big.bin")).size, 400_000);
  // nothing in job records, responses or audit lines carries the secret
  const all = JSON.stringify([job, xj, await j(await fetch(`${base}/api/jobs`))]) + audit.join("\n");
  assert.ok(!all.includes(SECRET) && !all.includes(b64(SECRET)) && !all.includes(encodeURIComponent(SECRET)));
  assert.ok(audit.some((l) => l.includes("/api/jobs/compress")), "the requests were audited");
  assert.deepEqual(fs.readdirSync(path.join(tmp, "out")).filter((n) => n.startsWith(".")), []);
});

test("7z with header encryption: names hidden, password needed even to list", needSz, async () => {
  const job = await compress({ format: "7z", name: "hdr", encryptHeaders: true, level: 3 }, SECRET);
  assert.equal(job.state, "done", JSON.stringify(job));
  const raw = fs.readFileSync(path.join(tmp, "src/hdr.7z"));
  assert.ok(!raw.includes("a.txt") && !raw.includes(Buffer.from("a.txt", "utf16le")), "names must not be readable");
  const none = await listOf("/src/hdr.7z");
  assert.equal(none.status, 401);
  assert.equal((await j(none)).code, "password_required");
  assert.equal((await listOf("/src/hdr.7z", "wrong")).status, 401);
  assert.ok((await names("/src/hdr.7z", SECRET)).includes("sub/b c.txt"));
  const x = await post("/api/jobs/extract", { path: "/src/hdr.7z", destDir: "/out", subfolder: false, overwrite: "rename" }, SECRET);
  assert.equal(x.status, 202);
  assert.equal((await waitJob((await j(x)).id)).state, "done");
  assert.equal(fs.readFileSync(path.join(tmp, "out/sub/deep/d.txt"), "utf8"), "delta");
});

test("7z content-only encryption lists freely but extraction needs the password", needSz, async () => {
  const job = await compress({ format: "7z", name: "cont" }, SECRET);
  assert.equal(job.state, "done", JSON.stringify(job));
  assert.equal((await post("/api/jobs/extract", { path: "/src/cont.7z", destDir: "/out" })).status, 401);
  assert.ok((await names("/src/cont.7z")).includes("a.txt"));
});

test("split volumes: parts are at most the volume size and join back into a valid archive", needSz, async () => {
  const job = await compress({ format: "7z", name: "split", level: 0, splitBytes: 100_000 }, undefined);
  assert.equal(job.state, "done", JSON.stringify(job));
  assert.ok(job.result.volumes >= 4 && job.result.path === "/src/split.7z.001", JSON.stringify(job.result));
  assert.ok((await names(job.result.path)).includes("big.bin")); // the first volume opens the whole set
  const parts = fs.readdirSync(path.join(tmp, "src")).filter((n) => n.startsWith("split.7z.")).sort();
  assert.equal(parts.length, job.result.volumes);
  for (const p of parts) assert.ok(fs.statSync(path.join(tmp, "src", p)).size <= 100_000);
  fs.writeFileSync(path.join(tmp, "src/joined.7z"), Buffer.concat(parts.map((p) => fs.readFileSync(path.join(tmp, "src", p)))));
  assert.ok((await names("/src/joined.7z")).includes("big.bin"));
  // a second run does not overwrite: the whole set gets a free name
  const again = await compress({ format: "7z", name: "split", level: 0, splitBytes: 100_000 });
  assert.equal(again.result.path, "/src/split (2).7z.001");
});

test("overwrite policies when extracting into a folder that already has the files", needTool, async () => {
  const z = await compress({ format: "zip", name: "pol" });
  fs.mkdirSync(path.join(tmp, "out/p"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "out/p/a.txt"), "OLD");
  fs.mkdirSync(path.join(tmp, "out/p/sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "out/p/sub/b c.txt"), "OLD2");
  const run = async (overwrite: string) => waitJob((await j(await post("/api/jobs/extract", { path: z.result.path, destDir: "/out/p", subfolder: false, overwrite }))).id);
  const skip = await run("skip");
  assert.equal(skip.state, "done", JSON.stringify(skip));
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/a.txt"), "utf8"), "OLD");
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/sub/b c.txt"), "utf8"), "OLD2");
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/sub/deep/d.txt"), "utf8"), "delta"); // new files still land
  assert.equal(skip.result.skippedExisting, 2);
  const over = await run("overwrite");
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/a.txt"), "utf8"), "alpha-plain-text-marker");
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/sub/b c.txt"), "utf8"), "bravo");
  assert.equal(over.result.replaced >= 2, true, JSON.stringify(over.result));
  const ren = await run("rename");
  assert.equal(fs.readFileSync(path.join(tmp, "out/p/a (2).txt"), "utf8"), "alpha-plain-text-marker");
  assert.equal(ren.state, "done");
  assert.equal((await post("/api/jobs/extract", { path: z.result.path, destDir: "/out/p", overwrite: "bogus" })).status, 400);
});

test("extract selected entries only (bsdtar and 7-Zip paths)", needSz, async () => {
  for (const [fmt, pw] of [["tar.gz", undefined], ["zip", SECRET]] as const) {
    const z = await compress({ format: fmt, name: `sel-${fmt.replace(".", "")}` }, pw);
    assert.equal(z.state, "done", JSON.stringify(z));
    const dest = `sel-${fmt.replace(".", "")}-out`;
    fs.mkdirSync(path.join(tmp, "out", dest));
    const x = await waitJob((await j(await post("/api/jobs/extract", { path: z.result.path, destDir: `/out/${dest}`, subfolder: false, entries: ["a.txt", "sub/deep"] }, pw))).id);
    assert.equal(x.state, "done", JSON.stringify(x));
    assert.deepEqual(fs.readdirSync(path.join(tmp, "out", dest)).sort(), ["a.txt", "sub"]);
    assert.deepEqual(fs.readdirSync(path.join(tmp, "out", dest, "sub")), ["deep"]);
    const none = await waitJob((await j(await post("/api/jobs/extract", { path: z.result.path, destDir: `/out/${dest}`, entries: ["nope.txt"] }, pw))).id);
    assert.equal(none.state, "failed");
    assert.match(none.error, /none of the selected/);
  }
});

test("encrypted zip with a symlink entry: link is not created and cannot be written through", needSz, async () => {
  const d = path.join(tmp, "evil");
  fs.mkdirSync(path.join(d, "x"), { recursive: true });
  fs.symlinkSync(path.join(work, "root/elsewhere"), path.join(d, "x/lnk"));
  fs.writeFileSync(path.join(d, "x/f.txt"), "f");
  const z = await post("/api/jobs/compress", { dir: "/evil", names: ["x"], format: "zip", name: "evilsz" }, SECRET);
  assert.equal((await waitJob((await j(z)).id)).state, "done");
  const ok = await post("/api/jobs/extract", { path: "/evil/evilsz.zip", destDir: "/out", subfolder: true }, SECRET);
  const xj = await waitJob((await j(ok)).id);
  assert.equal(xj.state, "done", JSON.stringify(xj));
  assert.equal(fs.existsSync(path.join(tmp, "out/evilsz/x/lnk")), false);
  assert.equal(fs.readFileSync(path.join(tmp, "out/evilsz/x/f.txt"), "utf8"), "f");
});

test("audit never records a password sent in a body or header", needTool, async () => {
  const before = audit.length;
  await post("/api/jobs/compress", { dir: "/src", names: ["a.txt"], format: "zip", name: "aud", password: SECRET, passphrase: SECRET }, SECRET);
  await post("/api/jobs/extract", { path: "/src/aud.zip", destDir: "/out", password: SECRET }, SECRET);
  const lines = audit.slice(before).join("\n");
  assert.ok(lines.includes("/api/jobs/compress"));
  assert.ok(!lines.includes(SECRET) && !lines.includes(b64(SECRET)) && !lines.toLowerCase().includes("password"));
});
