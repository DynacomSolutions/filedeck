import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { assertIotraceFailure, assertIotraceLine } from "./iotrace-protocol.ts";

/**
 * The built filedeck-iotrace program (BPF program embedded). Built here with scripts/build-native.mjs; skipped with a reason where there is no clang or libbpf.
 * Where the process is not allowed to load BPF (the normal case in CI and for a developer), it must say so in one JSON line and exit with status 3.
 * Where it is allowed, it must print a line per interval and end on SIGTERM. work-item: 31.215
 */
const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-iotrace-build-")));
after(() => fs.rmSync(out, { recursive: true, force: true }));
const build = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
const bin = path.join(out, "filedeck-iotrace");
const built = build.status === 0 && fs.existsSync(bin);
const skip = built || process.env.FILEDECK_REQUIRE_IOTRACE ? false : `iotrace helper: skipped (${/filedeck-iotrace skipped \(([^)]*)\)/.exec(build.stdout)?.[1] ?? "not built"})`;
// the helper's start is the only way to know whether this process may load BPF
const probe = built ? spawnSync(bin, ["--interval-ms", "100"], { encoding: "utf8", timeout: 400, killSignal: "SIGTERM" }) : undefined;
const allowed = probe !== undefined && probe.status !== 3;

test("iotrace helper: the build step makes the program and leaves nothing else behind", { skip }, () => {
  fs.accessSync(bin, fs.constants.X_OK);
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith(".")), [], "no build leftovers");
});

test("iotrace helper: a bad option is a usage error (status 1)", { skip }, () => {
  const r = spawnSync(bin, ["--interval-ms", "5"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(spawnSync(bin, ["--nope"], { encoding: "utf8" }).status, 1);
});

test("iotrace helper: without the privilege it prints one failure line and exits with 3", { skip: skip || (allowed ? "iotrace helper: skipped (this process may load BPF)" : false) }, () => {
  const r = probe!;
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trimEnd().split("\n").length, 1);
  assertIotraceFailure(r.stdout.trimEnd());
  assert.equal(r.stderr, "");
});

test("iotrace helper: with the privilege it prints one valid line per interval and ends on SIGTERM", { skip: skip || (allowed ? false : "iotrace helper: skipped (this process may not load BPF)") }, async () => {
  const child = spawn(bin, ["--interval-ms", "200"], { stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop()!;
    lines.push(...parts);
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (c, s) => r([c, s])));
  await new Promise((r) => setTimeout(r, 1000));
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
  assert.ok(lines.length >= 2, `lines: ${lines.length}`);
  for (const l of lines) assertIotraceLine(l);
});
