// SPDX-License-Identifier: GPL-2.0
/*
 * filedeck-iotrace, kernel side: counts the block requests that are sent to a disk, per disk, cgroup and process, in one bounded kernel map.
 * Nothing is sent to user space per event. The loader (filedeck-iotrace.c) reads and clears the map once per interval.
 *
 * Attached to the BTF tracepoint block_rq_issue ("tp_btf": it needs no tracefs, and CAP_BPF with CAP_PERFMON is enough). The kernel changed the
 * arguments of this tracepoint in 5.11 (request_queue, request) to (request): the loader loads the program that fits the running kernel.
 * The request is counted when it is issued, because its size is final then (requests that were merged are counted once, with all their bytes).
 *
 * Which task and cgroup:
 *   - A request that a normal task sends is attributed to that task: its process id (tgid), its name and its cgroup (the cgroup v2 id).
 *   - A request that a kernel thread sends (write-back of dirty pages from a flusher, a journal thread, a blk-mq worker) is attributed to the
 *     kernel thread as a process. Its cgroup is the cgroup that the request's first bio is charged to, read from bio->bi_blkg->blkcg
 *     (the cgroup that owns the dirty pages when the io controller is on for that cgroup). Where the kernel has no such link, or it names the
 *     root cgroup, the cgroup is the kernel thread's own (the root cgroup).
 *   - A request that merged bios of several cgroups is attributed to the cgroup of its first bio. Bytes follow the request.
 * Only reads and writes are counted. Flush, discard, write zeroes and other operations are not.
 * A disk is the whole disk (a partition counts to its disk). Stacked devices that send bios (device mapper, md, bcache) are counted on the
 * disks below them, where the requests are made, never twice.
 */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

#define IOTRACE_MAX_ENTRIES 16384
#define REQ_OP_MASK 0xffu
#define REQ_OP_READ 0u
#define REQ_OP_WRITE 1u
#define PF_KTHREAD 0x00200000u

struct iokey {
	u64 cg;  /* cgroup v2 id (the inode number of the cgroup folder) */
	u32 dev; /* (major << 20) | minor of the whole disk */
	u32 pid; /* thread group id */
};
struct ioval {
	u64 r, w, rb, wb;
	char comm[16];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, IOTRACE_MAX_ENTRIES);
	__type(key, struct iokey);
	__type(value, struct ioval);
} agg SEC(".maps");

static __always_inline int account(struct request *rq)
{
	unsigned int op = BPF_CORE_READ(rq, cmd_flags) & REQ_OP_MASK;
	if (op != REQ_OP_READ && op != REQ_OP_WRITE)
		return 0;

	struct gendisk *disk = NULL;
	if (bpf_core_field_exists(((struct request___old *)rq)->rq_disk))
		disk = BPF_CORE_READ((struct request___old *)rq, rq_disk);
	else if (bpf_core_field_exists(((struct request_queue *)0)->disk))
		disk = BPF_CORE_READ(rq, q, disk);
	if (!disk)
		return 0;

	struct iokey key = {};
	key.dev = ((u32)BPF_CORE_READ(disk, major) << 20) | (u32)BPF_CORE_READ(disk, first_minor);
	key.pid = (u32)(bpf_get_current_pid_tgid() >> 32);
	key.cg = bpf_get_current_cgroup_id();

	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	if (BPF_CORE_READ(task, flags) & PF_KTHREAD) {
		if (bpf_core_field_exists(((struct bio *)0)->bi_blkg)) {
			struct bio *bio = BPF_CORE_READ(rq, bio);
			if (bio) {
				u64 id = BPF_CORE_READ(bio, bi_blkg, blkcg, css.cgroup, kn, id);
				if (id > 1)
					key.cg = id;
			}
		}
	}

	u64 bytes = BPF_CORE_READ(rq, __data_len);
	struct ioval *v = bpf_map_lookup_elem(&agg, &key);
	if (!v) {
		struct ioval zero = {};
		bpf_get_current_comm(&zero.comm, sizeof(zero.comm));
		bpf_map_update_elem(&agg, &key, &zero, BPF_NOEXIST);
		v = bpf_map_lookup_elem(&agg, &key);
		if (!v)
			return 0;
	}
	if (op == REQ_OP_READ) {
		__sync_fetch_and_add(&v->r, 1);
		__sync_fetch_and_add(&v->rb, bytes);
	} else {
		__sync_fetch_and_add(&v->w, 1);
		__sync_fetch_and_add(&v->wb, bytes);
	}
	return 0;
}

SEC("tp_btf/block_rq_issue")
int BPF_PROG(on_rq_issue, struct request *rq)
{
	return account(rq);
}

/* Linux before 5.11: block_rq_issue(request_queue, request) */
SEC("tp_btf/block_rq_issue")
int BPF_PROG(on_rq_issue_old, struct request_queue *q, struct request *rq)
{
	return account(rq);
}

char LICENSE[] SEC("license") = "GPL";
