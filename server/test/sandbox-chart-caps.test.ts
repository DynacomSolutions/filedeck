import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepo, runGit, repoArgs } from "../src/git.ts";
import { selfCheckTools, listArchive, prepareCompress, prepareExtract, runCompress, runExtract } from "../src/archive.ts";
import { haveSevenZip } from "../src/sevenzip.ts";
import { launchGit } from "../src/git-sandbox.ts";
import { readerCapability, resetSandbox, spawnSandboxed } from "../src/sandbox.ts";
import type { JobCtl } from "../src/jobs.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * The shipped chart gives the agent exactly the capabilities in k8s/templates/agents.yaml (everything else dropped: not CAP_SETPCAP, so the agent cannot
 * shrink its capability bounding set) and sets no-new-privileges. The suites run as root with a full set (CI) or the container defaults (image build),
 * both of which hold CAP_SETPCAP, so this file starts the launcher the way the chart's agent would: a small wrapper drops the process to exactly the
 * chart's set, with no-new-privileges, and then runs the real launcher. The capability names are read from the chart template, so the two cannot drift.
 * Git on a root-owned private repository and the archive operations must work under it (root only: the wrapper needs CAP_SETPCAP to build the set).
 */
const IS_ROOT = process.getuid?.() === 0;
const CAPS: Record<string, number> = { CHOWN: 0, DAC_OVERRIDE: 1, DAC_READ_SEARCH: 2, FOWNER: 3, FSETID: 4, KILL: 5, SETGID: 6, SETUID: 7, SETPCAP: 8, NET_BIND_SERVICE: 10, SYS_CHROOT: 18, SYS_ADMIN: 21, MKNOD: 27, SETFCAP: 31 };

function chartCaps(): string[] {
  const t = fs.readFileSync(path.resolve(import.meta.dirname, "../../k8s/templates/agents.yaml"), "utf8");
  const m = /add:\s*\[([^\]]*(?:\{\{[^}]*\}\}[^\]]*)*)\]/.exec(t.slice(t.indexOf("securityContext:", t.indexOf("agent"))));
  assert.ok(m, "the chart's capability list is found");
  const names = [...m![1]!.matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]!);
  assert.ok(names.length >= 4, `names: ${names}`);
  return names;
}

const WRAPPER = String.raw`
#define _GNU_SOURCE
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
struct hdr { uint32_t v; int pid; };
struct dat { uint32_t e, p, i; };
int main(int argc, char **argv) {
  uint64_t keep = 0;
  char *l = strdup(getenv("FD_CAPS"));
  for (char *t = strtok(l, ","); t; t = strtok(NULL, ",")) keep |= 1ULL << atoi(t);
  struct hdr h = {0x20080522, 0};
  struct dat d[2];
  /* only what this process holds can be kept (a container's default set lacks some of the chart's capabilities) */
  if (syscall(SYS_capget, &h, d) < 0) return 89;
  keep &= (uint64_t)d[0].p | ((uint64_t)d[1].p << 32);
  for (int c = 0; c < 64; c++) if (!(keep & (1ULL << c))) prctl(PR_CAPBSET_DROP, c, 0, 0, 0);
  d[0].e = d[0].p = (uint32_t)keep; d[0].i = 0;
  d[1].e = d[1].p = (uint32_t)(keep >> 32); d[1].i = 0;
  if (syscall(SYS_capset, &h, d) < 0) return 90;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return 91;
  if (argc > 1 && !strcmp(argv[1], "--raw")) { execvp(argv[2], argv + 2); return 92; }
  argv[0] = getenv("FD_REAL");
  execv(argv[0], argv);
  return 93;
}
`;

let tmp: string, box: Awaited<ReturnType<typeof useSandbox>>, wrapper: string, caps: string[], prevHelper: string | undefined;
const mkCtl = (): JobCtl => ({ signal: new AbortController().signal, progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: "" } }) as unknown as JobCtl;
const LIM = { maxEntries: 100_000, maxBytes: 1 << 30 };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd-chartcaps-")));
  fs.chmodSync(tmp, 0o755);
  box = await useSandbox();
  if (!IS_ROOT) return;
  caps = chartCaps();
  assert.ok(!caps.includes("SETPCAP"), "the chart does not grant SETPCAP (this test exists because of that)");
  const src = path.join(tmp, "wrap.c");
  fs.writeFileSync(src, WRAPPER);
  wrapper = path.join(tmp, "wrap");
  const cc = spawnSync("cc", ["-O2", "-o", wrapper, src], { encoding: "utf8" });
  assert.equal(cc.status, 0, cc.stderr);
  prevHelper = process.env.FILEDECK_SANDBOX_HELPER;
  process.env.FD_CAPS = caps.map((n) => { assert.ok(n in CAPS, `capability ${n} is known to this test`); return CAPS[n]; }).join(",");
  process.env.FD_REAL = box.bin;
  process.env.FILEDECK_SANDBOX_HELPER = wrapper;
  process.env.FILEDECK_WORK_DIR = path.join(tmp, "workdir");
  fs.mkdirSync(process.env.FILEDECK_WORK_DIR, { mode: 0o700 });
  resetSandbox();
  console.log(`# chart capabilities: ${caps.join(",")}`);
});
after(() => {
  if (IS_ROOT) {
    process.env.FILEDECK_SANDBOX_HELPER = prevHelper;
    delete process.env.FD_CAPS;
    delete process.env.FD_REAL;
    delete process.env.FILEDECK_WORK_DIR;
  }
  delete process.env.FILEDECK_SANDBOX_HELPER;
  resetSandbox();
  fs.rmSync(box.dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** what a program sees when started as the archive user with the reader capability under this wrapper (shown when a test fails, so a CI log says why) */
async function diagnose(dir: string, file: string): Promise<string> {
  const cap = await readerCapability();
  const run = async (opts: Parameters<typeof spawnSandboxed>[2]) => {
    const c = await spawnSandboxed("sh", ["-c", `id; grep ^Cap /proc/self/status; ls -ld ${dir}; wc -c < ${file}; bsdtar --version; bsdtar -cf - ${file} | wc -c`], { readOnly: [dir, "/proc"], ...opts });
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.stderr?.on("data", (d) => (out += d));
    await new Promise((r) => c.on("close", r));
    return out;
  };
  // the same start as the real code makes, with a trivial command, and the launcher's own flags varied, to see which part ends in a signal
  const trial = async (label: string, run: () => Promise<import("node:child_process").ChildProcess>) => {
    try {
      const c = await run();
      let err = "";
      c.stderr?.on("data", (d) => (err += d));
      c.stdout?.resume();
      const [code, sig] = await new Promise<[number | null, string | null]>((r) => c.on("close", (a, b) => r([a, b])));
      return `${label}: code ${code} signal ${sig} ${err.trim().slice(0, 200)}\n`;
    } catch (e) {
      return `${label}: ${e}\n`;
    }
  };
  let more = "\n--- trials:\n";
  more += await trial("git --version via launchGit", () => launchGit(dir, ["--version"], ENV, { stdio: ["ignore", "pipe", "pipe"] }, { root: path.dirname(dir), gitDir: dir }));
  more += await trial("git --version, no root", () => launchGit(dir, ["--version"], ENV, { stdio: ["ignore", "pipe", "pipe"] }, { root: null, gitDir: null }));
  more += await trial("git --version, spawnSandboxed readOnly dir", () => spawnSandboxed("git", ["--version"], { readOnly: [dir], cwd: dir, env: ENV }));
  more += await trial("git --version, spawnSandboxed no env", () => spawnSandboxed("git", ["--version"], { readOnly: [dir], cwd: dir }));
  more += await trial("git --version, noSystem off, no roots", () => spawnSandboxed("git", ["--version"], {}));
  return `reader ${cap}${more}\n--- as the archive user with it:\n${await run({ uid: 65533, gid: 65533, ...(cap ? { keepCaps: [cap] } : {}) })}\n--- as the agent without capabilities:\n${await run({})}`;
}
const live = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: IS_ROOT ? false : "sandbox live: skipped (not running as root)" }, async (t) => {
    if (box.state !== "landlock") return t.skip(`skipped (${box.why})`);
    await fn();
  });

live("the wrapper really holds exactly the chart's capabilities and not SETPCAP", async () => {
  const r = spawnSync(wrapper, ["--raw", "grep", "-E", "^Cap(Eff|Prm|Bnd):", "/proc/self/status"], { encoding: "utf8", env: process.env });
  const eff = BigInt("0x" + /CapEff:\s*([0-9a-f]+)/.exec(r.stdout)![1]!);
  const held = BigInt("0x" + /CapPrm:\s*([0-9a-f]+)/.exec(fs.readFileSync("/proc/self/status", "utf8"))![1]!); // the wrapper keeps what this process holds of the chart's set
  const want = caps.reduce((a, n) => a | (1n << BigInt(CAPS[n]!)), 0n) & held;
  assert.equal(eff, want, `${r.stdout} ${r.stderr} (exit ${r.status})`);
  assert.ok(eff & 1n, "the wrapper's set is not empty");
  assert.equal(eff & (1n << 8n), 0n);
});

live("under the chart's capabilities Git reads a root-owned repository that the unprivileged user cannot", async () => {
  const root = path.join(tmp, "host");
  const d = path.join(root, "private");
  fs.mkdirSync(d, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "safe.directory=*", ...a], { cwd: d, env: ENV, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(d, "own.txt"), "mine\n");
  git("add", "-A");
  git("commit", "-qm", "own");
  execFileSync("chmod", ["-R", "go-rwx", d]);
  fs.chmodSync(root, 0o755);
  const r = (await findRepo(root, d))!;
  assert.ok(r);
  const log = await runGit(d, [...repoArgs(r), "log", "--format=%s"]);
  assert.equal(log.code, 0, `${JSON.stringify({ code: log.code, stderr: log.stderr, timedOut: log.timedOut })}\n${await diagnose(d, path.join(d, "own.txt"))}`);
  assert.equal(log.stdout.trim(), "own");
});

live("under the chart's capabilities every archive operation works on 0600 and 0700 shapes", async () => {
  const root = path.join(tmp, "arch");
  fs.mkdirSync(path.join(root, "src/pick"), { recursive: true });
  fs.mkdirSync(path.join(root, "out"));
  fs.chmodSync(root, 0o755);
  const body = Buffer.alloc(150_000, "x");
  for (let i = 0; i < body.length; i += 7) body[i] = (i * 31) & 255;
  fs.writeFileSync(path.join(root, "src/pick/a.bin"), body, { mode: 0o600 });
  fs.chmodSync(path.join(root, "src/pick"), 0o700);
  fs.chmodSync(path.join(root, "src"), 0o700);
  const c = await runCompress(await prepareCompress(root, "/src", ["pick"], "tar.gz", "t", { destDir: "/out" }), LIM, mkCtl()).catch(async (e) => {
    throw new Error(`${e.message}\n${await diagnose(path.join(root, "src/pick"), path.join(root, "src/pick/a.bin"))}`);
  });
  assert.equal(fs.statSync(path.join(root, c.path)).mode & 0o777, 0o600);
  assert.ok(JSON.stringify(await listArchive(root, c.path)).includes("a.bin"));
  const x = await runExtract(await prepareExtract(root, c.path, "/out", true, { overwrite: "rename" }), LIM, mkCtl());
  assert.deepEqual(fs.readFileSync(path.join(root, x.path, "pick/a.bin")), body);
  if (haveSevenZip()) {
    const z = await runCompress(await prepareCompress(root, "/src", ["pick"], "7z", "z", { destDir: "/out", password: "pw" }), LIM, mkCtl());
    const zx = await runExtract(await prepareExtract(root, z.path, "/out", true, { overwrite: "rename", password: "pw" }), LIM, mkCtl());
    assert.deepEqual(fs.readFileSync(path.join(root, zx.path, "pick/a.bin")), body);
  }
});

live("the start-up self-check finds every tool identity startable under the chart's capabilities", async () => {
  const lines: string[] = [];
  const failed = await selfCheckTools((m) => lines.push(m));
  assert.deepEqual(failed, [], lines.join("\n"));
  assert.match(lines.join("\n"), /every identity starts/);
  console.log(`# ${lines.join(" ")}`);
});
