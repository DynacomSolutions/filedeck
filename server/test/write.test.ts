import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string, outside: string, app: ReturnType<typeof createAgent>;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-write-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-outside-")));
  fs.writeFileSync(path.join(tmp, "a.txt"), "hello\n", { mode: 0o640 });
  fs.writeFileSync(path.join(tmp, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "link-out.txt"));
  fs.mkdirSync(path.join(tmp, ".filedeck-trash"));
  app = createAgent(loadConfig({ FILEDECK_ROOT: tmp, FILEDECK_NODE: "t", FILEDECK_MAX_EDIT: "1000" } as never));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const get = async (p: string) => (await app.request(`/api/fs/text?path=${encodeURIComponent(p)}`)) as Response;
const put = (p: string, body: string | Uint8Array, headers: Record<string, string> = {}, q = "") =>
  app.request(`/api/fs/write?path=${encodeURIComponent(p)}${q}`, { method: "PUT", body: body as BodyInit, headers });

test("text read returns content and etag; binary and oversize refused", async () => {
  const r = await get("/a.txt");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { content: string; etag: string };
  assert.equal(j.content, "hello\n");
  assert.ok(j.etag);
  assert.equal((await get("/bin.dat")).status, 415);
  assert.equal((await get("/missing.txt")).status, 404);
  fs.writeFileSync(path.join(tmp, "big.txt"), "x".repeat(1001));
  assert.equal((await get("/big.txt")).status, 413);
});

test("write with matching etag is atomic, keeps mode, returns new etag", async () => {
  const { etag } = (await (await get("/a.txt")).json()) as { etag: string };
  const r = await put("/a.txt", "changed\n", { "if-match": etag });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { etag: string; size: number };
  assert.equal(j.size, 8);
  assert.notEqual(j.etag, etag);
  assert.equal(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "changed\n");
  assert.equal(fs.statSync(path.join(tmp, "a.txt")).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.endsWith(".part")), []);
  // the returned etag is immediately usable for the next save
  assert.equal((await put("/a.txt", "again\n", { "if-match": j.etag })).status, 200);
});

test("stale etag gives 409 with current etag and leaves the file untouched", async () => {
  const { etag } = (await (await get("/a.txt")).json()) as { etag: string };
  fs.writeFileSync(path.join(tmp, "a.txt"), "external edit, longer\n");
  const r = await put("/a.txt", "mine\n", { "if-match": etag });
  assert.equal(r.status, 409);
  const j = (await r.json()) as { etag: string };
  assert.notEqual(j.etag, etag);
  assert.equal(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "external edit, longer\n");
  // retrying with the fresh etag (explicit overwrite) succeeds
  assert.equal((await put("/a.txt", "mine\n", { "if-match": j.etag })).status, 200);
});

test("If-Match is required; create-only refuses existing files", async () => {
  assert.equal((await put("/a.txt", "x")).status, 428);
  assert.equal((await put("/a.txt", "x", {}, "&create=1")).status, 409);
  assert.equal((await put("/new.txt", "fresh", {}, "&create=1")).status, 200);
  assert.equal(fs.readFileSync(path.join(tmp, "new.txt"), "utf8"), "fresh");
  assert.equal((await put("/nope.txt", "x", { "if-match": "1-1-1" })).status, 404);
});

test("path guard: traversal, symlink escape, trash, directories", async () => {
  assert.equal((await put("/../x.txt", "x", {}, "&create=1")).status, 400);
  assert.equal((await put("/sub/../../x.txt", "x", {}, "&create=1")).status, 400);
  assert.equal((await put("/.filedeck-trash/x.txt", "x", {}, "&create=1")).status, 403);
  assert.equal((await put("/", "x", { "if-match": "1" })).status, 400);
  // an absolute symlink is re-based onto the root, so it can never reach the real target
  const before = fs.readFileSync(path.join(outside, "secret.txt"), "utf8");
  const r = await put("/link-out.txt", "pwned", {}, "&create=1");
  assert.ok([404, 409].includes(r.status), `status ${r.status}`);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(tmp, "x.txt")), false);
});

test("content guards: binary, invalid UTF-8, too large", async () => {
  assert.equal((await put("/c1.txt", new Uint8Array([104, 0, 105]), {}, "&create=1")).status, 415);
  assert.equal((await put("/c2.txt", new Uint8Array([0xff, 0xfe, 0x41]), {}, "&create=1")).status, 415);
  assert.equal((await put("/c3.txt", "x".repeat(1001), {}, "&create=1")).status, 413);
  assert.equal(fs.existsSync(path.join(tmp, "c1.txt")), false);
});
