# Site traffic classification

Every public-site visit that runs JavaScript gets one traffic class,
`declared_bot`, `automated`, `datacenter`, `human` or `unverified`, and the
reason codes that decided it. The class rides on `site_page_viewed` and
`site_page_left` into PostHog as `trafficClass` and `trafficReasons`. It exists
so paid acquisition (X first) can be judged on people rather than requests.

The detector does not try to recognise bots. It looks for contradictions
between what a visitor claims to be and what its network, headers and browser
engine show, and stores each answer as a yes/no code. Raw inputs are read and
dropped where they are read. It measures and never blocks.

The product decision and the research behind it are in the
[traffic classification PRD](PRDs/2026-10-11_site-traffic-classification/prd.md).
The events it rides on belong to [public-site telemetry](public-site-telemetry.md).

## Where the code lives

| Path | Role |
|---|---|
| `packages/contracts/src/telemetry.ts` | The closed code lists (`SITE_EDGE_SIGNALS`, `SITE_PAGE_START_SIGNALS`, `SITE_PAGE_LEAVE_SIGNALS`, `SITE_TRAFFIC_CLASSES`), the bootstrap body fields and the event properties. |
| `apps/api/src/telemetry/site-traffic.ts` | `classifySiteTraffic` (codes to class) and `edgeTrafficSignals` (request to codes). |
| `apps/api/src/telemetry/hosting-networks.ts` | The hosting ASN list and the iCloud Private Relay ASNs. |
| `apps/api/src/routes/telemetry.ts` | `POST /telemetry/bootstrap` computes the edge codes and passes them to bootstrap. |
| `apps/api/src/telemetry/bootstrap.ts` | Signs the codes into the capability (`traffic` claim); `withTrafficClass` stamps class and reasons on acceptance. |
| `apps/site/src/traffic-signals.ts` | The page's start checks, time zone and input watcher. |
| `apps/site/src/telemetry.ts` | Sends the start checks with bootstrap and the input facts with `site_page_left`. |

## How it works

1. **Page start.** Before bootstrap the page runs `pageStartSignals()` and
   sends those codes and its IANA time zone in the bootstrap body.
2. **Edge.** The bootstrap route runs `edgeTrafficSignals` on the request:
   its network, headers and transport, and the page's time zone against the
   address's.
3. **Capability.** Edge and start codes, sorted and deduplicated, go into the
   signed capability's `traffic` claim. Nothing else about the request is kept.
4. **Page leave.** `watchPageInput()` reports what the visitor's input did, as
   `pageSignals` on `site_page_left`.
5. **Acceptance.** `withTrafficClass` merges the capability's codes with a page
   leave's `pageSignals`, runs `classifySiteTraffic`, and writes `trafficClass`
   and `trafficReasons` over whatever the page sent, dropping `pageSignals`.

What each code checks is commented beside it in `apps/api/src/telemetry/site-traffic.ts`
and `apps/site/src/traffic-signals.ts`; the code lists are in the contract. The
class rule is the `HARD` and `SOFT_GROUP` tables and `classifySiteTraffic` in
`site-traffic.ts`: first match wins, from `declared_bot` through `automated`
(any hard code, or soft codes from two groups), `datacenter`, `human` and
`unverified`. Those tables are the source of truth; this document does not
repeat them.

A pageview carries the class its bootstrap earned, which can never be `human`:
it is accepted before the visitor has done anything, and an accepted event is
never rewritten. The page leave carries the final class. **Count visits by class
from `$pageleave`**, and add pageviews whose session has no page leave under
their own (at best `unverified`) class. A page leave carries no campaign
tags; join it to its pageview on `$session_id`, which both share, to get
`$utm_campaign` and `adClickIdSource`. A chart of `$pageview` by
`trafficClass` alone shows no humans by construction.

## Invariants

- **The API sets the class, never the page.** `withTrafficClass` overwrites
  `trafficClass` and `trafficReasons` on every classified event. If it stopped,
  any page could report itself human.
- **Only closed codes cross.** Every code list is a closed enum in the
  contract. A free-form field here would let an ASN, a time zone or a user
  agent reach PostHog, which [public-site telemetry](public-site-telemetry.md)
  forbids.
- **Classification never fails bootstrap.** The checks are pure and guard
  every runtime call that can throw. A broken check that threw would take the
  site's telemetry down with it.
- **One soft code never decides.** Each has an innocent population (VPNs,
  travellers, proxies, carousels). Promoting a code to hard is a table edit
  that needs evidence from the PRD's validation plan.
- **`human` needs a consequence.** Input injected by a page script is
  untrusted, but a script or the browser can scroll the page itself. Only a
  scroll that begins within `SCROLL_AFTER_INPUT_MS` of a trusted, deliberate
  input counts; an input long past vouches for nothing.

## Boundary

Owns the codes, the class rule and the network lists. Exposes `trafficClass`
and `trafficReasons` on two site events. Does not own the events themselves,
bootstrap, the capability format, PostHog delivery, consent, or the X
reconciliation funnel (Cloudflare GraphQL counts, X Ads `url_clicks`), which is
analysis outside this module.

## Failure modes and limits

- **Bots that drive a real browser through the DevTools protocol** produce
  trusted input that really scrolls the page. They read as `human` unless
  another code catches them. Catching them needs fingerprinting, which this
  module refuses.
- **Residential proxies** pass the network check.
- **Cloudflare's own network** is labelled Private Relay and is not on the
  hosting list, so a script running on Cloudflare Workers or WARP is never
  `datacenter`.
- **Browser extensions** fire synthetic input, so `untrusted_input` is soft
  and needs a second, independent code.
- **No page leave** (a killed webview, a crash) leaves the pageview's class,
  which is at best `unverified`.
- **Tabs opened before deploy** send no start codes and no time zone; their
  visits classify on edge codes alone.
- **Bots that never run JavaScript** never bootstrap and are never classified.
  Count them by difference against Cloudflare's request counts.

## Testing

- `apps/api/test/site-traffic.test.ts`: the class table, each edge check, and
  two visits through bootstrap and acceptance on the real migrations (the
  scripted iPhone seen in replay, and an iPhone visitor who scrolled).
- `apps/site/test/site-telemetry-client.test.ts`: the bootstrap body, the
  engine check under an iOS user agent, and script-made input on leave.
- `packages/contracts/src/telemetry.test.ts`: closed lists reject raw values.

jsdom cannot make trusted input, so `human_input` and a real `swipe_no_scroll`
are checked in Chromium through Playwright with the API intercepted: a mouse
wheel scroll gives `human_input`; a script-dispatched swipe on an emulated
iPhone gives `engine_mismatch`, `untrusted_input` and `swipe_no_scroll`.

## Security and trust model

The page's codes are claims a script can forge, but forging only makes a visit
look more human, and replaying bootstrap without a browser trips `origin_bad`,
`fetch_metadata_bad` or `declared_bot`. Page checks read device properties,
which EU and UK regulators treat as needing consent for non-essential purposes;
they run wherever the site's analytics runs, which today is everywhere. If the
site gains a regional consent rule, the page checks follow it and the class
falls back to edge codes.

## Open questions

The numbers below are starting points the team owns, not measurements:
the hosting ASN list, the 60-minute time zone gap, the 30 px swipe, the 24 px
edge margin, the 500 ms swipe scroll wait and the 1 s input-to-scroll window. The Cookie Notice still describes
request signals as used "to prevent abuse", not to label analytics.

## Changelog

### 2026-10-11 — Classify public-site visits by contradictions, not bot signatures

**What changed:** Bootstrap reads the request's network and headers and the
page's start checks into signed codes; page leave adds input facts; acceptance
stamps a class and reasons on `site_page_viewed` and `site_page_left`.

**Why:** 262 paid X visits could not be split into people and scripts. Our
events carry no user agent, so PostHog's user-agent classifier filed every one
as automation, and a scripted "Chrome on iPhone" seen in replay sent a real
Safari user agent anyway. A study of 20 paid bot services found they evade
commercial detectors about half the time, and consistency rules across layers
roughly halved that (FP-Inconsistent, arXiv 2406.07647).

**Considered and rejected:** Cloudflare Bot Management (Enterprise only), paid
detectors (about $4k a month, or built on persistent device IDs), a Worker in
front of the landing HTML (latency on every page), the `isbot` package (adding
any dependency under pnpm 11 re-resolved every `latest` range in the
lockfile), canvas, audio and WebGL fingerprints, and the DevTools
`Error.stack` trick (dead since V8 changes in May 2025).

**Consequences:** The class is a floor on automation, not an exact split.
Promoting a soft code to hard, or changing a threshold, should come with
replay or device evidence. The TLS extension-order check and the X
reconciliation funnel in the PRD are not built yet.

Shipped in [PR #1192](https://github.com/juno-ai-labs/avalon/pull/1192); see the [traffic classification PRD](PRDs/2026-10-11_site-traffic-classification/prd.md).
