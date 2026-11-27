# Disk pressure

## eBPF attribution (`filedeck-iotrace`)

`filedeck-iotrace` is a native helper. It tells the disk pressure collector which cgroup and which process sends block IO to which disk. It uses eBPF and costs very little CPU. It is off by default. The proc source needs none of it.

### What it does

- A BPF program is attached to the block layer tracepoint `block_rq_issue`. It counts each read and write request in one hash map in the kernel. The key is the disk, the cgroup id and the process id. The value is the request and byte counts for reads and writes, and the task name.
- The map holds at most 16,384 keys and drops the least recently used key when it is full. In that case the busiest keys stay and a rare key can lose counts.
- Once per interval (default 1000 ms, `--interval-ms`, 100 to 60,000) the helper reads and clears the map. It sorts the rows by request count and prints the top 512 as one JSON line. It prints nothing else. It sees no single event and writes no file.
- The program uses the BTF tracepoint (`tp_btf`) and CO-RE. The build needs no kernel BTF. The BPF object is embedded in the helper, so the helper is one file. Kernel structures are matched by field name against the BTF of the running kernel when the helper starts.

### Output

One line per interval. The values are the change in that interval.

```json
{"t":1795800001000,"ok":true,"rows":[{"dev":"259:0","cg":4821,"pid":1200,"comm":"postgres","r":10,"w":90,"rb":81920,"wb":737280}]}
```

| Field | Meaning |
|---|---|
| `t` | Time in milliseconds since the epoch |
| `dev` | The whole disk as `major:minor`, the same as in `/proc/diskstats` (a partition counts to its disk) |
| `cg` | The cgroup v2 id. This is the inode number of the cgroup folder, so the collector finds the path with `stat` |
| `pid`, `comm` | The thread group id and the task name at the first request of the interval |
| `r`, `w`, `rb`, `wb` | Read requests, write requests, bytes read, bytes written |

A start failure gives one line `{"ok":false,"error":"..."}` and exit status 3. A read error of the map later gives the same. The collector then uses the proc source. The helper exits with status 0 on `SIGTERM`, `SIGINT` or when its output closes.

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

The program runs once per block request. It does one hash lookup and a few counter updates. The helper wakes once per interval and reads and clears the map.

- Sorting and printing the worst case (16,384 keys in the map) takes about 1.7 ms per interval, which is about 0.17% of one core at the default interval.
- The map read costs about two system calls per key. A normal interval has tens of keys.
- The kernel part grows with the request rate, not with the number of files. It has not been measured on a live kernel yet (the first live run needs `CAP_BPF`). Measure it with `time` or the `filedeck_pressure_probe_seconds_total` metric of the collector.
