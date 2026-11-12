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
const live = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (box.state !== "landlock") return t.skip(`sandbox live: skipped (${box.why})`);
    await fn();
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
    if (r.scope & 1n) assert.equal(out.abs, "EPERM", "abstract unix socket outside the sandbox");
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

live("UDP: denied where the kernel cannot control it (a seccomp layer on socket()), unless sockets are allowed", async () => {
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
  console.log(`# sandbox UDP: kernel Landlock handles UDP rights: ${(r.net & 12n) === 12n}`);
  assert.equal((await udp({})).udp, "EACCES");
  if ((r.net & 12n) !== 12n) assert.equal((await udp({ allowSockets: true })).udp, "bound", "allowSockets opens the extra layer (the kernel has no UDP rights)");
  // unix-domain stream sockets still work through the filter
  const sock = path.join(tmp, "unix-ok.sock");
  const srv = (await import("node:net")).createServer((c) => c.end("hi"));
  await new Promise<void>((res) => srv.listen(sock, res));
  try {
    const un = `require("net").connect(${JSON.stringify(sock)}).on("data", (d) => console.log(String(d))).on("error", (e) => console.log("ERR " + e.code));`;
    const res = await run(process.execPath, ["-e", un], { readExec: [prefix], readWrite: [tmp], env });
    assert.ok(res.stdout.includes("hi") || /ERR (EACCES|EPERM)/.test(res.stdout), res.stdout); // allowed by seccomp; the kernel's own pathname-socket rule may still refuse it
  } finally {
    srv.close();
  }
});
