import { TELEMETRY_ENVELOPE_SCHEMA } from '@rally/contracts/telemetry';
import type {
  TelemetryBootstrapResponse,
  TelemetryEnvelope,
  TelemetryEventName,
  TelemetryEventProperties,
  TelemetryRouteResponse,
} from '@rally/contracts/telemetry';

type SitePage = TelemetryEventProperties<'site_page_viewed'>['page'];
type SiteAction = TelemetryEventProperties<'site_action_selected'>['action'];
type SitePlacement = TelemetryEventProperties<'site_action_selected'>['placement'];
type HandoffType = TelemetryEventProperties<'desktop_handoff_attempted'>['handoffType'];

const ANONYMOUS_EPOCH_KEY = 'rally.site.anonymous-epoch.v1';
const MAX_PENDING_EVENTS = 20;

interface CapabilityState extends TelemetryBootstrapResponse {
  anonymousEpochId: string;
}

const sessionId = uuidV7();
const transientAnonymousEpochId = uuidV7();
const pageVisibleAt = Date.now();
const pending: TelemetryEnvelope[] = [];
let capabilityPromise: Promise<CapabilityState> | null = null;
let leaveReported = false;

function apiBaseUrl(): string {
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

function storageRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageWrite(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Private browsing and storage policy must not affect the site experience.
  }
}

function globalAnonymousEpochId(): string {
  const stored = storageRead(localStorage, ANONYMOUS_EPOCH_KEY);
  if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(stored)) {
    return stored;
  }
  const created = uuidV7();
  storageWrite(localStorage, ANONYMOUS_EPOCH_KEY, created);
  return created;
}

async function coarseRoute(): Promise<TelemetryRouteResponse> {
  const response = await fetch(`${apiBaseUrl()}/telemetry/route`, { cache: 'no-store' });
  if (!response.ok) throw new Error('site_telemetry_route_failed');
  const value = await response.json() as Record<string, unknown>;
  if ((value.route !== 'global' && value.route !== 'eu')
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
  // EU public-site measurement remains page-scoped and never reads or writes a
  // browser identifier. Global may retain one first-party anonymous epoch so
  // acquisition and handoff steps can form a truthful multi-page funnel.
  const epochId = route.route === 'global' ? globalAnonymousEpochId() : transientAnonymousEpochId;
  const response = await fetch(`${apiBaseUrl()}/telemetry/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anonymousEpochId: epochId, routeToken: route.routeToken }),
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

function environment(): 'development' | 'staging' | 'production' {
  if (PRODUCTION_SITE_HOSTS.has(location.hostname)) return 'production';
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'development';
  return 'staging';
}

function makeEnvelope<TName extends TelemetryEventName>(
  state: CapabilityState,
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
      sessionId,
      onboardingJourneyId: state.journeyId,
    },
  } as TelemetryEnvelope;
}

async function flush(keepalive = false): Promise<void> {
  if (pending.length === 0) return;
  const state = await getCapability();
  const events = pending.splice(0, 50);
  const response = await fetch(`${apiBaseUrl()}/telemetry/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability: state.capability, events }),
    keepalive,
  });
  if (!response.ok) pending.unshift(...events);
}

function report<TName extends TelemetryEventName>(
  name: TName,
  properties: TelemetryEventProperties<TName>,
  keepalive = false,
): void {
  void getCapability().then((state) => {
    if (pending.length >= MAX_PENDING_EVENTS) pending.shift();
    pending.push(makeEnvelope(state, name, properties));
    return flush(keepalive);
  }).catch(() => undefined);
}

export function normalizedTelemetryPathname(pathname: string): string {
  const path = pathname.toLowerCase().slice(0, 160);
  if (path.startsWith('/app/workstreams/')) return '/app/workstreams/:id';
  return /^\/[a-z0-9_:/.-]*$/u.test(path) ? path : '/';
}

function normalizedPathname(): string {
  return normalizedTelemetryPathname(location.pathname);
}

export function currentSitePage(): SitePage {
  const path = normalizedPathname();
  if (document.querySelector('.not-found') || path === '/404.html') return 'not_found';
  if (path.startsWith('/auth/desktop')) return 'auth_handoff';
  if (path.startsWith('/invite')) return 'invite_handoff';
  if (path.startsWith('/app/workstreams')) return 'workstream_handoff';
  if (path.startsWith('/slack/link')) return 'slack_handoff';
  if (path.startsWith('/open')) return 'desktop_handoff';
  if (path.startsWith('/support') || path === '/slack/' || path === '/slack') return 'support';
  if (/^\/(?:terms|privacy|acceptable-use|dpa|subprocessors|cookies|security)(?:\/|$)/u.test(path)) return 'legal';
  if (path.startsWith('/download')) return 'download';
  return 'landing';
}

function campaignValue(name: string): string | undefined {
  const value = new URLSearchParams(location.search).get(name)?.slice(0, 160);
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value) ? value : undefined;
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

export function reportSiteAction(action: SiteAction, placement: SitePlacement): void {
  const page = currentSitePage();
  if (page !== 'landing' && page !== 'download' && page !== 'support') return;
  report('site_action_selected', { page, action, placement });
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

export function initializeSiteTelemetry(): void {
  report('site_page_viewed', {
    page: currentSitePage(),
    pathname: normalizedPathname(),
    ...(referringDomain() ? { referringDomain: referringDomain() } : {}),
    ...(campaignValue('utm_source') ? { campaignSource: campaignValue('utm_source') } : {}),
    ...(campaignValue('utm_medium') ? { campaignMedium: campaignValue('utm_medium') } : {}),
    ...(campaignValue('utm_campaign') ? { campaignName: campaignValue('utm_campaign') } : {}),
  });
  const leave = (): void => {
    if (leaveReported) return;
    leaveReported = true;
    report('site_page_left', {
      page: currentSitePage(),
      pathname: normalizedPathname(),
      duration: durationBucket(Date.now() - pageVisibleAt),
    }, true);
  };
  window.addEventListener('pagehide', leave, { once: true });
}
