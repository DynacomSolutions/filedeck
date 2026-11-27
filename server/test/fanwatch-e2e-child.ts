// Run by fanwatch-e2e.test.ts (in an unprivileged user namespace, or as root): a real agent with the real helper, a reader of the event stream, some changes.
// Usage: node --import tsx fanwatch-e2e-child.ts HELPER WORKDIR STATEDIR   (prints one JSON line: what the reader saw, and some metrics)
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const [helper, work, state] = process.argv.slice(2) as [string, string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = path.join(work, "data");
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(state, { recursive: true });
const mounts = path.join(state, "mounts");
// the served root is the work folder and it is the filesystem's top: agent paths are relative to it, wherever the folder is (a temporary folder below
// a runtime folder such as /run/user would be left out of the mount list)
fs.writeFileSync(mounts, "/dev/x / ext4 rw 0 0\n");
const cfg = loadConfig({ FILEDECK_ROOT: work, FILEDECK_NODE: "e2e", FILEDECK_FANWATCH: helper, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_INDEX_DIR: state, FILEDECK_EVENTS_LABELS: "/data/{team}" } as never);
const app = createAgent(cfg) as unknown as { fetch: never; startWatcher(): void; close(): Promise<void>; events: { ready: boolean; whenServing(): Promise<boolean> } };
const server = await new Promise<ReturnType<typeof serve>>((res) => {
  const s: ReturnType<typeof serve> = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
app.startWatcher();
for (let i = 0; i < 200 && !app.events.ready; i++) await sleep(50);
if (!app.events.ready) throw new Error("the watcher did not become ready");
await app.events.whenServing();

const seen: Record<string, unknown>[] = [];
const ctl = new AbortController();
const res = await fetch(`${base}/api/v1/changes?prefix=${encodeURIComponent("/data")}&kind=create&kind=move&kind=delete&kind=close_write`, { signal: ctl.signal });
const reader = res.body!.getReader();
const pump = (async () => {
  let buf = "";
  for (;;) {
    const x = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (x.done) return;
    buf += new TextDecoder().decode(x.value);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      seen.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  }
})();
await sleep(200);
fs.mkdirSync(path.join(data, "red"));
fs.writeFileSync(path.join(data, "red", "a.txt"), "hello");
fs.renameSync(path.join(data, "red", "a.txt"), path.join(data, "red", "b.txt"));
fs.writeFileSync(path.join(work, "outside.txt"), "x"); // not under the prefix
fs.rmSync(path.join(data, "red", "b.txt"));
await sleep(1500);
const first = seen.find((e) => e.kind === "create" && String(e.path).endsWith("/a.txt"));
// a second reader that continues from the cursor of the first event gets the rest from the journal
let again: Record<string, unknown>[] = [];
if (first) {
  const r2 = await fetch(`${base}/api/v1/changes?prefix=${encodeURIComponent("/data")}&since=${encodeURIComponent(String(first.cursor))}`);
  const rd = r2.body!.getReader();
  const t0 = Date.now();
  let buf = "";
  while (Date.now() - t0 < 1500) {
    const x = await Promise.race([rd.read(), sleep(300).then(() => ({ done: true, value: undefined }))]);
    if (x.done) break;
    buf += new TextDecoder().decode(x.value);
  }
  again = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await rd.cancel().catch(() => {});
}
const metrics = await (await fetch(`${base}/metrics`)).text();
const metric = (n: string) => Number(new RegExp(`^${n}(?:\\{[^}]*\\})? (\\S+)$`, "m").exec(metrics)?.[1] ?? NaN);
ctl.abort();
await pump.catch(() => {});
console.log(
  JSON.stringify({
    seen: seen.filter((e) => e.kind !== "ping").map((e) => ({ kind: e.kind, dir: e.dir, path: e.path, from: e.from, labels: e.labels })),
    again: again.filter((e) => e.kind !== "ping").map((e) => ({ kind: e.kind, path: e.path })),
    metrics: { total: metric("filedeck_events_total"), journalBytes: metric("filedeck_events_journal_bytes"), serving: metric("filedeck_events_serving"), hits: metric("filedeck_fanwatch_handle_cache_hits_total"), watcherReady: metric("filedeck_watcher_ready") },
    journalFiles: fs.readdirSync(path.join(state, "changes-e2e")).sort(),
  }),
);
await app.close();
server.close();
(server as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
process.exit(0);
