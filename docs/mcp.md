# MCP server

`contract: 2`

The hub can run a [Model Context Protocol](https://modelcontextprotocol.io) server. A client reads FileDeck data (sizes, folders, scans, jobs, node status, change events) with tools and resources. A client can also subscribe to resources, and the server then sends an event when a scan finishes, a job changes state or a node changes status. The client does not poll.

The server is read only. No tool changes a file, starts a scan or starts a job.

FileDeck runs no AI agent of its own. There is no ACP (Agent Client Protocol) endpoint. The MCP server is the only machine interface of this kind.

## Contract version

This page describes contract 2. The server tells the client the contract in three places: the `instructions` text of the `initialize` answer ("FileDeck contract 2"), the field `contract` in every resource body, and this page.

The contract number rises when a tool, a field or a URI changes in a way that can break a client. A new field, a new tool or a new resource does not raise it. A client must ignore fields that it does not know.

Contract 2 differs from contract 1 in the notifications. A client of contract 1 must change these points:

- `eventId` is also at the top of `_meta`, and it has a new form: it is now made of the URI and the revision, so it is stable for a replay (see [Event id and change id](#event-id-and-change-id)).
- `_meta.filedeck` has the new fields `changeId`, `streamId`, `seq` and `missed` (see [Gaps](#gaps-baseline-reads)).
- Every session gets `notifications/resources/list_changed` from `initialize`, not only after its first `resources/list`.

## Discovery

Everything a client needs to find the server is a setting of the hub. There is no registry and no discovery call.

| What | Value |
|---|---|
| Transport | Streamable HTTP over HTTPS |
| Port | `FILEDECK_MCP_PORT` (chart value `hub.mcp.port`, default 9092). The listener is off when the setting is unset. |
| Path | `/mcp` |
| Liveness | `GET /mcp/healthz` on the same port |
| Readiness | `GET /mcp/readyz` on the same port |
| Header | `Authorization: Bearer <token>`. Each grant has its own token. |
| Grants | `FILEDECK_MCP_GRANTS_FILE`: a JSON file. Chart: `hub.mcp.grants`. |
| TLS | `FILEDECK_MCP_TLS_CERT` and `FILEDECK_MCP_TLS_KEY` (PEM files). Chart: `hub.mcp.tls.secretName`, a `kubernetes.io/tls` Secret. |
| Default account | `FILEDECK_MCP_ACCOUNT` (chart: `hub.mcp.account`). Sign-in on only. A grant may name its own account. |
| Poll interval | `FILEDECK_MCP_POLL_MS` (chart: `hub.mcp.pollMs`, default 5000, 1000 to 600000) |
| Sessions for each grant | `FILEDECK_MCP_SESSIONS_PER_GRANT` (chart: `hub.mcp.sessionsPerGrant`, default 32, 1 to 256) |
| Allowed hosts | `FILEDECK_MCP_ALLOWED_HOSTS` (chart: `hub.mcp.allowedHosts`): host names, separated by commas. Empty (the default) means any host. It is not `FILEDECK_ALLOWED_HOSTS`. |
| Chart switch | `hub.mcp.enabled` (default `false`) |
| Allowed clients | `hub.mcp.allowFrom`: a list of NetworkPolicy peers. Empty (the default) means no peer can reach the port. |
| Plain HTTP | `FILEDECK_MCP_ALLOW_PLAINTEXT=1`. For tests only. The chart has no value for it. |

The server never uses the port of the file API and never appears in the public route. The Service has a port named `mcp`, and a NetworkPolicy lets only `hub.mcp.allowFrom` reach it. That policy is made whenever `hub.mcp.enabled` is true. It does not close the other hub ports.

With `FILEDECK_MCP_PORT` set, the hub runs the MCP server or it stops. The hub does not run on without it: the probes of the chart ask the MCP port, so a hub without the listener would fail them and Kubernetes would restart the pod again and again. The hub writes one log line that names the reason, then one line that says that the MCP server cannot start, and then it exits with code 2. A rollout then stops with the old pod still serving. These are the cases:

- `FILEDECK_MCP_GRANTS_FILE` is not set, or the file is not valid JSON at start. The listener never runs without a way to check a token.
- There is no TLS certificate and `FILEDECK_MCP_ALLOW_PLAINTEXT` is not `1`. The listener never serves plain HTTP.
- The certificate or key file cannot be read, is empty, or is not a valid PEM pair.

Without `FILEDECK_MCP_PORT` the MCP server is off and the hub starts as before.

A grants file with no grants is valid. The listener then answers 401 to every request.

## Transport

- The listener serves HTTPS only when TLS is configured, and it serves nothing else on that port. The hub reads the certificate and the key again every 5 seconds. A renewed pair (for example from cert-manager) is used for new connections with no restart. A pair that cannot be loaded is ignored, and the last good pair stays.
- MCP protocol versions 2025-11-25 and 2025-06-18 are tested. The server answers with the version that the client asks for when it knows that version.
- One endpoint, `/mcp`. `POST` sends a request, a notification or a response. `GET` opens the stream for notifications from the server. `DELETE` ends the session. `PUT` and the other methods answer 405.
- The first request must be `initialize`. The answer has the header `Mcp-Session-Id`. The client sends that header on every other request, with the same token. An unknown session id answers 404, and the client then starts again with `initialize`.
- A request body has at most 4 MiB. A hub holds at most 256 sessions, a grant at most `FILEDECK_MCP_SESSIONS_PER_GRANT` (default 32), and a session at most 256 subscriptions. A session with no request and no open stream for 15 minutes ends.
- When a grant is at its limit, a new `initialize` ends one session of that grant (`filedeck_mcp_sessions_closed_total{reason="evicted"}`). A session with no open event stream goes first, and among those the one that made no request for the longest time. A session that holds an open stream goes only when every session of the grant holds one, and then again the one with the oldest last request. The client of the ended session gets 404 and starts again. One grant cannot fill the hub.
- The limit of the grant comes before the limit of the hub. When the hub holds 256 sessions and the grant is at its own limit, the new session takes the place of a session of that grant. Only a grant that is below its own limit gets 503 from a full hub.
- A stream that holds more than 1 MiB that the client has not read ends its session (reason `error`). The client connects again and does a [baseline read](#gaps-baseline-reads).
- The answer to a `POST` has the same limit. When more than 1 MiB of an answer waits in the hub because the client does not read it, the hub cuts the connection (`filedeck_mcp_errors_total{kind="slow"}`). The client sends the request again, or asks for a smaller answer (a lower `limit`). The kernel buffers of the connection are not part of the 1 MiB.
- The listener answers an `Origin` header only when it names the same host as the `Host` header. Clients that are not browsers send none. With `FILEDECK_MCP_ALLOWED_HOSTS` set, any other `Host` answers 421. Clients in the cluster use the name of the Service, so list it, or leave the setting empty. The Origin check stays on in both cases.

| Status | Meaning |
|---|---|
| 400 | A POST holds a request with an id that another request of the same session still uses. The error is a JSON-RPC `InvalidRequest`. Use a new id for each request. |
| 401 | The token is missing or matches no grant. The header `WWW-Authenticate: Bearer realm="filedeck-mcp"` is set. |
| 403 | Sign-in is on and the grant has no account. Or the `Origin` is foreign. Or the session belongs to another grant. |
| 404 | Unknown session id, or an unknown path. |
| 421 | The `Host` is not in `FILEDECK_MCP_ALLOWED_HOSTS`. |
| 503 | The server drains (see [Rollout](#rollout-and-drain)), or the hub holds 256 sessions. The header `Retry-After` is set. |

## Grants

Each client has a grant. A grant is read only. It has its own token and its own scope: the tools it may call and the resources it may read and follow. Every grant can be revoked by itself.

The grants file is a JSON array. The chart writes it from `hub.mcp.grants` into a ConfigMap, and each token comes from its own Secret, mounted as a file.

```json
[
  {
    "id": "ops-reader",
    "tokenFile": "/var/run/filedeck/mcp/ops-reader/token",
    "resources": ["filedeck://nodes/web1/", "filedeck://nodes/web2/status"],
    "tools": ["filedeck_du", "filedeck_scan_status"],
    "account": "svc-mcp"
  }
]
```

| Field | Meaning |
|---|---|
| `id` | 1 to 32 characters of `a-z`, `0-9` and `-`. Unique. It is the value of the metrics label `grant`. |
| `tokenFile` | A file that holds the token (at least 16 characters; white space at the ends is cut). Two grants may not have the same token. |
| `resources` | A list of URI prefixes and URI templates. Not empty. |
| `tools` | A list of tool names, or `*` for every tool. Not empty. |
| `account` | Sign-in on only: the account that the grant reads as. Without it the grant uses `FILEDECK_MCP_ACCOUNT`. |

Scope rules:

- A resource entry has one of three forms. With `{name}` parts it is a URI template: each part matches one path segment, and the whole URI must match. With a slash at the end it is a prefix: it matches every URI that starts with it, and its segments may be `{name}` parts (so `filedeck://nodes/{node}/` is the prefix of every node). Any other entry is one URI and matches only that URI. The parts of an entry are compared one path segment at a time. `filedeck://nodes/web1/` gives every resource of `web1`, `filedeck://nodes` gives the node list and nothing below it, and `filedeck://` gives everything.
- A node is named by the grant when some entry matches `filedeck://nodes/<node>/`: a prefix such as `filedeck://nodes/web1/` or `filedeck://nodes/`, or a template such as `filedeck://nodes/{node}/`. An entry for one resource of a node (`filedeck://nodes/web2/status`, `.../scans` or `.../jobs`) lets the session read and follow that resource only. It does not name the node.
- A tool that takes a `node` argument works only for nodes that the grant names. Another node gives a tool error that starts with `forbidden`. In the example above, the tools work on `web1`. The grant can read the status resource of `web2`, but no tool works on `web2`.
- A tool with no `node` argument works on the nodes that the grant names. `filedeck_nodes` lists only those nodes, and lists the network sources only when the grant can read `filedeck://nodes`. `filedeck_storage_groups` without `node` needs a grant for every node. The hub's own operations (`hub` as a node) need `filedeck://hub/jobs` in the grant.
- A job is visible when its node is named by the grant. `filedeck_job_get` gives `not found` for a job of another node. The server asks only the nodes of the grant, so it never reads a job of another node. A job id has 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`. Any other id is not found.

What a client sees is the same as what it may use:

- `tools/list` holds only the tools that the grant names. A tool that is not named does not exist for that session. A call of it gets a tool result with `isError: true` and the text `MCP error -32602: Tool <name> not found` (the answer of the SDK for an unknown tool). It is not a JSON-RPC error. An unknown method gets the JSON-RPC error `-32601`.
- `resources/list` and `resources/templates/list` hold only the resources and templates that the grant can read. A template is listed when the grant can read at least one URI of it. The test is made one path segment at a time: the grant `filedeck://nodes/{node}/status` lists the status template and not the scans template.
- `resources/read` and `resources/subscribe` of a URI outside the grant give the JSON-RPC error `-32602`. The message starts with `forbidden`. When no template of the grant could match, the SDK gives its own message, `Resource <uri> not found`, with the same code `-32602`. This holds also for a node that the hub does not have: a node that the grant does not name is outside the grant, whether it exists or not.
- `resources/read` of a node or a job that does not exist, and that the grant can read by its URI, gives the JSON-RPC error `-32002` (resource not found) with a message that starts with `not found`. A job of a node that the grant does not name is such a case: the job URI is in the grant, and the job is not found.
- A bad percent escape in a URI (`filedeck://nodes/%E0/status`) names nothing. A read gives `-32002`, and a subscribe gives `-32602`. It is never an internal error (`-32603`).
- A notification is sent only for a URI that the session subscribed to, so a grant never gets an event about a resource outside it.

Revocation. The hub reads the grants file and every token file again every 2 seconds. When a grant is removed, when its token file is removed or changes, or when its scope or account changes, the hub:

1. stops accepting its old token (a request with it gets 401), and
2. closes every open session of that grant, with its subscriptions and its watches (`filedeck_mcp_sessions_closed_total{reason="revoked"}`).

A request with a token that no grant has now gets 401. This is the token of a removed grant and the old token of a changed grant. A session that was open when its grant was revoked is closed, and its id gets 404. The client must open a new session with its new token. A session that opens in the moment of the revocation is closed at once. A grants file that is not valid JSON at a reload changes nothing: a half-written file never revokes everyone. A grant whose token file cannot be read, or has fewer than 16 characters, is off until the file is good.

No restart is needed. With the chart, editing a token Secret or the grants ConfigMap takes effect when the kubelet refreshes the mounted file (about a minute). Removing a grant from `hub.mcp.grants` with Helm also changes the volumes of the hub pod, so Helm rolls the hub too. The grant is revoked in both ways.

## Authentication and permissions

The server finds the grant of a request by its bearer token. Every grant is compared with a constant-time comparison, so the time of an answer does not tell how close a token is. A request without a token that matches a grant never reaches a tool. The two probe paths need no token and give no data.

A session belongs to the grant that opened it. A request on that session with the token of another grant answers 403.

Every tool call and every resource read goes through the same routes and access checks as a request from the web app. A grant does not give more than the account behind it.

### Sign-in off

The hub has no accounts. A matching token is enough. A request runs as the hub does today without sign-in: every node and every network source is open, and the grant's scope is the only limit. `account` and `FILEDECK_MCP_ACCOUNT` are not used.

### Sign-in on

A grant reads as one account: its `account`, or else `FILEDECK_MCP_ACCOUNT`. It is the virtual account with that name, or else the system account. The name may not be `root`. When the grant has no account, or the account is `root`, every request with the token of that grant answers 403. A token that matches no grant still answers 401 first.

The grant's scope and the account's access both apply. The account decides what the hub allows:

| Tool or resource | What the account needs |
|---|---|
| `filedeck_nodes`, `filedeck://nodes` | Nothing. The list holds only the nodes and sources that the account may use. |
| `filedeck_du`, `filedeck_list`, `filedeck_stat` | Access to the node and to the path. The agent refuses the rest (`forbidden`). |
| `filedeck_jobs_list`, `filedeck_job_get`, jobs resources | Nothing more. The lists hold the jobs that the account started or follows. |
| `filedeck_scan_status`, `filedeck://nodes/{node}/scans` | Scan jobs: nothing more. The scanned roots need an administrator. For another account `state` is `forbidden` and `roots` is empty. |
| `filedeck_node_status`, `filedeck://nodes/{node}/status` | An administrator account (`FILEDECK_ADMINS` or the administrator flag). |
| `filedeck_change_events` | An administrator account. |
| `filedeck_storage_groups` | An administrator account. |

Each account has its own shared watches, because the jobs and the status that an account can see differ. Two grants with the same account share them.

A refused call gives a tool result with `isError: true` and a text that starts with `forbidden`. A refused resource read gives a JSON-RPC error.

## Tools

`tools/list` shows only the tools that the session's grant names. Every tool is read only (`readOnlyHint: true`, `destructiveHint: false`). Each has an input schema and an output schema, and its result has `structuredContent` that matches the output schema. The same JSON is also in the text content. An expected failure gives `isError: true` and a text that starts with one of `not found`, `forbidden`, `unavailable` or a short description. An unexpected failure gives `isError: true` and the text `internal error`.

### `filedeck_nodes`

Input: none. Output:

| Field | Type | Meaning |
|---|---|---|
| `nodes` | array | `{name, online, roots?}`. `roots` appears for a virtual account: its granted paths. |
| `sources` | array | `{name, type, host, online, offlineReason?, readOnly?}` for each network source. |

### `filedeck_du`

Folder sizes from stored scans, like `filedeck du --cached`. It never starts a scan.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | | Node name. |
| `path` | string | | Absolute path of a folder. |
| `depth` | integer 0 to 64 | 1 | Levels below the folder. |
| `all` | boolean | false | Also list files. |

| Output | Type | Meaning |
|---|---|---|
| `node`, `path` | string | The request. |
| `stored` | boolean | False when the folder has no stored size. `entries` is then empty. |
| `entries` | array | `{path, type, bytes, diskBytes, scannedAt?, partial?}`. `type` is `dir`, `file` or `mount`. |
| `cached`, `watched` | boolean | `watched`: the change watcher covers the folder. |
| `truncated` | boolean | The answer hit the entry limit. |
| `stale` | boolean | The rows may be out of date. |
| `partial` | boolean | A scan has not finished some folders. |
| `error` | string | The agent could not read the whole answer. |

### `filedeck_list`

| Input | Type | Default | Meaning |
|---|---|---|---|
| `node`, `path` | string | | The folder. |
| `hidden` | boolean | false | Also list names that start with a dot. |
| `limit` | integer 1 to 5000 | 500 | Most entries returned. |

Output: `node`, `path`, `entries` (`{name, path, type, size, mtime, mode, ...}`, folders first), `total` (entries the agent gave), `truncated` (more entries than `limit`, or the agent cut the list).

### `filedeck_stat`

Input: `node`, `path`. Output: `node`, `entry` (`{name, path, type, size, mtime, mode, ...}`).

### `filedeck_scan_status`

| Input | Type | Meaning |
|---|---|---|
| `node` | string, optional | One node. All nodes when left out. |

Output: `nodes`, an array of `{node, state, roots, scans}`. `state` is `available`, `unsupported`, `unavailable` or `forbidden`. `roots` is an array of `{path, scannedAt, fullScan, state}` where `state` is `missing`, `partial`, `current`, `stale` or `unknown`. `scans` is an array of [jobs](#job) of kind `size` or `du`.

### `filedeck_node_status`

Input: `node` (optional). Output: `nodes`, an array of `{node, state: "available", status}`, `{node, state: "unsupported"}` or `{node, state: "unavailable", reason}`. `status` is the node status described in the [node status](#filedecknodesnodestatus) resource.

### `filedeck_jobs_list`

| Input | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | all | A node name, or `hub` for the hub's own operations. |
| `state` | string | all | For example `running` or `done`. |
| `kind` | string | all | For example `size`, `du` or `compress`. |
| `limit` | integer 1 to 1000 | 100 | |

Output: `jobs` (newest first, see [Job](#job)), `total`, `truncated`, `unavailable` (sources that did not answer).

### `filedeck_job_get`

Input: `id`, and `node` (optional: a node name or `hub`). Output: `job`. Job ids are random and unique in practice. Without `node` the first source that knows the id answers.

### `filedeck_storage_groups`

Input: `node` (optional). Output: `groups`, the answer of `GET /api/groups` (`nodes`, `unavailable`, `io`). See [Grouped storage](storage-groups.md).

### `filedeck_change_events`

Reads the change events of one node. See [Change events](#change-events-tool) for the cursor rules.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | | Node name. |
| `since` | string | oldest event kept | A cursor `<node>:<epoch>:<seq>`. |
| `kind` | array | all | `create`, `delete`, `modify`, `close_write`, `attrib`, `move`. |
| `prefix`, `glob`, `label` | arrays | | Filters as in [Filters](change-events.md#filters). |
| `type` | `file` or `dir` | both | |
| `limit` | integer 1 to 1000 | 100 | Most events returned. |
| `idleMs` | integer 50 to 5000 | 750 | End the read after this long with no event. |
| `maxMs` | integer 100 to 20000 | 5000 | End the read after this long in total. |

| Output | Type | Meaning |
|---|---|---|
| `node` | string | |
| `events` | array | Event lines as in [Event format](change-events.md#event-format). `ping` and `ready` lines are left out. |
| `count` | integer | `events.length`. |
| `nextCursor` | string, optional | The place to continue from. Give it as `since` in the next call. |
| `needsRescan` | boolean | True when `events` holds a `reset` or `overflow` event. |
| `ended` | string | `limit`, `idle`, `timeout`, `lagged` or `closed`. |

## Resources

All resources have the MIME type `application/json`. The URIs are stable. They are listed by `resources/list` (concrete resources) and `resources/templates/list` (templates).

| URI | Content |
|---|---|
| `filedeck://nodes` | The nodes and network sources. |
| `filedeck://nodes/{node}/status` | The status of a node. |
| `filedeck://nodes/{node}/scans` | The scanned roots and scan jobs of a node. |
| `filedeck://nodes/{node}/jobs` | The jobs of a node. |
| `filedeck://hub/jobs` | The hub's own operations (copy, move, trash, sync). |
| `filedeck://jobs/{id}` | One job. |

The prefix `filedeck://disk-verify/` is reserved for disk verification runs. It is not defined in contract 1.

### Body of every resource

Every body is a JSON object with these four fields, and then the fields of its own resource.

```json
{
  "type": "object",
  "required": ["contract", "uri", "revision", "updatedAt"],
  "properties": {
    "contract": {"const": 1},
    "uri": {"type": "string", "description": "the URI that was read"},
    "revision": {"type": "integer", "description": "changes only when the content changes"},
    "updatedAt": {"type": "integer", "description": "ms since 1970: when the hub first saw this revision"}
  }
}
```

### Revision

`revision` is an integer for one URI. It does not go down, also not after a hub restart. When the content of the resource changes, the hub sets a larger revision. When the content is the same, a read gives the same revision and the same `updatedAt`.

"Content" means what a notification announces: job states and errors, the list of jobs, the node state, the scanned roots and the watcher and journal state of a node. Values that move all the time do not count: the sample time, the journal age and size, subscriber counts and scan progress. A body has the current values of them, but they do not change the revision.

Compare revisions for equality only. The number is not a counter: it is the larger of the old revision plus one and the hub clock in milliseconds. The first read of a URI after a hub restart can give a new revision for content that did not change. A client then reads once more. It never misses a change.

### `filedeck://nodes`

| Field | Type | Meaning |
|---|---|---|
| `nodes` | array | `{name: string, online: boolean, roots?: string[]}` |
| `sources` | array | `{name, type, host: string, online: boolean, offlineReason?: string, readOnly?: boolean}` |

### `filedeck://nodes/{node}/status`

| Field | Type | Meaning |
|---|---|---|
| `node` | string | |
| `state` | `available` \| `unsupported` \| `unavailable` | `unsupported`: an old agent without a status route. `unavailable`: the agent does not answer. |
| `reason` | string | Only when `state` is `unavailable`. |
| `status` | object | Only when `state` is `available`. See below. |

`status`:

| Field | Type | Meaning |
|---|---|---|
| `sampledAt` | integer | When the agent made the sample (ms). |
| `sizeStore` | `{available: boolean, damaged: boolean}` | |
| `roots` | array | `{path, scannedAt: integer\|null, fullScan: boolean, state: "missing"\|"partial"\|"current"\|"stale"\|"unknown"}` |
| `watcher` | object | `kind` (`native`\|`fanotify`), `running`, `ready`, `mounts`, `watched`, `covered`, `unsupported`, `aliases`, `unwatched`, `excluded`, `backlog`, `lostEvents`, `unresolved`, `unwatchedPaths` (string array), `coverage` (array of `{path, state: "watched"\|"unwatched"\|"unknown"}`) |
| `journal` | object | `serving`, `epoch`, `oldestCursor`, `newestCursor`, `oldestAgeMs`, `bytes`, `subscribers` (`{socket, http, internal}`), `lagMs`, `overflows`, `dropped` |

### `filedeck://nodes/{node}/scans`

| Field | Type | Meaning |
|---|---|---|
| `node` | string | |
| `state` | string | `available`, `unsupported`, `unavailable` or `forbidden` (see [permissions](#authentication-and-permissions)). |
| `roots` | array | Scanned roots, as in the status. Empty unless `state` is `available`. |
| `scans` | array | [Jobs](#job) of kind `size` or `du`. |

### `filedeck://nodes/{node}/jobs` and `filedeck://hub/jobs`

| Field | Type | Meaning |
|---|---|---|
| `node` | string | The node name, or `hub`. |
| `jobs` | array | [Jobs](#job), newest first as the agent lists them. |

### `filedeck://jobs/{id}`

| Field | Type | Meaning |
|---|---|---|
| `job` | object | The [job](#job). |

An unknown id gives the JSON-RPC error `-32002` (resource not found). A job that the agent or the hub no longer lists gives the same error. So does a job of a node that the grant does not name.

### Job

| Field | Type | Meaning |
|---|---|---|
| `id` | string | |
| `kind` | string | `size` and `du` are scans. Others are for example `compress`, `extract` and the hub's operations. |
| `title` | string | |
| `state` | string | `queued`, `running`, `done`, `failed`, `canceled` and others that the node reports. |
| `node` | string | The node, or `hub`. |
| `origin` | string, optional | `ui` or `cli`. |
| `createdAt`, `startedAt`, `finishedAt` | integer, optional | ms since 1970. |
| `error` | string, optional | |
| `progress` | object, optional | For a scan: `{entries, totalEntries, bytes, current}`. |

The job result is never included. A scan result is a whole folder tree. Read the sizes with `filedeck_du`.

## Subscriptions and notifications

The server declares the capabilities `resources.subscribe` and `resources.listChanged`.

### Subscribe

`resources/subscribe` with a `uri` follows one resource. The URI must be one of the URIs above for a node or a job that exists. Any other URI gives the JSON-RPC error `-32602` (unknown resource, unknown node or unknown job). A job counts as unknown when its node is not named by the grant: the hub searches only the nodes of the grant, so it never reads, polls or announces a job of another node. The answer comes when the server knows the current state, so a change after the answer is never missed. Subscribing again to the same URI is not an error. `resources/unsubscribe` ends it, and it is not an error to unsubscribe from a URI that was never subscribed.

### `notifications/resources/updated`

The params hold the `uri` and the `_meta` object:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "filedeck://nodes/web1/scans",
    "_meta": {
      "eventId": "3f9a0c1d2b4e.1795600012345",
      "filedeck": {
        "eventId": "3f9a0c1d2b4e.1795600012345",
        "revision": 1795600012345,
        "uri": "filedeck://nodes/web1/scans",
        "changeId": "a41c9e07b2d3",
        "streamId": "7c1d9e2a",
        "seq": 3
      }
    }
  }
}
```

`params.uri` is the only field that the MCP specification (2025-06-18) defines. The server sends no `title` and no other field. `_meta` is the place that the specification gives to extra data.

| Field | Meaning |
|---|---|
| `_meta.eventId` | The id of this notice, a non-empty string. It is the delivery identity: a client that dispatches work reads it here. See [Event id and change id](#event-id-and-change-id). |
| `_meta.filedeck.eventId` | The same value as `_meta.eventId`. |
| `_meta.filedeck.revision` | The revision of the resource after the change. A read of the resource after the change gives this revision, unless it changed again. |
| `_meta.filedeck.uri` | The same as `params.uri`. |
| `_meta.filedeck.changeId` | The id that ties together the notices of one change. See [Event id and change id](#event-id-and-change-id). |
| `_meta.filedeck.streamId` | The id of the event stream that carries this notice. See [Gaps](#gaps-baseline-reads). |
| `_meta.filedeck.seq` | The number of this notice on that stream: 1, 2, 3, and so on. |
| `_meta.filedeck.missed` | Only when it is more than 0: how many notices the server could not write since the previous notice, because the session had no open stream. |

The notification says that the resource changed. It does not say what changed. The client reads the resource to see the new state, for example a scan job with `state: "done"` and a `finishedAt`, and the higher `revision`.

The server sends it when:

| Resource | What causes a notification |
|---|---|
| `filedeck://nodes` | A node starts or stops answering, or its status state changes (for example from `available` to `unavailable`). |
| `filedeck://nodes/{node}/status` | The status changes in its content (see [Revision](#revision)), or the node starts or stops answering. |
| `filedeck://nodes/{node}/scans` | A scan job appears, changes state (for example `running` to `done`, `failed` or `canceled`) or goes. Or a root gets a new `scannedAt` or `state`. A finished scan is a notification on this resource and on the job. |
| `filedeck://nodes/{node}/jobs`, `filedeck://hub/jobs` | A job appears, changes state or goes. |
| `filedeck://jobs/{id}` | The job changes state, or goes. |

A scan that starts and ends between two polls gives one notification. Several changes of one resource in one poll also give one notification. A change of progress alone gives none.

How fast: the hub reads each followed node every `FILEDECK_MCP_POLL_MS` (default 5 seconds). An event reaches the client after at most one interval, plus the time of the read.

### `notifications/resources/list_changed`

Every session gets this notification, from `initialize` on. The session does not need to list resources or to subscribe first. A replacement session (after a 404, an eviction or a reconnect) is armed in the same way. The params hold `_meta.eventId` and `_meta.filedeck = {eventId, revision, uri, changeId, streamId, seq}` as above. For this notification `uri` is the fixed value `filedeck://resources` (the list itself, not a resource that can be read), and `revision` is the revision of the list: it changes when the set of job resources changes.

It covers the answer of `resources/list`. That list holds the fixed resources that the grant can read (`filedeck://nodes`, `filedeck://hub/jobs` and the `status`, `scans` and `jobs` resource of each node, which change only with the hub's settings) and `filedeck://jobs/{id}` for each job that the hub knows now and the grant can read (at most 200). The notification fires when a job appears or goes in any node or in the hub's operations that the session can see. It does not fire for a state change of a job. A session gets it only for a node or for the hub's operations that its grant names. The list of templates never changes.

After the notification, call `resources/list` again.

### Event id and change id

Every `resources/updated` and every `list_changed` notification has `_meta.eventId`, and the same value in `_meta.filedeck.eventId`.

- The id has the form `<hash>.<revision>`. `<hash>` is 12 hexadecimal characters made from the URI and the account that the session reads as. `<revision>` is the revision of the resource after the change. A client keeps the id as an opaque string.
- The same URI and the same revision give the same id, in every session of one hub process and after a reconnect. The id is unique for each URI and revision: two different resources, or two different revisions of one resource, never share an id. A hub restart is a gap: the client sees a new `streamId` (see [Gaps](#gaps-baseline-reads)) and must do baseline reads. It must not match an id from before the restart with an id from after it.
- One notice is for one resource. When one change of a source touches several resources (a job that ends changes the job, the jobs of its node, the scans of its node and the list of resources), the client gets one notice for each, and each has its own `eventId`. All of them have the same `changeId` in `_meta.filedeck`. The `changeId` is 12 hexadecimal characters made from the set of URI and revision pairs of that change: the same set gives the same `changeId`, also for a replay. A `list_changed` notice that belongs to the change has the same `changeId`.
- Use `eventId` to drop a repeat: keep the ids that you have handled and drop a notice whose id you have seen. Use `changeId` when the cause matters: notices with one `changeId` are one cause, so a client that starts work for a cause starts it once for the `changeId`, not once for each notice. Do not use `changeId` to drop a repeat.
- Two notices with the same URI and the same revision have the same id. The second one carries no new state: the revision did not change. Drop it.
- The hub itself sends each notice once to each session. A repeat can come from a proxy or from your own reconnect code. Ids exist to make a repeat harmless. A baseline read does not carry an `eventId`. Only notifications do.

### Gaps: baseline reads

The server keeps no history of notifications. A notification that a client did not receive is lost for good: the stream was closed, the client was offline, or the session ended. The client cannot ask for it again. SSE resumption is not supported: a `GET` with `Last-Event-ID` opens a new stream and the header is ignored. The server writes no SSE `id` field.

**How a client sees a gap.** Each event stream (each `GET` that the server accepts, one for each session at a time) has a `streamId`, 8 hexadecimal characters, new for each stream. The notices on a stream are numbered by `seq`. The first notice of a stream has `seq` 1. `resources/updated` and `list_changed` use the same count. A notice that the server cannot write because the session has no open stream is counted, and the next notice that is written has `missed` set to that number. Treat any of these as a gap:

1. Your stream ended or failed, for any reason: the end of the stream, a network error, an HTTP error on the `GET`, a 409 (the server still holds the old stream), a 503, or a 404.
2. A notice has a `streamId` that is not the `streamId` of the notice before it. The stream was replaced.
3. A notice has a `seq` that is not the previous `seq` plus 1 on the same `streamId`, or the first notice of a stream that you opened has a `seq` other than 1.
4. A notice has `missed` (more than 0).
5. Your session ended or changed: a 404, a new `initialize`, a hub restart, or a drain.

Rule 1 and rule 5 need no field. A client whose transport reconnects by itself and hides that from the client still sees rules 2, 3 and 4. A notice that the server wrote to a connection that broke before the client read it is lost with no field to show it. Only rule 1 finds that, so rule 1 is the main rule.

**What a client does after a gap.** It does baseline reads. The server cannot say what was missed or how many changes happened.

- A baseline read is the read of each followed resource (`resources/read`) after the client has subscribed again. It gives the state now, with its `revision` and `updatedAt`.
- A baseline read is never an event. A client that starts work for each notification (for example an agent run) starts no work because of a gap, a reconnect, a new session or a baseline read. This is also true when the `revision` of the baseline read is not the one that the client kept: the client records the new state and the new revision, and starts nothing. Work starts only for a notification with a new `eventId` that arrives on an open stream. A baseline read and a gap give zero run admissions.
- Compare the `revision` of the baseline read with the one that you kept for the URI. When they are equal, nothing that you follow changed. When they differ, the content changed at least once, and you hold the new state. The revision is the only signal that survives a gap. A change that went one way and back between two reads can give the same revision, and then the content is the same too.
- A baseline read has no `eventId`.

Procedure after a gap:

1. If the session is gone (404) or you are not sure, send `initialize` and keep the new session id. Otherwise keep the session.
2. Open the event stream (`GET`) again. On 409 wait a moment and try once more, or start a new session.
3. Send `resources/subscribe` for each resource that you follow.
4. Send `resources/read` for each one (the baseline read), record the `revision`, and start no work from it.
5. For the change journal of a node, continue from your last cursor (see [Change events tool](#change-events-tool)). The journal cursor is a different thing from `streamId` and `seq`.

Subscribe first and read second, so a change between the two steps gives a notification and no change is lost. A notification can arrive for a state that you have already read. You then find the same `revision`, and the notice has the `eventId` that follows from it.

### Subscriptions end with the session

Subscriptions belong to the session. They do not survive the end of a session: a closed connection that the client does not resume, a `DELETE`, a session that was idle for 15 minutes, a revoked grant, a hub restart or a drain. After that, the old `Mcp-Session-Id` answers 404.

### Shared watch

The hub does not start a poll for each session. For each account and node there is at most one shared watch (sessions of grants with the same account share it). It starts when the first session opens (`initialize`), because every session gets `list_changed`, and it stops when the last session leaves. A session starts the watches of the nodes that its grant names, and of the hub's operations when the grant names them. The hub's own operations have one shared watch in the same way. While no session is open, the hub asks no agent for anything.

While a watch runs, a read of one job (`filedeck://jobs/{id}`, `filedeck_job_get`) answers from what the last poll saw, so it can be up to one poll interval old. A read after a notification is never older than the notification.

## Change events tool

`filedeck_change_events` reads the journal of one node ([Change events](change-events.md)). It reads, and it stops. It does not follow the live stream.

### Two different cursors

Do not mix up these two. They are not related.

| | Journal cursor | `Last-Event-ID` |
|---|---|---|
| What it is | A place in the change journal of one node: `<node>:<epoch>:<seq>`. It is part of the data. | A header of the streamable HTTP transport. It is a place in one SSE stream of one session. |
| Who makes it | The agent of the node, for each file change. | The transport, for each message that it sends on a stream. |
| What it is for | To continue reading file changes after a pause, also across sessions and restarts: `since`. | To resume a stream after a broken connection, so no message of that stream is lost. |
| Supported here | Yes. `filedeck_change_events` takes it as `since` and gives `nextCursor`. | **No.** The server writes no SSE `id`. |
| Gap signal | `reset` and `overflow` events, `needsRescan`. | `_meta.filedeck.streamId`, `seq` and `missed` of the notifications (see [Gaps](#gaps-baseline-reads)). These are not SSE ids. Do not send them as `Last-Event-ID`. |

The server does not support SSE stream resumption. It keeps no event store. A `GET` with the header `Last-Event-ID` is accepted, the header is ignored, and the server opens a new stream with no replay. Messages that were sent on the old stream and not received are lost. This is why a client must do a [baseline read](#gaps-baseline-reads) after a reconnect.

### Rules

- Cursor: `<node>:<epoch>:<seq>`. `seq` rises by one for each event of the node. `epoch` changes when the journal is lost or restarted.
- `since` is exclusive: the call returns the events after that cursor, in order, with no gap and no repeat inside one call. Delivery between calls is at least once. Handle a repeat.
- Catch-up: keep `nextCursor` of each answer, and give it as `since` in the next call. When `ended` is `limit`, there may be more events: call again at once. When it is `idle` or `timeout`, you have what the journal holds now.
- Without `since`, the read starts at the oldest event that the journal keeps. Page forward with `nextCursor`.
- `reset`: the agent cannot continue from your cursor (another epoch, older than the journal, or newer than it), or it lost events (a helper crash, a mount it could not watch). `events` holds the `reset` event. Its cursor is the head of the journal and becomes `nextCursor`. `needsRescan` is true. Scan again what you follow (for example with `filedeck_du` and `filedeck_list`), and then continue from `nextCursor`.
- `overflow`: the kernel dropped events. `needsRescan` is true. Scan again what you follow.
- `lagged`: the agent ended the stream because the reader was too slow. `ended` is `lagged`, and `nextCursor` is the cursor of the last event that was sent. Call again with `since` set to it. No event is lost.
- A node that does not answer gives a tool error (`unavailable`). A node without a journal (no fanotify helper) gives no events.

## Retention, expiry and reset

What the server keeps, and what a client gets when it is gone:

| What | How long | After that |
|---|---|---|
| Journal events of a node | `FILEDECK_EVENTS_JOURNAL_HOURS` (default 24) and `FILEDECK_EVENTS_JOURNAL_BYTES` (default 2 GiB), whichever limit comes first. They are agent settings. | A `since` cursor older than the oldest kept event, from another epoch, or newer than the head gets a `reset` event. `needsRescan` is true. The client scans again and continues from `nextCursor`. |
| Notifications (`resources/updated`, `list_changed`) | Not kept. There is no history and no replay. A notice with no open stream is dropped and counted in `missed`. | A client that missed one reads the resource: a baseline read. It starts no work from that read. |
| Event streams | One for each session. It ends with the connection, the session or a drain. | A new stream has a new `streamId` and `seq` 1. A `GET` while the old stream is still open gets 409. |
| A session | Until `DELETE`, a drain, a revocation, or 15 minutes with no request and no open stream. | 404 on the old session id. The client starts a new session, subscribes again and does a baseline read. |
| Subscriptions | As long as the session. | They are gone with it. Subscribe again. |
| Resource revisions | In the hub's memory. A restart starts them again from the hub clock. | The first read after a restart can give a new revision for unchanged content. The client reads the state once more. It never misses a change. |
| Jobs | As long as the agent or the hub lists them. A finished job is removed after a time that the node sets. | The job resource then gives "not found", and a notification (`job.removed`) tells the list resources. |
| Event ids | Not kept. An id is made from the URI and the revision: the same URI and revision give the same id. | A repeat is dropped by `eventId`. After a hub restart the client sees a gap (a new `streamId`) and does baseline reads. |
| Domain journal cursor | In the agent: see the first row. The hub keeps none. | A `reset` event, as in the first row. It has nothing to do with the event ids of the notifications. |

## Commissioning list

This list is what a client records when it commissions a FileDeck connection. The names and URIs are exact.

| Item | Value |
|---|---|
| Endpoint | `https://<service>:<port>/mcp`. The port is `hub.mcp.port` (default 9092). Streamable HTTP, protocol 2025-06-18 or 2025-11-25. |
| Credential | `Authorization: Bearer <token>`, one token for each grant. The server sends no cookie. |
| Contract | 2 (`instructions` of `initialize`, and `contract` in every resource body) |
| Subscriptions | `resources/subscribe` and `resources/unsubscribe`, on every URI in the table of concrete URIs below. At most 256 for each session. |
| List changes | `notifications/resources/list_changed`, for every session, from `initialize`. |
| Delivery identity | `params._meta.eventId` (and `params._meta.filedeck.eventId`) on every notification. |
| Stream resumption | None. `Last-Event-ID` is ignored. Use `streamId`, `seq` and `missed` to see a gap, and baseline reads to recover. |

Tools (all read only, `readOnlyHint: true`):

| Tool | Needs for the node |
|---|---|
| `filedeck_nodes` | none (it lists the nodes of the grant) |
| `filedeck_du` | `node` named by the grant |
| `filedeck_list` | `node` named by the grant |
| `filedeck_stat` | `node` named by the grant |
| `filedeck_scan_status` | nodes named by the grant |
| `filedeck_node_status` | nodes named by the grant, and an administrator account when sign-in is on |
| `filedeck_jobs_list` | nodes named by the grant, and `filedeck://hub/jobs` for `hub` |
| `filedeck_job_get` | the node of the job named by the grant |
| `filedeck_storage_groups` | `node` named by the grant, or every node; an administrator account when sign-in is on |
| `filedeck_change_events` | `node` named by the grant, and an administrator account when sign-in is on |

Concrete resource URIs. `<node>` is a node name from `filedeck_nodes`, percent-encoded. `<id>` is a job id of 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`.

| URI | Content | Subscribe | `resources/list` |
|---|---|---|---|
| `filedeck://nodes` | the nodes and network sources | yes | yes |
| `filedeck://nodes/<node>/status` | the status of one node | yes | yes, for each node |
| `filedeck://nodes/<node>/scans` | the scanned roots and scan jobs of one node | yes | yes, for each node |
| `filedeck://nodes/<node>/jobs` | the jobs of one node | yes | yes, for each node |
| `filedeck://hub/jobs` | the hub's own operations | yes | yes |
| `filedeck://jobs/<id>` | one job | yes | yes, for the jobs that the hub knows (at most 200) |
| `filedeck://resources` | not a resource: the `uri` of `list_changed` notices | no | no |

Resource templates (`resources/templates/list`): `filedeck://nodes/{node}/status`, `filedeck://nodes/{node}/scans`, `filedeck://nodes/{node}/jobs` and `filedeck://jobs/{id}`. A grant sees only the templates that it can read.

Grant entries that give these (the field `resources` of a grant): `filedeck://nodes/<node>/` for one node with its tools, `filedeck://nodes/<node>/status` for one resource only, `filedeck://nodes` for the node list, `filedeck://hub/jobs` for the hub's operations and `filedeck://jobs/` for the job URIs.

Rejection codes to prove: a missing or wrong token gives HTTP 401, a foreign `Origin` gives 403, an unknown session gives 404, a read or subscribe outside the grant gives `-32602`, a missing node or job in the grant gives `-32002`, an unknown method gives `-32601`, and a tool outside the grant gives a result with `isError: true` and the text `MCP error -32602: Tool <name> not found`.

## Metrics

The MCP server adds these lines to the hub metrics, on the hub metrics port (`hub.metricsPort`, `FILEDECK_HUB_METRICS_PORT`). Without that setting they are on the hub's HTTP port, as the other hub metrics are.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `filedeck_mcp_sessions` | gauge | `grant` | Open sessions. |
| `filedeck_mcp_subscriptions` | gauge | `grant` | Subscriptions held by open sessions. |
| `filedeck_mcp_grants` | gauge | | Grants that are active now. |
| `filedeck_mcp_inflight_requests` | gauge | | Requests being answered now. |
| `filedeck_mcp_watched_nodes` | gauge | | Sources (nodes and the hub's operations) with a running shared watch. |
| `filedeck_mcp_draining` | gauge | | 1 while the server drains. |
| `filedeck_mcp_sessions_opened_total` | counter | `grant` | Sessions opened. |
| `filedeck_mcp_sessions_closed_total` | counter | `grant`, `reason` | `client`, `idle`, `drain`, `revoked`, `evicted` (the grant was at its limit of sessions) or `error`. |
| `filedeck_mcp_notifications_total` | counter | `grant`, `kind` | `resource_updated` or `list_changed`. |
| `filedeck_mcp_tool_calls_total` | counter | `grant`, `tool`, `outcome` | `ok` or `error`. |
| `filedeck_mcp_tool_duration_seconds` | histogram | `grant`, `tool` | Duration of a tool call. |
| `filedeck_mcp_http_requests_total` | counter | `grant`, `outcome` | Requests to `/mcp`: `ok`, `unauthorized`, `forbidden`, `wrong_grant`, `bad_host`, `bad_origin`, `bad_body`, `bad_method`, `unknown_session`, `no_session`, `draining`, `busy`, `not_found`, `error`. `grant` is `none` until a token matched. |
| `filedeck_mcp_errors_total` | counter | `grant`, `kind` | `auth`, `protocol`, `internal`, `notify`, `slow` (an answer was cut because the client did not read it) or `watch`. |
| `filedeck_mcp_watch_polls_total` | counter | `source`, `outcome` | Polls of an agent by a shared watch (one for each account and node). `source` is a node name or `hub`. `outcome` is `ok` or `error`. |

## Rollout and drain

- Liveness: `GET /mcp/healthz` answers 200 while the MCP listener accepts requests and the hub's own listener answers on loopback. On a connection that is open during a drain it still answers 200.
- Readiness: `GET /mcp/readyz` answers 200 while the server takes new sessions. It answers 503 from the first moment of a drain. With the chart, `hub.mcp.enabled` makes the hub pod use these two paths as its readiness and liveness probes, with the scheme `HTTPS`.
- Drain, on `SIGTERM`: the listener closes, so a new connection is refused. A request on a connection that is still open (keep-alive) gets 503 with `Retry-After`, and so does `initialize`. The server lets every tool call in flight finish and then closes every session and its streams. The drain has no timer and no time limit: it waits until the server has answered every call in flight. It waits for the work, not for the client: a client that does not read its answer does not hold the drain, and a call that the client cancelled (`notifications/cancelled`) is not work in flight. The grace period of the pod (`terminationGracePeriodSeconds`) is the only limit, and it ends the process. The timers of the hub's own shutdown start when the MCP drain ends. Then the hub runs its clean-up, which cuts any MCP connection that is still open, and stops as it does without MCP. A client that sees its stream end reconnects and follows the procedure in [Gaps: baseline reads](#gaps-baseline-reads).

## Adding a module

The server has an internal interface, `McpModule` (`server/src/mcp/events.ts`). A module adds tools and resources to each session, says which URIs need a live watch (`follow`, and `followList` for the list of resources, which every session gets), and pushes events through a sink (`updated(uri)`, `listChanged()`). The server core gives each notice its `eventId`, from the audience, the URI and the revision. The node and job watch described above is the first module. A module gets the session (`grant`, `audience`, `scope`, a caller and the metrics) in `register`, `follow` and `followList`, and must check the grant's scope for what it adds. A new source of events (for example disk verification runs) is one more module in the list that `createMcp` gets. The server core does not change. Such a module defines its own URIs under its own prefix and adds them to this page.
