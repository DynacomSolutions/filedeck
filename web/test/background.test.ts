import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_HEADER, listStream } from "../src/api.ts";
import { gitApi } from "../src/git.ts";
import { checkSignedIn, createChangeHub, type StreamSource } from "../src/eventStream.ts";

/**
 * Requests the app makes by itself (a refresh after a change feed event, a reconnect or a poll; the "who is signed in" check after a
 * dropped feed) carry `x-filedeck-background: 1`, so the hub does not count them as use of the session. A person's own requests do not.
 */
function capture() {
  const real = globalThis.fetch;
  const seen: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ entries: [], truncated: false, repo: false }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

test("the header is x-filedeck-background: 1", () => {
  assert.deepEqual(BACKGROUND_HEADER, { "x-filedeck-background": "1" });
});

test("the listing and the git status carry the header only when asked for in the background", async () => {
  const c = capture();
  try {
    const ctl = new AbortController();
    await listStream("n", "/d", false, ctl.signal, () => {}, { background: true });
    await listStream("n", "/d", false, ctl.signal, () => {});
    await gitApi.status("n", "/d", true, ctl.signal, { background: true });
    await gitApi.status("n", "/d", true, ctl.signal);
    assert.deepEqual(
      c.seen.map((s) => s.headers.get("x-filedeck-background")),
      ["1", null, "1", null],
    );
  } finally {
    c.restore();
  }
});

test("the sign-in check after a dropped feed is a background request", async () => {
  const c = capture();
  try {
    await checkSignedIn();
    assert.equal(c.seen[0]?.url, "/api/auth/me");
    assert.equal(c.seen[0]?.headers.get("x-filedeck-background"), "1");
  } finally {
    c.restore();
  }
});

test("every notification of the change hub (a change, a reconnect, a poll, the page shown again) says it is automatic", () => {
  const handlers = new Map<string, (e: { data?: unknown }) => void>();
  const src: StreamSource & { readyState: number } = { readyState: 1, addEventListener: (t, fn) => void handlers.set(t, fn), close: () => {} };
  const timers: (() => void)[] = [];
  const hub = createChangeHub({
    open: () => src,
    maxStreams: 1,
    pollMs: 1000,
    setInterval: (fn) => timers.push(fn),
    clearInterval: () => {},
    url: (n, p) => `${n}:${p}`,
  });
  const why: unknown[] = [];
  hub.subscribe("n", "/a", (w) => why.push(w));
  hub.subscribe("n", "/b", (w) => why.push(w)); // beyond the cap: polled
  handlers.get("change")!({});
  handlers.get("ready")!({ data: "false" });
  handlers.get("ready")!({ data: "false" });
  timers[0]!();
  hub.setVisible(false);
  hub.setVisible(true);
  assert.ok(why.length >= 4);
  for (const w of why) assert.deepEqual(w, { background: true });
});
