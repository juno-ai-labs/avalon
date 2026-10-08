// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Sent { keepalive: boolean; capability: string; events: Array<{ name: string; properties: Record<string, unknown> }> }

/** A stub Global API: route, bootstrap and ingest, with scripted ingest statuses. */
function stubApi(options: { statuses?: number[]; bootstrapped?: Promise<void> } = {}) {
  const statuses = [...(options.statuses ?? [])];
  const sent: Sent[] = [];
  let bootstraps = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/telemetry/route')) {
      return Response.json({ route: 'global', routingBasis: 'ip_geolocation', routeToken: 'r'.repeat(40) });
    }
    if (url.endsWith('/telemetry/bootstrap')) {
      await options.bootstrapped;
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
  return { sent, clicks: () => sent.flatMap((request) => request.events).filter((event) => event.name === 'site_action_selected') };
}

async function start(html: string) {
  document.body.innerHTML = html;
  const { initializeSiteTelemetry } = await import('../src/telemetry');
  initializeSiteTelemetry();
}

// jsdom keeps one `document` per file, so each fresh import of the reporter
// would stack another click listener on the last test's.
const listeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
const addListener = document.addEventListener.bind(document);

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([type, listener, options]);
    addListener(type, listener, options);
  });
});

afterEach(() => {
  for (const [type, listener, options] of listeners.splice(0)) document.removeEventListener(type, listener, options);
});

describe('site telemetry reporter', () => {
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

  it('names the page a click came from, so landing variants can be compared', async () => {
    const api = stubApi();
    history.replaceState(null, '', '/start-fast/');
    await start('<a data-site-action="download-hero" href="#">Download the macOS beta</a>');
    document.querySelector<HTMLElement>('a')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]!.properties).toEqual({ page: 'landing', pathname: '/start-fast/', action: 'download', placement: 'hero' });
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
    await start('<a id="plain" href="#">x</a><a id="unknown" data-site-action="download-footer" href="#">y</a><a id="header" data-site-action="download-header" href="#">z</a>');
    document.querySelector<HTMLElement>('#plain')!.click();
    document.querySelector<HTMLElement>('#unknown')!.click();
    document.querySelector<HTMLElement>('#header')!.click();

    await vi.waitFor(() => expect(api.clicks()).toHaveLength(1));
    expect(api.clicks()[0]!.properties).toEqual({ page: 'landing', pathname: '/', action: 'download', placement: 'header' });
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
});
