import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { USAGE } from "../src/du-cli.ts";

let work: string;
let srv: ReturnType<typeof serve>;
let base: string;

before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-fid-")));
  fs.writeFileSync(path.join(work, "a.bin"), "12345");
  const app = createAgent(loadConfig({ FILEDECK_ROOT: work, FILEDECK_NODE: "t" } as never), () => {});
  srv = await new Promise((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => {
  srv.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("the file identity used by the password vault includes the device", async () => {
  const st = fs.statSync(path.join(work, "a.bin"));
  const r = await fetch(`${base}/api/fs/fid?path=${encodeURIComponent("/a.bin")}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { fid: `${st.dev}:${st.ino}:${st.size}` });
});

test("du usage text lists both stored-size flags and the interrupt exit status", () => {
  assert.match(USAGE, /\[--fresh \| --cached\]/);
  assert.match(USAGE, /130/);
});
