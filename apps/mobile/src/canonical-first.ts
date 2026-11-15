import type { NativeArtifact } from './protocol';

/**
 * What a hosted canvas view should hold when Home delivers fresh access.
 *
 * A view already showing the same site on its cookie (canonical URL) keeps it:
 * Home's one-time URL would only redeem a cookie the view already has and reload
 * the page. A newer version is taken, which reloads the view; another artifact,
 * another site, or a renewal the view asked for takes the fresh access.
 */
export function acceptFreshAccess(current: NativeArtifact | undefined, fresh: NativeArtifact, renewing: boolean): NativeArtifact {
  const onCookie = current !== undefined && current.openUrl === current.canonicalUrl;
  if (!onCookie || renewing || current.resourceId !== fresh.resourceId || current.canonicalUrl !== fresh.canonicalUrl) return fresh;
  return fresh.version > current.version ? { ...current, version: fresh.version } : current;
}
