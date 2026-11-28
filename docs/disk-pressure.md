# Disk pressure

Each FileDeck agent can show how busy its disks are and who makes them busy. It reads the disk counters of the kernel, the IO pressure (PSI), the cgroup tree and, when the machine allows it, the processes. It gives the result as a snapshot. A person or a program can read one snapshot or a live stream from the hub API. Prometheus can read a short list of series.

The feature is off by default. Chart value `agent.pressure.enabled` turns it on (setting `FILEDECK_PRESSURE=1`).

## What is measured

For each whole disk:

| Value | Meaning |
|---|---|
| `util` | Share of time the disk had IO in flight, 0 to 1. It comes from `io_ticks`. |
| `rIops`, `wIops` | Read and write operations per second. |
| `rBps`, `wBps` | Read and write bytes per second. |
| `queueDepth` | Average number of requests in the queue (`aqu-sz`, from the weighted IO time). |
| `rAwaitMs`, `wAwaitMs` | Average time of one request, queue time included. |
| `inflight` | Requests in flight when the sample was taken. |
| `mounts` | The mount points on the disk. Mounts of container runtimes are left out. |

For the whole machine: `psi`, the IO pressure of `/proc/pressure/io` (`some` and `full`, 10, 60 and 300 second averages, in percent). PSI is not split by disk.

The agent shows whole disks only. It skips partitions, loop, ram and zram devices. It skips device-mapper and md devices, unless a mount sits on them.

### Consumers

A disk has a list of consumers, the busiest first. A consumer has one of three kinds:

- `cgroup`: a cgroup that holds processes. This is a pod container, a pod, a systemd service or a scope. A cgroup that has child cgroups shows only its own IO, not the IO of its children. Nothing is counted twice.
- `process`: one process. It is a closer look at a cgroup row, so do not add process rows to cgroup rows.
- `path`: a folder that has many change events. It has `eventsPerSec` and no IO numbers. It needs the change events (`agent.fanotify.enabled`).

Names:

- Kubernetes pods get `namespace/name` and the container name. The agent finds them from the folder names under `/var/log/pods` and the links under `/var/log/containers` of the machine. It makes no API call.
- systemd units and scopes get the unit name from the cgroup path.
- An operator can add label rules for the other cgroups (see `FILEDECK_PRESSURE_LABELS`).

### Sources

| Source | How | Needs |
|---|---|---|
| `ebpf` | The helper `filedeck-iotrace` counts each IO in the kernel, with the process and the cgroup. It gives exact numbers per process and per cgroup. | The helper in `server/dist/native` or `/usr/local/bin`, and the capabilities that it needs. |
| `proc` | The agent reads `io.stat` of the cgroups and `/proc/<pid>/io` of processes. | The cgroup tree (`agent.pressure.cgroupMount`). For processes: the host process list and `CAP_SYS_PTRACE` (`agent.pressure.hostPID`). |

The agent uses `ebpf` when the helper starts and answers a first `read` with `"ok":true`. If the helper fails at any time (no kernel support, a crash, no answer within 5 seconds), the agent logs one line and uses `proc`. It does not start the helper again until the agent restarts. The snapshot field `source` says which one is in use.

In the `proc` source, a process row gets its disk IOPS from its bytes and the average IO size of the disk. Its disk is the disk of its cgroup. When several disks are busy, the bytes of the process are shared by the bytes of the cgroup on each disk. This is an estimate.

## What it needs

| Setting | Gives | Cost to the node |
|---|---|---|
| Nothing | Disk values and PSI of the whole machine (`/proc/diskstats`, `/proc/pressure/io` are not namespaced). The cgroups of the agent container only. | None. |
| `agent.pressure.cgroupMount` | The cgroup tree of the machine, read only, at `/host-cgroup`. Gives pods, services and scopes. | One read-only host path mount. |
| `agent.pressure.hostPID` | The process list of the machine. Adds `CAP_SYS_PTRACE`, which `/proc/<pid>/io` needs for processes of other users. | The agent can see all processes of the node. |
| eBPF helper (`agent.pressure.ebpf`) | Exact IO per process. See the section below. | `CAP_BPF` and `CAP_PERFMON`. |

The agent runs as root, with `CAP_SYS_ADMIN` and `CAP_DAC_READ_SEARCH` as before. The new mounts and capabilities are opt-in.

## Cost

Everything stays in memory. The agent writes nothing to disk for a sample. The agent has **no timer of its own and never samples by itself**. A sample runs only when something asks:

| Demand | What runs |
|---|---|
| `GET /api/v1/disk-pressure` | One read now. The rates cover the time since the previous read. The first read after two minutes of rest has no baseline: it takes one and waits one interval (a one-shot wait), then reads again. |
| `GET /api/v1/disk-pressure/stream` | A live view. One one-shot deadline is set again after each read, once per interval, while at least one stream is open. The last stream to close clears it. |
| `/metrics` scrape | One read per scrape. The scraper is the clock. Nothing runs between scrapes. |
| A `pressure` event above `ok` | One read, so that the latest snapshot holds the attribution of the moment. See [Change events](change-events.md#pressure). |
| Nobody asks | No timer, no event listener and no helper process. |

Reads that overlap share one result. The attribution comes from `IotraceSampler` (`server/src/iotrace.ts`): the eBPF helper when it can run, else the proc and cgroup collector in the same on-demand way. The helper itself has no timer: it reads its kernel map only when it gets a `read` line.

The cost of the sampling code is the counter `filedeck_pressure_probe_seconds_total` (CPU seconds from `process.cpuUsage`). The proc collector keeps its cost low in these ways:

- `io.stat` of a cgroup counts its children. A cgroup whose counters did not move has idle children, so the agent does not read them.
- Children that did IO in the last 5 reads are read every time. The others are read when their parent has IO that the known children do not explain.
- The agent follows at most 20,000 cgroups.
- Process rows come from the 20 busiest cgroups, at most. If the agent may not read `/proc/<pid>/io` for any process, it rests for one minute.

Measured on a machine with 1,300 cgroups and a high load: one full cgroup read took 6 to 12 ms of CPU. At one read per second that is about 0.6% of one core, and only while somebody watches.

The change event counting runs inside the event bus, only while a stream is open, and costs a few microseconds for each event. It is part of the probe seconds.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `FILEDECK_PRESSURE` | off | `1` turns the feature on. Off: no routes (404), no metrics, no sampling. |
| `FILEDECK_PRESSURE_INTERVAL_MS` | `1000` | Time between reads while a stream is open, and the wait of a one-shot read that has no baseline. From 250 to 60000. |
| `FILEDECK_PRESSURE_CGROUP_ROOT` | `/sys/fs/cgroup` | The cgroup v2 tree to read. The chart mounts the host tree at `/host-cgroup` and sets this. |
| `FILEDECK_PRESSURE_PROC_ROOT` | `/proc` | The process folders. With `hostPID`, `/proc` of the container is the one of the host. |
| `FILEDECK_PRESSURE_PATH_DEPTH` | `3` | Folder parts under a mount that make one path consumer. |
| `FILEDECK_PRESSURE_LABELS` | empty | Label rules, a JSON list. See below. |
| `FILEDECK_IOTRACE` | empty | Path of the eBPF helper. Empty: look in `/usr/local/bin` and `server/dist/native`. `off`: never use it. |
| `FILEDECK_PRESSURE_LEVELS` | empty | Filesystem pressure events: see [Change events](change-events.md#pressure). |

Chart values: `agent.pressure.enabled`, `agent.pressure.intervalMs`, `agent.pressure.pathDepth`, `agent.pressure.cgroupMount`, `agent.pressure.hostPID`, `agent.pressure.labels`, `agent.pressure.ebpf` and `agent.pressure.levels`.

### Label rules

`FILEDECK_PRESSURE_LABELS` is a JSON list. Each rule has `match` (a regular expression on the cgroup path), `label` (a template) and an optional `link` (a URL template). The first rule that matches a cgroup wins. In a template, `{1}` is the first capture group, `{name}` a named group and `{0}` the whole match. Captures in a `link` are URL-encoded. A link must start with `https://`, `http://` or `/`. The agent skips a bad rule and logs it. There are no default rules.

```json
[{"match": "^/jobs\\.slice/(?<id>[a-f0-9]+)\\.scope$", "label": "job {id}", "link": "https://example.test/jobs/{id}"}]
```

## API

All routes need the agent token, as the change events do. With sign-in on, the hub allows them for administrators only. A hub API token can read them only with the scope `disk-pressure` (`FILEDECK_API_TOKEN_SCOPES=disk-pressure`): read only, `GET` only. A Kubernetes ServiceAccount token never gets this scope: it reads folder sizes only. The filesystem levels (`/api/v1/pressure`) are a different route and belong to the scope `changes`.

### Agent

```
GET /api/v1/disk-pressure          one Snapshot (JSON)
GET /api/v1/disk-pressure/stream   NDJSON: {"type":"ready"} first, then one Snapshot for each interval
```

Query: `disk=<name>` (one disk) and `top=<n>` (consumers for each disk, from 0 to 100, default 20).

Errors: 404 when the feature is off, 400 for a bad query, 429 when 32 streams are open, 503 when no sample is ready.

A slow client gets the newest snapshot and skips the ones in between. The agent never keeps a queue for it. A one-shot request that finds no baseline answers after about one interval.

### Hub

```
GET /api/v1/disk-pressure?node=<node>[&disk=][&top=]          Snapshot of that node
GET /api/v1/disk-pressure/stream?node=<node>[&disk=][&top=]   NDJSON proxy of that node
GET /api/v1/disk-pressure/nodes[?node=a,b]                    summary of every node
GET /api/nodes/<node>/api/v1/disk-pressure[/stream]            the same, through the per-node route
```

The summary is a list of `{node, state, disks:[{name, util, psiFull10}], source, at}`. `state` is `ok`, `unsupported` (the node has the feature off) or `unavailable`. A node that is not `ok` has no disks, `source` null and `at` 0. `psiFull10` is the `full` `avg10` of the machine, in percent, and is the same for each disk.

### Snapshot

```json
{
  "type": "snapshot",
  "node": "web1",
  "at": 1795800000000,
  "intervalMs": 1000,
  "source": "proc",
  "psi": {"some": {"avg10": 5.3, "avg60": 11.7, "avg300": 22.9}, "full": {"avg10": 0.9, "avg60": 4.5, "avg300": 7.5}},
  "disks": [{
    "name": "nvme0n1", "dev": "259:0", "mounts": ["/", "/var/lib"],
    "util": 0.80, "rIops": 1143, "wIops": 2492, "rBps": 13500000, "wBps": 31500000,
    "queueDepth": 10.2, "rAwaitMs": 0.4, "wAwaitMs": 3.1, "inflight": 2,
    "consumers": [{
      "kind": "cgroup",
      "id": "/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/cri-containerd-<id>.scope",
      "label": "team/web-1/app",
      "cgroup": "/kubepods.slice/...",
      "pod": {"namespace": "team", "name": "web-1", "container": "app", "uid": "..."},
      "rIops": 900, "wIops": 1800, "rBps": 9000000, "wBps": 18000000,
      "psiFull10": 2.5
    }]
  }]
}
```

- `at` is milliseconds since 1970. `intervalMs` is the time that the rates cover (the time since the previous read).
- Consumers are sorted by `rIops + wIops`. Path consumers come after the IO consumers, at most 5 for each disk, and share the `top` limit.
- A cgroup consumer has `cgroup` and, when known, `pod`, `unit`, `link` and `psiFull10` (the `full` `avg10` of its `io.pressure`, for the 10 busiest cgroups of a disk).
- A process consumer has `pid`, `comm` and, when known, `cgroup`, `pod` and `unit`. Its `id` is `pid:<pid>:<start time>` in the `proc` source and `pid:<pid>` in the `ebpf` source.
- A path consumer has `id` `path:<folder>`, `path` and `eventsPerSec`.

## Metrics

The agent serves these on `/metrics`, without a token, like its other metrics. Each scrape makes one read, and the rates cover the time since the previous scrape (or the previous read). The series come from that read, so a disk or consumer that is gone leaves no series.

| Series | Labels |
|---|---|
| `filedeck_disk_util_ratio` | `disk` |
| `filedeck_disk_iops` | `disk`, `op` (`read`, `write`) |
| `filedeck_disk_bytes_per_second` | `disk`, `op` |
| `filedeck_disk_queue_depth` | `disk` |
| `filedeck_disk_await_seconds` | `disk`, `op` |
| `filedeck_io_pressure_ratio` | `kind` (`some`, `full`), `window` (`avg10`, `avg60`, `avg300`), a ratio from 0 to 1 |
| `filedeck_disk_consumer_iops` | `disk`, `op`, `kind`, `consumer` |
| `filedeck_disk_consumer_bytes_per_second` | `disk`, `op`, `kind`, `consumer` |
| `filedeck_pressure_probe_seconds_total` | none, the CPU time of the sampling code |
| `filedeck_pressure_source` | `source` (`ebpf`, `proc`), 1 for the one in use |

Only the 10 busiest consumers of each disk have series, and `consumer` is cut to 80 characters. Series of consumers with the same label on one disk are added. Path consumers have no series, because they name folders. The consumer names are the names of pods, services and processes, so this metrics port is a place where workload names are visible. The feature is off by default for this reason too.

## Limits

- The numbers of a cgroup that starts and ends inside one interval are approximate. The IO of a cgroup that vanished is not given to its parent.
- The writer process of a changed folder is not known: the change events do not carry a process.
- Only Linux with cgroup v2 gives cgroup rows. On other systems the feature is not started.

## eBPF attribution (`filedeck-iotrace`)

`filedeck-iotrace` is a native helper. It tells the disk pressure collector which cgroup and which process sends block IO to which disk. It uses eBPF and costs very little CPU. It is off by default. The proc source needs none of it.

### What it does

- A BPF program is attached to the block layer tracepoint `block_rq_issue`. It counts each read and write request in one hash map in the kernel. The key is the disk, the cgroup id and the process id. The value is the request and byte counts for reads and writes, and the task name.
- The map holds at most 16,384 keys and drops the least recently used key when it is full. In that case the busiest keys stay and a rare key can lose counts.
- The helper has no timer and no options. It waits on its standard input. For each line `read` it reads and clears the map, sorts the rows by request count and prints the top 512 as one JSON line. It prints nothing else. It sees no single event and writes no file.
- Nothing in FileDeck reads the map on a schedule. `IotraceSampler` (`server/src/iotrace.ts`) sends `read` only on demand: for an API request, for the `/metrics` scrape (the scraper is the demand), or for a disk pressure event. While a live view is open, a one-shot deadline is set again after each read. The last subscriber to leave clears it. While nobody asks, no timer runs. If the helper cannot run, the sampler uses the proc and cgroup collector in the same on-demand way.
- The program uses the BTF tracepoint (`tp_btf`) and CO-RE. The build needs no kernel BTF. The BPF object is embedded in the helper, so the helper is one file. Kernel structures are matched by field name against the BTF of the running kernel when the helper starts.

### Output

One line per `read`. The values are the change since the previous `read`.

```json
{"t":1795800001000,"ok":true,"rows":[{"dev":"259:0","cg":4821,"pid":1200,"comm":"postgres","r":10,"w":90,"rb":81920,"wb":737280}]}
```

| Field | Meaning |
|---|---|
| `t` | Time in milliseconds since the epoch |
| `dev` | The whole disk as `major:minor`, the same as in `/proc/diskstats` (a partition counts to its disk) |
| `cg` | The cgroup v2 id. This is the inode number of the cgroup folder, so the collector finds the path with `stat` |
| `pid`, `comm` | The thread group id and the task name at the first request since the previous `read` |
| `r`, `w`, `rb`, `wb` | Read requests, write requests, bytes read, bytes written |

A start failure gives one line `{"ok":false,"error":"..."}` and exit status 3. A read error of the map later gives the same. The collector then uses the proc source. The helper exits with status 0 on `SIGTERM`, `SIGINT` or when its input or output closes.

### What the attribution gets right

- **Reads and direct writes** (`O_DIRECT`, `fsync`, database log writes) are sent by the task that asked for them. The task and its cgroup are correct.
- **Buffered writes** are sent later by a kernel thread (a flusher, `kworker/...`). The process is that kernel thread. The cgroup is the cgroup that owns the dirty pages, read from the request's first bio (`bio->bi_blkg->blkcg`). This is correct only when the io controller is on for that cgroup. Where it is off, or the kernel has no such link, the cgroup is the root cgroup (`cg` 1) and the work shows as the kernel thread.
- **Merged requests**: one request can hold bios of several cgroups. It counts to the cgroup of its first bio. The request count and bytes are for the merged request, counted once at issue.
- **Requests that the block layer sends from a kernel worker** (a request queue run later, not by the submitter) also show as that kernel thread.
- **Stacked devices that send bios** (device mapper, md, bcache) are counted on the disks below them, where the requests are made, never twice. The name of the upper device does not appear.
- Only reads and writes count. Flush, discard and write zeroes do not.
- The program counts requests at issue, not at completion. A request that fails still counts. It gives no latency. The collector takes latency from `/proc/diskstats`.

### What it needs

| Need | Detail |
|---|---|
| Kernel | Linux 5.8 or newer (BPF capabilities, BTF tracepoints). Both signatures of `block_rq_issue` are supported (before and after 5.11). The helper tries each program and uses the one the kernel accepts |
| BTF | `/sys/kernel/btf/vmlinux` must exist (`CONFIG_DEBUG_INFO_BTF`). In a container the runtime shows `/sys/kernel/btf`, so no mount is needed |
| Privilege | `CAP_BPF` and `CAP_PERFMON`, or `CAP_SYS_ADMIN`. The chart gives `BPF` and `PERFMON` when `agent.pressure.ebpf` is `true` |
| Seccomp | The `bpf` call must be allowed. The default container profile allows it when the container holds the capability. If a runtime blocks it, the helper reports the error and the collector falls back |
| Cgroup | cgroup v2, for the ids. To name a cgroup the collector needs to read the node's cgroup folders |
| Memory | Before Linux 5.11 the kernel counts the map as locked memory. The helper raises the limit when it may |

The helper needs no tracefs, no `debugfs` and no extra mount.

### Chart

```yaml
agent:
  pressure:
    ebpf: true
```

This adds `BPF` and `PERFMON` to the agent container and sets `FILEDECK_IOTRACE` to `/usr/local/bin/filedeck-iotrace` for the collector. It changes nothing else.

### Build

The image build compiles the BPF program with clang and links the loader statically with libbpf, libelf, zlib and zstd. The runtime image holds the one binary. `npm run build` builds it too when clang and libbpf are present. Without them it prints one line and goes on. `FILEDECK_REQUIRE_IOTRACE=1` turns that into an error.

The BPF program uses a small hand-written `vmlinux.h` (`server/native/vmlinux.h`) with `preserve_access_index`. To read one more kernel field, add the field to that file.

### Cost

The program runs once per block request. It does one hash lookup and a few counter updates. The helper runs only when it gets a `read`.

- Sorting and printing the worst case (16,384 keys in the map) takes about 1.7 ms per read.
- The map read costs about two system calls per key. A normal read has tens of keys.
- The kernel part grows with the request rate, not with the number of files. It has not been measured on a live kernel yet (the first live run needs `CAP_BPF`). Measure it with `time` or the `filedeck_pressure_probe_seconds_total` metric of the collector.
