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
      return `${c.pid}: ${st ? JSON.stringify({ comm: st.comm, dirty: st.dirty, cwd: st.cwd, exe: st.exe, holds: [...st.holds.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`) }) : "not in the table"} exit=${c.exitCode}`;
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
  }
});
