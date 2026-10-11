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
`datacenter`, `automated`, `unverified` or `human`. The class comes with fixed
reason codes. The API decides it from the request when the site's telemetry
starts up, and the browser adds one fact on page leave: whether a real person
touched, clicked, typed or scrolled. Raw signals (IP, network, user agent,
timezone) are read and thrown away at the edge. Only the class and the codes
are stored. PostHog stays the place we chart it, not the place we detect it.

This is measurement only. Nothing is blocked, challenged or slowed.

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
more". The 20 visits that stayed 30 s are the floor. The other 242 are fast
exits or silent, which fits both people who mis-tapped an ad and scripts. We
cannot tell those apart with what we collect.

### A bot we already caught by hand

On 2026-10-11 four "Chrome on iPhone" visits arrived within 50 minutes from
Reston, Newark and New York. They had four fresh visitor IDs but an identical
device, browser build and OS. Each reported a `America/Los_Angeles` timezone
from an East Coast address. Each sent swipes that never scrolled the page
(PostHog logged them as `$dead_swipe`). None clicked anything. They came in as
direct traffic, not from X. The class below exists to catch this without
someone watching replays.

### Why PostHog's built-in bot filter does not answer it

PostHog's `$virt_is_bot` and `isLikelyBot()` read only the user agent.

- Our own `$pageview` and `$pageleave` events have no user agent, so
  PostHog files all of them as `Automation / no_user_agent`. That is 100% of
  our pageviews, which tells us nothing.
- The bot above sent a real Safari-on-iPhone user agent. A user-agent check
  passes it.
- The SDK that does send user agents is temporary
  ([public-site telemetry](../../public-site-telemetry.md) plans to remove it).

PostHog custom bot rules can match `$ip`, screen size, or referrer, but our
project discards IPs and the other fields don't separate this traffic.

## Goals

1. Answer "what share of X visits were human?" per campaign, from data we
   already keep, with no manual replay review.
2. Catch scripted browsers that spoof a real phone, not only self-declared
   crawlers.
3. Keep the site's privacy line: no IP, network name, user agent or timezone
   is stored or sent to PostHog. Only derived codes cross.
4. Keep it working after the PostHog SDK leaves the site.
5. Add nothing to page load time.

## Non-goals

- **Blocking or challenging traffic.** No Turnstile, CAPTCHA or rate limit on
  the landing page. A wrong verdict must cost us a number, not a visitor.
- **Fingerprinting.** No canvas, font, audio or hardware probes, and no
  long-lived device ID. Each signal is a yes/no about this one request.
- **Sign-up abuse.** The sign-up flow on app.rallywith.ai has its own risk and
  its own PRD if it needs one.
- **Seeing bots that never run JavaScript.** They never start telemetry, so
  they never reach this classifier. We count them by difference (see
  [Reconciling with X](#reconciling-with-x)).

## Product behavior

### The primitive

One function, `classifyTraffic(signals) → { class, reasons }`, run in the API.
It takes yes/no signals and returns one class and the codes that drove it. It
knows nothing about X, the site or PostHog. Any anonymous producer that starts
through a bootstrap call can reuse it, including the web app's sign-up page
later.

### Where it runs

The site already calls `POST /telemetry/bootstrap` on the API once per page
load, before it sends any event. That request is the only point where we see
the visitor's real connection, and it costs nothing extra.

1. The browser adds two fields to the bootstrap body: its IANA timezone name,
   and `navigator.webdriver` as a boolean.
2. The API reads `request.cf.asn`, `request.cf.timezone` and the
   `User-Agent` header. All are on every Cloudflare plan; the Bot Management
   score is not, and we do not use it.
3. It computes the signals below, runs `classifyTraffic`, and writes the
   class and codes into the signed telemetry capability. Raw inputs are
   dropped there and then.
4. The collector stamps the class and codes onto every site event that
   capability sends. The browser never sees or sets the class, so a script
   cannot upgrade itself to `human`.
5. On page leave the browser reports `humanInput: boolean`. It is true once
   any trusted pointer, touch, key, wheel or scroll event fired while the page
   was visible. Script-made events have `isTrusted === false` and never count.
   The collector upgrades `unverified` to `human` when this is true.

### Signals

| Code | Source | True when |
|---|---|---|
| `declared_bot` | User-Agent | The agent names itself a crawler, preview fetcher or HTTP client. |
| `hosting_network` | `cf.asn` | The address belongs to a cloud or hosting network on our checked-in list. |
| `webdriver` | browser | `navigator.webdriver` is true. |
| `timezone_mismatch` | `cf.timezone` and browser | The browser's timezone and the address's timezone are in different UTC offsets right now. |
| `x_in_app` | User-Agent | The page opened in X's own in-app browser. A context flag, not a bot signal. |
| `human_input` | browser, on leave | A trusted input event fired while the page was visible. |

### Classes

First match wins.

| Class | Rule |
|---|---|
| `declared_bot` | `declared_bot` |
| `automated` | `webdriver`, or `hosting_network` with `timezone_mismatch` |
| `datacenter` | `hosting_network` |
| `human` | `human_input` |
| `unverified` | anything else: JavaScript ran, nothing a person did was seen |

`unverified` is not "bot". A person who taps an ad by mistake and closes the
tab in half a second lands here, and on X that is common. The report keeps
`unverified` as its own bar rather than splitting it.

`timezone_mismatch` alone never makes a visit `automated`. VPN users and
travellers trip it. It only counts when paired with a hosting network.

### Reconciling with X

X Ads reports clicks per campaign. We see three later steps per campaign:

1. **Bootstraps:** the visit ran our JavaScript.
2. **Classified visits:** by class, as above.
3. **Human visits:** class `human`.

Clicks minus bootstraps is the gap that holds no-JavaScript bots, link
preview fetchers, and people who left before the page loaded. We cannot split
that gap further, but its size per campaign is the first number to look at.
This needs an export from X Ads, not a code change.

### The report

One PostHog insight: X landing pageviews for the last 30 days, broken down by
`trafficClass`, one bar per `campaignName`. A second insight shows the same for
all traffic, so X can be compared with direct and organic visitors.

## Impact on the product contract

None for users. The site's telemetry contract gains two optional properties on
`site_page_viewed` and `site_page_left` (`trafficClass`, `trafficReasons`) and
one on `site_page_left` (`humanInput`). The bootstrap request gains two
optional fields. Older tabs that send neither keep working and classify as
`unverified`.

## Key design decisions

### Classify at bootstrap, not with a new Worker in front of the HTML

The landing page is served as static assets with no Worker in the path. Putting
one there would add latency to every page load. Bootstrap already crosses the
edge once per page, and only for visits that ran JavaScript, which is exactly
the set we have events for.

### Derived codes cross the privacy line, raw values do not

[Public-site telemetry](../../public-site-telemetry.md) treats every new
property as a privacy decision and refuses identifying, high-cardinality data.
An ASN, a timezone or a user agent narrows down who someone is. A boolean
"hosting network: yes" does not. The API compares and forgets. Nothing raw is
logged, stored in D1, or forwarded.

### Trusted input as the human signal

The bot we caught sent swipes from script. A browser marks those
`isTrusted: false`, so they never count. A bot that drives a real browser
through the DevTools protocol does produce trusted events and will pass as
`human`. We accept that miss. Catching it means fingerprinting, which is a
non-goal.

### Not Cloudflare Bot Management

Its score would be the strongest single signal, but it is an Enterprise add-on.
If we later buy it, its score becomes one more code in the same table.

### Not PostHog's classifier

See [Why PostHog's built-in bot filter does not answer it](#why-posthogs-built-in-bot-filter-does-not-answer-it).
PostHog remains where the class is charted.

## Data model

- **Capability claims:** add `trafficClass` and `trafficReasons`. Signed as
  today.
- **`telemetry_accepted_events` rows:** carry the two fields inside the event
  properties. No new column, no migration.
- **Contracts:** `packages/contracts/src/telemetry.ts` gains the enums and the
  optional properties on the two site events. The schemas stay
  `strictObject`.

## Security and trust model

- **The class is server-made.** The browser supplies only `webdriver`, its
  timezone and `humanInput`. A script can lie about all three. Lying about the
  first two can only make it look more human. Lying about `humanInput` turns
  `unverified` into `human` and is the cheapest evasion available. We accept
  it: the threat is ad bots that don't target our telemetry, and any bot that
  does is already outside this design.
- **No new disclosure of raw data.** The Cookie Notice already says hosting
  and security logs may use IP and user agent "to prevent abuse". Using them
  to label analytics is close to that but not the same; see open questions.
- **No effect on the page.** Classification failure falls back to
  `unverified` and never fails bootstrap.

## Rollout

1. Contract and API change, behind no flag: classification only adds
   properties.
2. Site change: bootstrap body fields and `humanInput` on leave.
3. While the PostHog SDK is still on the site, hand-check 30 recent replays
   against their class. Any replay showing a person scrolling that the
   classifier calls `automated` or `datacenter` is a bug in the rules.
4. Build the two insights.
5. Ask for the X Ads click export for the next campaign and fill in the
   reconciliation.

## Acceptance

- A visit from a desktop browser on a home connection that scrolls the landing
  page is `human` in PostHog.
- A headless browser on a cloud VM with its timezone set to another region is
  `automated`, with reasons `hosting_network` and `timezone_mismatch`.
- A page whose only input is script-dispatched touch events stays
  `unverified`.
- `curl` against bootstrap gets `declared_bot`.
- No event in PostHog or D1 contains an ASN, network name, IP, user agent or
  timezone name.
- Bootstrap latency does not change measurably.

## Open questions

These are the team's to set, not the implementer's.

1. **Which networks count as hosting.** A short checked-in ASN list (the large
   clouds and VPS hosts) is cheapest. Who owns it, and do we include
   residential-proxy and VPN providers?
2. **What counts as human input.** Any single trusted event, or a minimum
   (for example a scroll, or input after the first second, to rule out a
   stray tap while closing)? The number is a decision, not a detail.
3. **Notice wording.** Do we update the Cookie Notice to say request signals
   are used to label traffic in analytics, beyond abuse prevention?
4. **Do we have Bot Management?** If our Cloudflare plan already includes it,
   the score replaces the hosting-network list.
5. **Click IDs.** Should the reporter record whether `twclid` was present, as
   a boolean, to separate real ad clicks from copied links that still carry
   UTM tags?
