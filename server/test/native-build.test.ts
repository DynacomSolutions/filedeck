import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILT_NATIVE_DIR, locateHelper } from "../src/sandbox.ts";

/** work-item: a development start finds the helpers `npm run build` compiled, in a fixed order, and the build step never fails for lack of a compiler. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-native-"));
const exe = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 }), p);

test("helper location: the environment value wins, as given, with no fallback", async () => {
  const installed = exe(path.join(tmp, "a/bin/filedeck-sandbox"));
  exe(path.join(tmp, "a/built/filedeck-sandbox"));
  assert.equal(await locateHelper("filedeck-sandbox", "/no/such/launcher", installed, path.join(tmp, "a/built")), "/no/such/launcher");
});

test("helper location: the installed helper comes before the built one", async () => {
  const installed = exe(path.join(tmp, "b/bin/filedeck-sandbox"));
  exe(path.join(tmp, "b/built/filedeck-sandbox"));
  assert.equal(await locateHelper("filedeck-sandbox", undefined, installed, path.join(tmp, "b/built")), installed);
});

test("helper location: the built helper is used when the installed one is missing", async () => {
  const built = exe(path.join(tmp, "c/built/filedeck-sandbox"));
  assert.equal(await locateHelper("filedeck-sandbox", undefined, path.join(tmp, "c/bin/filedeck-sandbox"), path.join(tmp, "c/built")), built);
});

test("helper location: a built file that cannot be run is not used; with none the installed path is reported", async () => {
  const installed = path.join(tmp, "d/bin/filedeck-sandbox");
  fs.mkdirSync(path.join(tmp, "d/built"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "d/built/filedeck-sandbox"), "x", { mode: 0o644 });
  assert.equal(await locateHelper("filedeck-sandbox", undefined, installed, path.join(tmp, "d/built")), installed);
});

test("helper location: the built folder is server/dist/native, whether run from src or dist, and PATH is not searched", async () => {
  assert.equal(BUILT_NATIVE_DIR, path.resolve(import.meta.dirname, "../dist/native"));
  const bin = path.join(tmp, "e/pathbin");
  exe(path.join(bin, "filedeck-sandbox"));
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    assert.equal(await locateHelper("filedeck-sandbox", undefined, path.join(tmp, "e/none"), path.join(tmp, "e/none-built")), path.join(tmp, "e/none"));
  } finally {
    process.env.PATH = prev;
  }
});

test("build step without a compiler prints one line and succeeds", () => {
  const out = path.join(tmp, "nocc");
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8", env: { ...process.env, FILEDECK_CC: path.join(tmp, "no-such-compiler") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, /no C compiler found/);
  assert.equal(fs.existsSync(out), false);
});

test("build step with a compiler builds every helper", (t) => {
  if (spawnSync("cc", ["--version"], { stdio: "ignore" }).status !== 0) return t.skip("native build: skipped (no C compiler)");
  const out = path.join(tmp, "withcc");
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const n of ["filedeck-sandbox", "filedeck-fanwatch", "filedeck-rename"]) fs.accessSync(path.join(out, n), fs.constants.X_OK);
});
