import assert from "node:assert/strict";
import test from "node:test";
import { installSignedOutWatch, login, me, signInMessage, SignInError } from "../src/auth.ts";

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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("signed-out watch: an archive password 401 is not a sign-out", async (t) => {
  fakeFetch(t, () => json({ error: "password required", code: "password_required" }, 401));
  let n = 0;
  installSignedOutWatch(() => n++);
  const r = await fetch("/api/nodes/a/api/archive/list?path=/x.zip");
  assert.equal(n, 0);
  // the caller still gets the answer as it was, so the archive password prompt opens
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "password required", code: "password_required" });
});

test("signed-out watch: a 401 with the signed-out header is", async (t) => {
  fakeFetch(t, () => json({ error: "signed out" }, 401, { "x-filedeck-auth": "signed-out" }));
  let n = 0;
  installSignedOutWatch(() => n++);
  const r = await fetch("/api/nodes");
  assert.equal(n, 1);
  assert.equal(r.status, 401);
});

test("signed-out watch: other answers pass through", async (t) => {
  fakeFetch(t, (url) => (url.endsWith("/ok") ? json({ ok: true }) : json({ error: "sign-in failed" }, 401)));
  let n = 0;
  installSignedOutWatch(() => n++);
  assert.equal((await fetch("/api/ok")).status, 200);
  assert.equal((await fetch("/api/auth/login", { method: "POST" })).status, 401);
  assert.equal(n, 0);
});

test("me: auth off, signed in, signed out", async (t) => {
  let answer: Response = json({ auth: false });
  fakeFetch(t, () => answer);
  assert.deepEqual(await me(), { auth: false });
  answer = json({ auth: true, kind: "virt", name: "alice", admin: false });
  assert.deepEqual(await me(), { auth: true, kind: "virt", name: "alice", admin: false });
  answer = json({ error: "signed out" }, 401, { "x-filedeck-auth": "signed-out" });
  assert.equal(await me(), "signed-out");
});

test("sign-in messages", async () => {
  assert.equal(await signInMessage(json({ error: "sign-in failed" }, 401)), "Sign-in failed");
  assert.equal(await signInMessage(json({ error: "too many attempts" }, 429, { "retry-after": "7" })), "Too many attempts. Try again in 7 seconds");
  assert.equal(await signInMessage(json({ error: "too many attempts" }, 429, { "retry-after": "1" })), "Too many attempts. Try again in 1 second");
  assert.equal(await signInMessage(json({ error: "sign-in needs HTTPS" }, 403)), "sign-in needs HTTPS");
});

test("login sends the password in the body only, and reports a failure", async (t) => {
  const calls = fakeFetch(t, () => json({ error: "sign-in failed" }, 401));
  await assert.rejects(login("alice", "secret"), (e: unknown) => e instanceof SignInError && e.message === "Sign-in failed");
  assert.equal(calls[0]!.url, "/api/auth/login");
  assert.ok(!calls[0]!.url.includes("secret"));
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { name: "alice", password: "secret" });
});
