import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { couldMatch, Scope, uriMatches } from "../src/mcp/grants.ts";
import { RESOURCE_NOT_FOUND } from "../src/mcp/core.ts";
import { ALL_TOKEN, bodyOf, boot, everything, job, sleep, until, type GrantDef } from "./mcp-support.ts";

const web: GrantDef = { id: "reader", token: "reader-token-" + "r".repeat(24), resources: ["filedeck://nodes/n/"], tools: ["filedeck_du", "filedeck_nodes", "filedeck_jobs_list", "filedeck_job_get"] };
type R = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
const tool = async (c: { client: { callTool(a: object): Promise<unknown> } }, name: string, args: Record<string, unknown> = {}) => (await c.client.callTool({ name, arguments: args })) as unknown as R;
const post = (url: string, token: string) =>
  fetch(url + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });

test("a resource entry is a URI template, a prefix (slash at the end) or one URI", () => {
  assert.equal(uriMatches("filedeck://nodes/web1/", "filedeck://nodes/web1/status"), true);
  assert.equal(uriMatches("filedeck://nodes/web1/", "filedeck://nodes/web10/status"), false);
  assert.equal(uriMatches("filedeck://nodes/web1", "filedeck://nodes/web10/status"), false, "no slash at the end: one URI, not a prefix");
  assert.equal(uriMatches("filedeck://nodes/web1", "filedeck://nodes/web1"), true);
  assert.equal(uriMatches("filedeck://nodes", "filedeck://nodes/n/status"), false, "the node list is not every node");
  assert.equal(uriMatches("filedeck://nodes", "filedeck://nodes"), true);
  assert.equal(uriMatches("filedeck://nodes/{node}/status", "filedeck://nodes/a/status"), true);
  assert.equal(uriMatches("filedeck://nodes/{node}/status", "filedeck://nodes/a/scans"), false);
  assert.equal(uriMatches("filedeck://nodes/{node}/status", "filedeck://nodes/a/b/status"), false, "{node} is one segment");
  assert.equal(uriMatches("filedeck://", "filedeck://jobs/x"), true);
});

test("a template that ends with a slash is a prefix, and the parts of an entry are compared one segment at a time", () => {
  assert.equal(uriMatches("filedeck://nodes/{node}/", "filedeck://nodes/a/status"), true);
  assert.equal(uriMatches("filedeck://nodes/{node}/", "filedeck://nodes/a/"), true);
  assert.equal(uriMatches("filedeck://nodes/{node}/", "filedeck://nodes/a"), false);
  assert.equal(uriMatches("filedeck://nodes/{node}/", "filedeck://jobs/a/status"), false);
  assert.equal(uriMatches("filedeck://nodes/web1/", "filedeck://nodes/web1"), false);
  // a template of a resource: some URI of it must be readable
  const t = (entry: string, template: string) => couldMatch(entry, template);
  assert.equal(t("filedeck://nodes/{node}/status", "filedeck://nodes/{node}/status"), true);
  assert.equal(t("filedeck://nodes/{node}/status", "filedeck://nodes/{node}/scans"), false, "the same beginning is not enough");
  assert.equal(t("filedeck://nodes/{node}/status", "filedeck://jobs/{id}"), false);
  assert.equal(t("filedeck://nodes/n/jobs", "filedeck://nodes/{node}/jobs"), true);
  assert.equal(t("filedeck://nodes/n/jobs", "filedeck://nodes/{node}/status"), false);
  assert.equal(t("filedeck://nodes/{node}/", "filedeck://nodes/{node}/status"), true, "a template with a slash at the end is a prefix");
  assert.equal(t("filedeck://nodes/{node}/", "filedeck://jobs/{id}"), false);
  assert.equal(t("filedeck://nodes/n/", "filedeck://nodes/{node}/scans"), true);
  assert.equal(t("filedeck://nodes/", "filedeck://nodes/{node}/scans"), true);
  assert.equal(t("filedeck://jobs/", "filedeck://jobs/{id}"), true);
  assert.equal(t("filedeck://jobs/", "filedeck://nodes/{node}/jobs"), false);
  assert.equal(t("filedeck://nodes", "filedeck://nodes/{node}/status"), false, "the node list is one URI");
  assert.equal(t("filedeck://", "filedeck://jobs/{id}"), true);
  assert.equal(t("filedeck://nodes/n/status/", "filedeck://nodes/{node}/status"), false, "a prefix needs one more segment than the template has");
});

test("a node is named only by its prefix or the template filedeck://nodes/{node}/", () => {
  const scope = (...resources: string[]) => new Scope({ tools: ["*"], resources });
  assert.equal(scope("filedeck://nodes/n/").allowsNode("n"), true);
  assert.equal(scope("filedeck://nodes/n/").allowsNode("m"), false);
  assert.equal(scope("filedeck://nodes/{node}/").allowsNode("anything"), true);
  assert.equal(scope("filedeck://nodes/").allowsNode("n"), true);
  assert.equal(scope("filedeck://").allowsNode("n"), true);
  for (const one of ["filedeck://nodes/{node}/status", "filedeck://nodes/{node}/scans", "filedeck://nodes/n/jobs", "filedeck://nodes", "filedeck://nodes/n", "filedeck://jobs/", "filedeck://hub/jobs"]) {
    assert.equal(scope(one).allowsNode("n"), false, one);
  }
  // a single URI cannot match a template that it does not fit
  assert.equal(scope("filedeck://nodes").allowsTemplate("filedeck://nodes/{node}/status"), false);
  assert.equal(scope("filedeck://nodes/n/status").allowsTemplate("filedeck://nodes/{node}/status"), true);
  assert.equal(scope("filedeck://nodes/n/status").allowsTemplate("filedeck://nodes/{node}/jobs"), false);
});

test("an unknown token is 401, a known one opens a session, and each grant has its own token", async (t) => {
  const b = await boot({ grants: [everything(), web] });
  t.after(() => b.close());
  assert.equal((await post(b.url, "no-such-token-" + "x".repeat(20))).status, 401);
  assert.equal((await post(b.url, ALL_TOKEN)).status, 200);
  assert.equal((await post(b.url, web.token)).status, 200);
  const metrics = await (await b.hub.metrics.request("/metrics")).text();
  assert.match(metrics, /filedeck_mcp_http_requests_total\{grant="none",outcome="unauthorized"\} 1/);
  assert.match(metrics, /filedeck_mcp_sessions_opened_total\{grant="reader"\} 1/);
  assert.match(metrics, /filedeck_mcp_grants 2/);
  // a session belongs to the grant that opened it
  const open = await post(b.url, web.token);
  const sid = open.headers.get("mcp-session-id")!;
  const other = await fetch(b.url + "/mcp", { method: "POST", headers: { authorization: `Bearer ${ALL_TOKEN}`, "mcp-session-id": sid, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(other.status, 403);
});

test("a grant sees and may use only what it names: tools, resources, templates and nodes", async (t) => {
  const b = await boot({ grants: [everything(), web] });
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const full = await b.connect();
  const c = await b.connect({ token: web.token });

  const tools = (await c.client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(tools, [...web.tools].sort());
  assert.ok((await full.client.listTools()).tools.length > tools.length);
  const nope = await tool(c, "filedeck_stat", { node: "n", path: "/data" }).catch((e: Error) => e);
  assert.ok(nope instanceof Error || (nope.isError === true && /not found/i.test(nope.content[0]!.text)), "a tool outside the grant does not exist");

  const resources = (await c.client.listResources()).resources.map((r) => r.uri);
  assert.ok(resources.includes("filedeck://nodes/n/status"));
  assert.equal(resources.includes("filedeck://nodes"), false, "the node list is not in the grant");
  assert.equal(resources.includes("filedeck://hub/jobs"), false);
  const templates = (await c.client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
  assert.ok(templates.includes("filedeck://nodes/{node}/status"));
  assert.ok(templates.includes("filedeck://jobs/{id}") === false, "the job template is not in the grant");
  await assert.rejects(c.client.readResource({ uri: "filedeck://nodes" }), /outside the grant|not found|unknown/i);
  await assert.rejects(c.client.readResource({ uri: "filedeck://jobs/s1" }), /outside the grant|not found|unknown/i);
  await assert.rejects(c.client.subscribeResource({ uri: "filedeck://nodes" }), /outside the grant/);
  assert.equal(bodyOf(await c.client.readResource({ uri: "filedeck://nodes/n/jobs" })).jobs[0].id, "s1");
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });

  // tools of the grant answer for its nodes only
  assert.equal((await tool(c, "filedeck_du", { node: "n", path: "/data" })).structuredContent.stored, true);
  const names = (await tool(c, "filedeck_nodes")).structuredContent;
  assert.deepEqual(names.nodes.map((n: { name: string }) => n.name), ["n"]);
  assert.deepEqual(names.sources, []);
  assert.equal((await tool(c, "filedeck_jobs_list", { node: "hub" })).isError, true);
  assert.equal((await tool(c, "filedeck_job_get", { id: "s1" })).structuredContent.job.id, "s1");
});

test("a node that the grant does not name is refused in every tool", async (t) => {
  const other: GrantDef = { id: "other", token: "other-token-" + "o".repeat(24), resources: ["filedeck://nodes/elsewhere/"], tools: ["filedeck_du", "filedeck_list", "filedeck_nodes", "filedeck_scan_status", "filedeck_job_get"] };
  const b = await boot({ grants: [other] });
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const c = await b.connect({ token: other.token });
  const call = async (name: string, args: Record<string, unknown>) => (await c.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };
  for (const [name, args] of [["filedeck_du", { node: "n", path: "/data" }], ["filedeck_list", { node: "n", path: "/data" }], ["filedeck_scan_status", { node: "n" }]] as const) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0]!.text, /^forbidden/, name);
  }
  assert.deepEqual((await call("filedeck_nodes", {})).structuredContent!.nodes, []);
  assert.deepEqual((await call("filedeck_scan_status", {})).structuredContent!.nodes, [], "no node of the grant exists here");
  assert.equal((await call("filedeck_job_get", { id: "s1" })).isError, true, "a job of another node is not found");
});

test("revocation: removing a grant, or changing its token or scope, ends its sessions and the token stops working", async (t) => {
  const b = await boot({ grants: [everything(), web] });
  t.after(() => b.close());
  const keep = await b.connect();
  const c = await b.connect({ token: web.token });
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  assert.equal(b.mcp.sessionCount, 2);
  assert.equal(b.mcp.subscriptionCount, 1);

  b.setGrants([everything()]); // the reader grant is removed from the list
  await until(() => b.mcp.sessionCount === 1);
  assert.equal(b.mcp.subscriptionCount, 0, "its subscriptions go with it");
  assert.equal((await post(b.url, web.token)).status, 401, "its token no longer works");
  await assert.rejects(c.client.callTool({ name: "filedeck_nodes", arguments: {} }), "the session is gone");
  assert.equal((await tool(keep, "filedeck_nodes")).isError, undefined, "the other grant is untouched");
  const metrics = await (await b.hub.metrics.request("/metrics")).text();
  assert.match(metrics, /filedeck_mcp_sessions_closed_total\{grant="reader",reason="revoked"\} 1/);
  assert.match(metrics, /filedeck_mcp_grants 1/);

  // a new token for a grant revokes the old one: the file changes, the hub is not restarted
  b.setGrants([everything(), web]);
  await sleep(300);
  const again = await b.connect({ token: web.token });
  await again.client.listTools();
  b.setGrants([everything(), { ...web, token: "rotated-token-" + "n".repeat(22) }]);
  await until(() => b.mcp.sessionCount === 1);
  assert.equal((await post(b.url, web.token)).status, 401);
  assert.equal((await post(b.url, "rotated-token-" + "n".repeat(22))).status, 200);

  // a narrower scope also ends the old sessions
  const rotated = await b.connect({ token: "rotated-token-" + "n".repeat(22) });
  b.setGrants([everything(), { ...web, token: "rotated-token-" + "n".repeat(22), tools: ["filedeck_nodes"] }]);
  await sleep(400);
  await assert.rejects(rotated.client.callTool({ name: "filedeck_nodes", arguments: {} }), "its session ended");
  const fresh = await b.connect({ token: "rotated-token-" + "n".repeat(22) });
  assert.deepEqual((await fresh.client.listTools()).tools.map((x) => x.name), ["filedeck_nodes"]);
});

test("a token file that is removed or too short turns its grant off; a half-written grants file revokes nobody", async (t) => {
  const b = await boot({ grants: [everything(), web] });
  t.after(() => b.close());
  const c = await b.connect({ token: web.token });
  fs.writeFileSync(path.join(b.dir, "grants.json"), "[{ not json"); // a write in progress
  await sleep(300);
  assert.equal(b.mcp.sessionCount, 1, "nothing was revoked");
  assert.equal((await tool(c, "filedeck_nodes")).isError, undefined);
  b.setGrants([everything(), web]); // the write is finished
  await sleep(300);
  assert.equal(b.mcp.sessionCount, 1, "the same grants: nothing changed");
  fs.rmSync(path.join(b.dir, "token-reader"));
  await until(() => b.mcp.sessionCount === 0);
  assert.equal((await post(b.url, web.token)).status, 401);
  fs.writeFileSync(path.join(b.dir, "token-reader"), "short");
  b.setGrants([everything(), web]);
  fs.writeFileSync(path.join(b.dir, "token-reader"), "short");
  await sleep(300);
  assert.equal((await post(b.url, "short")).status, 401, "a token under 16 characters is never accepted");
});

test("one change has one event id for every session that gets it", async (t) => {
  const b = await boot({ grants: [everything(), { ...web, id: "reader2", token: "reader2-token-" + "q".repeat(22) }] });
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const a = await b.connect();
  const c = await b.connect({ token: "reader2-token-" + "q".repeat(22) });
  await a.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  await c.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  b.agent.state.jobs[0]!.state = "done";
  await until(() => a.updated.length > 0 && c.updated.length > 0);
  assert.equal(a.updated[0]!._meta!.filedeck!.eventId, c.updated[0]!._meta!.filedeck!.eventId);
  assert.equal(a.updated.length + c.updated.length, 2, "one notification for each session");
  b.agent.state.jobs[0]!.state = "failed";
  await until(() => a.updated.length > 1);
  assert.notEqual(a.updated[1]!._meta!.filedeck!.eventId, a.updated[0]!._meta!.filedeck!.eventId, "the next change has a new id");
  assert.ok(a.updated[1]!._meta!.filedeck!.revision > a.updated[0]!._meta!.filedeck!.revision);
});

test("sign-in on: each account has its own watch, and a notification reaches only the sessions of its account", async (t) => {
  const b = await boot({ auth: true, grants: [everything({ id: "one", account: "svcone" }), { ...everything({ id: "two", account: "svctwo" }), token: "second-token-" + "s".repeat(22) }] });
  t.after(() => b.close());
  b.agent.state.jobs.push(job("s1", "size", "running"));
  const one = await b.connect();
  const two = await b.connect({ token: "second-token-" + "s".repeat(22) });
  await one.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  await two.client.subscribeResource({ uri: "filedeck://nodes/n/jobs" });
  assert.match(await (await b.hub.metrics.request("/metrics")).text(), /filedeck_mcp_watched_nodes 4/, "one watch for each account and source (the node and the hub operations)");
  b.agent.state.jobs[0]!.state = "done";
  await until(() => one.updated.length > 0 && two.updated.length > 0);
  await sleep(300);
  assert.equal(one.updated.length, 1);
  assert.equal(two.updated.length, 1);
  assert.notEqual(one.updated[0]!._meta!.filedeck!.eventId, two.updated[0]!._meta!.filedeck!.eventId);
});

// ---- the list of templates is what the grant can read, and the codes of a refused or missing resource ----

const code = (e: unknown) => (e as McpError).code;

test("resources/templates/list holds exactly the templates that the grant can read, and no more", async (t) => {
  const NODE = ["filedeck://nodes/{node}/jobs", "filedeck://nodes/{node}/scans", "filedeck://nodes/{node}/status"];
  const cases: [string[], string[]][] = [
    [["filedeck://nodes/{node}/status"], ["filedeck://nodes/{node}/status"]],
    [["filedeck://nodes/{node}/scans", "filedeck://jobs/{id}"], ["filedeck://jobs/{id}", "filedeck://nodes/{node}/scans"]],
    [["filedeck://nodes/n/jobs"], ["filedeck://nodes/{node}/jobs"]],
    [["filedeck://nodes/{node}/"], NODE],
    [["filedeck://nodes/n/"], NODE],
    [["filedeck://jobs/"], ["filedeck://jobs/{id}"]],
    [["filedeck://nodes", "filedeck://hub/jobs"], []],
    [["filedeck://"], ["filedeck://jobs/{id}", ...NODE]],
  ];
  const all = ["filedeck://jobs/{id}", ...NODE];
  for (const [resources, listed] of cases) {
    const g: GrantDef = { id: "tmpl", token: "tmpl-token-" + "t".repeat(24), resources, tools: ["*"] };
    const b = await boot({ grants: [g] });
    try {
      const c = await b.connect();
      const got = (await c.client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate).sort();
      assert.deepEqual(got, [...listed].sort(), JSON.stringify(resources));
      // what is listed can be read (a node or a job that does not exist is "not found"), and what is not listed is refused
      for (const template of all) {
        const uri = template.replace("{node}", "n").replace("{id}", "x");
        const e = await c.client.readResource({ uri }).then(() => undefined, (x: unknown) => x);
        if (listed.includes(template)) assert.ok(e === undefined || code(e) === RESOURCE_NOT_FOUND, `${JSON.stringify(resources)} reads ${uri}: ${(e as Error)?.message}`);
        else {
          assert.equal(code(e), -32602, `${JSON.stringify(resources)} must refuse ${uri}`);
          // a template that the grant cannot read is not registered: the SDK answers "not found" with the same code
          assert.match((e as Error).message, /forbidden|not found/);
        }
      }
    } finally {
      await b.close();
    }
  }
});

test("a read of a URI outside the grant is -32602 forbidden, also for a node that the hub does not have; a bad percent escape is never an internal error", async (t) => {
  const g: GrantDef = { id: "one", token: "one-token-" + "o".repeat(24), resources: ["filedeck://nodes/n/"], tools: ["*"] };
  const b = await boot({ grants: [everything(), g] });
  t.after(() => b.close());
  const one = await b.connect({ token: g.token });
  const err = async (c: typeof one, f: () => Promise<unknown>) => await f().then(() => undefined, (e: unknown) => e as McpError);
  // the grant names node n only: any other node is outside it, whether the hub has it or not
  for (const uri of ["filedeck://nodes/other/status", "filedeck://nodes/ghost/scans", "filedeck://nodes/ghost/jobs"]) {
    const e = await err(one, () => one.client.readResource({ uri }));
    assert.equal(code(e), -32602, uri);
    assert.match(e!.message, /forbidden/, uri);
  }
  // a grant that covers every node: a node that does not exist is "not found"
  const full = await b.connect();
  for (const uri of ["filedeck://nodes/ghost/status", "filedeck://jobs/ghost"]) assert.equal(code(await err(full, () => full.client.readResource({ uri }))), RESOURCE_NOT_FOUND, uri);
  // a bad percent escape names nothing: -32002 on a read, -32602 on a subscribe, and never -32603
  for (const c of [full, one]) {
    for (const uri of ["filedeck://nodes/%E0/status", "filedeck://nodes/%/scans", "filedeck://jobs/%E0%A4%A"]) {
      const r = await err(c, () => c.client.readResource({ uri }));
      assert.ok(r instanceof McpError, `${uri} is a JSON-RPC error`);
      assert.ok([RESOURCE_NOT_FOUND, -32602].includes(r.code), `${uri}: code ${r.code} ${r.message}`);
      assert.notEqual(r.code, -32603);
      const sub = await err(c, () => c.client.subscribeResource({ uri }));
      assert.ok(sub instanceof McpError && [RESOURCE_NOT_FOUND, -32602].includes(sub.code), `${uri} subscribe: ${sub?.message}`);
    }
  }
  assert.equal(code(await err(full, () => full.client.readResource({ uri: "filedeck://nodes/%E0/status" }))), RESOURCE_NOT_FOUND);
  assert.doesNotMatch(await (await b.hub.metrics.request("/metrics")).text(), /kind="internal"/);
});
