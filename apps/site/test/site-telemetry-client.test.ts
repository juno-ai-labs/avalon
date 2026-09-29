// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('site telemetry reporter', () => {
  it('sends a click made before bootstrap with keepalive and never an empty batch', async () => {
    let releaseBootstrap!: () => void;
    const bootstrapped = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const sent: Array<{ keepalive: boolean; names: string[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/telemetry/route')) {
        return Response.json({ route: 'global', routingBasis: 'ip_geolocation', routeToken: 'r'.repeat(40) });
      }
      if (url.endsWith('/telemetry/bootstrap')) {
        await bootstrapped;
        return Response.json({
          journeyId: '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a',
          route: 'global',
          routingBasis: 'ip_geolocation',
          capability: 'c'.repeat(40),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      const body = JSON.parse(String(init?.body)) as { events: Array<{ name: string }> };
      sent.push({ keepalive: init?.keepalive === true, names: body.events.map((event) => event.name) });
      return new Response(null, { status: 202 });
    }));
    document.body.innerHTML = '<a data-site-action="download-pricing-max" href="#">Download</a>';

    const { initializeSiteTelemetry } = await import('../src/telemetry');
    initializeSiteTelemetry();
    document.querySelector('a')!.click();
    releaseBootstrap();

    await vi.waitFor(() => expect(sent.flatMap((request) => request.names)).toContain('site_action_selected'));
    const click = sent.find((request) => request.names.includes('site_action_selected'))!;
    expect(click.keepalive).toBe(true);
    expect(sent.every((request) => request.names.length > 0)).toBe(true);
  });
});
