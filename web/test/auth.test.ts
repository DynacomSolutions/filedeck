import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, verify } from "node:crypto";
import { installSignedOutWatch, login, me, noteXhr, signInMessage, SignInError, startAsRoot, stopAsRoot } from "../src/auth.ts";
import * as keys from "./fixtures/keys.ts";

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

test("signed-out watch: an upload (XMLHttpRequest) answer reports through the same callback", (t) => {
  fakeFetch(t, () => json({}));
  let n = 0;
  installSignedOutWatch(() => n++);
  const xhr = (status: number, header: string | null) => ({ status, getResponseHeader: (h: string) => (h.toLowerCase() === "x-filedeck-auth" ? header : null) });
  noteXhr(xhr(401, null)); // an archive password or other 401
  noteXhr(xhr(200, "signed-out"));
  assert.equal(n, 0);
  noteXhr(xhr(401, "signed-out"));
  assert.equal(n, 1);
});

test("me: a system administrator acting as root carries asRootUntil; nobody else does", async (t) => {
  let answer: Response = json({ auth: true, kind: "sys", name: "alice", admin: true, asRootUntil: 1_800_000_000_000 });
  fakeFetch(t, () => answer);
  assert.deepEqual(await me(), { auth: true, kind: "sys", name: "alice", admin: true, asRootUntil: 1_800_000_000_000 });
  answer = json({ auth: true, kind: "sys", name: "alice", admin: true });
  assert.deepEqual(await me(), { auth: true, kind: "sys", name: "alice", admin: true });
  // a virtual account never acts as root, whatever the answer says
  answer = json({ auth: true, kind: "virt", name: "bob", admin: false, asRootUntil: 1_800_000_000_000 });
  assert.deepEqual(await me(), { auth: true, kind: "virt", name: "bob", admin: false });
  answer = json({ auth: true, kind: "sys", name: "alice", admin: true, asRootUntil: "soon" });
  assert.deepEqual(await me(), { auth: true, kind: "sys", name: "alice", admin: true });
});

test("startAsRoot with a password posts it in the body only, and gives back the end time", async (t) => {
  const calls = fakeFetch(t, () => json({ asRootUntil: 1_800_000_000_000 }));
  assert.deepEqual(await startAsRoot({ password: "secret" }), { asRootUntil: 1_800_000_000_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/auth/as-root");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { password: "secret" });
});

test("startAsRoot reports the hub's answers as sign-in messages", async (t) => {
  let answer: Response = json({ error: "sign-in failed" }, 401);
  fakeFetch(t, () => answer);
  await assert.rejects(startAsRoot({ password: "x" }), (e: unknown) => e instanceof SignInError && e.message === "Sign-in failed");
  answer = json({ error: "too many attempts" }, 429, { "retry-after": "12" });
  await assert.rejects(startAsRoot({ password: "x" }), (e: unknown) => e instanceof SignInError && e.message === "Too many attempts. Try again in 12 seconds");
  answer = json({ error: "only system administrators can act as root" }, 403);
  await assert.rejects(startAsRoot({ password: "x" }), (e: unknown) => e instanceof SignInError && e.message === "only system administrators can act as root");
});

test("startAsRoot with a key file asks for a fresh challenge first and sends only the public key and a signature", async (t) => {
  const challenge = Buffer.alloc(32, 7).toString("base64");
  const calls = fakeFetch(t, (url) => (url === "/api/auth/challenge" ? json({ challenge, hubId: "hub-1" }) : json({ asRootUntil: 1_800_000_000_000 })));
  assert.deepEqual(await startAsRoot({ keyText: keys.ed25519.key, name: "alice" }), { asRootUntil: 1_800_000_000_000 });
  assert.deepEqual(calls.map((c) => [c.url, c.init?.method]), [["/api/auth/challenge", "POST"], ["/api/auth/as-root", "POST"]]);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { name: "alice" });
  const sent = JSON.parse(String(calls[1]!.init?.body)) as Record<string, string>;
  assert.deepEqual(Object.keys(sent).sort(), ["challenge", "publicKey", "signature"]);
  assert.equal(sent.challenge, challenge);
  assert.equal(sent.publicKey, keys.ed25519.pub.split(" ").slice(0, 2).join(" "));
  for (const c of calls) assert.ok(!String(c.init?.body).includes("PRIVATE KEY"), "the key file text never leaves the browser");
  // the signature is over the hub's login message for the account's own name and this challenge
  const field = (b: Buffer | string) => { const d = Buffer.from(b); const n = Buffer.alloc(4); n.writeUInt32BE(d.length); return Buffer.concat([n, d]); };
  const msg = Buffer.concat([field("filedeck-login-v1"), field("hub-1"), field("alice"), field(Buffer.from(challenge, "base64"))]);
  const blob = Buffer.from(sent.publicKey!.split(" ")[1]!, "base64");
  const x = blob.subarray(blob.length - 32).toString("base64url");
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  assert.ok(verify(null, msg, pub, Buffer.from(sent.signature!, "base64")));
});

test("startAsRoot with a key file stops when the challenge is refused", async (t) => {
  const calls = fakeFetch(t, () => json({ error: "too many attempts" }, 429, { "retry-after": "3" }));
  await assert.rejects(startAsRoot({ keyText: keys.ed25519.key, name: "alice" }), (e: unknown) => e instanceof SignInError && e.message === "Too many attempts. Try again in 3 seconds");
  assert.equal(calls.length, 1);
});

test("stopAsRoot sends DELETE", async (t) => {
  const calls = fakeFetch(t, () => json({ ok: true }));
  await stopAsRoot();
  assert.deepEqual(calls.map((c) => [c.url, c.init?.method]), [["/api/auth/as-root", "DELETE"]]);
});

test("stopAsRoot throws when the hub does not confirm", async (t) => {
  fakeFetch(t, () => json({ error: "boom" }, 500));
  await assert.rejects(stopAsRoot());
});
