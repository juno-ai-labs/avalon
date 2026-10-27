import { loadPostHog, runsPostHog } from './posthog-loader';
import { loadApollo, runsApollo } from './apollo-loader';
import { loadXPixel, runsXPixel } from './x-pixel-loader';
import { awaitAnalyticsSession, currentSitePage, environment, initializeSiteTelemetry, takeAdClickId } from './telemetry';

// Capability pages have no acquisition telemetry, including their fragments.
if (!/^\/download(?:\/|$)/u.test(location.pathname)) {
  const notFound = currentSitePage() === 'not_found';
  const globalPrivacyControl = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  // Read before `takeAdClickId` strips it; the pixel receives it in a cookie.
  if (runsXPixel(environment(), location.pathname, notFound, globalPrivacyControl)) loadXPixel(new URL(location.href).searchParams.get('twclid'));
  // Before the PostHog SDK can read the address bar.
  takeAdClickId();
  if (!notFound && runsApollo(environment(), location.pathname)) loadApollo();
  if (runsPostHog(environment(), location.pathname, notFound)) {
    awaitAnalyticsSession();
    loadPostHog();
  }
  initializeSiteTelemetry();
}
