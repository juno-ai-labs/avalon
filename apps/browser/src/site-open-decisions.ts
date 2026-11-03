/**
 * The site-opening page's decisions, apart from React so they can be tested:
 * where to send a person once the site is open, and what to tell them when it
 * cannot be. See `docs/browser-client.md#shared-site-resources`.
 */
import { IDENTITY_REGION } from "@rally/contracts/regions";

import { BrowserApiError } from "./transport";

/**
 * The site's open URL with the path to return to. The single-use code stays
 * in the fragment, which no server sees; the return path is only a path.
 */
export function siteOpenTarget(openUrl: string, returnPath: string): string {
  const target = new URL(openUrl);
  target.searchParams.set("return", returnPath);
  return target.toString();
}

export interface SiteOpenFailure {
  title: string;
  message: string;
  /** Whether trying again could work, so the page offers it. */
  retry: boolean;
}

export function siteOpenFailure(cause: unknown, region: string): SiteOpenFailure {
  if (cause instanceof BrowserApiError) {
    if (cause.status === 404) {
      return { title: "Site not found", message: "This site doesn't exist. Check the link.", retry: false };
    }
    if (cause.status === 403) {
      return {
        title: "No access to this site",
        message: "Your account can't open this site. Ask the person who sent it to share its thread with you, or sign in with a different account.",
        retry: false,
      };
    }
    if (cause.status === 401 && region !== IDENTITY_REGION) {
      // A deployment other than Global sets its cookie only when one of its
      // organizations is opened, which needs the organization this lookup finds.
      return {
        title: "Open your organization first",
        message: "This site is in a region you haven't opened yet. Open your organization in Rally once, then use this link again.",
        retry: false,
      };
    }
    return { title: "Can't open this site", message: cause.message, retry: true };
  }
  // A fetch that never reached Rally throws a TypeError with the browser's
  // own wording, which says nothing a person can act on.
  return { title: "Can't reach Rally", message: "Check your connection and try again.", retry: true };
}
