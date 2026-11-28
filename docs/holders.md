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
| `holders[].kinds` | `cwd`, `root`, `exe`, `fd` or `mmap`. `inflight`: the process sent the file in a message (`SCM_RIGHTS`) and may have closed it, so the file may be in flight. The holder with the pid 0 and the name `in flight` has such files after their sender ended. |
| `holders[].container`, `pod` | The first 12 characters of the container id and the pod uid, read from the cgroup of the process, when they are known. |
| `holders[].uncertain` | The table guesses: the folders above one held file are not all known. The holder is reported, never dropped. |
| `holders[].comm` | The task name (15 characters at most). |
| `mounts` | A mount inside the path (its files are held through that mount), an overlay that uses a folder of the path as a layer (the kernel holds it), a loop device whose backing file is in the path, or a swap file in the path. Mounts inside the path are read in the host mount namespace. Overlay layers are read in every mount namespace that the agent can read. |
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
| `dup2` and `dup3` | `fexit __x64_sys_dup2` and `__x64_sys_dup3` (arm64: `__arm64_sys_dup3`), and `__ia32_sys_dup2` and `__ia32_sys_dup3` for 32-bit processes | They set a descriptor without `fd_install`. `fexit` gives the result, so a failed call is not counted. The 32-bit hooks are loaded only where the kernel has them (the loader looks in the BTF). |
| A descriptor is set by seccomp | `fentry replace_fd` | `SECCOMP_IOCTL_NOTIF_ADDFD` with `SETFD` puts a file into a descriptor without `fd_install`. |
| Descriptors in a message | `fexit __scm_send` | A process that sends descriptors (`SCM_RIGHTS`) leaves the files in flight, held by no process. The table pins what the sender holds at that moment (see "Descriptors in flight"). |
| A descriptor is closed | `fentry filp_flush(file, owner)` | `close`, `close_range`, the close-on-exec files at `exec`, the files at exit and the file that `dup2` replaces all pass here. It is `filp_flush` and not `filp_close`: recent kernels (7.2 for sure) make the `close` call use `filp_flush` and `fput_close_sync` and not `filp_close`. The owner argument is the file table: a task that only drops the last reference of another process's table (a reader of `/proc/<pid>/fd`) is ignored. |
| Working folder, root folder | `fentry set_fs_pwd` and `set_fs_root` | `chdir`, `fchdir` and `chroot` all call them with the new path. |
| `pivot_root` | `fentry chroot_fs_refs` | It changes the folders of other tasks without a named path. The pid that called it is marked, and the table reads it again. |
| Executable | `fentry begin_new_exec`, then `tp_btf sched_process_exec` | The first event says that the old executable and mappings are gone (the point of no return of `exec`). The second names the new executable. |
| File mapping | `fentry security_mmap_file(file)` | Every `mmap` of a file, also the ones of the `exec` loader. |
| Fork | `tp_btf sched_process_fork` | The child holds what the parent holds. The table copies it. The child is read again (and is unproven until then) when the parent has or had other threads (one of them may have changed a descriptor after the kernel copied the table) and when the parent is the agent (the agent is not in the table). A child that shares the file table or folders with the parent (`CLONE_FILES`, `CLONE_FS`) and its parent are unproven while both live. |
| io_uring | `fentry fd_install` and the iterators | A ring has a fixed file table that holds files without a descriptor. No hook sees it. A process that holds a ring (the descriptor of an anonymous inode named `[io_uring]`) is unproven while it holds it. |
| Exit | `tp_btf sched_process_exit` | The table forgets the process when its last thread ends. |
| A file or folder moves | `fentry security_inode_rename` | Only a move to another folder is sent. A move changes the chain of the files below it, and so the answer for a tree that they are inside. |
| A rename runs | `fentry` and `fexit vfs_rename` | They count the renames that run and that ended. The chain of a record is read one parent at a time, and a rename can change the parents while it is read. If one ran at the start or the end of the read, or one ended during it, the chain is marked cut (it matches every path on its device) and the pid is marked dirty. |

The record is a fixed header (56 bytes, with the `fs_struct` key of a folder) and the chain, sent with `bpf_ringbuf_output`. The `fentry` hooks send their record before the kernel acts, so a hold is in the ring before the process can use it. The fork and exec tracepoints send theirs after the kernel has copied or loaded. The order in the ring is the order in which the records were made.

Not tracked: `munmap` and `mremap`, and so a mapping is never released by an event. See "Mappings". Kernel holds (an NFS export, an `inotify` mark) are not processes and are not seen. A loop device and a swap file are read at each question from `/sys/block/loop*/loop/backing_file` and `/proc/swaps`. Mounts in the host mount namespace and overlay layers in the other mount namespaces are reported in `mounts`.

### Start, and re-reads of a process

The helper attaches the hooks first. Then it reads each process once with three BPF iterators (`task_file`, `task_vma`, `task`). They run in the kernel, give the chain with the same code as the events, and need no `/proc` read and no `ptrace` permission. This is the start-up pass: one pass, no timer. The agent needs `hostPID` for it because the iterators name processes by the pid namespace of the caller.

The same iterators re-read one process when the agent sends `snap <pid>` to the helper. The agent does this only when events of that process may be lost:

- **The ring buffer was full.** The BPF program puts the pid of the lost record in a map and counts it. After each batch the helper writes a `DIRTY` record for each such pid. The agent marks the pid unproven and re-reads only that pid. If the map itself is full, the helper says "all pids" and the agent runs the start-up pass again.
- **A fork or move record was lost.** One lost record can leave holds missing in many processes (a lost fork gives a child with no holds, and not only a parent that is marked; a lost move leaves the chains of every holder below the folder wrong). The program then puts pid 0 in the map: the helper says "all pids", the whole table is unproven, and every process is re-read. The answer is unproven until that pass ends.
- **The kernel skipped a program run** because the same program already ran on that CPU. The helper reads `recursion_misses` of its programs after a batch when the ring dropped something, and at every `sync`. A change means events of unknown pids were lost: the same re-read of everything.
- **A fork from a multi-threaded parent or from the agent**, and a thread that has a folder table of its own: that process is re-read.
- **`pivot_root`** changes the folders of every task that had the old root, and nothing says whose: every process is re-read.
- **A chain was read while a rename ran:** that pid is re-read (and the file matches every path on its device until a complete chain is seen).
- **A directory or file moved** to another folder: the pids that hold files below it are re-read before the next answer.
- **A mapping is in the answer.** The agent re-reads the pid first, if the last read is older than 2 seconds, because a mapping is never released by an event.

A re-read that does not end in 15 seconds, or fails, is tried again two more times. After that the pid is "unreadable", and every answer is `proven: false` until it ends. A pid that has gone is removed.

While a re-read runs, the events of that pid go to both the table and the re-read result, so none is lost.

### The read barrier

The events travel from the kernel to the table through the ring buffer, the helper and a pipe. A file that a process opened a moment before the question may not be in the table yet. Before it uses the table, each question sends `sync N` to the helper and waits for the answer. The helper copies every record in the ring, reads the map of lost pids and the skipped program runs, writes the `DIRTY` records that they give, and then writes a `SYNC` record with the number N. The question then waits (once, bounded, then it settles the pids that are to be read again) and reads the table. If the helper does not answer in 8 seconds, the answer is `proven: false`. Nothing runs on a timer: the wait exists only while the answer is pending.

### What a process holds: one set per file table and per folder table

A working folder and a root folder belong to an `fs_struct`, not to a process. Two threads of a process can have one each (`unshare(CLONE_FS)`). The kernel side sends the pointer of the `fs_struct` with each folder record, and the table keeps one working folder and one root per `fs_struct`: a thread that changes its folder does not release the folder of another thread. A child gets a copy of the table of the thread that forked, and its first folder record names it. The start-up pass and each re-read record the folders of every thread.

Two processes that share a table (`CLONE_FILES` or `CLONE_FS` without `CLONE_THREAD`) have one set of holds in the kernel, and the events of either are sent for that pid only. The table cannot give both the same holds, so both are unproven while they share. If one ends, the other keeps its own copy of the holds and is re-read.

### Descriptors in flight

A descriptor that a process sent in a message (`SCM_RIGHTS`) holds the file in the receiver's queue, with no process holding it, until the receiver reads it or the socket ends. When a process sends descriptors, the table pins everything that the process holds at that moment: a pinned hold stays after the descriptor is closed (kind `inflight`). When the sender ends, the pinned holds go to the holder with the pid 0, which stays until the helper restarts. This is more than the real hold (a file that was received long ago stays held), never less.

### Why the table cannot miss a holder

The rule is: a hold is always in the table, unless a gap is known and shown. A process gets a hold only through the hooks above, and each one sends its event before the hold exists. The table releases a hold only on an event that says so. If a release event is missed, the table keeps an extra hold (a holder that is not real). It never loses a real one. An extra hold ends when the process execs, exits or is re-read.

## What is not proven

Each of these is a reason in the answer (`proven: false`) when it can apply, or a fix. None is silent.

| Case | What the answer does |
|---|---|
| A filesystem where `stat` does not give the kernel's device number of the superblock (btrfs gives each subvolume a device number that no superblock has; some network and FUSE filesystems do the same) | A proof is given only on ext4 (and ext2, ext3), xfs, tmpfs and f2fs. On any other filesystem, for the path or for a mount inside it, `proven` is `false` with the type named. |
| A lost `FORK` or `MOVED` record | The whole table is unproven until a full re-read ends (see above). |
| A question and the records in flight | The read barrier (`sync`) closes it. No answer to `sync` is unproven. |
| Two processes that share a file table or folders | Both are unproven while they share. |
| A fork from a multi-threaded parent, from the agent, or a thread with its own folder table | The process is re-read and unproven until then. |
| A rename during the read of a chain | The chain is cut (matches the whole device), the pid is re-read. A `d_move` that is not a `vfs_rename` (for example the join of a disconnected folder by `open_by_handle_at` on a filesystem that is exported) is not seen. |
| `io_uring` fixed files and descriptors that a ring opened itself | Any process that holds a ring is unproven. The file table of a ring is not visible to a hook that is cheap and stable across kernels. |
| `replace_fd` (seccomp `ADDFD` with `SETFD`) | The hook `fentry replace_fd` sees it. If the kernel has no such function, the answer says the hook is missing. |
| Descriptors in flight in a message | The holds of the sender are pinned (above). A message that was already queued when the helper started is not known: after a start of the helper, a file that only a queued message holds is not seen. |
| 32-bit `dup2` and `dup3` | The `__ia32_sys_*` hooks see them. They are not loaded where the kernel has no 32-bit entries. If the kernel has them and the hook fails to load, the answer says the hook is missing. |
| `pivot_root` that changes tasks other than the caller | The table reads every process again. |
| Overlay mounts in other mount namespaces | The agent reads one process of each other mount namespace. A namespace of another user cannot be read without `CAP_SYS_PTRACE` (the chart does not give it), and then the answer says so and is unproven. On a node where the agent runs as root without that capability, this is the usual case: the proof is then not given unless every process is readable. |
| Loop devices and swap files | Read at each question (`/sys/block/loop*/loop/backing_file`, `/proc/swaps`). A file in the path is in `mounts` and the answer is `held`. |
| Mappings after `munmap` | Removed only by a re-read. The agent does that before it reports them, so a mapping that was released is not reported, but a re-read that fails shows as `unreadable`. |
| A kernel without one of the soft hooks | The helper still loads. Every answer is `proven: false` with the missing hook named: `dup2`, `dup3`, the rename hook, `chroot_fs_refs`, `replace_fd`, `__scm_send` or one of the 32-bit calls. |
| Mounts in other mount namespaces (a container that mounts a folder of the tree itself) | Not in `mounts` for "mount inside". A process in that container that opens a file of the tree is still found through its chain. |
| The agent itself and the helper | Not in the table: a transient hold by the agent (for example a size scan) is not reported. A child of the agent is re-read. |
| The real kernel hooks | They run in the CI of this repository only where BPF is allowed (the root test suite). The table logic has its own unit tests that need no privilege. |

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
