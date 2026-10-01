// Loaded only inside the lazy editor chunk. Monaco is bundled locally (no CDN):
// @monaco-editor/react is pointed at the bundled module and workers come from Vite.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
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
  const dark = t !== "light"; // Studio default is dark; Auto follows it, like the other Filedeck pages
  return dark ? "vs-dark" : "vs";
};

/** Monaco picks the language from the model URI; this is the display name for the header. */
export const modelUri = (node: string, path: string) => `inmemory://filedeck/${encodeURIComponent(node)}${path.split("/").map(encodeURIComponent).join("/")}`;
