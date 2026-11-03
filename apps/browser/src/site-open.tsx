import { ErrorNotice, RallyMark } from "@rally/ui/components/primitives";
import { BrowserSiteResolutionSchema, type BrowserSession } from "@rally/contracts/browser-session";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { useEffect, useState } from "react";
import { z } from "zod";

import { siteOpenFailure, siteOpenTarget, type SiteOpenFailure } from "./site-open-decisions";
import { browserRequest } from "./transport";

/** The one field this page needs from opening a site. */
const SiteOpenedSchema = z.object({ openUrl: HttpUrlSchema });

/**
 * Opens a site for a signed-in person, then hands them to it.
 *
 * A protected site sends a visitor with no site session here, as
 * `/app/sites/<region>/<stub>/<return path>`. Signing in happens on the
 * ordinary sign-in card, which brings an `/app/` path back with it; this page
 * then finds the site's organization, opens it for this browser, mints the
 * site's single-use access code and goes to the site at the path the person
 * was trying to reach. See `docs/browser-client.md#shared-site-resources`.
 *
 * Rendered with the signed-in user's id as its key, so a change of account
 * starts over rather than finishing the previous account's open.
 */
export function SiteOpening({ region, hostnameStub, returnPath, openWorkspace, onSignOut }: {
  region: string;
  hostnameStub: string;
  returnPath: string;
  openWorkspace: (region: string, workspaceId: string) => Promise<BrowserSession>;
  onSignOut: () => void;
}) {
  const [failure, setFailure] = useState<SiteOpenFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      const site = await browserRequest(region, "/sites/resolve", BrowserSiteResolutionSchema, { hostnameStub });
      if (!active) return;
      await openWorkspace(region, site.workspaceId);
      if (!active) return;
      // Workspace routes cross the browser adapter under the organization's id.
      const opened = await browserRequest(region, `/api/${site.workspaceId}/resources/${site.resourceId}/artifact/open`, SiteOpenedSchema, {});
      if (active) location.replace(siteOpenTarget(opened.openUrl, returnPath));
    })().catch((cause: unknown) => {
      if (active) setFailure(siteOpenFailure(cause, region));
    });
    return () => { active = false; };
  }, [region, hostnameStub, returnPath, openWorkspace, attempt]);

  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={!failure}>
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{failure ? failure.title : "Opening the site…"}</h1>
      {failure ? <>
        <ErrorNotice title={failure.title} detailsLabel="Details">{failure.message}</ErrorNotice>
        {failure.retry
          ? <button className="text-button onboarding-signout" type="button" onClick={() => { setFailure(null); setAttempt((count) => count + 1); }}>Try again</button>
          : null}
        <a className="text-button onboarding-signout" href="/">Your organizations</a>
        <button className="text-button onboarding-signout" type="button" onClick={onSignOut}>Use a different account</button>
      </> : <p className="entry-lead" role="status">One moment.</p>}
    </section>
  </main>;
}
