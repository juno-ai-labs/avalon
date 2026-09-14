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

1. Measure public page visits, exits, bounded engagement, and acquisition source
   without sending full URLs, page content, forms, tokens, or resource IDs.

2. Measure presented, automatic, and manual desktop handoffs by type and local
   validity without copying the handoff target.

3. Make Global observations work idiomatically with PostHog Web analytics through
   one `$pageview` or `$pageleave` per actual page observation.

5. Keep every request and storage failure off the page's navigation, download,
   and desktop-open correctness paths.

1. DOM autocapture, heatmaps, session replay, surveys, or form analytics are
   rejected because the semantic allowlist cannot bound their content.

2. Advertising attribution, pixels, device-advertising identifiers, and
   cross-site tracking are rejected; this is first-party product measurement.

3. Automatically link a public-site epoch to a later Rally account is deferred;
   the current browser handoff has no privacy-safe, region-stable link contract.

## Product behavior

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

2. **Use Rally's contract and adapter, not a browser provider SDK.** Global
   still receives idiomatic reserved PostHog web events, while the site keeps
   provider tokens and unrestricted capture out of the browser.

3. **Measure the handoff shell, never its target.** The site reports only type,
   method, and local validity after the owning parser runs. Query strings,
   fragments, single-use credentials, and resource IDs are prohibited.

## Security and trust model

The anonymous capability grants no account or workspace authority and permits
only a short event allowlist. Strict schemas bound every string and reject
unknown properties. The site receives no PostHog token, telemetry signing key,
or bridge credential. Exact production CORS origins are required.

1. Every built site page loads the shared reporter and remains usable when
   storage and telemetry requests fail.

2. Global page views/leaves become exactly one PostHog `$pageview`/`$pageleave`
   with safe path/referrer/campaign properties.

4. Handoff tests prove tokens, fragments, and resource IDs do not enter event
   properties.

## Acceptance
