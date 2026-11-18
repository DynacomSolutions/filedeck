import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pushroutes-")));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
const hubs: { close(): Promise<void> }[] = [];
after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Hub = ReturnType<typeof createHub>;
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1", encrypted: false } } } as never;
const L = "http://localhost";

function makeHub(env: Record<string, string> = {}): Hub {
  const h = createHub(loadConfig({ FILEDECK_MODE: "hub", FILEDECK_STATIC: tmp, NODES: "t=http://127.0.0.1:9", ...env } as never), undefined, () => {});
  hubs.push(h);
  return h;
}
const signedIn = (env: Record<string, string> = {}) => makeHub({ FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "agent-secret", ...env });

const req = (h: Hub, method: string, p: string, body?: unknown, cookie?: string) =>
  h.request(L + p, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, peer);

async function login(h: Hub, name: string): Promise<string> {
  h.auth!.accounts.create({ name, password: `pw-${name}`, admin: false, nodes: {} });
  const r = await req(h, "POST", "/api/auth/login", { name, password: `pw-${name}` });
  assert.equal(r.status, 200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const SUB = (n = 1) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/e${n}`,
  keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
});

/** the hub's push store, read through its routes' side effects: the subscriptions of `owner` */
const subsOf = (h: Hub, owner: string) => (h as unknown as { push?: { store: { of(o: string): { endpoint: string; session: string | null }[] } } }).push?.store.of(owner) ?? [];

test("sign-in on: the key and subscribe need a signed-in session; a subscription is kept with the account and session", async () => {
  const h = signedIn();
  assert.equal((await req(h, "GET", "/api/push/key")).status, 401);
  assert.equal((await req(h, "POST", "/api/push/subscribe", SUB())).status, 401);
  const c = await login(h, "ann");
  const k = await req(h, "GET", "/api/push/key", undefined, c);
  assert.equal(k.status, 200);
  const { publicKey } = (await k.json()) as { publicKey: string };
  assert.equal(Buffer.from(publicKey, "base64url").length, 65);
  // the same key on the next call
  assert.equal(((await (await req(h, "GET", "/api/push/key", undefined, c)).json()) as { publicKey: string }).publicKey, publicKey);
  assert.equal((await req(h, "POST", "/api/push/subscribe", SUB(), c)).status, 200);
  const subs = subsOf(h, "virt:ann");
  assert.equal(subs.length, 1);
  assert.ok(subs[0]!.session);
});

test("only push service addresses and well-formed keys are taken", async () => {
  const h = signedIn();
  const c = await login(h, "ann");
  for (const endpoint of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://example.test/x", "https://fcm.googleapis.com:444/x"])
    assert.equal((await req(h, "POST", "/api/push/subscribe", { ...SUB(), endpoint }, c)).status, 400, endpoint);
  assert.equal((await req(h, "POST", "/api/push/subscribe", { ...SUB(), keys: { ...SUB().keys, p256dh: "AAAA" } }, c)).status, 400);
  assert.equal((await req(h, "POST", "/api/push/subscribe", { ...SUB(), keys: { ...SUB().keys, auth: "AA" } }, c)).status, 400);
  assert.equal((await req(h, "POST", "/api/push/subscribe", null, c)).status, 400);
  assert.equal(subsOf(h, "virt:ann").length, 0);
});

test("sign-out ends the session's subscriptions; an account change ends all of the account's", async () => {
  const h = signedIn();
  const c1 = await login(h, "ann");
  await req(h, "POST", "/api/push/subscribe", SUB(1), c1);
  const r2 = await req(h, "POST", "/api/auth/login", { name: "ann", password: "pw-ann" });
  const c2 = (r2.headers.get("set-cookie") ?? "").split(";")[0]!;
  await req(h, "POST", "/api/push/subscribe", SUB(2), c2);
  assert.equal(subsOf(h, "virt:ann").length, 2);
  await req(h, "POST", "/api/auth/logout", undefined, c1);
  assert.deepEqual(subsOf(h, "virt:ann").map((s) => s.endpoint), [SUB(2).endpoint]);
  await h.accountChanged(h.auth!.accounts.identity("virt", "ann")!);
  assert.equal(subsOf(h, "virt:ann").length, 0);
});

test("delete removes only the caller's own subscription", async () => {
  const h = signedIn();
  const a = await login(h, "ann");
  const b = await login(h, "ben");
  await req(h, "POST", "/api/push/subscribe", SUB(1), a);
  assert.deepEqual(await (await req(h, "DELETE", "/api/push/subscribe", { endpoint: SUB(1).endpoint }, b)).json(), { removed: 0 });
  assert.equal(subsOf(h, "virt:ann").length, 1);
  assert.deepEqual(await (await req(h, "DELETE", "/api/push/subscribe", { endpoint: SUB(1).endpoint }, a)).json(), { removed: 1 });
});

test("sign-in off: one shared list; FILEDECK_PUSH=off: the routes are 404", async () => {
  const h = makeHub();
  assert.equal((await req(h, "GET", "/api/push/key")).status, 200);
  assert.equal((await req(h, "POST", "/api/push/subscribe", SUB())).status, 200);
  assert.deepEqual(subsOf(h, "").map((s) => [s.endpoint, s.session]), [[SUB().endpoint, null]]);
  const off = makeHub({ FILEDECK_PUSH: "off" });
  assert.equal((await req(off, "GET", "/api/push/key")).status, 404);
  assert.equal((await req(off, "POST", "/api/push/subscribe", SUB())).status, 404);
});

test("the watch lists the hub's jobs and each machine's, as the agents answer them", async () => {
  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const fake = new Hono();
  fake.get("/api/jobs", (c) => c.json({ jobs: [{ id: "j1", title: "Compress a.zip", state: "done", origin: "ui", finishedAt: 5 }, { bad: true }] }));
  const srv = serve({ fetch: fake.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => srv.once("listening", r));
  try {
    const port = (srv.address() as { port: number }).port;
    const h = makeHub({ NODES: `m1=http://127.0.0.1:${port},m2=http://127.0.0.1:9` });
    const list = (h as unknown as { push: { listJobs(id: undefined): Promise<{ source: string; id: string; state: string }[]> } }).push.listJobs;
    const jobs = await list(undefined);
    assert.deepEqual(jobs.map((j) => [j.source, j.id, j.state]), [["node:m1", "j1", "done"]], "a machine that is down adds nothing; a malformed row is skipped");
  } finally {
    srv.close();
  }
});
