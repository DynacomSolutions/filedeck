/** The shapes of the disk pressure API (docs/disk-pressure.md). One Snapshot per sample interval. */

export interface PsiWindows {
  avg10: number;
  avg60: number;
  avg300: number;
}
export interface Psi {
  some: PsiWindows;
  full: PsiWindows;
}

export interface Pod {
  namespace: string;
  name: string;
  container?: string;
  uid: string;
}

export type ConsumerKind = "cgroup" | "process" | "path";

export interface Consumer {
  kind: ConsumerKind;
  /** stable key: the cgroup path, `pid:<pid>:<starttime>`, or `path:<top folder>` */
  id: string;
  label: string;
  cgroup?: string;
  pod?: Pod;
  unit?: string;
  pid?: number;
  comm?: string;
  path?: string;
  /** a link from an operator label rule (FILEDECK_PRESSURE_LABELS) */
  link?: string;
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
  eventsPerSec?: number;
  psiFull10?: number;
}

export interface DiskSnapshot {
  name: string;
  dev: string;
  mounts: string[];
  util: number;
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
  queueDepth: number;
  rAwaitMs: number;
  wAwaitMs: number;
  inflight: number;
  consumers: Consumer[];
}

export type PressureSource = "ebpf" | "proc";

export interface Snapshot {
  type: "snapshot";
  node: string;
  at: number;
  intervalMs: number;
  source: PressureSource;
  psi: Psi;
  disks: DiskSnapshot[];
}

/** What a consumer row looks like before it is placed on a disk. Rates are per second. */
export interface Rates {
  rIops: number;
  wIops: number;
  rBps: number;
  wBps: number;
}

export const ZERO_PSI: Psi = {
  some: { avg10: 0, avg60: 0, avg300: 0 },
  full: { avg10: 0, avg60: 0, avg300: 0 },
};
