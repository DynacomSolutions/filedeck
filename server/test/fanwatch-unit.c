/*
 * Test only (fanwatch-unit.test.ts): feeds hand-made kernel events to the helper's own event code, with no kernel and no capability. The helper's source is
 * included, so the code under test is the shipped code. Folder paths come from the path cache, which the driver fills; nothing calls open_by_handle_at.
 *   fanwatch-unit SCENARIO [DIR]      prints what the helper would write to its output; DIR is a real folder for the scenarios that look at the entry
 */
#ifndef FANWATCH_SRC
#define FANWATCH_SRC "../native/filedeck-fanwatch.c"
#endif
/*
 * open_by_handle_at is replaced here by a fake that no kernel or capability is needed for: a handle that starts "DIRHGONE" is a deleted folder
 * (ESTALE), one that starts "DIRHOUTS" is a folder that no given mount shows (the descriptor is the root folder, whose path is outside every mount
 * of these scenarios), and any other handle is not openable (EBADF: an error that may pass). The calls are counted in `fake_opens`.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
static unsigned long long fake_opens;
static int fake_open_by_handle_at(int mfd, struct file_handle *fh, int flags) {
	(void)mfd;
	fake_opens++;
	if (fh->handle_bytes == 8 && !memcmp(fh->f_handle, "DIRHGONE", 8)) return errno = ESTALE, -1;
	if (fh->handle_bytes == 8 && !memcmp(fh->f_handle, "DIRHOUTS", 8)) return open("/", flags | O_PATH);
	return errno = EBADF, -1;
}
#define open_by_handle_at fake_open_by_handle_at
#define main fanwatch_main
#include FANWATCH_SRC
#undef main

struct R {
	int type;
	const char *name; /* NULL: no name */
	unsigned handle_bytes; /* what the handle header claims */
	unsigned handle_len; /* how many handle bytes the record really holds */
	int no_nul; /* the name has no terminating NUL inside the record */
	int alt; /* which handle: an index into HANDLES (0 = the primed folder) */
};

static const unsigned char DIRH[8] = "DIRHANDL";
static const unsigned char DIRH2[8] = "DIRHAND2";
static const unsigned char *const HANDLES[] = {DIRH, DIRH2, (const unsigned char *)"DIRHGONE", (const unsigned char *)"DIRHOUTS", (const unsigned char *)"DIRHNEWH"};
static int fsid[2] = {1, 2};

static void prime_h(const char *path, const unsigned char *handle) {
	struct { unsigned handle_bytes; int handle_type; unsigned char b[8]; } h = {8, 1, {0}};
	memcpy(h.b, handle, 8);
	unsigned char key[KEYMAX];
	size_t klen = key_make(key, fsid, (struct file_handle *)&h);
	cache_put(key, klen, path);
}
static void prime(const char *path) { prime_h(path, DIRH); }
static void prime2(const char *path) { prime_h(path, DIRH2); }

/* a mount of the one filesystem: where it is and which folder of the filesystem it shows */
static void addm(const char *target, const char *root) {
	struct fsrec *f = &fss[0];
	f->m = realloc(f->m, (size_t)(f->nm + 1) * sizeof *f->m);
	f->m[f->nm] = (struct mnt){strdup(target), strlen(target), strdup(root), strlen(root), 99, target, f->nm};
	f->nm++;
	qsort(f->m, (size_t)f->nm, sizeof *f->m, mnt_cmp);
}

/* one event in a buffer of exactly its size, so a read past its end is a fault under AddressSanitizer */
static void feed(uint64_t mask, int nr, const struct R *r) {
	size_t total = sizeof(struct fanotify_event_metadata);
	size_t rl[8];
	for (int i = 0; i < nr; i++) {
		rl[i] = sizeof(struct fanotify_event_info_fid) + sizeof(struct file_handle) + r[i].handle_len + (r[i].name ? strlen(r[i].name) + (r[i].no_nul ? 0 : 1) : 0);
		total += rl[i];
	}
	unsigned char *buf = malloc(total);
	memset(buf, 0, total);
	struct fanotify_event_metadata *ev = (void *)buf;
	ev->event_len = (unsigned)total;
	ev->vers = FANOTIFY_METADATA_VERSION;
	ev->metadata_len = sizeof *ev;
	ev->mask = mask;
	ev->fd = FAN_NOFD;
	unsigned char *p = buf + sizeof *ev;
	for (int i = 0; i < nr; i++) {
		struct fanotify_event_info_fid *f = (void *)p;
		f->hdr.info_type = (unsigned char)r[i].type;
		f->hdr.len = (unsigned short)rl[i];
		memcpy(&f->fsid, fsid, sizeof fsid);
		struct file_handle *fh = (void *)f->handle;
		fh->handle_bytes = r[i].handle_bytes;
		fh->handle_type = 1;
		memcpy(fh->f_handle, HANDLES[r[i].alt], r[i].handle_len < 8 ? r[i].handle_len : 8);
		if (r[i].name) memcpy((char *)fh->f_handle + r[i].handle_len, r[i].name, strlen(r[i].name) + (r[i].no_nul ? 0 : 1));
		p += rl[i];
	}
	handle(ev);
	free(buf);
}

static void ev1(uint64_t mask, const char *name) {
	struct R r = {FAN_EVENT_INFO_TYPE_DFID_NAME, name, 8, 8, 0};
	feed(mask, 1, &r);
}

int main(int argc, char **argv) {
	if (argc < 2) return 2;
	const char *sc = argv[1];
	const char *dir = argc > 2 ? argv[2] : "/work";
	fss[0].fsid[0] = fsid[0];
	fss[0].fsid[1] = fsid[1];
	nfs = 1;
	caps_rename = caps_target = 1;
	cache_init(1024);
	/* the mounts' fd is 99, not a descriptor: any lookup that is not in the cache fails */
	if (!strncmp(sc, "binds", 5)) {
		/* the mount of the whole filesystem, and two folders of it bound elsewhere, one of them in a folder that sorts before it */
		if (!strcmp(sc, "binds") || !strcmp(sc, "binds-move")) addm("/srv/p", "/");
		if (!strcmp(sc, "binds") || !strncmp(sc, "binds-move", 10)) {
			addm("/h/.archives", "/repositories/.archives");
			addm("/h/.data/o", "/repositories/.data/o");
			addm("/h/.data/o2", "/repositories/.data/o2");
		}
		if (!strcmp(sc, "binds-nobase")) {
			addm("/m/a", "/repositories/.data/a"); /* a bind of a folder */
			addm("/m/ab", "/repositories/.data/a/b"); /* a bind of a folder of that bind */
		}
		if (!strcmp(sc, "binds-top")) { /* a mount at "/" that shows a folder, and one that shows the whole filesystem somewhere else */
			addm("/", "/x");
			addm("/all", "/");
		}
	} else if (!strncmp(sc, "neg-", 4)) {
		if (!strcmp(sc, "neg-gone")) { /* the whole filesystem and two binds */
			addm("/srv/p", "/");
			addm("/h/a", "/x/a");
			addm("/h/b", "/x/b");
		} else { /* three binds, none of the whole filesystem */
			addm("/m/a", "/x/a");
			addm("/m/b", "/x/b");
			addm("/m/c", "/x/c");
		}
	} else addm("/", "/");
	prime(dir);
	uint64_t all = FAN_CREATE | FAN_DELETE | FAN_ATTRIB | FAN_MODIFY | FAN_CLOSE_WRITE;
	if (!strcmp(sc, "merged")) ev1(all, "f"); /* DIR/f exists or not: the caller decides */
	else if (!strcmp(sc, "modify-delete")) ev1(FAN_MODIFY | FAN_CLOSE_WRITE | FAN_DELETE, "f");
	else if (!strcmp(sc, "overflow")) {
		ev1(FAN_CREATE, "a"); /* a hit */
		struct fanotify_event_metadata ov = {0};
		ov.event_len = sizeof ov;
		ov.vers = FANOTIFY_METADATA_VERSION;
		ov.metadata_len = sizeof ov;
		ov.mask = FAN_Q_OVERFLOW;
		ov.fd = FAN_NOFD;
		handle(&ov);
		ev1(FAN_CREATE, "b"); /* a miss now: the cache was dropped, and the lookup fails */
		stats_emit();
	} else if (!strcmp(sc, "rename-held")) {
		ev1(FAN_MODIFY, "a"); /* reported */
		ev1(FAN_MODIFY, "a"); /* held back: inside the second */
		struct R r[2] = {{FAN_EVENT_INFO_TYPE_OLD_DFID_NAME, "a", 8, 8, 0}, {FAN_EVENT_INFO_TYPE_NEW_DFID_NAME, "b", 8, 8, 0}};
		feed(FAN_RENAME, 2, r);
	} else if (!strcmp(sc, "short-handle")) {
		/* the record claims a 64 byte handle and holds 2 */
		struct R r = {FAN_EVENT_INFO_TYPE_DFID_NAME, NULL, 64, 2, 0};
		feed(FAN_CREATE, 1, &r);
		struct R r2 = {FAN_EVENT_INFO_TYPE_OLD_DFID_NAME, NULL, 100, 3, 0};
		feed(FAN_RENAME, 1, &r2);
		ev1(FAN_CREATE, "ok"); /* a good event after the bad ones still works */
	} else if (!strcmp(sc, "name-no-nul")) {
		struct R r = {FAN_EVENT_INFO_TYPE_DFID_NAME, "unterminated", 8, 8, 1};
		feed(FAN_CREATE, 1, &r);
		ev1(FAN_CREATE, "ok");
	} else if (!strncmp(sc, "binds", 5) && strcmp(sc, "binds-move") && strcmp(sc, "binds-move-only")) {
		ev1(FAN_CREATE, "f");
		stats_emit();
	} else if (!strcmp(sc, "binds-move") || !strcmp(sc, "binds-move-only")) {
		/* DIR (argv 2) holds the old name, DIR2 (argv 3) the new one */
		prime2(argc > 3 ? argv[3] : dir);
		struct R r[2] = {{FAN_EVENT_INFO_TYPE_OLD_DFID_NAME, "f", 8, 8, 0, 0}, {FAN_EVENT_INFO_TYPE_NEW_DFID_NAME, "g", 8, 8, 0, 1}};
		feed(FAN_RENAME, 2, r);
		stats_emit();
	} else if (!strncmp(sc, "neg-", 4)) {
		/* two events in one folder whose handle is: gone (neg-gone), outside every mount (neg-outside, then an overflow and a third event), or not openable (neg-transient) */
		int alt = !strcmp(sc, "neg-gone") ? 2 : !strcmp(sc, "neg-outside") ? 3 : 4;
		struct R r = {FAN_EVENT_INFO_TYPE_DFID_NAME, "f", 8, 8, 0, alt};
		feed(FAN_CREATE, 1, &r);
		feed(FAN_CREATE, 1, &r);
		if (!strcmp(sc, "neg-outside")) {
			struct fanotify_event_metadata ov = {0};
			ov.event_len = sizeof ov;
			ov.vers = FANOTIFY_METADATA_VERSION;
			ov.metadata_len = sizeof ov;
			ov.mask = FAN_Q_OVERFLOW;
			ov.fd = FAN_NOFD;
			handle(&ov); /* the cache is dropped: the folder is asked about again */
			feed(FAN_CREATE, 1, &r);
		}
		stats_emit();
		out_flush();
		printf("calls=%llu\n", fake_opens);
		return 0;
	} else return 2;
	out_flush();
	return 0;
}
