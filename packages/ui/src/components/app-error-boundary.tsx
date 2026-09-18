import { Component, type ErrorInfo, type PropsWithChildren } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./primitives";

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
            <AlertTriangle aria-hidden="true" size={22} />
            <h1>Rally needs to reopen this view</h1>
            <p>{this.state.error.message}</p>
            <Button className="button-primary" onClick={() => window.location.reload()}>Reload Rally</Button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

