import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FanWatch } from "../src/fanwatch.ts";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";

/**
 * Bind mounts on the real kernel (root, CAP_SYS_ADMIN). One filesystem (a tmpfs) is shown at several places: whole, and as two bound sub folders. The
 * bind mount points sort before the mount of the whole filesystem, so the first mount of the filesystem by name is a bind with a root that is not "/".
 * A change must be reported under every path that shows it, and nothing else must stop it (a folder size cache that listens to the same events gets
 * every path). CI runs this file as root with FILEDECK_REQUIRE_FANWATCH=1 and FILEDECK_REQUIRE_MOUNT=1, where a skip is a failure.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 15_000) => {
  for (const t0 = Date.now(); !f() && Date.now() - t0 < ms; ) await sleep(20);
};

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fanbind-")));
const bin = path.join(work, "filedeck-fanwatch");
const mounted: string[] = [];
const watchers: FanWatch[] = [];
const buses: EventBus[] = [];
after(async () => {
  for (const w of watchers) w.stop();
  for (const b of buses) await b.close().catch(() => {});
  for (const m of mounted.reverse()) spawnSync("umount", ["-l", m]);
  fs.rmSync(work, { recursive: true, force: true });
});

const cc = spawnSync("cc", ["-O2", "-o", bin, path.resolve(import.meta.dirname, "../native/filedeck-fanwatch.c")], { encoding: "utf8" });
const required = !!process.env.FILEDECK_REQUIRE_FANWATCH;
function cannotWhy(): string {
  if (cc.status !== 0) return "no C compiler";
  if (process.getuid?.() !== 0) return "not running as root";
  const probe = spawnSync(bin, [work], { timeout: 2000, encoding: "utf8" });
  if (probe.status === 2 || probe.status === 3) return probe.stderr.trim();
  return "";
}
const why = cannotWhy();
if (why && required) throw new Error("fanwatch bind test required but cannot run: " + why);
const skip = why ? `helper cannot run here: ${why}` : false;

function mount(args: string[]): void {
  const r = spawnSync("mount", args, { encoding: "utf8" });
  assert.equal(r.status, 0, `mount ${args.join(" ")}: ${r.stderr}`);
}

/** One filesystem with data/one and data/two, `a-bind` = data/one and `b-bind` = data/two, and (when `whole`) the whole filesystem at `zz-whole`. */
function layout(whole: boolean) {
  const base = fs.mkdtempSync(path.join(work, "l-"));
  const a = path.join(base, "a-bind");
  const b = path.join(base, "b-bind");
  const z = path.join(base, "zz-whole");
  for (const d of [a, b, z]) fs.mkdirSync(d);
  mount(["-t", "tmpfs", "tmpfs", z]);
  mounted.push(z);
  fs.mkdirSync(path.join(z, "data/one"), { recursive: true });
  fs.mkdirSync(path.join(z, "data/two"), { recursive: true });
  fs.mkdirSync(path.join(z, "data/other"), { recursive: true });
  mount(["--bind", path.join(z, "data/one"), a]);
  mounted.push(a);
  mount(["--bind", path.join(z, "data/two"), b]);
  mounted.push(b);
  if (!whole) spawnSync("umount", ["-l", z]); // only the two binds show the filesystem now
  const mounts = path.join(base, "mounts");
  const lines = [a, b, ...(whole ? [z] : [])].map((m) => `/dev/test ${m} ext4 rw 0 0`);
  fs.writeFileSync(mounts, lines.join("\n") + "\n");
  return { base, a, b, z, mounts };
}

async function watch(mounts: string) {
  const bus = new EventBus({ node: "n1", journal: { dir: null } });
  buses.push(bus);
  const folders: string[] = [];
  const w = new FanWatch({ applyChanged: async (v: string) => void folders.push(v), markStale: () => {} }, { helper: bin, root: "/", procMounts: mounts, settleMs: 20, modifyMs: 1000, bus });
  watchers.push(w);
  await w.start();
  await until(() => bus.ready);
  assert.equal(bus.ready, true, "the helper is ready");
  return { bus, w, folders };
}

async function held(bus: EventBus): Promise<{ kind: string; path?: string; from?: string }[]> {
  await bus.whenServing();
  const sub = await bus.subscribe(new Filter(), bus.cursorOf(0), "internal");
  const out: { kind: string; path?: string; from?: string }[] = [];
  const head = bus.journal.head;
  while (out.length < head) {
    const batch = await Promise.race([sub.next(), sleep(500).then(() => null)]);
    if (!batch) break;
    for (const x of batch) out.push(JSON.parse(x.toString("utf8")));
  }
  sub.close();
  return out;
}

test("kernel check: what a handle gives through a bind mount for a folder the bind does not show", { skip }, (t) => {
  const l = layout(true);
  const probe = path.join(work, "probe");
  const pc = spawnSync("cc", ["-O2", "-o", probe, path.resolve(import.meta.dirname, "fanwatch-handle-probe.c")], { encoding: "utf8" });
  assert.equal(pc.status, 0, pc.stderr);
  fs.mkdirSync(path.join(l.a, "sub"));
  const ask = (m: string, e: string) => spawnSync(probe, [m, e], { encoding: "utf8" }).stdout.trim();
  const rows = [
    ["inside the bind", l.a, path.join(l.a, "sub")],
    ["outside the bind (the other bind)", l.a, l.b],
    ["outside the bind (a folder only the whole shows)", l.a, path.join(l.z, "data/other")],
    ["the whole through a bind of its own", l.b, path.join(l.z, "data/one/sub")],
    ["the whole, through the whole", l.z, path.join(l.a, "sub")],
  ] as const;
  for (const [what, m, e] of rows) {
    const msg = `${what}: mount ${m} entry ${e} -> ${ask(m, e)}`;
    t.diagnostic(msg);
  }
});

const seen = (ev: { kind: string; path?: string }[], kind: string, p: string) => ev.some((e) => e.kind === kind && e.path === p);

test("bind mounts: a change is reported under every path that shows it, whichever mount is first by name", { skip }, async () => {
  const l = layout(true);
  const r = await watch(l.mounts);
  fs.writeFileSync(path.join(l.a, "in-one.txt"), "1");
  fs.writeFileSync(path.join(l.b, "in-two.txt"), "2");
  fs.mkdirSync(path.join(l.z, "data/other/deep"));
  fs.writeFileSync(path.join(l.z, "data/other/deep/hidden.txt"), "3");
  let ev: { kind: string; path?: string; from?: string }[] = [];
  for (let i = 0; i < 100; i++) {
    ev = await held(r.bus);
    if (seen(ev, "create", path.join(l.b, "in-two.txt")) && seen(ev, "create", path.join(l.z, "data/two/in-two.txt"))) break;
    await sleep(100);
  }
  const all = ev.map((e) => `${e.kind} ${e.path}`).join("\n");
  assert.ok(seen(ev, "create", path.join(l.a, "in-one.txt")), `a-bind path\n${all}`);
  assert.ok(seen(ev, "create", path.join(l.z, "data/one/in-one.txt")), `whole path of a-bind change\n${all}`);
  assert.ok(seen(ev, "create", path.join(l.b, "in-two.txt")), `b-bind path (not the first mount)\n${all}`);
  assert.ok(seen(ev, "create", path.join(l.z, "data/two/in-two.txt")), `whole path of b-bind change\n${all}`);
  assert.ok(seen(ev, "create", path.join(l.z, "data/other/deep/hidden.txt")), `a change that only the whole filesystem shows\n${all}`);
  assert.ok(!ev.some((e) => e.path?.includes("hidden.txt") && (e.path.startsWith(l.a) || e.path.startsWith(l.b))), "no bind shows that entry");
  // the folder size cache is told the folder under every path as well
  await until(() => r.folders.includes(l.b) && r.folders.includes(path.join(l.z, "data/two")));
  assert.ok(r.folders.includes(l.a) && r.folders.includes(l.b), `folders ${JSON.stringify(r.folders)}`);
  assert.ok(r.folders.includes(path.join(l.z, "data/one")) && r.folders.includes(path.join(l.z, "data/two")), `folders ${JSON.stringify(r.folders)}`);
});

test("bind mounts: a rename inside a bind is a move under every path, and a move out of what a bind shows is a delete for that bind", { skip }, async () => {
  const l = layout(true);
  fs.writeFileSync(path.join(l.a, "m.txt"), "m");
  const r = await watch(l.mounts);
  fs.renameSync(path.join(l.a, "m.txt"), path.join(l.a, "n.txt"));
  await sleep(300);
  const ev = await held(r.bus);
  const all = ev.map((e) => `${e.kind} ${e.path} ${e.from ?? ""}`).join("\n");
  assert.ok(ev.some((e) => e.kind === "move" && e.path === path.join(l.a, "n.txt") && e.from === path.join(l.a, "m.txt")), all);
  assert.ok(ev.some((e) => e.kind === "move" && e.path === path.join(l.z, "data/one/n.txt") && e.from === path.join(l.z, "data/one/m.txt")), all);
  // a move on the whole filesystem from a place the first bind shows to a place no bind shows: a move for the whole, a delete for the bind
  fs.renameSync(path.join(l.z, "data/one/n.txt"), path.join(l.z, "data/other/n.txt"));
  await sleep(300);
  const ev2 = (await held(r.bus)).slice(ev.length); // the journal is read from its start: only what the second rename added
  const all2 = ev2.map((e) => `${e.kind} ${e.path} ${e.from ?? ""}`).join("\n");
  assert.ok(ev2.some((e) => e.kind === "delete" && e.path === path.join(l.a, "n.txt")), `delete under the bind that loses it\n${all2}`);
  assert.ok(ev2.some((e) => e.kind === "move" && e.path === path.join(l.z, "data/other/n.txt") && e.from === path.join(l.z, "data/one/n.txt")), `move under the whole filesystem\n${all2}`);
  assert.ok(!ev2.some((e) => e.kind === "move" && e.path?.startsWith(l.a)), "no move under the bind: the entry left it");
});

test("bind mounts: with no mount of the whole filesystem, a change in the second bind is still reported (the mark mount shows only the first bind)", { skip }, async () => {
  const l = layout(false);
  const r = await watch(l.mounts);
  fs.writeFileSync(path.join(l.a, "in-one.txt"), "1");
  fs.mkdirSync(path.join(l.b, "sub"));
  fs.writeFileSync(path.join(l.b, "sub/in-two.txt"), "2");
  let ev: { kind: string; path?: string }[] = [];
  for (let i = 0; i < 100; i++) {
    ev = await held(r.bus);
    if (seen(ev, "create", path.join(l.b, "sub/in-two.txt"))) break;
    await sleep(100);
  }
  const all = ev.map((e) => `${e.kind} ${e.path}`).join("\n");
  assert.ok(seen(ev, "create", path.join(l.a, "in-one.txt")), all);
  assert.ok(seen(ev, "create", path.join(l.b, "sub")), all);
  assert.ok(seen(ev, "create", path.join(l.b, "sub/in-two.txt")), all);
  assert.ok(!ev.some((e) => e.path?.includes("data/")), "paths are the bind paths");
});
