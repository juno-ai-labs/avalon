import "../../../tests/isolated-region";
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteTrafficReason } from '@rally/contracts/telemetry';
import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { publicTelemetryRoutes } from '../src/routes/telemetry';
import { classifySiteTraffic, edgeTrafficSignals } from '../src/telemetry/site-traffic';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

const SITE = 'https://rallywith.ai';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Mobile/15E148 Safari/604.1';
// The scripted visitor seen in replay on 2026-10-11.
const CRIOS_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/144.0.7559.95 Mobile/15E148 Safari/604.1';

/** The headers a real browser sends on the site's bootstrap fetch. */
function browserHeaders(userAgent: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'user-agent': userAgent,
    origin: SITE,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'accept-language': 'en-US,en;q=0.9',
    ...extra,
  });
}

const HOME = { asn: 7922, timezone: 'America/Los_Angeles', httpProtocol: 'HTTP/2', tlsVersion: 'TLSv1.3' };

function signals(headers: Headers, cf: Record<string, unknown> | undefined = HOME, pageTimeZone?: string): SiteTrafficReason[] {
  return edgeTrafficSignals({
    headers,
    cf,
    allowedOrigins: new Set([SITE]),
    pageTimeZone,
    now: new Date('2026-10-11T09:00:00Z'),
  }).sort();
}

describe('site traffic classification', () => {
  it.each<[SiteTrafficReason[], string]>([
    [[], 'unverified'],
    [['human_input'], 'human'],
    [['declared_bot', 'human_input'], 'declared_bot'],
    [['signed_agent'], 'declared_bot'],
    [['untrusted_input', 'human_input'], 'automated'],
    [['origin_bad'], 'automated'],
    [['hosting_network', 'human_input'], 'datacenter'],
    [['hosting_network', 'tz_offset_mismatch'], 'automated'],
    [['hosting_network', 'swipe_no_scroll'], 'automated'],
    // Two soft codes that observe the same thing are still one piece of evidence.
    [['transport_legacy', 'accept_language_bad', 'human_input'], 'human'],
    [['tz_offset_mismatch', 'human_input'], 'human'],
    [['private_relay', 'x_in_app', 'never_visible'], 'unverified'],
  ])('classifies %j as %s', (reasons, expected) => {
    expect(classifySiteTraffic(reasons)).toBe(expected);
  });

  it('finds nothing to object to in an ordinary iPhone visit', () => {
    expect(signals(browserHeaders(SAFARI_IPHONE), HOME, 'America/Los_Angeles')).toEqual([]);
  });

  it('catches the scripted iPhone on its network, its clock and its client hints', () => {
    const headers = browserHeaders(CRIOS_IPHONE, { 'sec-ch-ua': '"Chromium";v="144", "Not:A-Brand";v="99"' });
    expect(signals(headers, { ...HOME, asn: 16509, timezone: 'America/New_York' }, 'America/Los_Angeles'))
      .toEqual(['ch_contradiction', 'hosting_network', 'tz_offset_mismatch']);
  });

  it('exempts iCloud Private Relay from the hosting check', () => {
    expect(signals(browserHeaders(SAFARI_IPHONE), { ...HOME, asn: 36183 })).toEqual(['private_relay']);
  });

  it('names a script that replays the bootstrap call without a browser', () => {
    expect(signals(new Headers({ 'user-agent': 'curl/8.7.1' }), undefined))
      .toEqual(['accept_language_bad', 'declared_bot', 'origin_bad']);
    // An impersonation client copies a browser's user agent but sends a navigation's metadata.
    expect(signals(browserHeaders(SAFARI_IPHONE, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })))
      .toEqual(['fetch_metadata_bad']);
  });

  it('reads declared crawlers, headless Chrome and the X app from the user agent', () => {
    expect(signals(browserHeaders('Twitterbot/1.0'))).toEqual(['declared_bot']);
    expect(signals(browserHeaders('Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0 Mobile Safari/537.36')))
      .toEqual([]);
    expect(signals(browserHeaders('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/144.0 Safari/537.36')))
      .toEqual(['headless_ua']);
    expect(signals(browserHeaders(`${SAFARI_IPHONE} Twitter for iPhone/11.0`))).toEqual(['x_in_app']);
  });

  it('flags an old transport only under a browser user agent', () => {
    expect(signals(browserHeaders(SAFARI_IPHONE), { ...HOME, httpProtocol: 'HTTP/1.1' })).toEqual(['transport_legacy']);
  });

  it('ignores time zones in the same offset and ones the runtime does not know', () => {
    expect(signals(browserHeaders(SAFARI_IPHONE), { ...HOME, timezone: 'America/Phoenix' }, 'America/Los_Angeles')).toEqual([]);
    expect(signals(browserHeaders(SAFARI_IPHONE), HOME, 'Mars/Olympus_Mons')).toEqual([]);
  });
});

describe('site traffic through bootstrap and acceptance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T09:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  function app(): Hono<HonoAppEnv> {
    const routes = new Hono<HonoAppEnv>();
    routes.route('/telemetry', publicTelemetryRoutes);
    routes.onError(errorHandler);
    return routes;
  }

  async function visit(input: {
    headers: Headers;
    cf: Record<string, unknown>;
    timeZone: string;
    startSignals: SiteTrafficReason[];
    leaveSignals: SiteTrafficReason[];
  }) {
    const database = migratedObservabilityFixture();
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
      ALLOWED_ORIGINS: SITE,
    });
    const bootstrapRequest = new Request('https://api.rallywith.ai/telemetry/bootstrap', {
      method: 'POST',
      headers: { ...Object.fromEntries(input.headers), 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousEpochId: '018f22f2-4c22-7abc-8def-0123456789ab',
        timeZone: input.timeZone,
        pageSignals: input.startSignals,
      }),
    });
    Object.defineProperty(bootstrapRequest, 'cf', { value: input.cf });
    const bootstrapResponse = await app().request(bootstrapRequest, undefined, environment);
    expect(bootstrapResponse.status).toBe(201);
    const bootstrap = await bootstrapResponse.json() as { capability: string; journeyId: string };

    const event = (eventId: string, name: string, properties: Record<string, unknown>) => ({
      schema: 'ai.rallywith.telemetry.event', schemaVersion: 1, eventId,
      name, source: 'site', category: 'product', identityScope: 'anonymous-epoch',
      originalTimestamp: '2026-10-11T09:00:00.000Z', sentAt: '2026-10-11T09:00:00.000Z',
      context: {
        environment: 'production', region: 'global', release: 'site-1', buildId: 'site-1',
        sessionId: '018f22f2-4c22-7abc-8def-0123456789bd', onboardingJourneyId: bootstrap.journeyId,
      },
      properties,
    });
    const accepted = await app().request('/telemetry/anonymous', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: bootstrap.capability,
        events: [
          // A page claiming its own class is overruled.
          event('018f22f2-4c22-7abc-8def-0123456789c1', 'site_page_viewed', {
            page: 'landing', pathname: '/', trafficClass: 'human', trafficReasons: [],
          }),
          event('018f22f2-4c22-7abc-8def-0123456789c2', 'site_page_left', {
            page: 'landing', pathname: '/', duration: '1s_5s', pageSignals: input.leaveSignals,
          }),
        ],
      }),
    }, environment);
    expect(accepted.status).toBe(202);
    const stored = (database.prepare(
      'SELECT envelope_json FROM telemetry_accepted_events ORDER BY event_id',
    ).all() as Array<{ envelope_json: string }>).map((row) => JSON.parse(row.envelope_json) as {
      name: string; properties: { trafficClass?: string; trafficReasons?: string[] };
    });
    database.close();
    return Object.fromEntries(stored.map((envelope) => [envelope.name, envelope.properties]));
  }

  it('stores the scripted iPhone as automated, with every reason, over the class it claimed', async () => {
    const stored = await visit({
      headers: browserHeaders(CRIOS_IPHONE, { 'sec-ch-ua': '"Chromium";v="144"' }),
      cf: { ...HOME, asn: 16509, timezone: 'America/New_York' },
      timeZone: 'America/Los_Angeles',
      startSignals: ['engine_mismatch'],
      leaveSignals: ['swipe_no_scroll', 'untrusted_input'],
    });
    expect(stored.site_page_viewed).toMatchObject({
      trafficClass: 'automated',
      trafficReasons: ['ch_contradiction', 'engine_mismatch', 'hosting_network', 'tz_offset_mismatch'],
    });
    expect(stored.site_page_left).toMatchObject({
      trafficClass: 'automated',
      trafficReasons: [
        'ch_contradiction', 'engine_mismatch', 'hosting_network', 'swipe_no_scroll', 'tz_offset_mismatch', 'untrusted_input',
      ],
    });
  });

  it('stores an iPhone visitor who scrolled as human once the page is left', async () => {
    const stored = await visit({
      headers: browserHeaders(SAFARI_IPHONE),
      cf: HOME,
      timeZone: 'America/Los_Angeles',
      startSignals: [],
      leaveSignals: ['human_input'],
    });
    expect(stored.site_page_viewed).toMatchObject({ trafficClass: 'unverified', trafficReasons: [] });
    expect(stored.site_page_left).toMatchObject({ trafficClass: 'human', trafficReasons: ['human_input'] });
  });
});
