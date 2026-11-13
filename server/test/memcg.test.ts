import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memcgRelief } from "../src/memcg.ts";

test("memcg relief: nothing without a limit or far from it; close to the limit it asks the walk to wait", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memcg-"));
  try {
    const set = (max: string, cur: number) => {
      fs.writeFileSync(path.join(dir, "memory.max"), max + "\n");
      fs.writeFileSync(path.join(dir, "memory.current"), cur + "\n");
    };
    set("max", 1 << 30);
    assert.equal(memcgRelief({ dir, everyMs: 0 })(), false);
    set(String(256 << 20), 100 << 20);
    assert.equal(memcgRelief({ dir, everyMs: 0 })(), false);
    set(String(256 << 20), 250 << 20);
    // close to the limit, but nothing the kernel could free: no charge (it would be the out-of-memory kill), no pause
    fs.writeFileSync(path.join(dir, "memory.stat"), "anon 230000000\nslab_reclaimable 1000000\nactive_file 0\ninactive_file 2000000\n");
    assert.equal(memcgRelief({ dir, everyMs: 0 })(), false);
    // with enough reclaimable slab it charges and asks the walk to wait (the file does not change when the buffer is written: still tight)
    fs.writeFileSync(path.join(dir, "memory.stat"), "anon 90000000\nslab_reclaimable 150000000\nactive_file 0\ninactive_file 0\n");
    assert.equal(memcgRelief({ dir, everyMs: 0 })(), true);
    assert.equal(memcgRelief({ dir: path.join(dir, "missing"), everyMs: 0 })(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
