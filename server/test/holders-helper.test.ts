import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Holders, type HoldersAnswer } from "../src/holders.ts";

/**
 * The built filedeck-holders program (BPF program embedded). Built with scripts/build-native.mjs; skipped, with a reason, where there is no clang or libbpf
 * (the image build sets FILEDECK_REQUIRE_HOLDERS=1 and fails instead of skipping). Where this process may not load BPF (no CAP_BPF and CAP_PERFMON, or a pid
 * namespace of its own) the program must say so in one JSON line and exit with status 3, and the manager must report `unavailable`. Where it may (CI runs
 * this suite as root, with FILEDECK_REQUIRE_HOLDERS_LIVE=1: a skip is then a failure), the kernel side is checked end to end against processes that this test
 * starts: a working folder, a descriptor, an executable, a mapping, a process that forks, a descriptor that is closed, a process that ends.
 */
const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-holders-build-")));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-holders-work-")));
const children: ChildProcess[] = [];
/** every child and what it started: each child leads its own process group */
const killAll = () => {
  for (const c of children) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch {
      // gone already
    }
  }
};
after(() => {
  killAll();
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
const build = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
const bin = path.join(out, "filedeck-holders");
const built = build.status === 0 && fs.existsSync(bin);
const skip = built || process.env.FILEDECK_REQUIRE_HOLDERS ? false : `holders helper: skipped (${/filedeck-holders skipped \(([^)]*)\)/.exec(build.stdout)?.[1] ?? "not built"})`;

/** the first bytes of the program's output: a JSON line is a refusal, anything else is a record */
async function probe(): Promise<{ refused: boolean; line: string; status: number | null }> {
  const c = spawn(bin, ["--ring-mb", "1", "--ignore", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"] });
  const first = await new Promise<Buffer>((resolve) => {
    c.stdout.once("data", resolve);
    c.once("exit", () => resolve(Buffer.alloc(0)));
    setTimeout(() => resolve(Buffer.alloc(0)), 10_000).unref();
  });
  const refused = first[0] === 0x7b;
  const exited = new Promise<number | null>((r) => c.once("exit", (code) => r(code)));
  c.stdin.end();
  c.kill("SIGTERM");
  const status = await exited;
  return { refused, line: refused ? first.toString("utf8").split("\n")[0]! : "", status };
}
const probed = built ? await probe() : undefined;
const allowed = probed !== undefined && !probed.refused;
const liveSkip = skip || (allowed ? false : process.env.FILEDECK_REQUIRE_HOLDERS_LIVE ? false : "holders helper: skipped (this process may not load BPF)");

test("holders helper: the build step makes the program and leaves nothing else behind", { skip }, () => {
  fs.accessSync(bin, fs.constants.X_OK);
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith(".")), [], "no build leftovers");
});

test("holders helper: a bad option is a usage error (status 1)", { skip }, () => {
  assert.equal(spawnSync(bin, ["--ring-mb", "3"], { encoding: "utf8" }).status, 1, "not a power of two");
  assert.equal(spawnSync(bin, ["--nope"], { encoding: "utf8" }).status, 1);
});

test("holders helper: without the privilege it prints one failure line and exits with 3, and the manager reports it", { skip: skip || (allowed ? "holders helper: skipped (this process may load BPF)" : false) }, async () => {
  assert.equal(probed!.refused, true);
  assert.equal(probed!.status, 3);
  const j = JSON.parse(probed!.line) as { ok: boolean; error: string };
  assert.equal(j.ok, false);
  assert.match(j.error, /not permitted|not supported/);
  const h = new Holders({ helper: bin, root: "/", log: () => {} });
  h.start();
  const end = Date.now() + 10_000;
  while (h.state !== "unavailable" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const a = await h.query(work, "/work");
  h.close();
  assert.equal(a.feature.state, "unavailable");
  assert.equal(a.proven, false);
  assert.deepEqual(a.holders, []);
});

let diag: () => string = () => "";
const until = async (f: () => Promise<boolean>, ms = 15_000, what = "the condition") => {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return;
    if (Date.now() > end) assert.fail(`${what} did not become true in ${ms} ms\n${diag()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const start = (cmd: string, args: string[], cwd = work): ChildProcess => {
  const c = spawn(cmd, args, { cwd, stdio: "ignore", detached: true });
  children.push(c);
  return c;
};
const holdersOf = async (h: Holders, p: string): Promise<HoldersAnswer> => h.query(p, p);

test("holders helper: with the privilege, the table sees what processes hold, as the kernel has it", { skip: liveSkip, timeout: 120_000 }, async () => {
  assert.equal(allowed, true, `this suite must run with BPF allowed (FILEDECK_REQUIRE_HOLDERS_LIVE is set); the helper said: ${probed?.line}`);
  const h = new Holders({ helper: bin, root: "/", ringMb: 4, settleMs: 20_000, log: (s) => console.log(`# ${s}`) });
  h.start();
  diag = () => {
    const procs = [...children].map((c) => {
      const st = c.pid === undefined ? undefined : h.table.procs.get(c.pid);
      return `${c.pid}: ${st ? JSON.stringify({ comm: st.comm, dirty: st.dirty, cwds: [...st.cwds.entries()], exe: st.exe, holds: [...st.holds.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`) }) : "not in the table"} exit=${c.exitCode}`;
    });
    return `state=${h.state} ${h.reason ?? ""} events=${h.table.events} helperEvents=${h.helperEvents} drops=${h.drops} soft=${h.softMissing} size=${JSON.stringify(h.table.size())} gaps=${JSON.stringify(h.table.gaps())}\n${procs.join("\n")}`;
  };
  try {
    await until(async () => h.state === "ready", 60_000, "the start-up pass");
    const tree = path.join(work, "tree");
    fs.mkdirSync(path.join(tree, "sub/deep"), { recursive: true });
    fs.writeFileSync(path.join(tree, "sub/deep/file"), "data");
    const kindsOf = async (pid: number): Promise<string[]> => (await holdersOf(h, tree)).holders.find((x) => x.pid === pid)?.kinds ?? [];
    const first = await holdersOf(h, tree);
    assert.equal(first.proven, true, first.reasons.join("; "));
    assert.deepEqual(first.holders, [], "nothing holds the new tree");

    // a working folder
    const cwd = start("sleep", ["300"], path.join(tree, "sub"));
    await until(async () => (await kindsOf(cwd.pid!)).includes("cwd"), 15_000, "the working folder");
    const a = await holdersOf(h, path.join(tree, "sub/deep"));
    assert.deepEqual(a.holders.map((x) => x.pid), [], "the working folder is above sub/deep: not held");

    // a descriptor, a descriptor that is closed, and a descriptor that is passed on to a child by fork
    const fdp = start("sh", ["-c", `exec 3< ${tree}/sub/deep/file; sleep 300`]);
    await until(async () => (await kindsOf(fdp.pid!)).includes("fd"), 15_000, "the descriptor");
    assert.ok((await holdersOf(h, path.join(tree, "sub/deep"))).holders.some((x) => x.pid === fdp.pid), "found from the folder above the file");
    const closed = start("sh", ["-c", `exec 3< ${tree}/sub/deep/file; exec 3<&-; sleep 300`]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(await kindsOf(closed.pid!), [], "closed: not held (the shell's own working folder is outside the tree)");
    const forked = start("sh", ["-c", `exec 3< ${tree}/sub/deep/file; sleep 300 & wait`]);
    await until(async () => (await holdersOf(h, tree)).holders.filter((x) => x.kinds.includes("fd")).length >= 3, 15_000, "the shell and its child hold the descriptor");

    // an executable that lives in the tree
    const exe = path.join(tree, "sleeper");
    // (a program of our own: a copy of /bin/sleep may be a multi-call binary that needs its name)
    fs.writeFileSync(path.join(work, "sleeper.c"), "#include <unistd.h>\nint main(void){for(;;)pause();}\n");
    assert.equal(spawnSync("cc", ["-O1", "-o", exe, path.join(work, "sleeper.c")], { encoding: "utf8" }).status, 0, "cc builds the test program");
    const ex = start(exe, [], work);
    await until(async () => (await kindsOf(ex.pid!)).includes("exe"), 15_000, "the executable");

    // a mapping (python is on every runner; the test is skipped without it)
    if (spawnSync("python3", ["--version"]).status === 0) {
      const mp = start("python3", ["-c", `import mmap,time\nf=open(${JSON.stringify(path.join(tree, "sub/deep/file"))},'rb')\nm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)\nf.close()\ntime.sleep(300)\n`]);
      await until(async () => (await kindsOf(mp.pid!)).includes("mmap"), 15_000, "the mapping");
      process.kill(-mp.pid!, "SIGKILL");
    }

    // a process that ends is forgotten, and then the answer is a proof of no holder
    killAll();
    await until(async () => (await holdersOf(h, tree)).holders.length === 0, 20_000, "every holder gone");
    const done = await holdersOf(h, tree);
    assert.equal(done.proven, true, done.reasons.join("; "));
    assert.equal(done.held, false);
    assert.ok(h.helperEvents > 0 || h.table.events > 0);
  } finally {
    h.close();
    killAll();
  }
});

/**
 * The cases that need a process of our own. One C program (built here with cc, like the executable above) does what the shell cannot: a thread with its own
 * folder table, a child that shares the file table, an io_uring. It writes the file `ready` when it is in the state under test, and then waits.
 */
const probeSource = `#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
static const char *ready, *dir_b;
static volatile int thread_done;
static void touch(void) { int fd = open(ready, O_CREAT | O_WRONLY, 0600); if (fd >= 0) close(fd); }
static void *thread(void *a) { (void)a; if (unshare(CLONE_FS) || chdir(dir_b)) _exit(2); thread_done = 1; for (;;) pause(); return 0; }
static char stack[65536];
static int child(void *a) { if (open((const char *)a, O_RDONLY) < 0) _exit(2); touch(); for (;;) pause(); return 0; }
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  ready = argv[2];
  if (!strcmp(argv[1], "fsthreads") && argc == 6) { /* fsthreads READY A B C */
    dir_b = argv[4];
    if (chdir(argv[3])) return 2;
    pthread_t t;
    if (pthread_create(&t, 0, thread, 0)) return 2;
    while (!thread_done) usleep(1000);
    if (chdir(argv[5])) return 2; /* the main thread moves on: the thread keeps B */
    touch();
    for (;;) pause();
  }
  if (!strcmp(argv[1], "shared") && argc == 4) { /* shared READY FILE */
    if (clone(child, stack + sizeof stack, CLONE_FILES | SIGCHLD, argv[3]) < 0) return 2;
    for (;;) pause();
  }
  if (!strcmp(argv[1], "uring") || !strcmp(argv[1], "uring-files")) { /* uring READY: a ring with nothing registered; uring-files READY: one with a registered file */
    char params[256];
    memset(params, 0, sizeof params);
    int ring = (int)syscall(425, 4, params); /* io_uring_setup */
    if (ring < 0) return 77; /* not allowed here */
    if (!strcmp(argv[1], "uring-files")) {
      int fds[1] = {open("/dev/null", O_RDONLY)};
      if (syscall(427, ring, 2 /* IORING_REGISTER_FILES */, fds, 1) < 0) return 77; /* io_uring_register */
    }
    touch();
    for (;;) pause();
  }
  return 2;
}
`;
const probeBin = path.join(work, "probe");
let probeBuilt = false;
const buildProbe = () => {
  if (probeBuilt) return;
  fs.writeFileSync(path.join(work, "probe.c"), probeSource);
  assert.equal(spawnSync("cc", ["-O1", "-pthread", "-o", probeBin, path.join(work, "probe.c")], { encoding: "utf8" }).status, 0, "cc builds the probe program");
  probeBuilt = true;
};
const waitFile = async (p: string, what: string) => until(async () => fs.existsSync(p), 15_000, what);

async function liveHolders(): Promise<Holders> {
  const h = new Holders({ helper: bin, root: "/", ringMb: 4, settleMs: 20_000, log: (s) => console.log(`# ${s}`) });
  h.start();
  await until(async () => h.state === "ready", 60_000, "the start-up pass");
  return h;
}

test("holders helper: a file opened just before the question is in the answer (the sync barrier)", { skip: liveSkip, timeout: 120_000 }, async () => {
  const h = await liveHolders();
  try {
    const tree = path.join(work, "barrier");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, "file"), "data");
    const ready = path.join(work, "barrier.ready");
    const p = start("sh", ["-c", `exec 3< ${tree}/file; : > ${ready}; sleep 300`]);
    await waitFile(ready, "the descriptor is open");
    const a = await holdersOf(h, tree); // one question, no waiting for the table: the barrier must make it complete
    assert.ok(a.holders.some((x) => x.pid === p.pid && x.kinds.includes("fd")), `the descriptor is in the answer: ${JSON.stringify(a.holders)} ${a.reasons.join("; ")}`);
    assert.equal(a.proven, true, a.reasons.join("; "));
  } finally {
    h.close();
    killAll();
  }
});

test("holders helper: two threads with a folder table each are two holds, and the folder that one left is released", { skip: liveSkip, timeout: 120_000 }, async () => {
  const h = await liveHolders();
  try {
    buildProbe();
    const tree = path.join(work, "fsthreads");
    for (const d of ["a", "b", "c"]) fs.mkdirSync(path.join(tree, d), { recursive: true });
    const ready = path.join(work, "fsthreads.ready");
    const p = start(probeBin, ["fsthreads", ready, path.join(tree, "a"), path.join(tree, "b"), path.join(tree, "c")]);
    await waitFile(ready, "the program is in place");
    const has = async (d: string) => (await holdersOf(h, path.join(tree, d))).holders.some((x) => x.pid === p.pid && x.kinds.includes("cwd"));
    await until(async () => (await has("c")) && (await has("b")), 20_000, "both folders are held");
    assert.equal(await has("a"), false, "the folder that the main thread left is not held");
  } finally {
    h.close();
    killAll();
  }
});

test("holders helper: a child that shares the file table makes the answer unproven while it lives", { skip: liveSkip, timeout: 120_000 }, async () => {
  const h = await liveHolders();
  try {
    buildProbe();
    const tree = path.join(work, "shared");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, "file"), "data");
    const ready = path.join(work, "shared.ready");
    const p = start(probeBin, ["shared", ready, path.join(tree, "file")]);
    await waitFile(ready, "the child has the file open");
    const a = await holdersOf(h, tree);
    assert.equal(a.proven, false);
    assert.ok(a.reasons.some((r) => /share a file table/.test(r)), a.reasons.join("; "));
    process.kill(-p.pid!, "SIGKILL");
    await until(async () => (await holdersOf(h, tree)).proven, 20_000, "the answer is a proof again when both ended");
  } finally {
    h.close();
    killAll();
  }
});

test("holders helper: a process with an io_uring and no registered file does not make the answer unproven", { skip: liveSkip, timeout: 120_000 }, async () => {
  const h = await liveHolders();
  try {
    buildProbe();
    const ready = path.join(work, "uring0.ready");
    const p = start(probeBin, ["uring", ready]);
    const code = await Promise.race([new Promise<number | null>((r) => p.once("exit", (c) => r(c))), waitFile(ready, "the ring exists").then(() => -1)]);
    if (code === 77) return;
    const a = await holdersOf(h, work);
    assert.ok(!a.reasons.some((r) => /io_uring/.test(r)), a.reasons.join("; "));
  } finally {
    h.close();
    killAll();
  }
});

test("holders helper: a process with an io_uring that has a registered file makes the answer unproven while it lives", { skip: liveSkip, timeout: 120_000 }, async () => {
  const h = await liveHolders();
  try {
    buildProbe();
    const ready = path.join(work, "uring.ready");
    const p = start(probeBin, ["uring-files", ready]);
    const code = await Promise.race([new Promise<number | null>((r) => p.once("exit", (c) => r(c))), waitFile(ready, "the ring exists").then(() => -1)]);
    if (code === 77) return; // io_uring is not allowed on this machine: nothing to test
    const a = await holdersOf(h, work);
    assert.equal(a.proven, false);
    assert.ok(a.reasons.some((r) => /io_uring/.test(r)), a.reasons.join("; "));
    process.kill(-p.pid!, "SIGKILL");
    await until(async () => !(await holdersOf(h, work)).reasons.some((r) => /io_uring/.test(r)), 20_000, "the ring is gone");
  } finally {
    h.close();
    killAll();
  }
});
