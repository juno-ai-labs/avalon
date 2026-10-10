import posthog from 'posthog-js/dist/module.full.no-external';
import { currentSitePage, globalAnonymousEpochId, provideAnalyticsSession } from './telemetry';

// The project's public ingestion token. It can only send events, which is why
// PostHog designs it to sit in page source; it reads nothing back.
const POSTHOG_PROJECT_TOKEN = 'phc_DdHrRpgL7QujHkP4dMRaWyiBJZ94pNxAVuAv4Eurk3FR';
// PostHog's managed reverse proxy for this project, on our own domain so
// blockers that drop PostHog's hosts still let it through.
const POSTHOG_PROXY_HOST = 'https://p.rallywith.ai';

/**
 * Starts PostHog's full browser SDK under the site's own anonymous id, with
 * session replay, heatmaps and autocapture. Page views and page leaves stay
 * with the site's reporter, which sends them through the API; the SDK sends
 * neither, so PostHog gets each one once. The full bundle carries the
 * recorder, heatmaps and dead-click capture, so nothing loads from PostHog's
 * CDN under the site's script policy.
 */
function startPostHog(): (() => string) | null {
  try {
    posthog.init(POSTHOG_PROJECT_TOKEN, {
      api_host: POSTHOG_PROXY_HOST,
      ui_host: 'https://us.posthog.com',
      defaults: '2026-08-30',
      bootstrap: { distinctID: globalAnonymousEpochId() },
      // Beside the site's own id in localStorage, so clearing one clears both
      // and the SDK never reports a different visitor than the API does.
      persistence: 'localStorage',
      person_profiles: 'always',
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: true,
      enable_heatmaps: true,
      capture_exceptions: true,
      capture_performance: true,
      enable_recording_console_log: true,
      // Every session, whatever the project's own sample rate is set to.
      session_recording: { sampleRate: 1 },
    });
    posthog.register({ page: currentSitePage(), source: 'site', release: __RALLY_SITE_RELEASE__ });
    return () => posthog.get_session_id();
  } catch {
    return null;
  }
}

provideAnalyticsSession(startPostHog());
