/** One readable line for a thrown value; never empty. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const line = m.split("\n")[0]?.trim() ?? "";
  return line ? line.slice(0, 300) : "Unknown error";
}

/** A failed dynamic import, which usually means the page is older than the server's files. */
export function isChunkError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed|Unable to preload/i.test(m);
}

/** Whether the given reset keys differ (arrays of equal length compared element by element). */
export function keysChanged(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length !== y.length || x.some((v, i) => !Object.is(v, y[i]));
}
