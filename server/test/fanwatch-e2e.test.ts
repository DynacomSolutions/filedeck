import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A real agent with the real helper and the real kernel, from the kernel event to a reader of `GET /api/v1/changes`: kinds, paths, labels, the filter, the journal
 * on disk and a second reader that continues from a cursor. Runs as root (CI), or in an unprivileged user namespace on a tmpfs with the test library for
 * `open_by_handle_at` (see fanwatch-live.test.ts), else it is skipped.
 */
const here = import.meta.dirname;
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fane2e-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const bin = path.join(work, "filedeck-fanwatch");
const shim = path.join(work, "shim.so");
const cc = spawnSync("cc", ["-O2", "-o", bin, path.resolve(here, "../native/filedeck-fanwatch.c")], { encoding: "utf8" });
const probe = cc.status === 0 ? spawnSync(bin, [work], { timeout: 1500, encoding: "utf8" }) : null;
const real = !!probe && probe.status !== 2 && probe.status !== 3;
let how: "root" | "userns" | null = null;
let why = cc.status !== 0 ? "no C compiler" : (probe?.stderr.trim() ?? "");
if (cc.status === 0) {
  if (real) how = "root";
  else if (spawnSync("cc", ["-shared", "-fPIC", "-o", shim, path.resolve(here, "fanwatch-shim.c"), "-ldl"], { encoding: "utf8" }).status === 0 && spawnSync("unshare", ["-Urm", "sh", "-c", 'mkdir -p "$1" && mount -t tmpfs tmpfs "$1"', "_", path.join(work, "probe")], { timeout: 5000 }).status === 0) how = "userns";
}
if (!how && process.env.FILEDECK_REQUIRE_FANWATCH) throw new Error("fanwatch e2e required but the helper cannot run: " + why);

test("agent with the real helper: changes reach a reader of /api/v1/changes with labels, filter and journal, and a second reader continues from a cursor", { skip: how ? false : `helper cannot run here: ${why}` }, () => {
  const w = fs.mkdtempSync(path.join(work, "w-"));
  const state = path.join(work, "state");
  const child = path.resolve(here, "fanwatch-e2e-child.ts");
  const node = [process.execPath, "--import", "tsx", child, bin, path.join(w, "tree"), state];
  const r =
    how === "root"
      ? spawnSync(node[0]!, node.slice(1), { encoding: "utf8", timeout: 90_000, cwd: path.resolve(here, "..") })
      : spawnSync("unshare", ["-Urm", "sh", "-c", 'mkdir -p "$1" && mount -t tmpfs tmpfs "$1" && shift && exec "$@"', "_", path.join(w, "tree"), ...node], {
          encoding: "utf8",
          timeout: 90_000,
          cwd: path.resolve(here, ".."),
          env: { ...process.env, LD_PRELOAD: shim, FILEDECK_SHIM_ROOT: path.join(w, "tree") },
        });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as {
    seen: { kind: string; dir: boolean; path: string; from?: string; labels?: Record<string, string> }[];
    again: { kind: string; path: string }[];
    metrics: Record<string, number>;
    journalFiles: string[];
  };
  const tree = path.join(w, "tree", "data");
  const has = (kind: string, p: string, extra: Record<string, unknown> = {}) => out.seen.some((e) => e.kind === kind && e.path === tree + p && Object.entries(extra).every(([k, v]) => JSON.stringify((e as never)[k]) === JSON.stringify(v)));
  assert.ok(has("create", "/red", { dir: true, labels: { team: "red" } }), JSON.stringify(out.seen));
  assert.ok(has("create", "/red/a.txt", { dir: false, labels: { team: "red" } }));
  assert.ok(has("close_write", "/red/a.txt"));
  assert.ok(out.seen.some((e) => e.kind === "move" && e.path === tree + "/red/b.txt" && e.from === tree + "/red/a.txt"));
  assert.ok(has("delete", "/red/b.txt"));
  assert.ok(!out.seen.some((e) => e.kind === "modify"), "the kind filter held");
  assert.ok(!out.seen.some((e) => String(e.path).includes("outside.txt")), "the prefix filter held");
  assert.ok(!out.seen.some((e) => String(e.path).includes("changes-e2e")), "the journal's own writes are not events");
  // the second reader started after the create of a.txt and got what followed it from the journal
  assert.ok(out.again.some((e) => e.kind === "move"), JSON.stringify(out.again));
  assert.ok(out.again.some((e) => e.kind === "delete"));
  assert.ok(!out.again.some((e) => e.kind === "create" && e.path.endsWith("/a.txt")), "it starts after the cursor");
  assert.equal(out.metrics.serving, 1);
  assert.equal(out.metrics.watcherReady, 1);
  assert.ok((out.metrics.journalBytes ?? 0) > 0);
  assert.ok(out.journalFiles.includes("meta.json") && out.journalFiles.some((n) => n.startsWith("seg-")), out.journalFiles.join(","));
});
