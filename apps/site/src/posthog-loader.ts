import { provideAnalyticsSession } from './telemetry';

/**
 * Paths that never run the PostHog SDK. Every other page records by default,
 * so a new page is covered without an edit here. These pages carry sign-in
 * tickets, invitation tokens, download grants or resource ids in their URL,
 * which a recording would keep. A new page that receives a credential in its
 * URL must be added here before it ships.
 */
const RECORDING_DENIED_PATHS: readonly RegExp[] = [
  /^\/download(?:\/|$)/u,
  /^\/invite(?:\/|$)/u,
  /^\/auth\//u,
  /^\/slack\/link(?:\/|$)/u,
  /^\/open(?:\/|$)/u,
  /^\/app(?:\/|$)/u,
  // Not a path but the 404 page: a mistyped handoff link lands here with its
  // token still in the URL.
  /^\/404(?:\.html)?$/u,
];

/** Whether a third-party script may run on this path: not one in `RECORDING_DENIED_PATHS`. */
export function allowsThirdPartyScripts(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return !RECORDING_DENIED_PATHS.some((denied) => denied.test(path));
}

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
