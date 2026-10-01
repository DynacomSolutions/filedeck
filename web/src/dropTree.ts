// No imports: pure helpers so the server tests can exercise them directly.
export interface Picked {
  file: File;
  rel: string;
}

// ---- drag and drop of folders ----

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: FsEntry[]) => void, err: (e: unknown) => void): void };
}
const MAX_DROP = 200_000;

/** Entries must be taken from the drop event synchronously (they are gone after the first await). */
export function dropEntries(dt: DataTransfer): { entries: FsEntry[]; plain: File[] } {
  const entries: FsEntry[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const e = (it as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  return { entries, plain: Array.from(dt.files) };
}

export async function gatherDrop(d: { entries: FsEntry[]; plain: File[] }): Promise<{ picked: Picked[]; dirs: string[] }> {
  const picked: Picked[] = [];
  const dirs: string[] = [];
  if (!d.entries.length) return { picked: d.plain.map((file) => ({ file, rel: file.name })), dirs };
  const walk = async (e: FsEntry, prefix: string, depth: number): Promise<void> => {
    if (picked.length + dirs.length > MAX_DROP || depth > 64) return;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isFile && e.file) {
      const file = await new Promise<File>((ok, err) => e.file!(ok, err));
      picked.push({ file, rel });
    } else if (e.isDirectory && e.createReader) {
      dirs.push(rel);
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
        if (!batch.length) break;
        for (const c of batch) await walk(c, rel, depth + 1);
      }
    }
  };
  for (const e of d.entries) await walk(e, "", 0);
  return { picked, dirs };
}

/** Files from an <input type=file webkitdirectory>: paths come from webkitRelativePath. */
export const pickedFromInput = (files: File[]): Picked[] => files.map((file) => ({ file, rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
