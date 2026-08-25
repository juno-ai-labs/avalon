# Public-site telemetry

Rally's public site records a closed, content-free acquisition and desktop-
handoff journey through the same regional telemetry boundary as the desktop.
Global traffic can form an anonymous multi-page funnel and reaches PostHog as
real web events. EU traffic stays in Rally's EU Cloudflare resources and is
page-scoped: the site does not read or write a persistent analytics identifier
for an affirmative EU route.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/telemetry.ts` | Cloudflare route lookup, region-dependent anonymous identity, capability bootstrap, closed envelopes, page/action/handoff reporting, and failure isolation. |
| `apps/site/src/site-entry.ts` | Initializes page-view and page-leave reporting on every built HTML entry. |
| `apps/site/src/landing.ts` | Reports bounded download, CTA, FAQ, connector, and support selections. |
| `apps/site/src/*-handoff.ts`, `desktop-open.ts`, `invite.ts`, `slack-link.ts`, `workstream-link.ts` | Report presented, automatic, and manual browser-to-desktop handoff attempts after each page has validated its own target. |
| `apps/site/vite.config.ts` | Injects the shared telemetry entry and immutable release/build context into every site page. |
| `apps/api/src/routes/telemetry.ts` | Exposes the content-free Cloudflare route decision and the capability-bound anonymous ingest. |
| `apps/api/src/telemetry/bootstrap.ts` | Reduces Cloudflare country to `eu` or `global`, fixes the journey route, and permits only the public-site event allowlist before authentication. |
| `apps/api/src/telemetry/posthog-adapter.ts` | Maps the Global page observations once to PostHog `$pageview` and `$pageleave`. |
| `apps/site/cookies/index.html` | Public disclosure for first-party site analytics, browser storage, regional behavior, and prohibited fields. |

The product decision is in the [public-site telemetry
PRD](PRDs/2026-08-13_public-site-telemetry/prd.md). The shared event, retention,
and destination mechanics remain in [`telemetry.md`](telemetry.md).

## How it works

Every page first requests `GET /telemetry/route` from the Global edge. The
response carries the coarse `eu`/`global` route, whether it came from Cloudflare
geolocation or the conservative Global fallback, and a five-minute signed route
token. It creates no D1 journey and returns `Cache-Control: no-store`. The site
then selects an identity:

- Global reads or creates one random UUIDv7 in first-party `localStorage`, so
  landing, download, and handoff pages can form one anonymous acquisition path.
- EU creates one in-memory UUIDv7 for this page load and never reads or writes a
  persistent analytics identifier.

That ID and the signed route token enter the ordinary `/telemetry/bootstrap`
exchange. Bootstrap consumes the token's route rather than independently
classifying the second request; a pre-existing journey with a conflicting route
is rejected. The signed, one-hour capability then fixes the route and anonymous
epoch. Events enter
`/telemetry/anonymous`; the Global Worker either accepts them locally or sends
an already validated EU projection through the named EU telemetry RPC. The
country and source IP are not event properties and are not retained by this
subsystem.

`site_page_viewed` carries a closed page class, a lowercased bounded pathname,
an external referring domain, and allowlisted `utm_source`, `utm_medium`, and
`utm_campaign` values. `site_page_left` carries the page/path and a bounded
visible-duration bucket. Global maps these observations one-for-one to PostHog
`$pageview` and `$pageleave`, with URL/host/path properties derived from the
already validated site context. Electron screen events never impersonate web
page events.

`site_action_selected` reports only a closed action and placement on landing,
download, or support pages. `desktop_handoff_attempted` reports the handoff type,
whether it was merely presented or actually attempted, and whether the local
target parser considered it valid. Handoff query strings, URL fragments,
single-use tickets, invitation tokens, Slack state, work-stream IDs, automation
IDs, and settings values never enter an event.

Reporting is fire-and-forget. A page keeps at most 20 already-sanitized events
in memory, sends immediately, and uses browser `keepalive` only for the single
page-leave attempt. It has no persistent event spool and no retry that can delay
navigation or opening the desktop.

## Invariants

- **Routing precedes browser identity selection.** EU must not read a Global
  persistent anonymous ID. The signed decision used for identity selection is
  the decision bootstrap consumes, so a network/location change between the two
  requests cannot move the epoch or event.
- **One observed page produces one web event.** The adapter translates the
  Rally event to the reserved PostHog name; it does not deliver a custom copy.
- **Handoff analytics never carries the handoff.** Tokens, fragments, query
  values, and resource identifiers stay inside the page-specific parser.
- **The site has no generic capture or DOM autocapture.** A new event starts in
  the shared closed registry and one semantic producer.
- **Measurement cannot change the site experience.** Storage denial, route or
  bootstrap failure, a rejected event, and destination failure are silent to
  navigation, downloads, and desktop handoffs.

## Boundary

This module owns public-site page classification, anonymous acquisition
identity, semantic action capture, and browser-to-desktop handoff measurement.
It does not own advertising, cross-site identity, account identification,
session replay, heatmaps, form analytics, consent-law determinations, or the
desktop action that follows a handoff. Site identities are not automatically
linked to a Rally login.

## Failure modes and limits

- If route lookup or capability bootstrap fails, events for that page are lost;
  product behavior continues.
- A route token expires after five minutes and a token/journey route conflict is
  rejected. The page does not retry with a newly inferred route or reuse the
  selected epoch across that conflict.
- `pagehide` delivery is best effort. A browser that terminates before the
  keepalive request begins can omit `site_page_left`.
- EU paths cannot be joined across full page loads because EU uses a page-scoped
  anonymous epoch. Aggregate page, action, and handoff funnels remain available.
- Global browsers that block `localStorage` receive a fresh epoch and remain
  usable; only cross-page attribution is reduced.
- Campaign fields are 160-character allowlisted taxonomy values. The reporter
  ignores arbitrary query keys and never sends a complete URL.

## Testing

```bash
pnpm --filter @rally/site test
pnpm --filter @rally/site typecheck
pnpm --filter @rally/site build
pnpm --filter @rally/api exec vitest run test/telemetry-routes.test.ts test/posthog-adapter.test.ts
pnpm --filter @rally/contracts test
```

Site tests prove every HTML entry receives the shared reporter, legal copy
matches the implemented storage boundary, and bootstrap receives the signed
decision used before identity selection. API tests force different Cloudflare
country values between route lookup and bootstrap and prove the signed first
decision wins without creating an EU journey for a persistent Global epoch.
They also prove the route endpoint creates no journey, site events pass only the
anonymous allowlist, and the Global destination gets the exact reserved
web-event mapping.

## Regional impact

The public route lookup and signed-capability issuer exist only on the Global
Worker because Cloudflare observes the incoming country there. An affirmative EU
route sends the validated event projection to EU over `EU_TELEMETRY_BRIDGE` and
terminates in EU D1. EU has no PostHog token or destination call. Non-EU,
unknown, malformed, or unavailable geolocation uses Global and may reach the US
PostHog project. Nothing is queued in a region-pending store or moved after an
explicit choice elsewhere in the product.

## Security and trust model

The site is an untrusted anonymous producer. The route token proves only one
short-lived content-free routing decision; it grants no ingest or account
authority. The capability authorizes only its fixed epoch, route, and the
pre-authentication event allowlist. Both the shared envelope and each event use
strict schemas; accepted events still pass regional collection validation and
retention. CORS permits only the production Rally site origins and explicit
local development origins. The reporter never receives a PostHog token,
regional service credential, account session, or cross-region bridge authority.

## Operations

The public site needs no analytics secret. The Global Worker needs exact
`ALLOWED_ORIGINS` entries for all four served site origins —
`https://rallywith.ai`, `https://www.rallywith.ai`, `https://with-avalon.com`,
and `https://www.with-avalon.com` — plus the existing telemetry capability signing
key and Global PostHog configuration. Operators inspect Global and EU telemetry
backlogs independently; a healthy Global PostHog graph says nothing about EU
site delivery. Cloudflare Pages applies one `/*` Content Security Policy to
every public path. Its `connect-src` permits the Global browser origin on both
zones, `https://api.rallywith.ai` and `https://api.with-avalon.com`: the route
probe, bootstrap, and anonymous batch all use it, and the page calls the
canonical host from whichever domain served it. An EU decision is forwarded
server-side over `EU_TELEMETRY_BRIDGE`; the browser must not call
`https://eu.api.rallywith.ai` directly.

`$host` and `$current_url` on a web event are reconstructed in the Global
PostHog adapter from the Worker's own `PUBLIC_WEB_BASE_URL`, because a site
envelope reports a `pathname` and deliberately nothing else about its origin.
While two domains both answer, that attributes every visit to the canonical one.
Splitting acquisition by domain would mean the site reporting its own host — a
registered property and a privacy-boundary decision, not a default to assume.

## Performance and cost

The route lookup and bootstrap add two small no-store Global requests to a page
that reports. Events are sent immediately in batches bounded by the shared
256-KiB/50-event contract; the page itself holds at most 20. The route lookup
avoids writing a disposable D1 journey merely to decide whether browser storage
is allowed.

## Changelog

### 2026-08-25 — The web page host is read from configuration, not hardcoded

**What changed:** `$host` and `$current_url` on `$pageview` and `$pageleave` are
built from the Worker's `PUBLIC_WEB_BASE_URL` instead of a literal
`with-avalon.com`. `mapPostHogCapture` and `sendPostHogBatch` take the base URL
as an argument. The site's own production-environment check now recognises all
four served hostnames.

**Why:** The rebrand to Rally made the public site answer on two domains at once.
A literal naming one of them stops being merely stale and becomes wrong for the
whole migration — which is precisely the period the acquisition numbers are being
read. The site reports a `pathname` and deliberately nothing else about its
origin, so the host has to come from somewhere; configuration is the only source
that follows the canonical domain without another edit.

The environment check was the sharper bug: it compared `location.hostname`
against the two Rally hosts, so every visit arriving on a Rally domain would
have been filed as `staging` — invisible in the production funnel, and
indistinguishable from a drop in traffic.

**Considered and rejected:** Adding the host to the `site_page_viewed` envelope so
acquisition could be split by domain, which is genuinely the more useful number
during a migration. That is a registered telemetry property and a privacy-boundary
decision, not something to add as a side effect of removing a literal; it goes
through [`adding-new-instrumented-event.md`](adding-new-instrumented-event.md) if
the split is wanted.

**Consequences:** While both domains answer, every visit is attributed to the
canonical one; the split is unavailable until the site reports its own host. Any
new caller of `mapPostHogCapture` must pass the deployment's web base URL — the
argument is required rather than defaulted, so a caller cannot silently
reintroduce a hardcoded host. See [`domain-migration.md`](domain-migration.md).
### 2026-08-13 — One site-wide CSP admits the complete regional telemetry exchange

**What changed:** The `/*` Cloudflare Pages policy permits the one Global API
origin used by route lookup, bootstrap, and anonymous batch delivery. Tests
enumerate all three paths and reject a direct EU browser origin.

**Why:** `connect-src 'none'` blocked the reporter before CORS or regional
routing ran. Adding the EU API origin would have bypassed the Global-only route
decision and signed-capability exchange.

**Considered and rejected:** Allowing broad HTTPS connections or both regional
API hosts. The site needs one outbound origin; affirmative EU traffic crosses
the named server-side RPC after validation.

**Consequences:** Every new public-site network dependency needs an explicit CSP
review. Telemetry path additions must stay on the Global API origin unless the
regional architecture is deliberately revised.

### 2026-08-13 — Public paths and invalid handoffs keep truthful bounded classes

**What changed:** Canonical work-stream handoff paths collapse their UUID segment
to `/app/workstreams/:id` before page-view or page-leave construction. Invalid
generic desktop targets preserve a provable workstream/settings/automation type,
or use `unknown` when no type is provable, instead of defaulting to Settings.

**Why:** Raw work-stream pathnames leaked the resource identifier that the public
site contract prohibits, while attributing every malformed target to Settings
corrupted the handoff funnel.

**Considered and rejected:** Dropping all path and invalid-handoff observations.
Bounded canonical paths and explicit validity retain useful acquisition and
failure metrics without retaining the target.

**Consequences:** Any future dynamic public path needs canonicalization before
envelope construction, and invalid target classification must never invent a
specific product surface.

### 2026-08-13 — Identity selection and bootstrap consume one signed route decision

**What changed:** The content-free route response now includes a five-minute
signed decision token. The site submits that token with its selected anonymous
epoch, and bootstrap uses the token's route instead of re-reading Cloudflare
country on the second request. Existing journey state must match the decision.

**Why:** The site previously selected persistent versus memory-only identity
from the first request while bootstrap independently routed the second. A
network change between them could therefore admit a persistent epoch to an EU
journey despite the region-before-identity promise.

**Considered and rejected:** Merely comparing bootstrap's response in the
browser. That detects the mismatch only after the server has persisted the
wrong journey. Combining identity selection into bootstrap was also rejected
because the server cannot safely read or write browser storage.

**Consequences:** Public-site bootstrap must carry the signed route token, route
tokens remain content-free and short-lived, and token/journey conflicts fail
closed without retrying the product action. Desktop bootstrap may continue to
use its single authoritative Cloudflare request without this site-only preflight.

### 2026-08-13 — The public acquisition path becomes region-aware product telemetry

**What changed:** Every public page now reports real page views/leaves, bounded
semantic actions, and browser-to-desktop handoff attempts through Rally's
regional anonymous boundary. Global may keep a first-party random anonymous
epoch and maps page events to PostHog's reserved web events. EU uses an in-memory
page epoch and keeps the accepted projection in EU Cloudflare resources.

**Why:** Desktop adoption data could show what happened after Rally opened but
not which acquisition pages, calls to action, downloads, or handoff paths brought
someone there. Directly embedding a provider SDK would bypass the regional and
schema boundaries already built for the more sensitive product.

**Considered and rejected:** PostHog's browser autocapture, URL/query capture,
session replay, a Global identifier for EU visitors, and one persistent identity
regardless of location. Those alternatives either collect content, expose
handoff tokens, or merge residency histories. Also rejected was a bootstrap-only
route probe because it would create a retained journey for every route check.

**Consequences:** Global gains cross-page anonymous acquisition funnels; EU gains
aggregate page/action/handoff funnels without persistent browser identity. The
public disclosure now names the practice. Any additional site signal must extend
the shared registry, the anonymous allowlist, the disclosure when applicable,
and exact producer/adapter tests.
