export interface TransferSourcePath {
  node: string;
  path: string;
  dir: boolean;
}

/** Prevent copying or moving a directory into itself or one of its descendants. */
export function validTransferDestination(items: TransferSourcePath[], node: string, dir: string): boolean {
  return items.every((item) => !(item.dir && item.node === node && (dir === item.path || dir.startsWith(item.path.replace(/\/$/, "") + "/"))));
}
