import { isRetiredLinkPath } from '@rally/contracts/links';
import { TELEMETRY_ENVELOPE_SCHEMA } from '@rally/contracts/telemetry';
import { reportXIntent } from './x-pixel-loader';
import type {
  TelemetryBootstrapResponse,
  TelemetryEnvelope,
  TelemetryEventName,
  TelemetryEventProperties,
  TelemetryRouteResponse,
} from '@rally/contracts/telemetry';
import { pageStartSignals, pageTimeZone, watchPageInput } from './traffic-signals';

type SitePage = TelemetryEventProperties<'site_page_viewed'>['page'];
type SiteActionLink = Omit<TelemetryEventProperties<'site_action_selected'>, 'page'>;
type HandoffType = TelemetryEventProperties<'desktop_handoff_attempted'>['handoffType'];

const ANONYMOUS_EPOCH_KEY = 'rally.site.anonymous-epoch.v1';
const MAX_PENDING_EVENTS = 20;

interface CapabilityState extends TelemetryBootstrapResponse {
  anonymousEpochId: string;
}

const sessionId = uuidV7();
// While PostHog's browser SDK runs on the page, events carry its session so
// PostHog joins them to that session's replay instead of opening one per page.
let analyticsSession: Promise<(() => string) | null> = Promise.resolve(null);
let provideSession: ((session: (() => string) | null) => void) | null = null;
const pageVisibleAt = Date.now();
const pending: TelemetryEnvelope[] = [];
let capabilityPromise: Promise<CapabilityState> | null = null;
let leaveReported = false;
// Set by any queued event that must survive the page handing off; carried by
// whichever request next sends the queue, since that request may include it.
let keepaliveWanted = false;
let capabilityRefreshed = false;

/** The Global API, or the local one when the site itself is served locally. */
export function apiBaseUrl(): string {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8787'
    : 'https://api.rallywith.ai';
}

function uuidV7(milliseconds = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let remaining = milliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function storageRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function storageWrite(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Private browsing and storage policy must not affect the site experience.
  }
}

let pageEpochId: string | null = null;

/**
 * The first-party anonymous id every site event, and the PostHog SDK, reports
 * as. Kept for the page, so a browser that refuses storage still gives both
 * the same id rather than one each.
 */
export function globalAnonymousEpochId(): string {
  if (pageEpochId) return pageEpochId;
  const stored = storageRead(localStorage, ANONYMOUS_EPOCH_KEY);
  if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(stored)) {
    pageEpochId = stored;
    return stored;
  }
  pageEpochId = uuidV7();
  storageWrite(localStorage, ANONYMOUS_EPOCH_KEY, pageEpochId);
  return pageEpochId;
}

async function coarseRoute(): Promise<TelemetryRouteResponse> {
  const response = await fetch(`${apiBaseUrl()}/telemetry/route`, { cache: 'no-store' });
  if (!response.ok) throw new Error('site_telemetry_route_failed');
  const value = await response.json() as Record<string, unknown>;
  if (value.route !== 'global'
    || (value.routingBasis !== 'ip_geolocation' && value.routingBasis !== 'geolocation_fallback')
    || typeof value.routeToken !== 'string'
    || value.routeToken.length < 32
    || value.routeToken.length > 2_048) {
    throw new Error('site_telemetry_route_invalid');
  }
  return { route: value.route, routingBasis: value.routingBasis, routeToken: value.routeToken };
}

async function capability(): Promise<CapabilityState> {
  const route = await coarseRoute();
  // A first-party anonymous epoch connects acquisition and handoff steps.
  const epochId = globalAnonymousEpochId();
  const response = await fetch(`${apiBaseUrl()}/telemetry/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      anonymousEpochId: epochId,
      routeToken: route.routeToken,
      timeZone: pageTimeZone(),
      pageSignals: pageStartSignals(),
    }),
  });
  if (!response.ok) throw new Error('site_telemetry_bootstrap_failed');
  const value = { ...(await response.json() as TelemetryBootstrapResponse), anonymousEpochId: epochId };
  return value;
}

function getCapability(): Promise<CapabilityState> {
  capabilityPromise ??= capability().catch((error) => {
    capabilityPromise = null;
    throw error;
  });
  return capabilityPromise;
}

// Both production domains, for as long as both are served. Omitting one would
// not fail anywhere visible — it would quietly file every visit arriving on
// that domain under `staging`, which is indistinguishable from nobody visiting.
const PRODUCTION_SITE_HOSTS = new Set([
  'rallywith.ai',
  'www.rallywith.ai',
  'with-avalon.com',
  'www.with-avalon.com',
]);

export function environment(): 'development' | 'staging' | 'production' {
  if (PRODUCTION_SITE_HOSTS.has(location.hostname)) return 'production';
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'development';
  return 'staging';
}

function makeEnvelope<TName extends TelemetryEventName>(
  state: CapabilityState,
  session: string,
  name: TName,
  properties: TelemetryEventProperties<TName>,
): TelemetryEnvelope {
  const timestamp = new Date().toISOString();
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    schemaVersion: 1,
    eventId: uuidV7(),
    name,
    source: 'site',
    category: 'product',
    identityScope: 'anonymous-epoch',
    originalTimestamp: timestamp,
    sentAt: timestamp,
    properties,
    context: {
      environment: environment(),
      region: state.route,
      release: __RALLY_SITE_RELEASE__,
      buildId: __RALLY_SITE_BUILD__,
      sessionId: session,
      onboardingJourneyId: state.journeyId,
    },
  } as TelemetryEnvelope;
}

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const state = await getCapability();
  // Two reports waiting on one bootstrap resume together; the first request
  // takes both events and the second finds nothing left to send.
  const events = pending.splice(0, 50);
  if (events.length === 0) return;
  const keepalive = keepaliveWanted;
  keepaliveWanted = false;
  const requeue = (): void => {
    pending.unshift(...events);
    if (keepalive) keepaliveWanted = true;
  };
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/telemetry/anonymous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: state.capability, events }),
      keepalive,
    });
  } catch {
    // Offline or blocked: keep the batch for the page's next send.
    requeue();
    return;
  }
  if (response.ok) {
    capabilityRefreshed = false;
    return;
  }
  // The capability expires while a tab stays open; bootstrap again once and
  // resend, since the same anonymous epoch gets the same journey back.
  if (response.status === 401 && !capabilityRefreshed) {
    capabilityRefreshed = true;
    capabilityPromise = null;
    requeue();
    await flush();
    return;
  }
  // Any other 4xx is the API refusing the batch itself; resending it would
  // refuse every event queued behind it on this page. A server failure, a
  // timeout, or rate limiting is transient and retries.
  if (response.status >= 500 || response.status === 408 || response.status === 429) requeue();
}

function report<TName extends TelemetryEventName>(
  name: TName,
  properties: TelemetryEventProperties<TName>,
  keepalive = false,
): void {
  void Promise.all([getCapability(), analyticsSession]).then(([state, session]) => {
    if (pending.length >= MAX_PENDING_EVENTS) pending.shift();
    pending.push(makeEnvelope(state, session?.() ?? sessionId, name, properties));
    if (keepalive) keepaliveWanted = true;
    return flush();
  }).catch(() => undefined);
}

export function normalizedTelemetryPathname(pathname: string): string {
  const path = pathname.toLowerCase().slice(0, 160);
  if (/^\/app\/[^/]+\/[^/]+\/cv\/[^/]+\/a\/[^/]+\/?$/u.test(path)) {
    return '/app/:region/:organization/cv/:canvas/a/:artifact';
  }
  if (/^\/app\/[^/]+\/[^/]+\/cv\/[^/]+\/?$/u.test(path)) {
    return '/app/:region/:organization/cv/:canvas';
  }
  if (/^\/app\/[^/]+\/[^/]+\/sk\/[^/]+\/?$/u.test(path)) {
    return '/app/:region/:organization/sk/:sidekick';
  }
  // A Thread's links, which the handoff page opens as the Canvas of the
  // Thread's id. Shape only, as above: this path is lowercased, so its Base58
  // segments cannot be decoded here.
  if (/^\/app\/[^/]+\/[^/]+\/s\/[^/]+\/c\/[^/]+(?:\/a\/[^/]+)?\/?$/u.test(path)) {
    return '/app/:region/:organization/s/:space/c/:thread';
  }
  if (/^\/app\/workspaces\/[^/]+\/[^/]+\/workstreams\/[^/]+\/?$/u.test(path)) {
    return '/app/workspaces/:region/:organization/workstreams/:thread';
  }
  // The Space, Breakout and other retired forms, which the handoff page now
  // answers as gone. Still counted, so how often a retired link is followed
  // stays visible, but as one path: which of them it was no longer matters.
  // The same test the handoff page answers with, so the two cannot disagree.
  if (isRetiredLinkPath(path)) {
    return '/app/:retired';
  }
  if (path.startsWith('/app/')) return '/app/:unrecognized';
  return /^\/[a-z0-9_:/.-]*$/u.test(path) ? path : '/';
}

function normalizedPathname(): string {
  return normalizedTelemetryPathname(location.pathname);
}

export function sitePageForPath(path: string): SitePage {
  if (path === '/404.html') return 'not_found';
  if (path.startsWith('/auth/desktop')) return 'auth_handoff';
  if (path.startsWith('/invite')) return 'invite_handoff';
  if (path.startsWith('/app/')) return 'workstream_handoff';
  if (path.startsWith('/slack/link')) return 'slack_handoff';
  if (path.startsWith('/open')) return 'desktop_handoff';
  if (path.startsWith('/support') || /^\/help(?:\/|$)/u.test(path) || path === '/slack/' || path === '/slack') return 'support';
  if (/^\/trust(?:\/|$)/u.test(path)) return 'legal';
  if (path.startsWith('/download')) return 'download';
  return 'landing';
}

export function currentSitePage(): SitePage {
  if (document.querySelector('.not-found')) return 'not_found';
  return sitePageForPath(normalizedPathname());
}

function campaignValue(name: string): string | undefined {
  const value = new URLSearchParams(location.search).get(name)?.slice(0, 160);
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value) ? value : undefined;
}

// Ad platforms' click-identifier parameters, by the source the event names.
// Only whether one is present is reported; its value identifies one ad click.
const AD_CLICK_ID_PARAMETERS = [['twclid', 'x']] as const;

let adClickIdSource: TelemetryEventProperties<'site_page_viewed'>['adClickIdSource'];
let adClickIdTaken = false;

/**
 * Notes which ad platform's click identifier the landing URL carried, then
 * removes the identifier from the address bar. It runs before PostHog's SDK
 * loads, because the SDK reports the full URL with every event and replay,
 * and the identifier names one ad click.
 */
export function takeAdClickId(): void {
  if (adClickIdTaken) return;
  adClickIdTaken = true;
  const url = new URL(location.href);
  adClickIdSource = AD_CLICK_ID_PARAMETERS.find(([parameter]) => url.searchParams.get(parameter))?.[1];
  if (!AD_CLICK_ID_PARAMETERS.some(([parameter]) => url.searchParams.has(parameter))) return;
  for (const [parameter] of AD_CLICK_ID_PARAMETERS) url.searchParams.delete(parameter);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function referringDomain(): string | undefined {
  if (!document.referrer) return undefined;
  try {
    const hostname = new URL(document.referrer).hostname.toLowerCase();
    return hostname && hostname !== location.hostname && /^[a-z0-9.-]{1,253}$/u.test(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function durationBucket(milliseconds: number): TelemetryEventProperties<'site_page_left'>['duration'] {
  if (milliseconds < 1_000) return 'lt_1s';
  if (milliseconds < 5_000) return '1s_5s';
  if (milliseconds < 30_000) return '5s_30s';
  if (milliseconds < 120_000) return '30s_2m';
  if (milliseconds < 600_000) return '2m_10m';
  return 'gte_10m';
}

function reportSiteAction(link: SiteActionLink): void {
  const page = currentSitePage();
  if (page !== 'landing' && page !== 'download' && page !== 'support') return;
  // A click is often the visitor's last act on the page, so it gets the same
  // best-effort keepalive as a page leave.
  report('site_action_selected', { page, pathname: normalizedPathname(), ...link }, true);
}

/**
 * The links a page may report, keyed by the `data-site-action` id in its HTML.
 * An id not listed here is ignored, so markup can only select one of these
 * closed combinations and never put its own values into an event.
 */
export const SITE_ACTION_LINKS = {
  'sign-in-header': { action: 'primary_cta', placement: 'header' },
  'download-hero': { action: 'download', placement: 'hero' },
  'web-app-hero': { action: 'secondary_cta', placement: 'hero' },
  'web-app-offer': { action: 'primary_cta', placement: 'offer' },
  'download-pricing-start': { action: 'download', placement: 'pricing', plan: 'start' },
  'download-pricing-grow': { action: 'download', placement: 'pricing', plan: 'grow' },
  'contact-pricing-enterprise': { action: 'founder_contact', placement: 'pricing', plan: 'enterprise' },
  'demo-request': { action: 'demo_request', placement: 'sidekicks' },
  'founder-contact': { action: 'founder_contact', placement: 'team' },
  'support-contact-footer': { action: 'support_contact', placement: 'footer' },
} satisfies Record<string, SiteActionLink>;

// Links into the web app, each activation of which starts a signup flow.
const WEB_ENTRY_LINKS = new Set(['web-app-hero', 'web-app-offer', 'sign-in-header']);

export function siteActionForLink(id: string | undefined): SiteActionLink | null {
  if (!id || !Object.hasOwn(SITE_ACTION_LINKS, id)) return null;
  return SITE_ACTION_LINKS[id as keyof typeof SITE_ACTION_LINKS];
}

function initializeSiteActions(): void {
  const selected = (event: MouseEvent): void => {
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-site-action]');
    const id = link?.dataset['siteAction'];
    const action = siteActionForLink(id);
    if (!action || !link) return;
    let flowId: string | undefined;
    if (id && WEB_ENTRY_LINKS.has(id)) {
      flowId = uuidV7();
      const destination = new URL(link.href);
      destination.searchParams.set('signupFlowId', flowId);
      link.href = destination.href;
      // Default navigation reads the updated href after dispatch. Restore the
      // clean link afterwards so copied links never share an attempt.
      destination.searchParams.delete('signupFlowId');
      setTimeout(() => { link.href = destination.href; }, 0);
      reportXIntent('signUp');
    }
    reportSiteAction({ ...action, ...(flowId ? { flowId } : {}) });
    if (action.action === 'download') reportXIntent('download');
  };
  document.addEventListener('click', selected, { capture: true });
  // A middle-click opens a link without firing `click`.
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1) selected(event);
  }, { capture: true });
}

export function reportDesktopHandoff(
  handoffType: HandoffType,
  method: TelemetryEventProperties<'desktop_handoff_attempted'>['method'],
  validity: TelemetryEventProperties<'desktop_handoff_attempted'>['validity'],
): void {
  // Automatic/manual handoffs can navigate away immediately; keepalive gives
  // the already-bounded event a best-effort chance to leave during unload.
  // Merely presenting the handoff stays on the ordinary request path.
  report('desktop_handoff_attempted', { handoffType, method, validity }, method !== 'presented');
}

/**
 * Holds events until `provideAnalyticsSession` names the session they report
 * under. Called before `initializeSiteTelemetry` on a page that loads PostHog,
 * so even the page view waits for the SDK's session. A visitor who leaves
 * before the SDK loads releases the hold with the page's own session, so the
 * quickest bounces and navigating clicks are still reported.
 */
export function awaitAnalyticsSession(): void {
  analyticsSession = new Promise((resolve) => { provideSession = resolve; });
  window.addEventListener('pagehide', () => provideAnalyticsSession(null), { once: true });
}

/**
 * Reports every event under the session `session` returns, read when each
 * event is made. Null, for an SDK that failed to load, keeps the page's own.
 */
export function provideAnalyticsSession(session: (() => string) | null): void {
  provideSession?.(session);
  provideSession = null;
}

export function initializeSiteTelemetry(): void {
  takeAdClickId();
  report('site_page_viewed', {
    page: currentSitePage(),
    pathname: normalizedPathname(),
    ...(referringDomain() ? { referringDomain: referringDomain() } : {}),
    ...(campaignValue('utm_source') ? { campaignSource: campaignValue('utm_source') } : {}),
    ...(campaignValue('utm_medium') ? { campaignMedium: campaignValue('utm_medium') } : {}),
    ...(campaignValue('utm_campaign') ? { campaignName: campaignValue('utm_campaign') } : {}),
    ...(adClickIdSource ? { adClickIdSource } : {}),
  });
  const pageInput = watchPageInput();
  const leave = (): void => {
    if (leaveReported) return;
    leaveReported = true;
    const pageSignals = pageInput();
    report('site_page_left', {
      page: currentSitePage(),
      pathname: normalizedPathname(),
      duration: durationBucket(Date.now() - pageVisibleAt),
      ...(pageSignals.length ? { pageSignals } : {}),
    }, true);
  };
  window.addEventListener('pagehide', leave, { once: true });
  initializeSiteActions();
}
