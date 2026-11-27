/*
 * filedeck-fanwatch: print every entry that changed on the given filesystems, one line each.
 *
 *   filedeck-fanwatch PATH...        PATH = any path on a local filesystem; the whole filesystem is watched
 *
 * Needs CAP_SYS_ADMIN (fanotify filesystem marks) and CAP_DAC_READ_SEARCH (open_by_handle_at). Linux 5.9 or newer;
 * 5.17 or newer gives the full output (FAN_RENAME and FAN_REPORT_TARGET_FID). No dependencies;
 * build: cc -O2 -static -o filedeck-fanwatch filedeck-fanwatch.c
 *
 * Settings (environment only, there are no options): FILEDECK_FANWATCH_CACHE = directory handles kept in the
 * path cache (default 16384, 0 = no cache).
 *
 * Output (stdout, one line each; in a path "\" is written "\\" and every byte below 0x20 or 0x7f as \xHH, so a
 * path never holds a TAB or a line break). KIND is one letter, DIR is "d" for a folder and "f" for anything else:
 *   KIND DIR PATH         an entry changed. KIND: C created, D deleted, M modified (an ongoing write), W closed
 *                         after writing, A attributes changed. An entry that is modified again within a second
 *                         is reported once, and once more when that second ends (nothing is dropped).
 *   R DIR NEW<TAB>OLD     an entry was renamed or moved: its new path, then its old path
 *   #caps K=V ...         which kernel features this run has (rename, target, unlimited), then the path cache size
 *   #ready N              N filesystems are watched
 *   #stats K=V ...        counters (events, hits, misses, opens, unresolved), printed every few seconds while events flow and before a #sync answer
 *   c PATH                PATH could not be watched (aliases of an already watched filesystem are not reported)
 *   !overflow             the kernel dropped events: everything watched must be rescanned
 *   #sync                 answer to a line on stdin: every event the kernel had queued by then has been printed above
 * Without FAN_RENAME (kernel before 5.17) a move is reported as D (old place) and C (new place).
 * Messages go to stderr. Exit status: 0 stdout closed, 1 usage or runtime error, 2 not permitted
 * (missing capability), 3 not supported (old kernel, or no filesystem could be marked).
 *
 * Directory paths come from open_by_handle_at and are kept in a cache (fsid and handle to path), so most events
 * need no system call to learn their place. The cache is dropped as a whole when a folder is renamed. A folder
 * that is deleted leaves it alone: it had no children, and its handle never names another folder.
 * An event inside a folder that was removed before the event was read has no place to name and is not reported
 * (counted as "unresolved"); the removal of that folder is reported.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fanotify.h>
#include <signal.h>
#include <stdarg.h>
#include <poll.h>
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

/* older kernel headers may lack these: the values are part of the kernel interface */
#ifndef FAN_RENAME
#define FAN_RENAME 0x10000000
#endif
#ifndef FAN_REPORT_TARGET_FID
#define FAN_REPORT_TARGET_FID 0x00001000
#endif
#ifndef FAN_REPORT_FID
#define FAN_REPORT_FID 0x00000200
#endif
#ifndef FAN_EVENT_INFO_TYPE_OLD_DFID_NAME
#define FAN_EVENT_INFO_TYPE_OLD_DFID_NAME 10
#define FAN_EVENT_INFO_TYPE_NEW_DFID_NAME 12
#endif

#define MAXFS 4096
#define FHMAX 128
#define SELF_MASK (FAN_DELETE_SELF | FAN_MOVE_SELF)
#define ENTRY_MASK (FAN_CREATE | FAN_DELETE | FAN_ATTRIB | FAN_MODIFY | FAN_CLOSE_WRITE)
#define BASE_MASK (ENTRY_MASK | SELF_MASK | FAN_ONDIR)
#define THROTTLE_MS 1000
#define THR_SLOTS 4096
#define PEND_POLL_MS 250
#define STATS_MS 5000

static struct { int fsid[2]; int fd; } fss[MAXFS];
static int nfs;

/* ---- output: one buffer, written when it fills, when a batch of events ends and before a #sync answer ---- */

static char obuf[192 * 1024];
static size_t olen;

static void out_flush(void) {
	const char *s = obuf;
	size_t n = olen;
	olen = 0;
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

static void out(const char *s, size_t n) {
	if (olen + n > sizeof obuf) out_flush();
	memcpy(obuf + olen, s, n);
	olen += n;
}

/* a line is at most two escaped paths plus its head: 2 * 4 * PATH_MAX + 16 bytes */
#define LINE_MAX_BYTES (8 * PATH_MAX + 16)

static size_t put_path(char *buf, size_t n, const char *path) {
	for (const unsigned char *p = (const unsigned char *)path; *p && n < LINE_MAX_BYTES - 6; p++) {
		if (*p == '\\') { buf[n++] = '\\'; buf[n++] = '\\'; }
		else if (*p < 0x20 || *p == 0x7f) n += (size_t)snprintf(buf + n, 5, "\\x%02x", *p);
		else buf[n++] = (char)*p;
	}
	return n;
}

static void emit(char kind, int isdir, const char *path, const char *old) {
	static char buf[LINE_MAX_BYTES + 8];
	size_t n = 0;
	buf[n++] = kind;
	buf[n++] = ' ';
	if (kind != 'c') { buf[n++] = isdir ? 'd' : 'f'; buf[n++] = ' '; }
	n = put_path(buf, n, path);
	if (old) { buf[n++] = '\t'; n = put_path(buf, n, old); }
	buf[n++] = '\n';
	out(buf, n);
}

static void emitf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void emitf(const char *fmt, ...) {
	char buf[256];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	if (n > 0) out(buf, (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1);
}

static long long now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* ---- counters ---- */

static unsigned long long n_events, n_hits, n_misses, n_opens, n_unresolved;
static unsigned long long stats_sent[5];

static void stats_emit(void) {
	unsigned long long cur[5] = {n_events, n_hits, n_misses, n_opens, n_unresolved};
	if (!memcmp(cur, stats_sent, sizeof cur)) return;
	memcpy(stats_sent, cur, sizeof cur);
	emitf("#stats events=%llu hits=%llu misses=%llu opens=%llu unresolved=%llu\n", cur[0], cur[1], cur[2], cur[3], cur[4]);
}

/* ---- filesystems ---- */

static int find_fs(const int *fsid) {
	for (int i = 0; i < nfs; i++)
		if (fss[i].fsid[0] == fsid[0] && fss[i].fsid[1] == fsid[1]) return fss[i].fd;
	return -1;
}

/* ---- directory path cache: (fsid, handle) -> path, 4-way sets, the least recently used way is replaced ---- */

#define WAYS 4
#define KEYMAX (8 + 4 + FHMAX)
struct cent {
	uint64_t h;
	unsigned tick;
	unsigned gen; /* valid only while equal to cache_gen: dropping the cache is one increment */
	unsigned short klen;
	unsigned char key[KEYMAX];
	char *path;
};
static struct cent *cache;
static size_t cache_sets;
static unsigned cache_gen = 1, cache_tick;

static uint64_t hash64(const void *p, size_t n, uint64_t h) {
	const unsigned char *s = p;
	for (size_t i = 0; i < n; i++) { h ^= s[i]; h *= 1099511628211ULL; }
	return h;
}

static size_t key_make(unsigned char *key, const int *fsid, const struct file_handle *fh) {
	memcpy(key, fsid, 8);
	memcpy(key + 8, &fh->handle_type, 4);
	memcpy(key + 12, fh->f_handle, fh->handle_bytes);
	return 12 + fh->handle_bytes;
}

static void cache_init(size_t entries) {
	if (entries < WAYS) return;
	cache_sets = entries / WAYS;
	cache = calloc(cache_sets * WAYS, sizeof *cache);
	if (!cache) cache_sets = 0;
}

static struct cent *cache_set(uint64_t h) { return cache + (size_t)(h % cache_sets) * WAYS; }

static const char *cache_get(const unsigned char *key, size_t klen) {
	if (!cache_sets) return NULL;
	uint64_t h = hash64(key, klen, 14695981039346656037ULL);
	struct cent *s = cache_set(h);
	for (int i = 0; i < WAYS; i++)
		if (s[i].gen == cache_gen && s[i].h == h && s[i].klen == klen && !memcmp(s[i].key, key, klen)) {
			s[i].tick = ++cache_tick;
			return s[i].path;
		}
	return NULL;
}

static void cache_put(const unsigned char *key, size_t klen, const char *path) {
	if (!cache_sets) return;
	uint64_t h = hash64(key, klen, 14695981039346656037ULL);
	struct cent *s = cache_set(h), *v = NULL;
	for (int i = 0; i < WAYS && !v; i++)
		if (s[i].gen == cache_gen && s[i].h == h && s[i].klen == klen && !memcmp(s[i].key, key, klen)) v = &s[i];
	for (int i = 0; i < WAYS && !v; i++)
		if (s[i].gen != cache_gen) v = &s[i]; /* an empty or dropped way */
	if (!v) {
		v = &s[0];
		for (int i = 1; i < WAYS; i++)
			if ((int)(s[i].tick - v->tick) < 0) v = &s[i]; /* the least recently used */
	}
	char *copy = strdup(path);
	if (!copy) return;
	free(v->path);
	v->path = copy;
	v->h = h;
	v->klen = (unsigned short)klen;
	memcpy(v->key, key, klen);
	v->gen = cache_gen;
	v->tick = ++cache_tick;
}

/* a folder with children moved: every path below it changed, so everything cached is forgotten (lazily: the memory is freed on reuse) */
static void cache_clear(void) {
	if (++cache_gen == 0) {
		cache_gen = 1;
		for (size_t i = 0; i < cache_sets * WAYS; i++) cache[i].gen = 0;
	}
}

/* Path (as this process sees it) of the directory a file handle names, or -1 (gone, or not reachable). */
static int resolve_open(int mfd, struct file_handle *fh, char *dst, size_t cap) {
	n_opens++;
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

static int resolve(const int *fsid, struct file_handle *fh, char *dst, size_t cap) {
	if (fh->handle_bytes > FHMAX) return -1;
	int mfd = find_fs(fsid);
	if (mfd < 0) return -1;
	unsigned char key[KEYMAX];
	size_t klen = key_make(key, fsid, fh);
	const char *hit = cache_get(key, klen);
	if (hit) {
		n_hits++;
		size_t n = strlen(hit);
		if (n >= cap) return -1;
		memcpy(dst, hit, n + 1);
		return 0;
	}
	n_misses++;
	if (resolve_open(mfd, fh, dst, cap) < 0) return -1;
	cache_put(key, klen, dst);
	return 0;
}

/* ---- modify throttle: an entry modified again within THROTTLE_MS is reported once now and once when the second ends ---- */

struct thr {
	uint64_t key;
	long long last;
	long long due; /* when the held report is made (0 = none held) */
	int isdir;
	char *path;
};
static struct thr thr[THR_SLOTS];
static int npend;

static void thr_release(struct thr *t) {
	if (t->due) npend--;
	t->due = 0;
	free(t->path);
	t->path = NULL;
}

static void thr_flush(long long now, int force) {
	if (!npend) return;
	for (int i = 0; i < THR_SLOTS && npend; i++) {
		struct thr *t = &thr[i];
		if (!t->due || (!force && t->due > now)) continue;
		emit('M', t->isdir, t->path, NULL);
		t->last = now;
		thr_release(t);
	}
}

/* true when this modify is reported now; false when it is held (the report is made later by thr_flush) */
static int thr_modify(uint64_t key, long long now, int isdir, const char *path) {
	struct thr *t = &thr[key % THR_SLOTS];
	if (t->key == key && t->last && now - t->last < THROTTLE_MS) {
		if (!t->due) {
			t->path = strdup(path);
			if (!t->path) return 1;
			t->isdir = isdir;
			t->due = t->last + THROTTLE_MS;
			npend++;
		}
		return 0;
	}
	if (t->key != key && t->due) { /* another entry takes the slot: its held report is made first */
		emit('M', t->isdir, t->path, NULL);
		thr_release(t);
	}
	if (t->due) thr_release(t); /* the window ended: this report takes the held one's place */
	t->key = key;
	t->last = now;
	return 1;
}

/* a close or a delete makes a held modify report unnecessary */
static void thr_done(uint64_t key) {
	if (!npend) return;
	struct thr *t = &thr[key % THR_SLOTS];
	if (t->key == key && t->due) thr_release(t);
}

/* ---- events ---- */

static int caps_target, caps_rename;

struct rec {
	int have;
	int fsid[2];
	struct file_handle *fh;
	const char *name; /* NULL for a record without a name */
};

static void rec_read(struct rec *r, const struct fanotify_event_info_header *h) {
	struct fanotify_event_info_fid *f = (void *)h;
	struct file_handle *fh = (void *)f->handle;
	if (fh->handle_bytes > FHMAX) return;
	r->have = 1;
	r->fh = fh;
	memcpy(r->fsid, &f->fsid, sizeof r->fsid);
	r->name = NULL;
	if (h->info_type != FAN_EVENT_INFO_TYPE_FID && h->info_type != FAN_EVENT_INFO_TYPE_DFID) {
		const char *name = (const char *)fh->f_handle + fh->handle_bytes;
		if ((const char *)h + h->len > name) r->name = name;
	}
}

/* Full path of the entry a record names: its directory's path and the name ("." and "" mean the directory itself). */
static int rec_path(const struct rec *r, char *dst, size_t cap) {
	if (!r->have) return -1;
	if (resolve(r->fsid, r->fh, dst, cap) < 0) return -1;
	if (!r->name || !*r->name || !strcmp(r->name, ".")) return 0;
	size_t n = strlen(dst), m = strlen(r->name);
	if (n + m + 2 > cap) return -1;
	if (!(n == 1 && dst[0] == '/')) dst[n++] = '/';
	memcpy(dst + n, r->name, m + 1);
	return 0;
}

static uint64_t rec_key(const struct rec *r) {
	unsigned char key[KEYMAX];
	size_t klen = key_make(key, r->fsid, r->fh);
	uint64_t h = hash64(key, klen, 14695981039346656037ULL);
	return r->name ? hash64(r->name, strlen(r->name), h ^ 0x9e3779b97f4a7c15ULL) : h;
}

static void handle(const struct fanotify_event_metadata *ev) {
	n_events++;
	if (ev->mask & FAN_Q_OVERFLOW) {
		out("!overflow\n", 10);
		return;
	}
	struct rec dfid = {0}, oldr = {0}, newr = {0}, fid = {0};
	const char *end = (const char *)ev + ev->event_len;
	for (const struct fanotify_event_info_header *h = (const void *)(ev + 1); (const char *)h + sizeof *h <= end;
	     h = (const void *)((const char *)h + h->len)) {
		if (h->len < sizeof *h || (const char *)h + h->len > end) break;
		switch (h->info_type) {
		case FAN_EVENT_INFO_TYPE_DFID_NAME:
		case FAN_EVENT_INFO_TYPE_DFID: rec_read(&dfid, h); break;
		case FAN_EVENT_INFO_TYPE_OLD_DFID_NAME: rec_read(&oldr, h); break;
		case FAN_EVENT_INFO_TYPE_NEW_DFID_NAME: rec_read(&newr, h); break;
		case FAN_EVENT_INFO_TYPE_FID: rec_read(&fid, h); break;
		}
	}
	int isdir = (ev->mask & FAN_ONDIR) != 0;
	long long t = 0;
	char path[PATH_MAX], old[PATH_MAX];

	/*
	 * A folder that moved or was removed itself. Handles carry a generation number, so a removed folder's entry can
	 * never name another folder: it stays until it is replaced (and a later event may still need it). A move is
	 * already handled by FAN_RENAME (or MOVED_*); only a kernel that reports neither relies on this one.
	 */
	if (ev->mask & SELF_MASK) {
		if (isdir && (ev->mask & FAN_MOVE_SELF) && !caps_rename) cache_clear();
		if (!(ev->mask & ENTRY_MASK)) return;
	}

	if (ev->mask & FAN_RENAME) {
		int ok_new = rec_path(&newr, path, sizeof path) == 0;
		int ok_old = rec_path(&oldr, old, sizeof old) == 0;
		if (isdir) cache_clear();
		if (ok_new && ok_old) {
			if (npend) thr_done(rec_key(&oldr));
			emit('R', isdir, path, old);
		} else if (ok_new) emit('C', isdir, path, NULL); /* moved in from outside what is watched */
		else if (ok_old) emit('D', isdir, old, NULL);
		else n_unresolved++;
		return;
	}
	if (ev->mask & (FAN_MOVED_FROM | FAN_MOVED_TO)) { /* kernels without FAN_RENAME */
		if (isdir) cache_clear();
		if (rec_path(&dfid, path, sizeof path) < 0) { n_unresolved++; return; }
		emit((ev->mask & FAN_MOVED_FROM) ? 'D' : 'C', isdir, path, NULL);
		return;
	}
	if (!(ev->mask & ENTRY_MASK)) return;
	/* an entry event names its entry; a record without a name (an inode event) is not one of them */
	if (!dfid.name) return;
	if (rec_path(&dfid, path, sizeof path) < 0) {
		/* The folder holding the entry is gone already (a tree removed faster than it is read). A removed folder
		 * that was seen before is still in the cache under its own id, so its removal is reported all the same. */
		const char *seen = NULL;
		if ((ev->mask & FAN_DELETE) && isdir && fid.have) {
			unsigned char key[KEYMAX];
			seen = cache_get(key, key_make(key, fid.fsid, fid.fh));
		}
		if (!seen) { n_unresolved++; return; }
		emit('D', 1, seen, NULL);
		return;
	}
	if (ev->mask & FAN_CREATE) {
		emit('C', isdir, path, NULL);
		/* a new folder: its place is known now, so its first event needs no lookup */
		if (isdir && fid.have && cache_sets) {
			unsigned char key[KEYMAX];
			size_t klen = key_make(key, fid.fsid, fid.fh);
			cache_put(key, klen, path);
		}
	}
	if (ev->mask & FAN_DELETE) {
		if (npend) thr_done(rec_key(&dfid));
		emit('D', isdir, path, NULL);
	}
	if (ev->mask & FAN_ATTRIB) emit('A', isdir, path, NULL);
	if (ev->mask & FAN_MODIFY) {
		t = now_ms();
		if (thr_modify(rec_key(&dfid), t, isdir, path)) emit('M', isdir, path, NULL);
	}
	if (ev->mask & FAN_CLOSE_WRITE) {
		if (npend) thr_done(rec_key(&dfid));
		emit('W', isdir, path, NULL);
	}
}

static int fail(int code, const char *msg, const char *arg) {
	fprintf(stderr, "filedeck-fanwatch: %s%s%s%s\n", msg, arg ? " (" : "", arg ? arg : "", arg ? ")" : "");
	return code;
}

static int fan_init(unsigned flags, unsigned *used) {
	*used = flags;
	return (int)syscall(SYS_fanotify_init, flags | FAN_CLASS_NOTIF | FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_LARGEFILE);
}

int main(int argc, char **argv) {
	if (argc < 2) return fail(1, "usage: filedeck-fanwatch PATH...", NULL);
	prctl(PR_SET_PDEATHSIG, SIGTERM);
	/* the best format first; each refusal drops one feature and says so */
	static const struct { unsigned flags; int target, unlimited; } formats[] = {
		{FAN_REPORT_DFID_NAME | FAN_REPORT_FID | FAN_REPORT_TARGET_FID | FAN_UNLIMITED_QUEUE, 1, 1},
		{FAN_REPORT_DFID_NAME | FAN_REPORT_FID | FAN_REPORT_TARGET_FID, 1, 0},
		{FAN_REPORT_DFID_NAME | FAN_UNLIMITED_QUEUE, 0, 1},
		{FAN_REPORT_DFID_NAME, 0, 0},
	};
	int fan = -1, first_errno = 0, caps_unlimited = 0;
	for (size_t i = 0; i < sizeof formats / sizeof *formats && fan < 0; i++) {
		unsigned used;
		fan = fan_init(formats[i].flags, &used);
		if (fan >= 0) {
			caps_target = formats[i].target;
			caps_unlimited = formats[i].unlimited;
		} else if (!first_errno) first_errno = errno;
		if (fan < 0 && errno == ENOSYS) break;
	}
	if (fan < 0) {
		if (errno == EPERM) return fail(2, "not permitted: fanotify needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH", strerror(errno));
		return fail(3, "fanotify_init failed (kernel 5.9 or newer is needed)", strerror(errno));
	}
	if (!caps_unlimited) fprintf(stderr, "filedeck-fanwatch: no unlimited event queue (%s): a burst may overflow the kernel queue\n", strerror(first_errno ? first_errno : EINVAL));
	if (!caps_target) fprintf(stderr, "filedeck-fanwatch: no target ids in events (kernel before 5.17): a removed folder empties the path cache\n");
	unsigned long long mask = BASE_MASK | FAN_RENAME;
	caps_rename = 1;
	int denied = 0;
	for (int i = 1; i < argc && nfs < MAXFS; i++) {
		struct statfs sf;
		int mfd = open(argv[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (mfd < 0 || fstatfs(mfd, &sf) < 0) {
			fprintf(stderr, "filedeck-fanwatch: skipping %s: %s\n", argv[i], strerror(errno));
			emit('c', 0, argv[i], NULL);
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
		long rc = syscall(SYS_fanotify_mark, fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, argv[i]);
		if (rc < 0 && errno == EINVAL && caps_rename) {
			/* no FAN_RENAME (kernel before 5.17): moves are reported as a delete and a create */
			caps_rename = 0;
			mask = (mask & ~(unsigned long long)FAN_RENAME) | FAN_MOVED_FROM | FAN_MOVED_TO;
			fprintf(stderr, "filedeck-fanwatch: no FAN_RENAME: a move is reported as a delete and a create\n");
			rc = syscall(SYS_fanotify_mark, fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, argv[i]);
		}
		if (rc < 0) {
			if (errno == EPERM) denied = 1;
			fprintf(stderr, "filedeck-fanwatch: cannot watch %s: %s\n", argv[i], strerror(errno));
			emit('c', 0, argv[i], NULL);
			close(mfd);
			continue;
		}
		fss[nfs].fsid[0] = fsid[0];
		fss[nfs].fsid[1] = fsid[1];
		fss[nfs++].fd = mfd;
	}
	if (denied) return fail(2, "not permitted: fanotify needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH", NULL);
	if (!nfs) return fail(3, "no filesystem could be watched", NULL);
	size_t cache_n = 16384;
	const char *env = getenv("FILEDECK_FANWATCH_CACHE");
	if (env && *env) cache_n = (size_t)strtoul(env, NULL, 10);
	if (cache_n > 4u * 1024 * 1024) cache_n = 4u * 1024 * 1024;
	cache_init(cache_n);
	emitf("#caps rename=%d target=%d unlimited=%d cache=%zu\n", caps_rename, caps_target, caps_unlimited, cache_sets * WAYS);
	emitf("#ready %d\n", nfs);
	out_flush();

	static char buf[256 * 1024] __attribute__((aligned(8)));
	struct pollfd pfd[2] = {{.fd = fan, .events = POLLIN}, {.fd = 0, .events = POLLIN}};
	long long last_stats = now_ms();
	for (;;) {
		int r = poll(pfd, 2, npend ? PEND_POLL_MS : STATS_MS);
		if (r < 0) {
			if (errno == EINTR) continue;
			return fail(1, "poll failed", strerror(errno));
		}
		int want_sync = 0;
		if (pfd[1].fd >= 0 && (pfd[1].revents & (POLLIN | POLLHUP | POLLERR))) {
			/* a line from the parent asks for a sync; end of input (or no input at all) just stops listening to it */
			char in[64];
			ssize_t n = read(0, in, sizeof in);
			if (n > 0) want_sync = 1;
			else if (n == 0 || errno != EINTR) pfd[1].fd = -1;
		}
		/* read what the kernel has queued (the descriptor does not block): for a sync, all of it, before answering */
		for (;;) {
			ssize_t len = read(fan, buf, sizeof buf);
			if (len < 0) {
				if (errno == EINTR) continue;
				if (errno == EAGAIN) break;
				return fail(1, "read failed", strerror(errno));
			}
			for (const struct fanotify_event_metadata *ev = (const void *)buf; FAN_EVENT_OK(ev, len); ev = FAN_EVENT_NEXT(ev, len)) {
				if (ev->vers != FANOTIFY_METADATA_VERSION) return fail(1, "fanotify metadata version mismatch", NULL);
				handle(ev);
				if (ev->fd >= 0) close(ev->fd);
			}
			/* a short read emptied the queue: poll tells when more comes (a sync reads on until the queue answers EAGAIN, to be sure) */
			if (!want_sync && (size_t)len < sizeof buf / 2) break;
		}
		long long now = now_ms();
		thr_flush(now, 0);
		if (now - last_stats >= STATS_MS) { last_stats = now; stats_emit(); }
		if (want_sync) {
			thr_flush(now, 1); /* held reports go out before the answer: the caller counts them as seen */
			stats_emit();
			out("#sync\n", 6);
		}
		out_flush();
	}
}
