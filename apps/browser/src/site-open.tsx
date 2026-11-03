import { ErrorNotice, RallyMark } from "@rally/ui/components/primitives";
import { BrowserSiteResolutionSchema, type BrowserSession } from "@rally/contracts/browser-session";
import { IDENTITY_REGION } from "@rally/contracts/regions";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { useEffect, useState } from "react";
import { z } from "zod";

import { browserRequest, BrowserApiError } from "./transport";

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
 * was trying to reach. See `docs/live-web-artifacts.md`.
 */
export function SiteOpening({ region, hostnameStub, returnPath, openWorkspace, onSignOut }: {
  region: string;
  hostnameStub: string;
  returnPath: string;
  openWorkspace: (region: string, workspaceId: string) => Promise<BrowserSession>;
  onSignOut: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      const site = await browserRequest(region, "/sites/resolve", BrowserSiteResolutionSchema, { hostnameStub });
      await openWorkspace(region, site.workspaceId);
      const opened = await browserRequest(region, `/resources/${site.resourceId}/artifact/open`, SiteOpenedSchema, {});
      const target = new URL(opened.openUrl);
      // The code stays in the fragment; the return path is only a path.
      target.searchParams.set("return", returnPath);
      if (active) location.replace(target.toString());
    })().catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof BrowserApiError && cause.status === 404) {
        setFailure("This site doesn't exist, or your account can't open it. Check you're signed in with the right account.");
      } else if (cause instanceof BrowserApiError && cause.status === 401 && region !== IDENTITY_REGION) {
        // A deployment other than Global sets its cookie only when one of its
        // organizations is opened, which needs the organization this lookup finds.
        setFailure("Open your organization in Rally once, then use this link again.");
      } else {
        setFailure(cause instanceof Error ? cause.message : "Unable to open this site. Try again.");
      }
    });
    return () => { active = false; };
  }, [region, hostnameStub, returnPath, openWorkspace]);

  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={!failure}>
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{failure ? "Can't open this site" : "Opening the site…"}</h1>
      {failure ? <>
        <ErrorNotice>{failure}</ErrorNotice>
        <a className="text-button onboarding-signout" href="/">Your organizations</a>
        <button className="text-button onboarding-signout" type="button" onClick={onSignOut}>Sign out</button>
      </> : <p className="entry-lead" role="status">One moment.</p>}
    </section>
  </main>;
}
