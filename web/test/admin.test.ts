import assert from "node:assert/strict";
import test from "node:test";
import * as admin from "../src/admin.ts";
import { AdminError } from "../src/admin.ts";

type Handler = (url: string, init?: RequestInit) => Response;
/** Puts a fake fetch in place for one test and gives back the calls it saw. */
function fakeFetch(t: { after: (fn: () => void) => void }, h: Handler) {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return h(url, init);
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = real));
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (c: { init?: RequestInit }) => (c.init?.body === undefined ? undefined : JSON.parse(String(c.init.body)));
const method = (c: { init?: RequestInit }) => c.init?.method ?? "GET";

const view: admin.AccountView = { name: "guest", admin: false, hasPassword: true, keys: [], nodes: {}, sources: {}, sessions: 0 };

test("each function sends its method, URL and body", async (t) => {
  const calls = fakeFetch(t, (url, init) => {
    if (url === "/api/admin/overview") return json({ nodes: ["a"], sources: [], systemAdmins: [], unownedPasswords: 0 });
    if (url === "/api/admin/accounts" && !init?.method) return json({ accounts: [view], system: [] });
    if (url === "/api/admin/sessions") return json({ sessions: [] });
    if (url === "/api/admin/vault/unowned") return json({ removed: 3 });
    if (url.startsWith("/api/admin/system/")) return json({ name: "alice", admin: false, sources: {}, sessions: 0 });
    return json(view);
  });
  const input: admin.AccountInput = { name: "guest", password: "a long password", admin: false, nodes: { a: { runAs: "share", grants: [{ path: "/srv", write: true }] } }, sources: { s3: { write: false } } };
  assert.deepEqual((await admin.overview()).nodes, ["a"]);
  assert.deepEqual((await admin.listAccounts()).accounts, [view]);
  assert.deepEqual(await admin.createAccount(input), view);
  await admin.updateAccount("guest", { admin: true, password: null });
  await admin.deleteAccount("guest");
  await admin.addKey("guest", "ssh-ed25519 AAAA comment");
  await admin.removeKey("guest", "SHA256:abc");
  await admin.setSystemSources("alice", { s3: { write: true } });
  assert.deepEqual(await admin.listSessions(), []);
  await admin.endSession("0123abcd");
  await admin.endAccountSessions("virt", "guest");
  assert.equal(await admin.forgetUnownedPasswords(), 3);
  assert.deepEqual(
    calls.map((c) => [method(c), c.url, sent(c)]),
    [
      ["GET", "/api/admin/overview", undefined],
      ["GET", "/api/admin/accounts", undefined],
      ["POST", "/api/admin/accounts", input],
      ["PATCH", "/api/admin/accounts/guest", { admin: true, password: null }],
      ["DELETE", "/api/admin/accounts/guest", undefined],
      ["POST", "/api/admin/accounts/guest/keys", { publicKey: "ssh-ed25519 AAAA comment" }],
      ["DELETE", "/api/admin/accounts/guest/keys/SHA256%3Aabc", undefined],
      ["PUT", "/api/admin/system/alice/sources", { sources: { s3: { write: true } } }],
      ["GET", "/api/admin/sessions", undefined],
      ["DELETE", "/api/admin/sessions/0123abcd", undefined],
      ["POST", "/api/admin/end-sessions", { kind: "virt", name: "guest" }],
      ["DELETE", "/api/admin/vault/unowned", undefined],
    ],
  );
  for (const c of calls) {
    if (c.init?.body !== undefined) assert.equal(new Headers(c.init.headers).get("content-type"), "application/json");
    assert.equal(c.init?.credentials, "same-origin");
  }
});

test("removeKey encodes the fingerprint as one path segment", async (t) => {
  const calls = fakeFetch(t, () => json(view));
  await admin.removeKey("guest", "SHA256:a/b+c");
  assert.equal(calls[0]!.url, "/api/admin/accounts/guest/keys/SHA256%3Aa%2Fb%2Bc");
});

test("a name is encoded as one path segment", async (t) => {
  const calls = fakeFetch(t, () => json(view));
  await admin.updateAccount("a/b", { admin: false });
  assert.equal(calls[0]!.url, "/api/admin/accounts/a%2Fb");
});

test("the password goes in the body only", async (t) => {
  const calls = fakeFetch(t, () => json(view));
  await admin.updateAccount("guest", { password: "a secret password" });
  assert.ok(!calls[0]!.url.includes("secret"));
  assert.deepEqual(sent(calls[0]!), { password: "a secret password" });
});

test("a 409 with an error text throws AdminError with that text", async (t) => {
  fakeFetch(t, () => json({ error: "exists" }, 409));
  await assert.rejects(admin.createAccount({ name: "guest", admin: false, nodes: {}, sources: {} }), (e: unknown) => e instanceof AdminError && e.message === "exists" && e.status === 409);
});

test("an answer without JSON throws `The server answered <status>`", async (t) => {
  fakeFetch(t, () => new Response("<html>oops</html>", { status: 500 }));
  await assert.rejects(admin.listAccounts(), (e: unknown) => e instanceof AdminError && e.message === "The server answered 500" && e.status === 500);
});

test("a server that cannot be reached throws AdminError", async (t) => {
  fakeFetch(t, () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(admin.deleteAccount("guest"), (e: unknown) => e instanceof AdminError && e.message === "Cannot reach the server");
});
