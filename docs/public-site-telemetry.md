# Public-site telemetry

Rally's public site records a closed, content-free acquisition and desktop-
handoff journey through the same regional telemetry boundary as the desktop.
Global traffic can form an anonymous multi-page funnel and reaches PostHog as
real web events. EU traffic stays in Rally's EU Cloudflare resources and is
page-scoped: the site does not read or write a persistent analytics identifier
for an affirmative EU route.

The request-only landing submits its email solely to `/access/requests`; neither
email values nor submission bodies enter telemetry. `/download/` deliberately
skips telemetry initialization so its bearer fragment cannot reach analytics.
The former landing download/CTA click listeners were removed with the public hero.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/telemetry.ts` | Cloudflare route lookup, region-dependent anonymous identity, capability bootstrap, closed envelopes, page/action/handoff reporting, and failure isolation. |
| `apps/site/src/site-entry.ts` | Initializes page-view and page-leave reporting on every built HTML entry. |
| `apps/site/src/landing.ts` | Sends the access-request form to its API; emits no telemetry or email content. |
| `apps/site/src/*-handoff.ts`, `desktop-open.ts`, `invite.ts`, `slack-link.ts`, `workstream-link.ts` | Report presented, automatic, and manual browser-to-desktop handoff attempts after each page has validated its own target. |
| `apps/site/vite.config.ts` | Injects the shared telemetry entry and immutable release/build context into every site page. |
| `apps/api/src/routes/telemetry.ts` | Exposes the content-free Cloudflare route decision and the capability-bound anonymous ingest. |
| `apps/api/src/telemetry/bootstrap.ts` | Reduces Cloudflare country to `eu` or `global`, fixes the journey route, and permits only the public-site event allowlist before authentication. |
| `apps/api/src/telemetry/posthog-adapter.ts` | Maps the Global page observations once to PostHog `$pageview` and `$pageleave`. |
| `apps/site/trust/cookies/index.html` | Public disclosure for first-party site analytics, browser storage, regional behavior, and prohibited fields. |

The product decision is in the [public-site telemetry
PRD](PRDs/2026-08-13_public-site-telemetry/prd.md). The shared event, retention,
and destination mechanics remain in [`telemetry.md`](telemetry.md).

## How it works

Every page first requests `GET /telemetry/route` from the Global edge. The
Worker prefers Cloudflare's maintained `request.cf.isEUCountry` classification,
falls back to the coarse country code when that property is unavailable, and
reduces either signal to `eu` or `global`. The response carries that route,
whether it came from Cloudflare geolocation or the conservative Global fallback,
and a five-minute signed route token. It creates no D1 journey and returns
`Cache-Control: no-store`. The site
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

`site_action_selected` retains the legacy closed action and placement contract for landing,
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
- **PostHog remains a server-side destination.** The site does not load
  `posthog-js`, expose the project token, accept remote capture settings, or
  enable PostHog cookies, autocapture, replay, heatmaps, exception capture, or
  browser person profiles. PostHog's cookieless browser mode is therefore not
  part of this path; Rally's narrower first-party envelopes already cross the
  regional boundary before delivery.
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
Worker because Cloudflare supplies the maintained EU-country classification and
incoming country there. An affirmative EU
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

The public site needs no analytics secret. Production Global delivery targets
US PostHog project `541600`; its project token remains only in the Global Worker
secret `POSTHOG_PROJECT_TOKEN`, and the EU Worker must not have that secret or a
PostHog host. The project-level **Discard client IP data** control remains
enabled as defense in depth alongside every delivered event's
`$geoip_disable: true`; neither setting substitutes for the regional route.
The Global Worker also needs exact
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

### 2026-09-09 — Keep request addresses and grant tokens out of site telemetry

**What changed:** The request form sends email only to the access API; the download
page skips telemetry initialization. The old hero's action listeners are removed.

**Why:** Address input and bearer fragments are credentials/acquisition content,
not analytics dimensions.

**Considered and rejected:** Adding generic form/DOM capture could export this
content. The legacy action contract remains readable for historical events.

**Consequences:** Landing emits no `site_action_selected` events now. Other page
and handoff telemetry remains bounded to the existing closed vocabulary.

### 2026-09-02 — Public policies move under one Trust Center route

**What changed:** The Trust Center overview and its Security, Privacy, Terms,
DPA, Acceptable Use, Sub-processor, and Cookie documents now publish as distinct
pages below `/trust/`.
The previous top-level document URLs redirect permanently to their canonical
Trust Center equivalents, and public-site telemetry classifies the full
hierarchy as legal content.

**Why:** The policies were visually related but lived at unrelated top-level
paths. A single public hierarchy makes the center easier to navigate, share,
and extend without changing the telemetry privacy boundary.

**Considered and rejected:** Keeping `/security/` as the overview and merely
linking the top-level policies from it. That preserved bookmarks but left the
information architecture fragmented; permanent redirects preserve those links
without making the old layout canonical.

**Consequences:** New links and search metadata use `/trust/`; old public links
continue to resolve. Route reporting still carries only bounded pathnames and
does not add query strings, content, or identity.

### 2026-09-01 — Workspace-addressed paths remain identifier-free in telemetry

**What changed:** Public-site path normalization recognizes the current
`/app/workspaces/<region>/<workspace>/workstreams/<id>` handoff and reports only
`/app/workspaces/:region/:workspace/workstreams/:id`. The older ID-only path
retains its compatibility normalization.

**Why:** Canonical links now need workspace routing coordinates, but those
identifiers add no value to anonymous handoff measurement and must not become a
new analytics dimension.

**Considered and rejected:** Reporting region while masking only UUIDs. The
regional route is already established by the capability handshake; duplicating
it in a path label creates two regional signals that can disagree.

**Consequences:** Dashboards see a new normalized path category for current
links and the old category only for compatibility traffic. No raw workspace or
work-stream identifier enters a site event.

Shipped in #464.

### 2026-08-27 — The homepage is the hero alone, so landing reports fewer actions

**What changed:** The homepage sections below the Convergence hero (principles
ticker, problem, method, product mock, connections, FAQ, download) were removed,
and the hero's download button became the release-rendered installer link.
`landing.ts` no longer wires FAQ toggles or classifies connections-grid clicks,
so `faq_opened` and `connector_setup` are no longer emitted from the homepage
and the `connector` placement has no emitter. The `site_action_selected`
contract still accepts both, so historical events remain valid.

**Why:** The marketing sections were the pre-hero site kept below the new hero;
the page now states its case once and offers the download directly. Emitters
for surfaces that no longer exist would be dead code that reads as live
coverage.

**Consequences:** Download clicks from the header and hero keep reporting with
their placements. Dashboards querying `faq_opened` or `connector_setup` from
the site will show the series ending at this deploy, not an instrumentation
break.

### 2026-08-25 — The public acquisition journey speaks Rally only, Cloudflare owns the EU classification, and PostHog stays off the page

**What changed:** The landing page now has one Rally art direction and one
meeting-grounded narrative: multiplayer workstreams turn an individual's AI
setup into shared team leverage. The Trust Center, support, legal, invitation,
work-stream, Slack, and desktop-auth handoff pages all show Rally identity and
canonical `rallywith.ai` contact addresses. Landing actions still enter the same
closed telemetry vocabulary, and the new social card carries no tracking or
resource identity. The visual system uses the canonical woven Rally mark shared
with the desktop product, a 120-unit horizontal grid, three accent colors plus
neutrals, functional geometric shapes, sculptural sans-serif type, and
deliberate asymmetry. Circle geometry has an explicit square aspect ratio, and
hover and keyboard-focus feedback cover each interactive treatment.

The temporary tennis-ball mark was removed from every public page, favicon, and
touch icon after the canonical product mark was identified in the desktop
assets. Public surfaces now consume the same Rally-named asset so the product
and acquisition identities cannot drift independently again.

Public-site routing now consumes Cloudflare's maintained
`request.cf.isEUCountry` signal directly and retains the country-code set as a
conservative fallback when the edge property is unavailable. The site disclosure
and operations guide now state explicitly that PostHog is a server-side Global
destination: the browser loads no PostHog SDK, exposes no project token, and
enables none of its automatic capture surfaces. Production delivery is recorded
against the renamed Rally US project while its token remains a Global Worker
secret, and that project now discards client IP data at ingestion.

**Why:** The public site was canonical on `rallywith.ai` but still introduced
itself, its desktop handoff, and every social unfurl as Avalon. That made the
reinstall message for the renamed desktop app lead to a page that appeared to be
for a different product, and it turned every shared link into a new source of
the superseded name. Research across the team's meetings and Slack repeated one
positioning pressure: AI use is still private and copy-paste mediated, while
Rally's value is the shared workstream and the visible trail behind an outcome.

PostHog's JavaScript SDK can run without cookies, but loading it would still
broaden the browser's data path and make project-side defaults relevant to what
the landing page collects. Rally already has a narrower semantic collector and a
regional edge boundary. Cloudflare also publishes an EU classification, so
maintaining only a hand-written country set would create avoidable policy drift
at the exact point that decides whether an identifier may persist.

**Considered and rejected:** Keeping the four randomly shuffled landscape
concepts and replacing only their nouns. Each concept still centered an
individual handing work to a named assistant, which contradicted the multiplayer
positioning, and random art direction made the brand change impossible to read
as one deliberate public identity.

Installing `posthog-js` with `cookieless_mode: "always"`. It would duplicate
page events, add a third-party browser dependency, and require project-side
cookieless mode, while producing less control over the closed event vocabulary
and regional destination than the existing Worker path.

**Consequences:** Public HTML must not emit Avalon product copy, Avalon contact
addresses, or the old mark path. Compatibility infrastructure remains separate:
the old served domains, deep-link scheme, renderer origin, and already-published
installer names continue to be accepted where the domain-migration contract
requires them. New landing interactions must keep using the registered
`site_action_selected` actions rather than adding DOM capture.

New public-site measurement must continue through Rally's typed first-party
endpoint. Changes to PostHog project defaults cannot silently expand browser
collection, and EU routing follows Cloudflare's maintained signal before the
browser chooses whether an anonymous identifier may persist.

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
### 2026-08-13 — One site-wide CSP admits the regional telemetry exchange, and public paths and invalid handoffs keep truthful bounded classes

**What changed:** The `/*` Cloudflare Pages policy permits the one Global API
origin used by route lookup, bootstrap, and anonymous batch delivery. Tests
enumerate all three paths and reject a direct EU browser origin.

Canonical work-stream handoff paths collapse their UUID segment to
`/app/workstreams/:id` before page-view or page-leave construction. Invalid
generic desktop targets preserve a provable workstream/settings/automation
type, or use `unknown` when no type is provable, instead of defaulting to
Settings.

**Why:** `connect-src 'none'` blocked the reporter before CORS or regional
routing ran. Adding the EU API origin would have bypassed the Global-only route
decision and signed-capability exchange.

Raw work-stream pathnames leaked the resource identifier that the public site
contract prohibits, while attributing every malformed target to Settings
corrupted the handoff funnel.

**Considered and rejected:** Allowing broad HTTPS connections or both regional
API hosts. The site needs one outbound origin; affirmative EU traffic crosses
the named server-side RPC after validation.

Dropping all path and invalid-handoff observations. Bounded canonical paths and
explicit validity retain useful acquisition and failure metrics without
retaining the target.

**Consequences:** Every new public-site network dependency needs an explicit CSP
review. Telemetry path additions must stay on the Global API origin unless the
regional architecture is deliberately revised.

Any future dynamic public path needs canonicalization before envelope
construction, and invalid target classification must never invent a specific
product surface.

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
