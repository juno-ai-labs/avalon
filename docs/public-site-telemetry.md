# Public-site telemetry

Avalon's public site records a closed, content-free acquisition and desktop-
handoff journey through the same regional telemetry boundary as the desktop.
Global traffic can form an anonymous multi-page funnel and reaches PostHog as
real web events. EU traffic stays in Avalon's EU Cloudflare resources and is
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
response is only the coarse `eu`/`global` route and whether it came from
Cloudflare geolocation or the conservative Global fallback; it creates no D1
journey and returns `Cache-Control: no-store`. The site then selects an identity:

- Global reads or creates one random UUIDv7 in first-party `localStorage`, so
  landing, download, and handoff pages can form one anonymous acquisition path.
- EU creates one in-memory UUIDv7 for this page load and never reads or writes a
  persistent analytics identifier.

That ID enters the ordinary `/telemetry/bootstrap` exchange. The signed,
one-hour capability fixes the route and anonymous epoch. Events then enter
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
  persistent anonymous ID, and a later location change never moves an event.
- **One observed page produces one web event.** The adapter translates the
  Avalon event to the reserved PostHog name; it does not deliver a custom copy.
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
linked to an Avalon login.

## Failure modes and limits

- If route lookup or capability bootstrap fails, events for that page are lost;
  product behavior continues.
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
pnpm --filter @avalon/site test
pnpm --filter @avalon/site typecheck
pnpm --filter @avalon/site build
pnpm --filter @avalon/api exec vitest run test/telemetry-routes.test.ts test/posthog-adapter.test.ts
pnpm --filter @avalon/contracts test
```

Site tests prove every HTML entry receives the shared reporter, legal copy
matches the implemented storage boundary, and EU selection cannot use the
persistent Global epoch. API tests prove the route endpoint creates no journey,
site events pass only the anonymous allowlist, and the Global destination gets
the exact reserved web-event mapping.

## Regional impact

The public route lookup and signed-capability issuer exist only on the Global
Worker because Cloudflare observes the incoming country there. An affirmative EU
route sends the validated event projection to EU over `EU_TELEMETRY_BRIDGE` and
terminates in EU D1. EU has no PostHog token or destination call. Non-EU,
unknown, malformed, or unavailable geolocation uses Global and may reach the US
PostHog project. Nothing is queued in a region-pending store or moved after an
explicit choice elsewhere in the product.

## Security and trust model

The site is an untrusted anonymous producer. The capability authorizes only its
fixed epoch, route, and the pre-authentication event allowlist. Both the shared
envelope and each event use strict schemas; accepted events still pass regional
collection validation and retention. CORS permits only the production Avalon
site origins and explicit local development origins. The reporter never receives
a PostHog token, regional service credential, account session, or cross-region
bridge authority.

## Operations

The public site needs no analytics secret. The Global Worker needs exact
`ALLOWED_ORIGINS` entries for `https://with-avalon.com` and
`https://www.with-avalon.com`, plus the existing telemetry capability signing
key and Global PostHog configuration. Operators inspect Global and EU telemetry
backlogs independently; a healthy Global PostHog graph says nothing about EU
site delivery.

## Performance and cost

The route lookup and bootstrap add two small no-store Global requests to a page
that reports. Events are sent immediately in batches bounded by the shared
256-KiB/50-event contract; the page itself holds at most 20. The route lookup
avoids writing a disposable D1 journey merely to decide whether browser storage
is allowed.

## Changelog

### 2026-08-13 — The public acquisition path becomes region-aware product telemetry

**What changed:** Every public page now reports real page views/leaves, bounded
semantic actions, and browser-to-desktop handoff attempts through Avalon's
regional anonymous boundary. Global may keep a first-party random anonymous
epoch and maps page events to PostHog's reserved web events. EU uses an in-memory
page epoch and keeps the accepted projection in EU Cloudflare resources.

**Why:** Desktop adoption data could show what happened after Avalon opened but
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
