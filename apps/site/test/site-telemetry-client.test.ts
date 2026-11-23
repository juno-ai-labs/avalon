// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Sent { keepalive: boolean; capability: string; events: Array<{ name: string; properties: Record<string, unknown>; context: { sessionId?: string } }> }

/** A stub Global API: route, bootstrap and ingest, with scripted ingest statuses. */
function stubApi(options: { statuses?: number[]; bootstrapped?: Promise<void> } = {}) {
  const statuses = [...(options.statuses ?? [])];
  const sent: Sent[] = [];
  const anonymousIds: string[] = [];
  const bootstrapBodies: Array<Record<string, unknown>> = [];
  let bootstraps = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/telemetry/route')) {
      return Response.json({ route: 'global', routingBasis: 'ip_geolocation', routeToken: 'r'.repeat(40) });
    }
    if (url.endsWith('/telemetry/bootstrap')) {
      await options.bootstrapped;
      const body = JSON.parse(String(init?.body)) as { anonymousEpochId: string };
      anonymousIds.push(body.anonymousEpochId);
      bootstrapBodies.push(body);
      bootstraps += 1;
      return Response.json({
        journeyId: '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a',
        route: 'global',
        routingBasis: 'ip_geolocation',
        capability: String(bootstraps).repeat(40),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    sent.push({ keepalive: init?.keepalive === true, ...JSON.parse(String(init?.body)) as Omit<Sent, 'keepalive'> });
    return new Response(null, { status: statuses.shift() ?? 202 });
  }));
  return { sent, anonymousIds, bootstrapBodies, clicks: () => sent.flatMap((request) => request.events).filter((event) => event.name === 'site_action_selected') };
}

async function start(html: string, session?: (() => string) | null) {
  document.body.innerHTML = html;
  const telemetry = await import('../src/telemetry');
  if (session !== undefined) telemetry.awaitAnalyticsSession();
  telemetry.initializeSiteTelemetry();
  // The SDK arrives after the page view is queued, as its separate script does.
  if (session !== undefined) setTimeout(() => telemetry.provideAnalyticsSession(session), 0);
  return telemetry;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// jsdom keeps one `document` and `window` per file, so each fresh import of
// the reporter would stack another click and pagehide listener on the last
// test's.
const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
const addListener = document.addEventListener.bind(document);
const addWindowListener = window.addEventListener.bind(window);

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([document, type, listener, options]);
    addListener(type, listener, options);
  });
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([window, type, listener, options]);
    addWindowListener(type, listener, options);
  });
});

afterEach(() => {
  for (const [target, type, listener, options] of listeners.splice(0)) target.removeEventListener(type, listener, options);
});

describe('site telemetry reporter', () => {
  it('reports Linux download intent without changing the direct Debian package link', async () => {
    const api = stubApi();
    await start('<a data-site-action="download-linux-hero" href="https://downloads.rallywith.ai/stable/linux/x64/Rally.deb" download>Download for Linux</a>');
    const link = document.querySelector<HTMLAnchorElement>('a')!;
    link.addEventListener('click', (event) => event.preventDefault());
    link.click();
    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]?.properties).toEqual({ page: 'landing', pathname: '/', action: 'download', placement: 'hero' });
    expect(link.href).toBe('https://downloads.rallywith.ai/stable/linux/x64/Rally.deb');
  });

  it('joins the web CTA to its destination flow without changing the direct Mac download', async () => {
    const api = stubApi();
    await start('<a id="web" data-site-action="web-app-hero" href="https://app.rallywith.ai">Use the web app</a><a id="mac" data-site-action="download-hero" href="https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg" download>Download the macOS beta</a>');
    const web = document.querySelector<HTMLAnchorElement>('#web')!;
    expect(new URL(web.href).searchParams.has('signupFlowId')).toBe(false);
    web.addEventListener('click', (event) => event.preventDefault());
    web.click();
    const flowId = new URL(web.href).searchParams.get('signupFlowId');
    expect(flowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const mac = document.querySelector<HTMLAnchorElement>('#mac')!;
    mac.addEventListener('click', (event) => event.preventDefault());
    mac.click();
    await vi.waitFor(() => expect(api.clicks()).toHaveLength(2));
    expect(api.clicks().map((event) => event.properties)).toEqual([
      { page: 'landing', pathname: '/', action: 'secondary_cta', placement: 'hero', flowId },
      { page: 'landing', pathname: '/', action: 'download', placement: 'hero' },
    ]);
    expect(mac.href).toBe('https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg');
  });

  it('starts a signup flow from the pilot offer and reports it under its own placement', async () => {
    const api = stubApi();
    await start('<a data-site-action="web-app-offer" href="https://app.rallywith.ai">Sign up</a>');
    const link = document.querySelector<HTMLAnchorElement>('a')!;
    link.addEventListener('click', (event) => event.preventDefault());
    link.click();
    const flowId = new URL(link.href).searchParams.get('signupFlowId');
    expect(flowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]?.properties).toEqual({ page: 'landing', pathname: '/', action: 'primary_cta', placement: 'offer', flowId });
  });

  it('mints distinct matched flows for repeated and middle-click activations and restores a clean copyable link', async () => {
    const api = stubApi();
    await start('<a data-site-action="web-app-hero" href="https://app.rallywith.ai/?keep=yes#anchor">Use the web app</a>');
    const link = document.querySelector<HTMLAnchorElement>('a')!;
    link.addEventListener('click', event => event.preventDefault());
    link.addEventListener('auxclick', event => event.preventDefault());
    link.click();
    const first = new URL(link.href).searchParams.get('signupFlowId');
    link.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    const second = new URL(link.href).searchParams.get('signupFlowId');
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(api.clicks()).toHaveLength(2));
    expect(api.clicks().map(event => event.properties['flowId'])).toEqual([first, second]);
    await vi.waitFor(() => expect(link.href).toBe('https://app.rallywith.ai/?keep=yes#anchor'));
  });

  it('names the marketing page a click came from', async () => {
    const api = stubApi();
    history.replaceState(null, '', '/canvases/');
    await start('<a data-site-action="download-hero" href="#">Download the macOS beta</a>');
    document.querySelector<HTMLElement>('a')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]!.properties).toEqual({ page: 'landing', pathname: '/canvases/', action: 'download', placement: 'hero' });
  });

  it('reports a click inside a tagged link with its closed values and keepalive', async () => {
    const api = stubApi();
    await start('<a data-site-action="download-pricing-grow" href="#"><span>Download</span></a>');
    document.querySelector('span')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]!.properties).toEqual({ page: 'landing', pathname: '/', action: 'download', placement: 'pricing', plan: 'grow' });
    expect(api.sent.find((request) => request.events.some((event) => event.name === 'site_action_selected'))!.keepalive).toBe(true);
  });

  it('sends no plan for a link that has none, and nothing for untagged or unknown links', async () => {
    const api = stubApi();
    await start('<a id="plain" href="#">x</a><a id="unknown" data-site-action="download-footer" href="#">y</a><a id="header" data-site-action="download-hero" href="#">z</a>');
    document.querySelector<HTMLElement>('#plain')!.click();
    document.querySelector<HTMLElement>('#unknown')!.click();
    document.querySelector<HTMLElement>('#header')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]!.properties).toEqual({ page: 'landing', pathname: '/', action: 'download', placement: 'hero' });
  });

  it('sends a click made before bootstrap with keepalive and never an empty batch', async () => {
    let releaseBootstrap!: () => void;
    const api = stubApi({ bootstrapped: new Promise<void>((resolve) => { releaseBootstrap = resolve; }) });
    await start('<a data-site-action="download-pricing-grow" href="#">Download</a>');
    document.querySelector('a')!.click();
    releaseBootstrap();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.sent.find((request) => request.events.some((event) => event.name === 'site_action_selected'))!.keepalive).toBe(true);
    expect(api.sent.every((request) => request.events.length > 0)).toBe(true);
  });

  it('drops a batch the API refuses but resends one it failed to take', async () => {
    const api = stubApi({ statuses: [400, 503] });
    await start('<a data-site-action="download-hero" href="#">a</a><a data-site-action="demo-request" href="#">b</a>');
    // Request 1: the page view, refused. Request 2: the first click, 503.
    await vi.waitFor(() => expect(api.sent).toHaveLength(1));
    document.querySelector<HTMLElement>('[data-site-action="download-hero"]')!.click();
    await vi.waitFor(() => expect(api.sent).toHaveLength(2));
    // Request 3 carries the resent click with the new one; the refused page view is gone.
    document.querySelector<HTMLElement>('[data-site-action="demo-request"]')!.click();
    await vi.waitFor(() => expect(api.sent).toHaveLength(3));
    expect(api.sent[2]!.events.map((event) => event.properties['action'] ?? event.name)).toEqual(['download', 'demo_request']);
  });

  it('bootstraps again once when the capability has expired', async () => {
    const api = stubApi({ statuses: [401] });
    await start('');

    await vi.waitFor(() => expect(api.sent).toHaveLength(2));
    expect(api.sent[1]!.events.map((event) => event.name)).toEqual(['site_page_viewed']);
    expect(api.sent[1]!.capability).not.toBe(api.sent[0]!.capability);
  });

  it('names the ad platform whose click id the landing URL carried, never the id', async () => {
    history.replaceState(null, '', '/?utm_source=x&utm_medium=paid_social&twclid=23opevjt88psuo13lu8d020qkn');
    const api = stubApi();
    await start('');

    await vi.waitFor(() => expect(api.sent).toHaveLength(1));
    const view = api.sent[0]!.events[0]!;
    expect(view.properties).toMatchObject({ campaignSource: 'x', campaignMedium: 'paid_social', adClickIdSource: 'x' });
    expect(JSON.stringify(view)).not.toContain('23opevjt88psuo13lu8d020qkn');
    // Gone from the address bar too, before PostHog's SDK could read it; the campaign tags stay.
    expect(location.search).toBe('?utm_source=x&utm_medium=paid_social');
  });

  it.each([
    ['/?utm_source=x'],
    ['/?utm_source=x&twclid='],
  ])('reports no ad click id for %s', async (url) => {
    history.replaceState(null, '', url);
    const api = stubApi();
    await start('');

    await vi.waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.events[0]!.properties).not.toHaveProperty('adClickIdSource');
  });

  it("sends the page's time zone and its start checks with bootstrap", async () => {
    const api = stubApi();
    await start('');

    await vi.waitFor(() => expect(api.bootstrapBodies).toHaveLength(1));
    expect(api.bootstrapBodies[0]).toMatchObject({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pageSignals: [],
    });
  });

  it('reports an iPhone user agent running on V8 as an engine mismatch', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/144.0.7559.95 Mobile/15E148 Safari/604.1',
    );
    const api = stubApi();
    await start('');

    await vi.waitFor(() => expect(api.bootstrapBodies).toHaveLength(1));
    expect(api.bootstrapBodies[0]!.pageSignals).toEqual(['engine_mismatch']);
  });

  it('reports input the page made itself when the visitor leaves', async () => {
    const api = stubApi();
    await start('<main>page</main>');
    const main = document.querySelector('main')!;
    main.dispatchEvent(new Event('touchstart', { bubbles: true }));
    main.dispatchEvent(new Event('touchend', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(api.sent.flatMap((request) => request.events)).toHaveLength(2));
    const left = api.sent.flatMap((request) => request.events).find((event) => event.name === 'site_page_left')!;
    expect(left.properties.pageSignals).toEqual(['untrusted_input']);
  });

  describe('swipes that scroll nothing', () => {
    let top = 0;
    // jsdom lays nothing out, so the page is given a height and a scroll position.
    const page = document.documentElement;
    beforeEach(() => {
      top = 0;
      Object.defineProperty(page, 'scrollHeight', { configurable: true, get: () => 3_000 });
      Object.defineProperty(page, 'clientHeight', { configurable: true, get: () => 800 });
      Object.defineProperty(page, 'scrollTop', { configurable: true, get: () => top });
    });
    afterEach(() => {
      for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) Reflect.deleteProperty(page, property);
    });

    /** One finger from `from` to `to`, made the way a page script makes it. */
    function swipe(from: { x: number; y: number }, to: { x: number; y: number }): void {
      const touch = (point: { x: number; y: number }) => ({ clientX: point.x, clientY: point.y });
      document.body.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [touch(from)] }));
      document.body.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: [touch(to)] }));
    }

    async function leaveSignals(api: ReturnType<typeof stubApi>): Promise<unknown> {
      // Past the swipe's settle window, so its verdict is in.
      await new Promise((resolve) => setTimeout(resolve, 600));
      window.dispatchEvent(new Event('pagehide'));
      await vi.waitFor(() => expect(api.sent.flatMap((request) => request.events)).toHaveLength(2));
      return api.sent.flatMap((request) => request.events).find((event) => event.name === 'site_page_left')!.properties.pageSignals;
    }

    it('reports a vertical swipe the page could have answered and did not', async () => {
      const api = stubApi();
      await start('');
      swipe({ x: 200, y: 600 }, { x: 205, y: 300 });
      expect(await leaveSignals(api)).toEqual(['swipe_no_scroll', 'untrusted_input']);
    });

    it('does not report a swipe the page scrolled for', async () => {
      const api = stubApi();
      await start('');
      swipe({ x: 200, y: 600 }, { x: 205, y: 300 });
      top = 300;
      document.dispatchEvent(new Event('scroll'));
      expect(await leaveSignals(api)).toEqual(['untrusted_input']);
    });

    it.each([
      ['starts at the screen edge, where back and forward gestures live', { x: 10, y: 600 }, { x: 15, y: 300 }],
      ['pulls down at the top of the page, which has nowhere to go', { x: 200, y: 300 }, { x: 205, y: 600 }],
      ['moves sideways more than down', { x: 200, y: 600 }, { x: 600, y: 500 }],
    ])('ignores a swipe that %s', async (_case, from, to) => {
      const api = stubApi();
      await start('');
      swipe(from, to);
      expect(await leaveSignals(api)).toEqual(['untrusted_input']);
    });
  });

  it('sends no page signals for a visit with no input', async () => {
    const api = stubApi();
    await start('');
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(api.sent.flatMap((request) => request.events)).toHaveLength(2));
    const left = api.sent.flatMap((request) => request.events).find((event) => event.name === 'site_page_left')!;
    expect(left.properties).not.toHaveProperty('pageSignals');
  });

  it("reports each event under PostHog's session at the moment it is made", async () => {
    const api = stubApi();
    let current = '019a0000-0000-7000-8000-000000000001';
    await start('<a data-site-action="download-hero" href="#">a</a>', () => current);
    await vi.waitFor(() => expect(api.sent).toHaveLength(1));
    // PostHog rotates a session after inactivity; the next event follows it.
    current = '019a0000-0000-7000-8000-000000000002';
    document.querySelector<HTMLElement>('a')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.sent.flatMap((request) => request.events).map((event) => [event.name, event.context.sessionId])).toEqual([
      ['site_page_viewed', '019a0000-0000-7000-8000-000000000001'],
      ['site_action_selected', '019a0000-0000-7000-8000-000000000002'],
    ]);
  });

  it("keeps the page's own session when PostHog could not load", async () => {
    const api = stubApi();
    await start('<a data-site-action="download-hero" href="#">a</a>', null);
    document.querySelector<HTMLElement>('a')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    const sessions = new Set(api.sent.flatMap((request) => request.events).map((event) => event.context.sessionId));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(UUID_V7);
  });

  it('bootstraps with the anonymous id given to PostHog, even when storage is refused', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const api = stubApi();
    const { globalAnonymousEpochId } = await import('../src/telemetry');
    const givenToPostHog = globalAnonymousEpochId();
    await start('');

    await vi.waitFor(() => expect(api.anonymousIds).toHaveLength(1));
    expect(api.anonymousIds[0]).toBe(givenToPostHog);
    expect(givenToPostHog).toMatch(UUID_V7);
  });

  it('sends what is queued with the page session when the visitor leaves before PostHog loads', async () => {
    const api = stubApi();
    document.body.innerHTML = '<a data-site-action="download-hero" href="#">a</a>';
    const telemetry = await import('../src/telemetry');
    // The SDK script never arrives: a slow network, or a click that navigates away first.
    telemetry.awaitAnalyticsSession();
    telemetry.initializeSiteTelemetry();
    document.querySelector<HTMLElement>('a')!.click();
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(api.sent.flatMap((request) => request.events)).toHaveLength(3));
    const events = api.sent.flatMap((request) => request.events);
    expect(events.map((event) => event.name).sort()).toEqual(['site_action_selected', 'site_page_left', 'site_page_viewed']);
    expect(new Set(events.map((event) => event.context.sessionId)).size).toBe(1);
    expect(events[0]!.context.sessionId).toMatch(UUID_V7);
  });
});
