// SPDX-License-Identifier: GPL-2.0
/*
 * filedeck-holders, kernel side: sends an event for every way a process comes to hold a file or a folder, to one ring buffer. The loader
 * (filedeck-holders.c) passes the records to the agent, which keeps the table "who holds what" (server/src/holders-table.ts).
 *
 * What a process holds, and the hook that sees it begin:
 *   open file descriptor   fentry fd_install(fd, file)       every way a descriptor is made: open, dup, F_DUPFD, SCM_RIGHTS, pidfd_getfd, ...
 *                          fexit  __x64_sys_dup2/dup3        dup2 and dup3 set a descriptor without fd_install (arm64: __arm64_sys_dup3)
 *   descriptor closed      fentry filp_close(file, owner)    close, close_range, exec of a close-on-exec file, exit, and the file that dup2 replaced
 *   working/root folder    fentry set_fs_pwd, set_fs_root    chdir, fchdir, chroot (pivot_root also sets fs_struct for other tasks: chroot_fs_refs marks the pid)
 *   executable             fentry begin_new_exec, then tp_btf sched_process_exec
 *   file mapping           fentry security_mmap_file(file)   every mmap of a file, also those of an exec
 *   fork                   tp_btf sched_process_fork         the child holds what the parent holds
 *   exit                   tp_btf sched_process_exit         the table forgets the process (only when its last thread ends)
 *   inode moved            fentry security_inode_rename      only a move to another folder (a rename in one folder changes no chain)
 * And three BPF iterators (task_file, task_vma, task) that read the same facts from the kernel for one process: the start-up pass and the re-read of a
 * process whose events may be lost. They run in the kernel, need no /proc and no ptrace permission.
 *
 * The identity of what is held is the superblock device and the inode number, plus the inode numbers of the folders above it. A tree is held when its
 * root inode is the held inode or one of those folders. This does not depend on the name, on the mount namespace or on bind mounts.
 * Only regular files and folders on a real filesystem count. Sockets, pipes, devices and the pseudo filesystems (proc, sysfs, cgroup, overlay, ...) do not.
 *
 * Nothing is sent for the agent and the loader themselves (the ignore pids in `cfg`). When a record cannot be sent (ring full) the pid is put in `dirty`
 * and `stats` counts it: the loader reports it and the agent reads the pid again.
 */
#include "holders-vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>
#include "filedeck-holders.h"

#define S_IFMT 0170000
#define S_IFDIR 0040000
#define S_IFREG 0100000
#define DIRTY_ENTRIES 65536

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 16 * 1024 * 1024);
} rb SEC(".maps");

/* One record buffer per CPU and per program (a program that is preempted must not be overwritten by another program on the same CPU). */
#define SCRATCH_SLOTS 24
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, SCRATCH_SLOTS);
	__type(key, u32);
	__type(value, struct holders_rec);
} scratch SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, HS_COUNT);
	__type(key, u32);
	__type(value, u64);
} stats SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, HC_COUNT);
	__type(key, u32);
	__type(value, u32);
} cfg SEC(".maps");

/* pids whose records were lost: the loader reads and clears it */
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, DIRTY_ENTRIES);
	__type(key, u32);
	__type(value, u8);
} dirty SEC(".maps");

static __always_inline void count(u32 which)
{
	u64 *v = bpf_map_lookup_elem(&stats, &which);
	if (v)
		*v += 1;
}

static __always_inline bool ignored(u32 pid)
{
	u32 a = HC_IGNORE_A, b = HC_IGNORE_B;
	u32 *x = bpf_map_lookup_elem(&cfg, &a);
	u32 *y = bpf_map_lookup_elem(&cfg, &b);
	return (x && *x == pid) || (y && *y == pid);
}

/* Filesystems that hold no file of a tree that someone could clean: a hold on them is not tracked. */
static __always_inline bool untracked_magic(unsigned long m)
{
	switch (m) {
	case 0x9fa0: /* proc */
	case 0x62656572: /* sysfs */
	case 0x27e0eb: /* cgroup */
	case 0x63677270: /* cgroup2 */
	case 0x1cd1: /* devpts */
	case 0x794c7630: /* overlayfs */
	case 0x09041934: /* anon_inodefs */
	case 0x534f434b: /* sockfs */
	case 0x50495045: /* pipefs */
	case 0x64626720: /* debugfs */
	case 0x74726163: /* tracefs */
	case 0xcafe4a11: /* bpf */
	case 0x6e736673: /* nsfs */
	case 0x19800202: /* mqueue */
	case 0x42494e4d: /* binfmt_misc */
	case 0x73636673: /* securityfs */
	case 0x62656570: /* configfs */
	case 0x6165676c: /* pstore */
	case 0xde5e81e4: /* efivarfs */
		return true;
	}
	return false;
}

/*
 * Fills `r` from a dentry: the superblock device, the inode number and (when `with_chain`) the inode numbers of the folders above, up to the root of
 * the superblock. Returns false for what is not tracked (not a regular file or a folder, or a pseudo filesystem).
 */
static __always_inline bool fill(struct holders_rec *r, struct dentry *d, bool with_chain)
{
	r->flags = 0;
	r->nchain = 0;
	if (!d)
		return false;
	struct inode *inode = BPF_CORE_READ(d, d_inode);
	if (!inode)
		return false;
	u32 fmt = BPF_CORE_READ(inode, i_mode) & S_IFMT;
	if (fmt != S_IFREG && fmt != S_IFDIR)
		return false;
	struct super_block *sb = BPF_CORE_READ(inode, i_sb);
	if (!sb || untracked_magic(BPF_CORE_READ(sb, s_magic)))
		return false;
	r->dev = BPF_CORE_READ(sb, s_dev);
	r->ino = BPF_CORE_READ(inode, i_ino);
	if (!with_chain)
		return true;

	struct dentry *cur = d;
	u32 n = 0;
#pragma unroll
	for (int i = 0; i < HOLDERS_MAX_CHAIN; i++) {
		struct dentry *p = BPF_CORE_READ(cur, d_parent);
		if (!p || p == cur)
			break;
		struct inode *pi = BPF_CORE_READ(p, d_inode);
		if (!pi)
			break;
		r->chain[i] = BPF_CORE_READ(pi, i_ino);
		n = i + 1;
		cur = p;
	}
	r->nchain = n;
	/* complete only when the walk ended at the root of the superblock */
	if (cur != BPF_CORE_READ(sb, s_root) || BPF_CORE_READ(cur, d_parent) != cur)
		r->flags |= HF_TRUNCATED;
	return true;
}

static __always_inline void send(struct holders_rec *r, u16 type, u32 pid, u32 aux, u32 extra_flags)
{
	u32 n = r->nchain;
	if (n > HOLDERS_MAX_CHAIN)
		n = HOLDERS_MAX_CHAIN;
	u32 len = HOLDERS_HDR_BYTES + n * 8;
	r->nchain = n;
	r->len = len;
	r->type = type;
	r->pid = pid;
	r->aux = aux;
	r->flags |= extra_flags;
	if (bpf_ringbuf_output(&rb, r, len, 0) == 0) {
		count(HS_EVENTS);
		return;
	}
	count(HS_DROPS);
	u8 one = 1;
	if (bpf_map_update_elem(&dirty, &pid, &one, BPF_ANY))
		count(HS_DIRTY_LOST);
}

static __always_inline struct holders_rec *slot(u32 i)
{
	return bpf_map_lookup_elem(&scratch, &i);
}

static __always_inline u32 cur_tgid(void)
{
	return (u32)(bpf_get_current_pid_tgid() >> 32);
}

/* a record for the current task about a file */
static __always_inline int file_event(u32 slot_no, u16 type, u32 aux, struct file *file, bool with_chain)
{
	u32 pid = cur_tgid();
	if (!file || ignored(pid))
		return 0;
	struct holders_rec *r = slot(slot_no);
	if (!r)
		return 0;
	if (!fill(r, BPF_CORE_READ(file, f_path.dentry), with_chain))
		return 0;
	bpf_get_current_comm(r->comm, sizeof(r->comm));
	send(r, type, pid, aux, 0);
	return 0;
}

/* a record for the current task about a path */
static __always_inline int path_event(u32 slot_no, u16 type, struct path *path)
{
	u32 pid = cur_tgid();
	if (!path || ignored(pid))
		return 0;
	struct holders_rec *r = slot(slot_no);
	if (!r)
		return 0;
	if (!fill(r, BPF_CORE_READ(path, dentry), true))
		return 0;
	bpf_get_current_comm(r->comm, sizeof(r->comm));
	send(r, type, pid, 0, 0);
	return 0;
}

/* a record without a file: the pid and the name of the current task */
static __always_inline int pid_event(u32 slot_no, u16 type, u32 pid, u32 aux, u32 flags)
{
	struct holders_rec *r = slot(slot_no);
	if (!r)
		return 0;
	r->flags = 0;
	r->nchain = 0;
	r->dev = 0;
	r->ino = 0;
	bpf_get_current_comm(r->comm, sizeof(r->comm));
	send(r, type, pid, aux, flags);
	return 0;
}

/* ---- descriptors ---- */

SEC("fentry/fd_install")
int BPF_PROG(h_fd_install, unsigned int fd, struct file *file)
{
	return file_event(0, HT_FD, fd, file, true);
}

SEC("fentry/filp_close")
int BPF_PROG(h_filp_close, struct file *file, void *owner)
{
	/* The owner is the file table that the descriptor is closed in. A task that drops the last reference of another process's table (a reader of
	 * /proc/<pid>/fd) closes files of that table: those are not its own. At exit the task has no table any more (files is NULL), and the table is its own. */
	struct task_struct *t = (struct task_struct *)bpf_get_current_task();
	void *files = BPF_CORE_READ(t, files);
	if (files && files != owner)
		return 0;
	return file_event(1, HT_CLOSE, 0, file, false);
}

static __always_inline int dup_done(u32 slot_no, struct pt_regs *regs, long ret, bool dup2)
{
	if (ret < 0)
		return 0;
#if defined(__TARGET_ARCH_x86)
	unsigned int oldfd = (unsigned int)BPF_CORE_READ(regs, di);
	unsigned int newfd = (unsigned int)BPF_CORE_READ(regs, si);
#else
	unsigned int oldfd = (unsigned int)BPF_CORE_READ(regs, regs[0]);
	unsigned int newfd = (unsigned int)BPF_CORE_READ(regs, regs[1]);
#endif
	if (dup2 && oldfd == newfd)
		return 0; /* dup2 of a descriptor onto itself changes nothing */
	struct task_struct *t = (struct task_struct *)bpf_get_current_task();
	struct files_struct *files = BPF_CORE_READ(t, files);
	if (!files)
		return 0;
	struct fdtable *fdt = BPF_CORE_READ(files, fdt);
	if (!fdt || newfd >= BPF_CORE_READ(fdt, max_fds))
		return 0;
	struct file **fda = BPF_CORE_READ(fdt, fd);
	struct file *f = NULL;
	if (bpf_probe_read_kernel(&f, sizeof(f), fda + newfd))
		return 0;
	return file_event(slot_no, HT_FD, newfd, f, true);
}

#if defined(__TARGET_ARCH_x86)
SEC("fexit/__x64_sys_dup3")
int BPF_PROG(h_dup3, struct pt_regs *regs, long ret)
{
	return dup_done(2, regs, ret, false);
}
SEC("fexit/__x64_sys_dup2")
int BPF_PROG(h_dup2, struct pt_regs *regs, long ret)
{
	return dup_done(3, regs, ret, true);
}
#elif defined(__TARGET_ARCH_arm64)
SEC("fexit/__arm64_sys_dup3")
int BPF_PROG(h_dup3, struct pt_regs *regs, long ret)
{
	return dup_done(2, regs, ret, false);
}
#endif

/* ---- folders ---- */

SEC("fentry/set_fs_pwd")
int BPF_PROG(h_set_fs_pwd, struct fs_struct *fs, struct path *path)
{
	return path_event(4, HT_CWD, path);
}

SEC("fentry/set_fs_root")
int BPF_PROG(h_set_fs_root, struct fs_struct *fs, struct path *path)
{
	return path_event(5, HT_ROOT, path);
}

/* pivot_root changes the root and the working folder of other tasks in place: nothing says whose, so the pid that called it is read again */
SEC("fentry/chroot_fs_refs")
int BPF_PROG(h_chroot_fs_refs, struct path *old_root, struct path *new_root)
{
	u32 pid = cur_tgid();
	if (ignored(pid))
		return 0;
	return pid_event(6, HT_DIRTY, pid, 0, 0);
}

/* ---- exec, mappings, fork, exit ---- */

SEC("fentry/begin_new_exec")
int BPF_PROG(h_begin_new_exec, struct linux_binprm *bprm)
{
	u32 pid = cur_tgid();
	if (ignored(pid))
		return 0;
	return pid_event(7, HT_EXECBEG, pid, 0, 0);
}

SEC("tp_btf/sched_process_exec")
int BPF_PROG(h_exec, struct task_struct *p, pid_t old_pid, struct linux_binprm *bprm)
{
	return file_event(8, HT_EXE, 0, BPF_CORE_READ(bprm, file), true);
}

SEC("fentry/security_mmap_file")
int BPF_PROG(h_mmap, struct file *file, unsigned long prot, unsigned long flags)
{
	return file_event(9, HT_MMAP, 0, file, true);
}

SEC("tp_btf/sched_process_fork")
int BPF_PROG(h_fork, struct task_struct *parent, struct task_struct *child)
{
	u32 ppid = BPF_CORE_READ(parent, tgid);
	u32 cpid = BPF_CORE_READ(child, tgid);
	if (ppid == cpid || ignored(ppid))
		return 0; /* a thread of the same process */
	u32 flags = 0;
	if (BPF_CORE_READ(child, files) == BPF_CORE_READ(parent, files) || BPF_CORE_READ(child, fs) == BPF_CORE_READ(parent, fs))
		flags |= HF_SHARED;
	return pid_event(10, HT_FORK, ppid, cpid, flags);
}

SEC("tp_btf/sched_process_exit")
int BPF_PROG(h_exit, struct task_struct *p)
{
	/* the signal's thread count is already lower by this thread: zero means that it was the last one (the kernel's own group_dead) */
	struct signal_struct *sig = BPF_CORE_READ(p, signal);
	if (!sig || BPF_CORE_READ(sig, live.counter) != 0)
		return 0;
	u32 pid = BPF_CORE_READ(p, tgid);
	if (ignored(pid))
		return 0;
	return pid_event(11, HT_EXIT, pid, 0, 0);
}

/* ---- inodes that move ---- */

SEC("fentry/security_inode_rename")
int BPF_PROG(h_rename, struct inode *old_dir, struct dentry *old_dentry, struct inode *new_dir, struct dentry *new_dentry, unsigned int flags)
{
	if (old_dir == new_dir)
		return 0; /* a rename inside one folder keeps every chain */
	struct holders_rec *r = slot(12);
	if (!r)
		return 0;
	u32 pid = cur_tgid();
	if (fill(r, old_dentry, false)) {
		bpf_get_current_comm(r->comm, sizeof(r->comm));
		send(r, HT_MOVED, pid, 0, 0);
	}
	if ((flags & 2 /* RENAME_EXCHANGE */) && fill(r, new_dentry, false)) {
		bpf_get_current_comm(r->comm, sizeof(r->comm));
		send(r, HT_MOVED, pid, 0, 0);
	}
	return 0;
}

/* ---- snapshots: the same facts, read from the kernel for one process ---- */

static __always_inline int snap_file(u32 slot_no, u16 type, u32 aux, struct task_struct *task, struct file *file)
{
	if (!task || !file)
		return 0;
	u32 pid = BPF_CORE_READ(task, tgid);
	if (ignored(pid))
		return 0;
	struct holders_rec *r = slot(slot_no);
	if (!r)
		return 0;
	if (!fill(r, BPF_CORE_READ(file, f_path.dentry), true))
		return 0;
	BPF_CORE_READ_STR_INTO(&r->comm, task, comm);
	send(r, type, pid, aux, 0);
	return 0;
}

SEC("iter/task_file")
int snap_files(struct bpf_iter__task_file *ctx)
{
	return snap_file(13, HT_SFD, ctx->fd, ctx->task, ctx->file);
}

SEC("iter/task_vma")
int snap_vmas(struct bpf_iter__task_vma *ctx)
{
	struct vm_area_struct *vma = ctx->vma;
	if (!vma)
		return 0;
	return snap_file(14, HT_SMMAP, 0, ctx->task, BPF_CORE_READ(vma, vm_file));
}

SEC("iter/task")
int snap_tasks(struct bpf_iter__task *ctx)
{
	struct task_struct *task = ctx->task;
	if (!task)
		return 0;
	struct task_struct *leader = BPF_CORE_READ(task, group_leader);
	u32 pid = BPF_CORE_READ(task, tgid);
	if (ignored(pid))
		return 0;
	struct fs_struct *fs = BPF_CORE_READ(task, fs);
	if (fs && (task == leader || fs != BPF_CORE_READ(leader, fs))) {
		struct holders_rec *r = slot(15);
		if (r && fill(r, BPF_CORE_READ(fs, pwd.dentry), true)) {
			BPF_CORE_READ_STR_INTO(&r->comm, task, comm);
			send(r, HT_SCWD, pid, 0, 0);
		}
		r = slot(16);
		if (r && fill(r, BPF_CORE_READ(fs, root.dentry), true)) {
			BPF_CORE_READ_STR_INTO(&r->comm, task, comm);
			send(r, HT_SROOT, pid, 0, 0);
		}
	}
	struct mm_struct *mm = BPF_CORE_READ(task, mm);
	if (mm && (task == leader || mm != BPF_CORE_READ(leader, mm))) {
		struct file *exe = BPF_CORE_READ(mm, exe_file);
		struct holders_rec *r = slot(17);
		if (exe && r && fill(r, BPF_CORE_READ(exe, f_path.dentry), true)) {
			BPF_CORE_READ_STR_INTO(&r->comm, task, comm);
			send(r, HT_SEXE, pid, 0, 0);
		}
	}
	return 0;
}

char LICENSE[] SEC("license") = "GPL";
