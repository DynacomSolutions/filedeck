/*
 * filedeck-pam SERVICE NAME
 *
 * Checks NAME's password with the machine's own PAM, service SERVICE (/etc/pam.d/SERVICE). The password is read from stdin: at most
 * 1024 bytes, ending at the first newline or at the end of the input. It is never taken from the arguments or the environment, and
 * never printed. Nothing is written on stdout.
 *
 * Exit status:
 *   0   PAM accepted the password (pam_authenticate) and the account (pam_acct_mgmt)
 *   1   wrong password
 *   2   the account stage refused (expired, locked, a new password needed, ...)
 *   3   the PAM stack asked more than one question, or a question that is not a hidden one (a one-time code, an echo-on prompt):
 *       only one password prompt is supported, so the attempt fails at once
 *   4   no such account, or an account with uid 0 (it never signs in here)
 *   5   PAM cannot be used: no libpam.so.0, no service file, a lookup or PAM system error
 *   64  usage error
 * A reason goes to stderr for the agent's log (never the password).
 *
 * It runs inside the machine's root as root, with only CAP_DAC_READ_SEARCH (pam_unix may need to read a mode-0000 /etc/shadow), started
 * from the image by descriptor (`filedeck-sandbox --chroot --exec-outside`, server/src/host-helpers.ts and host-pam.ts). It loads the
 * machine's libpam.so.0 with dlopen at run time, so it links only libdl, and the image builds it against an old glibc so that it starts
 * on old machines too (Dockerfile, stage hostbuild). For that reason it does not call explicit_bzero (glibc 2.25): `wipe` does the same.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pwd.h>
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_PASSWORD 1024
#define MAX_PWBUF (1 << 20)

static char password[MAX_PASSWORD + 1];
static int prompts;
static int refused; /* a second question, or a question that is not a hidden prompt */

/* The same as explicit_bzero: the empty asm that takes the pointer and clobbers memory keeps the compiler from removing the memset. */
static void wipe(void *p, size_t n) {
  memset(p, 0, n);
  __asm__ __volatile__("" : : "r"(p) : "memory");
}

static void finish(int code) {
  wipe(password, sizeof password);
  exit(code);
}

static void say(const char *what, const char *detail) {
  if (detail) fprintf(stderr, "filedeck-pam: %s: %s\n", what, detail);
  else fprintf(stderr, "filedeck-pam: %s\n", what);
}

/* A plain name: letters, digits, '.', '_', '-' and '@', not starting with '-' or '.', at most 64 bytes (NAME), or no '@' (SERVICE). */
static int plain(const char *s, int service) {
  size_t n = strlen(s);
  if (n == 0 || n > 64 || s[0] == '-' || s[0] == '.') return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' || (!service && c == '@');
    if (!ok) return 0;
  }
  return 1;
}

static int conversation(int n, const struct pam_message **msg, struct pam_response **resp, void *data) {
  (void)data;
  if (n <= 0 || n > PAM_MAX_NUM_MSG) return PAM_CONV_ERR;
  struct pam_response *r = calloc((size_t)n, sizeof *r);
  if (!r) return PAM_BUF_ERR;
  for (int i = 0; i < n; i++) {
    switch (msg[i]->msg_style) {
      case PAM_PROMPT_ECHO_OFF:
        if (++prompts > 1) {
          refused = 1;
          goto fail;
        }
        r[i].resp = strdup(password); /* PAM takes it, and pam_unix wipes and frees it */
        if (!r[i].resp) goto fail;
        break;
      case PAM_ERROR_MSG:
      case PAM_TEXT_INFO:
        break; /* a message, not a question */
      default: /* PAM_PROMPT_ECHO_ON and anything else: a question this program cannot answer */
        refused = 1;
        goto fail;
    }
  }
  *resp = r;
  return PAM_SUCCESS;
fail:
  for (int i = 0; i < n; i++)
    if (r[i].resp) {
      wipe(r[i].resp, strlen(r[i].resp));
      free(r[i].resp);
    }
  free(r);
  return PAM_CONV_ERR;
}

/* Whether the service has a file: Linux-PAM falls back to the service "other" without one, which is not what was asked for. */
static int has_service(const char *service) {
  struct stat st;
  if (stat("/etc/pam.d", &st) != 0 || !S_ISDIR(st.st_mode)) return 1; /* /etc/pam.conf only: PAM decides */
  static const char *dirs[] = {"/etc/pam.d/", "/usr/lib/pam.d/", "/usr/share/pam.d/"};
  char p[128];
  for (size_t i = 0; i < sizeof dirs / sizeof *dirs; i++) {
    snprintf(p, sizeof p, "%s%s", dirs[i], service);
    if (stat(p, &st) == 0 && S_ISREG(st.st_mode)) return 1;
  }
  return 0;
}

typedef int (*start_fn)(const char *, const char *, const struct pam_conv *, pam_handle_t **);
typedef int (*call_fn)(pam_handle_t *, int);
typedef int (*end_fn)(pam_handle_t *, int);
typedef const char *(*strerror_fn)(pam_handle_t *, int);
typedef int (*get_item_fn)(const pam_handle_t *, int, const void **);

int main(int argc, char **argv) {
  if (argc != 3 || !plain(argv[1], 1) || !plain(argv[2], 0)) {
    fprintf(stderr, "usage: filedeck-pam SERVICE NAME (the password on stdin)\n");
    return 64;
  }
  const char *service = argv[1], *name = argv[2];

  size_t len = 0;
  while (len < MAX_PASSWORD) {
    ssize_t k = read(0, password + len, MAX_PASSWORD - len);
    if (k < 0 && errno == EINTR) continue;
    if (k < 0) {
      say("cannot read the password", strerror(errno));
      finish(5);
    }
    if (k == 0) break;
    char *nl = memchr(password + len, '\n', (size_t)k);
    if (nl) {
      len = (size_t)(nl - password);
      break;
    }
    len += (size_t)k;
  }
  wipe(password + len, sizeof password - len);
  if (memchr(password, '\0', len)) finish(1); /* a NUL cannot be part of a password PAM sees */

  long first = sysconf(_SC_GETPW_R_SIZE_MAX);
  size_t size = first > 0 && first < MAX_PWBUF ? (size_t)first : 16384;
  char *buf = NULL;
  struct passwd pw, *found = NULL;
  for (;;) {
    char *grown = realloc(buf, size);
    if (!grown) {
      say("out of memory", NULL);
      finish(5);
    }
    buf = grown;
    int rc = getpwnam_r(name, &pw, buf, size, &found);
    if (rc == ERANGE && size < MAX_PWBUF) {
      size *= 2;
      continue;
    }
    if (rc != 0) {
      say("getpwnam_r", strerror(rc));
      finish(5);
    }
    break;
  }
  if (!found || pw.pw_uid == 0) finish(4);

  if (!has_service(service)) {
    say("no PAM service file for", service);
    finish(5);
  }
  void *lib = dlopen("libpam.so.0", RTLD_NOW | RTLD_GLOBAL);
  if (!lib) {
    say("cannot load libpam.so.0", dlerror());
    finish(5);
  }
  start_fn pam_start_p = (start_fn)dlsym(lib, "pam_start");
  call_fn pam_authenticate_p = (call_fn)dlsym(lib, "pam_authenticate");
  call_fn pam_acct_mgmt_p = (call_fn)dlsym(lib, "pam_acct_mgmt");
  end_fn pam_end_p = (end_fn)dlsym(lib, "pam_end");
  strerror_fn pam_strerror_p = (strerror_fn)dlsym(lib, "pam_strerror");
  get_item_fn pam_get_item_p = (get_item_fn)dlsym(lib, "pam_get_item");
  if (!pam_start_p || !pam_authenticate_p || !pam_acct_mgmt_p || !pam_end_p || !pam_strerror_p || !pam_get_item_p) {
    say("libpam.so.0 lacks a function", NULL);
    finish(5);
  }

  struct pam_conv conv = {conversation, NULL};
  pam_handle_t *h = NULL;
  int rc = pam_start_p(service, name, &conv, &h);
  if (rc != PAM_SUCCESS) {
    say("pam_start failed", h ? pam_strerror_p(h, rc) : NULL);
    if (h) pam_end_p(h, rc);
    finish(5);
  }

  int code;
  rc = pam_authenticate_p(h, PAM_SILENT | PAM_DISALLOW_NULL_AUTHTOK);
  if (refused) {
    code = 3;
    say("the service asked more than one question", NULL);
  } else if (rc != PAM_SUCCESS) {
    switch (rc) {
      case PAM_AUTH_ERR:
      case PAM_USER_UNKNOWN:
      case PAM_MAXTRIES:
      case PAM_CRED_INSUFFICIENT:
      case PAM_PERM_DENIED:
      case PAM_CONV_ERR:
        code = 1;
        break;
      default:
        code = 5;
        say("pam_authenticate", pam_strerror_p(h, rc));
    }
  } else {
    rc = pam_acct_mgmt_p(h, PAM_SILENT | PAM_DISALLOW_NULL_AUTHTOK);
    if (refused) {
      code = 3;
      say("the service asked more than one question", NULL);
    } else if (rc != PAM_SUCCESS) {
      code = 2;
      say("pam_acct_mgmt", pam_strerror_p(h, rc));
    } else {
      /* a module may map the name to another account: only the name that was checked for uid 0 may sign in */
      const void *user = NULL;
      if (pam_get_item_p(h, PAM_USER, &user) != PAM_SUCCESS || !user || strcmp((const char *)user, name) != 0) {
        code = 1;
        say("PAM changed the user name", NULL);
      } else {
        code = 0;
      }
    }
  }
  pam_end_p(h, rc);
  finish(code);
  return code;
}
