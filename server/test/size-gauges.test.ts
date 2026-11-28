import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { PodTable, PodWatch, ApiStatusError, toPodInfo, type PodInfo, type PodOpener } from "../src/pod-watch.ts";
import { overlayUppers, parseSizeGauges, podParts, sizeGaugeLines, type StoredSize } from "../src/size-gauges.ts";
import type { Jobs } from "../src/jobs.ts";
import { fakeResolver } from "./worker-env.ts";

const token = "fixture-agent-token";
const headers = { authorization: `Bearer ${token}` };
const ID1 = "a".repeat(64);
const ID2 = "b".repeat(64);

type App = ReturnType<typeof createAgent> & { close(): Promise<void>; jobs: Jobs };

async function fixture(t: TestContext, extra: Record<string, string> = {}, pods?: PodInfo[]) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "size-gauges-"));
  const root = path.join(tmp, "root");
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "one.bin"), Buffer.alloc(20_000, 1));
  await fs.writeFile(path.join(root, "data", "two.bin"), Buffer.alloc(5_000, 2));
  const mounts = path.join(tmp, "mounts");
  await fs.writeFile(mounts, "/dev/sample / ext4 rw 0 0\n");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const app = createAgent(
    loadConfig({ FILEDECK_NODE: "n1", FILEDECK_ROOT: root, FILEDECK_PROC_MOUNTS: mounts, FILEDECK_EVENTS_JOURNAL_BYTES: "0", FILEDECK_AGENT_TOKEN: token, ...extra } as NodeJS.ProcessEnv),
    () => {},
    { accounts: fakeResolver(), ...(pods ? { pods: { list: () => pods, synced: () => true } } : {}) },
  ) as App;
  t.after(() => app.close());
  const scrape = async () => (await app.request("/metrics")).text();
  return { tmp, root, mounts, app, scrape };
}

const series = (text: string, name: string) => text.split("\n").filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));

test("filedeck_path_bytes equals the du answer for the same path", async (t) => {
  const { app, scrape } = await fixture(t, { FILEDECK_SIZE_GAUGES: "/data" });
  const du = (await (await app.request("/api/du?path=/data&depth=0", { headers })).json()) as { entries: { path: string; diskBytes: number }[] };
  const want = du.entries.find((e) => e.path === "/data")!.diskBytes;
  assert.ok(want > 0);
  const lines = series(await scrape(), "filedeck_path_bytes");
  assert.equal(lines.length, 1);
  // (no fanotify here, so the store cannot vouch for the row: it keeps its value and says stale)
  assert.match(lines[0]!, /^filedeck_path_bytes\{node="n1",path="\/data"(,stale="true")?\} \d+$/);
  assert.equal(Number(lines[0]!.split(" ").pop()), want);
});

test("a path the store does not hold gives no series, and a scrape starts no job and no walk", async (t) => {
  const { app, scrape } = await fixture(t, { FILEDECK_SIZE_GAUGES: "/data\n/nowhere" });
  const before = app.jobs.list().length;
  const first = await scrape();
  assert.deepEqual(series(first, "filedeck_path_bytes"), []);
  assert.deepEqual(series(first, "filedeck_path_bytes_missing"), ["filedeck_path_bytes_missing 2"]);
  const second = await scrape();
  assert.deepEqual(series(second, "filedeck_path_bytes"), [], "the scrape stored nothing: it walked nothing");
  assert.equal(app.jobs.list().length, before);
  assert.equal((await app.request("/api/du?path=/data&depth=0", { headers })).status, 200);
  assert.equal(series(await scrape(), "filedeck_path_bytes").length, 1);
  assert.deepEqual(series(await scrape(), "filedeck_path_bytes_missing"), ["filedeck_path_bytes_missing 1"]);
});

test("without settings the metrics carry no path or pod series", async (t) => {
  const { scrape } = await fixture(t);
  const text = await scrape();
  assert.ok(!text.includes("filedeck_path_bytes"));
  assert.ok(!text.includes("agent_resource_pod_ephemeral_storage_used_bytes"));
});

test("FILEDECK_SIZE_GAUGES refuses a relative path", () => {
  assert.throws(() => parseSizeGauges("data"), /not an absolute path/);
  assert.deepEqual(parseSizeGauges("/a/b/, /c;/a/b\n"), ["/a/b", "/c"]);
});

const podObject = (uid: string, name: string, ids: string[], rv = "1") => ({
  metadata: { uid, name, namespace: "agents", resourceVersion: rv },
  spec: {
    volumes: [
      { name: "work", emptyDir: {} },
      { name: "ram", emptyDir: { medium: "Memory" } },
      { name: "cfg", configMap: { name: "x" } },
      { name: "sec", secret: { secretName: "s" } },
    ],
  },
  status: { containerStatuses: ids.map((i) => ({ containerID: `containerd://${i}` })), initContainerStatuses: [{ containerID: "containerd://" + "c".repeat(64) }] },
});

test("the pod watch maps uid to namespace and pod, and counts only the volumes kubelet counts", () => {
  const p = toPodInfo(podObject("uid-1", "agent-run-1", [ID1]))!;
  assert.equal(p.uid, "uid-1");
  assert.equal(p.namespace, "agents");
  assert.equal(p.name, "agent-run-1");
  assert.deepEqual(p.containerIds, ["c".repeat(64), ID1]);
  assert.deepEqual(p.volumes, [
    { plugin: "kubernetes.io~empty-dir", name: "work" },
    { plugin: "kubernetes.io~configmap", name: "cfg" },
  ]);
});

function opener(script: { list: unknown[]; watch: unknown[][] }) {
  const paths: string[] = [];
  let watches = 0;
  const open: PodOpener = async (p) => {
    paths.push(p);
    if (!p.includes("watch=1")) return (async function* () { yield new TextEncoder().encode(JSON.stringify({ metadata: { resourceVersion: "10" }, items: script.list })); })();
    const events = script.watch[Math.min(watches++, script.watch.length - 1)]!;
    return (async function* () { for (const e of events) yield new TextEncoder().encode(JSON.stringify(e) + "\n"); })();
  };
  return { open, paths };
}

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(f(), "condition not reached"); };

test("the pod watch lists with the node selector, follows events, and a replaced pod is a new uid", async () => {
  const { open, paths } = opener({
    list: [podObject("uid-1", "agent-run-1", [ID1])],
    watch: [[
      { type: "BOOKMARK", object: { metadata: { resourceVersion: "11" } } },
      { type: "DELETED", object: podObject("uid-1", "agent-run-1", [ID1], "12") },
      { type: "ADDED", object: podObject("uid-2", "agent-run-1", [ID2], "13") },
    ]],
  });
  const w = new PodWatch({ node: "hq0", open, retryMs: 5 });
  w.start();
  await until(() => w.table.list().some((p) => p.uid === "uid-2"));
  w.close();
  assert.ok(w.synced);
  assert.match(paths[0]!, /fieldSelector=spec\.nodeName%3Dhq0/);
  assert.match(paths[1]!, /watch=1.*resourceVersion=10/);
  assert.deepEqual(w.table.list().map((p) => `${p.namespace}/${p.name}/${p.uid}`), ["agents/agent-run-1/uid-2"]);
});

test("a gone resource version lists again", async () => {
  const { open, paths } = opener({ list: [podObject("uid-1", "p", [ID1])], watch: [[{ type: "ERROR", object: { code: 410 } }], [{ type: "MODIFIED", object: podObject("uid-1", "p", [ID1], "20") }]] });
  const w = new PodWatch({ node: "n", open, retryMs: 5, log: () => {} });
  w.start();
  await until(() => paths.filter((p) => !p.includes("watch=1")).length === 2);
  w.close();
  assert.ok(new ApiStatusError(410).status === 410);
});

test("the table keeps one row per uid", () => {
  const t = new PodTable();
  t.apply("ADDED", podObject("u1", "p", []));
  t.apply("MODIFIED", podObject("u1", "p", [ID1]));
  assert.equal(t.list().length, 1);
  t.apply("DELETED", podObject("u1", "p", []));
  assert.equal(t.list().length, 0);
});

test("overlay mounts map a container id to its writable layer", () => {
  const mounts = [
    `overlay /run/containerd/io.containerd.runtime.v2.task/k8s.io/${ID1}/rootfs overlay rw,relatime,lowerdir=/l/1,upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/7/fs,workdir=/w/7 0 0`,
    `overlay /somewhere/else overlay rw,upperdir=/x,workdir=/y 0 0`,
    `tmpfs /run/containerd/io.containerd.runtime.v2.task/k8s.io/${ID2}/rootfs tmpfs rw 0 0`,
  ].join("\n");
  assert.deepEqual([...overlayUppers(mounts)], [[ID1, "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/7/fs"]]);
});

test("pod gauges add volumes, logs and layers; a missing part or a replaced pod changes the series", async () => {
  const mounts = `overlay /run/containerd/io.containerd.runtime.v2.task/k8s.io/${ID1}/rootfs overlay rw,upperdir=/layers/7/fs,workdir=/w 0 0\n`;
  const sizes = new Map<string, StoredSize>([
    ["/kp/uid-1/volumes/kubernetes.io~empty-dir/work", { bytes: 100, stale: false }],
    ["/kp/uid-1/volumes/kubernetes.io~configmap/cfg", { bytes: 1, stale: false }],
    ["/logs/agents_agent-run-1_uid-1", { bytes: 10, stale: false }],
    ["/layers/7/fs", { bytes: 1000, stale: true }],
  ]);
  const size = async (v: string) => sizes.get(v) ?? null;
  const pod1 = toPodInfo(podObject("uid-1", "agent-run-1", [ID1]))!;
  pod1.containerIds = [ID1];
  let pods = [pod1];
  const run = () => sizeGaugeLines({ node: "n1", paths: [], size, pods: { list: () => pods, synced: () => true, mounts: async () => mounts, podsDir: "/kp", logsDir: "/logs" } });
  const a = (await run()).join("\n");
  const labels = 'node="n1",namespace="agents",pod="agent-run-1",pod_uid="uid-1",stale="true"';
  assert.ok(a.includes(`agent_resource_pod_ephemeral_storage_used_bytes{${labels}} 1111`), a);
  assert.ok(a.includes(`filedeck_pod_ephemeral_storage_bytes{${labels}} 1111`));
  assert.ok(a.includes("filedeck_pod_ephemeral_storage_missing 0"));
  // the pod is replaced: same name, new uid, no stored parts yet: the old series is gone and the new one is missing
  const pod2 = { ...pod1, uid: "uid-2", containerIds: [ID2] };
  pods = [pod2];
  const b = (await run()).join("\n");
  assert.ok(!b.includes('pod_uid="uid-1"'));
  assert.ok(!b.includes('pod_uid="uid-2"'));
  assert.ok(b.includes("filedeck_pod_ephemeral_storage_missing 1"));
  // once its parts are stored it appears under the new uid
  sizes.set("/kp/uid-2/volumes/kubernetes.io~empty-dir/work", { bytes: 5, stale: false });
  sizes.set("/kp/uid-2/volumes/kubernetes.io~configmap/cfg", { bytes: 1, stale: false });
  sizes.set("/logs/agents_agent-run-1_uid-2", { bytes: 2, stale: false });
  const c = (await run()).join("\n");
  assert.ok(c.includes('agent_resource_pod_ephemeral_storage_used_bytes{node="n1",namespace="agents",pod="agent-run-1",pod_uid="uid-2"} 8'), c);
  assert.deepEqual(podParts(pod2, new Map(), "/kp", "/logs").length, 3);
});

test("the agent exports pod ephemeral storage from its own size store, without a walk", async (t) => {
  const pod: PodInfo = { uid: "uid-9", namespace: "agents", name: "agent-run-9", containerIds: [ID1], volumes: [{ plugin: "kubernetes.io~empty-dir", name: "work" }] };
  const { tmp, root, mounts, app, scrape } = await fixture(t, { FILEDECK_POD_STORAGE: "on", FILEDECK_KUBELET_PODS_DIR: "/kp", FILEDECK_POD_LOGS_DIR: "/logs" }, [pod]);
  await fs.mkdir(path.join(root, "kp/uid-9/volumes/kubernetes.io~empty-dir/work"), { recursive: true });
  await fs.mkdir(path.join(root, "logs/agents_agent-run-9_uid-9"), { recursive: true });
  await fs.mkdir(path.join(root, "layers/7/fs"), { recursive: true });
  await fs.writeFile(path.join(root, "kp/uid-9/volumes/kubernetes.io~empty-dir/work/f"), Buffer.alloc(8192, 1));
  await fs.writeFile(path.join(root, "layers/7/fs/g"), Buffer.alloc(4096, 1));
  await fs.writeFile(mounts, `overlay /run/containerd/io.containerd.runtime.v2.task/k8s.io/${ID1}/rootfs overlay rw,upperdir=/layers/7/fs,workdir=/w 0 0\n`);
  const before = app.jobs.list().length;
  assert.deepEqual(series(await scrape(), "agent_resource_pod_ephemeral_storage_used_bytes"), []);
  assert.equal(app.jobs.list().length, before);
  const du = async (p: string) => ((await (await app.request(`/api/du?path=${p}&depth=0`, { headers })).json()) as { entries: { path: string; diskBytes: number }[] }).entries.find((e) => e.path === p)!.diskBytes;
  const want = (await du("/kp/uid-9/volumes/kubernetes.io~empty-dir/work")) + (await du("/logs/agents_agent-run-9_uid-9")) + (await du("/layers/7/fs"));
  const lines = series(await scrape(), "agent_resource_pod_ephemeral_storage_used_bytes");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^agent_resource_pod_ephemeral_storage_used_bytes\{node="n1",namespace="agents",pod="agent-run-9",pod_uid="uid-9"(,stale="true")?\} \d+$/);
  assert.equal(Number(lines[0]!.split(" ").pop()), want);
  void tmp;
});
