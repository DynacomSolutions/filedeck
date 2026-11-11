import assert from "node:assert/strict";
import test from "node:test";
import { fsChanged, noteSources, onFsChanged, onOpFinished, zipFitsInUrl, zipTicketUrl, ZIP_URL_LIMIT } from "../src/api.ts";

test("zip download: short selections stay in the URL, long ones do not", () => {
  assert.equal(zipFitsInUrl("n", "/d", ["a", "b"]), true);
  const many = Array.from({ length: 600 }, (_, i) => `file-number-${i}.txt`);
  assert.equal(zipFitsInUrl("n", "/d", many), false);
  assert.ok(ZIP_URL_LIMIT <= 8000);
});

test("a long selection posts its names for a ticket and downloads from a plain GET", async () => {
  const real = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "abc123" }), { status: 201 });
  }) as typeof fetch;
  try {
    const url = await zipTicketUrl("n", "/d", ["a", "b"]);
    assert.match(url, /\/api\/fs\/zip\?ticket=abc123$/);
    assert.match(seen?.url ?? "", /\/api\/fs\/zip-ticket$/);
    assert.equal(seen?.init.method, "POST");
    assert.equal((seen?.init.headers as Record<string, string>)["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(seen?.init.body)), { dir: "/d", names: ["a", "b"] });
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 })) as typeof fetch;
    await assert.rejects(zipTicketUrl("n", "/d", ["a"]), /nope/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a change on a network source refreshes every panel; one on a node only tells the tree", () => {
  noteSources([{ name: "nas", kind: "source" }, { name: "n1", kind: "node" }]);
  const seen: (string | undefined)[] = [];
  let panels = 0;
  const off1 = onFsChanged((n) => seen.push(n));
  const off2 = onOpFinished(() => panels++);
  fsChanged("n1");
  assert.equal(panels, 0);
  fsChanged("nas");
  assert.equal(panels, 1, "sources push no change events, so panels are told");
  assert.deepEqual(seen, ["n1", "nas", undefined], "the job-end refresh reaches the tree as well");
  off1();
  off2();
  noteSources([]);
});
