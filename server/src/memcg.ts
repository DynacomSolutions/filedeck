import fs from "node:fs";

/**
 * Relief for the kernel memory a big walk leaves in the agent's memory cgroup.
 *
 * Every folder and file a walk stats leaves a dentry and an inode in the kernel's cache, charged to the cgroup that read it. They are reclaimable,
 * but the filesystem allocates the next ones (ext4 lookups, extent cache) with GFP_NOFS, and a reclaim started from such an allocation may not run the
 * dentry and inode shrinkers. So once the cache fills the cgroup to its limit, the next lookup is an out-of-memory kill, with the agent's own memory far
 * below the limit (measured: killed at 256 MiB with 94 MiB anonymous and 165 MiB of reclaimable slab, after about 1.5 million files).
 *
 * A page fault on anonymous memory is charged with a normal allocation, whose reclaim does run the shrinkers. So when the cgroup is close to its limit,
 * the walk writes to a short-lived buffer: the kernel frees about as much of the dentry and inode cache to make room, then the buffer is dropped.
 * Nothing happens without a cgroup limit (or where the files cannot be read).
 */
/** Returns a check to call often (cheap: it reads two files at most every `everyMs`); true = still within 10% of the limit, the caller should pause a moment. */
export function memcgRelief(o: { /** checks at most this often */ everyMs?: number; dir?: string } = {}): () => boolean {
  const every = o.everyMs ?? 100;
  const dir = o.dir ?? cgroupDir();
  let next = 0;
  let max = 0;
  let maxAt = 0;
  return () => {
    const now = Date.now();
    if (!dir || now < next) return false;
    next = now + every;
    try {
      if (now - maxAt > 60_000) {
        const m = fs.readFileSync(dir + "/memory.max", "utf8").trim();
        max = m === "max" ? 0 : Number(m);
        maxAt = now;
      }
      if (!max) return false;
      const cur = Number(fs.readFileSync(dir + "/memory.current", "utf8").trim());
      const room = Math.max(32 << 20, max * 0.2);
      if (cur < max - room) return false;
      // more than the room left: only a charge that would pass the limit makes the kernel reclaim (about as much as it is over), at most 64 MiB
      const want = Math.min(64 << 20, max - cur + (16 << 20));
      // ... and only when the cgroup holds at least twice that much cache the kernel can free (slab it may reclaim, file pages): else the charge
      // itself, with memory that cannot be freed (the heap, a child process in the same cgroup), would be the out-of-memory kill
      if (reclaimable(dir) < 2 * Math.max(0, cur + want - max)) return false;
      const ab = new ArrayBuffer(want);
      const u = new Uint8Array(ab);
      for (let i = 0; i < want; i += 4096) u[i] = 1; // one write per page: each one is a charge
      (ab as ArrayBuffer & { transfer(n: number): ArrayBuffer }).transfer(0); // (ES2024, Node 22) given back at once (a garbage collection may be far away while the walk waits)
      const tight = Number(fs.readFileSync(dir + "/memory.current", "utf8").trim()) > max * 0.9;
      if (tight) next = now; // checked again at once after the pause
      return tight;
    } catch {
      return false; // no cgroup files here: nothing to do
    }
  };
}

/** Bytes of the cgroup's memory the kernel can free on demand: reclaimable slab (dentries, inodes) and file pages. */
function reclaimable(dir: string): number {
  let n = 0;
  for (const l of fs.readFileSync(dir + "/memory.stat", "utf8").split("\n")) {
    const [k, v] = l.split(" ");
    if (k === "slab_reclaimable" || k === "active_file" || k === "inactive_file") n += Number(v) || 0;
  }
  return n;
}

/** The memory cgroup of this process (cgroup v2): the namespace root in a container, the process's own group elsewhere. */
function cgroupDir(): string {
  try {
    const rel = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3).trim();
    if (rel === undefined) return "";
    const d = "/sys/fs/cgroup" + (rel === "/" ? "" : rel);
    fs.accessSync(d + "/memory.current");
    return d;
  } catch {
    return "";
  }
}
