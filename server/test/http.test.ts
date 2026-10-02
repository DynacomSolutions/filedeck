import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { parseMounts } from "../src/mounts.ts";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

let tmp: string, agentSrv: ReturnType<typeof serve>, hubSrv: ReturnType<typeof serve>, hub: string;

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-http-")));
  fs.writeFileSync(path.join(tmp, "v.bin"), Buffer.from("0123456789"));
  const cfg = loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t" } as never);
  const open = (app: { fetch: never }) =>
    new Promise<ReturnType<typeof serve>>((res) => {
      const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    });
  agentSrv = await open(createAgent(cfg) as never);
  const aport = (agentSrv.address() as AddressInfo).port;
  hubSrv = await open(
    createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=http://127.0.0.1:${aport}`, FILEDECK_STATIC: tmp } as never)) as never,
  );
  hub = `http://127.0.0.1:${(hubSrv.address() as AddressInfo).port}`;
});
after(() => {
  agentSrv.close();
  hubSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("hub lists nodes and proxies range reads", async () => {
  const n = (await (await fetch(`${hub}/api/nodes`)).json()) as { nodes: { name: string; online: boolean }[] };
  assert.deepEqual(n.nodes, [{ name: "t", online: true }]);
  const r = await fetch(`${hub}/api/nodes/t/api/fs/read?path=/v.bin`, { headers: { range: "bytes=2-4" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "234");
  assert.equal(r.headers.get("content-range"), "bytes 2-4/10");
});

test("upload (streamed), traversal rejected, trash via hub", async () => {
  const up = await fetch(`${hub}/api/nodes/t/api/fs/upload?dir=/&name=up.txt`, { method: "PUT", body: "hello" });
  assert.equal(up.status, 201);
  assert.equal(fs.readFileSync(path.join(tmp, "up.txt"), "utf8"), "hello");
  const bad = await fetch(`${hub}/api/nodes/t/api/fs/list?path=/../..`);
  assert.equal(bad.status, 400);
  const bad2 = await fetch(`${hub}/api/nodes/t/api/fs/upload?dir=/&name=..%2Fx`, { method: "PUT", body: "x" });
  assert.equal(bad2.status, 400);
  const tr = await fetch(`${hub}/api/nodes/t/api/fs/trash`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ["/up.txt"] }),
  });
  assert.equal(tr.status, 200);
  assert.equal(fs.existsSync(path.join(tmp, "up.txt")), false);
});

test("unknown node 404", async () => {
  assert.equal((await fetch(`${hub}/api/nodes/nope/api/fs/list`)).status, 404);
});

test("live feed emits a change event", async () => {
  const ctl = new AbortController();
  const r = await fetch(`${hub}/api/nodes/t/api/events?path=/`, { signal: ctl.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (needle: string) => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += dec.decode(value);
    }
  };
  await until("event: ready");
  fs.writeFileSync(path.join(tmp, "new.txt"), "x");
  await until("event: change");
  ctl.abort();
});

test("parseMounts filters pseudo filesystems and decodes escapes", () => {
  const m = parseMounts(
    ["/dev/sda1 / ext4 rw 0 0", "proc /proc proc rw 0 0", "tmpfs /run tmpfs rw 0 0", "/dev/sdb1 /mnt/my\\040disk xfs rw 0 0", "overlay /var/lib/x overlay rw 0 0"].join("\n"),
  );
  assert.deepEqual(m.map((x) => x.mountpoint), ["/", "/mnt/my disk"]);
});

test("hub fills branding into index.html and ignores logo and links", async () => {
  fs.writeFileSync(path.join(tmp, "index.html"), "<title>%%TITLE%%</title><link href=\"%%ICON%%\">%%BRANDCSS%%<script>%%BOOT%%</script>");
  const mk = async (env: Record<string, string>) => {
    const s = await new Promise<ReturnType<typeof serve>>((res) => {
      const x: ReturnType<typeof serve> = serve({ fetch: createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, ...env } as never)).fetch as never, port: 0 }, () => res(x));
    });
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const html = await (await fetch(url + "/")).text();
    const deep = await (await fetch(url + "/some/route")).text();
    s.close();
    return { html, deep };
  };
  const neutral = await mk({});
  assert.match(neutral.html, /<title>Filedeck<\/title>/);
  assert.ok(!neutral.html.includes("links"));
  assert.match(neutral.html, /"themeKey":"filedeck-theme"/);
  assert.equal(neutral.deep, neutral.html);
  const branded = await mk({ FILEDECK_BRAND: JSON.stringify({ name: "Acme <b>", links: [{ label: "Docs", url: "https://docs.example/" }], logo: { light: "/l.svg", dark: "/d.svg" }, icon: "javascript:alert(1)", themeKey: "acme-theme", css: "/assets/brand/theme.css" }) });
  assert.match(branded.html, /<title>Acme &#60;b&#62;<\/title>/);
  assert.ok(!branded.html.includes("docs.example") && !branded.html.includes("/l.svg"));
  assert.ok(!branded.html.includes("javascript:"));
  assert.ok(!branded.html.includes("<b>"));
  assert.match(branded.html, /"themeKey":"acme-theme"/);
  assert.match(branded.html, /<link rel="stylesheet" href="\/assets\/brand\/theme.css" \/>/);
});
