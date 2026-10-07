// Loaded only inside the lazy editor chunk. Monaco is bundled locally (no CDN):
// @monaco-editor/react is pointed at the bundled module and workers come from Vite.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import DOMPurify from "dompurify";
import { fallbackLanguage, fenceLanguage } from "./highlight";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

export const monacoTheme = () => {
  const t = document.documentElement.dataset.theme;
  const dark = t !== "light"; // the bundled theme is dark by default; Auto follows it
  return dark ? "vs-dark" : "vs";
};

/** Monaco picks the language from the model URI; this is the display name for the header. */
export const modelUri = (node: string, path: string) => `inmemory://filedeck/${encodeURIComponent(node)}${path.split("/").map(encodeURIComponent).join("/")}`;

/** Resolve Monaco's bundled language by exact filename first, then longest matching extension. */
export function languageForPath(path: string): string | undefined {
  return resolveLanguage(path) ?? fallbackLanguage(path);
}

function resolveLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const languages = monaco.languages.getLanguages();
  const named = languages.find((language) => language.filenames?.some((filename) => filename.toLowerCase() === name));
  if (named) return named.id;
  return languages
    .filter((language) => language.extensions?.some((extension) => name.endsWith(extension.toLowerCase())))
    .sort((a, b) => Math.max(...(b.extensions ?? []).map((extension) => extension.length)) - Math.max(...(a.extensions ?? []).map((extension) => extension.length)))[0]?.id;
}

/** Monaco language for a markdown fence info string. */
export const languageForFence = (info: string) => fenceLanguage(info, monaco.languages.getLanguages());

// Colorized output carries mtk* classes whose colours live in a stylesheet Monaco injects when a theme is
// applied, so apply it up front and follow later theme switches even when no editor is mounted.
let themeHooked = false;
function syncTheme() {
  monaco.editor.setTheme(monacoTheme());
  if (themeHooked) return;
  themeHooked = true;
  new MutationObserver(() => monaco.editor.setTheme(monacoTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/** Tokenise text with Monaco and return markup made of <span class="mtk*"> and <br/> only (sanitised again here). */
export async function colorizeSafe(text: string, languageId: string): Promise<string> {
  syncTheme();
  // creating a model activates the language (lazy tokenizer / JSON mode) the way an editor would
  monaco.editor.createModel("", languageId).dispose();
  await tokenizerReady(languageId);
  const html = await monaco.editor.colorize(text, languageId, { tabSize: 4 });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["span", "br"], ALLOWED_ATTR: ["class"] });
}

/** Wait (at most 2 s) until the language's tokenizer is registered; JSON/TS ones arrive from a lazy mode chunk. */
interface TokenRegistry {
  getOrCreate(id: string): Promise<unknown>;
  get(id: string): unknown;
  onDidChange(cb: (e: { changedLanguages: string[] }) => void): monaco.IDisposable;
}
async function tokenizerReady(languageId: string): Promise<void> {
  // internal module (no public typings); same instance the editor core uses
  // @ts-ignore
  const { TokenizationRegistry: registry } = (await import("monaco-editor/editor/common/languages")) as { TokenizationRegistry: TokenRegistry };
  if ((await registry.getOrCreate(languageId)) || registry.get(languageId)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = registry.onDidChange((e) => e.changedLanguages.includes(languageId) && done());
    const timer = setTimeout(done, 2000);
  });
}
