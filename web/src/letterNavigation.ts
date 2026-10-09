export interface LetterMatch {
  name: string;
  path: string;
}

export const TYPEAHEAD_TIMEOUT_MS = 500;

export interface TypeAheadState {
  buffer: string;
  at: number;
}

export interface TypeAheadResult<T> {
  state: TypeAheadState;
  match: T | null;
  /** True when the key extended a live buffer, so the caller should consume it even without a match. */
  continued: boolean;
}

function find<T extends LetterMatch>(entries: readonly T[], from: number, prefix: string): T | null {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[(from + i) % entries.length]!;
    if (entry.name.toLocaleLowerCase().startsWith(prefix)) return entry;
  }
  return null;
}

/**
 * Type-ahead search. Returns null when key cannot be used (caller keeps its own handling).
 * A fresh buffer starts after the cursor (so repeating a letter cycles); a continuation starts at the cursor.
 */
export function typeAheadMatch<T extends LetterMatch>(
  entries: readonly T[],
  currentPath: string | null,
  key: string,
  prev: TypeAheadState | null,
  now: number,
  timeoutMs = TYPEAHEAD_TIMEOUT_MS,
): TypeAheadResult<T> | null {
  const continued = !!prev && prev.buffer !== "" && now - prev.at <= timeoutMs;
  if (!(continued ? /^\P{C}$/u : /^[\p{L}\p{N}]$/u).test(key) || entries.length === 0) return null;
  const buffer = continued ? prev!.buffer + key : key;
  const needle = buffer.toLocaleLowerCase();
  const current = entries.findIndex((entry) => entry.path === currentPath);
  const after = Math.max(current, -1) + 1;
  let match: T | null;
  if (!continued) match = find(entries, after, needle);
  else {
    match = find(entries, Math.max(current, 0), needle);
    // "aa" with no "aa*" file: cycle through "a*" like Windows Explorer.
    if (!match && [...needle].every((c) => c === needle[0])) match = find(entries, after, needle[0]!);
  }
  return { state: { buffer, at: now }, match, continued };
}
