import assert from "node:assert/strict";
import test from "node:test";
import { dispositionName, fsChanged, noteSources, onFsChanged, onOpFinished, zipFitsInUrl, zipPost, ZIP_URL_LIMIT } from "../src/api.ts";

test("zip download: short selections stay in the URL, long ones do not", () => {
  assert.equal(zipFitsInUrl("n", "/d", ["a", "b"]), true);
  const many = Array.from({ length: 600 }, (_, i) => `file-number-${i}.txt`);
  assert.equal(zipFitsInUrl("n", "/d", many), false);
  assert.ok(ZIP_URL_LIMIT <= 8000);
});

test("dispositionName prefers the UTF-8 name", () => {
  assert.equal(dispositionName(`attachment; filename="a_b.zip"; filename*=UTF-8''a%20b.zip`, "x"), "a b.zip");
  assert.equal(dispositionName(`attachment; filename="plain.zip"`, "x"), "plain.zip");
  assert.equal(dispositionName(null, "files.zip"), "files.zip");
});

test("zipPost sends the names as a JSON body", async () => {
  const real = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("zipbytes", { headers: { "content-disposition": `attachment; filename="d.zip"` } });
  }) as typeof fetch;
  try {
    const r = await zipPost("n", "/d", ["a", "b"]);
    assert.equal(r.name, "d.zip");
    assert.equal(await r.blob.text(), "zipbytes");
    assert.equal(seen?.init.method, "POST");
    assert.equal((seen?.init.headers as Record<string, string>)["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(seen?.init.body)), { dir: "/d", names: ["a", "b"] });
    assert.match(seen?.url ?? "", /\/api\/fs\/zip$/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 })) as typeof fetch;
    await assert.rejects(zipPost("n", "/d", ["a"]), /nope/);
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
