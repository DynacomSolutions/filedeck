export interface StatusChange {
  kind: string;
  node?: string;
  cursor?: string;
  time?: number;
  dir?: boolean;
  path?: string;
  from?: string;
  reason?: string;
  error?: string;
  unwatched?: string[];
}

export const CHANGE_ROW_LIMIT = 500;
const MAX_LINE = 1024 * 1024;

export function appendChanges<T extends StatusChange>(previous: T[], batch: T[]): T[] {
  const key = (event: StatusChange) => event.cursor ? event.kind + ":" + event.cursor : undefined;
  const seen = new Set(previous.map(key));
  const fresh = batch.filter((event) => {
    const id = key(event);
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...previous, ...fresh].slice(-CHANGE_ROW_LIMIT);
}

export async function readChanges(body: ReadableStream<Uint8Array>, onEvent: (event: StatusChange) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending) throw new Error("The change stream ended with an incomplete line.");
        return;
      }
      const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > MAX_LINE) throw new Error("The change stream sent an oversized line.");
      for (const line of lines) {
        if (!line) continue;
        if (line.length > MAX_LINE) throw new Error("The change stream sent an oversized line.");
        const event = JSON.parse(line) as StatusChange | null;
        if (event && typeof event.kind === "string") onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
