import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorText, isChunkError, keysChanged } from "./errorText";

interface Props {
  /** what failed, in words: "Filedeck", "The diff viewer", "This panel" */
  what: string;
  /** the whole app (full-page message) or one part of it (message in place) */
  scope?: "root" | "view";
  /** the boundary clears itself when these change (for example the panel's folder) */
  resetKeys?: readonly unknown[];
  /** called when the user closes a failed view */
  onClose?: () => void;
  children: ReactNode;
}
interface State {
  error: unknown;
  failed: boolean;
}

/** Catches render and lazy-load errors so one failing view does not unmount the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Filedeck view failed", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.failed && keysChanged(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null, failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { what, scope = "view", onClose } = this.props;
    const stale = isChunkError(this.state.error);
    return (
      <div className={"pad" + (scope === "root" ? " app-error" : "")} role="alert">
        <p><b>{what} stopped working.</b> {stale ? "The page may be older than the server. Reload to get the current version." : "Your changes in other views are not affected."}</p>
        <p className="muted">{errorText(this.state.error)}</p>
        <p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
          {scope === "view" && !stale && <>{" "}<button type="button" onClick={() => this.setState({ error: null, failed: false })}>Try again</button></>}
          {onClose && <>{" "}<button type="button" onClick={onClose}>Close</button></>}
        </p>
      </div>
    );
  }
}
