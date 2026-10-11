# Site traffic classification

> Created 2026-10-11.
>
> Scope: telling human visits to the public site apart from automated ones, so
> paid acquisition (X first) can be judged on people rather than requests.
>
> Companion documents: [state](state.md), [public-site telemetry](../../public-site-telemetry.md), [regional telemetry](../../telemetry.md).
>
> Builds on: [public-site product telemetry](../2026-08-13_public-site-telemetry/prd.md).

## Summary

Every visit to the public site gets one traffic class: `declared_bot`,
`automated`, `datacenter`, `human` or `unverified`, with the reason codes that
decided it. The detector does not try to recognise bots. It looks for
**contradictions between what a visitor claims to be and what its network,
headers and browser engine show**: an "iPhone" running Chrome's JavaScript
engine, a script fetch carrying page-navigation headers, swipes that move
nothing, a cloud network keeping Los Angeles time.

The API checks the network and headers when the site's telemetry starts
(`POST /telemetry/bootstrap`). The page adds a few yes/no facts at start and on
leave. Raw inputs are read and discarded where they are read. Only the class
and codes are stored. PostHog stays where we chart it.

This is measurement only. Nothing is blocked, challenged or slowed.

The headline number is **verified human visits per X `url_click`**, reported
next to the automated and unverified shares, never folded together. Every share
the detector reports is a floor, not an exact split.

## Motivation

We pay for X traffic and cannot say how much of it is people.

### What the data says today

Pulled from PostHog on 2026-10-11, last 30 days.

- **Volume.** 262 X visits (4 of them our own `rally_qa*` checks), nearly
  all `utm_source=x&utm_medium=paid_social` and all but 3 between 2026-09-30
  and 2026-10-06. Every one viewed only the landing page.
- **Time on page.** Median 1.3 s for X against 22 s for all other traffic.
  90 left in under 1 s, 88 in 1 to 5 s, 24 in 5 to 30 s and 20 stayed past
  30 s. 40 never sent a page leave at all.
- **Nothing else to go on.** Our own pageviews carry no user agent, network,
  geo or screen data, by design. PostHog's browser SDK, which does carry
  them, only went live on 2026-10-10, after the campaigns stopped. Only one X
  visit has SDK data.

So the honest answer today is "at least 8% human, and we can't say how much
more". Fast exits do not separate people from scripts: survey-era studies put
accidental mobile ad clicks at 47 to 60%, and both groups leave in a second.
Dwell time cannot be the bot test.

### What we know about X

- **No reliable published bot rate.** CHEQ flagged 76% of about 144,000 X
  visits as fake over the 2024 Super Bowl weekend, against 2.8% the year
  before and about 2% for TikTok and Facebook. CHEQ calls the sample
  unscientific. X lost TAG brand-safety certification by March 2024.
- **X prefetches links on iOS.** Since 2025-11-05 the X iOS app loads link
  pages in the background with JavaScript off until the user taps. Prefetches
  never reach our bootstrap, but they do inflate any server-side count.
- **X gives no click-level data.** The Ads API reports hourly aggregates. Its
  `clicks` metric counts likes; `url_clicks` counts link clicks. Billing
  settles over 14 days and is lowered for "junk" events. Refunds are by support
  ticket for billing or technical errors only.

### A bot we already caught by hand

On 2026-10-11 four "Chrome on iPhone" visits arrived within 50 minutes from
Reston, Newark and New York. They had four fresh visitor IDs but an identical
device, browser build and OS. Each reported an `America/Los_Angeles` timezone
from an East Coast address. Each sent swipes that never scrolled the page. None
clicked anything. They came in as direct traffic, not from X. The design below
catches this visitor four separate ways.

### Why not PostHog's filter or a vendor

- **PostHog's `$virt_is_bot`** reads only the user agent. Our pageviews have
  none, so PostHog files all of them as `Automation / no_user_agent`. The bot
  above sent a real Safari-on-iPhone user agent and would pass anyway.
- **Vendors.** An independent study sent about 500,000 requests from 20 paid
  "undetectable" bot services at sites running DataDome and BotD: the bots got
  through 53% and 45% of the time. Adding cross-layer consistency rules roughly
  halved that ([FP-Inconsistent, arXiv 2406.07647](https://arxiv.org/abs/2406.07647)).
  DataDome starts around $3,800 a month. Fingerprint and Castle are affordable
  but built on persistent device IDs, which this design rules out. No
  click-fraud tool we found integrates with X beyond Spider AF.
- **Cloudflare Bot Management.** Its bot score, JA3/JA4 and detection IDs are
  null in a Worker without the Enterprise add-on.

## Goals

1. Answer "what share of X `url_clicks` became a human visit?" per campaign and
   hour, with no manual replay review.
2. Catch scripted browsers that spoof a real phone, not only self-declared
   crawlers.
3. Keep the site's privacy line: no IP, network name, user agent, timezone or
   click identifier is stored or sent to PostHog. Only derived codes cross.
4. Keep working after the PostHog SDK leaves the site.
5. Add nothing measurable to page load time.

## Non-goals

- **Blocking or challenging traffic.** No Turnstile, CAPTCHA or Bot Fight Mode.
  Bot Fight Mode would challenge the bootstrap call and cannot be skipped by
  WAF rules, so it must stay off the API zone.
- **Fingerprinting.** No canvas, audio, font or WebGL hashes, and no
  long-lived device ID. Safari 26 adds noise to those values for everyone
  anyway.
- **Catching every bot.** A bot that drives a real browser through Chrome's
  DevTools protocol produces trusted, scrolling input and will pass as
  `human`. Catching it needs fingerprinting.
- **Sign-up abuse.** The sign-up flow on app.rallywith.ai has its own risk and
  its own PRD if it needs one.

## Product behavior

### The primitive

One pure function, `classifyTraffic(codes) → { class, reasons }`, in the API.
It takes a set of reason codes and returns a class by fixed precedence. It
knows nothing about X, the site or PostHog. Each code comes from a small,
separate check, so adding, removing or promoting a check is a one-line table
edit. Any anonymous producer that starts through a bootstrap call can reuse it.

### Where it runs

1. **At bootstrap, in the page.** The reporter adds a few fields to the
   bootstrap body: the IANA timezone, and yes/no results of the page checks in
   [Signals](#signals) that can run before first paint.
2. **At bootstrap, in the API.** The Worker reads `request.cf` (all plans:
   `asn`, `timezone`, `httpProtocol`, `tlsVersion`, TLS hashes) and request
   headers, computes the edge codes, and recognises iCloud Private Relay by
   the networks Apple egresses through. Raw values are dropped.
3. **Into the capability.** The codes go into the signed telemetry
   capability. The collector stamps the class and codes onto every site event
   that capability sends, so a script cannot set its own class.
4. **On page leave, in the page.** The reporter adds the input facts:
   whether trusted input caused a consequence, whether any untrusted input
   fired, whether a swipe moved nothing, whether the page was ever visible.
   The collector re-runs `classifyTraffic` with them.

### Signals

Ranked by value against cost. "Needs test" means the behaviour rests on
inference or undocumented Cloudflare or browser behaviour; see
[Validation](#validation).

| Rank | Code | Where | True when | Tier | Status |
|---|---|---|---|---|---|
| 1 | `hosting_network` | edge | `cf.asn` is on the checked-in hosting list, and the address is not Private Relay | soft | fields confirmed; list is a team decision |
| 2 | `engine_mismatch` | page | the UA claims iOS, yet Chromium-only APIs exist or `Error().stack` has V8's format | soft until tested, then hard | needs test |
| 3 | `fetch_metadata_bad` | edge | `Sec-Fetch-Site/Mode/Dest` are not `same-site`/`cors`/`empty` | hard | needs capture of exact values |
| 3 | `origin_bad` | edge | `Origin` is missing or not a site origin | hard | confirmed |
| 4 | `declared_bot` | edge | a self-declared crawler, preview fetcher or HTTP library pattern matches the UA | class | confirmed |
| 4 | `headless_ua` | edge | `HeadlessChrome` in the UA or `Sec-CH-UA` | hard | confirmed |
| 4 | `signed_agent` | edge | `Signature-Agent` header present (Web Bot Auth) | class | confirmed |
| 5 | `untrusted_input` | page | any pointer, touch, key or wheel event with `isTrusted === false` | hard | confirmed |
| 5 | `swipe_no_scroll` | page | mostly vertical touch travel on a scrollable page and the page did not move | soft | mechanism confirmed; threshold open |
| 6 | `webdriver` | page | `navigator.webdriver` is true | hard | confirmed |
| 6 | `automation_globals` | page | Playwright's `__playwright__binding__` or `__pwInitScripts` exists | hard | confirmed |
| 7 | `tz_offset_mismatch` | edge + page | the browser's current UTC offset differs from `cf.timezone`'s | soft | confirmed available; no published false-positive rate |
| 8 | `transport_legacy` | edge | HTTP/1.1 or TLS below 1.3 under a modern browser UA | soft | fields confirmed |
| 9 | `accept_language_bad` | edge | `Accept-Language` missing or the literal `*` | soft | Playwright default confirmed |
| 10 | `ch_contradiction` | edge | `Sec-CH-UA` present on a Safari/iOS/Firefox UA, missing on a Chromium UA, or disagreeing on version or platform | soft until tested, then hard | needs test |
| — | `tls_ext_unstable` | edge | an "iPhone" whose TLS extension hash changes across connections (Chrome shuffles, WebKit does not) | hard if it exists | needs test |

Context codes are recorded but are never bot evidence: `private_relay`,
`x_in_app`, `ad_click_id` (shipped, see below), `ever_visible`,
`no_leave_event`.

### Classes

First match wins.

| Class | Rule |
|---|---|
| `declared_bot` | `declared_bot` or `signed_agent` |
| `automated` | any hard code, or two soft codes from different layers (edge, page start, page leave) |
| `datacenter` | `hosting_network` alone |
| `human` | trusted touch, pointer, wheel or key input that produced a consequence (the page scrolled, or a link or control activated) while visible |
| `unverified` | anything else: JavaScript ran, nothing a person did was seen |

`unverified` is not "bot". A person who taps an ad by mistake and closes the
tab in half a second lands here, and on X that is likely most of the 90
sub-second visits. The report keeps it as its own bar.

**Why the human test needs a consequence.** Input injected through the
DevTools protocol reports `isTrusted: true`, and a page scrolled by
`window.scrollTo` almost certainly fires a trusted scroll event. Requiring a
trusted input *and* its effect closes the second route; the first is the
accepted miss.

**Why precedence, not a weighted score.** We have no labelled data to fit
weights, and a rule can be argued with in a refund ticket.

### X click identifiers

Shipped with this PRD: `site_page_viewed` carries `adClickIdSource: "x"` when
the landing URL has a non-empty `twclid`. The identifier itself is dropped in
the page. X appends it to real ad clicks, so it tells a paid click apart from a
copied link that kept the campaign tags. The field is a closed enum so other
platforms (`gclid`, `fbclid`) are one value each.

We do not send `twclid` back through X's Conversions API. That shares data
with X and is a separate decision.

### Reconciling with X

Per campaign, line item and hour:

| Stage | Source | Gap to the next stage means |
|---|---|---|
| 1. `url_clicks` | X Ads API, `PUBLISHER_NETWORK` excluded, billed figures re-pulled after 14 days | taps abandoned before the request reached us |
| 2. Landing HTML requests with `utm_source=x` or `twclid` | Cloudflare GraphQL Analytics (`httpRequestsAdaptiveGroups`, 31+ days on all plans, sampled at volume) | prefetch, Twitterbot, no-JavaScript automation |
| 3. Bootstraps with `adClickIdSource = x` | our events | — |
| 4. Visits by class | our events | automated, datacenter, unverified |
| 5. `human` | our events | — |

Stage 2 runs as a scheduled aggregate query that stores counts only.
Logpush would give unsampled rows, but its `ClientRequestURI` carries full
query strings and click IDs, so it is the fallback, not the default.

### The report

The final class rides on the page leave; a pageview is accepted before the
visitor does anything, so it can never be `human`. One PostHog insight counts X
landing `$pageleave` events for the last 30 days, broken down by
`trafficClass`, one bar per `campaignName`, plus pageviews whose session sent
no page leave under their own class. A page leave carries no campaign tags, so
it is joined to its pageview on `$session_id` for `$utm_campaign` and
`adClickIdSource`. A second insight shows the same for all
traffic. A third, outside PostHog, joins the hourly funnel above.

## Impact on the product contract

None for users. The site's telemetry contract gains, all optional:

- `site_page_viewed.adClickIdSource` (shipped).
- `trafficClass` and `trafficReasons` on `site_page_viewed` and
  `site_page_left`, set by the collector.
- The page-leave input facts on `site_page_left`.
- Bootstrap body fields for the page-start checks.

Older tabs that send none of these keep working and classify as `unverified`.

## Key design decisions

### Classify at bootstrap, not with a Worker in front of the HTML

The landing page is static assets with no Worker in the path. Putting one there
adds latency to every page load. Bootstrap already crosses the edge once per
JavaScript-running visit, which is exactly the set we have events for, and
Cloudflare's aggregate analytics covers the rest without a Worker.

### Derived codes cross the privacy line, raw values do not

[Public-site telemetry](../../public-site-telemetry.md) treats every new
property as a privacy decision and refuses identifying, high-cardinality data.
An ASN, a timezone, a user agent or a click identifier narrows down who someone
is. "Hosting network: yes" does not. Nothing raw is logged, stored in D1, or
forwarded.

### Header checks close the replay route

Anyone can replay `POST /telemetry/bootstrap` from a script and forge
`humanInput`. A browser cannot omit `Origin` on a cross-origin POST, and every
major browser has sent Fetch Metadata since March 2023. Impersonation tools
such as `curl_cffi` ship navigation values (`Sec-Fetch-Mode: navigate`), which
are wrong for a fetch. These checks cost nothing.

### Rejected signals

- **The DevTools `Error.stack` getter trick.** Dead in stock Chrome since V8
  changes in May 2025, and it flagged humans with DevTools open.
- **Round-trip-time proxy detection.** Strong in the lab, but simple timing
  attacks cut its detection rate from 99% to 8% (NDSS 2026), and it needs
  calibration we can't do yet.
- **Header order.** Cloudflare does not preserve it.
- **Accept-Language against location.** Too many travellers and expats.
- **`window.chrome`, plugins, notification permission, `ApplePaySession`.**
  Misfire on iOS and in-app browsers.
- **Invisible Turnstile.** The cheapest upgrade if the first-party set proves
  too weak, not a starting point: it adds a third-party script.

## Data model

- **Capability claims:** add the edge codes. Signed as today.
- **`telemetry_accepted_events` rows:** carry class and codes inside the event
  properties. No new column, no migration.
- **Contracts:** `packages/contracts/src/telemetry.ts` gains closed enums for
  class and codes. The schemas stay `strictObject`.
- **Hosting ASN list:** a checked-in starter set of large cloud and VPS
  networks in `apps/api/src/telemetry/hosting-networks.ts`, edited by hand.
  Private Relay is recognised by its egress networks (Akamai's relay ASN,
  Cloudflare, Fastly), not Apple's address CSV, which is too large to ship in
  the Worker.

## Security and trust model

- **The class is server-made.** The page supplies yes/no facts that a script
  can lie about. Lying can only make a visit look more human. The header
  checks catch replays from raw HTTP clients, so a convincing lie needs a real
  browser, which the page checks then see.
- **Consent exposure.** Edge signals read only what the browser already sent.
  Page checks read device properties, which the EDPB's Guidelines 2/2023 place
  under ePrivacy Article 5(3), and the UK ICO says fingerprinting needs consent
  even for fraud prevention unless strictly necessary. Page checks therefore
  follow whatever regional rule governs the site's analytics. Where that rule
  withholds them, the class uses edge codes only and the visit is tagged
  edge-only, so its weaker `human` test stays visible. `cf.isEUCountry` covers
  the EU; the UK needs its own country check.
- **No effect on the page.** Any check that throws yields no code. Failure
  falls back to `unverified` and never fails bootstrap.

## Rollout

1. **Now:** `adClickIdSource` (shipped with this PRD).
2. **Before the PostHog SDK is removed:** hand-label 30 or more replays (X and
   direct). This is the only ground truth we will have.
3. Run the [validation](#validation) checks that decide which codes ship hard.
4. Contract, API and collector change for the edge codes.
5. Site change for the page codes.
6. Build the insights and the hourly X funnel for the next campaign.

## Validation

In order of urgency and dependency.

| # | Test | Settles |
|---|---|---|
| 1 | Label 30+ replays with what the classifier would say | ground truth for every rule |
| 2 | Team-only diagnostic capture on bootstrap, then removed | whether `request.cf.botManagement` is null on our plan; whether `Sec-CH-UA` reaches api.rallywith.ai; exact `Sec-Fetch-*`, `Origin`, `httpProtocol` values |
| 3 | 20 fresh connections each from desktop Chrome, iPhone Safari and Chrome on iPhone | whether `tlsClientExtensionsSha1` follows received order, which decides whether `tls_ext_unstable` exists |
| 4 | Open the landing page from Safari, Chrome and X's in-app browser on iOS and Android, including from an ad preview | `engine_mismatch` false positives; X in-app UA strings |
| 5 | Playwright with iPhone emulation and an LA timezone on a cloud VM; curl, undici and Python replays; `dispatchEvent` swipes; Playwright taps | each hard code fires for the right reason (also the repo's prove-the-test-can-fail rule) |
| 6 | One-page test in Chrome and Safari | whether `scrollTo` scroll events are trusted |
| 7 | Cloudflare GraphQL Explorer | which `httpRequestsAdaptiveGroups` filters and dimensions our plan exposes |
| 8 | X Ads API pull for the next campaign | `url_clicks` by hour, placement and platform; zero `PUBLISHER_NETWORK` |

Steps 2 and 4 decide whether `engine_mismatch` and `ch_contradiction` move from
soft to hard.

## Acceptance

- A desktop browser on a home connection that scrolls the landing page is
  `human`.
- Playwright Chromium emulating an iPhone on a cloud VM with an LA timezone is
  `automated`, with at least `engine_mismatch`, `hosting_network` and
  `tz_offset_mismatch`.
- A page whose only input is script-dispatched touch events is `automated`
  with `untrusted_input`.
- `curl` against bootstrap is `declared_bot` or `automated` with `origin_bad`.
- An iCloud Private Relay visitor is never `datacenter`.
- No event in PostHog or D1 contains an ASN, network name, IP, user agent,
  timezone name or click identifier.
- Bootstrap latency does not change measurably.

## Open questions

These are the team's to set. Suggested starting points are reasoning, not
measurements.

| Decision | Suggested start |
|---|---|
| Which networks count as hosting, and who maintains the list | Major clouds and VPS hosts from X4BNet; residential and VPN providers left out at first |
| Timezone mismatch size | current UTC offsets differ by 1 h or more |
| `swipe_no_scroll` distance | a few tens of CSS px, mostly vertical, starting away from screen edges, only on pages taller than the window |
| Human input minimum | one trusted input with a consequence; add a time floor only if replays show stray close-taps counted as human |
| Soft codes needed for `automated` | two, from different layers |
| Funnel alert | flag a campaign-hour where bootstraps fall below about half of `url_clicks` |
| Cookie Notice wording | say request and browser signals are used to label analytics traffic, not only to prevent abuse; needed before page checks ship to the EU and UK |
