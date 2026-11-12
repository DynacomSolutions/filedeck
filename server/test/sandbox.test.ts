import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EXIT_LANDLOCK_UNSUPPORTED, resetSandbox, sandboxInfo, spawnSandboxed, type SandboxOpts } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: `spawnSandboxed` confines a child to the listed folders (Landlock, through the native launcher). The tests
 * run children that try to read outside a read-only root through a link, through a link swapped in after they started,
 * and through a name that was renamed after the rule was attached to a directory descriptor. They print the mode that ran.
 */
let tmp: string, box: Awaited<ReturnType<typeof useSandbox>>;
const write = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
}
async function run(cmd: string, args: string[], opts: SandboxOpts = {}, during?: () => void | Promise<void>): Promise<Out> {
  const child = await spawnSandboxed(cmd, args, opts);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const done = new Promise<Out>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  await during?.();
  return done;
}
const live = (name: string, fn: (t: import("node:test").TestContext) => Promise<void> | void) =>
  test(name, async (t) => {
    if (box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    await fn(t);
  });

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sandbox-")));
  fs.chmodSync(tmp, 0o755);
  box = await useSandbox();
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(box.dir, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
});

live("a read-only root: files beneath it are read, a link that leads outside is denied, nothing can be written", async () => {
  const ro = path.join(tmp, "ro1");
  const outside = path.join(tmp, "outside1");
  write(path.join(ro, "in.txt"), "inside\n");
  write(path.join(outside, "secret.txt"), "outside\n");
  fs.symlinkSync("in.txt", path.join(ro, "inlink"));
  fs.symlinkSync(outside, path.join(ro, "outlink"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ro, "filelink"));
  // control: without the sandbox the link reads the outside file
  assert.equal(fs.readFileSync(path.join(ro, "outlink/secret.txt"), "utf8"), "outside\n");
  const cat = (p: string) => run("cat", [p], { readOnly: [ro] });
  assert.deepEqual(await cat(path.join(ro, "in.txt")).then((r) => [r.code, r.stdout]), [0, "inside\n"]);
  assert.deepEqual(await cat(path.join(ro, "inlink")).then((r) => [r.code, r.stdout]), [0, "inside\n"]);
  for (const p of ["outlink/secret.txt", "filelink"]) {
    const r = await cat(path.join(ro, p));
    assert.notEqual(r.code, 0, p);
    assert.match(r.stderr, /Permission denied/, p);
    assert.equal(r.stdout, "");
  }
  assert.notEqual((await cat(path.join(outside, "secret.txt"))).code, 0, "a path outside the root, not through a link");
  const w = await run("sh", ["-c", `echo x > ${ro}/new.txt; rm ${ro}/in.txt; mkdir ${ro}/d`], { readOnly: [ro] });
  assert.match(w.stderr, /Permission denied/);
  assert.deepEqual(fs.readdirSync(ro).sort(), ["filelink", "in.txt", "inlink", "outlink"]);
});

live("a link swapped in after the child started gains nothing", async () => {
  const ro = path.join(tmp, "ro2");
  const outside = path.join(tmp, "outside2");
  write(path.join(ro, "in.txt"), "inside\n");
  write(path.join(outside, "secret.txt"), "outside\n");
  fs.symlinkSync("in.txt", path.join(ro, "swap"));
  const go = path.join(ro, "go");
  const script = `while [ ! -e ${go} ]; do sleep 0.05; done; cat ${ro}/swap`;
  const r = await run("sh", ["-c", script], { readOnly: [ro] }, () => {
    fs.rmSync(path.join(ro, "swap"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ro, "swap")); // after the child started
    fs.writeFileSync(go, "");
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Permission denied/);
  assert.equal(r.stdout, "");
});

live("a rule given as a directory descriptor follows the directory, not its name", async () => {
  const a = path.join(tmp, "dirA");
  const b = path.join(tmp, "dirB");
  write(path.join(a, "s.txt"), "original\n");
  const fh = await fs.promises.open(a, "r"); // pinned
  try {
    const script = `while [ ! -e ${b}/go ]; do sleep 0.05; done; echo "renamed: $(cat ${b}/s.txt 2>&1)"; echo "oldname: $(cat ${a}/s.txt 2>&1)"`;
    const r = await run("sh", ["-c", script], { readOnly: [fh.fd] }, () => {
      fs.renameSync(a, b); // the pinned directory moves
      write(path.join(a, "s.txt"), "impostor\n"); // something else takes the old name
      fs.writeFileSync(path.join(b, "go"), "");
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /renamed: original/, "the rule follows the directory to its new name");
    assert.match(r.stdout, /oldname: .*Permission denied/, "the old name now leads to a different directory: not allowed");
    assert.ok(!r.stdout.includes("impostor"));
  } finally {
    await fh.close();
  }
});

live("read-write and read-execute roots", async () => {
  const rw = path.join(tmp, "rw");
  const rx = path.join(tmp, "rx");
  const ro = path.join(tmp, "ro3");
  write(path.join(rx, "tool.sh"), "#!/bin/sh\necho ran\n");
  fs.chmodSync(path.join(rx, "tool.sh"), 0o755);
  write(path.join(ro, "tool.sh"), "#!/bin/sh\necho ran\n");
  fs.chmodSync(path.join(ro, "tool.sh"), 0o755);
  fs.mkdirSync(rw);
  const w = await run("sh", ["-c", `echo data > ${rw}/a.txt && mv ${rw}/a.txt ${rw}/b.txt && mkdir ${rw}/d && rm -r ${rw}/d && cat ${rw}/b.txt`], { readWrite: [rw] });
  assert.deepEqual([w.code, w.stdout], [0, "data\n"], w.stderr);
  assert.equal((await run(path.join(rx, "tool.sh"), [], { readExec: [rx] })).stdout, "ran\n");
  const denied = await run(path.join(ro, "tool.sh"), [], { readOnly: [ro] });
  assert.notEqual(denied.code, 0, "a read-only root cannot be executed from");
  const noWrite = await run("sh", ["-c", `echo x > ${rx}/n.txt`], { readExec: [rx] });
  assert.match(noWrite.stderr, /Permission denied/);
});

test("the launcher's 'unsupported' status: at probe time the fallback is chosen and the program still runs; 'require' and 'off' behave as documented", async () => {
  const fake = path.join(tmp, "fake-sandbox.sh");
  const prevHelper = process.env.FILEDECK_SANDBOX_HELPER;
  try {
    write(fake, `#!/bin/sh\nexit ${EXIT_LANDLOCK_UNSUPPORTED}\n`);
    fs.chmodSync(fake, 0o755);
    process.env.FILEDECK_SANDBOX_HELPER = fake;
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "fallback");
    const r = await run("echo", ["hi"], { readOnly: [tmp] });
    assert.deepEqual([r.code, r.stdout], [0, "hi\n"], "auto: the program runs, unconfined; the caller checks its input");
    process.env.FILEDECK_SANDBOX = "require";
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "unavailable");
    await assert.rejects(spawnSandboxed("echo", ["hi"], { readOnly: [tmp] }), (e: Error & { status?: number }) => e.status === 503 && /sandbox/.test(e.message));
    process.env.FILEDECK_SANDBOX = "off";
    resetSandbox();
    assert.equal((await sandboxInfo()).state, "off");
    assert.equal((await run("echo", ["hi"])).stdout, "hi\n");
  } finally {
    delete process.env.FILEDECK_SANDBOX;
    if (prevHelper === undefined) delete process.env.FILEDECK_SANDBOX_HELPER;
    else process.env.FILEDECK_SANDBOX_HELPER = prevHelper;
    resetSandbox();
  }
  console.log(`# sandbox: the run used ${(await sandboxInfo()).state}`);
});

test("as root the program runs as the given uid and gid with no supplementary groups", async (t) => {
  if (process.getuid?.() !== 0) return t.skip("sandbox live: skipped (not running as root)");
  fs.chmodSync(tmp, 0o755);
  const r = await run("sh", ["-c", "id -u; id -g; id -G"], { readOnly: [tmp], uid: 65534, gid: 65534 });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["65534", "65534", "65534"]);
});

const rights = () => {
  const m = /fs (0x[0-9a-f]+) net (0x[0-9a-f]+) scope (0x[0-9a-f]+)/.exec(execFileSync(box.bin, ["--probe"], { encoding: "utf8" }));
  return { fs: BigInt(m![1]!), net: BigInt(m![2]!), scope: BigInt(m![3]!) };
};

live("a confined program cannot connect over TCP, reach an abstract unix socket or signal a process outside (where the kernel's ABI has those rights)", async () => {
  const r = rights();
  console.log(`# sandbox rights handled: fs 0x${r.fs.toString(16)} net 0x${r.net.toString(16)} scope 0x${r.scope.toString(16)}`);
  const tcp = net.createServer((c) => c.destroy());
  await new Promise<void>((res) => tcp.listen(0, "127.0.0.1", res));
  const abs = "filedeck-sandbox-test-" + process.pid;
  const unix = net.createServer((c) => c.destroy());
  await new Promise<void>((res) => unix.listen("\0" + abs, res));
  const script = `
    const net = require("net"); const out = {};
    const s = net.connect(${(tcp.address() as net.AddressInfo).port}, "127.0.0.1");
    s.on("error", (e) => { out.tcp = e.code; step2(); });
    s.on("connect", () => { out.tcp = "connected"; s.destroy(); step2(); });
    function step2() { const u = net.connect("\\0${abs}"); u.on("error", (e) => { out.abs = e.code; step3(); }); u.on("connect", () => { out.abs = "connected"; u.destroy(); step3(); }); }
    function step3() { try { process.kill(${process.pid}, 0); out.sig = "allowed"; } catch (e) { out.sig = e.code; } console.log(JSON.stringify(out)); }`;
  try {
    const prefix = path.dirname(path.dirname(process.execPath));
    const res = await run(process.execPath, ["-e", script], { readExec: [prefix], env: { ...process.env, OPENSSL_CONF: "/dev/null" } });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split("\n").at(-1)!) as { tcp: string; abs: string; sig: string };
    if (r.net & 2n) assert.equal(out.tcp, "EACCES", "TCP connect");
    if (r.scope & 1n) assert.match(out.abs, /^(EPERM|EACCES)$/, "abstract unix socket outside the sandbox");
    if (r.scope & 2n) assert.equal(out.sig, "EPERM", "signal to a process outside the sandbox");
    const control = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const free = JSON.parse(control.stdout.trim().split("\n").at(-1)!) as { tcp: string; abs: string; sig: string };
    assert.deepEqual([free.tcp, free.abs, free.sig], ["connected", "connected", "allowed"], "control: without the sandbox all three work");
  } finally {
    tcp.close();
    unix.close();
  }
});

live("descriptors above the standard three do not reach the program", async () => {
  const f = path.join(tmp, "secret-fd.txt");
  write(f, "secret\n");
  const fh = await fs.promises.open(f, "r");
  try {
    const script = "if [ -e /dev/fd/3 ]; then echo open; else echo closed; fi";
    const r = await run("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe", fh.fd] });
    assert.equal(r.stdout.trim(), "closed");
    const control = spawnSync("sh", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fh.fd] });
    assert.equal(control.stdout.trim(), "open", "control: a plain child inherits it");
  } finally {
    await fh.close();
  }
});

test("--uid and --gid must be whole non-negative numbers, and 0 is refused unless it is explicitly allowed", async () => {
  const st = (...a: string[]) => spawnSync(box.bin, [...a, "--", "true"], { encoding: "utf8" }).status;
  for (const bad of [["--uid", "x", "--gid", "1"], ["--uid", "1x", "--gid", "1"], ["--uid", "-1", "--gid", "1"], ["--uid", "", "--gid", "1"], ["--uid", "99999999999", "--gid", "1"], ["--uid", "1", "--gid", "y"], ["--uid", "0", "--gid", "0"], ["--uid", "5", "--gid", "0"], ["--uid", "5"]]) {
    assert.equal(st(...bad), 64, bad.join(" "));
  }
  if (process.getuid?.() !== 0) await assert.rejects(spawnSandboxed("true", [], { uid: 0, gid: 0 }), /root/); // (as root, uid 0 is simply no change)
});

live("every descriptor above 2 is closed on exec, also above 1024", async () => {
  const f = path.join(tmp, "secret-fd-high.txt");
  write(f, "secret\n");
  const fh = await fs.promises.open(f, "r");
  try {
    const hi = 1100;
    const stdio: unknown[] = ["ignore", "pipe", "pipe"];
    while (stdio.length < hi) stdio.push("ignore");
    stdio.push(fh.fd);
    const script = `if [ -e /dev/fd/${hi} ]; then echo open; else echo closed; fi`;
    const r = await run("sh", ["-c", script], { stdio: stdio as never });
    assert.equal(r.stdout.trim(), "closed", r.stderr);
    const control = spawnSync("sh", ["-c", script], { encoding: "utf8", stdio: stdio as never });
    assert.equal(control.stdout.trim(), "open", "control: a plain child inherits it");
  } finally {
    await fh.close();
  }
});

live("a failure while probing the rights stops the launcher (exit 71) instead of leaving a right unrestricted", async () => {
  // with four descriptors allowed and one in use, creating the probe ruleset fails with EMFILE: not "right not offered"
  if (!box.staticBin) return; // only without a static libc (a dynamic launcher cannot even load with so few descriptors); the CI run requires the static build
  const r = spawnSync("sh", ["-c", `exec 3</dev/null; ulimit -n 4; exec ${box.staticBin} -- echo ran`], { encoding: "utf8" });
  assert.equal(r.status, 71, r.stderr);
  assert.equal(r.stdout, "", "the program must not have run");
  assert.match(r.stderr, /probing the rights/);
});

live("sockets: UDP and pathname unix sockets are refused by the seccomp layer on every kernel, unless allowSockets is set", async () => {
  const r = rights();
  const script = `
    const dgram = require("dgram"); const out = {};
    try { const s = dgram.createSocket("udp4"); s.on("error", (e) => { out.udp = e.code; fin(); }); s.bind(0, "127.0.0.1", () => { out.udp = "bound"; s.close(); fin(); }); } catch (e) { out.udp = e.code; fin(); }
    function fin() { console.log(JSON.stringify(out)); }`;
  const prefix = path.dirname(path.dirname(process.execPath));
  const env = { ...process.env, OPENSSL_CONF: "/dev/null" };
  const udp = async (opts: SandboxOpts) => JSON.parse((await run(process.execPath, ["-e", script], { readExec: [prefix], env, ...opts })).stdout.trim().split("\n").at(-1)!) as { udp: string };
  const free = JSON.parse(spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }).stdout.trim().split("\n").at(-1)!) as { udp: string };
  assert.equal(free.udp, "bound", "control: without the sandbox UDP works");
  const info = await sandboxInfo();
  console.log(`# sandbox sockets: kernel Landlock handles UDP rights: ${(r.net & 12n) === 12n}; socket filter (seccomp) on: ${info.seccomp}`);
  if (!info.seccomp) {
    // no filter on this kernel or architecture: reported, and UDP then relies on Landlock alone
    assert.equal((await udp({})).udp, (r.net & 12n) === 12n ? "EACCES" : "bound");
    return;
  }
  assert.equal((await udp({})).udp, "EACCES");
  assert.equal((await udp({ allowSockets: true })).udp, (r.net & 12n) === 12n ? "EACCES" : "bound", "allowSockets lifts the extra layer only");
  // a pathname unix socket under a served folder: connecting is refused, whatever the kernel's Landlock offers
  const sock = path.join(tmp, "unix-ok.sock");
  const srv = (await import("node:net")).createServer((c) => c.end("hi"));
  await new Promise<void>((res) => srv.listen(sock, res));
  try {
    const un = `require("net").connect(${JSON.stringify(sock)}).on("data", (d) => console.log(String(d))).on("error", (e) => console.log("ERR " + e.code));`;
    const denied = await run(process.execPath, ["-e", un], { readExec: [prefix], readWrite: [tmp], env });
    assert.match(denied.stdout, /ERR (EACCES|EPERM)/, `connect must be refused: ${denied.stdout}`);
    const allowed = await run(process.execPath, ["-e", un], { readExec: [prefix], readWrite: [tmp], env, allowSockets: true });
    assert.ok(allowed.stdout.includes("hi") || /ERR (EACCES|EPERM)/.test(allowed.stdout), allowed.stdout); // the kernel's own pathname-socket rule may still refuse it
  } finally {
    srv.close();
  }
});

live("an x32 system call number does not get round the socket filter (x86-64 only; skipped where the kernel has x32 disabled)", async (t) => {
  if (process.arch !== "x64") return t.skip("sandbox live: skipped (x32 calls exist on x86-64 only)");
  const info = await sandboxInfo();
  if (!info.seccomp) return t.skip("sandbox live: skipped (no socket filter on this kernel)");
  const src = path.join(tmp, "x32.c");
  write(src, `#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/socket.h>
int main(void) {
  long fd = syscall(0x40000000 | 41, AF_INET, SOCK_DGRAM, 0); /* x32 socket() */
  if (fd < 0) { printf("x32 socket: %s\\n", strerror(errno)); return 1; }
  printf("x32 socket opened: %ld\\n", fd);
  return 0;
}
`);
  const bin = path.join(tmp, "x32bin");
  const cc = spawnSync("cc", ["-O2", "-o", bin, src], { encoding: "utf8" });
  if (cc.status !== 0) return t.skip(`sandbox live: skipped (cannot build the x32 probe: ${cc.stderr.trim().split("\n")[0]})`);
  const free = spawnSync(bin, [], { encoding: "utf8" });
  if (!/opened/.test(free.stdout)) {
    console.log(`# sandbox x32: this kernel has x32 calls disabled (${free.stdout.trim()}): the x32 socket() branch is skipped here; the number probe below still covers the filter`);
    return t.skip(`sandbox live: skipped (this kernel has x32 calls disabled: ${free.stdout.trim()})`);
  }
  console.log("# sandbox x32: the x32 socket() call was made inside the sandbox and the process was killed (this kernel accepts x32 calls)");
  const r = await run(bin, [], { readExec: [tmp] });
  assert.ok(!/opened/.test(r.stdout), `an x32 socket() was opened inside the sandbox: ${r.stdout}`);
  assert.ok(r.code !== 0, "the x32 call must end the process or fail");
});

live("any x32-numbered system call is killed by the filter, whether or not the kernel implements x32 (seccomp sees the number first)", async (t) => {
  if (process.arch !== "x64") return t.skip("sandbox live: skipped (x32 calls exist on x86-64 only)");
  const info = await sandboxInfo();
  if (!info.seccomp) return t.skip("sandbox live: skipped (no socket filter on this kernel)");
  const src = path.join(tmp, "x32num.c");
  write(src, `#define _GNU_SOURCE
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>
int main(void) {
  long r = syscall(0x40000000 | SYS_getpid); /* an x32-numbered getpid */
  printf("returned %ld\\n", r);
  return 0;
}
`);
  const bin = path.join(tmp, "x32numbin");
  const cc = spawnSync("cc", ["-O2", "-o", bin, src], { encoding: "utf8" });
  if (cc.status !== 0) return t.skip(`sandbox live: skipped (cannot build the x32 number probe: ${cc.stderr.trim().split("\n")[0]})`);
  const free = spawnSync(bin, [], { encoding: "utf8" });
  assert.equal(free.status, 0, "control: without the sandbox the call returns (a pid, or -1 where x32 is off)");
  const r = await run(bin, [], { readExec: [tmp] });
  console.log(`# sandbox x32 number probe: unconfined it ${free.stdout.trim()}; confined: ${r.code === null ? "killed" : "exit " + r.code}`);
  assert.ok(r.code !== 0 && !/returned/.test(r.stdout), `the x32-numbered call was not stopped: ${r.stdout}`);
});

live("git, bsdtar and name lookups still work with the socket filter (they use only the descriptors they were given)", async () => {
  const r1 = await run("id", ["-un"], { readOnly: [tmp] });
  assert.equal(r1.code, 0, r1.stderr);
  const r2 = await run("ls", ["-ln", tmp], { readOnly: [tmp] });
  assert.equal(r2.code, 0, r2.stderr);
  if (spawnSync("bsdtar", ["--version"]).status === 0) {
    const d = path.join(tmp, "tarsrc");
    write(path.join(d, "a.txt"), "tar me\n");
    const out = path.join(tmp, "out.tar");
    const c = await run("bsdtar", ["-cf", out, "-C", d, "a.txt"], { readOnly: [d], readWrite: [tmp] });
    assert.equal(c.code, 0, c.stderr);
    const l = await run("bsdtar", ["-tf", out], { readOnly: [tmp] });
    assert.equal(l.stdout.trim(), "a.txt", l.stderr);
  } else console.log("# sandbox: bsdtar not installed here, its check is skipped");
  const z = ["7zz", "7z"].find((x) => spawnSync(x, ["--help"]).status === 0);
  if (z) {
    const d = path.join(tmp, "zsrc");
    write(path.join(d, "a.txt"), "zip me\n");
    const out = path.join(tmp, "out.7z");
    const c = await run(z, ["a", "-snl", out, path.join(d, "a.txt")], { readOnly: [d], readWrite: [tmp] });
    assert.equal(c.code, 0, c.stdout + c.stderr);
  } else console.log("# sandbox: 7-Zip not installed here, its check is skipped (CI runs it)");
});

test("the sandbox state is reported: --probe says whether the socket filter is available, sandboxInfo carries it", async () => {
  const out = execFileSync(box.bin, ["--probe"], { encoding: "utf8" });
  assert.match(out, /landlock abi \d+ fs 0x[0-9a-f]+ net 0x[0-9a-f]+ scope 0x[0-9a-f]+ seccomp [01]/);
  const info = await sandboxInfo();
  if (info.landlock) {
    assert.equal(info.seccomp, / seccomp 1/.test(out));
    assert.ok(info.abi >= 1 && info.rights);
  }
  const { sandboxLine, sandboxSummary } = await import("../src/sandbox.ts");
  assert.match(sandboxLine(info), /sandbox: mode \w+, state \w+, archive tools and git (confined|unconfined|disabled), landlock .*socket filter (on|off)/);
  const sum = await sandboxSummary();
  assert.deepEqual(Object.keys(sum).sort(), ["archiveTools", "landlockAbi", "mode", "socketFilter", "state"]);
});

/* ---- working folder by descriptor, the privilege drop in every mode, the root limit, launcher failures ---- */

live("a working folder given by descriptor is exact even when its number collides with a slot the launcher's grants take", async () => {
  const base = path.join(tmp, "cwdfd");
  const grantDirs: string[] = [];
  for (let i = 0; i < 20; i++) {
    write(path.join(base, `g${i}`, "id"), `grant-${i}\n`);
    grantDirs.push(path.join(base, `g${i}`));
  }
  write(path.join(base, "pinned", "id"), "pinned\n");
  const pinned = fs.openSync(path.join(base, "pinned"), "r"); // opened first: a low descriptor number
  const grants = grantDirs.map((d) => fs.openSync(d, "r"));
  try {
    assert.ok(pinned < 3 + grants.length, `descriptor ${pinned} must fall among the ${grants.length} grant slots for this test to mean anything`);
    const got = await run("cat", ["id"], { readOnly: [...grants, pinned], cwdFd: pinned });
    assert.equal(got.stdout, "pinned\n", got.stderr);
    // the old way, a /proc/self/fd path as the working folder, lands in another folder: that is the bug this option removes
    const old = await run("cat", ["id"], { readOnly: [...grants, pinned], cwd: `/proc/self/fd/${pinned}` });
    assert.notEqual(old.stdout, "pinned\n");
  } finally {
    for (const f of [...grants, pinned]) fs.closeSync(f);
  }
});

live("a launcher failure is told apart from the program's own failure; too many roots is a clear error", async () => {
  const { isLauncherFailure, MAX_ROOTS } = await import("../src/sandbox.ts");
  const f = path.join(tmp, "plainfile");
  write(f, "x");
  const fd = fs.openSync(f, "r");
  try {
    const r = await run("true", [], { cwdFd: fd }); // fchdir to a file fails: the launcher says so and the program does not run
    assert.ok(isLauncherFailure(r.code, r.stderr), `${r.code} ${r.stderr}`);
    const own = await run("sh", ["-c", "echo filedeck-sandbox: fake >&2; exit 71"]);
    assert.ok(isLauncherFailure(own.code, own.stderr), "the check is on the status and the launcher's prefix; a program printing both is indistinguishable, so callers use it only for tools that never do");
    assert.equal(isLauncherFailure(1, "tar: error"), false);
  } finally {
    fs.closeSync(fd);
  }
  const many = Array.from({ length: MAX_ROOTS + 1 }, () => f);
  await assert.rejects(spawnSandboxed("true", [], { readOnly: many }), (e: { status?: number; message?: string }) => e.status === 500 && /limit is/.test(e.message ?? ""));
  // a few hundred descriptor roots work (a split set of 200 parts, a selection of 300 files)
  const fds = Array.from({ length: 300 }, () => fs.openSync(f, "r"));
  try {
    const ok = await run("cat", [f], { readOnly: fds });
    assert.equal(ok.stdout, "x", ok.stderr);
  } finally {
    for (const x of fds) fs.closeSync(x);
  }
});

/** the child's uid, gid and supplementary groups, in each of the three modes (root only: an agent that is not root changes nothing) */
for (const mode of ["landlock", "fallback", "off"] as const) {
  test(`the privilege drop does not depend on the sandbox mode: ${mode}`, { skip: process.getuid?.() === 0 ? false : "sandbox live: skipped (not running as root)" }, async (t) => {
    if (mode === "landlock" && box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    const prev = [process.env.FILEDECK_SANDBOX, process.env.FILEDECK_SANDBOX_HELPER];
    try {
      if (mode === "off") process.env.FILEDECK_SANDBOX = "off";
      else if (mode === "fallback") {
        process.env.FILEDECK_SANDBOX = "auto";
        process.env.FILEDECK_SANDBOX_HELPER = path.join(tmp, "no-such-launcher"); // no launcher at all: spawn's own uid and gid
      } else process.env.FILEDECK_SANDBOX = "auto";
      resetSandbox();
      const state = (await sandboxInfo()).state;
      assert.equal(state, mode);
      const r = await run("sh", ["-c", "id -u; id -g; id -G"], { uid: 65534, gid: 65534 }); // /proc is not readable inside Landlock
      const [u, g, groups] = r.stdout.split("\n");
      assert.equal(u, "65534", r.stderr);
      assert.equal(g, "65534");
      assert.equal(groups, "65534", `the supplementary groups are cleared in ${mode} mode (with no launcher it is Node's own spawn that does it: libuv calls setgroups(0) when a gid is given)`);
    } finally {
      for (const [i, k] of ["FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"].entries()) {
        if (prev[i] === undefined) delete process.env[k];
        else process.env[k] = prev[i];
      }
      resetSandbox();
    }
  });
}

test("the start-up log says clearly when the helper programs are not confined (off, fallback) and when they are required", async () => {
  const { initSandbox } = await import("../src/sandbox.ts");
  const prev = [process.env.FILEDECK_SANDBOX, process.env.FILEDECK_SANDBOX_HELPER];
  const lines = async (mode: string, helper?: string) => {
    process.env.FILEDECK_SANDBOX = mode;
    if (helper) process.env.FILEDECK_SANDBOX_HELPER = helper;
    resetSandbox();
    const out: string[] = [];
    await initSandbox((m) => out.push(m));
    return out;
  };
  try {
    const off = await lines("off");
    assert.equal(off.length, 2);
    assert.match(off[0]!, /state off, archive tools and git unconfined/);
    assert.match(off[1]!, /bsdtar and 7zz run with no kernel confinement/);
    const fb = await lines("auto", path.join(tmp, "no-such-launcher"));
    assert.match(fb[0]!, /state fallback, archive tools and git unconfined/);
    assert.match(fb[1]!, /bsdtar and 7zz run without kernel confinement/);
    const req = await lines("require", path.join(tmp, "no-such-launcher"));
    assert.match(req[0]!, /archive tools and git disabled/);
    assert.match(req[1]!, /answer an error/);
  } finally {
    for (const [i, k] of ["FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"].entries()) {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    }
    resetSandbox();
  }
});

/* ---- a descriptor kept open for the program: readable in the child, every other descriptor above 2 closed, in each mode ---- */

for (const mode of ["landlock", "fallback", "off"] as const) {
  test(`keepFds: the archive descriptor is readable in the child and every other descriptor above 2 is closed: ${mode}`, async (t) => {
    if (mode === "landlock" && box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    const prev = [process.env.FILEDECK_SANDBOX, process.env.FILEDECK_SANDBOX_HELPER];
    const kept = path.join(tmp, `kept-${mode}`);
    const other = path.join(tmp, `other-${mode}`);
    write(kept, "KEPT-CONTENT");
    write(other, "OTHER-CONTENT");
    const keptFd = fs.openSync(kept, "r");
    const otherFd = fs.openSync(other, "r");
    try {
      if (mode === "off") process.env.FILEDECK_SANDBOX = "off";
      else if (mode === "fallback") {
        process.env.FILEDECK_SANDBOX = "auto";
        process.env.FILEDECK_SANDBOX_HELPER = path.join(tmp, "no-such-launcher");
      } else process.env.FILEDECK_SANDBOX = "auto";
      resetSandbox();
      assert.equal((await sandboxInfo()).state, mode);
      // descriptor 3 is the kept one; the other descriptor is handed over as a Landlock root (descriptor 4 in the child) and must not stay open
      const r = await run("sh", ["-c", "cat <&3; echo; cat <&4 2>&1; cat <&5 2>&1; exit 0"], { keepFds: [keptFd], readOnly: [otherFd] });
      const [first, ...rest] = r.stdout.split("\n");
      assert.equal(first, "KEPT-CONTENT", r.stderr);
      assert.ok(!r.stdout.includes("OTHER-CONTENT"), "no other descriptor may reach the program");
      assert.match(r.stderr + rest.join("\n"), /Bad file descriptor|not open|bad fd/i);
      // and through a user change too (root only): the descriptor is still the program's
      if (process.getuid?.() === 0) {
        fs.chmodSync(tmp, 0o755);
        const again = fs.openSync(kept, "r"); // a fresh open: the first run read the shared one to its end
        try {
          const u = await run("sh", ["-c", "cat <&3"], { keepFds: [again], uid: 65534, gid: 65534 });
          assert.equal(u.stdout, "KEPT-CONTENT", u.stderr);
        } finally {
          fs.closeSync(again);
        }
      }
    } finally {
      for (const [i, k] of ["FILEDECK_SANDBOX", "FILEDECK_SANDBOX_HELPER"].entries()) {
        if (prev[i] === undefined) delete process.env[k];
        else process.env[k] = prev[i];
      }
      resetSandbox();
      fs.closeSync(keptFd);
      fs.closeSync(otherFd);
    }
  });
}
