import { describe, expect, it } from 'vitest';
import { runsPostHog } from '../src/posthog-loader';
import { sitePageForPath } from '../src/telemetry';

describe('which pages run the PostHog SDK', () => {
  it('runs on the public marketing, help and policy pages in production', () => {
    expect(['/', '/start-fast/', '/compare/notion/', '/blog/', '/help/', '/trust/privacy/']
      .map((path) => runsPostHog('production', sitePageForPath(path)))).toEqual([true, true, true, true, true, true]);
  });

  it('never runs on a page whose URL can carry a ticket, token or resource id', () => {
    expect(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/:id', '/404.html']
      .map((path) => runsPostHog('production', sitePageForPath(path)))).toEqual([false, false, false, false, false, false, false]);
  });

  it('never runs outside production, so local and preview visits stay out of the project', () => {
    expect([runsPostHog('development', 'landing'), runsPostHog('staging', 'landing')]).toEqual([false, false]);
  });
});
