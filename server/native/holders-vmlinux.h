/*
 * A minimal, hand-written subset of the kernel types that filedeck-holders.bpf.c reads. It is not the generated vmlinux.h: the build needs no
 * kernel BTF and no bpftool. Every record below is marked preserve_access_index, so clang writes a CO-RE relocation for each field access and
 * libbpf matches the field by name against the BTF of the kernel that loads the program (offsets, sizes and anonymous unions are the kernel's).
 * Only the names and the member types matter, not the layout of this file.
 */
#ifndef FILEDECK_HOLDERS_VMLINUX_H
#define FILEDECK_HOLDERS_VMLINUX_H

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
typedef int pid_t;
typedef unsigned short umode_t;
typedef u32 dev_t;
typedef _Bool bool;
enum { false = 0, true = 1 };

enum bpf_map_type {
	BPF_MAP_TYPE_UNSPEC = 0,
	BPF_MAP_TYPE_HASH = 1,
	BPF_MAP_TYPE_ARRAY = 2,
	BPF_MAP_TYPE_PERCPU_ARRAY = 6,
	BPF_MAP_TYPE_RINGBUF = 27,
};
enum { BPF_ANY = 0, BPF_NOEXIST = 1, BPF_EXIST = 2 };

#pragma clang attribute push(__attribute__((preserve_access_index)), apply_to = record)

struct inode;
struct super_block;
struct vfsmount;
struct seq_file;
struct socket;
struct msghdr;
struct renamedata;
struct scm_fp_list;

/* what `__scm_send` fills for a message with descriptors in it */
struct scm_cookie {
	struct scm_fp_list *fp;
};

struct path {
	struct vfsmount *mnt;
	struct dentry *dentry;
};
struct qstr {
	union {
		struct {
			u32 hash;
			u32 len;
		};
		u64 hash_len;
	};
	const unsigned char *name;
};
struct dentry {
	struct dentry *d_parent;
	struct qstr d_name;
	struct inode *d_inode;
	struct super_block *d_sb;
};
struct inode {
	umode_t i_mode;
	struct super_block *i_sb;
	u64 i_ino;
};
struct super_block {
	dev_t s_dev;
	unsigned long s_magic;
	struct dentry *s_root;
};
struct file {
	struct inode *f_inode;
	struct path f_path;
	void *private_data;
};
/* only what the io_uring check reads: the count of registered (fixed) files. The name differs by kernel: file_table.data.nr (6.10 and newer), nr_user_files (older). */
struct io_rsrc_data {
	unsigned int nr;
};
struct io_file_table {
	struct io_rsrc_data data;
};
struct io_ring_ctx {
	struct io_file_table file_table;
	unsigned int nr_user_files;
};
struct fs_struct {
	struct path root;
	struct path pwd;
};
struct fdtable {
	unsigned int max_fds;
	struct file **fd;
};
struct files_struct {
	struct fdtable *fdt;
};
struct mm_struct {
	struct file *exe_file;
};
typedef struct {
	int counter;
} atomic_t;
struct signal_struct {
	atomic_t live;
};
struct task_struct {
	unsigned int flags;
	pid_t pid;
	pid_t tgid;
	struct task_struct *group_leader;
	struct mm_struct *mm;
	struct fs_struct *fs;
	struct files_struct *files;
	struct signal_struct *signal;
	char comm[16];
};
struct linux_binprm {
	struct file *file;
};
struct vm_area_struct {
	struct file *vm_file;
};
struct bpf_iter_meta {
	struct seq_file *seq;
	u64 session_id;
	u64 seq_num;
};
struct bpf_iter__task_file {
	struct bpf_iter_meta *meta;
	struct task_struct *task;
	u32 fd;
	struct file *file;
};
struct bpf_iter__task_vma {
	struct bpf_iter_meta *meta;
	struct task_struct *task;
	struct vm_area_struct *vma;
};
struct bpf_iter__task {
	struct bpf_iter_meta *meta;
	struct task_struct *task;
};

/* the system call arguments of a wrapper such as __x64_sys_dup3(struct pt_regs *) */
struct pt_regs {
#if defined(__TARGET_ARCH_x86)
	unsigned long di;
	unsigned long si;
	unsigned long bx; /* the arguments of a 32-bit call (__ia32_sys_*) */
	unsigned long cx;
#elif defined(__TARGET_ARCH_arm64)
	u64 regs[31];
#endif
};

#pragma clang attribute pop

#endif
