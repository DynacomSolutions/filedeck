import { opLive, type JobView, type OpJob } from "./api";
import type { JobsSnapshot } from "./Jobs";
import type { StatusRoute } from "./statusRoute";

export interface StatusJob {
  key: string;
  nodes: string[];
  source: "agent" | "hub" | "compares" | "browser";
  job: (Omit<JobView, "state"> & { state: OpJob["state"] }) | OpJob;
}

export function statusJobs(snapshot: JobsSnapshot, route: StatusRoute): StatusJob[] {
  const all: StatusJob[] = [
    ...Object.entries(snapshot.jobs).flatMap(([node, jobs]) =>
      jobs.map((job) => ({ key: `agent:${node}:${job.id}`, nodes: [node], source: "agent" as const, job }))),
    ...snapshot.ops.map((job) => ({ key: `op:${job.id}`, nodes: job.nodes ?? [], source: "hub" as const, job })),
    ...snapshot.compares.map((job) => ({
      key: `compare:${job.id}`, nodes: [...new Set([job.left?.node, job.right?.node].filter((node) => node !== undefined))],
      source: "compares" as const, job,
    })),
    ...snapshot.uploads.map((upload): StatusJob => ({
      key: `upload:${upload.id}`, nodes: [upload.node], source: "browser",
      job: {
        ...upload, kind: "upload", origin: "ui", startedAt: upload.createdAt,
        progress: {
          bytes: upload.bytes, totalBytes: upload.totalBytes,
          entries: upload.files.filter((file) => file.state === "done").length,
          totalEntries: upload.files.length, current: upload.dir,
        },
        error: upload.files.find((file) => file.error)?.error,
      },
    })),
  ];
  return all.filter(({ key, nodes, job }) => {
    if (route.node && !nodes.includes(route.node)) return false;
    if (key === route.job) return true;
    if (route.jobs === "active") return isActive(job);
    if (route.jobs === "recent") return !isActive(job);
    if (route.jobs === "failed") return job.state === "failed";
    return true;
  }).sort((a, b) => Number(isActive(b.job)) - Number(isActive(a.job))
    || (b.job.finishedAt ?? b.job.createdAt) - (a.job.finishedAt ?? a.job.createdAt));
}

export const isActive = (job: Pick<StatusJob["job"], "state">) => opLive(job);

export function jobDuration(job: Pick<StatusJob["job"], "startedAt" | "finishedAt" | "state">, now: number): string {
  if (job.startedAt === undefined) return "Not started";
  const end = job.finishedAt ?? (isActive(job) ? now : undefined);
  if (end === undefined) return "Unknown";
  const seconds = Math.max(0, Math.floor((end - job.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  if (minutes) return `${minutes} min ${seconds % 60} s`;
  return `${seconds} s`;
}
