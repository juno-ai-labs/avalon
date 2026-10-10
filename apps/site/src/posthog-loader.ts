import type { TelemetryEventProperties } from '@rally/contracts/telemetry';
import { provideAnalyticsSession } from './telemetry';

type SitePage = TelemetryEventProperties<'site_page_viewed'>['page'];

/**
 * Pages that run the PostHog SDK: the landing, its variants and compare
 * pages, the blog, help and the Trust Center. Handoff and download pages
 * carry tickets, invitation tokens and fragments in their URLs, which the
 * SDK would record, so they never load it.
 */
const RECORDED_PAGES = new Set<SitePage>(['landing', 'support', 'legal']);

export function runsPostHog(environment: 'development' | 'staging' | 'production', page: SitePage): boolean {
  return environment === 'production' && RECORDED_PAGES.has(page);
}

/**
 * Adds the PostHog entry (`src/posthog.ts`) as its own script, so pages that
 * never run it do not download it. The page names the entry in a
 * `rally-posthog-src` meta tag; in development that is the source file, and
 * the build rewrites it to the hashed bundle (see `rally-posthog-entry` in
 * vite.config.ts). A script that fails to load releases the held events.
 */
export function loadPostHog(): void {
  const source = document.querySelector<HTMLMetaElement>('meta[name="rally-posthog-src"]')?.content;
  if (!source) {
    provideAnalyticsSession(null);
    return;
  }
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  script.addEventListener('error', () => provideAnalyticsSession(null), { once: true });
  document.head.append(script);
}
