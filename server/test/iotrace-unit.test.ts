import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertIotraceLine } from "./iotrace-protocol.ts";

/**
 * The output code of filedeck-iotrace on hand-made rows (iotrace-unit.c): no kernel, no capability, no BPF program. Needs a C compiler and the libbpf headers
 * and library (the helper's source includes them), and is skipped with a one-line reason where they are missing.
 * work-item: 31.215
 */
const here = import.meta.dirname;
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-iotrace-unit-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const bin = path.join(work, "unit");
const src = path.resolve(here, "../native/filedeck-iotrace.c");
// (AddressSanitizer when the compiler has it, so a read past the end of a buffer fails the test; the helper's unused code paths are not part of this build)
const args = ["-O1", "-g", "-Wall", "-Wno-unused-function", `-DIOTRACE_SRC="${src}"`, "-o", bin, path.join(here, "iotrace-unit.c"), "-lbpf", "-lelf", "-lz"];
let cc = spawnSync("cc", ["-fsanitize=address", ...args], { encoding: "utf8" });
if (cc.status !== 0) cc = spawnSync("cc", args, { encoding: "utf8" });
const skip = cc.status !== 0 && !process.env.FILEDECK_REQUIRE_IOTRACE ? "iotrace unit: skipped (no C compiler or no libbpf here)" : false; // (the image build sets FILEDECK_REQUIRE_IOTRACE: there a build failure fails the test)

function run(...args: string[]): string {
  const r = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, LD_PRELOAD: "", ASAN_OPTIONS: "detect_leaks=0" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("iotrace output: rows are busiest first and the line is exactly the protocol", { skip }, () => {
  const out = run("sample");
  assert.equal(out.split("\n").length, 2, "one line and its newline");
  const line = assertIotraceLine(out.trimEnd());
  assert.equal(line.t, 1795800000000);
  // 400 requests (the flusher), then two with 100 (more bytes first), then 90 on the other disk
  assert.deepEqual(line.rows.map((r) => r.pid), [51, 1200, 3000, 1200]);
  assert.equal(line.rows[0]!.comm, "kworker/u8:3");
  assert.deepEqual(line.rows[1], { dev: "259:0", cg: 4821, pid: 1200, comm: "postgres", r: 10, w: 90, rb: 81920, wb: 737280 });
  assert.deepEqual(line.rows[2], { dev: "259:0", cg: 777, pid: 3000, comm: "tar", r: 90, w: 10, rb: 9000, wb: 100 });
  assert.equal(line.rows[3]!.dev, "8:16");
});

test("iotrace output: at most 512 rows, the busiest ones", { skip }, () => {
  const line = assertIotraceLine(run("many").trimEnd());
  assert.equal(line.rows.length, 512);
  assert.equal(line.rows[0]!.r, 900);
  assert.equal(line.rows[511]!.r, 900 - 511);
});

test("iotrace output: an interval without requests has an empty list", { skip }, () => {
  const line = assertIotraceLine(run("empty").trimEnd());
  assert.deepEqual(line.rows, []);
});

test("iotrace output: a task name is valid JSON whatever its bytes", { skip }, () => {
  const out = run("escape");
  const line = assertIotraceLine(out.trimEnd());
  assert.equal(line.rows[0]!.comm, 'a"b\\c\td\u0001\u007f??');
});

test("iotrace failure line: ok false with a message", { skip }, () => {
  const o = JSON.parse(run("error"));
  assert.deepEqual(o, { ok: false, error: 'not permitted: needs "CAP_BPF"' });
});

test("iotrace privileges: CAP_SYS_ADMIN, or CAP_BPF with CAP_PERFMON", { skip }, () => {
  const bit = (n: number) => (1n << BigInt(n)).toString(16);
  assert.equal(run("caps", bit(21)).trim(), "1");
  assert.equal(run("caps", (BigInt(`0x${bit(38)}`) | BigInt(`0x${bit(39)}`)).toString(16)).trim(), "1");
  assert.equal(run("caps", bit(39)).trim(), "0");
  assert.equal(run("caps", bit(38)).trim(), "0");
  assert.equal(run("caps", "0").trim(), "0");
});

test("iotrace recorded lines follow the protocol", () => {
  const lines = fs.readFileSync(path.join(here, "iotrace-recorded.ndjson"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(assertIotraceLine(lines[0]!).rows.length, 3);
  assert.deepEqual(assertIotraceLine(lines[1]!).rows, []);
});
