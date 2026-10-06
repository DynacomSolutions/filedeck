import { lazy, Suspense, useEffect, useId, useState } from "react";
import type { TextFile } from "./api";
import { ApiError, api } from "./api";
import { gitApi } from "./git";

const GitInlineDiffEditor = lazy(() => import("./GitInlineDiffEditor").then((module) => ({ default: module.GitInlineDiffEditor })));

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; head: TextFile; working: TextFile; workingAbsent: boolean; headAbsent: boolean };

const emptyTextFile = (path: string): TextFile => ({ path, content: "", size: 0, mtime: 0, etag: "" });

function normaliseHead(path: string, value: TextFile & { absent?: boolean }): { file: TextFile; absent: boolean } {
  if (value.absent) return { file: emptyTextFile(path), absent: true };
  if (typeof value.content !== "string") throw new Error("Git HEAD returned invalid UTF-8 or non-text content");
  return { file: { ...emptyTextFile(path), ...value }, absent: false };
}

async function readWorking(path: string, node: string): Promise<{ file: TextFile; absent: boolean }> {
  try {
    return { file: await api.readText(node, path), absent: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { file: emptyTextFile(path), absent: true };
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A compact, read-only HEAD-versus-working-tree diff for one Git change row. */
export function GitInlineDiff({ node, path }: { node: string; path: string }) {
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const modelId = useId().replace(/:/g, "");

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    Promise.allSettled([gitApi.show(node, path, "HEAD"), readWorking(path, node)]).then(([headResult, workingResult]) => {
      if (!live) return;
      if (headResult.status !== "fulfilled" || workingResult.status !== "fulfilled") {
        const errors = [
          headResult.status === "rejected" ? `HEAD: ${errorMessage(headResult.reason)}` : "",
          workingResult.status === "rejected" ? `working tree: ${errorMessage(workingResult.reason)}` : "",
        ].filter(Boolean);
        setState({ kind: "error", message: `Unable to read a text diff for ${path}: ${errors.join("; ")}` });
        return;
      }
      try {
        const head = normaliseHead(path, headResult.value);
        setState({ kind: "ready", head: head.file, headAbsent: head.absent, working: workingResult.value.file, workingAbsent: workingResult.value.absent });
      } catch (error: unknown) {
        setState({ kind: "error", message: `Unable to read a text diff for ${path}: HEAD: ${errorMessage(error)}` });
      }
    });
    return () => {
      live = false;
    };
  }, [node, path]);

  return (
    <div className="git-inline-diff" data-testid="git-inline-diff" data-path={path}>
      {state.kind === "loading" && <div className="pad muted" role="status">Loading HEAD and working tree diff...</div>}
      {state.kind === "error" && <div className="ed-banner err" role="alert">{state.message}</div>}
      {state.kind === "ready" && (
        <>
          <div className="git-inline-diff-meta muted">
            {state.headAbsent && "No HEAD version. "}
            {state.workingAbsent && "The working tree file is absent. "}
            HEAD versus working tree (read-only)
          </div>
          <div className="git-inline-diff-editor">
            <Suspense fallback={<div className="pad muted" role="status">Loading editor...</div>}>
              <GitInlineDiffEditor node={node} path={path} head={state.head} working={state.working} modelId={modelId} />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
