// Builds the native helpers in server/native into server/dist/native (or the folder given as the first argument), so a
// development start finds them beside the compiled code (see `locateHelper` in src/native.ts). The image builds the same
// sources itself, statically, into /usr/local/bin (Dockerfile).
//
// Each helper is linked statically where the toolchain allows it, and dynamically otherwise (many glibc machines have no
// static libc). With no C compiler, or on a system other than Linux (the helpers use Linux calls), it prints one line and
// succeeds: the agent then reports the sandbox as "fallback". A helper that does not compile is an error.
// FILEDECK_CC names the compiler (default: cc, then gcc); the test sets it to a missing program.
//
// filedeck-iotrace and filedeck-holders (eBPF) are not built by the loop below: each needs clang for its BPF program (filedeck-<name>.bpf.c) and libbpf
// with libelf and zlib. Where they are missing it prints one line and goes on (set FILEDECK_REQUIRE_IOTRACE or FILEDECK_REQUIRE_HOLDERS to make that
// an error, as the image build does). FILEDECK_CLANG names the BPF compiler (default: clang).
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
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".c") && !/^filedeck-(?:iotrace|holders)[.]/.test(f)).sort()) {
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

// An eBPF helper: the BPF program with clang, then the loader (the program is embedded in it), static where libbpf's static libraries are there.
function buildBpfHelper({ name, requireVar, macro, without }) {
  const skip = (why) => {
    if (process.env[requireVar]) {
      console.error(`native helpers: ${name} did not build: ${why}`);
      process.exit(1);
    }
    console.log(`native helpers: ${name} skipped (${why}); ${without}`);
  };
  const bpfArch = { x64: "x86", arm64: "arm64" }[process.arch];
  if (!bpfArch) return skip(`no BPF target for ${process.arch}`);
  const clang = process.env.FILEDECK_CLANG ?? "clang";
  if (spawnSync(clang, ["--version"], { stdio: "ignore" }).status !== 0) return skip(`no clang found: ${clang}`);
  const work = fs.mkdtempSync(path.join(outDir, `.${name}-`));
  try {
    const obj = path.join(work, `${name}.bpf.o`);
    let r = spawnSync(clang, ["-O2", "-g", "-Wall", "-target", "bpf", `-D__TARGET_ARCH_${bpfArch}`, "-I", srcDir, "-c", path.join(srcDir, `${name}.bpf.c`), "-o", obj], { encoding: "utf8" });
    if (r.status !== 0) return skip(`the BPF program did not compile (libbpf headers missing?): ${r.stderr.trim().split("\n")[0]}`);
    const out = path.join(outDir, name);
    const link = (extra, libs) => spawnSync(cc, ["-O2", "-Wall", `-D${macro}="${obj}"`, ...extra, "-o", out, path.join(srcDir, `${name}.c`), ...libs], { encoding: "utf8" });
    let how = "static";
    r = link(["-static"], ["-lbpf", "-lelf", "-lz", "-lzstd"]);
    if (r.status !== 0) {
      how = "dynamic";
      r = link([], ["-lbpf", "-lelf", "-lz"]);
    }
    if (r.status !== 0) return skip(`libbpf is not available to link: ${r.stderr.trim().split("\n").pop()}`);
    console.log(`native helpers: built ${name} (${how}) in ${outDir}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
buildBpfHelper({ name: "filedeck-iotrace", requireVar: "FILEDECK_REQUIRE_IOTRACE", macro: "IOTRACE_BPF_OBJ", without: "the disk pressure collector then uses its proc fallback" });
buildBpfHelper({ name: "filedeck-holders", requireVar: "FILEDECK_REQUIRE_HOLDERS", macro: "HOLDERS_BPF_OBJ", without: "the holder table is then unavailable" });

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
