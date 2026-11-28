/*
 * filedeck-iotrace: attributes block IO to a disk, a cgroup and a process with eBPF, at very low cost.
 *
 *   filedeck-iotrace      no options; it reads commands on stdin
 *
 * A BPF program (filedeck-iotrace.bpf.c) counts every read and write request that is sent to a disk, in one bounded hash map in the kernel.
 * The helper has no timer. It waits on stdin. For each line "read" it reads and clears the map, sorts the rows and prints ONE line on stdout. It
 * prints nothing else, it writes no file and it sees no single event. The cost is the BPF program per request (a hash update) and one map read
 * per command. The caller decides when to read: on a request, for a live subscriber, or on a pressure event (see server/src/iotrace.ts).
 *
 * Output (stdout, one JSON line per "read", deltas since the previous read, the 512 rows with the most requests, busiest first):
 *   {"t":<ms since the epoch>,"ok":true,"rows":[{"dev":"259:0","cg":<cgroup v2 id>,"pid":<tgid>,"comm":"postgres","r":<reads>,"w":<writes>,"rb":<bytes read>,"wb":<bytes written>}]}
 * dev is the whole disk as major:minor. cg is the cgroup v2 id, which is the inode number of the cgroup folder. pid is the thread group id. comm is
 * the task name at the first request since the previous read. Rows are not given when there were no requests ("rows":[]).
 *   {"ok":false,"error":"..."}   printed once when the helper cannot start (no capability, no BTF, the program does not load) or stops on an error,
 *                                then the exit status is 3. The collector then uses its fallback.
 *
 * Needs: Linux 5.8 or newer with BTF (/sys/kernel/btf/vmlinux, CONFIG_DEBUG_INFO_BTF), cgroup v2 for the cgroup ids, and either CAP_SYS_ADMIN or
 * CAP_BPF with CAP_PERFMON (the bpf() call also has to be allowed by the container's seccomp profile). The tracepoint is attached as a BTF
 * tracepoint, so tracefs need not be mounted. Before 5.11 the kernel may also need CAP_SYS_RESOURCE (locked memory); the helper raises the limit
 * when it can.
 *
 * Build: clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -c filedeck-iotrace.bpf.c -o filedeck-iotrace.bpf.o, then
 *        cc -O2 -DIOTRACE_BPF_OBJ='"filedeck-iotrace.bpf.o"' -o filedeck-iotrace filedeck-iotrace.c -lbpf -lelf -lz   (add -static and -lzstd for a static program)
 * The BPF object is embedded in the program, so the program is one file. See server/scripts/build-native.mjs and the Dockerfile.
 *
 * Exit status: 0 on SIGTERM, SIGINT, a closed stdin or a closed stdout, 1 usage error, 3 not supported or not permitted (the line above is printed first).
 */
#define _GNU_SOURCE
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_ROWS 512
#define MAP_ENTRIES 16384 /* the same as IOTRACE_MAX_ENTRIES in the BPF program */
#define EXIT_UNSUPPORTED 3

struct iokey {
	uint64_t cg;
	uint32_t dev;
	uint32_t pid;
};
struct ioval {
	uint64_t r, w, rb, wb;
	char comm[16];
};
struct row {
	struct iokey key;
	struct ioval val;
};

#ifndef IOTRACE_UNIT
#ifndef IOTRACE_BPF_OBJ
#error "build with -DIOTRACE_BPF_OBJ='\"path/to/filedeck-iotrace.bpf.o\"'"
#endif
__asm__(".section .rodata\n.balign 8\n.global iotrace_obj_start\niotrace_obj_start:\n.incbin \"" IOTRACE_BPF_OBJ "\"\n"
        ".global iotrace_obj_end\niotrace_obj_end:\n.byte 0\n.previous\n");
extern const char iotrace_obj_start[], iotrace_obj_end[];
#endif

/* ---- output: building the JSON line ---- */

struct out {
	char *p;
	size_t len, cap;
};
static void out_put(struct out *o, const char *s, size_t n) {
	if (o->len + n + 1 > o->cap) n = o->cap > o->len + 1 ? o->cap - o->len - 1 : 0; /* never past the buffer; the buffers are sized for the worst case */
	memcpy(o->p + o->len, s, n);
	o->len += n;
	o->p[o->len] = 0;
}
static void out_printf(struct out *o, const char *fmt, ...) {
	char tmp[256];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
	va_end(ap);
	if (n > 0) out_put(o, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}
/* A JSON string: " and \ escaped, a byte below 0x20 or 0x7f as \u00XX, a byte of 0x80 or more as "?" (a task name is raw bytes, the line must be valid UTF-8). */
static void out_str(struct out *o, const char *s, size_t max) {
	out_put(o, "\"", 1);
	for (size_t i = 0; i < max && s[i]; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == '"' || c == '\\') {
			char e[2] = {'\\', (char)c};
			out_put(o, e, 2);
		} else if (c < 0x20 || c == 0x7f) {
			out_printf(o, "\\u%04x", c);
		} else if (c >= 0x80) {
			out_put(o, "?", 1);
		} else {
			out_put(o, (const char *)&c, 1);
		}
	}
	out_put(o, "\"", 1);
}
#define LINE_CAP (MAX_ROWS * 320 + 256) /* a row is at most about 290 bytes */

/* Busiest first: requests, then bytes, then the key (so that the same input always gives the same line). */
static int row_cmp(const void *pa, const void *pb) {
	const struct row *a = pa, *b = pb;
	uint64_t ia = a->val.r + a->val.w, ib = b->val.r + b->val.w;
	if (ia != ib) return ia < ib ? 1 : -1;
	uint64_t ba = a->val.rb + a->val.wb, bb = b->val.rb + b->val.wb;
	if (ba != bb) return ba < bb ? 1 : -1;
	if (a->key.cg != b->key.cg) return a->key.cg < b->key.cg ? -1 : 1;
	if (a->key.dev != b->key.dev) return a->key.dev < b->key.dev ? -1 : 1;
	if (a->key.pid != b->key.pid) return a->key.pid < b->key.pid ? -1 : 1;
	return 0;
}

/* Sorts the rows and writes the line for the first MAX_ROWS of them into `o` (with the final newline). */
static void format_line(struct out *o, long long now_ms, struct row *rows, size_t n) {
	qsort(rows, n, sizeof *rows, row_cmp);
	if (n > MAX_ROWS) n = MAX_ROWS;
	out_printf(o, "{\"t\":%lld,\"ok\":true,\"rows\":[", now_ms);
	for (size_t i = 0; i < n; i++) {
		const struct row *r = &rows[i];
		out_printf(o, "%s{\"dev\":\"%u:%u\",\"cg\":%llu,\"pid\":%u,\"comm\":", i ? "," : "", r->key.dev >> 20, r->key.dev & 0xfffff, (unsigned long long)r->key.cg, r->key.pid);
		out_str(o, r->val.comm, sizeof r->val.comm);
		out_printf(o, ",\"r\":%llu,\"w\":%llu,\"rb\":%llu,\"wb\":%llu}", (unsigned long long)r->val.r, (unsigned long long)r->val.w, (unsigned long long)r->val.rb, (unsigned long long)r->val.wb);
	}
	out_put(o, "]}\n", 3);
}

static void format_error(struct out *o, const char *msg) {
	out_put(o, "{\"ok\":false,\"error\":", 20);
	out_str(o, msg, 400);
	out_put(o, "}\n", 2);
}

/* ---- startup checks ---- */

#define CAP_SYS_ADMIN_BIT 21
#define CAP_PERFMON_BIT 38
#define CAP_BPF_BIT 39
/* The effective capability mask from the hex of the CapEff line of /proc/self/status. */
static int caps_allow_bpf(unsigned long long eff) {
	int admin = (eff >> CAP_SYS_ADMIN_BIT) & 1, bpf = (eff >> CAP_BPF_BIT) & 1, perf = (eff >> CAP_PERFMON_BIT) & 1;
	return admin || (bpf && perf);
}
static int read_cap_eff(unsigned long long *eff) {
	FILE *f = fopen("/proc/self/status", "re");
	if (!f) return -1;
	char line[256];
	int found = -1;
	while (fgets(line, sizeof line, f))
		if (!strncmp(line, "CapEff:", 7)) {
			*eff = strtoull(line + 7, NULL, 16);
			found = 0;
			break;
		}
	fclose(f);
	return found;
}

/* ---- loading ---- */

static char lib_msg[300]; /* the first warning that libbpf printed during the current attempt (the verifier or the loader says why) */
static int lib_print(enum libbpf_print_level level, const char *fmt, va_list ap) {
	if (level != LIBBPF_WARN || lib_msg[0]) return 0;
	char tmp[300];
	vsnprintf(tmp, sizeof tmp, fmt, ap);
	tmp[strcspn(tmp, "\n")] = 0;
	const char *msg = strncmp(tmp, "libbpf: ", 8) ? tmp : tmp + 8;
	snprintf(lib_msg, sizeof lib_msg, "%s", msg);
	return 0;
}

struct tracer {
	struct bpf_object *obj;
	struct bpf_link *link;
	int map_fd;
	int delete_mode; /* 0 = lookup_and_delete (Linux 5.14 and newer for hash maps), 1 = lookup then delete */
};

#ifndef IOTRACE_UNIT
/* The programs, in the order they are tried: the arguments of block_rq_issue changed in Linux 5.11. */
static const char *const candidates[] = {"on_rq_issue", "on_rq_issue_old"};

static int tracer_open(struct tracer *t, char *err, size_t errlen) {
	size_t objlen = (size_t)(iotrace_obj_end - iotrace_obj_start);
	snprintf(err, errlen, "no program could be loaded");
	for (size_t c = 0; c < sizeof candidates / sizeof *candidates; c++) {
		lib_msg[0] = 0;
		LIBBPF_OPTS(bpf_object_open_opts, opts, .object_name = "filedeck_iotrace");
		struct bpf_object *obj = bpf_object__open_mem(iotrace_obj_start, objlen, &opts);
		if (!obj) {
			snprintf(err, errlen, "cannot read the embedded BPF object: %s", strerror(errno));
			return -1;
		}
		struct bpf_program *prog = NULL, *p;
		bpf_object__for_each_program(p, obj) {
			int want = !strcmp(bpf_program__name(p), candidates[c]);
			bpf_program__set_autoload(p, want);
			if (want) prog = p;
		}
		int e = prog ? bpf_object__load(obj) : -ENOENT;
		struct bpf_link *link = NULL;
		if (!e) {
			link = bpf_program__attach(prog);
			e = libbpf_get_error(link);
			if (e) link = NULL;
		}
		if (!e) {
			t->obj = obj;
			t->link = link;
			t->map_fd = bpf_map__fd(bpf_object__find_map_by_name(obj, "agg"));
			return 0;
		}
		snprintf(err, errlen, "cannot load the BPF program %s: %s%s%s", candidates[c], strerror(e < 0 ? -e : e), lib_msg[0] ? ": " : "", lib_msg);
		bpf_object__close(obj);
	}
	return -1;
}
#endif

/* Reads and clears the map: appends the rows to `rows` (capacity `cap`), returns how many. */
static size_t tracer_collect(struct tracer *t, struct row *rows, size_t cap, int *err) {
	static struct iokey keys[MAP_ENTRIES * 2];
	size_t nk = 0;
	struct iokey cur, next;
	int rc = bpf_map_get_next_key(t->map_fd, NULL, &next);
	while (!rc && nk < sizeof keys / sizeof *keys) {
		keys[nk++] = next;
		cur = next;
		rc = bpf_map_get_next_key(t->map_fd, &cur, &next);
	}
	if (rc && errno != ENOENT) {
		*err = errno;
		return 0;
	}
	size_t n = 0;
	for (size_t i = 0; i < nk && n < cap; i++) {
		struct ioval v;
		int got = -1;
		if (t->delete_mode == 0) {
			got = bpf_map_lookup_and_delete_elem(t->map_fd, &keys[i], &v);
			if (got && (errno == EINVAL || errno == ENOTSUP || errno == EOPNOTSUPP || errno == ENOSYS)) t->delete_mode = 1;
		}
		if (t->delete_mode == 1) {
			got = bpf_map_lookup_elem(t->map_fd, &keys[i], &v);
			if (!got) bpf_map_delete_elem(t->map_fd, &keys[i]); /* a request counted between the two calls is lost: at most a few on a very old kernel */
		}
		if (got) continue; /* the entry was evicted since the key scan */
		if (!v.r && !v.w) continue;
		rows[n].key = keys[i];
		rows[n].val = v;
		n++;
	}
	return n;
}

/* ---- main loop ---- */

static volatile sig_atomic_t stop;
static void on_signal(int s) {
	(void)s;
	stop = 1;
}

static int write_all(const char *buf, size_t len) {
	while (len) {
		ssize_t w = write(STDOUT_FILENO, buf, len);
		if (w < 0) {
			if (errno == EINTR) continue;
			return -1; /* EPIPE and any other error: stdout is gone */
		}
		buf += w;
		len -= (size_t)w;
	}
	return 0;
}

static int fail(const char *msg) {
	char buf[1024];
	struct out o = {buf, 0, sizeof buf};
	format_error(&o, msg);
	write_all(buf, o.len);
	return EXIT_UNSUPPORTED;
}

static long long wall_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

#ifndef IOTRACE_UNIT
/* Reads one command line from stdin. Returns 1 for "read", 0 at end of input or on a signal, -1 for an unknown command. No timer: it blocks in read(). */
static int next_command(void) {
	static char buf[64];
	static size_t len;
	for (;;) {
		char *nl = memchr(buf, '\n', len);
		if (nl) {
			size_t n = (size_t)(nl - buf);
			int ok = n == 4 && !memcmp(buf, "read", 4);
			memmove(buf, nl + 1, len - n - 1);
			len -= n + 1;
			return ok ? 1 : -1;
		}
		if (len == sizeof buf) return -1; /* a line that is too long is not a command */
		if (stop) return 0;
		ssize_t r = read(STDIN_FILENO, buf + len, sizeof buf - len);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) return 0;
		len += (size_t)r;
	}
}

int main(int argc, char **argv) {
	(void)argv;
	if (argc > 1) {
		fprintf(stderr, "usage: filedeck-iotrace   (reads the command \"read\" on stdin, one line per command)\n");
		return 1;
	}
	signal(SIGPIPE, SIG_IGN);
	struct sigaction sa = {.sa_handler = on_signal}; /* no SA_RESTART: a signal ends the wait for a command */
	sigemptyset(&sa.sa_mask);
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);

	unsigned long long eff = 0;
	if (read_cap_eff(&eff) == 0 && !caps_allow_bpf(eff)) return fail("not permitted: needs CAP_BPF and CAP_PERFMON (or CAP_SYS_ADMIN)");
	const char *btf = getenv("FILEDECK_IOTRACE_BTF");
	if (access(btf && *btf ? btf : "/sys/kernel/btf/vmlinux", R_OK) != 0) return fail("not supported: the kernel has no BTF (/sys/kernel/btf/vmlinux)");

	struct rlimit rl = {RLIM_INFINITY, RLIM_INFINITY};
	setrlimit(RLIMIT_MEMLOCK, &rl); /* Linux before 5.11 counts BPF memory as locked memory; failing here is fine on a newer kernel */
	libbpf_set_print(lib_print);

	struct tracer t = {0};
	char err[400];
	if (tracer_open(&t, err, sizeof err) != 0) return fail(err);

	static struct row rows[MAP_ENTRIES * 2];
	static char line[LINE_CAP];
	int status = 0;
	int cmd;
	while (!stop && (cmd = next_command()) != 0) {
		if (cmd < 0) {
			status = fail("unknown command: send \"read\"");
			break;
		}
		int e = 0;
		size_t n = tracer_collect(&t, rows, sizeof rows / sizeof *rows, &e);
		if (e) {
			snprintf(err, sizeof err, "cannot read the BPF map: %s", strerror(e));
			status = fail(err);
			break;
		}
		struct out o = {line, 0, sizeof line};
		format_line(&o, wall_ms(), rows, n);
		if (write_all(line, o.len) != 0) break; /* stdout closed: the reader is gone */
	}
	bpf_link__destroy(t.link);
	bpf_object__close(t.obj);
	return status;
}
#endif
