import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, tailscaleStartup } from "../src/config.ts";

const hub = (extra: Record<string, string>) => loadConfig({ FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", ...extra } as never);

test("tailscale settings: socket, headers and the proxy list", () => {
  const c = hub({ FILEDECK_TAILSCALE_SOCKET: "/run/ts/tailscaled.sock", FILEDECK_TAILSCALE_HEADERS: "on", FILEDECK_TAILSCALE_PROXIES: " 127.0.0.1/32, ::1/128 ,,10.1.0.0/16" });
  assert.equal(c.tailscaleSocket, "/run/ts/tailscaled.sock");
  assert.equal(c.tailscaleHeaders, true);
  assert.deepEqual(c.tailscaleProxies, ["127.0.0.1/32", "::1/128", "10.1.0.0/16"]);
  const d = hub({});
  assert.equal(d.tailscaleSocket, undefined);
  assert.equal(d.tailscaleHeaders, false);
  assert.deepEqual(d.tailscaleProxies, []);
  assert.equal(hub({ FILEDECK_TAILSCALE_HEADERS: "yes" }).tailscaleHeaders, false, "only `on` turns the headers on");
  assert.equal(hub({ FILEDECK_TAILSCALE_SOCKET: "" }).tailscaleSocket, undefined);
});

test("tailscale settings: a bad proxy entry stops the start", () => {
  for (const bad of ["localhost", "10.0.0.0/33", "127.0.0.1/32/1"]) {
    assert.throws(() => hub({ FILEDECK_TAILSCALE_PROXIES: `127.0.0.1,${bad}` }), { message: `FILEDECK_TAILSCALE_PROXIES: "${bad}" is not an IP address or range` });
  }
});

test("tailscale settings: not read with sign-in off", () => {
  const env = { FILEDECK_MODE: "hub", FILEDECK_TAILSCALE_SOCKET: "/run/ts/tailscaled.sock", FILEDECK_TAILSCALE_HEADERS: "on", FILEDECK_TAILSCALE_PROXIES: "not an address" };
  const c = loadConfig(env as never); // a bad list does not stop a hub with sign-in off
  assert.equal(c.tailscaleSocket, undefined);
  assert.equal(c.tailscaleHeaders, false);
  assert.deepEqual(c.tailscaleProxies, []);
  assert.deepEqual(tailscaleStartup(c, env as never), { lines: ["tailscale: sign-in is off, so FILEDECK_TAILSCALE_* is ignored"] });
  assert.deepEqual(tailscaleStartup(loadConfig({ FILEDECK_MODE: "hub" } as never), { FILEDECK_MODE: "hub" } as never), { lines: [] });
});

test("tailscale start-up: a source needs proxies; both sources set: the headers setting is ignored", () => {
  const stop = "FILEDECK_TAILSCALE_PROXIES is needed when FILEDECK_TAILSCALE_SOCKET or FILEDECK_TAILSCALE_HEADERS is set";
  for (const env of [{ FILEDECK_TAILSCALE_SOCKET: "/run/ts/tailscaled.sock" }, { FILEDECK_TAILSCALE_HEADERS: "on" }]) {
    const full = { FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", ...env };
    assert.equal(tailscaleStartup(loadConfig(full as never), full as never).stop, stop);
  }
  const both = { FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_TAILSCALE_SOCKET: "/run/ts/tailscaled.sock", FILEDECK_TAILSCALE_HEADERS: "on", FILEDECK_TAILSCALE_PROXIES: "127.0.0.1/32" };
  const s = tailscaleStartup(loadConfig(both as never), both as never);
  assert.equal(s.stop, undefined);
  assert.ok(s.lines.includes("tailscale: FILEDECK_TAILSCALE_SOCKET is set, so FILEDECK_TAILSCALE_HEADERS is ignored"), s.lines.join("\n"));
  assert.ok(!s.lines.join("\n").includes("/run/ts"), "no socket path in a log line");
  const headers = { FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_TAILSCALE_HEADERS: "on", FILEDECK_TAILSCALE_PROXIES: "127.0.0.1/32" };
  const h = tailscaleStartup(loadConfig(headers as never), headers as never);
  assert.equal(h.stop, undefined);
  assert.deepEqual(h.lines, ["tailscale: sign-in with Tailscale through the headers source, from 127.0.0.1/32"]);
  // proxies alone, or nothing: no source, no line
  const only = { FILEDECK_MODE: "hub", FILEDECK_AUTH: "on", FILEDECK_TAILSCALE_PROXIES: "127.0.0.1/32" };
  assert.deepEqual(tailscaleStartup(loadConfig(only as never), only as never), { lines: [] });
});

test("tailscale settings: an agent never reads them", () => {
  const env = { FILEDECK_AUTH: "on", FILEDECK_AGENT_TOKEN: "t", FILEDECK_TAILSCALE_SOCKET: "/run/ts/tailscaled.sock", FILEDECK_TAILSCALE_PROXIES: "bad" };
  const c = loadConfig(env as never);
  assert.equal(c.tailscaleSocket, undefined);
  assert.deepEqual(tailscaleStartup(c, env as never), { lines: [] });
});
