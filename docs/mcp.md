# MCP server

`contract: 1`

The hub can run a [Model Context Protocol](https://modelcontextprotocol.io) server. A client reads FileDeck data (sizes, folders, scans, jobs, node status, change events) with tools and resources. A client can also subscribe to resources, and the server then sends an event when a scan finishes, a job changes state or a node changes status. The client does not poll.

The server is read only. No tool changes a file, starts a scan or starts a job.

FileDeck runs no AI agent of its own. There is no ACP (Agent Client Protocol) endpoint. The MCP server is the only machine interface of this kind.

## Contract version

This page describes contract 1. The server tells the client the contract in three places: the `instructions` text of the `initialize` answer ("FileDeck contract 1"), the field `contract` in every resource body, and this page.

The contract number rises when a tool, a field or a URI changes in a way that can break a client. A new field, a new tool or a new resource does not raise it. A client must ignore fields that it does not know.

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
| Chart switch | `hub.mcp.enabled` (default `false`) |
| Allowed clients | `hub.mcp.allowFrom`: a list of NetworkPolicy peers. Empty (the default) means no peer can reach the port. |
| Plain HTTP | `FILEDECK_MCP_ALLOW_PLAINTEXT=1`. For tests only. The chart has no value for it. |

The server never uses the port of the file API and never appears in the public route. The Service has a port named `mcp`, and a NetworkPolicy lets only `hub.mcp.allowFrom` reach it. That policy is made whenever `hub.mcp.enabled` is true. It does not close the other hub ports.

The listener does not start, and the hub runs on without MCP, in these cases. Each case writes one log line that names the missing setting.

- `FILEDECK_MCP_GRANTS_FILE` is not set, or the file is not valid JSON at start. The listener never runs without a way to check a token.
- There is no TLS certificate and `FILEDECK_MCP_ALLOW_PLAINTEXT` is not `1`. The listener never serves plain HTTP.
- The certificate or key file cannot be read.

A grants file with no grants is valid. The listener then answers 401 to every request.

## Transport

- The listener serves HTTPS only when TLS is configured, and it serves nothing else on that port. The hub reads the certificate and the key again every 5 seconds. A renewed pair (for example from cert-manager) is used for new connections with no restart. A pair that cannot be loaded is ignored, and the last good pair stays.
- MCP protocol versions 2025-11-25 and 2025-06-18 are tested. The server answers with the version that the client asks for when it knows that version.
- One endpoint, `/mcp`. `POST` sends a request, a notification or a response. `GET` opens the stream for notifications from the server. `DELETE` ends the session. `PUT` and the other methods answer 405.
- The first request must be `initialize`. The answer has the header `Mcp-Session-Id`. The client sends that header on every other request, with the same token. An unknown session id answers 404, and the client then starts again with `initialize`.
- A request body has at most 4 MiB. A hub holds at most 256 sessions and a session at most 256 subscriptions. A session with no request and no open stream for 15 minutes ends.
- The listener answers an `Origin` header only when it names the same host as the `Host` header. Clients that are not browsers send none. With `FILEDECK_ALLOWED_HOSTS` set, any other `Host` answers 421.

| Status | Meaning |
|---|---|
| 401 | The token is missing or matches no grant. The header `WWW-Authenticate: Bearer realm="filedeck-mcp"` is set. |
| 403 | Sign-in is on and the grant has no account. Or the `Origin` is foreign. Or the session belongs to another grant. |
| 404 | Unknown session id, or an unknown path. |
| 421 | The `Host` is not in `FILEDECK_ALLOWED_HOSTS`. |
| 503 | The server drains (see [Rollout](#rollout-and-drain)). The header `Retry-After` is set. |

## Grants

Each client has a grant. A grant is read only. It has its own token and its own scope: the tools it may call and the resources it may read and follow. Every grant can be revoked by itself.

The grants file is a JSON array. The chart writes it from `hub.mcp.grants` into a ConfigMap, and each token comes from its own Secret, mounted as a file.

```json
[
  {
    "id": "ops-reader",
    "tokenFile": "/var/run/filedeck/mcp/ops-reader/token",
    "resources": ["filedeck://nodes/web1/", "filedeck://nodes/{node}/status"],
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

- A resource entry with `{name}` parts is a URI template: each part matches one path segment, and the whole URI must match. Any other entry is a prefix. `filedeck://nodes/web1/` gives every resource of `web1`, and `filedeck://` gives everything. Write the slash at the end of a prefix: `filedeck://nodes/web1` also matches `filedeck://nodes/web10/status`.
- A tool that takes a `node` argument works only for nodes that the grant names: a node is named when some entry matches one of `filedeck://nodes/{node}/status`, `.../scans` or `.../jobs`. Another node gives a tool error that starts with `forbidden`.
- A tool with no `node` argument works on the nodes that the grant names. `filedeck_nodes` lists only those nodes, and lists the network sources only when the grant can read `filedeck://nodes`. `filedeck_storage_groups` without `node` needs a grant for every node. The hub's own operations (`hub` as a node) need `filedeck://hub/jobs` in the grant.
- A job is visible when its node is. `filedeck_job_get` gives `not found` for a job of another node.

What a client sees is the same as what it may use:

- `tools/list` holds only the tools that the grant names. A tool that is not named does not exist for that session: a call gets the SDK answer "not found".
- `resources/list` and `resources/templates/list` hold only the resources and templates that the grant can read.
- `resources/read` and `resources/subscribe` of a URI outside the grant give the JSON-RPC error `-32602` with a message that starts with `forbidden`.
- A notification is sent only for a URI that the session subscribed to, so a grant never gets an event about a resource outside it.

Revocation. The hub reads the grants file and every token file again every 2 seconds. When a grant is removed, when its token file is removed or changes, or when its scope or account changes, the hub:

1. stops accepting its old token (a request with it gets 401), and
2. closes every open session of that grant, with its subscriptions and its watches (`filedeck_mcp_sessions_closed_total{reason="revoked"}`).

The client of a revoked session gets 404 on its next request and must open a new session with its new token. A grants file that is not valid JSON at a reload changes nothing: a half-written file never revokes everyone. A grant whose token file cannot be read, or has fewer than 16 characters, is off until the file is good.

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

An unknown id gives the JSON-RPC error "not found". A job that the agent or the hub no longer lists gives the same error.

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

`resources/subscribe` with a `uri` follows one resource. The URI must be one of the URIs above for a node or a job that exists. Any other URI gives the JSON-RPC error `-32602` (unknown resource, unknown node or unknown job). The answer comes when the server knows the current state, so a change after the answer is never missed. Subscribing again to the same URI is not an error. `resources/unsubscribe` ends it, and it is not an error to unsubscribe from a URI that was never subscribed.

### `notifications/resources/updated`

The params hold the `uri` and the `_meta.filedeck` object:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "filedeck://nodes/web1/scans",
    "_meta": {"filedeck": {"eventId": "9f3a1c2e.41", "revision": 1795600012345, "uri": "filedeck://nodes/web1/scans"}}
  }
}
```

`params.uri` is the only field that the MCP specification (2025-06-18) defines. The server sends no `title` and no other field. `_meta` is the place that the specification gives to extra data.

| Field | Meaning |
|---|---|
| `eventId` | The id of this change. See [Replay and dedup key](#replay-and-dedup-key). |
| `revision` | The revision of the resource after the change. A read of the resource after the change gives this revision, unless it changed again. |
| `uri` | The same as `params.uri`. |

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

A session gets this notification after its first `resources/list`. A session that never listed gets none. The params hold `_meta.filedeck = {eventId, revision, uri}` as above. For this notification `uri` is the fixed value `filedeck://resources` (the list itself, not a resource that can be read), and `revision` is the revision of the list: it changes when the set of job resources changes.

It covers the answer of `resources/list`. That list holds the fixed resources that the grant can read (`filedeck://nodes`, `filedeck://hub/jobs` and the `status`, `scans` and `jobs` resource of each node, which change only with the hub's settings) and `filedeck://jobs/{id}` for each job that the hub knows now and the grant can read (at most 200). The notification fires when a job appears or goes in any node or in the hub's operations that the session can see. It does not fire for a state change of a job. The list of templates never changes.

After the notification, call `resources/list` again.

### Replay and dedup key

Every `resources/updated` and every `list_changed` notification has `_meta.filedeck.eventId`.

- The id has the form `<boot>.<n>`. `<boot>` is 8 hexadecimal characters that the hub picks at each start. `<n>` rises by one for each change that the hub announces. An id is new for each change, and it is never used twice, also not after a hub restart.
- One change has one id. When several sessions get the same change, they all get the same id. When the same session gets the same notification again, it has the same id.
- Use: keep the ids that you have handled for each `uri` (the last one is enough, since ids rise within one `<boot>`). Drop a notification whose `eventId` you have seen. Otherwise read the resource, or skip the read when you already hold a `revision` that is equal or higher than `_meta.filedeck.revision`.
- The hub itself sends each notification once, to each session. A repeat can come from a proxy or from your own reconnect code. Ids exist to make a repeat harmless.
- An id from before a hub restart has a different `<boot>`. After a restart every client has lost its session anyway (see below), and starts again with a baseline read.

### Gaps: baseline reads

The server keeps no history of notifications. A notification that a client did not receive is lost for good: the stream was closed, the client was offline, or the session ended. The client cannot ask for it again.

After any gap, a client must read the resources again. This is a baseline read. Do it after a reconnect, after a new session, after a hub restart, after a 404 on a session, and when you are not sure that you got every notification.

- A baseline read is not a change event. It gives the state now, with its `revision` and `updatedAt`. It says nothing about what happened during the gap. Do not treat the read as "something changed". Compare its `revision` with the one that you kept for the URI. When they are equal, nothing that you follow changed. When they differ, the content changed at least once, and you process the new state.
- The revision is the only signal that survives a gap. A change that went one way and back between two reads can give the same revision, and then the content is the same too.
- A baseline read does not carry an `eventId`. Only notifications do.

Procedure after a reconnect:

1. Send `initialize` and keep the new session id.
2. Send `resources/subscribe` for each resource that you follow.
3. Send `resources/read` for each one (the baseline read), and compare `revision` with the one that you kept. Then keep the new revision.
4. For the change journal of a node, continue from your last cursor (see [Change events tool](#change-events-tool)).

Subscribe first and read second, so a change between the two steps gives a notification and no change is lost. A notification can arrive for a state that you have already read. You then find the same revision.

### Subscriptions end with the session

Subscriptions belong to the session. They do not survive the end of a session: a closed connection that the client does not resume, a `DELETE`, a session that was idle for 15 minutes, a revoked grant, a hub restart or a drain. After that, the old `Mcp-Session-Id` answers 404.

### Shared watch

The hub does not start a poll for each session. For each node there is at most one shared watch. It starts when the first session follows the node (a subscription, or a `resources/list` that returned) and it stops when the last session leaves. The hub's own operations have one shared watch in the same way. While no session follows, the hub asks no agent for anything.

## Change events tool

`filedeck_change_events` reads the journal of one node ([Change events](change-events.md)). It reads, and it stops. It does not follow the live stream.

### Two different cursors

Do not mix up these two. They are not related.

| | Journal cursor | `Last-Event-ID` |
|---|---|---|
| What it is | A place in the change journal of one node: `<node>:<epoch>:<seq>`. It is part of the data. | A header of the streamable HTTP transport. It is a place in one SSE stream of one session. |
| Who makes it | The agent of the node, for each file change. | The transport, for each message that it sends on a stream. |
| What it is for | To continue reading file changes after a pause, also across sessions and restarts: `since`. | To resume a stream after a broken connection, so no message of that stream is lost. |
| Supported here | Yes. `filedeck_change_events` takes it as `since` and gives `nextCursor`. | **No.** |

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
| Notifications (`resources/updated`, `list_changed`) | Not kept. There is no history and no replay. | A client that missed one reads the resource: a baseline read. |
| A session | Until `DELETE`, a drain, a revocation, or 15 minutes with no request and no open stream. | 404 on the old session id. The client starts a new session, subscribes again and does a baseline read. |
| Subscriptions | As long as the session. | They are gone with it. Subscribe again. |
| Resource revisions | In the hub's memory. A restart starts them again from the hub clock. | The first read after a restart can give a new revision for unchanged content. The client reads the state once more. It never misses a change. |
| Jobs | As long as the agent or the hub lists them. A finished job is removed after a time that the node sets. | The job resource then gives "not found", and a notification (`job.removed`) tells the list resources. |
| Event ids | Not kept. They are made for each notification. | A repeat is dropped by `eventId`. |

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
| `filedeck_mcp_sessions_closed_total` | counter | `grant`, `reason` | `client`, `idle`, `drain`, `revoked` or `error`. |
| `filedeck_mcp_notifications_total` | counter | `grant`, `kind` | `resource_updated` or `list_changed`. |
| `filedeck_mcp_tool_calls_total` | counter | `grant`, `tool`, `outcome` | `ok` or `error`. |
| `filedeck_mcp_tool_duration_seconds` | histogram | `grant`, `tool` | Duration of a tool call. |
| `filedeck_mcp_http_requests_total` | counter | `grant`, `outcome` | Requests to `/mcp`: `ok`, `unauthorized`, `forbidden`, `wrong_grant`, `bad_host`, `bad_origin`, `bad_body`, `bad_method`, `unknown_session`, `no_session`, `draining`, `busy`, `not_found`, `error`. `grant` is `none` until a token matched. |
| `filedeck_mcp_errors_total` | counter | `grant`, `kind` | `auth`, `protocol`, `internal`, `notify` or `watch`. |
| `filedeck_mcp_watch_polls_total` | counter | `source`, `outcome` | Polls of an agent by a shared watch (one for each account and node). `source` is a node name or `hub`. `outcome` is `ok` or `error`. |

## Rollout and drain

- Liveness: `GET /mcp/healthz` answers 200 while the MCP listener accepts requests and the hub's own listener answers on loopback. It stays 200 during a drain, so a drain is not a restart.
- Readiness: `GET /mcp/readyz` answers 200 while the server takes new sessions. It answers 503 from the first moment of a drain. With the chart, `hub.mcp.enabled` makes the hub pod use these two paths as its readiness and liveness probes, with the scheme `HTTPS`.
- Drain, on `SIGTERM`: the server fails readiness, answers `initialize` and every new request with 503 and `Retry-After`, lets the tool calls in flight finish (at most 4 seconds), and then closes every session and its streams. Then the hub stops as it does without MCP. A client that sees its stream end reconnects and follows the procedure in [Gaps: baseline reads](#gaps-baseline-reads).

## Adding a module

The server has an internal interface, `McpModule` (`server/src/mcp/events.ts`). A module adds tools and resources to each session, says which URIs need a live watch (`follow`), and pushes events through a sink (`updated(uri)`, `listChanged()`). The node and job watch described above is the first module. A module gets the session (`grant`, `audience`, `scope`, a caller and the metrics) in `register`, `follow` and `followList`, and must check the grant's scope for what it adds. A new source of events (for example disk verification runs) is one more module in the list that `createMcp` gets. The server core does not change. Such a module defines its own URIs under its own prefix and adds them to this page.
