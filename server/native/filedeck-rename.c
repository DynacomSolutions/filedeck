/*
 * filedeck-rename: rename one entry without replacing anything at the destination (renameat2 with RENAME_NOREPLACE).
 *
 *   filedeck-rename FROM_NAME TO_NAME      the directory of FROM_NAME is the inherited descriptor 3, that of TO_NAME descriptor 4
 *
 * Both names must be single path components: an empty name, "." , ".." and any name holding a "/" are refused. The program takes
 * no paths, reads no environment and prints nothing but one short error line on stderr. The caller (server/src/noreplace.ts) holds
 * the two directories open and passes those descriptors, so what is renamed is decided by the descriptors and not by a path
 * that could lead elsewhere by the time this program runs. It is started directly by the agent, never through the sandbox launcher.
 *
 * Exit status:
 *   0  done
 *   1  any other error (the errno name is on stderr)
 *   2  usage error or a name that is refused
 *   3  something exists at the destination (EEXIST)
 *   4  not supported here (ENOSYS, EINVAL or EOPNOTSUPP: an old kernel, or a filesystem without the flag)
 *   5  the two directories are on different devices (EXDEV)
 *
 * Build: cc -O2 -Wall -static -o filedeck-rename filedeck-rename.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

#define FROM_FD 3
#define TO_FD 4

static const char *errname(int e)
{
	switch (e) {
	case EACCES: return "EACCES";
	case EBADF: return "EBADF";
	case EBUSY: return "EBUSY";
	case EDQUOT: return "EDQUOT";
	case EFAULT: return "EFAULT";
	case EINVAL: return "EINVAL";
	case EIO: return "EIO";
	case EISDIR: return "EISDIR";
	case ELOOP: return "ELOOP";
	case EMLINK: return "EMLINK";
	case ENAMETOOLONG: return "ENAMETOOLONG";
	case ENOENT: return "ENOENT";
	case ENOMEM: return "ENOMEM";
	case ENOSPC: return "ENOSPC";
	case ENOSYS: return "ENOSYS";
	case ENOTDIR: return "ENOTDIR";
	case ENOTEMPTY: return "ENOTEMPTY";
	case EOPNOTSUPP: return "EOPNOTSUPP";
	case EPERM: return "EPERM";
	case EROFS: return "EROFS";
	case ETXTBSY: return "ETXTBSY";
	default: return "EUNKNOWN";
	}
}

static int single_component(const char *s)
{
	return s[0] != '\0' && strcmp(s, ".") != 0 && strcmp(s, "..") != 0 && strchr(s, '/') == NULL;
}

int main(int argc, char **argv)
{
	if (argc != 3) {
		fputs("filedeck-rename: usage: filedeck-rename FROM_NAME TO_NAME\n", stderr);
		return 2;
	}
	if (!single_component(argv[1]) || !single_component(argv[2])) {
		fputs("filedeck-rename: a name must be one path component\n", stderr);
		return 2;
	}
	if (syscall(SYS_renameat2, FROM_FD, argv[1], TO_FD, argv[2], RENAME_NOREPLACE) == 0) return 0;
	int e = errno;
	if (e == EEXIST) return 3;
	if (e == ENOSYS || e == EINVAL || e == EOPNOTSUPP) {
		fprintf(stderr, "filedeck-rename: %s\n", errname(e));
		return 4;
	}
	if (e == EXDEV) return 5;
	fprintf(stderr, "filedeck-rename: %s\n", errname(e));
	return 1;
}
