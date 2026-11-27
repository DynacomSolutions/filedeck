import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupIO, ioStatistics } from "../src/group-io.ts";
import { parseGroupRules } from "../src/group-rules.ts";
import type { AgentGroups } from "../src/group-agent.ts";

const nodes: AgentGroups[] = [{
  node: "studio", labels: [{ name: "Builds", match: { container: "builder" } }],
  drives: [{
    id: "disk", devices: [{ name: "disk", model: null }], mounts: ["/"],
    usedBytes: 80, capacityBytes: 100, overageBytes: 0,
    groups: [{ name: "Builds", bytes: 60, scannedAt: 99, stale: false, notStored: false, errors: 0, hardLinks: "normal", ioDevices: ["/dev/part"] },
      { name: "Unattributed", bytes: 20, scannedAt: null, stale: false, notStored: false, errors: 0, hardLinks: "unknown", unattributed: true }],
  }],
}];

const labels = { container: 'builder."quoted"\\path', pod: "a+b" };
const configured = new Map([["studio", parseGroupRules(JSON.stringify({
  studio: [{ name: "Builds", paths: ["/builds"], labels }],
}), "studio")]]);

test("resting is the median of the lowest quarter of samples", () => {
  assert.deepEqual(ioStatistics([5, 3, 7, 9, 6, 1, 12, 2]), { min: 1, max: 12, mean: 45 / 8, resting: 1.5 });
  assert.equal(ioStatistics([]), null);
  assert.deepEqual(ioStatistics([0]), { min: 0, max: 0, mean: 0, resting: 0 });
});

test("one range query, single flight, device and label join, and last known sample after error", async () => {
  let calls = 0;
  let now = 10_000_000;
  const io = new GroupIO("https://metrics.example/prefix", async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/prefix/api/v1/query_range");
    assert.equal(init?.method, "POST");
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get("step"), "60");
    const query = params.get("query") ?? "";
    assert.match(query, /node_disk_read_bytes_total/);
    const selector = `{node="studio",container!="",container!="POD",container=${JSON.stringify(labels.container)},pod="a+b"}`;
    assert.ok(query.includes(`container_fs_reads_bytes_total${selector}`));
    assert.ok(query.includes(`container_fs_writes_bytes_total${selector}`));
    assert.ok(query.includes(`container_fs_io_time_seconds_total${selector}`));
    if (calls > 1) return new Response("", { status: 503 });
    const sample = (kind: string, attrs: Record<string, string>, values: string[]) =>
      ({ metric: { node: "studio", filedeck_io_kind: kind, ...attrs }, values: values.map((v, i) => [i, v]) });
    return Response.json({ status: "success", data: { resultType: "matrix", result: [
      sample("drive_read", { device: "disk" }, ["1", "3"]),
      sample("drive_utilisation", { device: "disk" }, ["0.1", "0.6"]),
      sample("group_read", { container: "builder", pod: "a", device: "/dev/part" }, ["10", "20"]),
      sample("group_read", { container: "builder", pod: "a", device: "/dev/part", job: "duplicate" }, ["10", "20"]),
      sample("group_read", { container: "builder", pod: "a", device: "/dev/other" }, ["900", "900"]),
      sample("group_read", { container: "other", pod: "a", device: "/dev/part" }, ["900", "900"]),
      sample("group_write", { container: "builder", pod: "b", device: "/dev/part" }, ["0", "0"]),
      sample("group_read", { node: "another", container: "builder", pod: "a", device: "/dev/part" }, ["800", "800"]),
    ] } });
  }, () => now, ["studio", "another"], configured);
  assert.equal((await io.join(nodes, [], true)).io.status, "disabled");
  assert.equal(calls, 0);
  const [result] = await Promise.all([io.join(nodes, []), io.join(nodes, [])]);
  assert.equal(calls, 1);
  const drive = result.nodes[0]?.drives[0];
  assert.equal(drive?.io?.read?.mean, 2);
  assert.equal(drive?.io?.utilisation?.max, 60);
  assert.equal(drive?.groups[0]?.io?.read?.mean, 15);
  assert.equal(drive?.groups[0]?.io?.write?.max, 0);
  assert.equal(drive?.groups[0]?.io?.utilisation, null);
  assert.equal(drive?.groups[1]?.io, undefined);
  assert.equal(Object.hasOwn(drive!.groups[0]!, "ioDevices"), false);
  now += 59_999;
  await io.join(nodes, []);
  assert.equal(calls, 1);
  now++;
  const stale = await io.join(nodes, []);
  assert.equal(calls, 2);
  assert.equal(stale.io.stale, true);
  assert.equal(stale.io.sampledAt, result.io.sampledAt);
  assert.equal(io.metrics.requests, 2);
  assert.equal(io.metrics.errors, 1);
  assert.equal(io.metrics.lastSuccess, result.io.sampledAt);
});

test("disabled and failed queries have different status", async () => {
  const disabled = new GroupIO(undefined, async () => { throw new Error("unexpected request"); });
  assert.deepEqual((await disabled.join(nodes, [])).io, { status: "disabled" });
  assert.equal(disabled.metrics.requests, 0);
  const failing = new GroupIO("http://metrics.example", async () => Response.json({ status: "error" }));
  assert.deepEqual((await failing.join(nodes, [])).io, { status: "unavailable" });
  assert.equal(failing.metrics.errors, 1);
});

test("no configured labels means no container filesystem queries", async () => {
  let query = "";
  const io = new GroupIO("https://metrics.example", async (_input, init) => {
    query = new URLSearchParams(String(init?.body)).get("query") ?? "";
    return Response.json({ status: "success", data: { resultType: "matrix", result: [] } });
  });
  await io.join(nodes, []);
  assert.match(query, /node_disk_read_bytes_total/);
  assert.doesNotMatch(query, /container_fs_/);
});

test("cancel an oversized streamed response and keep the previous samples", async () => {
  let now = 60_000;
  let calls = 0;
  let cancelled = false;
  let chunks = 0;
  const limit = 256;
  const io = new GroupIO("https://metrics.example", async () => {
    if (++calls === 1) return Response.json({ status: "success", data: { resultType: "matrix", result: [] } });
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 2) controller.enqueue(new Uint8Array(chunks === 1 ? limit : 1));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  }, () => now, [], new Map(), limit);
  assert.equal((await io.join(nodes, [])).io.sampledAt, 60_000);
  now += 60_000;
  const guarded = await io.join(nodes, []);
  assert.deepEqual(guarded.io, { status: "available", sampledAt: 60_000, stale: true });
  assert.equal(cancelled, true);
  assert.match(io.metricLines().join("\n"), /^filedeck_group_io_oversize_responses_total 1$/m);
  assert.equal(io.metrics.errors, 1);
  assert.equal(io.metrics.lastSuccess, 60_000);
});
