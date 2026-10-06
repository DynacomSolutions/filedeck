import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { languageForPath, modelUri, monacoTheme } from "./monacoSetup";
import type { TextFile } from "./api";

const OPTIONS: MonacoEditor.IStandaloneDiffEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  readOnly: true,
  domReadOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  useInlineViewWhenSpaceIsLimited: false,
  scrollbar: { vertical: "hidden", handleMouseWheel: false, alwaysConsumeMouseWheel: false },
};

function useTheme() {
  const [theme, setTheme] = useState(monacoTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(monacoTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(monacoTheme());
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

export function GitInlineDiffEditor({ node, path, head, working, modelId }: { node: string; path: string; head: TextFile; working: TextFile; modelId: string }) {
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const [contentHeight, setContentHeight] = useState(180);
  const theme = useTheme();
  const modelRoot = modelUri(node, path);
  const modelSuffix = encodeURIComponent(modelId);
  const language = languageForPath(path);
  useEffect(() => () => {
    const editor = editorRef.current;
    editorRef.current = null;
    const models = editor ? [editor.getOriginalEditor().getModel(), editor.getModifiedEditor().getModel()] : [];
    try {
      editor?.setModel(null);
    } catch {
      /* wrapper already disposed */
    }
    setTimeout(() => models.forEach((model) => model?.dispose()), 0);
  }, []);
  const updateContentHeight = (editor: MonacoEditor.IStandaloneDiffEditor) => {
    const original = editor.getOriginalEditor();
    const modified = editor.getModifiedEditor();
    const update = () => setContentHeight(Math.max(180, Math.ceil(Math.max(original.getContentHeight(), modified.getContentHeight())) + 8));
    update();
    const originalSub = original.onDidContentSizeChange(update);
    const modifiedSub = modified.onDidContentSizeChange(update);
    return () => { originalSub.dispose(); modifiedSub.dispose(); };
  };
  const resizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeRef.current?.(), []);
  return (
    <DiffEditor
      originalLanguage={language}
      modifiedLanguage={language}
      originalModelPath={`${modelRoot}?git-accordion=${modelSuffix}&side=head`}
      modifiedModelPath={`${modelRoot}?git-accordion=${modelSuffix}&side=working`}
      original={head.content}
      modified={working.content}
      theme={theme}
      options={OPTIONS}
      height={contentHeight}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => { editorRef.current = editor; resizeRef.current?.(); resizeRef.current = updateContentHeight(editor); }}
      loading={<div className="pad muted">Loading editor...</div>}
    />
  );
}
