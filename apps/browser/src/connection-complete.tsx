import { ChevronRight } from "lucide-react";
import { RallyMark } from "@rally/ui/components/primitives";
import { useEffect } from "react";
/**
 * Where a connector authorization started in this browser returns. The tab
 * that asked is still open and reconciles from the attempt itself, so this
 * page only says what happened and closes itself when it can: a popup can,
 * and a tab that the person navigated away from cannot.
 */
export function ConnectionComplete(): React.JSX.Element {
  const query = new URLSearchParams(location.search);
  const status = query.get("status");
  const message = status === "connected" ? "Connected. You can close this tab."
    : status === "denied" ? "The connection was cancelled. You can close this tab."
    : "The connection did not complete. Close this tab and try again from Rally.";
  // Only a window a script opened can close itself; elsewhere this does nothing.
  useEffect(() => { if (status === "connected") window.close(); }, [status]);
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card">
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{status === "connected" ? "Connection added" : "Connection not added"}</h1>
      <p role="status">{message}</p>
      <div className="signin-choice-list"><a className="signin-choice" href="/"><span className="signin-choice-name">Return to Rally</span><ChevronRight aria-hidden="true" size={16} /></a></div>
    </section>
  </main>;
}
