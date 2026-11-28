# Holders: who holds what

FileDeck can say which process holds a file or a folder tree. A process holds a path when its working folder, its root folder, its executable, an open file or a file mapping is inside that path. The answer comes from a live table that eBPF events keep current. No timer scans `/proc`.

The first user is the storage scanner. Before it proposes to clean a tree, it must prove that no process holds the tree. The scanner used to read `/proc` of every process on each scan, which cost about one CPU core. Now it asks FileDeck.

The feature is off by default. Where the kernel or the permissions do not allow it, the agent says `unavailable` and never fails.

## The question

```
GET /api/v1/holders?path=/home/Storage/Projects/repositories/.worktrees/org/task
GET /api/nodes/<node>/api/v1/holders?path=...        (through the hub)
```

`path` is a folder or a file on the node, as for `GET /api/du`. The answer is JSON:

```json
{
  "path": "/home/Storage/Projects/repositories/.worktrees/org/task",
  "proven": true,
  "reasons": [],
  "held": true,
  "holders": [
    { "pid": 4321, "comm": "node", "kinds": ["cwd", "fd"], "container": "0a1b2c3d4e5f", "pod": "0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9" }
  ],
  "mounts": [ { "mountpoint": "/home/.../task/vol", "fstype": "ext4", "reason": "mount inside" } ],
  "feature": { "state": "ready" },
  "table": { "pids": 812, "files": 20431, "holds": 31877 },
  "at": "2026-11-28T10:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `proven` | `true` only when the table has no gap that matters. "No holder" is a proof only when `proven` is `true` and `holders` is empty. When `proven` is `false`, treat the answer as "not known". |
| `reasons` | Why `proven` is `false`. Empty when it is `true`. |
| `held` | A process or a mount holds the path. |
| `holders[].kinds` | `cwd`, `root`, `exe`, `fd` or `mmap`. |
| `holders[].container`, `pod` | The first 12 characters of the container id and the pod uid, read from the cgroup of the process, when they are known. |
| `holders[].uncertain` | The table guesses: the folders above one held file are not all known. The holder is reported, never dropped. |
| `holders[].comm` | The task name (15 characters at most). |
| `mounts` | A mount inside the path (its files are held through that mount), or an overlay that uses a folder of the path as a layer (the kernel holds it). Only mounts in the host mount namespace are seen. |
| `feature.state` | `ready`, `starting` (the first pass is not done), `unavailable` (with `feature.reason`) or `disabled`. |

The status is always 200 when the path is valid, also when the feature is off or unavailable. The body then has `proven: false` and the reason. A client must read `proven`.

With sign-in on, only administrators may ask: the answer names the processes of the whole machine. The hub applies the same rule as for the change events. An API token may ask when `FILEDECK_API_TOKEN_SCOPES` holds `holders` (default: `du` only). Then the account of the token must be an administrator.

## How it works

### What is held, and how a path is matched

The table holds file identities. For each held file it keeps the device of the superblock, the inode number and the inode numbers of the folders above it, up to the root of the superblock (the chain). A path is held when its own device and inode number is the held file, or is in its chain. This does not use names. A renamed folder, another mount namespace and a bind mount of a part of the tree all match. A mount inside the path is a different superblock: the answer asks for the root of each such mount too.

The kernel side reads the chain with `d_parent` links when an event happens. A chain that cannot reach the root of its superblock (deeper than 48 folders, or a file that is not connected to its root) is marked. A marked file matches every path on its device, and the holder has `uncertain: true`.

Only regular files and folders on a real filesystem count. Sockets, pipes, devices and the pseudo filesystems (proc, sysfs, cgroup, overlay, devpts, tracefs, bpf and similar) are not tracked. A question about a path on one of them is `proven: false` with the reason.

### The hooks

The helper `filedeck-holders` (`server/native/filedeck-holders.bpf.c`) attaches these programs. Each one sends a record to one ring buffer. The choice follows one rule: hook the one place where a hold is made, and not a system call that has many forms.

| Fact | Hook | Why this one |
|---|---|---|
| A descriptor is made | `fentry fd_install(fd, file)` | Every way to make a descriptor ends here: `open`, `openat`, `creat`, `dup`, `fcntl(F_DUPFD)`, a descriptor received in a message (`SCM_RIGHTS`), `pidfd_getfd`, `open_by_handle_at`. One hook instead of many system calls. |
| `dup2` and `dup3` | `fexit __x64_sys_dup2` and `__x64_sys_dup3` (arm64: `__arm64_sys_dup3`) | They set a descriptor without `fd_install`. `fexit` gives the result, so a failed call is not counted. |
| A descriptor is closed | `fentry filp_flush(file, owner)` | `close`, `close_range`, the close-on-exec files at `exec`, the files at exit and the file that `dup2` replaces all pass here. It is `filp_flush` and not `filp_close`: recent kernels (7.2 for sure) make the `close` call use `filp_flush` and `fput_close_sync` and not `filp_close`. The owner argument is the file table: a task that only drops the last reference of another process's table (a reader of `/proc/<pid>/fd`) is ignored. |
| Working folder, root folder | `fentry set_fs_pwd` and `set_fs_root` | `chdir`, `fchdir` and `chroot` all call them with the new path. |
| `pivot_root` | `fentry chroot_fs_refs` | It changes the folders of other tasks without a named path. The pid that called it is marked, and the table reads it again. |
| Executable | `fentry begin_new_exec`, then `tp_btf sched_process_exec` | The first event says that the old executable and mappings are gone (the point of no return of `exec`). The second names the new executable. |
| File mapping | `fentry security_mmap_file(file)` | Every `mmap` of a file, also the ones of the `exec` loader. |
| Fork | `tp_btf sched_process_fork` | The child holds what the parent holds. The table copies it. A child that shares the file table or folders with the parent (`CLONE_FILES`, `CLONE_FS`) is marked, because later changes of either are not copied. |
| Exit | `tp_btf sched_process_exit` | The table forgets the process when its last thread ends. |
| A file or folder moves | `fentry security_inode_rename` | Only a move to another folder is sent. A move changes the chain of the files below it, and so the answer for a tree that they are inside. |

The record is a fixed header and the chain, sent with `bpf_ringbuf_output`. The `fentry` hooks send their record before the kernel acts, so a hold is in the ring before the process can use it. The fork and exec tracepoints send theirs after the kernel has copied or loaded. The order in the ring is the order in which the records were made.

Not tracked: `munmap` and `mremap`, and so a mapping is never released by an event. See "Mappings". The 32-bit system call entries (`__ia32_sys_*`) and `io_uring` fixed files are not hooked. Kernel holds (a loop device, a swap file, an NFS export, an `inotify` mark) are not processes. Mounts and overlay layers in the host mount namespace are reported in `mounts`.

### Start, and re-reads of a process

The helper attaches the hooks first. Then it reads each process once with three BPF iterators (`task_file`, `task_vma`, `task`). They run in the kernel, give the chain with the same code as the events, and need no `/proc` read and no `ptrace` permission. This is the start-up pass: one pass, no timer. The agent needs `hostPID` for it because the iterators name processes by the pid namespace of the caller.

The same iterators re-read one process when the agent sends `snap <pid>` to the helper. The agent does this only when events of that process may be lost:

- **The ring buffer was full.** The BPF program puts the pid of the lost record in a map and counts it. After each batch the helper writes a `DIRTY` record for each such pid. The agent marks the pid unproven and re-reads only that pid. If the map itself is full, the helper says "all pids" and the agent runs the start-up pass again.
- **The kernel skipped a program run** because the same program already ran on that CPU. The helper reads `recursion_misses` of its programs at most once a second. A change means events of unknown pids were lost: the same re-read of everything.
- **A fork shares the file table or folders** with its parent: that child is re-read.
- **A directory or file moved** to another folder: the pids that hold files below it are re-read before the next answer.
- **A mapping is in the answer.** The agent re-reads the pid first, if the last read is older than 2 seconds, because a mapping is never released by an event.

A re-read that does not end in 15 seconds, or fails, is tried again two more times. After that the pid is "unreadable", and every answer is `proven: false` until it ends. A pid that has gone is removed.

While a re-read runs, the events of that pid go to both the table and the re-read result, so none is lost.

### Why the table cannot miss a holder

The rule is: a hold is always in the table, unless a gap is known and shown. A process gets a hold only through the hooks above, and each one sends its event before the hold exists. The table releases a hold only on an event that says so. If a release event is missed, the table keeps an extra hold (a holder that is not real). It never loses a real one. An extra hold ends when the process execs, exits or is re-read.

## What is not proven

- Holds that no hook sees: `io_uring` fixed files, 32-bit system calls, a `pivot_root` that changes tasks other than the caller (the caller is re-read).
- Mappings after `munmap` are removed only by a re-read. The agent does that before it reports them, so a mapping that was released is not reported, but a re-read that fails shows as `unreadable`.
- A kernel without one of `dup2`, `dup3` or the rename hook still loads. Every answer is then `proven: false` with the missing hook named, because a descriptor made by `dup2` or a moved tree could be missed.
- Mounts in other mount namespaces (a container that mounts a folder of the tree itself) are not in `mounts`. A process in that container that opens a file of the tree is still found through its chain.
- The agent itself and the helper are not in the table: a transient hold by the agent (for example a size scan) is not reported.
- The real kernel hooks run in the CI of this repository only where BPF is allowed (the root test suite). The table logic has its own unit tests that need no privilege.

## Cost

- The hooks run on every descriptor, close and mapping on a real filesystem, and on every fork, exec and exit. Each event is one `bpf_ringbuf_output` of 48 bytes plus 8 bytes per folder above the file (typically 100 to 150 bytes).
- The agent decodes the records in one pass, per record a few map operations. Memory is about 100 to 200 bytes per hold and per distinct held file. The table stops at 5 million holds and says so.
- The ring buffer is 16 MiB by default (`FILEDECK_HOLDERS_RING_MB`, a power of two from 1 to 256).
- A question scans the distinct held files once, and reads `/proc/<pid>/cgroup` for each holder it names.
- Not measured yet: the rate of events and the CPU cost of the hooks on a busy node (a CI node opens many thousand files a second). The metrics above give both. Measure them on the first node before the chart value is turned on elsewhere.
- Metrics (`/metrics` on the agent): `filedeck_holders_available`, `filedeck_holders_state{state}`, `filedeck_holders_table_pids`, `filedeck_holders_table_files`, `filedeck_holders_table_holds`, `filedeck_holders_events_total`, `filedeck_holders_events_per_second`, `filedeck_holders_ring_drops_total`, `filedeck_holders_unproven_pids`, `filedeck_holders_unreadable_pids`, `filedeck_holders_snapshots_total`, `filedeck_holders_snapshot_failures_total`, `filedeck_holders_helper_restarts_total`.

## What it needs

| Need | Detail |
|---|---|
| Kernel | Linux 5.14 or newer with BTF (`/sys/kernel/btf/vmlinux`). The nodes run 7.2 and 7.3. The program is CO-RE: kernel structures are matched by field name against the BTF of the running kernel. |
| Privilege | `CAP_BPF` and `CAP_PERFMON`, or `CAP_SYS_ADMIN`. The chart gives `BPF` and `PERFMON` when `agent.holders.ebpf` is `true`. |
| Pid namespace | The host pid namespace (`hostPID: true`). The helper refuses to start in another one, because it would read different pids than the kernel sends. The chart sets it. |
| BTF | The chart mounts `/sys/kernel/btf` read-only from the host. |
| Seccomp | The `bpf` and `perf_event_open` calls must be allowed. The default container profile allows them for a container with the capabilities. |
| Build | `clang` for the BPF program and libbpf with libelf and zlib. The image build has them and fails without them. A checkout build skips the helper with one line when they are missing. |

Where one of these is missing, the helper prints one JSON line `{"ok":false,"error":"..."}` and exits with status 3. The agent then reports `feature.state: "unavailable"` with the error, and does not start the helper again. On macOS and any system that is not Linux the feature is `unavailable` without trying.

## Chart

```yaml
agent:
  holders:
    ebpf: true
    ringMb: 16
```

This adds `BPF` and `PERFMON` to the agent container, sets `hostPID: true`, mounts `/sys/kernel/btf` read-only, and sets `FILEDECK_HOLDERS` to `/usr/local/bin/filedeck-holders`. It changes nothing else. The probes stay on the agent's HTTP port: a failed helper never fails the probes. `hostPID` lets the agent see all processes of the node. It still cannot read their files or memory: it has no `CAP_SYS_PTRACE`, and the helper reads the facts in the kernel.

To run the agent from a checkout, build the helper (`npm run build:native -w server`) and set `FILEDECK_HOLDERS=$PWD/server/dist/native/filedeck-holders`. The process needs the capabilities and the host pid namespace.
