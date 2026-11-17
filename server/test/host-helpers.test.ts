import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { hostHelperDir, installHostHelpers, runHostHelper } from "../src/host-helpers.ts";
import { HostAccounts, makeResolver } from "../src/local-accounts.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: the host helpers are copied into a private, root-owned folder under the machine's /run and run there through the
 * launcher's chroot, so `filedeck-id` answers from the machine's own NSS. The install refuses links and folders that root does not own.
 */
const ROOT_ONLY = process.getuid?.() === 0 ? false : "host helpers live: skipped (not running as root)";
const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" });
const GLIBC = /glibc|GNU/i.test(`${ldd.stdout ?? ""}${ldd.stderr ?? ""}`);

let tmp: string;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-host-")));
  fs.chmodSync(tmp, 0o755);
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
});

const write = (p: string, s: string, mode = 0o755) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s, { mode }), p);
const modeOf = (p: string) => fs.lstatSync(p).mode & 0o7777;

test("helper folder: FILEDECK_HOST_HELPERS is used as given, and a folder without filedeck-id is no folder", async () => {
  const dir = path.join(tmp, "given");
  write(path.join(dir, "filedeck-id"), "#!/bin/sh\n");
  assert.equal(await hostHelperDir(dir), dir);
  assert.equal(await hostHelperDir(path.join(tmp, "empty")), null);
});

test("no host helper: only the local files resolve, and the log says why", async () => {
  const root = path.join(tmp, "nohelper");
  write(path.join(root, "etc/passwd"), "root:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/sh\n", 0o644);
  write(path.join(root, "etc/group"), "users:x:100:alice\n", 0o644);
  const logs: string[] = [];
  const cfg = { ...loadConfig({ FILEDECK_ROOT: root, FILEDECK_AUTH: "on" }), hostHelpers: path.join(tmp, "none") };
  const r = await makeResolver(cfg, (s) => logs.push(s));
  assert.equal(r.helpers, undefined);
  assert.deepEqual(await r.resolver.resolve("alice"), { name: "alice", uid: 1000, gid: 1000, home: "/home/alice", groups: [1000, 100] });
  assert.equal(await r.resolver.resolve("root"), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^system accounts: host lookup unavailable \(.+\); only local \/etc\/passwd accounts resolve, and system sign-in is refused$/);
});

test("install: a private root-owned folder named by the files' hash, files 0500, the same folder again for the same files", { skip: ROOT_ONLY }, async () => {
  const root = path.join(tmp, "inst");
  fs.mkdirSync(path.join(root, "run"), { recursive: true, mode: 0o755 });
  const from = path.join(tmp, "inst-from");
  write(path.join(from, "filedeck-id"), "one\n", 0o644);
  write(path.join(from, "filedeck-pam"), "two\n", 0o644);
  const r = await installHostHelpers(root, from);
  assert.ok("dir" in r, JSON.stringify(r));
  assert.match(r.dir, /^\/run\/filedeck\/host-[0-9a-f]{16}$/);
  for (const d of [path.join(root, "run/filedeck"), path.join(root, r.dir)]) {
    const st = fs.lstatSync(d);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), d);
    assert.equal(st.uid, 0, d);
    assert.equal(modeOf(d), 0o700, d);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, r.dir)).sort(), ["filedeck-id", "filedeck-pam"]);
  for (const [n, body] of [["filedeck-id", "one\n"], ["filedeck-pam", "two\n"]] as const) {
    const p = path.join(root, r.dir, n);
    assert.equal(fs.readFileSync(p, "utf8"), body);
    assert.equal(modeOf(p), 0o500, n);
    assert.equal(fs.lstatSync(p).uid, 0, n);
  }
  // a folder left with a wrong mode is put right, and a file changed in place is written again
  fs.chmodSync(path.join(root, "run/filedeck"), 0o755);
  fs.chmodSync(path.join(root, r.dir, "filedeck-id"), 0o700);
  fs.writeFileSync(path.join(root, r.dir, "filedeck-id"), "tampered\n");
  const again = await installHostHelpers(root, from);
  assert.deepEqual(again, r);
  assert.equal(modeOf(path.join(root, "run/filedeck")), 0o700);
  assert.equal(fs.readFileSync(path.join(root, r.dir, "filedeck-id"), "utf8"), "one\n");
  assert.equal(modeOf(path.join(root, r.dir, "filedeck-id")), 0o500);
  // other files, another folder
  write(path.join(from, "filedeck-id"), "one, changed\n", 0o644);
  const other = await installHostHelpers(root, from);
  assert.ok("dir" in other && other.dir !== r.dir);
});

test("install: a link or a folder that root does not own is refused, and nothing is written through it", { skip: ROOT_ONLY }, async () => {
  const from = path.join(tmp, "refuse-from");
  write(path.join(from, "filedeck-id"), "x\n");
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o700 });

  const linked = path.join(tmp, "linked");
  fs.mkdirSync(path.join(linked, "run"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(linked, "run/filedeck"));
  const a = await installHostHelpers(linked, from);
  assert.ok("error" in a, JSON.stringify(a));
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const runLinked = path.join(tmp, "runlinked");
  fs.mkdirSync(runLinked);
  fs.symlinkSync(elsewhere, path.join(runLinked, "run"));
  assert.ok("error" in (await installHostHelpers(runLinked, from)));
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const leaf = path.join(tmp, "leaflinked");
  fs.mkdirSync(path.join(leaf, "run/filedeck"), { recursive: true, mode: 0o700 });
  const ok = await installHostHelpers(leaf, from);
  assert.ok("dir" in ok);
  fs.rmSync(path.join(leaf, ok.dir), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(leaf, ok.dir));
  assert.ok("error" in (await installHostHelpers(leaf, from)));
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const foreign = path.join(tmp, "foreign");
  fs.mkdirSync(path.join(foreign, "run/filedeck"), { recursive: true, mode: 0o700 });
  fs.chownSync(path.join(foreign, "run/filedeck"), 65534, 65534);
  assert.ok("error" in (await installHostHelpers(foreign, from)));
  assert.deepEqual(fs.readdirSync(path.join(foreign, "run/filedeck")), []);
});

/** Live against this machine's own `/`: needs root (the chroot and /run), the launcher and a glibc toolchain. */
const live = (name: string, fn: (h: { dir: string; built: string }) => Promise<void>) =>
  test(name, { skip: ROOT_ONLY }, async (t) => {
    if (!GLIBC) {
      if (process.env.FILEDECK_REQUIRE_HOST_HELPERS) throw new Error(`host helpers required but this is not a glibc system: ${(ldd.stdout || ldd.stderr || String(ldd.error)).trim().split("\n")[0]}`);
      return t.skip("host helpers live: skipped (no glibc here)");
    }
    const h = await liveSetup();
    await fn(h);
  });

let setup: Promise<{ dir: string; built: string }> | undefined;
// the live tests write into this machine's /run/filedeck: remove what they made
const hadRunFiledeck = fs.existsSync("/run/filedeck");
const liveDirs = new Set<string>();
function liveSetup() {
  setup ??= (async () => {
    await useSandbox();
    const out = path.join(tmp, "native");
    const b = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const built = path.join(out, "host");
    assert.ok(fs.existsSync(path.join(built, "filedeck-id")), `build-native did not build the host helpers: ${b.stdout}`);
    const r = await installHostHelpers("/", built);
    assert.ok("dir" in r, JSON.stringify(r));
    liveDirs.add(r.dir);
    return { dir: r.dir, built };
  })();
  return setup;
}
after(() => {
  for (const d of liveDirs) fs.rmSync(d, { recursive: true, force: true });
  if (!hadRunFiledeck) fs.rmSync("/run/filedeck", { recursive: true, force: true });
});

live("filedeck-id: nobody resolves to 65534, root and an unknown name do not, usage errors exit 64", async ({ dir }) => {
  const raw = await runHostHelper("/", dir, "filedeck-id", ["root"], {});
  assert.equal(raw.code, 0);
  assert.match(raw.stdout, /^0\n0\n\/[^\n]*\n[0-9 ]*\n$/);
  const usage = await runHostHelper("/", dir, "filedeck-id", [], {});
  assert.deepEqual([usage.code, usage.stdout], [64, ""]);
  const unknown = await runHostHelper("/", dir, "filedeck-id", ["no-such-user-xyz"], {});
  assert.deepEqual([unknown.code, unknown.stdout], [2, ""]);

  const accounts = new HostAccounts({ run: (name) => runHostHelper("/", dir, "filedeck-id", [name], {}) });
  const nobody = await accounts.resolve("nobody");
  assert.equal(nobody?.uid, 65534);
  assert.ok(nobody.groups.includes(nobody.gid));
  assert.equal(await accounts.resolve("root"), null);
  assert.equal(await accounts.resolve("no-such-user-xyz"), null);
});

live("makeResolver: the host lookup is used and the helpers are handed on", async ({ built }) => {
  const logs: string[] = [];
  const cfg = { ...loadConfig({ FILEDECK_ROOT: "/", FILEDECK_AUTH: "on" }), hostHelpers: built };
  const r = await makeResolver(cfg, (s) => logs.push(s));
  assert.deepEqual(logs, ["system accounts: resolved through the host (NSS)"]);
  assert.equal(r.helpers?.root, "/");
  assert.match(r.helpers.dir, /^\/run\/filedeck\/host-[0-9a-f]{16}$/);
  liveDirs.add(r.helpers.dir);
  assert.ok(r.resolver instanceof HostAccounts);
  assert.equal((await r.resolver.resolve("nobody"))?.uid, 65534);
});

test("runHostHelper: a helper that runs too long is killed (code null), and output is cut at 64 KiB", { skip: ROOT_ONLY }, async () => {
  await useSandbox();
  const from = path.join(tmp, "scripts");
  write(path.join(from, "sleeper"), "#!/bin/sh\nexec sleep 30\n");
  write(path.join(from, "talker"), "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' x\n");
  write(path.join(from, "show-env"), "#!/bin/sh\nenv\ncat\n");
  const r = await installHostHelpers("/", from);
  assert.ok("dir" in r, JSON.stringify(r));
  liveDirs.add(r.dir);
  const started = Date.now();
  const slow = await runHostHelper("/", r.dir, "sleeper", [], { timeoutMs: 300 });
  assert.equal(slow.code, null);
  assert.ok(Date.now() - started < 10_000);
  const big = await runHostHelper("/", r.dir, "talker", [], {});
  assert.equal(big.code, null);
  assert.ok(big.stdout.length <= 64 * 1024, String(big.stdout.length));
  const env = await runHostHelper("/", r.dir, "show-env", [], { stdin: Buffer.from("from stdin\n") });
  assert.equal(env.code, 0);
  const lines = env.stdout.trim().split("\n");
  assert.ok(lines.includes("PATH=/usr/bin:/bin"), env.stdout);
  assert.ok(lines.includes("from stdin"), env.stdout);
  assert.ok(!lines.some((l) => /^FILEDECK_|TOKEN|KEY=/.test(l)), env.stdout);
});
