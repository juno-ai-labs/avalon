// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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

describe('loading the PostHog script', () => {
  it.each(['error', 'load'])('releases held events with the page session when the script fires %s without providing one', async (settled) => {
    vi.resetModules();
    const sent: Array<{ sessionId?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/telemetry/route')) return Response.json({ route: 'global', routingBasis: 'ip_geolocation', routeToken: 'r'.repeat(40) });
      if (url.endsWith('/telemetry/bootstrap')) {
        return Response.json({ journeyId: '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a', route: 'global', routingBasis: 'ip_geolocation', capability: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      sent.push(...(JSON.parse(String(init?.body)) as { events: Array<{ context: { sessionId?: string } }> }).events.map((event) => event.context));
      return new Response(null, { status: 202 });
    }));
    document.head.innerHTML = '<meta name="rally-posthog-src" content="/assets/posthog-missing.js">';
    const telemetry = await import('../src/telemetry');
    const { loadPostHog } = await import('../src/posthog-loader');
    telemetry.awaitAnalyticsSession();
    loadPostHog();
    telemetry.initializeSiteTelemetry();

    const script = document.head.querySelector<HTMLScriptElement>('script[src="/assets/posthog-missing.js"]');
    expect(script?.type).toBe('module');
    // Held until the script settles: nothing is sent while it is loading.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
    script!.dispatchEvent(new Event(settled));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});

