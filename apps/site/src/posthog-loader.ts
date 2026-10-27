import { allowsThirdPartyScripts } from './credential-paths';
import { provideAnalyticsSession } from './telemetry';

export function runsPostHog(environment: 'development' | 'staging' | 'production', pathname: string, notFound: boolean): boolean {
  return environment === 'production' && !notFound && allowsThirdPartyScripts(pathname);
}

/**
 * Adds the PostHog entry (`src/posthog.ts`) as its own script, so pages that
 * never run it do not download it. The page names the entry in a
 * `rally-posthog-src` meta tag; in development that is the source file, and
 * the build rewrites it to the hashed bundle (see `rally-posthog-entry` in
 * vite.config.ts). A script that fails to load or to run releases the held
 * events.
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
  // A module that throws while it runs fires `load`, not `error`. The entry
  // provides its session while it runs, before `load`, so on success this
  // later call does nothing.
  script.addEventListener('load', () => provideAnalyticsSession(null), { once: true });
  document.head.append(script);
}
