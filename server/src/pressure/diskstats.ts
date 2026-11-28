import type { Rates } from "./types.ts";

/** One line of /proc/diskstats: the counters of a block device. Sectors are 512 bytes whatever the device's block size. */
export interface DiskCounters {
  major: number;
  minor: number;
  name: string;
  reads: number;
  readSectors: number;
  readMs: number;
  writes: number;
  writeSectors: number;
  writeMs: number;
  inflight: number;
  /** ms the device had IO in flight (the util numerator) */
  ioMs: number;
  /** weighted ms: in-flight count integrated over time (the queue depth numerator) */
  weightedMs: number;
}

export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const n = (i: number) => Number(f[i]) || 0;
    out.push({
      major: n(0), minor: n(1), name: f[2] as string,
      reads: n(3), readSectors: n(5), readMs: n(6),
      writes: n(7), writeSectors: n(9), writeMs: n(10),
      inflight: n(11), ioMs: n(12), weightedMs: n(13),
    });
  }
  return out;
}

export interface DiskRates extends Rates {
  util: number;
  queueDepth: number;
  rAwaitMs: number;
  wAwaitMs: number;
  inflight: number;
  /** average bytes per IO in this interval, 0 when there was none (used to estimate the IOPS of a process) */
  avgIoBytes: number;
}

/** Rates between two samples `dtMs` apart. A counter that went down (a device that came back) gives zero rates for that interval. */
export function diskRates(prev: DiskCounters, cur: DiskCounters, dtMs: number): DiskRates {
  const dt = Math.max(1, dtMs) / 1000;
  const d = (a: number, b: number) => (b >= a ? b - a : 0);
  const reads = d(prev.reads, cur.reads);
  const writes = d(prev.writes, cur.writes);
  const rBytes = d(prev.readSectors, cur.readSectors) * 512;
  const wBytes = d(prev.writeSectors, cur.writeSectors) * 512;
  const ios = reads + writes;
  return {
    rIops: reads / dt,
    wIops: writes / dt,
    rBps: rBytes / dt,
    wBps: wBytes / dt,
    util: Math.min(1, d(prev.ioMs, cur.ioMs) / (dt * 1000)),
    queueDepth: d(prev.weightedMs, cur.weightedMs) / (dt * 1000),
    rAwaitMs: reads > 0 ? d(prev.readMs, cur.readMs) / reads : 0,
    wAwaitMs: writes > 0 ? d(prev.writeMs, cur.writeMs) / writes : 0,
    inflight: cur.inflight,
    avgIoBytes: ios > 0 ? (rBytes + wBytes) / ios : 0,
  };
}

/** Devices that are never a disk to show, by name. */
const SKIP = /^(loop|ram|zram|fd|sr|nbd)\d*/;
/** Partition names, as a fallback when /sys/block is not readable: nvme0n1p2, sda1, mmcblk0p1, vda3. */
const PARTITION = /^(?:(?:nvme\d+n\d+|mmcblk\d+|md\d+|nbd\d+)p\d+|(?:sd|vd|xvd|hd)[a-z]+\d+)$/;
const STACKED = /^(dm-\d+|md\d+)$/;

export interface DeviceFacts {
  /** names of the entries in /sys/block (whole disks and stacked devices), when readable */
  wholeDisks?: Set<string>;
}

/**
 * Whole disks to report: partitions, loop, ram and zram devices are skipped, and so are device-mapper and md devices
 * unless a mount sits on them (`mounted`, as "major:minor").
 */
export function pickDisks(all: DiskCounters[], mounted: Set<string>, facts: DeviceFacts = {}): DiskCounters[] {
  return all.filter((d) => {
    if (SKIP.test(d.name)) return false;
    if (facts.wholeDisks ? !facts.wholeDisks.has(d.name) : PARTITION.test(d.name)) return false;
    if (STACKED.test(d.name)) return mounted.has(`${d.major}:${d.minor}`);
    return true;
  });
}

/** The whole disk a partition belongs to, by name, or the name itself. */
export function parentDisk(name: string): string {
  const m = /^(nvme\d+n\d+|mmcblk\d+|md\d+|nbd\d+)p\d+$/.exec(name) ?? /^((?:sd|vd|xvd|hd)[a-z]+)\d+$/.exec(name);
  return m ? (m[1] as string) : name;
}
