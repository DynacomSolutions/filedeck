/*
 * filedeck-fanwatch: print the directories that changed on the given filesystems, one line each.
 *
 *   filedeck-fanwatch PATH...        PATH = any path on a local filesystem; the whole filesystem is watched
 *
 * Needs CAP_SYS_ADMIN (fanotify filesystem marks) and CAP_DAC_READ_SEARCH (open_by_handle_at). Linux 5.9 or newer.
 * No dependencies; build: cc -O2 -static -o filedeck-fanwatch filedeck-fanwatch.c
 *
 * Output (stdout, one line each; "\" and newline in a path are written as "\\" and "\n"):
 *   #ready N          N filesystems are watched
 *   x PATH            entry created, deleted, moved or its attributes changed in directory PATH
 *   w PATH            a file in PATH was closed after writing
 *   m PATH            a file in PATH was modified (an ongoing write; repeated at most once a second)
 *   !overflow         the kernel dropped events: everything watched must be rescanned
 * Messages go to stderr. Exit status: 0 stdout closed, 1 usage or runtime error, 2 not permitted
 * (missing capability), 3 not supported (old kernel, or no filesystem could be marked).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fanotify.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#if __SIZEOF_LONG__ != 8
#error "64-bit only (fanotify_mark takes a 64-bit mask)"
#endif

#define MAXFS 256
#define SELF_MASK (FAN_DELETE_SELF | FAN_MOVE_SELF)
#define STRUCT_MASK (FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO | FAN_ATTRIB | SELF_MASK)
#define MASK (STRUCT_MASK | FAN_CLOSE_WRITE | FAN_MODIFY | FAN_ONDIR)

static struct { int fsid[2]; int fd; } fss[MAXFS];
static int nfs;

static void out(const char *s, size_t n) {
	while (n) {
		ssize_t w = write(1, s, n);
		if (w < 0) {
			if (errno == EINTR) continue;
			_exit(0); /* reader gone */
		}
		s += w;
		n -= (size_t)w;
	}
}

static void emit(char kind, const char *path) {
	char buf[2 * PATH_MAX + 4];
	size_t n = 0;
	buf[n++] = kind;
	buf[n++] = ' ';
	for (const char *p = path; *p && n < sizeof buf - 3; p++) {
		if (*p == '\\') { buf[n++] = '\\'; buf[n++] = '\\'; }
		else if (*p == '\n') { buf[n++] = '\\'; buf[n++] = 'n'; }
		else buf[n++] = *p;
	}
	buf[n++] = '\n';
	out(buf, n);
}

static long long now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int find_fs(const int *fsid) {
	for (int i = 0; i < nfs; i++)
		if (fss[i].fsid[0] == fsid[0] && fss[i].fsid[1] == fsid[1]) return fss[i].fd;
	return -1;
}

/* Path (as this process sees it) of the directory a file handle names, or -1 (gone, or not reachable). */
static int resolve(int mfd, struct file_handle *fh, char *dst, size_t cap) {
	int fd = open_by_handle_at(mfd, fh, O_PATH | O_CLOEXEC);
	if (fd < 0) return -1;
	char link[64];
	snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
	ssize_t n = readlink(link, dst, cap - 1);
	close(fd);
	if (n <= 0) return -1;
	dst[n] = 0;
	if (n > 10 && !strcmp(dst + n - 10, " (deleted)")) return -1;
	return 0;
}

static void handle(const struct fanotify_event_metadata *ev) {
	static unsigned char last_fh[sizeof(struct file_handle) + 128];
	static int last_fsid[2], last_kind;
	static long long last_at;

	if (ev->mask & FAN_Q_OVERFLOW) {
		out("!overflow\n", 10);
		return;
	}
	char kind = (ev->mask & STRUCT_MASK) ? 'x' : (ev->mask & FAN_CLOSE_WRITE) ? 'w' : 'm';
	const char *end = (const char *)ev + ev->event_len;
	for (const struct fanotify_event_info_header *h = (const void *)(ev + 1); (const char *)h + sizeof *h <= end;
	     h = (const void *)((const char *)h + h->len)) {
		if (h->len < sizeof *h) break;
		if (h->info_type != FAN_EVENT_INFO_TYPE_DFID_NAME && h->info_type != FAN_EVENT_INFO_TYPE_DFID) continue;
		struct fanotify_event_info_fid *f = (void *)h;
		struct file_handle *fh = (void *)f->handle;
		size_t fhlen = sizeof *fh + fh->handle_bytes;
		if (fh->handle_bytes > 128) return;
		int fsid[2];
		memcpy(fsid, &f->fsid, sizeof fsid);
		int mfd = find_fs(fsid);
		if (mfd < 0) return;
		long long t = now_ms();
		/* a busy writer repeats 'm' for the same directory; once a second is plenty */
		if (kind == 'm' && last_kind == 'm' && !memcmp(fsid, last_fsid, sizeof fsid) && !memcmp(fh, last_fh, fhlen) && t - last_at < 1000) return;
		char path[PATH_MAX];
		if (resolve(mfd, fh, path, sizeof path) < 0) return;
		last_kind = kind;
		memcpy(last_fsid, fsid, sizeof fsid);
		memcpy(last_fh, fh, fhlen);
		last_at = t;
		emit(kind, path);
		return;
	}
}

static int fail(int code, const char *msg, const char *arg) {
	fprintf(stderr, "filedeck-fanwatch: %s%s%s%s\n", msg, arg ? " (" : "", arg ? arg : "", arg ? ")" : "");
	return code;
}

int main(int argc, char **argv) {
	if (argc < 2) return fail(1, "usage: filedeck-fanwatch PATH...", NULL);
	prctl(PR_SET_PDEATHSIG, SIGTERM);
	int fan = (int)syscall(SYS_fanotify_init, FAN_CLASS_NOTIF | FAN_REPORT_DFID_NAME | FAN_UNLIMITED_QUEUE | FAN_CLOEXEC, O_RDONLY | O_LARGEFILE);
	if (fan < 0) {
		if (errno == EPERM) return fail(2, "not permitted: fanotify needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH", strerror(errno));
		return fail(3, "fanotify_init failed (kernel 5.9 or newer is needed)", strerror(errno));
	}
	int denied = 0;
	for (int i = 1; i < argc && nfs < MAXFS; i++) {
		struct statfs sf;
		int mfd = open(argv[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (mfd < 0 || fstatfs(mfd, &sf) < 0) {
			fprintf(stderr, "filedeck-fanwatch: skipping %s: %s\n", argv[i], strerror(errno));
			if (mfd >= 0) close(mfd);
			continue;
		}
		int fsid[2];
		memcpy(fsid, &sf.f_fsid, sizeof fsid);
		if (find_fs(fsid) >= 0) { close(mfd); continue; }
		/* is a handle of this path openable? (CAP_DAC_READ_SEARCH) */
		struct file_handle *probe = malloc(sizeof *probe + 128);
		int mount_id;
		probe->handle_bytes = 128;
		if (name_to_handle_at(mfd, "", probe, &mount_id, AT_EMPTY_PATH) == 0) {
			int pfd = open_by_handle_at(mfd, probe, O_PATH | O_CLOEXEC);
			if (pfd >= 0) close(pfd);
			else if (errno == EPERM) denied = 1;
		}
		free(probe);
		if (syscall(SYS_fanotify_mark, fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, (unsigned long long)MASK, AT_FDCWD, argv[i]) < 0) {
			if (errno == EPERM) denied = 1;
			fprintf(stderr, "filedeck-fanwatch: cannot watch %s: %s\n", argv[i], strerror(errno));
			close(mfd);
			continue;
		}
		fss[nfs].fsid[0] = fsid[0];
		fss[nfs].fsid[1] = fsid[1];
		fss[nfs++].fd = mfd;
	}
	if (denied) return fail(2, "not permitted: fanotify needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH", NULL);
	if (!nfs) return fail(3, "no filesystem could be watched", NULL);
	char ready[32];
	out(ready, (size_t)snprintf(ready, sizeof ready, "#ready %d\n", nfs));

	static char buf[256 * 1024] __attribute__((aligned(8)));
	for (;;) {
		ssize_t len = read(fan, buf, sizeof buf);
		if (len < 0) {
			if (errno == EINTR) continue;
			return fail(1, "read failed", strerror(errno));
		}
		for (const struct fanotify_event_metadata *ev = (const void *)buf; FAN_EVENT_OK(ev, len); ev = FAN_EVENT_NEXT(ev, len)) {
			if (ev->vers != FANOTIFY_METADATA_VERSION) return fail(1, "fanotify metadata version mismatch", NULL);
			handle(ev);
			if (ev->fd >= 0) close(ev->fd);
		}
	}
}
