export interface Statistics {
  min: number;
  max: number;
  mean: number;
  resting: number;
}

export interface IOPressure {
  read: Statistics | null;
  write: Statistics | null;
  utilisation: Statistics | null;
}

export interface StorageGroup {
  name: string;
  bytes: number;
  scannedAt: number | null;
  stale: boolean;
  notStored: boolean;
  errors: number;
  hardLinks: "heavy" | "normal" | "unknown";
  unattributed?: true;
  io?: IOPressure;
}

export interface StorageDrive {
  id: string;
  devices: { name: string; model: string | null }[];
  mounts: string[];
  usedBytes: number | null;
  capacityBytes: number | null;
  overageBytes: number;
  groups: StorageGroup[];
  io?: IOPressure;
}

export interface StorageNode {
  node: string;
  drives: StorageDrive[];
}

export interface GroupsResult {
  nodes: StorageNode[];
  unavailable: string[];
  io: { status: "disabled" | "available" | "unavailable"; sampledAt?: number; stale?: boolean };
}
