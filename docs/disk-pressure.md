# Disk pressure

Each FileDeck agent can show how busy its disks are and who makes them busy. It reads the disk counters of the kernel, the IO pressure (PSI), the cgroup tree and, when the machine allows it, the processes. It gives the result in one snapshot per second. A person or a program can read the snapshots from the hub API. Prometheus can read a short list of series.

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

The agent uses `ebpf` when the helper starts and sends a first line with `"ok":true`. If the helper fails at any time (no kernel support, a crash, silence), the agent logs one line, uses `proc`, and tries the helper again after 5 minutes. The snapshot field `source` says which one is in use.

In the `proc` source, a process row gets its disk IOPS from its bytes and the average IO size of the disk. Its disk is the disk of its cgroup. When several disks are busy, the bytes of the process are shared by the bytes of the cgroup on each disk. This is an estimate.

## What it needs

| Setting | Gives | Cost to the node |
|---|---|---|
| Nothing | Disk values and PSI of the whole machine (`/proc/diskstats`, `/proc/pressure/io` are not namespaced). The cgroups of the agent container only. | None. |
| `agent.pressure.cgroupMount` | The cgroup tree of the machine, read only, at `/host-cgroup`. Gives pods, services and scopes. | One read-only host path mount. |
| `agent.pressure.hostPID` | The process list of the machine. Adds `CAP_SYS_PTRACE`, which `/proc/<pid>/io` needs for processes of other users. | The agent can see all processes of the node. |
| eBPF helper | Exact IO per process. Added by its own chart values. | `CAP_BPF` and `CAP_PERFMON`. |

The agent runs as root, with `CAP_SYS_ADMIN` and `CAP_DAC_READ_SEARCH` as before. The new mounts and capabilities are opt-in.

## Cost

Everything stays in memory. The agent writes nothing to disk for a sample.

The agent samples only while someone reads:

- A stream or a request: once for each `FILEDECK_PRESSURE_INTERVAL_MS` (1000 ms).
- The metrics scrape: once for each 15 seconds, for three scrape intervals after the last scrape. Then it stops.
- Nobody reads: no timer, no event listener and no helper process.

The cost of the sampling code is the counter `filedeck_pressure_probe_seconds_total` (CPU seconds from `process.cpuUsage`). The target is under 1% of one CPU core. The collector keeps to it in these ways:

- `io.stat` of a cgroup counts its children. A cgroup whose counters did not move has idle children, so the agent does not read them.
- Children that did IO in the last 5 samples are read at each sample. The others are read when their parent has IO that the known children do not explain.
- The agent follows at most 20,000 cgroups.
- Every sample has a CPU budget of about 0.8% of the interval. If a sample costs more, the cgroup and process part runs every 2nd to 8th sample and the last attribution stays in the snapshots between. The disk values stay current at each sample.
- Process rows come from the 20 busiest cgroups, at most. If the agent may not read `/proc/<pid>/io` for any process, it rests for one minute.

Measured on a machine with 1,300 cgroups and a high load, 1 second interval: about 0.6% of one core, one full cgroup sample at 6 to 12 ms.

The change event counting runs inside the event bus, only while someone reads, and costs a few microseconds for each event. It is part of the probe seconds.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `FILEDECK_PRESSURE` | off | `1` turns the feature on. Off: no routes (404), no metrics, no sampling. |
| `FILEDECK_PRESSURE_INTERVAL_MS` | `1000` | Time between samples while a stream or request reads. From 250 to 60000. |
| `FILEDECK_PRESSURE_CGROUP_ROOT` | `/sys/fs/cgroup` | The cgroup v2 tree to read. The chart mounts the host tree at `/host-cgroup` and sets this. |
| `FILEDECK_PRESSURE_PROC_ROOT` | `/proc` | The process folders. With `hostPID`, `/proc` of the container is the one of the host. |
| `FILEDECK_PRESSURE_PATH_DEPTH` | `3` | Folder parts under a mount that make one path consumer. |
| `FILEDECK_PRESSURE_LABELS` | empty | Label rules, a JSON list. See below. |
| `FILEDECK_IOTRACE` | empty | Path of the eBPF helper. Empty: look in `/usr/local/bin` and `server/dist/native`. `off`: never use it. |

Chart values: `agent.pressure.enabled`, `agent.pressure.intervalMs`, `agent.pressure.pathDepth`, `agent.pressure.cgroupMount`, `agent.pressure.hostPID` and `agent.pressure.labels`. A place for `agent.pressure.ebpf` is reserved in `values.yaml`.

### Label rules

`FILEDECK_PRESSURE_LABELS` is a JSON list. Each rule has `match` (a regular expression on the cgroup path), `label` (a template) and an optional `link` (a URL template). The first rule that matches a cgroup wins. In a template, `{1}` is the first capture group, `{name}` a named group and `{0}` the whole match. Captures in a `link` are URL-encoded. A link must start with `https://`, `http://` or `/`. The agent skips a bad rule and logs it. There are no default rules.

```json
[{"match": "^/jobs\\.slice/(?<id>[a-f0-9]+)\\.scope$", "label": "job {id}", "link": "https://example.test/jobs/{id}"}]
```

## API

All routes need the agent token, as the change events do. With sign-in on, the hub allows them for administrators only. API tokens of the hub cannot read them.

### Agent

```
GET /api/v1/pressure          one Snapshot (JSON)
GET /api/v1/pressure/stream   NDJSON: {"type":"ready"} first, then one Snapshot for each interval
```

Query: `disk=<name>` (one disk) and `top=<n>` (consumers for each disk, from 0 to 100, default 20).

Errors: 404 when the feature is off, 400 for a bad query, 429 when 32 streams are open, 503 when no sample is ready.

A slow client gets the newest snapshot and skips the ones in between. The agent never keeps a queue for it.

### Hub

```
GET /api/v1/pressure?node=<node>[&disk=][&top=]          Snapshot of that node
GET /api/v1/pressure/stream?node=<node>[&disk=][&top=]   NDJSON proxy of that node
GET /api/v1/pressure/nodes[?node=a,b]                    summary of every node
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

- `at` is milliseconds since 1970. `intervalMs` is the time between samples now (15000 when only the metrics scrape reads).
- Consumers are sorted by `rIops + wIops`. Path consumers come after the IO consumers, at most 5 for each disk, and share the `top` limit.
- A cgroup consumer has `cgroup` and, when known, `pod`, `unit`, `link` and `psiFull10` (the `full` `avg10` of its `io.pressure`, for the 10 busiest cgroups of a disk).
- A process consumer has `pid`, `comm` and, when known, `cgroup`, `pod` and `unit`. Its `id` is `pid:<pid>:<start time>` in the `proc` source and `pid:<pid>` in the `ebpf` source.
- A path consumer has `id` `path:<folder>`, `path` and `eventsPerSec`.

## Metrics

The agent serves these on `/metrics`, without a token, like its other metrics. A scrape starts the sampling. The series come from the latest snapshot, so a disk or consumer that is gone leaves no series.

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
- With the cost budget active, cgroup rows can be a few seconds old. The disk numbers are always current.
- The writer process of a changed folder is not known: the change events do not carry a process.
- Only Linux with cgroup v2 gives cgroup rows. On other systems the feature is not started.
