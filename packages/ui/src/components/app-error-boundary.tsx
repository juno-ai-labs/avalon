import { Component, type ErrorInfo, type PropsWithChildren } from "react";
import { Button, ErrorNotice, RallyMark } from "./primitives";

export class AppErrorBoundary extends Component<PropsWithChildren<{ onError?: (error: Error, info: ErrorInfo) => void }>, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-error-screen window-drag">
          <section className="fatal-error-card window-no-drag">
            <RallyMark />
            <h1>Reopen this view</h1>
            <div className="fatal-error-actions">
              <ErrorNotice detailsLabel="View details" occurrence={this.state.error} title="Rally needs to reopen this view">{this.state.error.message}</ErrorNotice>
              <Button className="button-primary" onClick={() => window.location.reload()}>Reload Rally</Button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

