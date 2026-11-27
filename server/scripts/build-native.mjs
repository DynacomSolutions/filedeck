// Builds the native helpers in server/native into server/dist/native (or the folder given as the first argument), so a
// development start finds them beside the compiled code (see `locateHelper` in src/native.ts). The image builds the same
// sources itself, statically, into /usr/local/bin (Dockerfile).
//
// Each helper is linked statically where the toolchain allows it, and dynamically otherwise (many glibc machines have no
// static libc). With no C compiler, or on a system other than Linux (the helpers use Linux calls), it prints one line and
// succeeds: the agent then reports the sandbox as "fallback". A helper that does not compile is an error.
// FILEDECK_CC names the compiler (default: cc, then gcc); the test sets it to a missing program.
//
// The host helpers in server/native/host (filedeck-id, filedeck-pam) run inside the machine's own root against its glibc (src/host-helpers.ts),
// so they are built dynamically into <out>/host, and only with a glibc toolchain (`cc -dumpmachine` ends in -gnu, -gnueabihf, ...). The image
// builds them against an old glibc instead (Dockerfile, stage hostbuild).
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
  const libraries = name === "filedeck-disk-verify" ? ["-lblkid", "-lcrypto"] : [];
  const attempt = (extra) => spawnSync(cc, ["-O2", "-Wall", ...extra, "-o", out, path.join(srcDir, file), ...libraries], { encoding: "utf8" });
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

const hostSrc = path.join(srcDir, "host");
const hostFiles = fs.existsSync(hostSrc) ? fs.readdirSync(hostSrc).filter((f) => f.endsWith(".c")).sort() : [];
const machine = spawnSync(cc, ["-dumpmachine"], { encoding: "utf8" }).stdout?.trim() ?? "";
if (hostFiles.length && !/-gnu[a-z0-9]*$/.test(machine)) {
  console.log("host helpers: skipped (not a glibc toolchain)");
} else if (hostFiles.length) {
  const hostOut = path.join(outDir, "host");
  fs.mkdirSync(hostOut, { recursive: true });
  const skipped = [];
  for (const file of hostFiles) {
    const name = file.slice(0, -2);
    // (filedeck-pam loads the machine's libpam with dlopen: libdl before glibc 2.34, part of libc after; --as-needed keeps it off the others)
    const r = spawnSync(cc, ["-O2", "-Wall", "-o", path.join(hostOut, name), path.join(hostSrc, file), "-Wl,--as-needed", "-ldl"], { encoding: "utf8" });
    if (r.status !== 0 && /security\/pam_appl\.h/.test(r.stderr) && !process.env.FILEDECK_REQUIRE_HOST_HELPERS) {
      console.log(`host helpers: ${name} skipped (no PAM headers here: install libpam0g-dev or pam-devel)`);
      skipped.push(name);
      continue;
    }
    if (r.status !== 0) {
      console.error(`host helpers: ${name} did not compile:\n${r.stderr}`);
      process.exit(1);
    }
  }
  console.log(`host helpers: built ${hostFiles.map((f) => f.slice(0, -2)).filter((n) => !skipped.includes(n)).join(", ")} in ${hostOut}`);
}
