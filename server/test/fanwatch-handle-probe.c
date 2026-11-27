/*
 * Test only (fanwatch-binds-live.test.ts): what open_by_handle_at gives, through the mount of one path, for a folder named by another path.
 *   fanwatch-handle-probe MOUNTPATH ENTRYPATH     prints "ok PATH" (what /proc/self/fd/N says for the folder) or "error TEXT"
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc != 3) return 2;
	int mfd = open(argv[1], O_RDONLY | O_DIRECTORY);
	if (mfd < 0) return printf("error open mount: %s\n", strerror(errno)), 0;
	struct file_handle *fh = malloc(sizeof *fh + 128);
	fh->handle_bytes = 128;
	int mid;
	if (name_to_handle_at(AT_FDCWD, argv[2], fh, &mid, 0) < 0) return printf("error name_to_handle_at: %s\n", strerror(errno)), 0;
	int fd = open_by_handle_at(mfd, fh, O_PATH | O_CLOEXEC);
	if (fd < 0) return printf("error open_by_handle_at: %s\n", strerror(errno)), 0;
	char link[64], dst[4096];
	snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
	ssize_t n = readlink(link, dst, sizeof dst - 1);
	if (n < 0) return printf("error readlink: %s\n", strerror(errno)), 0;
	dst[n] = 0;
	printf("ok %s (mount id %d)\n", dst, mid);
	return 0;
}
