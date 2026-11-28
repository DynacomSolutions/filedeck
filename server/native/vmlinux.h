/*
 * A minimal, hand-written subset of the kernel types that filedeck-iotrace.bpf.c reads. It is not the generated vmlinux.h: the build needs no
 * kernel BTF and no bpftool. Every record below is marked preserve_access_index, so clang writes a CO-RE relocation for each field access and
 * libbpf matches the field by name against the BTF of the kernel that loads the program (offsets, and moved or missing fields, are the kernel's).
 * Only the names and the member types matter, not the layout of this file. A "___flavor" suffix names an older or newer shape of the same type.
 */
#ifndef FILEDECK_IOTRACE_VMLINUX_H
#define FILEDECK_IOTRACE_VMLINUX_H

typedef unsigned char __u8;
typedef unsigned short __u16;
typedef unsigned int __u32;
typedef unsigned long long __u64;
typedef signed char __s8;
typedef short __s16;
typedef int __s32;
typedef long long __s64;
typedef __u8 u8;
typedef __u16 u16;
typedef __u32 u32;
typedef __u64 u64;
typedef __s32 s32;
typedef __s64 s64;
typedef __u16 __be16;
typedef __u32 __be32;
typedef __u32 __wsum;

enum bpf_map_type {
	BPF_MAP_TYPE_UNSPEC = 0,
	BPF_MAP_TYPE_HASH = 1,
	BPF_MAP_TYPE_LRU_HASH = 9,
};
enum { BPF_ANY = 0, BPF_NOEXIST = 1, BPF_EXIST = 2 };

#pragma clang attribute push(__attribute__((preserve_access_index)), apply_to = record)

struct kernfs_node {
	u64 id; /* since Linux 5.5 (before, a union with a 32-bit id) */
};
struct cgroup_subsys_state {
	struct cgroup *cgroup;
};
struct cgroup {
	struct kernfs_node *kn;
};
struct blkcg {
	struct cgroup_subsys_state css;
};
struct blkcg_gq {
	struct blkcg *blkcg;
};
struct bio {
	struct blkcg_gq *bi_blkg; /* only with CONFIG_BLK_CGROUP */
};
struct gendisk {
	int major;
	int first_minor;
};
struct request_queue {
	struct gendisk *disk; /* Linux 5.15 and newer */
};
struct request {
	struct request_queue *q;
	struct bio *bio;
	unsigned int __data_len;
	unsigned int cmd_flags;
};
struct request___old { /* before Linux 5.17: the disk hangs on the request */
	struct gendisk *rq_disk;
};
struct task_struct {
	unsigned int flags;
};

#pragma clang attribute pop

#endif
