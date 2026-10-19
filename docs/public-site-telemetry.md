# Public-site telemetry

The landing links directly to the canonical macOS installer and collects no email.
`/download/` deliberately skips telemetry initialization so its bearer fragment cannot reach analytics.
The Download for Mac action is a plain installer link. What the landing reports, and the checklist a redesign must keep, is in [`landing-page-tracking.md`](landing-page-tracking.md). Existing page telemetry remains; no form or dialog is initialized on the homepage.

Help center pages under `/help/` report as the `support` page class; [`help-center.md`](help-center.md) owns them.

Trust Center pages load the landing's `landing.css` and add `apps/site/src/trust.css` for their own layouts. Their policy content, contact destinations, and telemetry entry remain unchanged.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/telemetry.ts` | Global route lookup, first-party anonymous identity, capability bootstrap, closed envelopes, page/action/handoff reporting, and failure isolation. |
| `apps/site/src/site-entry.ts` | Initializes page-view and page-leave reporting on every built HTML entry, and starts the PostHog SDK loader on pages that run it. |
| `apps/site/src/posthog-loader.ts` | The paths denied PostHog's browser SDK, and adding its separate script from the `rally-posthog-src` meta tag. |
| `apps/site/src/posthog.ts` | The PostHog SDK entry, a separate build input: initializes the full SDK with replay, heatmaps and autocapture, and hands its session to the reporter. |
| `apps/site/src/*-handoff.ts`, `desktop-open.ts`, `invite.ts`, `slack-link.ts`, `workstream-link.ts` | Report presented, automatic, and manual browser-to-desktop handoff attempts after each page has validated its own target. |
| `apps/site/vite.config.ts` | Injects the shared telemetry entry and immutable release/build context into every site page. |
| `apps/api/src/routes/telemetry.ts` | Exposes the content-free Cloudflare route decision and the capability-bound anonymous ingest. |
| `apps/api/src/telemetry/posthog-adapter.ts` | Maps the Global page observations once to PostHog `$pageview` and `$pageleave`; `site_action_selected` keeps its own name and properties. |
| `apps/site/trust/cookies/index.html` | Public disclosure for first-party site analytics, browser storage, regional behavior, and prohibited fields. |

The product decision is in the [public-site telemetry
PRD](PRDs/2026-08-13_public-site-telemetry/prd.md). The shared event, retention,
and destination mechanics remain in [`telemetry.md`](telemetry.md).

## How it works

- Global reads or creates one random UUIDv7 in first-party `localStorage`, so
  landing and handoff pages can form one anonymous acquisition path.

`site_page_viewed` carries a closed page class, a lowercased bounded pathname,
an external referring domain, allowlisted `utm_source`, `utm_medium`, and
`utm_campaign` values, and `adClickIdSource`: which ad platform's click
identifier the URL carried (`x` for X's `twclid`), never the identifier.
Both page events also carry `trafficClass` and `trafficReasons`, set by the API;
[site traffic classification](site-traffic-classification.md) owns them, the
time zone and start checks the bootstrap body carries, and `pageSignals`.
`site_page_left` carries the page/path and a bounded
visible-duration bucket. Global maps these observations one-for-one to PostHog
`$pageview` and `$pageleave`, with URL/host/path properties derived from the
already validated site context. Electron screen events never impersonate web
page events.

`site_action_selected` reports a click on a tagged link on the landing or
support pages (`/download/` initializes no telemetry). A link opts in with a `data-site-action` id, and
`SITE_ACTION_LINKS` in `telemetry.ts` maps each id to a closed action, placement
and, for pricing actions, plan. One capture-phase click listener reads the id
and ignores any id not in that table, so markup chooses a combination but never
supplies a value. Every installer link has its own id (`download-hero`,
`download-pricing-start|grow`), which is how the landing
dashboard tells the three identical DMG links apart. The event shares the page
view's anonymous `distinct_id`, so its referrer and campaign come from joining
to that visit's `$pageview` rather than being copied onto the click. The click
does carry its own `pathname`, which Global maps to `$pathname` as it does for
page views, so variants of one page that share link ids can be compared directly.
A middle-click, which fires `auxclick` rather than `click`, counts too.

`desktop_handoff_attempted` reports the handoff type,
whether it was merely presented, actually attempted, or declined for the web
app (`browser`, from a shared link's **Continue in browser**), and whether the local
target parser considered it valid. Handoff query strings, URL fragments,
single-use tickets, invitation tokens, Slack state, work-stream IDs, automation
IDs, and settings values never enter an event.

Reporting is fire-and-forget. A page keeps at most 20 already-sanitized events
in memory and sends immediately. Page leave, link clicks and handoff attempts ask
for browser `keepalive`, and whichever request next sends the queue carries it,
since that request may hold the event. A batch that fails with a 5xx, 408 or 429
goes back in memory and rides the page's next send, as does one that never
reached the API. A 401 means the one-hour capability expired: the page
bootstraps once more and resends. Any other 4xx is dropped. It has no persistent
event spool and no retry that can delay navigation or opening the desktop.

- **One observed page produces one web event.** The adapter translates the
  Rally event to the reserved PostHog name; it does not deliver a custom copy.

- **Handoff analytics never carries the handoff.** Tokens, fragments, query
  values, and resource identifiers stay inside the page-specific parser.

- **The closed registry stays the source of record.** Every event a dashboard,
  the lakehouse, or a signup report depends on is a registered site event sent
  through the API. PostHog's SDK, below, adds replay and behavior on top; no
  report should be built on its `$autocapture` events in place of a registered
  one, because the SDK will be removed.

### PostHog browser SDK (temporary)

To see why the landing does not convert, every public page except a short
deny list also runs PostHog's full browser SDK (`posthog-js`, the `module.full.no-external`
bundle) with session replay at a 100% sample rate, heatmaps, autocapture,
rage and dead clicks, exception capture, console logs and web vitals. It sends
through PostHog's managed reverse proxy at `p.rallywith.ai`, configured in the
PostHog organization's proxy settings, with the project's public token.

- **One page view, one page leave.** The SDK runs with `capture_pageview` and
  `capture_pageleave` off. `$pageview` and `$pageleave` reach PostHog only from
  the API adapter, so the dashboards built on them see no duplicates.
- **One visitor, one session.** The SDK is bootstrapped with the site's
  anonymous epoch as its `distinct_id`, and keeps its own state in
  `localStorage` beside that epoch, so the two cannot drift apart. The reporter
  holds its events until the SDK has loaded and stamps each with the SDK's
  current session as `context.sessionId`, which the adapter maps to
  `$session_id`. Server page views, clicks and the recording therefore share a
  person and a session, and PostHog's web analytics sees multi-page sessions
  rather than one per page. If the SDK script fails to load, events keep the
  page's own session.
- **On by default, denied by path.** `runsPostHog` runs the SDK on every
  production page except `RECORDING_DENIED_PATHS`: `/download`, `/invite`,
  `/auth/`, `/slack/link`, `/open` and `/app`, whose URLs hold tickets,
  tokens, grants and resource ids a recording would keep, plus the 404 page,
  where a mistyped handoff link lands with its token. A new page records
  without an edit; a new page that receives a credential in its URL must be
  added to the deny list before it ships.
- **No external scripts.** The full bundle carries the recorder and every
  extension, so the CSP adds only `p.rallywith.ai` to `connect-src` and
  `blob:` to `worker-src` (the recorder's worker). The PostHog toolbar and
  surveys cannot load or style themselves under this policy; view heatmaps in
  PostHog's Heatmaps page instead.
- **Separate script.** The SDK is its own build input, added by the loader as a
  module script, so pages that do not run it never download it (about 210 KB
  compressed).

- **Measurement cannot change the site experience.** Storage denial, route or
  bootstrap failure, a rejected event, and destination failure are silent to
  navigation, downloads, and desktop handoffs.

### Apollo landing-page tracker

The production homepage and its landing variants additionally load Apollo via
`apollo-loader.ts`; see [landing-page tracking](landing-page-tracking.md#apollo-visitor-tracking)
for the paths and app ID. It runs independently of first-party reporting and
uses Apollo and LiveIntent endpoints permitted only by the landing-page CSP
overrides. Apollo receives page visits directly rather than closed Rally events.

## Boundary

This module owns public-site page classification, anonymous acquisition
identity, semantic action capture, browser-to-desktop handoff measurement, and,
for now, the PostHog browser SDK on the marketing pages. The Apollo integration
additionally owns loading the third-party visitor tracker on landing pages. This
module does not own account identification, form analytics,
consent-law determinations, or the desktop action that follows a handoff. Site
identities are not automatically linked to a Rally login; signup reports join
the site to the app by `flowId`.

- If route lookup or capability bootstrap fails, events for that page are lost;
  product behavior continues.

- A route token expires after five minutes and a token/journey route conflict is
  rejected. The page does not retry with a newly inferred route or reuse the
  selected epoch across that conflict.

- `pagehide` delivery is best effort. A browser that terminates before the
  keepalive request begins can omit `site_page_left`.

- Global browsers that block `localStorage` receive a fresh epoch and remain
  usable; only cross-page attribution is reduced.

- Campaign fields are 160-character allowlisted taxonomy values. The reporter
  ignores arbitrary query keys and never sends a complete URL. Ad click
  identifiers are reduced to a closed platform name before they leave the page.

## Browser signup attribution

The hero “Sign up now” and header sign-in links mint a new UUIDv7 for each
click, keyboard activation, or middle-click. The same flow is reported in
`site_action_selected.flowId` and passed to `app.rallywith.ai` as `signupFlowId`.
Links stay clean before interaction and are restored after navigation dispatch,
so copying a link does not distribute a shared signup attempt.

Browser entry validates the ID, saves it in tab-scoped session storage, and
removes it from the URL. Reloading before authentication keeps the attribution;
a new incoming CTA replaces it, and authentication or sign-out retires it.
Storage failures leave sign-in available. Signup events and site events retain
separate anonymous subjects: reports must join by `properties.flowId`.

Deploy the API reader before the site producer: old strict readers reject a
batch containing the new optional property. Complete browser and fresh-install
desktop flow stages are owned by [`telemetry.md`](telemetry.md#complete-signup-measurement).

## Testing

```bash
pnpm --filter @rally/site test
pnpm --filter @rally/site typecheck
pnpm --filter @rally/site build
pnpm --filter @rally/api exec vitest run test/telemetry-routes.test.ts test/posthog-adapter.test.ts
pnpm --filter @rally/contracts test
```

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

### 2026-10-19 — Apollo tracks landing-page visits

**What changed:** Added the supplied Apollo tracker to production landing pages
and concept variants, with landing-only CSP permissions for Apollo and LiveIntent.

**Why:** The landing pages need the requested Apollo visitor tracking alongside
the existing acquisition reporting.

**Considered and rejected:** Inlining the snippet in every HTML file would repeat
the integration and be blocked by the existing script policy. Loading it on
every site page would expose credential-bearing handoff URLs.

**Consequences:** New landing variants must opt into the loader and CSP. Apollo
tracking is separate from the first-party event and regional-delivery guarantees.


### 2026-10-11 — Report which ad platform's click identifier a landing carried

**What changed:** `site_page_viewed` gains an optional `adClickIdSource`, a
closed enum. The reporter sets it to `x` when the landing URL has a non-empty
`twclid`; the identifier itself is read and dropped in the page, and
`takeAdClickId` removes it from the address bar before the PostHog SDK loads,
since the SDK reports the full URL with every event and replay.

**Why:** Paid X traffic could not be split into people and bots
([traffic classification PRD](PRDs/2026-10-11_site-traffic-classification/prd.md)).
X appends `twclid` to real ad clicks, so its presence tells a paid click apart
from a copied link that still carries the campaign tags, and lets landings be
counted against X's own `url_clicks` and Cloudflare's count of landing requests.

**Considered and rejected:** Sending the identifier, which names one ad click
and would join our anonymous visit to X's records; a boolean named for X, which
would need a new field for each further platform.

**Consequences:** Another platform is a new enum value and one entry in
`AD_CLICK_ID_PARAMETERS`. The enum must never widen to a free string: the
contract test rejects an identifier in this field. Anything that reads the
landing URL after `takeAdClickId` no longer sees the identifier.

Shipped in [PR #1192](https://github.com/juno-ai-labs/avalon/pull/1192); see the [traffic classification PRD](PRDs/2026-10-11_site-traffic-classification/prd.md).

### 2026-10-11 — Retire the header download link; keep the hero web entry as `secondary_cta`

**What changed:** The shared header no longer carries a download link, so
`download-header` is gone from `SITE_ACTION_LINKS` and header clicks now land
only on `sign-in-header`. The hero web app button became the primary, left
button on `/`, but `web-app-hero` still reports `action: secondary_cta`.

**Why:** Signing up through the web app is the entry the team wants first, and
it works on every device; the header now shows the rolling sign-in everywhere,
not only on touch devices.

**Considered and rejected:** Reclassifying `web-app-hero` as `primary_cta`: it
would split the button's click history at this deploy, and `/start-fast/` uses
the same id for one of two equal buttons.

**Consequences:** Insights counting `download-header` stop at this deploy.
If `web-app-hero` is ever reclassified, the API already accepts `primary_cta`,
but dashboards filtering on `secondary_cta` must move with it.

Shipped in [PR #1189](https://github.com/juno-ai-labs/avalon/pull/1189).

### 2026-10-10 — Run PostHog's browser SDK on the marketing pages

**What changed:** Public pages run PostHog's browser SDK with replay and
heatmaps, as described above. Recording is on by default and denied by path,
rather than allowed by page class, so a new marketing page is recorded without
anyone opting it in; the cost is that a new handoff page is recorded until it
is denied.

**Why:** The landing is not converting and page views and tagged clicks cannot
say why. The team wants to watch visits and see where people click and stop for
the next few weeks, then remove the SDK for privacy reasons.

**Considered and rejected:** Letting the SDK own `$pageview` and `$pageleave`
and dropping the site's own: the dashboards, the lakehouse and signup reports
are built on the registered events and their page class, and the SDK is
temporary. Sending both would double every page view. Loading the SDK from
PostHog's CDN or with `import()`: the CDN needs `script-src` widened, and the
repository bans dynamic imports, so it is a separate build entry like the
technology schematic. A separate per-page session id joined to the SDK's by a
property: PostHog only links an event to a recording by `$session_id`.

**Consequences:** PostHog's scroll-depth heatmap reads scroll properties from
the SDK's own `$pageleave`, which is off, so scroll maps stay empty; replays
still show scrolling. Removing the SDK means deleting `posthog.ts`, the loader,
its build input and meta tag, the CSP additions and Cookie Notice section 4;
the reporter then falls back to a per-page session. Any page whose URL can
carry a credential must be in `RECORDING_DENIED_PATHS`. Site events now wait
for the SDK to load or fail, so they leave later than before; a visitor who
leaves first releases them with the page's own session, so bounces are still
counted, but a browser that is killed outright can lose a page view it would
have sent before. Read any jump in landing conversion during the SDK's weeks
with that in mind. Inputs stay masked in recordings: recording is on by
default, so a new form field must not be captured keystroke by keystroke
without a review.

Shipped in [PR #1187](https://github.com/juno-ai-labs/avalon/pull/1187).

### 2026-10-08 — Name the page on each click

**What changed:** `site_action_selected` gained an optional `pathname`, the
same bounded path page views already report, and the site now sends it on every
click.

**Why:** `/start-fast/` is a variant of the home page that reuses the home
page's link ids, and the team wants to compare the two pages' click-through
directly. Without the path, a download click on either page was identical.

**Considered and rejected:** Joining each click to its visit's `$pageview`
through the shared anonymous id. That works, and the earlier entry below chose
it for referrer and campaign, but every variant comparison would need that join;
the path is the one property a click needs to answer the question by itself.
Giving each variant its own link ids was also rejected: every new variant would
then grow the closed id table and the dashboard's id lists.

**Consequences:** The property is optional so a tab opened before the site
deploy still validates. As with every new property, the API reader rejects a
batch containing it until the API deploys, so deploy the API first.

### 2026-10-07 — Connect web entry to complete signup

**What changed:** Web entry activations mint and report an opaque flow ID and
carry it to browser entry. The browser keeps the attempt through tab reloads.

**Why:** Site clicks and signup stages used separate subjects, hiding where
people left between the landing page and organization setup.

**Considered and rejected:** Preparing an ID on page load allows copied links
and repeated activations to collapse different people's signup events through
the API's stage deduplication. Keeping it only in memory loses attribution on
refresh. Each activation instead gets a fresh ID, retained only within its tab.

**Consequences:** Preserve click/navigation correlation and the clean copyable
URL. Deploy API readers first, and join stages by flow rather than subject.

Shipped in [PR #1161](https://github.com/juno-ai-labs/avalon/pull/1161).

### 2026-09-30 — Pricing plans follow the per-organization tiers

**What changed:** `plan` gained `start`, `grow` and `enterprise` (the Grown up
plan's internal name). Grown up's Contact us link reports
`founder_contact · pricing · enterprise`.

**Why:** The landing's pricing plans were replaced, and the pricing buttons
report the plan the visitor picked. The contract keeps `pro`, `max` and `ultra`
because the API refuses a whole batch carrying an unknown value, and a landing
tab opened before the site deploy still sends them.

**Considered and rejected:** Dropping the old values with the rename. A tab
opened before the site deploy would then lose every batch with a pricing click,
page views included.

**Consequences:** The enum carries three values no page sends. Removing them
is safe once no tab can still be running the pre-change page.

Shipped in juno-ai-labs/avalon#1025.

### 2026-09-29 — Report which landing link was clicked

**What changed:** The landing's download, demo, founder and footer support links
now report `site_action_selected`. The contract gained the `demo_request` and
`founder_contact` actions, the `sidekicks`, `team` and `pricing` placements, and
an optional `plan` (`pro`, `max`, `ultra`). The reporter also stopped resending
a batch the API refused as invalid, refreshes an expired capability once on a
401, and keeps a batch that never reached the API.

**Why:** The team wanted to know which of the five identical installer links
converts and to measure the landing for go-to-market. The event and its PostHog
path already existed, but no page called it, so the only signal was page views.

**Considered and rejected:** A `link` property carrying the link's own id.
That would let markup put any string into an event; a closed placement and plan
keep the event within the contract. Copying the referrer and UTM values onto each
click was also rejected: the click already shares the visit's anonymous id, so
the dashboard joins to the page view instead of widening the event.

**Consequences:** Widening the enums is compatible for new values only, and the
API validates a batch as a whole. A site deployed before the API would have
every batch containing a new value refused; with the 4xx change the site drops
that batch instead of resending it forever, so at worst that batch (and any page
view queued in it) is lost until the API catches up. A merge touching both
starts both deploys at once, so run the API deploy first. A new tagged link needs its id in `SITE_ACTION_LINKS`;
the site test fails on an id the table does not know.

### 2026-09-21 — Retire acquisition-form telemetry ownership

**What changed:** Removed the retired acquisition-form browser client from this
module's code ownership and kept the homepage on its existing bounded page
telemetry only.

**Why:** The homepage now links directly to the canonical installer and no
longer collects an email or initializes Turnstile. Keeping the deleted client in
the module contract described a telemetry boundary that no production page used.

**Considered and rejected:** Retaining the form client as dormant site
scaffolding would preserve dead code, its browser dependency, and unrelated
deployment configuration without providing an active acquisition path.

**Consequences:** A future public intake UI must introduce and document its own
client and telemetry boundary explicitly. The token-download page remains
excluded from telemetry so bearer fragments cannot enter analytics.

### 2026-09-21 — Match link previews to the landing page

**What changed:** The social card uses the static pale landing design and collaboration headline. Open Graph and Twitter metadata reference `rally-social-v01.jpg`.

**Why:** Sharing the homepage in Messages still displayed the old colorful artwork.

**Considered and rejected:** Replacing only the bytes at the old URL leaves image caches using the old design.

**Consequences:** Keep the versioned URL aligned with the generated card; existing Messages previews may retain cached page metadata until their client refreshes it.

### 2026-09-21 — Unify support and policy page presentation

**What changed:** All 24 support and Trust Center pages use pale surfaces, the homepage typography scale, rounded controls, and responsive navigation and cards.

**Why:** The homepage redesign left linked pages using the prior neon artwork and heavy display type.

**Considered and rejected:** Adding more overrides to the legacy stylesheet would retain conflicting designs. A dedicated shared stylesheet lets these informational pages use one design without changing desktop handoff screens.

**Consequences:** Preserve existing policy text and destinations; mobile tables scroll within their container rather than widening the page. Review follow-up restores visible Implemented labels, includes getting-started cards in the responsive grid, and stacks header actions below labels on narrow phones. Source-contract tests now check the stylesheet these pages actually load; real-browser checks cover 320px header overflow and overlap.

### 2026-09-14 — Configurable deployment isolation

Public-site measurement now consistently uses the Global endpoint and first-party anonymous epoch. Country-based routing and page-only regional identities are removed alongside the geographical product choice; the existing event registry and preference behavior remain unchanged.

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

Canonical work-stream handoff paths collapse their UUID segment to
`/app/workstreams/:id` before page-view or page-leave construction. Invalid
generic desktop targets preserve a provable workstream/settings/automation
type, or use `unknown` when no type is provable, instead of defaulting to
Settings.

Raw work-stream pathnames leaked the resource identifier that the public site
contract prohibits, while attributing every malformed target to Settings
corrupted the handoff funnel.

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

**Considered and rejected:** Merely comparing bootstrap's response in the
browser. That detects the mismatch only after the server has persisted the
wrong journey. Combining identity selection into bootstrap was also rejected
because the server cannot safely read or write browser storage.

**Consequences:** Public-site bootstrap must carry the signed route token, route
tokens remain content-free and short-lived, and token/journey conflicts fail
closed without retrying the product action. Desktop bootstrap may continue to
use its single authoritative Cloudflare request without this site-only preflight.

### 2026-08-13 — The public acquisition path becomes region-aware product telemetry

**Why:** Desktop adoption data could show what happened after Rally opened but
not which acquisition pages, calls to action, downloads, or handoff paths brought
someone there. Directly embedding a provider SDK would bypass the regional and
schema boundaries already built for the more sensitive product.
