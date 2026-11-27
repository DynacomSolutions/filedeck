/*
 * Test only: an open_by_handle_at that works in an unprivileged user namespace (where the kernel refuses the real one). It finds the folder whose handle
 * matches by walking the tree under FILEDECK_SHIM_ROOT (folders only, no stat of files) and keeps what it found, checking an entry again before it is used.
 * Build: cc -shared -fPIC -o shim.so fanwatch-shim.c -ldl; use: LD_PRELOAD=shim.so FILEDECK_SHIM_ROOT=/folder helper ...
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct ent {
	char *path;
	unsigned char bytes[128];
	unsigned n;
	int type;
};
static struct ent *tab;
static size_t ntab, captab;

static int handle_of(const char *path, struct ent *e) {
	char buf[sizeof(struct file_handle) + 128];
	struct file_handle *h = (void *)buf;
	int mid;
	h->handle_bytes = 128;
	if (name_to_handle_at(AT_FDCWD, path, h, &mid, 0) != 0) return -1;
	e->n = h->handle_bytes;
	e->type = h->handle_type;
	memcpy(e->bytes, h->f_handle, h->handle_bytes);
	return 0;
}

static void add(const char *path) {
	if (ntab == captab) {
		captab = captab ? captab * 2 : 256;
		tab = realloc(tab, captab * sizeof *tab);
	}
	struct ent *e = &tab[ntab];
	if (handle_of(path, e) != 0) return;
	e->path = strdup(path);
	ntab++;
}

static void walk(const char *dir) {
	add(dir);
	DIR *d = opendir(dir);
	if (!d) return;
	struct dirent *de;
	while ((de = readdir(d))) {
		if (de->d_type != DT_DIR || !strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
		char *p;
		if (asprintf(&p, "%s/%s", dir, de->d_name) < 0) continue;
		walk(p);
		free(p);
	}
	closedir(d);
}

static void rebuild(const char *root) {
	for (size_t i = 0; i < ntab; i++) free(tab[i].path);
	ntab = 0;
	walk(root);
}

static const char *find(const struct file_handle *h) {
	for (size_t i = 0; i < ntab; i++)
		if (tab[i].n == h->handle_bytes && tab[i].type == h->handle_type && !memcmp(tab[i].bytes, h->f_handle, h->handle_bytes)) {
			struct ent now;
			if (handle_of(tab[i].path, &now) == 0 && now.n == tab[i].n && !memcmp(now.bytes, tab[i].bytes, now.n)) return tab[i].path;
			return NULL; /* the entry is out of date */
		}
	return NULL;
}

int open_by_handle_at(int mfd, struct file_handle *h, int flags) {
	(void)mfd;
	(void)flags;
	const char *root = getenv("FILEDECK_SHIM_ROOT");
	if (!root) {
		errno = EPERM;
		return -1;
	}
	const char *p = find(h);
	if (!p) {
		rebuild(root);
		p = find(h);
	}
	if (!p) {
		errno = ESTALE;
		return -1;
	}
	return open(p, O_PATH | O_CLOEXEC);
}
