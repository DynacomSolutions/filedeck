import { Component, lazy, Suspense, type ReactNode } from "react";

const CodeView = lazy(() => import("./CodeView"));

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Read-only code viewer with folding and line numbers; plain text while Monaco loads or if it fails. */
export function PlainOrCode({ id, name, text }: { id: string; name: string; text: string }) {
  const plain = <pre className="pv-text">{text}</pre>;
  return (
    <Boundary key={id} fallback={plain}>
      <Suspense fallback={plain}>
        <CodeView id={id} name={name} text={text} fallback={plain} />
      </Suspense>
    </Boundary>
  );
}
