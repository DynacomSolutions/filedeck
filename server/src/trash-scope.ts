/**
 * The trash scope of this process (sign-in on): a worker serves one account, and its trash is that account's own folder in each volume's
 * trash store (`<volume>/.filedeck-trash/<folder>/`). Without a scope (sign-in off, the root process) the trash is the whole store.
 * Kept apart from trash.ts so that fsops.ts can read it without importing trash.ts (which imports fsops.ts).
 */
export interface TrashScope {
  /** `u<uid>` or `v-<owner>` (`TRASH_OWNER`) */
  folder: string;
  /** the account's folder on the volume whose root is `volumeReal` (made by the root process when missing); its real path */
  ensure(volumeReal: string): Promise<string>;
  /** a virtual account: whether a restore may put an item at this path (its grants); unset = anywhere the account may write */
  mayRestore?(virtual: string): boolean;
}

let scope: TrashScope | null = null;

/** Sets the trash scope of this process (a worker, once, at its start); null for none. */
export function setTrashScope(s: TrashScope | null): void {
  scope = s;
}

export const trashScope = (): TrashScope | null => scope;
