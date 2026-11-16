import { ChevronRight } from "lucide-react";
import { ConnectorOAuthClaimSchema, parseConnectorClaimLink } from "@rally/contracts/connector-oauth-claim";
import { RallyMark } from "@rally/ui/components/primitives";
import { useEffect, useState } from "react";
import { BrowserApiError, browserRequest } from "./transport";

type Outcome = { status: string | null; message: string | null };

/**
 * Where a connector authorization started in this browser returns. The tab
 * that asked is still open and reconciles from the attempt itself, so this
 * page only says what happened and closes itself when it can: a popup can,
 * and a tab that the person navigated away from cannot.
 *
 * An authorization the provider has just answered arrives `authorized`, with a
 * ticket in the fragment: Rally holds it until this browser's own session
 * claims it (`docs/connectors.md`, "Claiming a connector authorization").
 */
export function ConnectionComplete(): React.JSX.Element {
  const [claim] = useState(() => parseConnectorClaimLink(location.href));
  const [outcome, setOutcome] = useState<Outcome | null>(() =>
    claim ? null : { status: new URLSearchParams(location.search).get("status"), message: null });
  useEffect(() => {
    if (!claim) return;
    // The ticket is single-use; keep it out of history and a reload.
    history.replaceState(null, document.title, location.pathname);
    let current = true;
    void browserRequest(claim.region, `/api/${claim.workspaceId}/connections/oauth/claim`, ConnectorOAuthClaimSchema, { ticket: claim.ticket })
      .then(({ target }) => new URL(target).searchParams.get("status"))
      .then((status) => { if (current) setOutcome({ status, message: null }); })
      .catch((error: unknown) => {
        if (!current) return;
        setOutcome({
          status: "failed",
          message: error instanceof BrowserApiError && error.status === 401 && error.code !== "invalid_oauth_state"
            ? "Sign in to Rally in this browser, then start the connection again."
            : error instanceof BrowserApiError ? error.message : null,
        });
      });
    return () => { current = false; };
  }, [claim]);
  const status = outcome?.status ?? null;
  const message = outcome === null ? "Finishing the connection…"
    : outcome.message ? outcome.message
    : status === "connected" ? "Connected. You can close this tab."
    : status === "denied" ? "The connection was cancelled. You can close this tab."
    : "The connection did not complete. Close this tab and try again from Rally.";
  // Only a window a script opened can close itself; elsewhere this does nothing.
  useEffect(() => { if (status === "connected") window.close(); }, [status]);
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card">
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{outcome === null ? "Connecting…" : status === "connected" ? "Connection added" : "Connection not added"}</h1>
      <p role="status">{message}</p>
      <div className="signin-choice-list"><a className="signin-choice" href="/"><span className="signin-choice-name">Return to Rally</span><ChevronRight aria-hidden="true" size={16} /></a></div>
    </section>
  </main>;
}
