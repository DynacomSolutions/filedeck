/*
 * filedeck-fanwatch: print every entry that changed on the given filesystems, one line each.
 *
 *   filedeck-fanwatch PATH...        PATH = any path on a local filesystem; the whole filesystem is watched
 *                                    Give every mount point that shows the filesystem (bind mounts too): an entry is reported
 *                                    under each of them that shows it (see "Mounts" below).
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
 * Mounts: one filesystem can be shown at many places (the mount of the whole filesystem and bind mounts of some of its
 * folders). A mount has a root: the folder of the filesystem that it shows ("/" for the whole filesystem; field 4 of
 * /proc/self/mountinfo, found with the mount id that name_to_handle_at gives for the PATH). The filesystem is marked once. The
 * helper knows each event's place in the filesystem ("rel", for example /repositories/.data/org/x), and reports it under every
 * given mount whose root is a path prefix of rel (whole path segments), as MOUNTPOINT + rel without the root. An entry that two
 * mounts show gives one line for each, one after the other. An entry that no given mount shows is not reported (counted as
 * "unresolved"). A move gives R where both places are shown by a mount, D where only the old place is, C where only the new one is.
 *
 * Finding rel: open_by_handle_at(MOUNTFD, handle) gives a descriptor of the folder whatever the mount fd shows. Measured on a real
 * kernel (tmpfs, 7.x, bind mounts of /data/one and /data/two): readlink(/proc/self/fd/N) gives the mount point plus the path below the
 * root for a folder inside the root of that mount. For a folder outside the root (the other bind, or a folder that only the whole
 * filesystem shows) the kernel cannot build a path through that mount, and it gives "/". So a path is taken only when it starts with
 * the mount's own mount point (this refuses "/") and, for a root other than "/", fstat of the descriptor and stat of the path name the
 * same inode. A mount that shows the whole filesystem (root "/") shows every folder, so it is tried first, then the others by the
 * length of their root. rel is then the root plus the rest of the path.
 *
 * Directory paths come from open_by_handle_at and are kept in a cache (fsid and handle to rel), so most events
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

/* A mount that is given on the command line: where it is (target, as this process sees it) and which folder of the filesystem it shows (root). */
struct mnt {
	char *target;
	size_t tlen;
	char *root; /* "/" or a path without a trailing "/" */
	size_t rlen;
	int fd;
	const char *arg; /* the command line path: used to mark the filesystem and to name it in a message */
	int id; /* mount id (name_to_handle_at, mountinfo field 1), -1 when unknown */
};
struct fsrec {
	int fsid[2];
	struct mnt *m; /* sorted: the root "/" first, then by the length of the root */
	int nm;
};
static struct fsrec fss[MAXFS];
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
		if (fss[i].fsid[0] == fsid[0] && fss[i].fsid[1] == fsid[1]) return i;
	return -1;
}

/* the suffix of rel that a mount shows ("" for its root itself, else "/..."), or NULL when the mount does not show rel. Whole path segments only. */
static const char *mnt_shows(const struct mnt *m, const char *rel) {
	if (m->rlen == 1) return rel[1] ? rel : "";
	if (strncmp(rel, m->root, m->rlen) != 0 || (rel[m->rlen] != 0 && rel[m->rlen] != '/')) return NULL;
	return rel + m->rlen;
}

/* the path of rel under one mount (mount point + suffix), 0, or -1 when the mount does not show rel or the path is too long */
static int mnt_path(const struct mnt *m, const char *rel, char *dst, size_t cap) {
	const char *suffix = mnt_shows(m, rel);
	if (!suffix) return -1;
	size_t n = m->tlen == 1 ? 0 : m->tlen, k = strlen(suffix);
	if (n + k + 2 > cap) return -1;
	memcpy(dst, m->target, n);
	memcpy(dst + n, suffix, k + 1);
	if (!dst[0]) { dst[0] = '/'; dst[1] = 0; } /* a mount at "/" and the root of it */
	return 0;
}

/* mounts of one filesystem: the root "/" first (it shows every entry), then the shortest roots; the mount point breaks a tie */
static int mnt_cmp(const void *x, const void *y) {
	const struct mnt *a = x, *b = y;
	if (a->rlen != b->rlen) return a->rlen < b->rlen ? -1 : 1;
	return strcmp(a->target, b->target);
}

/* Report one entry under every mount of its filesystem that shows it. Nothing is reported when no mount does (counted as unresolved). */
static int emit_vis(char kind, int isdir, const int *fsid, const char *rel) {
	int fi = find_fs(fsid), n = 0;
	char buf[PATH_MAX];
	if (fi >= 0)
		for (int i = 0; i < fss[fi].nm; i++)
			if (mnt_path(&fss[fi].m[i], rel, buf, sizeof buf) == 0) { emit(kind, isdir, buf, NULL); n++; }
	if (!n) n_unresolved++;
	return n;
}

/* A move: R under a mount that shows both places, D under one that shows only the old place, C under one that shows only the new place. */
static void emit_move(int isdir, const int *nfsid, const char *newrel, const int *ofsid, const char *oldrel) {
	int fn = find_fs(nfsid), fo = find_fs(ofsid), n = 0;
	char np[PATH_MAX], op[PATH_MAX];
	if (fn < 0 || fn != fo) { /* (a rename never crosses filesystems: this is for a record that names two) */
		emit_vis('C', isdir, nfsid, newrel);
		emit_vis('D', isdir, ofsid, oldrel);
		return;
	}
	for (int i = 0; i < fss[fn].nm; i++) {
		int vn = mnt_path(&fss[fn].m[i], newrel, np, sizeof np) == 0, vo = mnt_path(&fss[fn].m[i], oldrel, op, sizeof op) == 0;
		if (vn && vo) emit('R', isdir, np, op);
		else if (vn) emit('C', isdir, np, NULL);
		else if (vo) emit('D', isdir, op, NULL);
		n += vn || vo;
	}
	if (!n) n_unresolved++;
}

/* a path that shows rel now, for a look at the entry itself: the first mount that shows it */
static int first_path(const int *fsid, const char *rel, char *dst, size_t cap) {
	int fi = find_fs(fsid);
	if (fi < 0) return -1;
	for (int i = 0; i < fss[fi].nm; i++)
		if (mnt_path(&fss[fi].m[i], rel, dst, cap) == 0) return 0;
	return -1;
}

/* ---- mounts: root and mount point of each mount, from /proc/self/mountinfo ---- */

struct mi { int id; char *root; char *mp; };
static struct mi *mis;
static size_t nmis;

/* "\040" and the like (the kernel writes a space, a tab, a line break and a backslash so) */
static void mi_unescape(char *s) {
	char *w = s;
	for (; *s; s++) {
		if (s[0] == '\\' && s[1] >= '0' && s[1] <= '3' && s[2] >= '0' && s[2] <= '7' && s[3] >= '0' && s[3] <= '7') {
			*w++ = (char)(((s[1] - '0') << 6) | ((s[2] - '0') << 3) | (s[3] - '0'));
			s += 3;
		} else *w++ = *s;
	}
	*w = 0;
}

static void mi_load(void) {
	FILE *f = fopen("/proc/self/mountinfo", "re");
	if (!f) {
		fprintf(stderr, "filedeck-fanwatch: cannot read /proc/self/mountinfo (%s): every mount is taken to show its whole filesystem\n", strerror(errno));
		return;
	}
	char *line = NULL;
	size_t cap = 0, capmis = 0;
	while (getline(&line, &cap, f) > 0) {
		int id, off = 0;
		char *root = malloc(strlen(line) + 1), *mp = malloc(strlen(line) + 1);
		/* id parent major:minor root mountpoint options ... (root and mountpoint hold no space: a space is written \040) */
		if (root && mp && sscanf(line, "%d %*d %*d:%*d %s %s%n", &id, root, mp, &off) >= 3) {
			if (nmis == capmis) {
				size_t ncap = capmis ? capmis * 2 : 256;
				struct mi *grown = realloc(mis, ncap * sizeof *mis);
				if (!grown) { free(root); free(mp); break; } /* what was read so far stays in `mis` and is freed by mi_free */
				mis = grown;
				capmis = ncap;
			}
			mi_unescape(root);
			mi_unescape(mp);
			mis[nmis++] = (struct mi){id, root, mp};
		} else {
			free(root);
			free(mp);
		}
	}
	free(line);
	fclose(f);
}

static void mi_free(void) {
	for (size_t i = 0; i < nmis; i++) { free(mis[i].root); free(mis[i].mp); }
	free(mis);
	mis = NULL;
	nmis = 0;
}

/* Add a mount (an open directory of it) to a filesystem. 1 added, 0 that mount is in it already, -1 no memory or no usable path. */
static int fs_add(struct fsrec *f, int fd, const char *arg, int id) {
	for (int i = 0; id >= 0 && i < f->nm; i++)
		if (f->m[i].id == id) return 0;
	const struct mi *mi = NULL;
	for (size_t i = 0; id >= 0 && i < nmis && !mi; i++)
		if (mis[i].id == id) mi = &mis[i];
	struct mnt *grown = realloc(f->m, (size_t)(f->nm + 1) * sizeof *f->m);
	if (!grown) return -1;
	f->m = grown;
	struct mnt *m = &f->m[f->nm];
	memset(m, 0, sizeof *m);
	if (mi) {
		m->target = strdup(mi->mp);
		m->root = strdup(mi->root);
	} else {
		/* mount not known: it is taken to show the whole filesystem, under the path that the descriptor has now (what the older helper did) */
		char link[64], p[PATH_MAX];
		snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
		ssize_t n = readlink(link, p, sizeof p - 1);
		m->target = strdup(n > 0 ? (p[n] = 0, p) : arg);
		m->root = strdup("/");
	}
	if (!m->target || !m->root) { free(m->target); free(m->root); return -1; }
	m->tlen = strlen(m->target);
	m->rlen = strlen(m->root);
	if (!m->tlen || !m->rlen) { free(m->target); free(m->root); return -1; }
	m->fd = fd;
	m->arg = arg;
	m->id = id;
	f->nm++;
	return 1;
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

/*
 * An entry whose path is "" says "no mount shows this folder": it is gone (its handle never names another folder), or every given mount was
 * asked and none shows it. Without it each later event in that folder would ask every mount again (a tree removed with 40 binds: about
 * 120 system calls per event). It is dropped with the rest of the cache when a folder is renamed, and a change of the mounts restarts the helper.
 */
static const char *cache_lookup(const unsigned char *key, size_t klen) {
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

/* the path of a known folder, NULL when it is not in the cache or is cached as "no mount shows it" */
static const char *cache_get(const unsigned char *key, size_t klen) {
	const char *p = cache_lookup(key, klen);
	return p && *p ? p : NULL;
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

#define SHOWN 0 /* resolve_open: the place was found */
#define NOT_HERE 1 /* this mount does not show the folder (a final answer for this mount) */
#define TRY_AGAIN (-1) /* an error that may pass (no memory, no descriptor, a race): nothing is cached */
#define GONE (-2) /* the folder is deleted: no mount shows it, and none ever will (its handle never names another folder) */

/*
 * Place in the filesystem ("rel": "/" or a path from the filesystem's top) of the directory a file handle names, found through one mount.
 * Returns SHOWN, NOT_HERE, GONE or TRY_AGAIN. A deleted folder (ESTALE, or a path that ends in " (deleted)") ends the search at once:
 * asking the other mounts gives the same answer.
 */
static int resolve_open(const struct mnt *m, struct file_handle *fh, char *dst, size_t cap) {
	n_opens++;
	int fd = open_by_handle_at(m->fd, fh, O_PATH | O_CLOEXEC);
	if (fd < 0) return errno == ESTALE || errno == ENOENT ? GONE : TRY_AGAIN;
	char link[64], p[PATH_MAX];
	snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
	ssize_t n = readlink(link, p, sizeof p - 1);
	int ret = SHOWN;
	if (n <= 0) ret = TRY_AGAIN;
	else {
		p[n] = 0;
		if (n > 10 && !strcmp(p + n - 10, " (deleted)")) ret = GONE;
	}
	/* the path must lie under the mount point of this mount (a folder outside the mount's root has no path through it) */
	const char *sub = p;
	if (ret == SHOWN && m->tlen > 1) {
		if (strncmp(p, m->target, m->tlen) || (p[m->tlen] != 0 && p[m->tlen] != '/')) ret = NOT_HERE;
		sub = p + m->tlen;
	} else if (ret == SHOWN && !p[1]) sub = p + 1; /* a mount at "/", and its top */
	if (ret == SHOWN && m->rlen > 1) { /* the path must be this very folder */
		struct stat a, b;
		if (fstat(fd, &a) != 0 || stat(p, &b) != 0) ret = TRY_AGAIN;
		else if (a.st_dev != b.st_dev || a.st_ino != b.st_ino) ret = NOT_HERE;
	}
	close(fd);
	if (ret != SHOWN) return ret;
	size_t k = strlen(sub), r = m->rlen == 1 ? 0 : m->rlen;
	if (r + k + 2 > cap) return TRY_AGAIN;
	memcpy(dst, m->root, r);
	memcpy(dst + r, sub, k + 1);
	if (!dst[0]) { dst[0] = '/'; dst[1] = 0; }
	return SHOWN;
}

static int resolve(const int *fsid, struct file_handle *fh, char *dst, size_t cap) {
	if (fh->handle_bytes > FHMAX) return -1;
	int fi = find_fs(fsid);
	if (fi < 0) return -1;
	unsigned char key[KEYMAX];
	size_t klen = key_make(key, fsid, fh);
	const char *hit = cache_lookup(key, klen);
	if (hit) {
		n_hits++;
		size_t n = strlen(hit);
		if (!n || n >= cap) return -1; /* "" is "no mount shows it" */
		memcpy(dst, hit, n + 1);
		return 0;
	}
	n_misses++;
	int shown = 0, gone = 0, again = 0;
	for (int i = 0; i < fss[fi].nm && !shown && !gone; i++) {
		int r = resolve_open(&fss[fi].m[i], fh, dst, cap);
		if (r == SHOWN) shown = 1;
		else if (r == GONE) gone = 1;
		else if (r == TRY_AGAIN) again = 1;
	}
	if (shown) {
		cache_put(key, klen, dst);
		return 0;
	}
	if (gone || !again) cache_put(key, klen, ""); /* final: gone, or every mount said "not here" */
	return -1;
}

/* ---- modify throttle: an entry modified again within THROTTLE_MS is reported once now and once when the second ends ---- */

struct thr {
	uint64_t key;
	long long last;
	long long due; /* when the held report is made (0 = none held) */
	int isdir;
	int fsid[2];
	char *path; /* the entry's place in its filesystem */
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
		emit_vis('M', t->isdir, t->fsid, t->path);
		t->last = now;
		thr_release(t);
	}
}

/* true when this modify is reported now; false when it is held (the report is made later by thr_flush) */
static int thr_modify(uint64_t key, long long now, int isdir, const int *fsid, const char *path) {
	struct thr *t = &thr[key % THR_SLOTS];
	if (t->key == key && t->last && now - t->last < THROTTLE_MS) {
		if (!t->due) {
			t->path = strdup(path);
			if (!t->path) return 1;
			t->isdir = isdir;
			memcpy(t->fsid, fsid, sizeof t->fsid);
			t->due = t->last + THROTTLE_MS;
			npend++;
		}
		return 0;
	}
	if (t->key != key && t->due) { /* another entry takes the slot: its held report is made first */
		emit_vis('M', t->isdir, t->fsid, t->path);
		thr_release(t);
	}
	if (t->due) thr_release(t); /* the window ended: this report takes the held one's place */
	t->key = key;
	t->last = now;
	return 1;
}

/* the entry is about to be renamed: its held modify report is made now, under the old name, before the rename line */
static void thr_emit(uint64_t key) {
	if (!npend) return;
	struct thr *t = &thr[key % THR_SLOTS];
	if (t->key == key && t->due) {
		emit_vis('M', t->isdir, t->fsid, t->path);
		thr_release(t);
	}
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
	const char *rend = (const char *)h + h->len;
	struct fanotify_event_info_fid *f = (void *)h;
	/* the record must hold the fid header, the handle's own header and all the handle bytes before any of them is read */
	if (h->len < sizeof *f + sizeof(struct file_handle)) return;
	struct file_handle *fh = (void *)f->handle;
	if (fh->handle_bytes > FHMAX || (size_t)(rend - (const char *)fh->f_handle) < fh->handle_bytes) return;
	const char *name = NULL;
	if (h->info_type != FAN_EVENT_INFO_TYPE_FID && h->info_type != FAN_EVENT_INFO_TYPE_DFID) {
		const char *n = (const char *)fh->f_handle + fh->handle_bytes;
		if (n < rend) {
			if (!memchr(n, 0, (size_t)(rend - n))) return; /* a name that does not end inside its record is not read */
			name = n;
		}
	}
	r->have = 1;
	r->fh = fh;
	memcpy(r->fsid, &f->fsid, sizeof r->fsid);
	r->name = name;
}

/* Place in its filesystem of the entry a record names: its directory's place and the name ("." and "" mean the directory itself). */
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
		/* events were lost, among them renames of folders: no cached path can be trusted any more */
		cache_clear();
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
			thr_emit(rec_key(&oldr));
			emit_move(isdir, newr.fsid, path, oldr.fsid, old);
		} else if (ok_new) emit_vis('C', isdir, newr.fsid, path); /* moved in from outside what is watched */
		else if (ok_old) emit_vis('D', isdir, oldr.fsid, old);
		else n_unresolved++;
		return;
	}
	if (ev->mask & (FAN_MOVED_FROM | FAN_MOVED_TO)) { /* kernels without FAN_RENAME */
		if (isdir) cache_clear();
		if (rec_path(&dfid, path, sizeof path) < 0) { n_unresolved++; return; }
		emit_vis((ev->mask & FAN_MOVED_FROM) ? 'D' : 'C', isdir, dfid.fsid, path);
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
		emit_vis('D', 1, fid.fsid, seen);
		return;
	}
	/*
	 * The kernel merges queued events of one name into one event with the OR of their masks, so the order is lost. The order of one entry's life is
	 * create, then attribute, modify and close, then delete. When both create and delete are set it can have been either way round
	 * (create ... delete, or delete ... create): the entry as it is now tells which came last.
	 */
	int created = (ev->mask & FAN_CREATE) != 0, deleted = (ev->mask & FAN_DELETE) != 0;
	int delete_first = 0;
	if (created && deleted) {
		struct stat st;
		char here[PATH_MAX];
		delete_first = first_path(dfid.fsid, path, here, sizeof here) == 0 && fstatat(AT_FDCWD, here, &st, AT_SYMLINK_NOFOLLOW) == 0;
	}
	if (delete_first) { thr_done(rec_key(&dfid)); emit_vis('D', isdir, dfid.fsid, path); }
	if (created) {
		emit_vis('C', isdir, dfid.fsid, path);
		/* a new folder: its place is known now, so its first event needs no lookup */
		if (isdir && fid.have && cache_sets) {
			unsigned char key[KEYMAX];
			size_t klen = key_make(key, fid.fsid, fid.fh);
			cache_put(key, klen, path);
		}
	}
	if (ev->mask & FAN_ATTRIB) emit_vis('A', isdir, dfid.fsid, path);
	if (ev->mask & FAN_MODIFY) {
		t = now_ms();
		if (thr_modify(rec_key(&dfid), t, isdir, dfid.fsid, path)) emit_vis('M', isdir, dfid.fsid, path);
	}
	if (ev->mask & FAN_CLOSE_WRITE) {
		thr_done(rec_key(&dfid));
		emit_vis('W', isdir, dfid.fsid, path);
	}
	if (deleted && !delete_first) { thr_done(rec_key(&dfid)); emit_vis('D', isdir, dfid.fsid, path); }
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
	if (!caps_target) fprintf(stderr, "filedeck-fanwatch: no target ids in events (kernel before 5.17): a new folder's path is looked up at its first event, not taken from the create event\n");
	unsigned long long mask = BASE_MASK | FAN_RENAME;
	caps_rename = 1;
	int denied = 0;
	mi_load();
	/* every path becomes one mount of its filesystem (a path given twice, or two paths of one mount, count once) */
	for (int i = 1; i < argc; i++) {
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
		int mid = -1;
		union { struct file_handle fh; char b[sizeof(struct file_handle) + FHMAX]; } mprobe; /* (on the stack: nothing to allocate or free) */
		mprobe.fh.handle_bytes = FHMAX;
		if (name_to_handle_at(mfd, "", &mprobe.fh, &mid, AT_EMPTY_PATH) != 0 && errno != EOVERFLOW) mid = -1;
		int fi = find_fs(fsid);
		if (fi < 0 && nfs < MAXFS) {
			fi = nfs++;
			memcpy(fss[fi].fsid, fsid, sizeof fsid);
		}
		int added = fi < 0 ? -1 : fs_add(&fss[fi], mfd, argv[i], mid);
		if (added < 0) emit('c', 0, argv[i], NULL);
		if (added <= 0) close(mfd);
	}
	int kept = 0;
	for (int i = 0; i < nfs; i++) {
		struct fsrec *f = &fss[i];
		if (!f->nm) continue;
		qsort(f->m, (size_t)f->nm, sizeof *f->m, mnt_cmp);
		/* is a handle of this filesystem openable? (CAP_DAC_READ_SEARCH) */
		union { struct file_handle fh; char b[sizeof(struct file_handle) + FHMAX]; } probe;
		int mount_id;
		probe.fh.handle_bytes = FHMAX;
		if (name_to_handle_at(f->m[0].fd, "", &probe.fh, &mount_id, AT_EMPTY_PATH) == 0) {
			int pfd = open_by_handle_at(f->m[0].fd, &probe.fh, O_PATH | O_CLOEXEC);
			if (pfd >= 0) close(pfd);
			else if (errno == EPERM) denied = 1;
		}
		/* the filesystem is marked once, through the first mount that accepts it (the mount of the whole filesystem when there is one) */
		int marked = 0;
		for (int j = 0; j < f->nm && !marked; j++) {
			long rc = syscall(SYS_fanotify_mark, fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, f->m[j].arg);
			if (rc < 0 && errno == EINVAL && caps_rename) {
				/* no FAN_RENAME (kernel before 5.17): moves are reported as a delete and a create */
				caps_rename = 0;
				mask = (mask & ~(unsigned long long)FAN_RENAME) | FAN_MOVED_FROM | FAN_MOVED_TO;
				fprintf(stderr, "filedeck-fanwatch: no FAN_RENAME: a move is reported as a delete and a create\n");
				rc = syscall(SYS_fanotify_mark, fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, f->m[j].arg);
			}
			if (rc == 0) marked = 1;
			else {
				if (errno == EPERM) denied = 1;
				fprintf(stderr, "filedeck-fanwatch: cannot watch %s: %s\n", f->m[j].arg, strerror(errno));
			}
		}
		if (!marked) {
			for (int j = 0; j < f->nm; j++) {
				emit('c', 0, f->m[j].arg, NULL);
				close(f->m[j].fd);
			}
			continue;
		}
		if (kept != i) fss[kept] = *f;
		kept++;
	}
	nfs = kept;
	mi_free();
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
