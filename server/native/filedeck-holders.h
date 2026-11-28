/*
 * The record that filedeck-holders.bpf.c (the kernel side) and filedeck-holders.c (the loader) share, and that the loader writes to stdout for the
 * agent (server/src/holders-proto.ts reads it). All numbers are little endian. A record is a fixed part of 56 bytes and `nchain` 64-bit numbers.
 * `len` is the whole size in bytes (a multiple of 8). The first byte of a valid record is therefore never "{" (0x7b): a start failure is one
 * line of JSON before any record.
 *
 *   type      meaning                                    fields used
 *   FD        a file descriptor was installed            pid, aux = fd, dev, ino, comm, chain
 *   CLOSE     one descriptor of the file was closed      pid, dev, ino
 *   CWD, ROOT the working or root folder was set         pid, dev, ino, chain
 *   EXECBEG   exec passed the point of no return         pid (the old executable and mappings are gone)
 *   EXE       exec finished                              pid, dev, ino, comm (the new name), chain
 *   MMAP      a file was mapped                          pid, dev, ino, chain
 *   FORK      a process was created                      pid = parent, aux = child, flags SHARED when it shares the file table or folders,
 *                                                        MT when the parent has (or had) other threads, AGENT when the parent is the agent
 *   EXIT      the last thread of a process ended         pid
 *   MOVED     an inode moved to another folder           dev, ino (pid = who moved it)
 *   DIRTY     events of this pid may be lost             pid (pid 0: events of unknown pids may be lost)
 *   URING     a process holds an io_uring                 pid, aux = 1 when the ring has registered (fixed) files: the ring holds them, and no hook sees them
 *   SCM       the process sent descriptors in a message  pid (the files may be in flight: held by no process)
 *   SFD, SCWD, SROOT, SEXE, SMMAP                        the same as FD, CWD, ROOT, EXE, MMAP, from a snapshot (see below)
 *   SURING    URING, from a snapshot
 *   SNAPBEG, SNAPEND  a snapshot of one pid starts, ends  pid, aux = request id; SNAPEND flags VANISHED when the pid had gone
 *   SEEDEND   the start-up pass over all processes ended
 *   SYNC      the answer to the loader command "sync N"   aux = N (every record that the kernel had made before the command is before this one)
 *   STATS     counters (loader)                          chain = {events, drops, ring size in bytes}
 *   HELLO     the loader started (loader)                aux = number of the hooks that did not load, chain = {ring size in bytes}; comm = the list of them
 *
 * `key` names the fs_struct (CWD, ROOT, SCWD, SROOT): the pointer value. Two threads of a process may have two. 0 for the other records.
 * `dev` is the kernel's device number of the superblock ((major << 20) | minor). `chain` lists the inode numbers of the folders above the entry, from its
 * folder up to the root of the superblock (so a folder is held when its inode number is `ino` or is in the chain). FLAG TRUNCATED: the chain ends before
 * the root (deeper than HOLDERS_MAX_CHAIN, or the entry is not connected to its root), so it proves no absence.
 */
#ifndef FILEDECK_HOLDERS_H
#define FILEDECK_HOLDERS_H

#define HOLDERS_MAX_CHAIN 48
#define HOLDERS_HDR_BYTES 56

enum holders_type {
	HT_FD = 1,
	HT_CLOSE = 2,
	HT_CWD = 3,
	HT_ROOT = 4,
	HT_EXECBEG = 5,
	HT_EXE = 6,
	HT_MMAP = 7,
	HT_FORK = 8,
	HT_EXIT = 9,
	HT_MOVED = 10,
	HT_DIRTY = 11,
	HT_URING = 12,
	HT_SCM = 13,
	HT_SFD = 21,
	HT_SCWD = 23,
	HT_SROOT = 24,
	HT_SEXE = 26,
	HT_SMMAP = 27,
	HT_SURING = 28,
	HT_SNAPBEG = 30,
	HT_SNAPEND = 31,
	HT_SEEDEND = 32,
	HT_SYNC = 33,
	HT_STATS = 40,
	HT_HELLO = 41,
};

#define HF_TRUNCATED 1u
#define HF_SHARED 2u
#define HF_VANISHED 4u
/* 8 is HF_ERROR of the loader (SNAPEND) */
#define HF_MT 16u /* FORK: the parent has or had other threads: one of them may have changed its descriptors while the table was copied */
#define HF_CUT 32u /* the chain was read while a rename ran: it is cut (and the pid is marked) */
#define HF_AGENT 64u /* FORK: the parent is the agent (it is not in the table, and the child may hold what the agent held) */

struct holders_rec {
	__u32 len;
	__u16 type;
	__u16 nchain;
	__u32 pid;
	__u32 aux;
	__u32 dev;
	__u32 flags;
	__u64 ino;
	char comm[16];
	__u64 key;
	__u64 chain[HOLDERS_MAX_CHAIN];
};

/* the entries of the `stats` map (per CPU) and of the `cfg` map */
enum { HS_EVENTS = 0, HS_DROPS = 1, HS_DIRTY_LOST = 2, HS_CUT = 3, HS_COUNT = 4 };
enum { HC_IGNORE_A = 0, HC_IGNORE_B = 1, HC_COUNT = 2 };

#endif
