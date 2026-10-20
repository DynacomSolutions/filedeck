import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

/**
 * Directory entries as a stream: `opendir` reads 64 at a time, so a folder with millions of names never sits on the heap.
 * The handle is closed when the loop ends, breaks or throws.
 */
export async function* direntsOf(dir: string): AsyncGenerator<Dirent> {
  const d = await fs.opendir(dir, { bufferSize: 64 });
  try {
    for await (const e of d) yield e;
  } finally {
    await d.close().catch(() => {}); // already closed once the iterator ran to the end
  }
}

/**
 * Names of `dir` in batches of at most `size` (arrival order), `keep` filtering as they stream.
 * A folder that cannot be opened or read calls `onError` and ends the stream; errors thrown by the consumer are not touched.
 */
export async function* namesOf(dir: string, size: number, keep: (name: string) => boolean = () => true, onError?: () => void): AsyncGenerator<string[]> {
  let batch: string[] = [];
  try {
    for await (const e of direntsOf(dir)) {
      if (!keep(e.name)) continue;
      batch.push(e.name);
      if (batch.length >= size) {
        const b = batch;
        batch = [];
        yield b;
      }
    }
  } catch (e) {
    if (!onError) throw e;
    onError();
    return;
  }
  if (batch.length) yield batch;
}
