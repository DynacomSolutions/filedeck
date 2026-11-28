import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The real helper on the real kernel: every kind of change on a watched filesystem, as one line per entry. Needs a C compiler and either
 * CAP_SYS_ADMIN + CAP_DAC_READ_SEARCH (root; CI runs this file as root with FILEDECK_REQUIRE_FANWATCH=1, where a skip is a failure), or an
 * unprivileged user namespace: there the kernel accepts the filesystem mark on a tmpfs the test mounts, but refuses open_by_handle_at, so a
 * small test-only library (fanwatch-shim.c) answers that one call by searching the tree. The path cache and everything else is the real code.
 */
const here = import.meta.dirname;
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fanlive2-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const bin = path.join(work, "filedeck-fanwatch");
const shim = path.join(work, "shim.so");
const cc = spawnSync("cc", ["-O2", "-Wall", "-o", bin, path.resolve(here, "../native/filedeck-fanwatch.c")], { encoding: "utf8" });

type Mode = { how: "root" } | { how: "userns" } | { how: "none"; why: string };
function detect(): Mode {
  if (cc.status !== 0) return { how: "none", why: "no C compiler" };
  const probe = spawnSync(bin, [work], { timeout: 1500, encoding: "utf8" });
  if (probe.status !== 2 && probe.status !== 3) return { how: "root" };
  const sc = spawnSync("cc", ["-shared", "-fPIC", "-o", shim, path.resolve(here, "fanwatch-shim.c"), "-ldl"], { encoding: "utf8" });
  if (sc.status !== 0) return { how: "none", why: probe.stderr.trim() };
  const ns = spawnSync("unshare", ["-Urm", "sh", "-c", "mkdir -p \"$1\" && mount -t tmpfs tmpfs \"$1\"", "_", path.join(work, "probe")], { encoding: "utf8", timeout: 5000 });
  return ns.status === 0 ? { how: "userns" } : { how: "none", why: probe.stderr.trim() };
}
const mode = detect();
if (mode.how === "none" && process.env.FILEDECK_REQUIRE_FANWATCH) throw new Error("fanwatch live test required but helper cannot run: " + mode.why);
const skip = mode.how === "none" ? `helper cannot run here: ${mode.why}` : false;

/** Run a scenario; returns the helper's lines (the work folder stripped) and its stderr. */
function run(scenario: string): { lines: string[]; err: string } {
  const w = fs.mkdtempSync(path.join(work, "s-"));
  const script = path.join(here, "fanwatch-scenario.sh");
  const r =
    mode.how === "root"
      ? spawnSync("bash", [script, scenario, bin, w], { encoding: "utf8", timeout: 60_000 })
      : spawnSync("unshare", ["-Urm", "bash", "-c", 'mount -t tmpfs tmpfs "$1" && shift && exec "$@"', "_", w, "bash", script, scenario, bin, w], {
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, LD_PRELOAD: shim, FILEDECK_SHIM_ROOT: path.join(w, "watched") },
        });
  assert.equal(r.status, 0, r.stderr);
  const [out, err = ""] = r.stdout.split("--- stderr\n");
  const prefix = path.join(w, "watched");
  const strip = (s: string) => s.split(prefix).join("");
  // as root the whole filesystem is watched: only what happened in the work folder counts
  const mine = out!.split("\n").filter((l) => l && (!/^[CDMWAR] [df] /.test(l) || l.includes(prefix)));
  return { lines: strip(mine.join("\n")).split("\n").filter(Boolean), err: strip(err) };
}

test("fanwatch live: create, modify, close, attributes, rename, delete, one line per entry, with the folder flag and the old place of a move", { skip }, () => {
  const { lines, err } = run("basic");
  assert.match(lines[0]!, /^#caps rename=1 target=1 unlimited=[01] cache=\d+ mounts=1$/, "the kernel features are reported");
  assert.equal(lines[1], "#ready 1");
  assert.equal(lines.at(-1), "#sync", "every event the kernel had queued comes before the answer to a sync");
  const has = (l: string) => assert.ok(lines.includes(l), `missing ${JSON.stringify(l)} in\n${lines.join("\n")}`);
  has("C d /a");
  has("C f /a/f.txt");
  has("W f /a/f.txt");
  has("R f /a/g.txt\t/a/f.txt");
  has("C d /a/d");
  has("C f /a/d/x");
  has("R d /b\t/a");
  has("C f /b/d/y"); // after the folder was renamed: the path cache was dropped, the new place is used
  has("A f /b/g.txt");
  has("C f /b/we\\x0aird\\\\name"); // a line break and a backslash in a name are escaped
  has("D f /b/g.txt");
  has("D d /b/d");
  has("D d /b");
  assert.ok(lines.some((l) => /^M f \/a\/f\.txt$/.test(l)), "an ongoing write is reported once");
  assert.ok(!lines.some((l) => l.startsWith("!overflow")), "no overflow");
  assert.equal(err.includes("no FAN_RENAME"), false);
  // the order of one entry's life is kept
  const at = (l: string) => lines.indexOf(l);
  assert.ok(at("C f /a/f.txt") < at("W f /a/f.txt") && at("W f /a/f.txt") < at("R f /a/g.txt\t/a/f.txt"));
});

test("fanwatch live: a tree removed at once is reported (its folders at least), and nothing in it is reported under a wrong place", { skip }, () => {
  const { lines } = run("tree");
  assert.ok(lines.includes("D d /t"), lines.join("\n"));
  for (const l of lines.filter((x) => /^[CDMWAR] /.test(x))) assert.match(l, /^[CDMWAR] [df] \/t(\/|$|\t)/);
  assert.ok(lines.includes("D f /t/u/v/f1") || lines.some((l) => l.startsWith("D ")), "deletes are reported");
});

test("fanwatch live: 1000 files in 20 folders: every create is reported once, and the path cache answers nearly every event", { skip }, () => {
  const { lines } = run("burst");
  const created = lines.filter((l) => /^C f \/dir\d+\/f\d+$/.test(l));
  assert.equal(new Set(created).size, 1000);
  assert.equal(created.length, 1000);
  assert.equal(lines.filter((l) => /^C d \/dir\d+$/.test(l)).length, 20);
  const stats = [...lines].reverse().find((l) => l.startsWith("#stats"));
  // (the stats line comes every few seconds while events flow; the run is shorter, so it may be absent)
  if (stats) {
    const n = Object.fromEntries(stats.slice(7).split(" ").map((kv) => kv.split("=")));
    assert.ok(Number(n.hits) >= Number(n.misses), stats);
  }
});

test("fanwatch live: a file that stays open and is written to is reported at most once a second, and once more when the second ends", { skip }, () => {
  const { lines } = run("trailing");
  const m = lines.filter((l) => l === "M f /log");
  assert.ok(m.length >= 2 && m.length <= 6, `${m.length} modify lines in a 2 s write: ${lines.join(" | ")}`);
  assert.ok(m.length < 20, "not one per write");
});

test("fanwatch live: a mount change prints #mounts within a second, and a quiet mount table prints nothing", { skip }, () => {
  const { lines, err } = run("mounts");
  assert.equal(err.includes("early #mounts"), false, "no #mounts before the mount table changed");
  assert.ok(lines.includes("#mounts"), `no #mounts line in\n${lines.join("\n")}`);
});
