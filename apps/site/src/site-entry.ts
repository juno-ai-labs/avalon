import { loadPostHog, runsPostHog } from './posthog-loader';
import { loadApollo, runsApollo } from './apollo-loader';
import { awaitAnalyticsSession, currentSitePage, environment, initializeSiteTelemetry, takeAdClickId } from './telemetry';

// Capability pages have no acquisition telemetry, including their fragments.
if (!/^\/download(?:\/|$)/u.test(location.pathname)) {
  // Before the PostHog SDK can read the address bar.
  takeAdClickId();
  if (currentSitePage() !== 'not_found' && runsApollo(environment(), location.pathname)) loadApollo();
  if (runsPostHog(environment(), location.pathname, currentSitePage() === 'not_found')) {
    awaitAnalyticsSession();
    loadPostHog();
  }
  initializeSiteTelemetry();
}
