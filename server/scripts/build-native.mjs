// Builds the native helpers in server/native into server/dist/native (or the folder given as the first argument), so a
// development start finds them beside the compiled code (see `locateHelper` in src/sandbox.ts). The image builds the same
// sources itself, statically, into /usr/local/bin (Dockerfile).
//
// Each helper is linked statically where the toolchain allows it, and dynamically otherwise (many glibc machines have no
// static libc). With no C compiler, or on a system other than Linux (the helpers use Linux calls), it prints one line and
// succeeds: the agent then reports the sandbox as "fallback". A helper that does not compile is an error.
// FILEDECK_CC names the compiler (default: cc, then gcc); the test sets it to a missing program.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const srcDir = path.resolve(here, "../native");
const outDir = path.resolve(process.argv[2] ?? path.join(here, "../dist/native"));
const say = (s) => console.log(`native helpers: ${s}`);

if (process.platform !== "linux") {
  say(`skipped (${process.platform} is not Linux)`);
  process.exit(0);
}
const candidates = process.env.FILEDECK_CC ? [process.env.FILEDECK_CC] : ["cc", "gcc"];
const cc = candidates.find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
if (!cc) {
  say(`skipped (no C compiler found: ${candidates.join(", ")}); the sandbox will report "fallback" until the helpers are installed`);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const built = [];
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".c")).sort()) {
  const name = file.slice(0, -2);
  const out = path.join(outDir, name);
  const attempt = (extra) => spawnSync(cc, ["-O2", "-Wall", ...extra, "-o", out, path.join(srcDir, file)], { encoding: "utf8" });
  let how = "static";
  let r = attempt(["-static"]);
  if (r.status !== 0) {
    how = "dynamic";
    r = attempt([]);
  }
  if (r.status !== 0) {
    console.error(`native helpers: ${name} did not compile:\n${r.stderr}`);
    process.exit(1);
  }
  built.push(`${name} (${how})`);
}
say(`built ${built.join(", ")} in ${outDir}`);
