#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <blkid/blkid.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <linux/nvme_ioctl.h>
#include <scsi/sg.h>
#include <signal.h>
#include <sys/prctl.h>
#include <openssl/evp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

#ifndef BLKGETDISKSEQ
#define BLKGETDISKSEQ _IOR(0x12, 128, uint64_t)
#endif

enum { device = 3, block = 4096, batch = 1024 * 1024 };

static void fail(const char *message) {
    fprintf(stderr, "%s\n", message);
    exit(1);
}

static uint64_t number(const char *value) {
    char *end;
    if (!*value || strspn(value, "0123456789") != strlen(value)) fail("Invalid integer");
    errno = 0;
    unsigned long long result = strtoull(value, &end, 10);
    if (errno || *end) fail("Invalid integer");
    return result;
}

static uint64_t identity(uint64_t *bytes, unsigned *sector, struct stat *info) {
    uint64_t sequence;
    if (fstat(device, info) || !S_ISBLK(info->st_mode) ||
        ioctl(device, BLKGETDISKSEQ, &sequence) || !sequence ||
        ioctl(device, BLKGETSIZE64, bytes) || !*bytes ||
        ioctl(device, BLKSSZGET, sector) || !*sector)
        fail("No pinned block device identity");
    return sequence;
}

static void check_zfs_labels(uint64_t bytes) {
    enum { label_size = 256 * 1024, ring_size = 128 * 1024 };
    static const unsigned char little[8] = {0x0c, 0xb1, 0xba};
    static const unsigned char big[8] = {0, 0, 0, 0, 0, 0xba, 0xb1, 0x0c};
    uint64_t aligned = bytes & ~(uint64_t)(label_size - 1);
    if (aligned < 4 * label_size) return;
    uint64_t labels[] = {0, label_size, aligned - 2 * label_size, aligned - label_size};
    unsigned char ring[ring_size];
    for (unsigned i = 0; i < sizeof(labels) / sizeof(labels[0]); i++) {
        if (pread(device, ring, sizeof(ring), labels[i] + ring_size) != sizeof(ring)) fail("Cannot read the ZFS label area");
        for (size_t slot = 0; slot < sizeof(ring); slot += 1024)
            if (!memcmp(ring + slot, little, sizeof(little)) || !memcmp(ring + slot, big, sizeof(big)))
                fail("Disk has a ZFS storage membership signature");
    }
}

static void no_signatures(uint64_t bytes) {
    blkid_probe probe = blkid_new_probe();
    if (!probe || blkid_probe_set_device(probe, device, 0, 0) ||
        blkid_probe_enable_partitions(probe, 1) ||
        blkid_probe_set_partitions_flags(probe, BLKID_PARTS_MAGIC | BLKID_PARTS_FORCE_GPT) ||
        blkid_probe_enable_superblocks(probe, 1) ||
        blkid_probe_set_superblocks_flags(probe, BLKID_SUBLKS_MAGIC | BLKID_SUBLKS_TYPE | BLKID_SUBLKS_BADCSUM))
        fail("Cannot initialise signature probe");
    int result = blkid_do_fullprobe(probe);
    blkid_free_probe(probe);
    if (result == 0) fail("Disk has a filesystem, partition table or storage membership signature");
    if (result != 1) fail("Cannot rule out disk signatures");
    unsigned char boot[512];
    if (pread(device, boot, sizeof(boot), 0) != sizeof(boot)) fail("Cannot read the boot sector");
    if (boot[510] == 0x55 && boot[511] == 0xaa) fail("Disk has a boot sector signature");
    check_zfs_labels(bytes);
    if (bytes < sizeof(boot) || pread(device, boot, sizeof(boot), bytes - sizeof(boot)) != sizeof(boot))
        fail("Cannot read the end of the disk");
}

static void read_key(const char *hex, unsigned char key[32]) {
    if (strlen(hex) != 64 || strspn(hex, "0123456789abcdef") != 64) fail("Invalid data key");
    for (int i = 0; i < 32; i++) {
        char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
        key[i] = strtoul(pair, NULL, 16);
    }
}

/* Counter positions are unique across the entire device. Two aliased addresses cannot have the same expected bytes. */
static void pattern(EVP_CIPHER_CTX *ctx, const unsigned char *key, uint64_t offset, unsigned char *buffer, int length) {
    unsigned char iv[16] = {0};
    uint64_t counter = offset / 16;
    for (int i = 15; i >= 8; i--, counter >>= 8) iv[i] = counter & 255;
    memset(buffer, 0, length);
    int written;
    if (!EVP_EncryptInit_ex(ctx, EVP_aes_256_ctr(), NULL, key, iv) ||
        !EVP_EncryptUpdate(ctx, buffer, &written, buffer, length) || written != length)
        fail("Cannot generate test data");
    if (!offset) buffer[510] = 0;
}

static int transfer(const char *op, uint64_t bytes, uint64_t begin, uint64_t length, const char *hex) {
    unsigned char key[32];
    read_key(hex, key);
    int sparse = !strcmp(op, "capacity-write") || !strcmp(op, "capacity-read");
    int random = !strcmp(op, "random-write") || !strcmp(op, "random-read");
    int write_data = !strcmp(op, "write") || !strcmp(op, "random-write") || !strcmp(op, "capacity-write");
    int verify = !strcmp(op, "verify") || !strcmp(op, "capacity-read");
    unsigned char *buffer = NULL, *expected = NULL;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx || posix_memalign((void **)&buffer, block, batch) || posix_memalign((void **)&expected, block, batch))
        fail("Cannot allocate aligned I/O buffers");
    int flags = fcntl(device, F_GETFL);
    if (flags < 0 || fcntl(device, F_SETFL, flags | O_DIRECT)) fail("Cannot enable direct I/O");
    struct timespec start, end;
    if (clock_gettime(CLOCK_MONOTONIC, &start)) fail("Cannot measure I/O duration");
    uint64_t count = 0;
    int result = 0;
    for (uint64_t step = 0; step < length;) {
        uint64_t offset = begin + step;
        uint64_t remaining = length - step;
        size_t size = remaining < batch ? remaining : batch;
        if (sparse) {
            uint64_t index = step / block;
            uint64_t slots = bytes / block;
            uint64_t samples = length / block;
            uint64_t span = slots - 1;
            offset = ((span / (samples - 1)) * index + (span % (samples - 1)) * index / (samples - 1)) * block;
            size = block;
        } else if (random) {
            uint64_t address;
            if (getentropy(&address, sizeof(address))) fail("Cannot sample I/O address");
            offset = (address % (bytes / block)) * block;
            size = block;
        }
        if (write_data || verify) pattern(ctx, key, offset, expected, size);
        ssize_t done = write_data ? pwrite(device, expected, size, offset) : pread(device, buffer, size, offset);
        if (done < 0 || (size_t)done != size) {
            fprintf(stderr, "I/O failed at byte %" PRIu64 "\n", offset);
            result = 1;
            break;
        }
        if (verify && memcmp(buffer, expected, size)) {
            fprintf(stderr, "Data mismatch at byte %" PRIu64 "\n", offset);
            result = 1;
            break;
        }
        count += size;
        step += size;
    }
    if (fcntl(device, F_SETFL, flags)) fail("Cannot restore device descriptor flags");
    if (write_data && fdatasync(device)) fail("Cannot flush writes");
    EVP_CIPHER_CTX_free(ctx);
    free(buffer);
    free(expected);
    if (clock_gettime(CLOCK_MONOTONIC, &end)) fail("Cannot measure I/O duration");
    double seconds = end.tv_sec - start.tv_sec + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("%" PRIu64 " %.9f\n", count, seconds);
    return result;
}

static void self_test(const char *type, const char *operation) {
    int code = !strcmp(operation, "short") ? 1 : !strcmp(operation, "long") ? 2 :
        !strcmp(operation, "cancel") ? 15 : 0;
    if (!code) fail("Unknown SMART command");
    if (!strcmp(type, "nvme")) {
        int namespace = ioctl(device, NVME_IOCTL_ID);
        if (namespace <= 0) fail("Cannot identify NVMe namespace");
        struct nvme_admin_cmd command = {.opcode = 0x14, .nsid = namespace, .cdw10 = code, .timeout_ms = 10000};
        if (ioctl(device, NVME_IOCTL_ADMIN_CMD, &command)) fail("NVMe device rejected SMART command");
    } else if (!strcmp(type, "ata") || !strcmp(type, "scsi")) {
        unsigned char ata[16] = {0x85, 6, 0, 0, 0xd4, 0, 0, 0, code == 15 ? 127 : code, 0, 0x4f, 0, 0xc2, 0, 0xb0, 0};
        unsigned char scsi[6] = {0x1d, (code == 15 ? 4 : code) << 5, 0, 0, 0, 0};
        int sat = !strcmp(type, "ata");
        unsigned char sense[32] = {0};
        sg_io_hdr_t request = {
            .interface_id = 'S', .dxfer_direction = SG_DXFER_NONE, .cmd_len = sat ? sizeof(ata) : sizeof(scsi),
            .cmdp = sat ? ata : scsi, .mx_sb_len = sizeof(sense), .sbp = sense, .timeout = 10000,
        };
        if (ioctl(device, SG_IO, &request) || (request.info & SG_INFO_OK_MASK) != SG_INFO_OK)
            fail("SCSI or ATA device rejected SMART command");
    } else fail("Pinned SMART commands are unavailable on this transport");
}

int main(int argc, char **argv) {
    const char *parent = getenv("FILEDECK_DISK_PARENT");
    if (!parent || prctl(PR_SET_PDEATHSIG, SIGKILL) || (uint64_t)getppid() != number(parent))
        fail("Disk worker lost its parent");
    if (argc < 2) fail("Missing operation");
    uint64_t bytes;
    unsigned sector;
    struct stat info;
    uint64_t sequence = identity(&bytes, &sector, &info);
    if (argc == 2 && !strcmp(argv[1], "identify")) {
        printf("%u:%u %" PRIu64 " %" PRIu64 " %u\n", major(info.st_rdev), minor(info.st_rdev), sequence, bytes, sector);
        return 0;
    }
    if (argc < 5 || sequence != number(argv[2]) || bytes != number(argv[3]) || sector != number(argv[4]))
        fail("Disk sequence or geometry changed");
    // Check the inherited descriptor immediately before every operation that can change the disk.
    no_signatures(bytes);
    if (argc == 5 && (!strcmp(argv[1], "probe") || !strcmp(argv[1], "wipefs"))) {
        /* The safety policy refuses signatures, including at final cleanup. The wipefs superblock scan must be empty. */
        return 0;
    }
    if (argc == 7 && !strcmp(argv[1], "smart")) {
        self_test(argv[5], argv[6]);
        return 0;
    }
    if (argc == 7 && !strcmp(argv[1], "discard")) {
        uint64_t range[] = {number(argv[5]), number(argv[6])};
        if (!range[1] || range[0] > bytes || range[1] > bytes - range[0] ||
            range[0] % sector || range[1] % sector) fail("Invalid discard range");
        if (ioctl(device, BLKDISCARD, &range)) fail("Device rejected discard");
        if (fdatasync(device)) fail("Cannot flush discard");
        return 0;
    }
    if (argc != 8 || (strcmp(argv[1], "write") && strcmp(argv[1], "verify") &&
        strcmp(argv[1], "read") && strcmp(argv[1], "random-write") && strcmp(argv[1], "random-read") &&
        strcmp(argv[1], "capacity-write") && strcmp(argv[1], "capacity-read"))) fail("Unknown operation");
    uint64_t begin = number(argv[5]), length = number(argv[6]);
    if (!length || begin > bytes || length > bytes - begin || begin % block || length % sector || sector > block || block % sector) fail("Invalid I/O range or sector size");
    if (!strncmp(argv[1], "capacity-", 9) && (begin || length % block || length < 2 * block || length > 4096 * block))
        fail("Invalid capacity sample");
    return transfer(argv[1], bytes, begin, length, argv[7]);
}
