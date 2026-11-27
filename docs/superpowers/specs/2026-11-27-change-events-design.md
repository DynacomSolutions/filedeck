# Change events

## Intent

The owner wants three things:

1. Every change of a file or folder is tracked: create, delete, modify, close after write, attribute change and move or rename. There is no watch limit and there are no gaps.
2. One very efficient service gives these events to other services, with filters. Those services then stop making their own watches.
3. FileDeck stops using inotify for its own needs.

This design is approved by the owner. The user guide is [Change events](../../change-events.md).

## Starting point

- The helper `filedeck-fanwatch` already uses one fanotify filesystem mark for each local filesystem. It printed only the changed folder (`x|w|m PATH`) and dropped the name of the entry. `fanwatch.ts` fed these folders to the size store.
- The compare index (`index-cache.ts`) used an LRU of inotify watches. The live feed `GET /api/events` used one `fs.watch` for each folder, with a cap of 256.
- The agent container already holds `SYS_ADMIN` (when `agent.fanotify.enabled`) and `DAC_READ_SEARCH`.
- Target kernels are Linux 6 and 7, so `FAN_RENAME` and `FAN_REPORT_TARGET_FID` (5.17 and newer) exist. The helper falls back when they do not.

## Decisions

### 1. The helper reports each entry

- `fanotify_init` flags: `FAN_CLASS_NOTIF`, `FAN_REPORT_DFID_NAME`, `FAN_REPORT_FID`, `FAN_REPORT_TARGET_FID`, `FAN_UNLIMITED_QUEUE`, `FAN_NONBLOCK`, `FAN_CLOEXEC`. `FAN_REPORT_TARGET_FID` needs `FAN_REPORT_FID` and `FAN_REPORT_DFID_NAME` (the kernel header names the three together `FAN_REPORT_DFID_NAME_TARGET`). If the kernel refuses a flag, the helper drops one feature at a time (first the unlimited queue, then the target id) and says so on stderr and in a `#caps` line.
- Mask: `FAN_CREATE`, `FAN_DELETE`, `FAN_RENAME`, `FAN_ATTRIB`, `FAN_MODIFY`, `FAN_CLOSE_WRITE`, `FAN_DELETE_SELF`, `FAN_MOVE_SELF`, `FAN_ONDIR`. If the mark refuses `FAN_RENAME`, the helper uses `FAN_MOVED_FROM` and `FAN_MOVED_TO` and reports a move as a delete and a create.
- One output line for each entry event: a kind letter, a folder flag and the escaped path. A rename is one line with the new path and the old path, separated by a TAB. A TAB cannot occur in a path, because the helper escapes it.
- The same program, the same install path, the same arguments (paths of filesystems) and the same mark type (`FAN_MARK_FILESYSTEM`) as before. The helper has no new option. The one setting, the size of the path cache, is an environment variable. The existing mount handling and bind alias handling are unchanged. The lines `#ready`, `#sync`, `c PATH`, `!overflow` and the exit codes are unchanged. `#caps` and `#stats` are new.
- A path cache (fsid and file handle to folder path, 4-way sets, least recently used) answers most events without a system call. A folder that is renamed drops the whole cache with one counter increment. A folder that is removed leaves it alone: it had no children, and a handle has a generation number, so a stale entry cannot name another folder. The measured hit rate is above 99.9 percent in the benchmark.
- A file that is modified again within one second is reported once, and once more when the second ends. The held report is never lost: a close, a delete and a sync settle it.
- Output is written in one buffer for each batch of events, so there is about one `write` call for each batch.

### 2. The agent event bus

- One in-process bus (`server/src/events/`). The watcher publishes to it. The bus gives each event a cursor, encodes it once, writes it to the journal, and hands the same bytes to every reader whose filter accepts it.
- The size store keeps its path: each entry event gives the parent folder, and a folder entry also gives itself, to `applyChanged`. The old `x|w|m` lines are still read, so an old helper keeps working.
- The compare index and the live feed use the bus (see 6).

### 3. The journal

- Bounded and append only, in the agent state folder (next to the index files), else in a temporary folder. Segments of lines, whole segments removed from the old end by age and size. The last events stay in memory.
- A new epoch starts when the journal is lost or damaged. A cursor of another epoch gets a `reset`.
- Only the process that holds the writer lease of the size store writes and serves. A process that is not the writer keeps what it sees. When it becomes the writer, it appends what the old writer did not journal, with a two second overlap, and writes a `reset` when the watching of the two processes did not overlap. The writer notes the time until which it watched in `meta.json` (every five seconds and at a clean stop).
- Delivery is at least once and in order for each node. A reader with `since` gets the journal and then the live events. The reader is added to the bus and the head of the journal is read in one step, so no event falls between the two.

### 4. Filters and labels

- `prefix`, `glob`, `kind`, `type` and `label`, evaluated in the agent. A glob uses the matcher of the folder compare (linear time with a step budget). A label template matches whole segments, and the most specific template wins.
- Control events (`ready`, `overflow`, `reset`) always pass.

### 5. Transports

- A Unix socket on the node. It is off by default. The folder has mode 0750, the socket has mode 0660, and a setting names the group. The client sends one JSON line with a filter and a cursor, and reads NDJSON.
- `GET /api/v1/changes` on the agent, and on the hub with `node=a,b`. The hub pushes the filter down and reads the agent streams, passes the lines on as they are, and asks again from the last cursor when an agent goes away.
- Access: the agent route needs the agent token. The hub allows it for administrators when sign-in is on, and for the API token when its scopes hold `changes`. The agent serves the route in its root process (`ROOT_ROUTES`), because a worker process sees only one account.
- Each reader has a bounded buffer. A reader that falls behind is ended with a `lagged` line and its last cursor. It reconnects with `since`. A slow reader never blocks the bus or the watcher.

### 6. FileDeck stops using inotify

- The compare index asks the bus for folder changes while the watcher covers the folder. A watch is a table entry in memory, so no kernel watch is made. A `reset` or an `overflow` tells every watch that it may have missed something. Where the watcher does not cover a folder, the index keeps one `fs.watch` for it, as before, and trusts a folder that it does not watch by its modification time for a limited time.
- `GET /api/events` keeps its response shape. It follows the folder through the bus, with no `fs.watch` and no cap. It ends when the watcher stops, so the web app asks again.
- macOS: the FSEvents watcher publishes its folder events to the bus as best effort.

### 7. Metrics and chart

- `/metrics` gets counts and ages only (see the user guide).
- The chart gets values for the socket, the journal limits and the label templates, and `apiToken.scopes`. The defaults stay safe: the socket is off, the token reads folder sizes only. `scripts/check-chart-defaults.py` guards both.

## Remaining limits

- The bounded `fs.watch` set stays as a fallback where no kernel watcher covers a folder. That is the case without the helper (the chart default has it off), for a folder on a network filesystem, and in the worker process of a signed-in account. A worker has no bus, and giving it a feed from the root process needs a stream over the worker connection. This is a separate change. When the helper is on and ready, FileDeck makes no inotify watch for the folders it covers.
- An event inside a folder tree that was removed before the helper read the event cannot name its place. The removal of the folder is reported, and a counter shows the rest.
- A paused helper (the size store is behind) leaves events in the kernel queue. The queue is unlimited when the kernel allows it.

## Tests

- The helper runs for real: as root on the CI machine, and in an unprivileged user namespace on a tmpfs for ordinary users, with a small test library for `open_by_handle_at`.
- Unit tests cover the cursor, labels, filters, journal (restart, segments, trim by size and age, a cut last line, a lost journal), and the bus (replay with no gap, epoch reset, lagged reader, writer take-over).
- Transport tests cover the socket, the agent route, the hub fan-in (with a restart of an agent), the token scope and the administrator rule with sign-in on.
- `scripts/bench-fanwatch.sh` measures events for each second and the CPU time of the helper.
