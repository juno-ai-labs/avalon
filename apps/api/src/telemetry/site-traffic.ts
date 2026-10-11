import type { SiteTrafficClass, SiteTrafficReason } from "@rally/contracts/telemetry";
import { HOSTING_ASNS, PRIVATE_RELAY_ASNS } from "./hosting-networks";

/**
 * Codes a real browser in normal use essentially never produces. Any one of
 * them makes a visit `automated`.
 */
const HARD: ReadonlySet<SiteTrafficReason> = new Set([
  "headless_ua",
  "origin_bad",
  "fetch_metadata_bad",
  "webdriver",
  "automation_globals",
  "untrusted_input",
]);

/**
 * Codes with a known population of innocent triggers (VPNs, travellers,
 * corporate proxies, carousels), grouped by what they observe. Two from
 * different groups make a visit `automated`; one alone never does.
 */
const SOFT_GROUP: Readonly<Partial<Record<SiteTrafficReason, string>>> = {
  hosting_network: "network",
  transport_legacy: "headers",
  accept_language_bad: "headers",
  ch_contradiction: "headers",
  tz_offset_mismatch: "clock",
  engine_mismatch: "engine",
  swipe_no_scroll: "behavior",
};

/**
 * The one class a set of reason codes earns, first match wins. Pure and
 * ignorant of where the codes came from, so a check can be added, removed or
 * moved between tiers by editing the tables above.
 */
export function classifySiteTraffic(reasons: Iterable<SiteTrafficReason>): SiteTrafficClass {
  const codes = new Set(reasons);
  if (codes.has("declared_bot") || codes.has("signed_agent")) return "declared_bot";
  if ([...codes].some((code) => HARD.has(code))) return "automated";
  const softGroups = new Set([...codes].flatMap((code) => SOFT_GROUP[code] ?? []));
  if (softGroups.size >= 2) return "automated";
  if (codes.has("hosting_network")) return "datacenter";
  if (codes.has("human_input")) return "human";
  return "unverified";
}

/** Sorted and without repeats, so the same evidence always stores the same way. */
export function normalizedTrafficReasons(reasons: Iterable<SiteTrafficReason>): SiteTrafficReason[] {
  return [...new Set(reasons)].sort();
}

/** The parts of `request.cf` the checks read; absent outside Cloudflare's edge. */
export interface TrafficRequestCf {
  asn?: number;
  timezone?: string;
  httpProtocol?: string;
  tlsVersion?: string;
}

// Self-declared crawlers name themselves, usually with an info URL; HTTP
// libraries lead with their own name. "Cubot" is a phone maker, not a bot.
const DECLARED_BOT_UA = /\+https?:\/\/|(?<!cu)bot(?:[/\s;)_-]|$)|crawler|spider|scraper|facebookexternalhit|embedly|skypeuripreview|lighthouse|pingdom|uptimerobot/iu;
const HTTP_LIBRARY_UA = /^(?:curl|wget|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|java|okhttp|axios|node-fetch|undici|node|deno|bun|libwww-perl|apache-httpclient|httpie|postmanruntime)\b/iu;
const IOS_UA = /\b(?:iPhone|iPad|iPod)\b/u;
const CHROMIUM_UA = /\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//u;

/** The zone's current offset from UTC in minutes, or null for a zone the runtime does not know. */
function utcOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(name ?? "");
    if (!match) return null;
    if (!match[1]) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

// The gap between the page's clock and its address's at which they disagree.
// A starting point the team owns: it ignores same-offset pairs such as
// Denver and Phoenix in summer.
const TIME_ZONE_MISMATCH_MINUTES = 60;

/**
 * The codes one bootstrap request earns from what it sent: its network, its
 * headers and the page's own time zone. Every input is compared here and
 * dropped; only codes leave.
 */
export function edgeTrafficSignals(input: {
  headers: Headers;
  cf: TrafficRequestCf | undefined;
  allowedOrigins: ReadonlySet<string>;
  pageTimeZone: string | undefined;
  now?: Date;
}): SiteTrafficReason[] {
  const { headers, cf } = input;
  const codes: SiteTrafficReason[] = [];
  const userAgent = headers.get("user-agent") ?? "";
  const clientHints = headers.get("sec-ch-ua");

  if (!userAgent || DECLARED_BOT_UA.test(userAgent) || HTTP_LIBRARY_UA.test(userAgent)) codes.push("declared_bot");
  if (headers.has("signature-agent")) codes.push("signed_agent");
  if (/HeadlessChrome/u.test(userAgent) || /HeadlessChrome/u.test(clientHints ?? "")) codes.push("headless_ua");
  if (/\bTwitter(?:Android)?\b/u.test(userAgent)) codes.push("x_in_app");

  // A browser cannot leave `Origin` off a cross-origin POST.
  const origin = headers.get("origin");
  if (!origin || !input.allowedOrigins.has(origin)) codes.push("origin_bad");

  // Browsers without Fetch Metadata send none of it; one that sends it for
  // this fetch() sends exactly these values.
  const mode = headers.get("sec-fetch-mode");
  const dest = headers.get("sec-fetch-dest");
  const site = headers.get("sec-fetch-site");
  if ((mode !== null && mode !== "cors")
    || (dest !== null && dest !== "empty")
    || (site !== null && site !== "same-site" && site !== "cross-site")) codes.push("fetch_metadata_bad");

  const acceptLanguage = headers.get("accept-language")?.trim();
  if (!acceptLanguage || acceptLanguage === "*") codes.push("accept_language_bad");

  // Only Chromium sends client hints. Safari, every iOS browser and Firefox
  // never do, so hints under one of those user agents are a Chromium in disguise.
  if (clientHints !== null && (IOS_UA.test(userAgent)
    || /\bFirefox\//u.test(userAgent)
    || (/\bSafari\//u.test(userAgent) && !CHROMIUM_UA.test(userAgent)))) codes.push("ch_contradiction");

  if (cf?.asn !== undefined) {
    if (PRIVATE_RELAY_ASNS.has(cf.asn)) codes.push("private_relay");
    else if (HOSTING_ASNS.has(cf.asn)) codes.push("hosting_network");
  }

  if (userAgent.startsWith("Mozilla/5.0")
    && (/^HTTP\/1/u.test(cf?.httpProtocol ?? "") || /^TLSv1(?:\.[0-2])?$/u.test(cf?.tlsVersion ?? ""))) {
    codes.push("transport_legacy");
  }

  if (cf?.timezone && input.pageTimeZone) {
    const at = input.now ?? new Date();
    const edge = utcOffsetMinutes(cf.timezone, at);
    const page = utcOffsetMinutes(input.pageTimeZone, at);
    if (edge !== null && page !== null && Math.abs(edge - page) >= TIME_ZONE_MISMATCH_MINUTES) {
      codes.push("tz_offset_mismatch");
    }
  }
  return codes;
}
