# Change events

Each FileDeck agent can tell other programs about every change of the files and folders on its machine. A program reads one stream of events. It does not need a watch of its own. The agent reads the kernel change notifications once and sends each event only to the readers that asked for it.

This page describes the event stream, the filters, the cursor and the rules that make the stream gap free. The settings are in [Configuration](configuration.md#change-events). The privileges are in [Security](security.md#change-events).

## What the agent needs

- The fanotify helper runs (chart value `agent.fanotify.enabled`). It needs `CAP_SYS_ADMIN` and `CAP_DAC_READ_SEARCH`. Without it, the agent logs one line and sends no events. A reader then gets a stream that holds only `ping` lines.
- Linux 5.17 or newer gives the full output. On Linux 5.9 to 5.16 the agent still works, but a move is a `delete` and a `create`, and a folder removal empties the helper's path cache.
- The helper watches whole filesystems. It has no watch limit and no recursion limit. A new folder, a bind mount and a new file are covered at once. Network filesystems and unreachable mounts are not covered. The `ready` event lists them.
- The agent does not report changes of its own state: the journal folder `changes-<node>` and the files `index-<node>.db*`, `sizes-<node>.db*` and `jobs-<node>.db*`. Without this rule, each write of the journal would be an event that is written to the journal.
- macOS agents use FSEvents. They send the same events as best effort: a rename is a `create` when the entry exists and a `delete` when it does not, and a folder flag is known only for a `create`.

## Event format

Each event is one JSON object on one line (NDJSON). The agent encodes the line once and sends the same bytes to every reader and to the journal.

```json
{"cursor":"web1:lq3x9a2b4f:1042","time":1795600000123,"node":"web1","kind":"create","dir":false,"path":"/srv/repos/acme/app/readme.md","labels":{"org":"acme","repo":"app"}}
```

| Field | Meaning |
|---|---|
| `cursor` | Place of the event in the journal: `<node>:<epoch>:<seq>`. Keep the last one you handled. |
| `time` | When the agent read the event, in milliseconds since 1970. |
| `node` | The node name of the agent. |
| `kind` | See the list below. |
| `dir` | `true` when the entry is a folder. |
| `path` | The path of the entry, as the agent shows it (the same virtual path as in the file API). For a `move`: where the entry is now. A control event for the whole node has no path. |
| `from` | A `move` only: where the entry was. |
| `labels` | Present when a [label template](#labels) matches the path. |
| `scope`, `window`, `reason`, `unwatched` | Control events only. See below. |

Kinds of entry events:

| Kind | When |
|---|---|
| `create` | A file, folder or link was made. A move from outside the served tree is also a `create`. |
| `delete` | An entry was removed. A move to outside the served tree is also a `delete`. |
| `modify` | A file was written. A file that is written all the time gives one `modify` each second, and one more when that second ends. |
| `close_write` | A file that was open for writing was closed. |
| `attrib` | Mode, owner, times, link count or extended attributes changed. |
| `move` | An entry was renamed or moved. `path` is the new place and `from` is the old place. |

Kinds of control event. They tell you about the stream, not about one entry. Every reader gets them, whatever its filter says.

| Kind | Meaning | What to do |
|---|---|---|
| `ready` | The watcher is running. `unwatched` lists the mounts that no event covers. | Nothing. |
| `overflow` | The kernel dropped events. `scope` is `node`. `window.from` and `window.to` are the time window. | Scan everything you follow again. |
| `reset` | Events may be missing. `scope` is `node` or `filesystem`. A `filesystem` reset has the mount in `path`. `window.to` is absent while the watcher is still away. | Scan again what is in the scope. |

Two more lines are not events. `ping` comes when nothing happened for 15 seconds. It has a `cursor`. All events up to that cursor were checked against your filter, so you can keep it as your place. `lagged` ends the stream when you read too slowly. See [Slow readers](#slow-readers).

## The cursor and the gap contract

A cursor has three parts: `<node>:<epoch>:<seq>`.

- `seq` rises by one for each event of the node.
- `epoch` changes when the journal is lost or started again. Sequence numbers of an old epoch mean nothing in a new one.
- Delivery is at least once and in order for each node. After a reconnect or a hand-over, an event may come twice. It never comes out of order. Your program must handle a repeat.

To continue from a place, send `since=<cursor>`. The agent then does this:

1. It sends the events from the journal after that cursor.
2. It sends the live events. There is no gap and no repeat between step 1 and step 2.

If the agent cannot continue from your cursor, it sends one `reset` event first and then the live events. This happens when the cursor is from another epoch, is older than the journal holds, or is newer than the journal. The `cursor` of that `reset` is the head of the journal. Scan what you follow, and then store that cursor.

The agent writes a `reset` or `overflow` event when it knows that it did not see something:

- The kernel queue overflowed (`overflow`, scope `node`). The helper asks the kernel for an unlimited queue, so this happens only when the kernel refuses that.
- The helper stopped or crashed (`reset`, scope `node`, first without `window.to`, and again with it when the helper runs).
- Two agent processes took turns (a rolling update) and the second one did not watch while the first one still did (`reset`, scope `node`). When the two overlap, the agents lose nothing and send no `reset`.
- A mount could not be watched (`reset`, scope `filesystem`).

One case is not reported. When a whole folder tree is removed faster than the helper reads the events, the events inside the tree have no place to name. The `delete` of the folder is reported. The helper counts the rest in `filedeck_fanwatch_unresolved_total`.

## Filters

The agent evaluates the filter before it sends a byte. An event passes when it passes every part that you give. A part with several values passes when one value matches. `label` is different: every key must match.

| Part | Meaning |
|---|---|
| `prefix` | The path is the prefix or is below it. For a `move`, the old path counts too. Give an absolute path. |
| `glob` | The path matches one glob. Patterns without a `/` match the name at any depth. Patterns with a `/` match the whole path, written from the root: `/srv/**/*.log`. A trailing `/` matches folders only. `*`, `**`, `?`, `[a-z]`, `[!a]` and `{a,b}` work. The matcher is the one of the folder compare. It takes linear time, so a hostile pattern cannot stall the agent. |
| `kind` | One or more of `create`, `delete`, `modify`, `close_write`, `attrib`, `move`. Give the part more than once, or separate the values with commas. |
| `type` | `file` or `dir`. |
| `label` | `key:value`. The same key twice means that either value is good. |

Limits: 32 values for each part, 4096 characters for each value. A bad filter gives `400`.

## Labels

A label template turns a path into labels, with no regular expression. Each segment of the template is a fixed name or `{name}`. A `{name}` takes one folder name. Every path below the template's depth gets the labels.

```
FILEDECK_EVENTS_LABELS="/srv/repos/{org}/{repo}
/srv/repos/.worktrees/{org}/{task}/{repo}"
```

With these templates, `/srv/repos/acme/app/src/main.c` has `org=acme` and `repo=app`. `/srv/repos/.worktrees/acme/fix-1/app/a.txt` has `org=acme`, `task=fix-1` and `repo=app`. When several templates match, the one with the most fixed names wins. On a tie, the first one wins. A path above the depth of the template has no labels.

## Transports

All three transports give the same lines and use the same filter.

### Unix socket on the node

Off by default. Set `FILEDECK_EVENTS_SOCKET` (chart: `agent.events.socket.enabled`). The agent makes the folder with mode 0750 and the socket with mode 0660, and gives both to `FILEDECK_EVENTS_SOCKET_GROUP`. A program on the same machine that is in that group can connect. There is no TLS and no token. The file modes decide.

The client sends one JSON line. Both parts are optional.

```json
{"filter":{"prefix":["/srv/repos"],"glob":["*.md"],"kind":["create","modify"],"type":"file","label":["org:acme"]},"since":"web1:lq3x9a2b4f:1042"}
```

The agent answers with one JSON line for each event, and with `ping` lines when nothing happens. A bad request gets one line `{"kind":"error","error":"..."}` and the agent closes the connection. The request line has at most 16 KiB. A client has 10 seconds to send it. A client may close its writing side after the request and keep reading. The agent finds a client that vanished when it cannot write the next line.

```sh
printf '{"filter":{"prefix":["/srv/repos"],"kind":["create","delete","move"]}}\n' | socat - UNIX-CONNECT:/run/filedeck-events/events.sock
```

### Agent HTTP

`GET /api/v1/changes` on the agent gives an NDJSON stream (`application/x-ndjson`). It uses the same query parameters as the filter (`prefix`, `glob`, `kind`, `type` and `label`, each as often as you need) and `since=<cursor>`. The agent needs its agent token, so only the hub calls it. Use the hub route below.

### Hub HTTP

`GET /api/v1/changes` on the hub gives one stream for several nodes.

```sh
curl -N -H "X-Filedeck-Token: $TOKEN" \
  'https://filedeck.example/api/v1/changes?node=web1,web2&prefix=/srv/repos&kind=create&kind=move&since=web1:lq3x9a2b4f:1042&since=web2:mm0x1a2c4d:77'
```

- `node` lists the nodes (comma separated or repeated). Without it, the stream covers every node that you may use.
- The hub pushes the filter down to each agent. Each agent filters before it sends.
- `since` is a cursor of one node. Give it once for each node. A node without a `since` starts at the live events.
- The hub passes each line on as the agent wrote it, so each line names its node and carries that node's cursor. The order is kept for each node. Between nodes it is the order of arrival.
- When an agent goes away, the hub sends `{"kind":"offline","node":"web1"}` once and asks again every three seconds from the last cursor it passed on. When an agent ends a stream as `lagged`, the hub asks again at once. The reader sees one stream.
- `GET /api/nodes/<node>/api/v1/changes` gives the stream of one node in the same way.

Access:

- Sign-in off: the hub is behind your network boundary, as for the rest of the API.
- Sign-in on: administrators only. Other accounts get `403`. A stream ends when its session ends, as the live feeds do.
- API token: the token of `FILEDECK_API_TOKEN` may read the stream when `FILEDECK_API_TOKEN_SCOPES` holds `changes` (default: `du` only). With sign-in on, the token acts as `FILEDECK_API_TOKEN_ACCOUNT`, and that account must be an administrator.

### Slow readers

Each reader has a buffer of 1 MiB on the agent (4 MiB for a hub stream). A reader that does not read fast enough is ended with one last line:

```json
{"kind":"lagged","node":"web1","cursor":"web1:lq3x9a2b4f:1042","reason":"the subscriber was too slow"}
```

`cursor` is the last event that the reader was given. Connect again with `since` set to it and read the missed events from the journal. A slow reader never slows the watcher or the other readers. A hub stream that lags ends with a `lagged` line that has `cursors`, one for each node.

## The journal

The agent keeps a bounded journal of the encoded lines, so a reader that was away can continue.

- Place: the agent state folder, `changes-<node>/` next to the index files (`FILEDECK_INDEX_DIR`). Without that folder, the journal is a temporary folder that goes away with the process, and the epoch changes at each start.
- Size: the smaller of 24 hours (`FILEDECK_EVENTS_JOURNAL_HOURS`) and 2 GiB (`FILEDECK_EVENTS_JOURNAL_BYTES`). The agent removes whole segment files from the old end. `0` bytes gives a journal in memory only.
- The last events are also in memory, so a reader that is close behind reads no file.
- Only the process that holds the writer lease of the agent state writes the journal and serves readers. During a rolling update the new process keeps what it sees, and takes over when the old one stops. A reader that connects before that waits up to 15 seconds, then gets `503`.
- A new epoch starts when the journal has no segment left, or when its `meta.json` is damaged.

## Metrics

The agent adds these to `/metrics`. They are counts and ages only.

| Metric | Meaning |
|---|---|
| `filedeck_events_total{kind}` | Events by kind. |
| `filedeck_events_overflows_total`, `filedeck_events_resets_total` | Overflows and resets. |
| `filedeck_events_subscribers{transport}` | Open streams by transport (`socket`, `http`, `internal`). |
| `filedeck_events_subscribers_dropped_total` | Readers ended as `lagged`. |
| `filedeck_events_replayed_total` | Events sent from the journal. |
| `filedeck_events_serving` | 1 when this process serves streams. |
| `filedeck_events_journal_bytes`, `filedeck_events_journal_oldest_age_seconds` | Size and age of the journal. |
| `filedeck_events_bus_lag_seconds` | Time to hand an event to all readers. |
| `filedeck_fanwatch_handle_cache_hits_total`, `..._misses_total` | Folder paths the helper took from its cache, and looked up. |
| `filedeck_fanwatch_open_by_handle_total` | `open_by_handle_at` calls of the helper. |
| `filedeck_fanwatch_unresolved_total` | Events in a folder that was already removed. |
| `filedeck_fanwatch_events_read_total` | Kernel events the helper read. |
| `filedeck_fanwatch_unlimited_queue` | 1 when the kernel queue is unlimited. |

## A reader that loses nothing

```js
// Node 22. Keeps its place, handles repeats, and scans again after a reset.
import net from "node:net";
import readline from "node:readline";
let cursor = loadCursor(); // from your own store, or undefined
function connect() {
  const sock = net.connect("/run/filedeck-events/events.sock");
  sock.write(JSON.stringify({ filter: { prefix: ["/srv/repos"], kind: ["create", "delete", "move", "close_write"] }, since: cursor }) + "\n");
  readline.createInterface({ input: sock }).on("line", (line) => {
    const e = JSON.parse(line);
    if (e.kind === "ping") return void (cursor = e.cursor);
    if (e.kind === "lagged") return; // the connection ends next; the cursor is the last event you handled
    if (e.kind === "reset" || e.kind === "overflow") scanEverythingAgain(e);
    else handle(e); // handle it so that a repeat does no harm
    cursor = e.cursor;
    saveCursor(cursor);
  });
  sock.on("close", () => setTimeout(connect, 1000));
  sock.on("error", () => {});
}
connect();
```

## Fallbacks

- No helper, no capability or an old kernel: the agent logs one line. Folder sizes and the compare index use the folder modification time, as before. `GET /api/events` (the live feed of the web app) uses a bounded set of per-folder watches for folders that no kernel watcher covers. With sign-in on, the live feed of a signed-in account runs in that account's worker process, and it uses this fallback.
- The compare index follows folder changes through the event bus when the watcher runs. A watched folder is a table entry in memory, not a kernel watch. The setting `FILEDECK_INDEX_WATCHES` caps the table (default 32768).
