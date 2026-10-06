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
  const hostRef = useRef<HTMLDivElement>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const [contentHeight, setContentHeight] = useState(180);
  const theme = useTheme();
  const modelRoot = modelUri(node, path);
  const modelSuffix = encodeURIComponent(modelId);
  const language = languageForPath(path);
  useEffect(() => () => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
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
  const attachHorizontalWheel = (editor: MonacoEditor.IStandaloneDiffEditor) => {
    const host = hostRef.current;
    if (!host) return;
    wheelCleanupRef.current?.();
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Preserve browser zoom gestures.
      const shiftedVertical = event.deltaX === 0 && event.shiftKey;
      const horizontalDelta = event.deltaX || (shiftedVertical ? event.deltaY : 0);
      if (!horizontalDelta) return;

      const original = editor.getOriginalEditor();
      const modified = editor.getModifiedEditor();
      const target = event.target instanceof Node ? event.target : null;
      const targetEditor = target && original.getContainerDomNode().contains(target) ? original
        : target && modified.getContainerDomNode().contains(target) ? modified
        : null;
      if (!targetEditor) return;

      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? targetEditor.getLayoutInfo().width
        : 1;
      const maxScroll = Math.max(0, targetEditor.getScrollWidth() - targetEditor.getLayoutInfo().width);
      targetEditor.setScrollLeft(Math.max(0, Math.min(maxScroll, targetEditor.getScrollLeft() + horizontalDelta * unit)));

      // For diagonal trackpad gestures, leave the event untouched so its vertical
      // component continues to the Properties panel's scroll owner.
      if (shiftedVertical || event.deltaY === 0) event.preventDefault();
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: false });
    wheelCleanupRef.current = () => host.removeEventListener("wheel", onWheel, true);
  };
  return (
    <div ref={hostRef}>
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
      onMount={(editor) => { editorRef.current = editor; attachHorizontalWheel(editor); resizeRef.current?.(); resizeRef.current = updateContentHeight(editor); }}
      loading={<div className="pad muted">Loading editor...</div>}
    />
    </div>
  );
}
