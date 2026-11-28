/*
 * filedeck-holders: tells the agent every event by which a process comes to hold a file or a folder, with eBPF. See filedeck-holders.bpf.c for the
 * hooks and filedeck-holders.h for the records.
 *
 *   filedeck-holders [--ring-mb N] [--ignore PID]      N = 1, 2, 4 ... 256 (default 16); the pid is the agent (default: the parent)
 *
 * It attaches the programs, reads each process once with the BPF iterators (the "seed": one pass, no timer), then copies every record of the ring
 * buffer to stdout, in order. It never writes a file. Nothing is sent for the processes named with --ignore (the agent) and for the helper itself.
 *
 * stdin takes commands, one per line:
 *   snap PID      read the facts of one process again with the iterators. The answer is the records SNAPBEG, SFD/SCWD/SROOT/SEXE/SMMAP..., SNAPEND for that pid
 *                 on stdout. The agent asks for this when events of a pid may have been lost.
 *   seed          read every process again (the agent asks for this when events of unknown pids were lost). The answer ends with SEEDEND.
 *   sync N        a barrier. The helper copies every record that the ring holds, reads the `dirty` map and the skipped program runs (recursion_misses),
 *                 writes the DIRTY records that they give, and then writes one SYNC record with aux = N. A process that made an event before the agent
 *                 sent `sync` has its record, or a DIRTY record, before the SYNC record. The agent answers a question only after that reply.
 * A closed stdin ends the helper.
 *
 * Lost events. When the ring is full the program puts the pid in the `dirty` map and counts a drop. After each batch this loader reads that map, empties
 * it and writes a DIRTY record per pid (pid 0 = events of unknown pids were lost: all of them; the programs put pid 0 there when a FORK or MOVED record
 * is lost). The same record is written when the kernel skipped a program run because the same program was already running on that CPU
 * (recursion_misses of the programs, read after a batch when the ring dropped something, and at every `sync`).
 *
 * Output: records only (see filedeck-holders.h). A start failure is one line {"ok":false,"error":"..."} instead, and exit status 3 (not supported or not
 * permitted). Needs: Linux 5.14 or newer with BTF (iterators and fentry), CAP_BPF and CAP_PERFMON (or CAP_SYS_ADMIN), and the host pid namespace (the pids
 * of the events are host pids, and the iterators and the pass over /proc must name the same ones).
 *
 * Build: clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -c filedeck-holders.bpf.c -o filedeck-holders.bpf.o, then
 *        cc -O2 -DHOLDERS_BPF_OBJ='"filedeck-holders.bpf.o"' -o filedeck-holders filedeck-holders.c -lbpf -lelf -lz   (add -static and -lzstd for a static program)
 * The BPF object is embedded in the program. See server/scripts/build-native.mjs and the Dockerfile.
 *
 * Exit status: 0 on SIGTERM, SIGINT, a closed stdin or a closed stdout, 1 usage error, 3 not supported or not permitted.
 */
#define _GNU_SOURCE
#include <bpf/bpf.h>
#include <bpf/btf.h>
#include <bpf/libbpf.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/bpf.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#include "filedeck-holders.h"

#define EXIT_UNSUPPORTED 3
#define OUT_CAP (256 * 1024)
#define OUT_FLUSH (192 * 1024)
#define HF_ERROR 8u /* SNAPEND: the process could not be read */

#ifndef HOLDERS_BPF_OBJ
#error "build with -DHOLDERS_BPF_OBJ='\"path/to/filedeck-holders.bpf.o\"'"
#endif
__asm__(".section .rodata\n.balign 8\n.global holders_obj_start\nholders_obj_start:\n.incbin \"" HOLDERS_BPF_OBJ "\"\n"
        ".global holders_obj_end\nholders_obj_end:\n.byte 0\n.previous\n");
extern const char holders_obj_start[], holders_obj_end[];

/* ---- output ---- */

static char out_buf[OUT_CAP];
static size_t out_len;
static int out_failed;

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
static void flush_out(void) {
	if (out_len && !out_failed && write_all(out_buf, out_len) != 0) out_failed = 1;
	out_len = 0;
}
static void put(const void *rec, size_t len) {
	if (out_len + len > OUT_CAP) flush_out();
	memcpy(out_buf + out_len, rec, len);
	out_len += len;
	if (out_len >= OUT_FLUSH) flush_out();
}
static void put_simple(uint16_t type, uint32_t pid, uint32_t aux, uint32_t flags, uint64_t ino, const uint64_t *chain, uint16_t n, const char *comm) {
	struct holders_rec r;
	memset(&r, 0, HOLDERS_HDR_BYTES);
	r.len = HOLDERS_HDR_BYTES + n * 8;
	r.type = type;
	r.nchain = n;
	r.pid = pid;
	r.aux = aux;
	r.flags = flags;
	r.ino = ino;
	if (comm) strncpy(r.comm, comm, sizeof r.comm - 1);
	if (n) memcpy(r.chain, chain, n * 8);
	put(&r, r.len);
}

static int fail(const char *msg) {
	char buf[1024];
	int n = snprintf(buf, sizeof buf, "{\"ok\":false,\"error\":\"");
	for (const char *p = msg; *p && n < (int)sizeof buf - 8; p++) {
		unsigned char c = (unsigned char)*p;
		if (c == '"' || c == '\\') buf[n++] = '\\', buf[n++] = (char)c;
		else if (c < 0x20 || c >= 0x7f) buf[n++] = '?';
		else buf[n++] = (char)c;
	}
	n += snprintf(buf + n, sizeof buf - (size_t)n, "\"}\n");
	write_all(buf, (size_t)n);
	return EXIT_UNSUPPORTED;
}

/* ---- startup checks ---- */

#define CAP_SYS_ADMIN_BIT 21
#define CAP_PERFMON_BIT 38
#define CAP_BPF_BIT 39

static int read_status(unsigned long long *eff, int *nspid_fields) {
	FILE *f = fopen("/proc/self/status", "re");
	if (!f) return -1;
	char line[512];
	*eff = 0;
	*nspid_fields = 1;
	while (fgets(line, sizeof line, f)) {
		if (!strncmp(line, "CapEff:", 7)) *eff = strtoull(line + 7, NULL, 16);
		else if (!strncmp(line, "NSpid:", 6)) {
			int n = 0;
			for (char *p = line + 6, *t; (t = strtok(p, " \t\n")); p = NULL) n++;
			*nspid_fields = n;
		}
	}
	fclose(f);
	return 0;
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

/* Programs that the agent can run without: the table then says that it is not complete (HELLO.aux bit). The order is the order of the bits, and of
 * SOFT_HOOKS in server/src/holders.ts. The two 32-bit calls are not loaded (and not counted) where the kernel has no 32-bit emulation. */
static const char *const SOFT[] = {"h_dup3", "h_dup2", "h_rename", "h_chroot_fs_refs", "h_replace_fd", "h_scm_send", "h_ia32_dup3", "h_ia32_dup2", "h_uring_register"};
#define NSOFT (sizeof SOFT / sizeof *SOFT)
static const char *const ITERS[] = {"snap_files", "snap_vmas", "snap_tasks"};
#define NITER 3

struct tracer {
	struct bpf_object *obj;
	struct bpf_link *links[32];
	int nlinks;
	struct bpf_program *iter[NITER];
	int rb_fd, cfg_fd, stats_fd, dirty_fd;
	int prog_fds[32];
	int nprogs;
	unsigned soft_failed; /* bit i = SOFT[i] is not loaded */
	size_t ring_bytes;
	int ncpu;
};

static unsigned absent_soft; /* bit i = SOFT[i] has no function in this kernel: it is not needed */

/* Does the kernel have this function (in its BTF)? Where that cannot be told, yes. */
static int kernel_has_func(const char *name) {
	struct btf *b = btf__load_vmlinux_btf();
	if (!b) return 1;
	int id = btf__find_by_name_kind(b, name, BTF_KIND_FUNC);
	btf__free(b);
	return id >= 0 || id == -EINVAL;
}

static int is_soft(const char *name) {
	for (size_t i = 0; i < NSOFT; i++)
		if (!strcmp(name, SOFT[i])) return (int)i;
	return -1;
}

/* One attempt: open the object, load it without the soft programs of `off`, attach the ones that are not iterators. Returns 0 or a negative errno (lib_msg says why). */
static int try_load(struct tracer *t, unsigned off) {
	size_t objlen = (size_t)(holders_obj_end - holders_obj_start);
	lib_msg[0] = 0;
	LIBBPF_OPTS(bpf_object_open_opts, opts, .object_name = "filedeck_holders");
	struct bpf_object *obj = bpf_object__open_mem(holders_obj_start, objlen, &opts);
	if (!obj) return -errno;
	struct bpf_map *rb = bpf_object__find_map_by_name(obj, "rb");
	if (!rb) {
		bpf_object__close(obj);
		return -ENOENT;
	}
	bpf_map__set_max_entries(rb, (uint32_t)t->ring_bytes);
	struct bpf_program *p;
	bpf_object__for_each_program(p, obj) {
		int s = is_soft(bpf_program__name(p));
		if (s >= 0 && ((off | absent_soft) >> s & 1)) bpf_program__set_autoload(p, false);
	}
	int e = bpf_object__load(obj);
	if (e) {
		bpf_object__close(obj);
		return e;
	}
	t->obj = obj;
	t->nlinks = 0;
	t->nprogs = 0;
	bpf_object__for_each_program(p, obj) {
		if (!bpf_program__autoload(p)) continue;
		const char *name = bpf_program__name(p);
		int is_iter = 0;
		for (int i = 0; i < NITER; i++)
			if (!strcmp(name, ITERS[i])) {
				t->iter[i] = p;
				is_iter = 1;
			}
		if (t->nprogs < 32) t->prog_fds[t->nprogs++] = bpf_program__fd(p);
		if (is_iter) continue;
		struct bpf_link *l = bpf_program__attach(p);
		e = libbpf_get_error(l);
		if (e) {
			char tmp[300];
			snprintf(tmp, sizeof tmp, "cannot attach %s: %s", name, strerror(e < 0 ? -e : e));
			if (!lib_msg[0]) snprintf(lib_msg, sizeof lib_msg, "%s", tmp);
			for (int i = 0; i < t->nlinks; i++) bpf_link__destroy(t->links[i]);
			t->nlinks = 0;
			bpf_object__close(obj);
			t->obj = NULL;
			return e;
		}
		if (t->nlinks < 32) t->links[t->nlinks++] = l;
	}
	t->soft_failed = off;
	return 0;
}

static int tracer_open(struct tracer *t, char *err, size_t errlen) {
	/* with every soft program first, then with fewer, until a combination loads; the message is the one of the first try (the most complete set) */
	snprintf(err, errlen, "no program could be loaded");
	int first = 1;
	for (int off_count = 0; off_count <= (int)NSOFT; off_count++) {
		for (unsigned off = 0; off < (1u << NSOFT); off++) {
			if (__builtin_popcount(off) != off_count || (off & absent_soft)) continue;
			int e = try_load(t, off);
			if (!e) return 0;
			if (first) snprintf(err, errlen, "cannot load the BPF programs: %s%s%s", strerror(e < 0 ? -e : e), lib_msg[0] ? ": " : "", lib_msg);
			first = 0;
		}
	}
	return -1;
}

static uint64_t stat_sum(int fd, uint32_t key, int ncpu) {
	uint64_t vals[512];
	if (ncpu > 512) ncpu = 512;
	if (bpf_map_lookup_elem(fd, &key, vals) != 0) return 0;
	uint64_t sum = 0;
	for (int i = 0; i < ncpu; i++) sum += vals[i];
	return sum;
}

/* ---- snapshots ---- */

static struct ring_buffer *rb;

static int rb_cb(void *ctx, void *data, size_t size) {
	(void)ctx;
	put(data, size);
	return 0;
}
static void drain(void) {
	if (rb) ring_buffer__consume(rb);
}

/* Reads one process with the three iterators. Returns 0, or -ENOENT when the process is gone, or another negative errno. */
static int snapshot_pid(struct tracer *t, uint32_t pid) {
	int status = 0;
	for (int i = 0; i < NITER; i++) {
		union bpf_iter_link_info linfo;
		memset(&linfo, 0, sizeof linfo);
		linfo.task.pid = pid;
		LIBBPF_OPTS(bpf_iter_attach_opts, opts, .link_info = &linfo, .link_info_len = sizeof linfo);
		struct bpf_link *l = bpf_program__attach_iter(t->iter[i], &opts);
		int e = libbpf_get_error(l);
		if (e) return e < 0 ? e : -e;
		int fd = bpf_iter_create(bpf_link__fd(l));
		if (fd < 0) {
			status = -errno;
			bpf_link__destroy(l);
			return status;
		}
		char sink[4096];
		for (;;) {
			ssize_t n = read(fd, sink, sizeof sink);
			if (n > 0) continue;
			if (n < 0 && errno == EINTR) continue;
			if (n < 0 && errno != ENOENT && errno != ESRCH) status = -errno;
			break;
		}
		close(fd);
		bpf_link__destroy(l);
		drain();
	}
	return status;
}

static void snapshot(struct tracer *t, uint32_t pid, uint32_t req) {
	drain();
	put_simple(HT_SNAPBEG, pid, req, 0, 0, NULL, 0, NULL);
	int e = snapshot_pid(t, pid);
	drain();
	uint32_t flags = 0;
	if (e == -ENOENT || e == -ESRCH) flags = HF_VANISHED;
	else if (e) flags = HF_ERROR;
	put_simple(HT_SNAPEND, pid, req, flags, 0, NULL, 0, NULL);
}

/* the start-up pass: every process that /proc lists, one by one, the ring drained after each */
static void seed(struct tracer *t) {
	DIR *d = opendir("/proc");
	if (!d) return;
	struct dirent *de;
	while ((de = readdir(d))) {
		char *end;
		unsigned long pid = strtoul(de->d_name, &end, 10);
		if (*end || pid == 0 || pid == (unsigned long)getpid()) continue;
		snapshot(t, (uint32_t)pid, 0);
	}
	closedir(d);
	drain();
	put_simple(HT_SEEDEND, 0, 0, 0, 0, NULL, 0, NULL);
}

/* ---- counters, dirty pids ---- */

static uint64_t last_events, last_drops, last_lost, last_cut, last_misses;
static struct timespec last_stats;

static uint64_t prog_misses(struct tracer *t) {
	uint64_t sum = 0;
	for (int i = 0; i < t->nprogs; i++) {
		struct bpf_prog_info info;
		uint32_t len = sizeof info;
		memset(&info, 0, sizeof info);
		if (bpf_obj_get_info_by_fd(t->prog_fds[i], &info, &len) == 0) sum += info.recursion_misses;
	}
	return sum;
}

static void emit_stats(struct tracer *t, uint64_t events, uint64_t drops) {
	uint64_t chain[3] = {events, drops, t->ring_bytes};
	put_simple(HT_STATS, 0, 0, 0, 0, chain, 3, NULL);
}

/*
 * Writes the dirty pids, and the counters when they changed. After a batch (`force` = 0) the map is read only when a counter says that something was
 * put in it, and the skipped program runs once a second. At a `sync` (`force` = 1) both are read every time: the answer to a question may not wait
 * for the next batch or the next second.
 */
static void housekeeping(struct tracer *t, int force) {
	uint64_t drops = stat_sum(t->stats_fd, HS_DROPS, t->ncpu);
	uint64_t lost = stat_sum(t->stats_fd, HS_DIRTY_LOST, t->ncpu);
	uint64_t cut = stat_sum(t->stats_fd, HS_CUT, t->ncpu);
	int all = 0;
	if (force || drops != last_drops || lost != last_lost || cut != last_cut) {
		uint32_t key, next;
		int rc = bpf_map_get_next_key(t->dirty_fd, NULL, &next);
		while (!rc) {
			key = next;
			rc = bpf_map_get_next_key(t->dirty_fd, &key, &next);
			bpf_map_delete_elem(t->dirty_fd, &key);
			put_simple(HT_DIRTY, key, 0, 0, 0, NULL, 0, NULL);
		}
		if (lost != last_lost) all = 1;
	}
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	int due = force || (now.tv_sec - last_stats.tv_sec) >= 1 || drops != last_drops;
	if (due) {
		uint64_t events = stat_sum(t->stats_fd, HS_EVENTS, t->ncpu);
		uint64_t misses = prog_misses(t);
		if (misses != last_misses) all = 1;
		if (events != last_events || drops != last_drops || misses != last_misses) emit_stats(t, events, drops);
		last_events = events;
		last_misses = misses;
		last_stats = now;
	}
	if (all) put_simple(HT_DIRTY, 0, 0, 0, 0, NULL, 0, NULL);
	last_drops = drops;
	last_lost = lost;
	last_cut = cut;
	flush_out();
}

/* ---- main loop ---- */

static volatile sig_atomic_t stop;
static void on_signal(int s) {
	(void)s;
	stop = 1;
}

/* every record that the kernel had made before this command is in the output now, the lost ones as DIRTY records; then the reply */
static void sync_barrier(struct tracer *t, uint32_t n) {
	drain();
	housekeeping(t, 1);
	drain();
	put_simple(HT_SYNC, 0, n, 0, 0, NULL, 0, NULL);
	flush_out();
}

static char cmd_buf[256];
static size_t cmd_len;
/* Reads what stdin has; runs the complete lines. Returns 1 when stdin is closed. */
static int handle_stdin(struct tracer *t) {
	ssize_t n = read(STDIN_FILENO, cmd_buf + cmd_len, sizeof cmd_buf - cmd_len - 1);
	if (n == 0) return 1;
	if (n < 0) return errno == EAGAIN || errno == EINTR ? 0 : 1;
	cmd_len += (size_t)n;
	cmd_buf[cmd_len] = 0;
	char *start = cmd_buf, *nl;
	while ((nl = memchr(start, '\n', cmd_buf + cmd_len - start))) {
		*nl = 0;
		unsigned long pid;
		char *end;
		if (!strcmp(start, "seed")) seed(t);
		else if (!strncmp(start, "snap ", 5) && (pid = strtoul(start + 5, &end, 10)) > 0 && !*end) snapshot(t, (uint32_t)pid, (uint32_t)pid);
		else if (!strncmp(start, "sync ", 5) && (pid = strtoul(start + 5, &end, 10)) > 0 && !*end) sync_barrier(t, (uint32_t)pid);
		start = nl + 1;
	}
	cmd_len = (size_t)(cmd_buf + cmd_len - start);
	memmove(cmd_buf, start, cmd_len);
	if (cmd_len >= sizeof cmd_buf - 1) cmd_len = 0; /* a line that long is no command */
	return 0;
}

int main(int argc, char **argv) {
	long ring_mb = 16;
	uint32_t agent_pid = (uint32_t)getppid(); /* the agent: the parent */
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--ring-mb") && i + 1 < argc) {
			char *end;
			ring_mb = strtol(argv[++i], &end, 10);
			if (*end || ring_mb < 1 || ring_mb > 256 || (ring_mb & (ring_mb - 1))) {
				fprintf(stderr, "filedeck-holders: --ring-mb must be 1, 2, 4, ... 256\n");
				return 1;
			}
		} else if (!strcmp(argv[i], "--ignore") && i + 1 < argc) {
			char *end;
			unsigned long v = strtoul(argv[++i], &end, 10);
			if (*end || v == 0) {
				fprintf(stderr, "filedeck-holders: --ignore needs a pid\n");
				return 1;
			}
			agent_pid = (uint32_t)v; /* the agent's pid when the parent is not the agent */
		} else {
			fprintf(stderr, "usage: filedeck-holders [--ring-mb N] [--ignore PID]\n");
			return 1;
		}
	}
	signal(SIGPIPE, SIG_IGN);
	struct sigaction sa = {.sa_handler = on_signal};
	sigemptyset(&sa.sa_mask);
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);

	unsigned long long eff = 0;
	int nspid = 1;
	if (read_status(&eff, &nspid) == 0) {
		int admin = (eff >> CAP_SYS_ADMIN_BIT) & 1, bpf = (eff >> CAP_BPF_BIT) & 1, perf = (eff >> CAP_PERFMON_BIT) & 1;
		if (!admin && !(bpf && perf)) return fail("not permitted: needs CAP_BPF and CAP_PERFMON (or CAP_SYS_ADMIN)");
		if (nspid > 1) return fail("not supported: needs the host pid namespace (hostPID: true), the pids of the events are host pids");
	}
	const char *btf = getenv("FILEDECK_HOLDERS_BTF");
	if (access(btf && *btf ? btf : "/sys/kernel/btf/vmlinux", R_OK) != 0) return fail("not supported: the kernel has no BTF (/sys/kernel/btf/vmlinux)");

	struct rlimit rl = {RLIM_INFINITY, RLIM_INFINITY};
	setrlimit(RLIMIT_MEMLOCK, &rl); /* Linux before 5.11 counts BPF memory as locked memory; failing here is fine on a newer kernel */
	libbpf_set_print(lib_print);

	struct tracer t = {0};
	for (size_t i = 0; i < NSOFT; i++)
		if (!strncmp(SOFT[i], "h_ia32_", 7) && !kernel_has_func(strcmp(SOFT[i], "h_ia32_dup3") ? "__ia32_sys_dup2" : "__ia32_sys_dup3")) absent_soft |= 1u << i;
	t.ring_bytes = (size_t)ring_mb << 20;
	t.ncpu = libbpf_num_possible_cpus();
	if (t.ncpu < 1) t.ncpu = 1;
	char err[400];
	if (tracer_open(&t, err, sizeof err) != 0) return fail(err);
	t.rb_fd = bpf_map__fd(bpf_object__find_map_by_name(t.obj, "rb"));
	t.cfg_fd = bpf_map__fd(bpf_object__find_map_by_name(t.obj, "cfg"));
	t.stats_fd = bpf_map__fd(bpf_object__find_map_by_name(t.obj, "stats"));
	t.dirty_fd = bpf_map__fd(bpf_object__find_map_by_name(t.obj, "dirty"));
	{
		uint32_t ka = HC_IGNORE_A, kb = HC_IGNORE_B, own = (uint32_t)getpid();
		bpf_map_update_elem(t.cfg_fd, &ka, &agent_pid, BPF_ANY);
		bpf_map_update_elem(t.cfg_fd, &kb, &own, BPF_ANY);
	}
	rb = ring_buffer__new(t.rb_fd, rb_cb, NULL, NULL);
	if (!rb) return fail("cannot open the ring buffer");
	int ep = epoll_create1(EPOLL_CLOEXEC);
	struct epoll_event ev = {.events = EPOLLIN};
	ev.data.fd = ring_buffer__epoll_fd(rb);
	epoll_ctl(ep, EPOLL_CTL_ADD, ev.data.fd, &ev);
	int rb_ep = ev.data.fd;
	ev.data.fd = STDIN_FILENO;
	epoll_ctl(ep, EPOLL_CTL_ADD, STDIN_FILENO, &ev);

	put_simple(HT_HELLO, 0, t.soft_failed, 0, 0, (uint64_t[]){t.ring_bytes}, 1, NULL);
	clock_gettime(CLOCK_MONOTONIC, &last_stats);
	flush_out();
	seed(&t);
	housekeeping(&t, 0);

	int status = 0;
	while (!stop && !out_failed) {
		struct epoll_event evs[2];
		int n = epoll_wait(ep, evs, 2, -1);
		if (n < 0) {
			if (errno == EINTR) continue;
			break;
		}
		int closed = 0;
		for (int i = 0; i < n; i++) {
			if (evs[i].data.fd == rb_ep) drain();
			else if (handle_stdin(&t)) closed = 1;
		}
		housekeeping(&t, 0);
		if (closed) break;
	}
	flush_out();
	for (int i = 0; i < t.nlinks; i++) bpf_link__destroy(t.links[i]);
	ring_buffer__free(rb);
	bpf_object__close(t.obj);
	return status;
}
