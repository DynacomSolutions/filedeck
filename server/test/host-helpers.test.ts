import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { hostHelperDir, runHostHelper } from "../src/host-helpers.ts";
import { HostAccounts, makeResolver } from "../src/local-accounts.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: the host helpers stay in the image. The launcher opens one by its path in the container, changes the root to the
 * machine's (`FILEDECK_ROOT`) and runs it from that descriptor, so its dynamic loader, libc and NSS modules are the machine's own
 * and nothing is written on the machine. `filedeck-id` then answers from the machine's own account database.
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

test("helper folder: the configured folder is used as given, and a folder without filedeck-id is no folder", async () => {
  const dir = path.join(tmp, "given");
  write(path.join(dir, "filedeck-id"), "#!/bin/sh\n");
  assert.equal(await hostHelperDir(dir), dir);
  assert.equal(await hostHelperDir(path.join(tmp, "empty")), null);
});

test("runHostHelper: a folder that is not absolute or a name with a slash is refused before anything starts", async () => {
  await assert.rejects(runHostHelper("/", "relative/dir", "filedeck-id", []), /folder/);
  await assert.rejects(runHostHelper("/", "/abs", "../filedeck-id", []), /name/);
  await assert.rejects(runHostHelper("/", "/abs", "", []), /name/);
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

/**
 * Live against this machine's own `/`: needs root (the chroot), the launcher, and glibc (the helpers are dynamic glibc programs; the
 * image's Alpine build stage has none, so these skip there). `FILEDECK_REQUIRE_HOST_HELPERS=1` turns the glibc skip into a failure.
 */
const live = (name: string, fn: (h: { built: string; extra: string }) => Promise<void>) =>
  test(name, { skip: ROOT_ONLY }, async (t) => {
    if (!GLIBC) {
      if (process.env.FILEDECK_REQUIRE_HOST_HELPERS) throw new Error(`host helpers required but this is not a glibc system: ${(ldd.stdout || ldd.stderr || String(ldd.error)).trim().split("\n")[0]}`);
      return t.skip("host helpers live: skipped (no glibc here)");
    }
    await fn(await liveSetup());
  });

const C_HELPERS: Record<string, string> = {
  sleeper: "#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n",
  talker: '#include <stdio.h>\nint main(void) { for (int i = 0; i < 200000; i++) putchar(\'x\'); return 0; }\n',
  "bad-utf8": '#include <stdio.h>\nint main(void) { fputs("\\xff\\xfe\\n", stdout); return 0; }\n',
  "show-env":
    '#include <stdio.h>\n#include <unistd.h>\nextern char **environ;\nint main(void) { printf("uid=%d gid=%d\\n", (int)getuid(), (int)getgid()); for (char **e = environ; *e; e++) puts(*e); char b[256]; size_t n = fread(b, 1, sizeof b - 1, stdin); b[n] = 0; fputs(b, stdout); return 0; }\n',
};

let setup: Promise<{ built: string; extra: string }> | undefined;
function liveSetup() {
  setup ??= (async () => {
    await useSandbox();
    const out = path.join(tmp, "native");
    const b = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const built = path.join(out, "host");
    assert.ok(fs.existsSync(path.join(built, "filedeck-id")), `build-native did not build the host helpers: ${b.stdout}`);
    const extra = path.join(tmp, "extra");
    fs.mkdirSync(extra, { mode: 0o755 });
    for (const [name, src] of Object.entries(C_HELPERS)) {
      const c = write(path.join(tmp, "src", `${name}.c`), src, 0o644);
      const r = spawnSync("cc", ["-O2", "-o", path.join(extra, name), c], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    return { built, extra };
  })();
  return setup;
}

live("filedeck-id: nobody resolves to 65534, root and an unknown name do not, usage errors exit 64; nothing is written on the machine", async ({ built }) => {
  const runBefore = fs.existsSync("/run/filedeck");
  const raw = await runHostHelper("/", built, "filedeck-id", ["root"]);
  assert.equal(raw.code, 0, raw.stderr);
  assert.match(raw.stdout, /^0\n0\n\/[^\n]*\n[0-9 ]*\n$/);
  const usage = await runHostHelper("/", built, "filedeck-id", []);
  assert.deepEqual([usage.code, usage.stdout], [64, ""]);
  const unknown = await runHostHelper("/", built, "filedeck-id", ["no-such-user-xyz"]);
  assert.deepEqual([unknown.code, unknown.stdout], [2, ""]);

  const accounts = new HostAccounts({ run: (name) => runHostHelper("/", built, "filedeck-id", [name]) });
  const nobody = await accounts.resolve("nobody");
  assert.equal(nobody?.uid, 65534);
  assert.ok(nobody.groups.includes(nobody.gid));
  assert.equal(await accounts.resolve("root"), null);
  assert.equal(await accounts.resolve("no-such-user-xyz"), null);
  assert.equal(fs.existsSync("/run/filedeck"), runBefore, "the helpers are not copied onto the machine");
});

live("filedeck-id runs from the image even where the helper's path does not exist inside the new root", async ({ built }) => {
  // a new root that holds only the machine's system folders (read-only bind mounts), so the helper's own path does not exist inside
  // it. It is not under `tmp`, and it is taken down with rmdir only: a recursive removal must never reach a mount that is still there.
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-jail-"));
  fs.chmodSync(jail, 0o755);
  const sys = ["usr", "etc", "lib", "lib64", "bin"].filter((d) => fs.existsSync(`/${d}`));
  const mounted: string[] = [];
  try {
    for (const d of sys) {
      const real = fs.lstatSync(`/${d}`);
      const at = path.join(jail, d);
      if (real.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(`/${d}`), at);
      else {
        fs.mkdirSync(at);
        const m = spawnSync("mount", ["-o", "bind,ro", `/${d}`, at], { encoding: "utf8" });
        assert.equal(m.status, 0, `bind mount of /${d}: ${m.stderr}`);
        mounted.push(at);
      }
    }
    assert.equal(fs.existsSync(path.join(jail, built)), false);
    const r = await runHostHelper(jail, built, "filedeck-id", ["nobody"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^65534\n/);
  } finally {
    for (const at of mounted) spawnSync("umount", [at]);
    for (const d of sys) {
      const at = path.join(jail, d);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) fs.unlinkSync(at);
      else if (st) fs.rmdirSync(at); // fails, and leaves everything, if the mount is still there
    }
    fs.rmdirSync(jail);
  }
});

live("makeResolver: the host lookup is used and the helpers are handed on", async ({ built }) => {
  const logs: string[] = [];
  const cfg = { ...loadConfig({ FILEDECK_ROOT: "/", FILEDECK_AUTH: "on" }), hostHelpers: built };
  const r = await makeResolver(cfg, (s) => logs.push(s));
  assert.deepEqual(logs, ["system accounts: resolved through the host (NSS)"]);
  assert.deepEqual(r.helpers, { root: "/", dir: built });
  assert.ok(r.resolver instanceof HostAccounts);
  assert.equal((await r.resolver.resolve("nobody"))?.uid, 65534);
});

live("runHostHelper: runs as 65534 unless asked for root, with only PATH and the given input; killed when too slow or too talkative; output must be UTF-8", async ({ extra }) => {
  const env = await runHostHelper("/", extra, "show-env", [], { stdin: Buffer.from("from stdin\n") });
  assert.equal(env.code, 0, env.stderr);
  const lines = env.stdout.trim().split("\n");
  assert.equal(lines[0], "uid=65534 gid=65534");
  assert.ok(lines.includes("PATH=/usr/bin:/bin"), env.stdout);
  assert.ok(lines.includes("from stdin"), env.stdout);
  assert.ok(!lines.some((l) => /^FILEDECK_|TOKEN|KEY=/.test(l)), env.stdout);
  const asRoot = await runHostHelper("/", extra, "show-env", [], { asRoot: true });
  assert.match(asRoot.stdout, /^uid=0 gid=0\n/);

  const started = Date.now();
  const slow = await runHostHelper("/", extra, "sleeper", [], { timeoutMs: 300 });
  assert.equal(slow.code, null);
  assert.ok(Date.now() - started < 10_000);
  // the caller's signal kills it too (an attempt that gave up), and the call ends when the process has exited
  const ac = new AbortController();
  const t1 = Date.now();
  setTimeout(() => ac.abort(), 200);
  const stopped = await runHostHelper("/", extra, "sleeper", [], { signal: ac.signal });
  assert.equal(stopped.code, null);
  assert.ok(Date.now() - t1 < 10_000);
  const pre = new AbortController();
  pre.abort();
  assert.equal((await runHostHelper("/", extra, "sleeper", [], { signal: pre.signal })).code, null);
  const big = await runHostHelper("/", extra, "talker", []);
  assert.equal(big.code, null);
  assert.ok(big.stdout.length <= 64 * 1024, String(big.stdout.length));
  await assert.rejects(runHostHelper("/", extra, "bad-utf8", []), /UTF-8/);
});
