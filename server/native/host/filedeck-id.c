/*
 * filedeck-id NAME
 *
 * Looks NAME up in the machine's own account database (NSS: /etc/passwd, LDAP, SSSD, whatever the machine is set up with) and
 * prints exactly four lines:
 *
 *   uid
 *   gid
 *   home folder
 *   every group id of the account (getgrouplist: the primary group and the supplementary ones), separated by single spaces
 *
 * Exit status: 0 with the four lines; 2 with no output when there is no such account; 64 on a usage error; 1 when the lookup
 * itself fails (an NSS error, a home that cannot be printed on one line, more than 65536 groups).
 *
 * It runs inside the machine's root (the agent starts it through `filedeck-sandbox --chroot`, server/src/host-helpers.ts), so it
 * is a dynamic glibc program that loads the machine's own libc and NSS modules. The image builds it against an old glibc so that
 * it starts on old machines too (Dockerfile, stage hostbuild). The agent checks the name before it starts this program and
 * parses the output strictly; this program still refuses an empty name or one that starts with '-'.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_GROUPS 65536
#define MAX_PWBUF (1 << 20)

static void fail(const char *what) {
  fprintf(stderr, "filedeck-id: %s\n", what);
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] == '\0' || argv[1][0] == '-') {
    fprintf(stderr, "usage: filedeck-id NAME\n");
    return 64;
  }
  const char *name = argv[1];

  long first = sysconf(_SC_GETPW_R_SIZE_MAX);
  size_t size = first > 0 && first < MAX_PWBUF ? (size_t)first : 16384;
  char *buf = NULL;
  struct passwd pw, *found = NULL;
  for (;;) {
    char *grown = realloc(buf, size);
    if (!grown) fail("out of memory");
    buf = grown;
    int rc = getpwnam_r(name, &pw, buf, size, &found);
    if (rc == ERANGE && size < MAX_PWBUF) {
      size *= 2;
      continue;
    }
    if (rc != 0) {
      fprintf(stderr, "filedeck-id: getpwnam_r: %s\n", strerror(rc));
      return 1;
    }
    break;
  }
  if (!found) return 2;
  if (!pw.pw_dir || strchr(pw.pw_dir, '\n')) fail("the home folder cannot be printed on one line");

  int n = 64;
  gid_t *groups = NULL;
  for (;;) {
    gid_t *grown = realloc(groups, (size_t)n * sizeof(gid_t));
    if (!grown) fail("out of memory");
    groups = grown;
    int count = n;
    if (getgrouplist(pw.pw_name, pw.pw_gid, groups, &count) >= 0) {
      n = count;
      break;
    }
    /* too small: glibc sets count to the number needed (some versions only to what fitted, so grow at least twice) */
    if (n >= MAX_GROUPS) fail("more than 65536 groups");
    int want = count > n ? count : n * 2;
    n = want > MAX_GROUPS ? MAX_GROUPS : want;
  }

  printf("%lu\n%lu\n%s\n", (unsigned long)pw.pw_uid, (unsigned long)pw.pw_gid, pw.pw_dir);
  for (int i = 0; i < n; i++) printf(i ? " %lu" : "%lu", (unsigned long)groups[i]);
  printf("\n");
  if (fflush(stdout) != 0 || ferror(stdout)) return 1;
  return 0;
}
