import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { groupStorage, type MeasuredDrive, type StoredGroupSize } from "./group-engine.ts";
import { GroupMetrics } from "./group-metrics.ts";
import { DriveMap, groupMounts, isStorageMount } from "./group-mounts.ts";
import type { GroupRule } from "./group-rules.ts";
import type { StorageNode } from "./group-types.ts";

export interface AgentGroups extends StorageNode {
  drives: MeasuredDrive[];
  labels: { name: string; match: Record<string, string> }[];
}

export class AgentGroupReader {
  readonly metrics = new GroupMetrics("groups");
  private pending?: Promise<AgentGroups>;
  private previous?: { at: number; result: AgentGroups };

  constructor(
    private readonly cfg: Pick<Config, "node" | "root" | "procMounts">,
    private readonly rules: GroupRule[],
    private readonly stored: (p: string) => Promise<StoredGroupSize | null>,
  ) {}

  read(): Promise<AgentGroups> {
    if (this.previous && Date.now() - this.previous.at < 10_000) return Promise.resolve(this.previous.result);
    return this.pending ??= this.collect().finally(() => { this.pending = undefined; });
  }

  private async collect(): Promise<AgentGroups> {
    this.metrics.requests++;
    const { node, root, procMounts } = this.cfg;
    try {
      const mounts = await groupMounts(root, procMounts);
      if (process.platform === "linux" && !mounts.length) throw new Error("mount table unavailable");
      const hostSys = path.join(root, "sys");
      const sys = await fs.access(path.join(hostSys, "class/block")).then(() => hostSys, () => "/sys");
      const driveMap = new DriveMap(sys, path.join(root, "dev"));
      const mapped = await Promise.all(mounts.map(async (mount) => ({
        ...mount,
        ...isStorageMount(mount) ? await driveMap.describe(mount) : { fsKey: mount.dev, drives: [] },
      })));
      const drives = await groupStorage(mapped, this.rules, this.stored, async (p) => {
        const target = path.join(root, p);
        const s = await fs.statfs(target).catch(() => null);
        return s && { used: (s.blocks - s.bfree) * s.bsize, capacity: s.blocks * s.bsize };
      }, isStorageMount);
      if (drives.some((drive) => drive.usedBytes === null)) this.metrics.errors++;
      else this.metrics.lastSuccess = Date.now();
      const result = {
        node, drives,
        labels: this.rules.filter((rule) => Object.keys(rule.labels).length).map((rule) => ({ name: rule.name, match: rule.labels })),
      };
      this.previous = { at: Date.now(), result };
      return result;
    } catch (error) {
      this.metrics.errors++;
      throw error;
    }
  }
}
