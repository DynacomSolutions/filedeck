/*
 * Test only (fanwatch-unit.test.ts): feeds hand-made kernel events to the helper's own event code, with no kernel and no capability. The helper's source is
 * included, so the code under test is the shipped code. Folder paths come from the path cache, which the driver fills; nothing calls open_by_handle_at.
 *   fanwatch-unit SCENARIO [DIR]      prints what the helper would write to its output; DIR is a real folder for the scenarios that look at the entry
 */
#ifndef FANWATCH_SRC
#define FANWATCH_SRC "../native/filedeck-fanwatch.c"
#endif
#define main fanwatch_main
#include FANWATCH_SRC
#undef main

struct R {
	int type;
	const char *name; /* NULL: no name */
	unsigned handle_bytes; /* what the handle header claims */
	unsigned handle_len; /* how many handle bytes the record really holds */
	int no_nul; /* the name has no terminating NUL inside the record */
};

static const unsigned char DIRH[8] = "DIRHANDL";
static int fsid[2] = {1, 2};

static void prime(const char *path) {
	struct { unsigned handle_bytes; int handle_type; unsigned char b[8]; } h = {8, 1, {0}};
	memcpy(h.b, DIRH, 8);
	unsigned char key[KEYMAX];
	size_t klen = key_make(key, fsid, (struct file_handle *)&h);
	cache_put(key, klen, path);
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
		memcpy(fh->f_handle, DIRH, r[i].handle_len < 8 ? r[i].handle_len : 8);
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
	fss[0].fd = 99; /* not a descriptor: any lookup that is not in the cache fails */
	nfs = 1;
	caps_rename = caps_target = 1;
	cache_init(1024);
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
	} else return 2;
	out_flush();
	return 0;
}
