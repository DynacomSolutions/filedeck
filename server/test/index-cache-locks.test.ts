import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/index-cache.ts";

const child = path.join(import.meta.dirname, "index-cache-locks-child.ts");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fd-locks-"));

function run(file: string, role: string, onLine?: (l: string) => void): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", child, file, role], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
      onLine?.(String(d));
    });
    c.on("exit", (code, signal) => resolve({ code, signal, out }));
  });
}

// Before the fix, openDb closed a descriptor of the database files. That drops the process's POSIX locks, so the next process rebuilt the
// shared memory file under the first one, which then died with SIGBUS on its next write.
test("a second openDb in one process does not make another process rebuild the shared memory file", async () => {
  for (let i = 0; i < 5; i++) {
    const dir = tmpDir();
    try {
      const file = path.join(dir, "x.db");
      let b: Promise<unknown> | undefined;
      const a = run(file, "a", (l) => {
        if (l.includes("ready") && !b) b = run(file, "b");
      });
      const r = await a;
      await b;
      assert.equal(r.signal, null, `round ${i}: the writer was killed by ${r.signal}`);
      assert.equal(r.code, 0, `round ${i}: ${r.out}`);
      assert.ok(Number(/shm (\d+)/.exec(r.out)?.[1]) >= 32768, `round ${i}: the shared memory file was rebuilt: ${r.out}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("files left with a loose mode are fixed, but not while this process has them open", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "m.db");
    fs.writeFileSync(file, "", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const first = openDb(file)!;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "not open here: fixed");
    first.exec("CREATE TABLE t (x)");
    fs.chmodSync(file, 0o644);
    const second = openDb(file)!;
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, "open here: left alone, no descriptor is closed");
    second.exec("INSERT INTO t VALUES (1)");
    first.close();
    second.close();
    openDb(file)!.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "closed: fixed again");
    for (const x of ["-wal", "-shm"]) if (fs.existsSync(file + x)) assert.equal(fs.statSync(file + x).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
