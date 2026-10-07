// Read-only Monaco viewer (line numbers, folding, theme-aware). Loaded lazily; one editor per preview,
// disposed (with its model) when the file changes or the preview closes.
import { Editor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useTheme } from "./EditorViews";
import { languageForPath } from "./monacoSetup";

const OPTS: MonacoEditor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  lineNumbers: "on",
  folding: true,
  showFoldingControls: "always",
  wordWrap: "on",
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  fontSize: 13,
  tabSize: 2,
  contextmenu: false,
  occurrencesHighlight: "off",
  selectionHighlight: false,
  scrollbar: { alwaysConsumeMouseWheel: false },
};

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36);

export default function CodeView({ id, name, text, fallback }: { id: string; name: string; text: string; fallback: React.ReactNode }) {
  const theme = useTheme();
  return (
    <div className="pv-code">
      <Editor
        path={`inmemory://filedeck-preview/${hash(id)}/${encodeURIComponent(name)}`}
        language={languageForPath(name)}
        value={text}
        theme={theme}
        options={OPTS}
        loading={fallback}
      />
    </div>
  );
}
