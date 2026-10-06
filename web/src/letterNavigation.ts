export interface LetterMatch {
  name: string;
  path: string;
}

/** Find the next visible name beginning with key, starting after currentPath and wrapping once. */
export function nextLetterMatch<T extends LetterMatch>(entries: readonly T[], currentPath: string | null, key: string): T | null {
  if (!/^\p{L}$/u.test(key) || entries.length === 0) return null;
  const needle = key.toLocaleLowerCase();
  const current = entries.findIndex((entry) => entry.path === currentPath);
  for (let offset = 1; offset <= entries.length; offset++) {
    const entry = entries[(Math.max(current, -1) + offset) % entries.length]!;
    if (entry.name.toLocaleLowerCase().startsWith(needle)) return entry;
  }
  return null;
}
