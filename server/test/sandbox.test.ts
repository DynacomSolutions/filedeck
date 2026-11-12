import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
