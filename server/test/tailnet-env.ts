import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHub } from "../src/hub.ts";
import type { SystemAuth } from "../src/auth/routes.ts";
import { loadConfig } from "../src/config.ts";

/**
 * A hub with sign-in on and a Tailscale source, for the sign-in, binding and audit tests: the headers source, or a fake tailscaled LocalAPI
 * on a unix socket in the private TMPDIR. The listed proxy is 127.0.0.1 and FILEDECK_TRUSTED_PROXIES is 1, so a request "from a device"
 * comes from peer 127.0.0.1 with the device's tailnet address as the last X-Forwarded-For entry and `X-Forwarded-Proto: https`.
 */

/** A device as the source sees it: its user login (none for a tagged device), its tags (socket only) and its stable id. */
export type Dev = { login?: string; tags?: string[]; stable?: string };
export const ADDR = "100.101.102.103";
export const LISTED = "127.0.0.1";
export const NODE_NAME = "laptop.example-tailnet.ts.net.";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

/** Closes every rig and removes its files (call it from `after`). */
export async function closeRigs(): Promise<void> {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

function newDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** The fake LocalAPI: `devices` answers by address (404 when missing), `down` answers 500 (unavailable); every asked address is recorded. */
export async function fakeLocalApi() {
  const devices = new Map<string, Dev>();
  const calls: string[] = [];
  const state = { down: false };
  const socket = path.join(newDir("fd-tsapi-"), "ts.sock");
  const server = http.createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://x").searchParams.get("addr") ?? "";
    calls.push(addr);
    if (state.down) {
      res.writeHead(500);
      return res.end();
    }
    const d = devices.get(addr);
    if (!d) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        Node: { ID: 7, StableID: d.stable ?? "nStable1", Name: NODE_NAME, Addresses: [`${addr}/32`], ...(d.tags ? { Tags: d.tags } : {}) },
        UserProfile: { ID: 9, LoginName: d.login ?? "tagged-devices", DisplayName: d.login ? "Some One" : "Tagged Devices" },
      }),
    );
  });
  await new Promise<void>((res) => server.listen(socket, res));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
  });
  return { socket, devices, calls, state };
}

/** A fake system sign-in: the password `right-pw` passes; `vouch` answers as `answer` says and records each name it is asked for. */
export function fakeSystem(answer: (name: string) => "yes" | "no" | "refused" = () => "yes") {
  const vouched: string[] = [];
  const system: SystemAuth = {
    password: async (_n, pw) => pw === "right-pw",
    key: async () => false,
    vouch: async (n) => {
      vouched.push(n);
      return answer(n);
    },
  };
  return { system, vouched };
}

export type Mode = "headers" | "socket";

export async function rig(mode: Mode | null, o: { env?: Record<string, string>; system?: SystemAuth; auth?: boolean; streamCheckMs?: number } = {}) {
  const clock = { t: Date.now() };
  const lines: string[] = [];
  const api = mode === "socket" ? await fakeLocalApi() : undefined;
  const stat = newDir("fd-tsstatic-");
  fs.writeFileSync(path.join(stat, "index.html"), "<!doctype html><title>t</title>");
  const env: Record<string, string> = {
    FILEDECK_MODE: "hub",
    ...(o.auth === false ? {} : { FILEDECK_AUTH: "on" }),
    FILEDECK_AGENT_TOKEN: "agent-secret",
    FILEDECK_STATIC: stat,
    NODES: "t=http://127.0.0.1:9",
    FILEDECK_TRUSTED_PROXIES: "1",
    ...(mode ? { FILEDECK_TAILSCALE_PROXIES: "127.0.0.1/32" } : {}),
    ...(mode === "headers" ? { FILEDECK_TAILSCALE_HEADERS: "on" } : {}),
    ...(api ? { FILEDECK_TAILSCALE_SOCKET: api.socket } : {}),
    ...o.env,
  };
  const sys = o.system ?? fakeSystem().system;
  const h = createHub(loadConfig(env as never), undefined, (l) => lines.push(l), { now: () => clock.t, system: sys, ...(o.streamCheckMs ? { streamCheckMs: o.streamCheckMs } : {}) });
  closers.push(() => h.close());
  /** The headers source's devices (the socket source's live in the fake LocalAPI). */
  const headerDevices = new Map<string, Dev>();
  const devices = api ? api.devices : headerDevices;

  /** One request "from a device": peer 127.0.0.1, X-Forwarded-For ending with `addr`, HTTPS; in headers mode the device's login header. */
  const req = (
    p: string,
    r: { method?: string; cookie?: string; addr?: string; peer?: string; https?: boolean; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> => {
    const addr = r.addr ?? ADDR;
    const method = r.method ?? "GET";
    const login = mode === "headers" ? headerDevices.get(addr)?.login : undefined;
    const headers: Record<string, string> = {
      "x-forwarded-for": addr,
      ...(r.https === false ? {} : { "x-forwarded-proto": "https" }),
      ...(r.cookie ? { cookie: r.cookie } : {}),
      ...(method !== "GET" && method !== "HEAD" ? { "content-type": "application/json" } : {}),
      ...(login ? { "tailscale-user-login": login } : {}),
      ...r.headers,
    };
    const init = { method, headers, ...(method !== "GET" && method !== "HEAD" ? { body: JSON.stringify(r.body ?? {}) } : {}) };
    const env = { incoming: { socket: { remoteAddress: r.peer ?? LISTED, encrypted: false } } };
    return Promise.resolve(h.request("http://localhost" + p, init, env as never));
  };

  /** Signs in with Tailscale from `addr` and gives the cookie (`name=value`); fails the test on any other answer. */
  const signIn = async (addr = ADDR): Promise<string> => {
    const r = await req("/api/auth/login-tailscale", { method: "POST", addr });
    assert.equal(r.status, 200, `sign-in: ${r.status} ${await r.clone().text()}`);
    const c = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(c, /^__Host-filedeck=/);
    return c;
  };

  /** The audit lines (parsed) of one route. */
  const audits = (route: string) =>
    lines
      .map((l) => JSON.parse(l) as Record<string, unknown> & { tailnet?: Record<string, unknown> })
      .filter((l) => l.audit === true && l.route === route);

  return {
    h,
    api,
    clock,
    lines,
    devices,
    req,
    signIn,
    audits,
    /** Moves the injected clock past the 10-second whois cache. */
    pastCache: () => (clock.t += 10_001),
  };
}
