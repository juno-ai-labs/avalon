import { describe, expect, it } from 'vitest';
import { runsPostHog } from '../src/posthog-loader';

describe('which pages run the PostHog SDK', () => {
  it('runs on every page not denied, including one added later', () => {
    expect(['/', '/start-fast/', '/compare/notion/', '/blog/', '/help/', '/trust/privacy/', '/slack/', '/some-new-page/']
      .map((path) => runsPostHog('production', path, false))).toEqual([true, true, true, true, true, true, true, true]);
  });

  it('never runs on a path whose URL can carry a ticket, token or resource id, in any case', () => {
    expect(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/abc', '/APP/x', '/download'].map((path) => runsPostHog('production', path, false)))
      .toEqual([false, false, false, false, false, false, false, false]);
  });

  it('never runs on the not-found page, where a mistyped handoff link lands with its token', () => {
    expect([runsPostHog('production', '/invte/', true), runsPostHog('production', '/404.html', false)]).toEqual([false, false]);
  });

  it('never runs outside production, so local and preview visits stay out of the project', () => {
    expect([runsPostHog('development', '/', false), runsPostHog('staging', '/', false)]).toEqual([false, false]);
  });
});
