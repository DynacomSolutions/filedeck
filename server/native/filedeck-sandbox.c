/*
 * filedeck-sandbox: run a command with access to the listed folders only.
 *
 *   filedeck-sandbox --probe
 *   filedeck-sandbox [--ro ROOT]... [--rx ROOT]... [--rw ROOT]... [--uid N --gid N [--allow-root-user]] [--no-system] [--no-landlock] -- COMMAND [ARG...]
 *
 * ROOT is a path, or `fd:N`: the number of a directory descriptor the caller left open for this process (spawn it as an
 * inherited descriptor). The Landlock rule is attached to the opened directory itself, so it follows the directory: renaming
 * the folder or swapping a link at its old name afterwards changes nothing about what is allowed.
 *   --ro ROOT   read files and list folders beneath ROOT
 *   --rx ROOT   the same, and execute files
 *   --rw ROOT   the same, and write, create, remove, rename and link beneath ROOT (not execute)
 * Unless --no-system is given, the folders a program needs to start are readable and executable as well (/usr, /lib,
 * /lib64, /bin, /sbin), a few world-readable files of /etc (loader cache, passwd, group, time zone) are readable, and
 * /dev/null can be read and written. Nothing else can be opened.
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
 * Exit status: 0 for --probe: Landlock works; 70 Landlock is not available (old kernel, not enabled in the kernel's list
 * of security modules, or blocked by a seccomp profile): COMMAND was NOT run; 64 usage error; 71 a step failed (message on
 * stderr): COMMAND was NOT run; 127 COMMAND could not be executed. Otherwise the helper replaces itself with COMMAND.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

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

/* does the kernel accept a ruleset that handles this one right? */
static int supported(enum ll_kind kind, int bit) {
  struct ll_attr a = {0, 0, 0};
  uint64_t v = 1ULL << bit;
  if (kind == KIND_FS) a.handled_access_fs = v;
  else if (kind == KIND_NET) a.handled_access_net = v;
  else a.scoped = v;
  int fd = ll_create(&a, sizeof a, 0);
  if (fd < 0) return 0;
  close(fd);
  return 1;
}

/* Every right of every kind the running kernel offers (and this helper knows) is handled, so that everything not allowed
 * explicitly is denied: all file system rights, TCP and UDP bind/connect, abstract unix sockets and signals to processes
 * outside the sandbox. */
static void handled_rights(struct ll_attr *h) {
  h->handled_access_fs = h->handled_access_net = h->scoped = 0;
  for (int b = 0; b < 64; b++) {
    uint64_t v = 1ULL << b;
    if ((FS_KNOWN & v) && supported(KIND_FS, b)) h->handled_access_fs |= v;
    if ((NET_KNOWN & v) && supported(KIND_NET, b)) h->handled_access_net |= v;
    if ((SCOPE_KNOWN & v) && supported(KIND_SCOPE, b)) h->scoped |= v;
  }
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

#define MAX_ROOTS 64
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
    if (*end || n < 3 || n > 1023) {
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
  long uid = -1, gid = -1;
  int no_landlock = 0, no_system = 0, do_probe = 0, allow_root_user = 0, i = 1;
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
      handled_rights(&h);
      printf("landlock abi %d fs 0x%llx net 0x%llx scope 0x%llx\n", abi, (unsigned long long)h.handled_access_fs, (unsigned long long)h.handled_access_net, (unsigned long long)h.scoped);
    }
    return r;
  }
  if (i >= argc) {
    fprintf(stderr, "usage: filedeck-sandbox [--ro ROOT]... [--rx ROOT]... [--rw ROOT]... [--uid N --gid N [--allow-root-user]] [--no-system] [--no-landlock] -- COMMAND [ARG...]\n");
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
    handled_rights(&attr);
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

  if (uid >= 0) {
    if (setgroups(0, NULL) < 0 || setgid((gid_t)gid) < 0 || setuid((uid_t)uid) < 0) {
      fprintf(stderr, "filedeck-sandbox: cannot change to uid %ld gid %ld: %s\n", uid, gid, strerror(errno));
      return EXIT_FAILED;
    }
    if (uid != 0 && setuid(0) == 0) { /* must not be able to get back */
      fprintf(stderr, "filedeck-sandbox: privileges were not dropped\n");
      return EXIT_FAILED;
    }
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "filedeck-sandbox: no_new_privs: %s\n", strerror(errno));
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

  /* Landlock does not restrict descriptors that are already open: nothing but the standard three may reach the command
   * (the root descriptors were closed-on-exec above already, and so is everything else from here on) */
  for (int fd = 3; fd < 1024; fd++) fcntl(fd, F_SETFD, FD_CLOEXEC);
  execvp(argv[i], argv + i);
  fprintf(stderr, "filedeck-sandbox: %s: %s\n", argv[i], strerror(errno));
  return 127;
}
