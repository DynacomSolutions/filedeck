/*
 * Test only (iotrace-unit.test.ts): runs the output code of filedeck-iotrace on hand-made rows, with no kernel, no capability and no BPF program.
 * The helper's source is included, so the code under test is the shipped code.
 *   iotrace-unit sample | many | escape | error | caps HEX
 */
#define IOTRACE_UNIT 1
#ifndef IOTRACE_SRC
#define IOTRACE_SRC "../native/filedeck-iotrace.c"
#endif
#include IOTRACE_SRC

static struct row mk(uint32_t major, uint32_t minor, uint64_t cg, uint32_t pid, const char *comm, uint64_t r, uint64_t w, uint64_t rb, uint64_t wb) {
	struct row x;
	memset(&x, 0, sizeof x);
	x.key.dev = (major << 20) | minor;
	x.key.cg = cg;
	x.key.pid = pid;
	strncpy(x.val.comm, comm, sizeof x.val.comm);
	x.val.r = r, x.val.w = w, x.val.rb = rb, x.val.wb = wb;
	return x;
}

static void emit(struct row *rows, size_t n) {
	static char buf[LINE_CAP];
	struct out o = {buf, 0, sizeof buf};
	format_line(&o, 1795800000000LL, rows, n);
	fputs(buf, stdout);
}

int main(int argc, char **argv) {
	const char *what = argc > 1 ? argv[1] : "";
	if (!strcmp(what, "sample")) {
		/* given out of order: the busiest comes first; equal requests are ordered by bytes, then by the key */
		struct row rows[] = {
			mk(259, 0, 4821, 1200, "postgres", 10, 90, 81920, 737280),
			mk(259, 0, 1, 51, "kworker/u8:3", 0, 400, 0, 52428800),
			mk(8, 16, 4821, 1200, "postgres", 0, 90, 0, 1000),
			mk(259, 0, 777, 3000, "tar", 90, 10, 9000, 100),
			mk(259, 0, 9, 9, "idle", 0, 0, 0, 0),
		};
		emit(rows, 4); /* the fifth row is outside n: not printed */
	} else if (!strcmp(what, "many")) {
		static struct row rows[900];
		for (size_t i = 0; i < 900; i++) rows[i] = mk(259, 0, 100 + i, 5000 + i, "p", i + 1, 0, (i + 1) * 4096, 0);
		emit(rows, 900);
	} else if (!strcmp(what, "escape")) {
		struct row rows[] = {mk(259, 0, 5, 5, "a\"b\\c\td\x01\x7f\xc3\xa9", 1, 0, 4096, 0)};
		emit(rows, 1);
	} else if (!strcmp(what, "empty")) {
		emit(NULL, 0);
	} else if (!strcmp(what, "error")) {
		char buf[1024];
		struct out o = {buf, 0, sizeof buf};
		format_error(&o, "not permitted: needs \"CAP_BPF\"");
		fputs(buf, stdout);
	} else if (!strcmp(what, "caps") && argc > 2) {
		printf("%d\n", caps_allow_bpf(strtoull(argv[2], NULL, 16)));
	} else {
		fprintf(stderr, "unknown scenario\n");
		return 2;
	}
	return 0;
}
