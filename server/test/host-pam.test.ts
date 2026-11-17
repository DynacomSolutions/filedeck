import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../src/config.ts";
import { runHostHelper } from "../src/host-helpers.ts";
import { HostPam, hostPam, type PamResult } from "../src/host-pam.ts";
import { resetSandbox } from "../src/sandbox.ts";
import { useSandbox } from "./sandbox-env.ts";

/**
 * work-item: system users sign in with their machine password. PAM runs in `filedeck-pam`, a host helper started per attempt inside the
 * machine's root (like `filedeck-id`). The password reaches it only on its stdin pipe, and a PAM stack that asks more than one question
 * fails the attempt at once (never a hang).
 */
const ROOT_ONLY = process.getuid?.() === 0 ? false : "host helpers live: skipped (not running as root)";
const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" });
const GLIBC = /glibc|GNU/i.test(`${ldd.stdout ?? ""}${ldd.stderr ?? ""}`);

const SECRET = "c0rrect horse é battery";
const SECOND_PROMPT = "pam: the service asked more than one question; only one password prompt is supported";

let tmp: string;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pam-")));
  fs.chmodSync(tmp, 0o755);
});

type Call = { name: string; stdin: Buffer };
const fake = (code: number | null | (() => Promise<{ code: number | null }>), log?: string[]) => {
  const calls: Call[] = [];
  const pam = new HostPam({
    run: async (name, stdin) => {
      calls.push({ name, stdin });
      return typeof code === "function" ? code() : { code };
    },
    log: (s) => log?.push(s),
    timeoutMs: 200,
  });
  return { pam, calls };
};

test("the password reaches the helper on stdin only: never in the name or the arguments", async () => {
  const { pam, calls } = fake(0);
  assert.equal(await pam.check("alice", SECRET), "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "alice");
  assert.deepEqual(calls[0]!.stdin, Buffer.from(SECRET, "utf8"));

  // hostPam: what it hands to runHostHelper
  const seen: { args: unknown[] }[] = [];
  const runner = (async (...args: unknown[]) => {
    seen.push({ args });
    return { code: 0, stdout: "", stderr: "" };
  }) as unknown as typeof runHostHelper;
  const cfg = { ...loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_AUTH: "on" }), pamService: "filedeck-x" };
  assert.equal(await hostPam(cfg, { root: "/host", dir: "/img/host" }, { runner }).check("alice", SECRET), "ok");
  assert.equal(seen.length, 1);
  const [root, dir, name, args, opts] = seen[0]!.args as [string, string, string, string[], Record<string, unknown>];
  assert.deepEqual([root, dir, name, args], ["/host", "/img/host", "filedeck-pam", ["filedeck-x", "alice"]]);
  assert.deepEqual(opts.stdin, Buffer.from(SECRET, "utf8"));
  assert.deepEqual(opts.keepCaps, ["dac_read_search"]);
  assert.equal(opts.asRoot, true);
  assert.equal(opts.allowMetadata, true);
  assert.equal(typeof opts.timeoutMs, "number");
  const { stdin: _stdin, ...rest } = opts;
  assert.ok(!JSON.stringify([root, dir, name, args, rest]).includes(SECRET), "the password is only in stdin");
});

test("each exit code maps to a result", async () => {
  const want: [number | null, PamResult][] = [
    [0, "ok"],
    [1, "fail"],
    [2, "fail"],
    [3, "fail"],
    [4, "unknown"],
    [5, "unavailable"],
    [6, "refused"],
    [64, "unavailable"],
    [71, "unavailable"],
    [127, "unavailable"],
    [null, "unavailable"],
  ];
  for (const [code, result] of want) assert.equal(await fake(code).pam.check("alice", SECRET), result, `exit ${code}`);
  const thrown = fake(() => Promise.reject(new Error("launcher missing")));
  assert.equal(await thrown.pam.check("alice", SECRET), "unavailable");
});

test("a helper that does not answer in time gives unavailable", async () => {
  const t0 = Date.now();
  const { pam } = fake(() => new Promise(() => {}));
  assert.equal(await pam.check("alice", SECRET), "unavailable");
  assert.ok(Date.now() - t0 < 2000);
});

test("a name that is not a valid system name is unknown and nothing runs", async () => {
  const { pam, calls } = fake(0);
  for (const n of ["", "-x", "a/b", "..", "a b", "a\nb", "x".repeat(65), "röot"]) assert.equal(await pam.check(n, SECRET), "unknown", JSON.stringify(n));
  assert.equal(calls.length, 0);
});

test("second prompt fails", async () => {
  const log: string[] = [];
  const { pam } = fake(3, log);
  assert.equal(await pam.check("alice", SECRET), "fail");
  assert.deepEqual(log, [SECOND_PROMPT]);
  assert.ok(!log.join("\n").includes(SECRET));
});

test("a 1025-byte password is sent as it is: the helper cuts it, not the caller", async () => {
  const { pam, calls } = fake(0);
  const long = "p".repeat(1025);
  await pam.check("alice", long);
  assert.equal(calls[0]!.stdin.length, 1025);
  assert.deepEqual(calls[0]!.stdin, Buffer.from(long));
});

test("at most 4 helpers run at once; a call over the limit waits, and the time limit still bounds it", async () => {
  let running = 0;
  let most = 0;
  let calls = 0;
  const gates: (() => void)[] = [];
  const pam = new HostPam({
    run: async () => {
      calls++;
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => gates.push(r));
      running--;
      return { code: 0 };
    },
    log: () => {},
    timeoutMs: 5000,
  });
  const all = Array.from({ length: 6 }, () => pam.check("alice", SECRET));
  await sleep(50);
  assert.equal(calls, 4, "two wait for a place");
  while (gates.length || calls < 6) {
    gates.shift()?.();
    await sleep(5);
  }
  assert.deepEqual(await Promise.all(all), Array(6).fill("ok"));
  assert.equal(most, 4);

  // the limit counts against the time limit: a call that waits too long is unavailable and never runs
  let started = 0;
  const stuck = new HostPam({ run: () => (started++, new Promise(() => {})), log: () => {}, timeoutMs: 100 });
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => stuck.check("alice", SECRET))), Array(5).fill("unavailable"));
  await sleep(150);
  assert.equal(started, 4, "the fifth gave up while it waited");
});

test("an unavailable helper is logged with its reason, never the password", async () => {
  const log: string[] = [];
  const pam = new HostPam({ run: async () => ({ code: 5, stderr: "filedeck-pam: no PAM service file for filedeck\n" }), log: (s) => log.push(s) });
  assert.equal(await pam.check("alice", SECRET), "unavailable");
  assert.equal(log.length, 1);
  assert.match(log[0]!, /^pam: unavailable \(exit 5: filedeck-pam: no PAM service file for filedeck\)$/);
});

/**
 * Live, against this machine's own PAM: needs root (the chroot, and the PAM service files written in /etc/pam.d) and glibc.
 * `FILEDECK_REQUIRE_HOST_HELPERS=1` turns the glibc skip into a failure. A small PAM module built here plays the odd stacks: a second
 * prompt (a one-time code), an echo-on prompt, an information message, a check of what the helper sent, and a slow one.
 */
const SERVICES: Record<string, string> = {
  "filedeck-test-ok": "auth required pam_permit.so\naccount required pam_permit.so\n",
  "filedeck-test-deny": "auth required pam_deny.so\naccount required pam_deny.so\n",
};
const MOD_SERVICES = (mod: string): Record<string, string> => ({
  "filedeck-test-twice": `auth required ${mod} twice\naccount required pam_permit.so\n`,
  "filedeck-test-echo": `auth required ${mod} echo\naccount required pam_permit.so\n`,
  "filedeck-test-info": `auth required ${mod} info\naccount required pam_permit.so\n`,
  "filedeck-test-check": `auth required ${mod} check=abc\naccount required pam_permit.so\n`,
  "filedeck-test-len": `auth required ${mod} len=1024\naccount required pam_permit.so\n`,
  "filedeck-test-acct": `auth required pam_permit.so\naccount required ${mod} expired\n`,
  "filedeck-test-sleep": `auth required ${mod} sleep\naccount required pam_permit.so\n`,
  "filedeck-test-dumpable": `auth required ${mod} undumpable\naccount required pam_permit.so\n`,
  "filedeck-test-delay": `auth required ${mod} delay\naccount required pam_permit.so\n`,
});
const written: string[] = [];
after(() => {
  for (const f of written) fs.rmSync(f, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FILEDECK_SANDBOX_HELPER;
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
});

const MODULE = String.raw`
#include <security/pam_appl.h>
#include <security/pam_modules.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>
static int ask(pam_handle_t *h, int style, const char *text, char **out) {
  const struct pam_conv *conv = NULL;
  if (pam_get_item(h, PAM_CONV, (const void **)&conv) != PAM_SUCCESS || !conv) return PAM_CONV_ERR;
  struct pam_message m = { style, text };
  const struct pam_message *mp = &m;
  struct pam_response *r = NULL;
  int rc = conv->conv(1, &mp, &r, conv->appdata_ptr);
  if (rc != PAM_SUCCESS) return rc;
  *out = r ? r->resp : NULL;
  free(r);
  return PAM_SUCCESS;
}
PAM_EXTERN int pam_sm_authenticate(pam_handle_t *h, int flags, int argc, const char **argv) {
  const char *mode = argc > 0 ? argv[0] : "";
  char *pw = NULL;
  if (!strcmp(mode, "echo")) return ask(h, PAM_PROMPT_ECHO_ON, "Name: ", &pw) == PAM_SUCCESS ? PAM_SUCCESS : PAM_AUTH_ERR;
  if (!strcmp(mode, "info")) { char *x = NULL; if (ask(h, PAM_TEXT_INFO, "hello", &x) != PAM_SUCCESS) return PAM_AUTH_ERR; free(x); }
  if (ask(h, PAM_PROMPT_ECHO_OFF, "Password: ", &pw) != PAM_SUCCESS) return PAM_AUTH_ERR;
  int ok = 0;
  if (!strcmp(mode, "twice")) { char *code = NULL; ok = ask(h, PAM_PROMPT_ECHO_OFF, "One-time code: ", &code) == PAM_SUCCESS; free(code); }
  else if (!strncmp(mode, "check=", 6)) ok = pw && !strcmp(pw, mode + 6);
  else if (!strncmp(mode, "len=", 4)) ok = pw && strlen(pw) == (size_t)atoi(mode + 4);
  else if (!strcmp(mode, "sleep")) { sleep(2); ok = 1; }
  else if (!strcmp(mode, "info")) ok = 1;
  else if (!strcmp(mode, "undumpable")) ok = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0;
  else if (!strcmp(mode, "delay")) { pam_fail_delay(h, 2000000); ok = 0; }
  free(pw);
  return ok ? PAM_SUCCESS : PAM_AUTH_ERR;
}
PAM_EXTERN int pam_sm_setcred(pam_handle_t *h, int flags, int argc, const char **argv) { return PAM_SUCCESS; }
PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t *h, int flags, int argc, const char **argv) {
  return argc > 0 && !strcmp(argv[0], "expired") ? PAM_ACCT_EXPIRED : PAM_SUCCESS;
}
`;

let setup: Promise<{ built: string }> | undefined;
function liveSetup() {
  setup ??= (async () => {
    await useSandbox();
    const out = path.join(tmp, "native");
    const b = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/build-native.mjs"), out], { encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const built = path.join(out, "host");
    assert.ok(fs.existsSync(path.join(built, "filedeck-pam")), `build-native did not build filedeck-pam: ${b.stdout}`);
    const src = path.join(tmp, "pam_filedeck_test.c");
    fs.writeFileSync(src, MODULE, { mode: 0o644 });
    const mod = path.join(tmp, "pam_filedeck_test.so");
    const c = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", mod, src, "-lpam"], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
    for (const [name, body] of Object.entries({ ...SERVICES, ...MOD_SERVICES(mod) })) {
      const f = path.join("/etc/pam.d", name);
      fs.writeFileSync(f, body, { mode: 0o644 });
      written.push(f);
    }
    return { built };
  })();
  return setup;
}

const live = (name: string, fn: (h: { built: string }) => Promise<void>) =>
  test(name, { skip: ROOT_ONLY }, async (t) => {
    if (!GLIBC) {
      if (process.env.FILEDECK_REQUIRE_HOST_HELPERS) throw new Error(`host helpers required but this is not a glibc system: ${(ldd.stdout || ldd.stderr || String(ldd.error)).trim().split("\n")[0]}`);
      return t.skip("host helpers live: skipped (no glibc here)");
    }
    await fn(await liveSetup());
  });

const cfgFor = (service: string) => ({ ...loadConfig({ FILEDECK_ROOT: "/", FILEDECK_AUTH: "on" }), pamService: service });
const pamFor = (built: string, service: string, log?: string[]) => hostPam(cfgFor(service), { root: "/", dir: built }, { log: (s) => log?.push(s) });
const raw = (built: string, args: string[], stdin = "x") => runHostHelper("/", built, "filedeck-pam", args, { stdin: Buffer.from(stdin), asRoot: true, keepCaps: ["dac_read_search"], allowMetadata: true });

live("filedeck-pam: permit gives ok, deny gives fail, root and an unknown name are unknown, a missing service is never ok", async ({ built }) => {
  assert.equal(await pamFor(built, "filedeck-test-ok").check("nobody", SECRET), "ok");
  assert.equal(await pamFor(built, "filedeck-test-deny").check("nobody", SECRET), "fail");
  // the helper itself sees uid 0 (whatever an agent's cached lookup said) and refuses, so the hub stops
  assert.equal(await pamFor(built, "filedeck-test-ok").check("root", SECRET), "refused");
  assert.equal(await pamFor(built, "filedeck-test-ok").check("no-such-user-xyz", SECRET), "unknown");
  assert.notEqual(await pamFor(built, "filedeck-test-missing-xyz").check("nobody", SECRET), "ok");
  // the raw codes
  assert.equal((await raw(built, ["filedeck-test-ok", "nobody"])).code, 0);
  assert.equal((await raw(built, ["filedeck-test-deny", "nobody"])).code, 1);
  assert.equal((await raw(built, ["filedeck-test-acct", "nobody"])).code, 2);
  assert.equal((await raw(built, ["filedeck-test-ok", "root"])).code, 6);
  assert.equal((await raw(built, ["filedeck-test-ok", "no-such-user-xyz"])).code, 4);
  assert.equal((await raw(built, ["filedeck-test-missing-xyz", "nobody"])).code, 5);
  for (const bad of [[], ["filedeck-test-ok"], ["filedeck-test-ok", "nobody", "x"], ["../passwd", "nobody"], ["filedeck-test-ok", "-nobody"], ["", "nobody"]]) {
    assert.equal((await raw(built, bad)).code, 64, JSON.stringify(bad));
  }
});

live("second prompt fails: a one-time code after the password, or an echo-on question, fails at once with a log line", async ({ built }) => {
  for (const service of ["filedeck-test-twice", "filedeck-test-echo"]) {
    const log: string[] = [];
    const t0 = Date.now();
    assert.equal(await pamFor(built, service, log).check("nobody", SECRET), "fail", service);
    assert.ok(Date.now() - t0 < 5000, "no hang");
    assert.deepEqual(log, [SECOND_PROMPT]);
    assert.equal((await raw(built, [service, "nobody"])).code, 3);
  }
  // an information message is not a question
  assert.equal(await pamFor(built, "filedeck-test-info").check("nobody", SECRET), "ok");
});

live("the password ends at the first newline and at 1024 bytes; the account stage can refuse", async ({ built }) => {
  assert.equal(await pamFor(built, "filedeck-test-check").check("nobody", "abc\nzzz"), "ok");
  assert.equal(await pamFor(built, "filedeck-test-check").check("nobody", "abcd"), "fail");
  assert.equal(await pamFor(built, "filedeck-test-len").check("nobody", "p".repeat(1025)), "ok");
  assert.equal(await pamFor(built, "filedeck-test-len").check("nobody", "p".repeat(1023)), "fail");
  assert.equal(await pamFor(built, "filedeck-test-acct").check("nobody", SECRET), "fail");
  // an empty password never reaches the stack as a success through a null token
  assert.equal(await pamFor(built, "filedeck-test-check").check("nobody", ""), "fail");
});

live("PAM's own failure delay is switched off: a failed attempt answers at once (the hub's floor is the one delay)", async ({ built }) => {
  const t0 = performance.now();
  assert.equal(await pamFor(built, "filedeck-test-delay").check("nobody", SECRET), "fail");
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `the helper waited ${Math.round(ms)} ms after a failure that asked for a 2 s delay`);
});

live("the helper is not dumpable while PAM holds the password (no core file can hold it)", async ({ built }) => {
  assert.equal(await pamFor(built, "filedeck-test-dumpable").check("nobody", SECRET), "ok");
});

live("the password is not in the helper's arguments, its environment or any log line", async ({ built }) => {
  const log: string[] = [];
  const pending = pamFor(built, "filedeck-test-sleep", log).check("nobody", SECRET);
  let found: { cmdline: string; environ: string } | undefined;
  for (let i = 0; i < 150 && !found; i++) {
    for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let cmdline: string;
      try {
        cmdline = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (!cmdline.includes("filedeck-pam") || !cmdline.includes("filedeck-test-sleep") || cmdline.includes("--exec-outside")) continue; // (the helper itself, not the launcher before its exec)
      try {
        found = { cmdline, environ: await fs.promises.readFile(`/proc/${pid}/environ`, "utf8") };
      } catch {
        continue;
      }
      break;
    }
    if (!found) await sleep(10);
  }
  assert.equal(await pending, "ok", log.join("\n"));
  assert.ok(found, "the helper was seen while it ran");
  assert.ok(found.cmdline.split("\0").includes("nobody"));
  assert.ok(!found.cmdline.includes(SECRET), "not in argv");
  assert.ok(!found.environ.includes(SECRET), "not in the environment");
  assert.deepEqual(found.environ.split("\0").filter(Boolean), ["PATH=/usr/bin:/bin"]);
  assert.ok(!log.join("\n").includes(SECRET));
  const r = await raw(built, ["filedeck-test-deny", "nobody"], SECRET);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), "not in the helper's own output");
});
