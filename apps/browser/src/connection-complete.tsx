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
  if (status === "connected") window.setTimeout(() => window.close(), 0);
  return <main className="entry"><a className="wordmark" href="/">Rally</a>
    <section className="entry-card"><h1>{status === "connected" ? "Connection added" : "Connection not added"}</h1>
      <p role="status">{message}</p>
      <a className="workspace-link" href="/">Return to Rally<span aria-hidden="true">→</span></a>
    </section>
  </main>;
}
