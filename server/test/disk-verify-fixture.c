#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <linux/fs.h>
#include <linux/nvme_ioctl.h>
#include <scsi/sg.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>

static int fixture_fstat(int fd, struct stat *info) {
    if (fstat(fd, info) || fd != 3 || !S_ISREG(info->st_mode)) return -1;
    info->st_mode = S_IFBLK;
    info->st_rdev = makedev(8, 16);
    return 0;
}

#include <stdarg.h>

static int fixture_ioctl(int fd, unsigned long request, ...) {
    struct stat info;
    if (fstat(fd, &info) || fd != 3 || !S_ISREG(info.st_mode)) return -1;
    if (request == NVME_IOCTL_ID) return -1;
    va_list args;
    va_start(args, request);
    void *argument = va_arg(args, void *);
    va_end(args);
    switch (request) {
    case _IOR(0x12, 128, uint64_t):
        *(uint64_t *)argument = 19;
        return 0;
    case BLKGETSIZE64:
        *(uint64_t *)argument = info.st_size;
        return 0;
    case BLKSSZGET:
        *(unsigned *)argument = 512;
        return 0;
    default:
        return -1;
    }
}

#define fstat fixture_fstat
#define ioctl fixture_ioctl
#include "../native/filedeck-disk-verify.c"
