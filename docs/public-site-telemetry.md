# Public-site telemetry

The landing links directly to the canonical macOS installer and collects no email.
`/download/` deliberately skips telemetry initialization so its bearer fragment cannot reach analytics.
The Download for Mac action is a plain installer link. What the landing reports, and the checklist a redesign must keep, is in [`landing-page-tracking.md`](landing-page-tracking.md). Existing page telemetry remains; no form or dialog is initialized on the homepage.

Help center pages under `/help/` report as the `support` page class; [`help-center.md`](help-center.md) owns them.

Support and Trust Center pages use `apps/site/src/information.css`, a static companion to the homepage design. Their policy content, contact destinations, and telemetry entry remain unchanged.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/telemetry.ts` | Global route lookup, first-party anonymous identity, capability bootstrap, closed envelopes, page/action/handoff reporting, and failure isolation. |
| `apps/site/src/site-entry.ts` | Initializes page-view and page-leave reporting on every built HTML entry. |
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
an external referring domain, and allowlisted `utm_source`, `utm_medium`, and
`utm_campaign` values. `site_page_left` carries the page/path and a bounded
visible-duration bucket. Global maps these observations one-for-one to PostHog
`$pageview` and `$pageleave`, with URL/host/path properties derived from the
already validated site context. Electron screen events never impersonate web
page events.

`site_action_selected` reports a click on a tagged link on the landing or
support pages (`/download/` initializes no telemetry). A link opts in with a `data-site-action` id, and
`SITE_ACTION_LINKS` in `telemetry.ts` maps each id to a closed action, placement
and, for pricing actions, plan. One capture-phase click listener reads the id
and ignores any id not in that table, so markup chooses a combination but never
supplies a value. Every installer link has its own id (`download-header`,
`download-hero`, `download-pricing-start|grow`), which is how the landing
dashboard tells the four identical DMG links apart. The event shares the page
view's anonymous `distinct_id`, so its referrer and campaign come from joining
to that visit's `$pageview` rather than being copied onto the click.
A middle-click, which fires `auxclick` rather than `click`, counts too.

`desktop_handoff_attempted` reports the handoff type,
whether it was merely presented or actually attempted, and whether the local
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
  ignores arbitrary query keys and never sends a complete URL.

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
