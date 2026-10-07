// Pure helpers (no Monaco import) for deciding what is text and which Monaco language to colour it with.

/** Extensions previewed as text without having to load Monaco to find out. */
export const TEXT_EXT = [
  "txt", "log", "json", "jsonc", "json5", "yaml", "yml", "ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx", "css", "scss", "less", "html", "htm", "xml", "svg",
  "csv", "tsv", "sh", "bash", "zsh", "py", "toml", "ini", "conf", "cfg", "go", "rs", "sql", "java", "c", "h", "cpp", "cc", "hpp", "cs", "rb", "php", "kt", "kts",
  "swift", "lua", "ps1", "psm1", "bat", "cmd", "graphql", "gql", "proto", "env", "gitignore", "gitattributes", "editorconfig", "dockerfile", "makefile", "mk", "r", "pl", "dart", "vue",
];
/** Extension-less file names (lower case) previewed as text. */
export const TEXT_NAMES = ["dockerfile", "makefile", "gnumakefile", "license", "readme", "changelog", "authors", ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".prettierrc", ".eslintrc"];

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();
const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");

/** Cheap, synchronous "is this a text file" decision from the name alone. */
export function isTextName(path: string): boolean {
  const name = baseName(path);
  if (TEXT_NAMES.includes(name)) return true;
  if (name.startsWith(".env.")) return true;
  return TEXT_EXT.includes(extOf(name));
}

/** Languages Monaco has no mapping for that are close enough to a bundled one. */
const FALLBACK_BY_EXT: Record<string, string> = { jsonc: "json", json5: "json", env: "ini", gitignore: "ini", gitattributes: "ini", editorconfig: "ini", cfg: "ini", conf: "ini", mk: "shell", vue: "html", psm1: "powershell", kts: "kotlin", mts: "typescript", cts: "typescript", gql: "graphql" };
const FALLBACK_BY_NAME: Record<string, string> = { ".env": "ini", ".npmrc": "ini", ".prettierrc": "json", ".eslintrc": "json", gnumakefile: "shell", makefile: "shell" };

export function fallbackLanguage(path: string): string | undefined {
  const name = baseName(path);
  if (name.startsWith(".env.")) return "ini";
  return FALLBACK_BY_NAME[name] ?? FALLBACK_BY_EXT[extOf(name)];
}

export interface LangInfo {
  id: string;
  aliases?: string[];
}
/** Fence names that are not a Monaco id or alias. */
const FENCE_EXTRA: Record<string, string> = { bash: "shell", sh: "shell", zsh: "shell", shell: "shell", shellscript: "shell", console: "shell", terminal: "shell", jsonc: "json", json5: "json", yml: "yaml", mjs: "javascript", cjs: "javascript", node: "javascript", golang: "go", rs: "rust", vue: "html", text: "plaintext", txt: "plaintext" };

/** Monaco language id for a markdown fence info string ("json", "bash title=x", "{.py}"), or undefined. */
export function fenceLanguage(info: string, languages: LangInfo[]): string | undefined {
  const first = info.trim().replace(/^\{\.?/, "").split(/[\s{},]/)[0]?.toLowerCase().replace(/^language-/, "");
  if (!first) return undefined;
  const direct = languages.find((l) => l.id.toLowerCase() === first) ?? languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === first));
  if (direct) return direct.id;
  const extra = FENCE_EXTRA[first];
  return extra && languages.some((l) => l.id === extra) ? extra : undefined;
}
