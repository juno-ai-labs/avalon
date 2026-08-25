# Public-site product telemetry

> Created 2026-08-13.
>
> Scope: anonymous acquisition, public-page engagement, and browser-to-desktop
> handoffs on `with-avalon.com`.
>
> Companion documents: [state](state.md), [public-site telemetry](../../public-site-telemetry.md), [regional telemetry](../../telemetry.md).
>
> Standing brief: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally will measure the public acquisition path with typed first-party events
that use the existing regional telemetry boundary. Global visitors can form an
anonymous multi-page funnel that reaches PostHog. Affirmative EU-country traffic
stays inside Rally's EU Cloudflare resources and uses no persistent browser
analytics identifier.

The site records real page views/leaves, bounded calls to action, downloads, and
browser-to-desktop handoff attempts. It does not enable DOM autocapture, replay,
heatmaps, advertising pixels, cross-site identity, or token/resource capture.

## Motivation

The regional telemetry PRD deliberately shipped the first desktop/API release
without public-site behavioral analytics and required a separate decision before
adding it. Desktop journeys can now explain activation and adoption after the
app opens, but they cannot answer which site pages, acquisition sources,
downloads, or handoff paths led to that open. That leaves the top of every
product funnel disconnected from the product it feeds.

## Goals

1. Measure public page visits, exits, bounded engagement, and acquisition source
   without sending full URLs, page content, forms, tokens, or resource IDs.
2. Measure presented, automatic, and manual desktop handoffs by type and local
   validity without copying the handoff target.
3. Make Global observations work idiomatically with PostHog Web analytics through
   one `$pageview` or `$pageleave` per actual page observation.
4. Keep affirmative EU traffic inside EU Cloudflare resources and avoid a
   persistent EU browser analytics identifier.
5. Keep every request and storage failure off the page's navigation, download,
   and desktop-open correctness paths.

## Non-goals

1. DOM autocapture, heatmaps, session replay, surveys, or form analytics are
   rejected because the semantic allowlist cannot bound their content.
2. Advertising attribution, pixels, device-advertising identifiers, and
   cross-site tracking are rejected; this is first-party product measurement.
3. Automatically link a public-site epoch to a later Rally account is deferred;
   the current browser handoff has no privacy-safe, region-stable link contract.
4. Add a site preference UI in this change. The implementation avoids persistent
   EU identity and the public notice states the practice; any legally required
   additional choice is a separate product/legal rollout.
5. Send EU public-site events to the US PostHog project. EU remains an internal
   regional projection until Rally deploys an approved EU destination.

## Product behavior

The visible site does not gain analytics UI. On each page load, the site obtains
a coarse Cloudflare route with a short-lived signed decision, chooses identity
from that route, then exchanges both for a signed anonymous telemetry
capability. Global may retain a random first-party anonymous ID so page-to-page
funnels work. EU uses a page-scoped ID held only in memory.

The reporter records the classified page and safe pathname, external referring
domain, allowlisted UTM values, and a bounded leave-duration bucket. Landing,
download, and support controls report only a closed action/placement. Auth,
invitation, Slack, work-stream, settings, and automation handoff pages report
whether a valid target was presented and whether an automatic or manual open was
attempted. Analytics failure is invisible and never retries the product action.

## Impact on the product contract

None — this connects the public acquisition surface to the existing desktop
product without changing what Rally is or what a work stream means. It replaces
the deliberately deferred public-site non-goal in the earlier telemetry release
through the separate PRD that release required.

## Decision log

None yet.

## Key design decisions

1. **Route before choosing browser identity.** Global gets cross-page funnels;
   EU gets page-scoped aggregate measurement. Bootstrap consumes the same signed
   route decision that selected identity, so a network change between requests
   cannot reclassify the epoch. A single persistent identity was rejected
   because moving networks could merge residency histories.
2. **Use Rally's contract and adapter, not a browser provider SDK.** Global
   still receives idiomatic reserved PostHog web events, while the site keeps
   provider tokens and unrestricted capture out of the browser.
3. **Measure the handoff shell, never its target.** The site reports only type,
   method, and local validity after the owning parser runs. Query strings,
   fragments, single-use credentials, and resource IDs are prohibited.

## Regional impact

`GET /telemetry/route` runs only on the Global edge and reduces Cloudflare's
country value to `eu` or `global` without retaining country or IP. Its
short-lived signed decision is authoritative for the subsequent bootstrap,
whose capability fixes the event route. EU projections cross only the existing named
`EU_TELEMETRY_BRIDGE`, land in EU D1, and never call PostHog. Global events use
the existing regional outbox and US PostHog destination.

## Security and trust model

The anonymous capability grants no account or workspace authority and permits
only a short event allowlist. Strict schemas bound every string and reject
unknown properties. The site receives no PostHog token, telemetry signing key,
or bridge credential. Exact production CORS origins are required.

## Acceptance

1. Every built site page loads the shared reporter and remains usable when
   storage and telemetry requests fail.
2. Global page views/leaves become exactly one PostHog `$pageview`/`$pageleave`
   with safe path/referrer/campaign properties.
3. EU route tests prove no persistent browser ID is selected and the event stays
   in EU internal telemetry.
4. Handoff tests prove tokens, fragments, and resource IDs do not enter event
   properties.
5. The Cookie & Tracking Notice accurately states the first-party analytics,
   Global storage, EU page-scoped identity, and absence of advertising tracking.
