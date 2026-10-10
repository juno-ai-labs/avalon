import { loadPostHog, runsPostHog } from './posthog-loader';
import { awaitAnalyticsSession, currentSitePage, environment, initializeSiteTelemetry } from './telemetry';

// Capability pages have no acquisition telemetry, including their fragments.
if (!/^\/download(?:\/|$)/u.test(location.pathname)) {
  if (runsPostHog(environment(), currentSitePage())) {
    awaitAnalyticsSession();
    loadPostHog();
  }
  initializeSiteTelemetry();
}
