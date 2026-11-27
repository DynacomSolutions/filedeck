import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MacWatch } from "../src/macwatch.ts";
import { EventBus } from "../src/events/bus.ts";
import { Filter } from "../src/events/filter.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FSEvents (Node's recursive fs.watch) says "change" or "rename" and a name. The mapping onto the bus is tried here by handing the watcher
// those notices, so the test does not depend on the inotify limits of the machine that runs it.
test("macOS watcher: FSEvents notices become bus events as best effort (a rename is a create when the entry exists, a delete when it does not)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "macwatch-")));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "dir"));
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  const bus = new EventBus({ node: "m", journal: { dir: null } });
  const w = new MacWatch({ applyChanged: async () => {}, markStale: () => {} }, { root, procMounts: path.join(root, "none"), bus });
  try {
    const notice = (w as unknown as { publish(event: string, p: string): void }).publish.bind(w);
    notice("rename", path.join(root, "dir")); // exists, a folder
    notice("rename", path.join(root, "file.txt")); // exists, a file
    notice("rename", path.join(root, "gone.txt")); // missing
    notice("change", path.join(root, "file.txt"));
    notice("change", "/elsewhere/outside"); // not under the served root
    await sleep(100);
    await bus.whenServing();
    const sub = await bus.subscribe(new Filter(), bus.cursorOf(0), "internal");
    const seen: [string, boolean, string | undefined][] = [];
    for (;;) {
      const b = await Promise.race([sub.next(), sleep(300).then(() => null)]);
      if (!b) break;
      for (const l of b) {
        const e = JSON.parse(l.toString("utf8")) as { kind: string; dir: boolean; path?: string };
        seen.push([e.kind, e.dir, e.path]);
      }
    }
    sub.close();
    const sorted = [...seen].sort((a, b) => String(a[2]).localeCompare(String(b[2])) || a[0].localeCompare(b[0]));
    assert.deepEqual(sorted, [
      ["create", true, "/dir"],
      ["create", false, "/file.txt"],
      ["modify", false, "/file.txt"],
      ["delete", false, "/gone.txt"],
    ]);
  } finally {
    w.stop();
    await bus.close();
  }
});
