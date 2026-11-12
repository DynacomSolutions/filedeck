/*
 * filedeck-sandbox: run a command with access to the listed folders only.
 *
 *   filedeck-sandbox --probe
 *   filedeck-sandbox [--ro ROOT]... [--rx ROOT]... [--rw ROOT]... [--cwd-fd N] [--keep-fd N]... [--uid N --gid N [--allow-root-user]] [--keep-cap NAME]... [--allow-metadata] [--no-system] [--no-landlock] [--allow-sockets] -- COMMAND [ARG...]
 *
 *   --cwd-fd N  start COMMAND in the directory descriptor N (fchdir, done after every descriptor is in place and before the user
 *               change and the restriction). A working folder given as a /proc/self/fd path can point at the wrong descriptor, because
 *               the caller's spawn moves descriptors into the slots 3, 4, ... first; this option names the folder by the number it has
 *               in this process, which is exact.
 *   --keep-fd N keep descriptor N open for COMMAND (repeatable): for a descriptor the caller means the command to use, such as an
 *               archive opened read-only, which it then reads as a file descriptor in every mode. Every other descriptor above 2 is
 *               closed on exec. Landlock does not restrict a descriptor that is already open: hand over only what COMMAND should use.
 * ROOT is a path, or `fd:N`: the number of a directory descriptor the caller left open for this process (spawn it as an
 * inherited descriptor). The Landlock rule is attached to the opened directory itself, so it follows the directory: renaming
 * the folder or swapping a link at its old name afterwards changes nothing about what is allowed.
 *   --ro ROOT   read files and list folders beneath ROOT
 *   --rx ROOT   the same, and execute files
 *   --rw ROOT   the same, and write, create, remove, rename and link beneath ROOT (not execute)
 * Unless --no-system is given, the folders a program needs to start are readable and executable as well (/usr, /lib,
 * /lib64, /bin, /sbin), a few world-readable files of /etc (loader cache, passwd, group, time zone) are readable, and
 * /dev/null can be read and written. Nothing else can be opened.
 *   --keep-cap NAME  keep this one Linux capability for COMMAND (repeatable; only `dac_read_search` is known: read any file and search any
 *               folder by the file's mode, which Landlock still limits to the roots). Every other capability is removed in every
 *               case, also when COMMAND runs as uid 0: the permitted, effective, inheritable and ambient sets are cleared and the
 *               bounding set is emptied (when this process may). The caller must hold a capability to keep it, else the helper fails.
 *   --allow-metadata  do not refuse the calls that change modes, owners, times and extended attributes (see the seccomp note below).
 * Before it executes COMMAND the helper drops to --uid/--gid with the supplementary groups cleared (when given; both must be
 * whole non-negative numbers, and 0 is refused unless --allow-root-user is also given), sets no-new-privileges and applies a
 * Landlock ruleset (Linux 5.13 or newer) that handles EVERY right the running kernel offers, so what is not allowed above is denied:
 *   ABI 1  file system: execute, read file, read directory, write file, remove file/dir, create any kind of entry
 *   ABI 2  + linking or renaming across directories (refer)
 *   ABI 3  + truncate
 *   ABI 4  + TCP bind and connect
 *   ABI 5  + ioctl on device files
 *   ABI 6  + connecting to abstract unix sockets and sending signals outside the sandbox
 *   ABI 9  + connecting to pathname unix sockets (resolve-unix)
 *   (UDP bind/connect, where a kernel has them, are handled too.)
 * What a kernel older than an ABI does NOT restrict is what that row adds: with ABI 1 renames across directories and truncation
 * are not restricted, below 4 the network is open, below 5 device ioctls are, below 6 abstract unix sockets and signals are,
 * below 9 pathname unix sockets are. Never restricted by Landlock at all: descriptors that are already open (so every
 * descriptor above 2 is closed on exec here, the root descriptors included), reading or writing through a mount the
 * program already is inside, and kernel facilities it does not mediate (ptrace of a same-uid process outside the sandbox is
 * governed by the system's Yama setting, SysV IPC, raw and packet sockets, ...).
 * --no-landlock skips the ruleset (the caller has decided to run without it; the uid step and no-new-privileges still
 * apply). --probe only reports whether Landlock can be used here and which rights it handles. No dependencies;
 * build: cc -O2 -static -o filedeck-sandbox filedeck-sandbox.c
 *
 * Order of the steps: open the roots, fchdir, bounding set, supplementary groups/gid/uid (keeping the named capabilities across the change),
 * capability sets and ambient set, no-new-privileges, close descriptors, seccomp filter, Landlock, exec. --probe also reports `caps 1` when
 * the capability steps work here. Exit status: 0 for --probe: Landlock works; 70 Landlock is not available (old kernel, not enabled in the kernel's list
 * of security modules, or blocked by a seccomp profile): COMMAND was NOT run; 64 usage error; 71 a step failed (message on
 * stderr): COMMAND was NOT run; 127 COMMAND could not be executed. Otherwise the helper replaces itself with COMMAND.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <dirent.h>
#include <stddef.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef PR_SET_KEEPCAPS
#define PR_SET_KEEPCAPS 8
#endif
#ifndef PR_CAPBSET_READ
#define PR_CAPBSET_READ 23
#endif
#ifndef PR_CAPBSET_DROP
#define PR_CAPBSET_DROP 24
#endif
#ifndef PR_CAP_AMBIENT
#define PR_CAP_AMBIENT 47
#endif
#define SB_AMBIENT_RAISE 2UL
#define SB_AMBIENT_CLEAR_ALL 4UL

/* the syscall numbers are the same on every architecture that uses the common table; older libc headers may not know them */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#ifndef landlock_create_ruleset
static inline int ll_create(const void *attr, size_t size, uint32_t flags) { return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags); }
static inline int ll_add(int fd, enum landlock_rule_type type, const void *attr, uint32_t flags) { return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags); }
static inline int ll_restrict(int fd, uint32_t flags) { return (int)syscall(__NR_landlock_restrict_self, fd, flags); }
#endif

#define EXIT_UNSUPPORTED 70
#define EXIT_USAGE 64
#define EXIT_FAILED 71

/* Landlock rights by their kernel bit numbers (so that an older libc header does not matter). A right the running kernel does
 * not know is found out by asking (`supported`) and is then simply not handled. */
struct ll_attr { /* the ruleset attribute as of the newest ABI this helper knows; unknown trailing fields are zero for older kernels */
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};
#define FS_KNOWN ((1ULL << 17) - 1) /* bits 0..16: execute .. resolve-unix (see the table in the file comment) */
#define NET_KNOWN ((1ULL << 4) - 1) /* bits 0..3: TCP bind, TCP connect, UDP bind, UDP connect/send */
#define SCOPE_KNOWN ((1ULL << 2) - 1) /* bits 0..1: abstract unix sockets, signals */

enum ll_kind { KIND_FS, KIND_NET, KIND_SCOPE };

/* does the kernel accept a ruleset that handles this one right? 1 yes; 0 "not offered": only the kernel's EINVAL for an unknown
 * right counts as that (and E2BIG for an attribute larger than it knows); any other failure is -1 and the caller must not
 * carry on, so that a right is never left unrestricted because of an unrelated error (out of memory, descriptors, ...) */
static int supported(enum ll_kind kind, int bit) {
  struct ll_attr a = {0, 0, 0};
  uint64_t v = 1ULL << bit;
  if (kind == KIND_FS) a.handled_access_fs = v;
  else if (kind == KIND_NET) a.handled_access_net = v;
  else a.scoped = v;
  int fd = ll_create(&a, sizeof a, 0);
  if (fd < 0) return (errno == EINVAL || errno == E2BIG) ? 0 : -1;
  close(fd);
  return 1;
}

/* Every right of every kind the running kernel offers (and this helper knows) is handled, so that everything not allowed
 * explicitly is denied: all file system rights, TCP and UDP bind/connect, abstract unix sockets and signals to processes
 * outside the sandbox. 0 on success, -1 when a probe failed for a reason other than "not offered". */
static int handled_rights(struct ll_attr *h) {
  h->handled_access_fs = h->handled_access_net = h->scoped = 0;
  for (int b = 0; b < 64; b++) {
    uint64_t v = 1ULL << b;
    int r;
    if (FS_KNOWN & v) {
      if ((r = supported(KIND_FS, b)) < 0) return -1;
      if (r) h->handled_access_fs |= v;
    }
    if (NET_KNOWN & v) {
      if ((r = supported(KIND_NET, b)) < 0) return -1;
      if (r) h->handled_access_net |= v;
    }
    if (SCOPE_KNOWN & v) {
      if ((r = supported(KIND_SCOPE, b)) < 0) return -1;
      if (r) h->scoped |= v;
    }
  }
  return 0;
}

/* 0 = usable (ABI in *abi), EXIT_UNSUPPORTED = not available here, EXIT_FAILED = unexpected error */
static int probe(int *abi) {
  int v = ll_create(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (v < 0) {
    if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EPERM || errno == EACCES) return EXIT_UNSUPPORTED; /* no syscall, disabled, or a seccomp profile says no */
    fprintf(stderr, "filedeck-sandbox: landlock version: %s\n", strerror(errno));
    return EXIT_FAILED;
  }
  if (v < 1) return EXIT_UNSUPPORTED;
  *abi = v;
  return 0;
}

/* a whole non-negative decimal number below 2^32 - 1 (that value means "unchanged" to the kernel) */
static int parse_id(const char *text, long *out) {
  char *end = NULL;
  errno = 0;
  long v = strtol(text, &end, 10);
  if (errno || end == text || *end || v < 0 || v > 4294967294L || text[0] == '+' || text[0] == ' ') return -1;
  *out = v;
  return 0;
}

/* descriptors the caller named with --keep-fd: the command is meant to use them, so they stay open across exec */
#define MAX_KEEP 64
static long keep_fds[MAX_KEEP];
static int nkeep = 0;
static int kept(long n) {
  for (int k = 0; k < nkeep; k++)
    if (keep_fds[k] == n) return 1;
  return 0;
}

/* every descriptor above 2 but the kept ones close-on-exec: close_range(2) where the kernel has it, else the real list of open descriptors, else a loop up to the limit */
static void mark_cloexec(void) {
#ifndef __NR_close_range
#define __NR_close_range 436
#endif
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif
  {
    /* close_range over every gap between the kept descriptors (sorted), then make sure the kept ones are inheritable */
    long sorted[MAX_KEEP];
    for (int k = 0; k < nkeep; k++) {
      int j = k;
      while (j > 0 && sorted[j - 1] > keep_fds[k]) {
        sorted[j] = sorted[j - 1];
        j--;
      }
      sorted[j] = keep_fds[k];
    }
    unsigned int from = 3;
    int ok = 1;
    for (int k = 0; k <= nkeep && ok; k++) {
      unsigned int to = k < nkeep ? (unsigned int)sorted[k] : ~0U;
      if (k < nkeep && (unsigned int)sorted[k] < from) continue; /* a duplicate */
      if (k < nkeep ? to > from : 1) ok = syscall(__NR_close_range, from, k < nkeep ? to - 1 : ~0U, CLOSE_RANGE_CLOEXEC) == 0;
      if (k < nkeep) from = to + 1;
    }
    if (ok) {
      for (int k = 0; k < nkeep; k++) fcntl((int)keep_fds[k], F_SETFD, 0);
      return;
    }
  }
  DIR *d = opendir("/proc/self/fd");
  if (d) {
    int self = dirfd(d);
    struct dirent *e;
    while ((e = readdir(d))) {
      char *end;
      long n = strtol(e->d_name, &end, 10);
      if (*end || end == e->d_name || n < 3 || n == self || kept(n)) continue;
      fcntl((int)n, F_SETFD, FD_CLOEXEC);
    }
    closedir(d);
    for (int k = 0; k < nkeep; k++) fcntl((int)keep_fds[k], F_SETFD, 0);
    return;
  }
  struct rlimit rl;
  long max = 65536;
  if (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY && (long)rl.rlim_cur < (1L << 20)) max = (long)rl.rlim_cur;
  for (long fd = 3; fd < max; fd++)
    if (!kept(fd)) fcntl((int)fd, F_SETFD, FD_CLOEXEC);
}

/* ------------------------------------------------------------------ capabilities
 * Raw capget/capset with the version 3 header (no libcap). A confined tool never keeps root's capabilities: after the user change every
 * set is cleared, except for the capabilities the caller named with --keep-cap. Landlock does not restrict changing a file's mode, owner or
 * times, so a process that stays root with its capabilities could still do that to any path it can name. */
#define SB_CAP_V3 0x20080522U
#define SB_CAP_LAST 63
struct cap_hdr {
  uint32_t version;
  int pid;
};
struct cap_data {
  uint32_t effective, permitted, inheritable;
};
#define CAP_BIT_DAC_READ_SEARCH 2
#define CAP_BIT_SETPCAP 8

static int cap_get(uint64_t *eff, uint64_t *perm, uint64_t *inh) {
  struct cap_hdr h = {SB_CAP_V3, 0};
  struct cap_data d[2];
  memset(d, 0, sizeof d);
  if (syscall(__NR_capget, &h, d) < 0) return -1;
  if (eff) *eff = (uint64_t)d[0].effective | ((uint64_t)d[1].effective << 32);
  if (perm) *perm = (uint64_t)d[0].permitted | ((uint64_t)d[1].permitted << 32);
  if (inh) *inh = (uint64_t)d[0].inheritable | ((uint64_t)d[1].inheritable << 32);
  return 0;
}

/* effective = permitted = inheritable = `set` */
static int cap_set_all(uint64_t set) {
  struct cap_hdr h = {SB_CAP_V3, 0};
  struct cap_data d[2];
  d[0].effective = d[0].permitted = d[0].inheritable = (uint32_t)set;
  d[1].effective = d[1].permitted = d[1].inheritable = (uint32_t)(set >> 32);
  return (int)syscall(__NR_capset, &h, d);
}

/* Empty the bounding set but for `keep` (a root process gets its bounding set back as capabilities at exec, so for uid 0 this matters most).
 * Returns the number of capabilities of the set that are still in it (those that could not be dropped for lack of CAP_SETPCAP). */
static int drop_bounding(uint64_t keep) {
  int left = 0;
  for (int c = 0; c <= SB_CAP_LAST; c++) {
    if (keep & (1ULL << c)) continue;
    int in = prctl(PR_CAPBSET_READ, c, 0, 0, 0);
    if (in < 0) break; /* above the kernel's last capability */
    if (in && prctl(PR_CAPBSET_DROP, c, 0, 0, 0) < 0) left++;
  }
  return left;
}

/* Clear the ambient set, then raise `keep` in it (it must be in the permitted and inheritable sets). */
static int set_ambient(uint64_t keep) {
  if (prctl(PR_CAP_AMBIENT, SB_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 && errno != EINVAL) return -1;
  for (int c = 0; c <= SB_CAP_LAST; c++)
    if ((keep & (1ULL << c)) && prctl(PR_CAP_AMBIENT, SB_AMBIENT_RAISE, c, 0, 0) < 0) return -1;
  return 0;
}

/* do the capability steps work here? (the probe reports it) */
static int caps_work(void) {
  uint64_t p;
  if (cap_get(NULL, &p, NULL) < 0) return 0;
  if (prctl(PR_CAP_AMBIENT, SB_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 && errno != EINVAL) return 0;
  return 1;
}

/* ------------------------------------------------------------------ seccomp
 * A filter installed for every confined tool (on x86-64 and arm64; elsewhere it is not installed and the probe says so).
 *  - sockets (unless --allow-sockets): socket(), socketpair(), connect(), bind(), listen(), accept() and accept4() fail with EACCES, and so does
 *    io_uring (which can do the same without those calls). A program that is meant to talk to nobody (git, bsdtar, 7-Zip) needs none of them:
 *    it uses the descriptors it was given. Name lookups degrade to numeric ids (the lookup's socket() fails, then it reads /etc/passwd).
 *  - always: mount and the new mount API, umount2, pivot_root, chroot, the setuid/setgid family, capset, ptrace, process_vm_readv/writev,
 *    kexec, bpf, unshare, setns, mknod/mknodat fail with EPERM; clone3 fails with ENOSYS (as container runtimes do, so the C library falls back
 *    to clone), and clone with a new-namespace flag fails with EPERM.
 *  - unless --allow-metadata: chmod, fchmod, fchmodat, fchmodat2, chown, fchown, lchown, fchownat, utime, utimes, utimensat, futimesat, and the
 *    setxattr and removexattr families fail with EPERM. (Landlock does not restrict these.) Reading and listing need none of them.
 * On x86-64 the architecture value is the same for x32 system calls, whose numbers carry bit 0x40000000: any number at or above
 * it ends the process, so an x32 call cannot go round the list. */
#if defined(__x86_64__)
#define SB_ARCH AUDIT_ARCH_X86_64
#define SB_NR_LIMIT 0x40000000U
#elif defined(__aarch64__)
#define SB_ARCH AUDIT_ARCH_AARCH64
#endif
#ifndef __NR_clone3
#define __NR_clone3 435
#endif
#define SB_NS_FLAGS 0x7e020000U /* CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET */

#ifdef SB_ARCH
#define MAXD 128
static int build_filter(struct sock_filter *f, int allow_sockets, int allow_metadata) {
  long sock[MAXD], always[MAXD], meta[MAXD];
  int ns = 0, na = 0, nm = 0;
#define S(nr) sock[ns++] = (nr)
#define A(nr) always[na++] = (nr)
#define M(nr) meta[nm++] = (nr)
  S(__NR_socket); S(__NR_socketpair); S(__NR_connect); S(__NR_bind); S(__NR_listen); S(__NR_accept); S(__NR_accept4);
#ifdef __NR_io_uring_setup
  S(__NR_io_uring_setup); S(__NR_io_uring_enter); S(__NR_io_uring_register);
#endif
  A(__NR_mount); A(__NR_umount2); A(__NR_pivot_root); A(__NR_chroot);
  A(__NR_setuid); A(__NR_setgid); A(__NR_setreuid); A(__NR_setregid); A(__NR_setresuid); A(__NR_setresgid); A(__NR_setfsuid); A(__NR_setfsgid); A(__NR_setgroups);
  A(__NR_capset); A(__NR_ptrace); A(__NR_process_vm_readv); A(__NR_process_vm_writev); A(__NR_kexec_load); A(__NR_bpf); A(__NR_unshare); A(__NR_setns);
  A(__NR_mknodat);
#ifdef __NR_mknod
  A(__NR_mknod);
#endif
#ifdef __NR_kexec_file_load
  A(__NR_kexec_file_load);
#endif
  /* the new mount API (Linux 5.2 and later; the numbers are in the common table) */
  A(428); A(429); A(430); A(431); A(432); A(433); A(442);
  M(__NR_fchmod); M(__NR_fchmodat); M(__NR_fchown); M(__NR_fchownat); M(__NR_utimensat);
  M(__NR_setxattr); M(__NR_lsetxattr); M(__NR_fsetxattr); M(__NR_removexattr); M(__NR_lremovexattr); M(__NR_fremovexattr);
#ifdef __NR_chmod
  M(__NR_chmod);
#endif
#ifdef __NR_chown
  M(__NR_chown);
#endif
#ifdef __NR_lchown
  M(__NR_lchown);
#endif
#ifdef __NR_utime
  M(__NR_utime);
#endif
#ifdef __NR_utimes
  M(__NR_utimes);
#endif
#ifdef __NR_futimesat
  M(__NR_futimesat);
#endif
  M(452); /* fchmodat2 */
  long all[3 * MAXD];
  int n = 0;
  if (!allow_sockets) for (int i = 0; i < ns; i++) all[n++] = sock[i];
  for (int i = 0; i < na; i++) all[n++] = always[i];
  if (!allow_metadata) for (int i = 0; i < nm; i++) all[n++] = meta[i];
  int k = 0;
  f[k++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  f[k++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SB_ARCH, 1, 0);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#ifdef SB_NR_LIMIT
  f[k++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, SB_NR_LIMIT, 0, 1); /* x32 (and any other out-of-range) numbers */
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
#endif
  /* tail layout, after the n list entries:  clone3 test, clone test (3 instructions), allow, EPERM-or-EACCES, ENOSYS */
  /* a list entry at index e jumps to the EPERM return; sockets use EACCES as before, so they get their own return */
  int first = k;
  int tail = first + n;          /* clone3 test */
  int t_allow = tail + 1 + 3;    /* after the clone test */
  int t_eperm = t_allow + 1;
  int t_eacces = t_eperm + 1;
  int t_enosys = t_eacces + 1;
  for (int i = 0; i < n; i++) {
    int is_sock = 0;
    for (int j = 0; j < ns; j++) if (sock[j] == all[i]) is_sock = 1;
    int target = is_sock ? t_eacces : t_eperm;
    f[k] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)all[i], (uint8_t)(target - k - 1), 0);
    k++;
  }
  f[k] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)__NR_clone3, (uint8_t)(t_enosys - k - 1), 0);
  k++;
  f[k++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)__NR_clone, 0, 2);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  f[k] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, SB_NS_FLAGS, (uint8_t)(t_eperm - k - 1), 0);
  k++;
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES);
  f[k++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
  return k;
}
#endif

static int install_filter(int allow_sockets, int allow_metadata) {
#ifdef SB_ARCH
  struct sock_filter f[3 * MAXD + 24];
  int n = build_filter(f, allow_sockets, allow_metadata);
  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
#else
  (void)allow_sockets;
  (void)allow_metadata;
  errno = ENOSYS;
  return -1;
#endif
}

/* can the filter be installed here? (tried in a child, so this process is not restricted) 1 yes, 0 no */
static int seccomp_works(void) {
#ifdef SB_ARCH
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0) {
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) _exit(1);
    _exit(install_filter(0, 0) == 0 ? 0 : 1);
  }
  int st = 0;
  if (waitpid(pid, &st, 0) < 0) return 0;
  return WIFEXITED(st) && WEXITSTATUS(st) == 0;
#else
  return 0;
#endif
}

#define MAX_ROOTS 4096 /* each is one small ruleset entry; the descriptor numbers they use must stay below 8192 */
struct root_spec {
  const char *spec;
  uint64_t access;
  int fd;
  int own; /* opened here: closed after the rules are added */
};

static int open_root(struct root_spec *r) {
  if (!strncmp(r->spec, "fd:", 3)) {
    char *end;
    long n = strtol(r->spec + 3, &end, 10);
    if (*end || n < 3 || n > 8191) {
      errno = EBADF;
      return -1;
    }
    struct stat st;
    if (fstat((int)n, &st) < 0) return -1;
    r->fd = (int)n;
    r->own = 0;
    fcntl(r->fd, F_SETFD, FD_CLOEXEC); /* the command must not inherit it */
    return 0;
  }
  r->fd = open(r->spec, O_PATH | O_CLOEXEC);
  r->own = 1;
  return r->fd < 0 ? -1 : 0;
}

/* Allow `access` beneath the opened directory (for a file only the file rights apply). */
static int allow_fd(int ruleset, int fd, uint64_t access, uint64_t handled) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -1;
  if (!S_ISDIR(st.st_mode)) access &= (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
                                       | LANDLOCK_ACCESS_FS_TRUNCATE
#endif
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
                                       | LANDLOCK_ACCESS_FS_IOCTL_DEV
#endif
  );
  struct landlock_path_beneath_attr pb = {.allowed_access = access & handled, .parent_fd = fd};
  return ll_add(ruleset, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
}

/* a system path that may be missing (not every system has /lib64) */
static int allow_path(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT || errno == ENOTDIR || errno == EACCES ? 0 : -1;
  int r = allow_fd(ruleset, fd, access, handled);
  int e = errno;
  close(fd);
  errno = e;
  return r;
}

int main(int argc, char **argv) {
  struct root_spec roots[MAX_ROOTS];
  int nroots = 0;
  long uid = -1, gid = -1, cwd_fd = -1;
  int no_landlock = 0, no_system = 0, do_probe = 0, allow_root_user = 0, allow_sockets = 0, allow_metadata = 0, i = 1;
  uint64_t keep_caps = 0;
  const uint64_t R = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  const uint64_t RX = R | LANDLOCK_ACCESS_FS_EXECUTE;
  /* every right except execute: write, create, remove, rename, link (the ABI-specific ones are masked by `handled`) */
  uint64_t RW = R;
  RW |= LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  RW |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  RW |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) {
      i++;
      break;
    }
    if (!strcmp(argv[i], "--probe")) do_probe = 1;
    else if (!strcmp(argv[i], "--no-landlock")) no_landlock = 1;
    else if (!strcmp(argv[i], "--no-system")) no_system = 1;
    else if (!strcmp(argv[i], "--allow-sockets")) allow_sockets = 1;
    else if (!strcmp(argv[i], "--allow-metadata")) allow_metadata = 1;
    else if (!strcmp(argv[i], "--keep-cap") && i + 1 < argc) {
      if (!strcmp(argv[++i], "dac_read_search")) keep_caps |= 1ULL << CAP_BIT_DAC_READ_SEARCH;
      else {
        fprintf(stderr, "filedeck-sandbox: --keep-cap knows only dac_read_search\n");
        return EXIT_USAGE;
      }
    }
    else if (!strcmp(argv[i], "--keep-fd") && i + 1 < argc) {
      long n;
      if (parse_id(argv[++i], &n) < 0 || n < 3 || n > 8191 || nkeep >= MAX_KEEP) {
        fprintf(stderr, "filedeck-sandbox: --keep-fd needs a descriptor number from 3 to 8191 (at most %d of them)\n", MAX_KEEP);
        return EXIT_USAGE;
      }
      keep_fds[nkeep++] = n;
    } else if (!strcmp(argv[i], "--cwd-fd") && i + 1 < argc) {
      if (parse_id(argv[++i], &cwd_fd) < 0 || cwd_fd < 3 || cwd_fd > 8191) {
        fprintf(stderr, "filedeck-sandbox: --cwd-fd needs a descriptor number from 3 to 8191\n");
        return EXIT_USAGE;
      }
    }
    else if ((!strcmp(argv[i], "--ro") || !strcmp(argv[i], "--rx") || !strcmp(argv[i], "--rw")) && i + 1 < argc) {
      if (nroots >= MAX_ROOTS) {
        fprintf(stderr, "filedeck-sandbox: too many roots\n");
        return EXIT_USAGE;
      }
      roots[nroots].access = !strcmp(argv[i], "--ro") ? R : !strcmp(argv[i], "--rx") ? RX : RW;
      roots[nroots].spec = argv[++i];
      nroots++;
    } else if (!strcmp(argv[i], "--uid") && i + 1 < argc) {
      if (parse_id(argv[++i], &uid) < 0) {
        fprintf(stderr, "filedeck-sandbox: --uid needs a whole non-negative number\n");
        return EXIT_USAGE;
      }
    } else if (!strcmp(argv[i], "--gid") && i + 1 < argc) {
      if (parse_id(argv[++i], &gid) < 0) {
        fprintf(stderr, "filedeck-sandbox: --gid needs a whole non-negative number\n");
        return EXIT_USAGE;
      }
    } else if (!strcmp(argv[i], "--allow-root-user")) allow_root_user = 1;
    else {
      fprintf(stderr, "filedeck-sandbox: unknown option %s\n", argv[i]);
      return EXIT_USAGE;
    }
  }
  if (do_probe) {
    int abi = 0;
    int r = probe(&abi);
    if (r == 0) {
      struct ll_attr h;
      if (handled_rights(&h) < 0) {
        fprintf(stderr, "filedeck-sandbox: probing the rights: %s\n", strerror(errno));
        return EXIT_FAILED;
      }
      printf("landlock abi %d fs 0x%llx net 0x%llx scope 0x%llx seccomp %d caps %d\n", abi, (unsigned long long)h.handled_access_fs, (unsigned long long)h.handled_access_net, (unsigned long long)h.scoped, seccomp_works(), caps_work());
    }
    return r;
  }
  if (i >= argc) {
    fprintf(stderr, "usage: filedeck-sandbox [--ro ROOT]... [--rx ROOT]... [--rw ROOT]... [--cwd-fd N] [--keep-fd N]... [--uid N --gid N [--allow-root-user]] [--keep-cap NAME]... [--allow-metadata] [--no-system] [--no-landlock] [--allow-sockets] -- COMMAND [ARG...]\n");
    return EXIT_USAGE;
  }
  if ((uid == 0 || gid == 0) && !allow_root_user) {
    fprintf(stderr, "filedeck-sandbox: uid 0 or gid 0 given: refused unless --allow-root-user says it is meant\n");
    return EXIT_USAGE;
  }
  if ((uid >= 0) != (gid >= 0)) {
    fprintf(stderr, "filedeck-sandbox: --uid and --gid go together\n");
    return EXIT_USAGE;
  }

  /* a ruleset that cannot be built means COMMAND must not run unconfined: decide before any other step */
  int abi = 0;
  int rs = -1;
  uint64_t handled = 0;
  if (!no_landlock) {
    int r = probe(&abi);
    if (r) return r;
    struct ll_attr attr;
    if (handled_rights(&attr) < 0) {
      fprintf(stderr, "filedeck-sandbox: probing the rights: %s\n", strerror(errno));
      return EXIT_FAILED;
    }
    handled = attr.handled_access_fs;
    rs = ll_create(&attr, sizeof attr, 0);
    if (rs < 0) {
      if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EPERM) return EXIT_UNSUPPORTED;
      fprintf(stderr, "filedeck-sandbox: create ruleset: %s\n", strerror(errno));
      return EXIT_FAILED;
    }
    /* open the roots while still privileged, then attach each rule to the opened directory itself */
    for (int k = 0; k < nroots; k++) {
      if (open_root(&roots[k]) < 0 || allow_fd(rs, roots[k].fd, roots[k].access, handled) < 0) {
        fprintf(stderr, "filedeck-sandbox: %s: %s\n", roots[k].spec, strerror(errno));
        return EXIT_FAILED;
      }
      if (roots[k].own) close(roots[k].fd);
    }
    if (!no_system) {
      static const char *const sys[] = {"/usr", "/lib", "/lib64", "/bin", "/sbin", NULL};
      for (int k = 0; sys[k]; k++)
        if (allow_path(rs, sys[k], RX, handled) < 0) {
          fprintf(stderr, "filedeck-sandbox: %s: %s\n", sys[k], strerror(errno));
          return EXIT_FAILED;
        }
      /* single files of /etc, read only: the dynamic loader's cache, user and group names, the time zone */
      static const char *const etc[] = {"/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld-musl-x86_64.path", "/etc/ld-musl-aarch64.path", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime", NULL};
      for (int k = 0; etc[k]; k++)
        if (allow_path(rs, etc[k], LANDLOCK_ACCESS_FS_READ_FILE, handled) < 0) {
          fprintf(stderr, "filedeck-sandbox: %s: %s\n", etc[k], strerror(errno));
          return EXIT_FAILED;
        }
      if (allow_path(rs, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, handled) < 0) {
        fprintf(stderr, "filedeck-sandbox: /dev/null: %s\n", strerror(errno));
        return EXIT_FAILED;
      }
    }
  } else {
    for (int k = 0; k < nroots; k++)
      if (!strncmp(roots[k].spec, "fd:", 3) && open_root(&roots[k]) < 0) {
        fprintf(stderr, "filedeck-sandbox: %s: %s\n", roots[k].spec, strerror(errno));
        return EXIT_FAILED;
      }
  }

  /* the working folder: by descriptor, while still privileged (searching it may need the privilege the next step drops) */
  if (cwd_fd >= 0 && fchdir((int)cwd_fd) < 0) {
    fprintf(stderr, "filedeck-sandbox: working folder (descriptor %ld): %s\n", cwd_fd, strerror(errno));
    return EXIT_FAILED;
  }
  /* capabilities: none survive but the ones named. The bounding set first (a root process gets it back as capabilities at exec), while the
   * launcher still holds CAP_SETPCAP; a named capability must be held to be kept. */
  if (keep_caps) {
    uint64_t perm = 0;
    if (cap_get(NULL, &perm, NULL) < 0 || (keep_caps & ~perm) != 0) {
      fprintf(stderr, "filedeck-sandbox: cannot keep a capability this process does not hold\n");
      return EXIT_FAILED;
    }
  }
  int bounding_left = drop_bounding(keep_caps);
  if (uid >= 0) {
    if (keep_caps && prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0) < 0) {
      fprintf(stderr, "filedeck-sandbox: keepcaps: %s\n", strerror(errno));
      return EXIT_FAILED;
    }
    if (setgroups(0, NULL) < 0 || setgid((gid_t)gid) < 0 || setuid((uid_t)uid) < 0) {
      fprintf(stderr, "filedeck-sandbox: cannot change to uid %ld gid %ld: %s\n", uid, gid, strerror(errno));
      return EXIT_FAILED;
    }
    if (uid != 0 && setuid(0) == 0) { /* must not be able to get back */
      fprintf(stderr, "filedeck-sandbox: privileges were not dropped\n");
      return EXIT_FAILED;
    }
  }
  if (cap_set_all(keep_caps) < 0 || set_ambient(keep_caps) < 0) {
    fprintf(stderr, "filedeck-sandbox: capabilities: %s\n", strerror(errno));
    return EXIT_FAILED;
  }
  prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0);
  if (bounding_left > 0 && geteuid() == 0) { /* root would get capabilities back at exec */
    fprintf(stderr, "filedeck-sandbox: cannot empty the capability bounding set, and the program would run as root\n");
    return EXIT_FAILED;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "filedeck-sandbox: no_new_privs: %s\n", strerror(errno));
    return EXIT_FAILED;
  }
  /* Landlock does not restrict descriptors that are already open: nothing but the standard three may reach the command.
   * Done before the ruleset is applied (the list of descriptors lives in /proc, which the ruleset hides). */
  mark_cloexec();
  /* the socket, privilege and metadata filter (see above) */
  if (install_filter(allow_sockets, allow_metadata) < 0 && errno != ENOSYS && errno != EINVAL) {
    fprintf(stderr, "filedeck-sandbox: seccomp: %s\n", strerror(errno));
    return EXIT_FAILED;
  }
  if (rs >= 0) {
    if (ll_restrict(rs, 0) < 0) {
      if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EPERM) return EXIT_UNSUPPORTED;
      fprintf(stderr, "filedeck-sandbox: restrict: %s\n", strerror(errno));
      return EXIT_FAILED;
    }
    close(rs);
  }

  execvp(argv[i], argv + i);
  fprintf(stderr, "filedeck-sandbox: %s: %s\n", argv[i], strerror(errno));
  return 127;
}
