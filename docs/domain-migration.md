# Domain migration

Avalon is becoming Rally, and its ten public hostnames are moving from
`with-avalon.com` to `rallywith.ai`. **Both zones serve simultaneously.** Every
URL the product mints is a Rally one; every Avalon one still answers. This
document owns which hostnames exist, which is canonical, what each serves, and
what has to be true before an Avalon hostname can be switched off.

Read it before adding a public hostname, changing one a caller was given, or
retiring an Avalon one. Two things that look like domains ride along with the
rename and are covered here because they fail the same way: the desktop
deep-link scheme, and the work-stream email domain.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/wrangler.global.jsonc` | Global Worker routes and every canonical URL it hands out (`PUBLIC_API_BASE_URL`, `PUBLIC_WEB_BASE_URL`, the four ingress base URLs, `ALLOWED_ORIGINS`, `DESKTOP_DEEP_LINK_URI`, `WORKSTREAM_EMAIL_DOMAIN`). |
| `apps/api/wrangler.eu.jsonc` | The same for the EU Worker; `eu.api.rallywith.ai` is the one hostname needing a certificate order. |
| `apps/site/wrangler.jsonc` | The four site routes: both Rally and both Avalon. |
| `packages/contracts/src/desktop-deep-link.ts` | The one list of deep-link schemes — minted, legacy, and accepted. Every other surface reads it. |
| `apps/api/src/lib/workstream-email-address.ts` | The minted email domain and the legacy domains still accepted inbound. |
| `apps/api/src/services/terminal/network-policy.ts` | The sandbox baseline allowlist, which holds the canonical API hosts only. |
| `apps/desktop/src/main/index.ts` | `rendererHost` — the `app://rallywithai` origin the Workers' `ALLOWED_ORIGINS` must admit. Also registers every accepted scheme with the operating system and filters what reaches a renderer. |
| `apps/desktop/src/renderer/lib/app-session.tsx` | The renderer's deep-link matcher — the surface that decides what an arriving link *does*. The fifth surface, and the one a scheme list is easiest to forget in, because it is reached only after the operating system and the main process have both already accepted the link. |
| `apps/desktop/src/main/message-export.ts` | `MESSAGE_EXPORT_SCHEME` — `rallywithai-export`, in-process only and renamed outright. |
| `apps/api/test/domain-migration-config.test.ts` | Asserts the deployed configs list both renderer origins, all four site origins, both route sets, and no superseded host in any minted URL. |
| `apps/api/src/lib/desktop-handoff.ts` | `compatibleDesktopDeepLink` — the one place a deep link is minted in its superseded scheme, for targets the server cannot attribute to a calling build. |
| `apps/api/src/services/auth-service.ts` | `allowedReturnUri` — pins the sign-in destination's host and path, deliberately not its scheme. |
| `apps/site/public/_headers` | The site's CSP `connect-src`, which permits both API origins. |
| `config/provider-apps/*.json` | The provider registrations to apply by hand, per provider. |

## How it works

### The ten hostnames

| Canonical hostname | Serves | Superseded hostname, still served |
| --- | --- | --- |
| `rallywith.ai` | Public marketing and legal site; `PUBLIC_WEB_BASE_URL`; the origin every canonical work-stream link is minted on | `with-avalon.com` |
| `www.rallywith.ai` | Second custom domain on the same site Worker | `www.with-avalon.com` |
| `api.rallywith.ai` | Global regional API; packaged desktop default; site telemetry ingest; sandbox allowlist | `api.with-avalon.com` |
| `eu.api.rallywith.ai` | EU regional API | `eu.api.with-avalon.com` |
| `github.rallywith.ai` | GitHub App smart ingress — `/ingest/github` and the setup URL | `github.with-avalon.com` |
| `linear.rallywith.ai` | Linear webhook ingress | `linear.with-avalon.com` |
| `notion.rallywith.ai` | Notion callback and webhook, answering for both regions | `notion.with-avalon.com` |
| `slack.rallywith.ai` | Slack events, interactivity, commands | `slack.with-avalon.com` |
| `automation.rallywith.ai` | Inbound work-stream and automation mail (Resend MX) | `automation.with-avalon.com` |
| `downloads.rallywith.ai` | R2 custom domain for desktop installers and the update feed | `downloads.with-avalon.com` |

Eight are attached to a Worker by a `routes` entry, listing the Rally pattern
and the Avalon pattern side by side. `automation.` is mail only and carries no
Worker route. `downloads.` is an R2 custom domain, configured outside this
repository.

### What is canonical, and what that means

Canonical is about **what gets written**, not what gets read. A Rally hostname
is what every minted URL, every redirect target, every registration manifest,
and every compiled default now contains. An Avalon hostname is still routed,
still resolves, and still serves the identical Worker — it is simply never the
answer to "what is our URL".

The asymmetry is the whole design. Reading is widened; writing is switched. That
is what lets the rename proceed without a coordinated cutover, because every
address already in the world keeps working while nothing new is minted on it.

### The deep-link scheme

`rallywithai://` is minted; `avalon://` is parsed and never emitted, with one
deliberate exception below. The desktop registers **both** with the operating
system.

A URL scheme is claimed by an *installed* build, which is what makes it unlike a
hostname: nothing on the server can make an older client answer to a scheme it
never registered. A build shipped before the rename knows `avalon:` alone, and
the links it minted are sitting in inboxes and Slack history that nobody can
reissue. So the Worker's `DESKTOP_DEEP_LINK_URI` moved to `rallywithai://`, and
every parser on every surface accepts either.

**Accepting a scheme is not the same as being able to answer in it**, and that
distinction decides two paths that look alike:

- **Sign-in answers in the caller's scheme.** `POST /auth/google/start` carries
  the client's own `returnUri`. `allowedReturnUri` pins its host and path to
  `DESKTOP_DEEP_LINK_URI` and deliberately does *not* pin its scheme, then
  returns the caller's value unchanged, so the completion lands in the scheme
  that build registered. Pinning the scheme would reject every pre-rename client
  with `invalid_return_uri` before OAuth even began.
- **Connector OAuth cannot, so it mints the compatible scheme.** A connector
  start request carries only a scope and capabilities — there is no caller
  scheme to record, and the completion is reached through a `return_uri` the
  server stored earlier. `compatibleDesktopDeepLink` therefore mints
  `COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL`: the oldest scheme still registered,
  which is the only one both build generations answer, because every build since
  the rename registers the current scheme *and* the legacy one. The same applies
  to the identity error path, which is reached when no stored return URI can be
  consumed.

That constant is the single place this migration writes a superseded value on
purpose, and it retires itself — when the last legacy scheme leaves the list, it
becomes the current scheme with no other edit.

### The two internal schemes

`app://rallywithai` is the packaged renderer's origin, and it is **not** purely
internal: it is the `Origin` header on every API request and WebSocket upgrade
the desktop makes, so both regional Workers list `app://rallywithai` and `app://avalon`
in `ALLOWED_ORIGINS`. A shipped build sends `app://avalon` and cannot be made to
send anything else, so this follows the same rule as the deep-link scheme —
switch what is written, widen what is accepted.

`rallywithai-export://` is the scheme a saved message card is rendered from. That one
*is* purely internal: the scheme is registered, served, and loaded inside one
process, against a single-use in-memory token, and nothing outside ever sees it.
It was renamed outright, with no legacy accepted, because there is no second
party to keep working. The distinction is the useful one to carry: a scheme
needs a compatibility window exactly when something outside this process
remembers it.

### The work-stream email domain

New addresses are minted on `automation.rallywith.ai`. Mail to
`automation.with-avalon.com` is still routed.

A work-stream address is **stored, not derived** — one row per work stream in
the Global `workstream_email_routes` ledger — so renaming the domain does not
move the addresses already issued. Those are printed in mail clients, saved in
contacts, and forwarded to by rules nobody here can see. Routing is keyed by
local part, so an old address resolves through exactly the same lookup as a new
one; the domain only decides whether a recipient is ours at all.

The domain a message *arrived on* is carried through to the region rather than
replaced with the canonical one, so the address attached to the work stream is
the address the sender actually used.

Minting and accepting are guarded separately. `configuredEmailDomain` requires
`WORKSTREAM_EMAIL_DOMAIN` to equal the canonical domain **exactly**, so a
deployment left on a superseded one fails loudly instead of quietly issuing
addresses nobody means to issue; `acceptedEmailDomains` is the wider set, and it
governs receiving only.

### Reading a shared link on more than one origin

`parseWorkstreamLink` reads one origin by default — the caller's own — because
the site really does serve one origin per request, and a narrow default is what
stops a look-alike host borrowing the treatment. A caller that is *handed* URLs
by a third party does not get that luxury and names every origin it accepts.

Slack is the case that matters: its app registers both site domains for
unfurling, so it delivers `link_shared` for links on either, with no way to know
which one a link in channel history was minted on. It passes
`PUBLIC_WEB_BASE_URL` plus `LEGACY_WORKSTREAM_LINK_ORIGINS`. Passing only the
canonical origin would silently drop every already-shared Avalon link — silently
because the drop is indistinguishable from Slack not delivering the event.

### Provider webhooks are switched by hand

A provider stores one webhook URL per app. GitHub, Linear, Notion, and Slack
each call exactly one of the two hosts, whichever their registration names, so
this is the one part of the migration that is a cutover rather than a dual
deployment. Both hosts serve, and the registrations are moved one provider at a
time. `config/provider-apps/*.json` describes the target state and is applied
manually; see [`provider-apps.md`](provider-apps.md).

OAuth callbacks are the exception and are genuinely dual: those lists are
multi-valued, so each manifest registers the Rally and the Avalon callback for
both regions and a connection completes on whichever origin the client used.

## Invariants

- **An Avalon hostname is removed only when nothing is observed arriving on it.**
  Removing one is not reversible on the timescale that matters: DNS and caches
  have already handed it out. A route costs nothing to keep.
- **`downloads.with-avalon.com` can never be retired.** The update feed URL is
  compiled into every shipped DMG, so binaries in the field poll it forever. It
  outlives every other Avalon hostname.
- **Every origin a live client sends appears in `ALLOWED_ORIGINS`.** That is the
  four site origins *and* both renderer origins. An origin the browser actually
  used but the Worker does not list is rejected by Chromium before any route
  code runs — the renderer sees a transport failure and no API request is
  logged, so the failure is invisible from the server side.
- **The deep-link scheme list lives in one module.** Five surfaces must agree on
  it and none can check the others; a copy that fell behind would silently
  classify a real link as untrusted, on one surface only.
- **A deep link the server mints without a caller scheme uses
  `COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL`.** Minting the current scheme there
  sends a pre-rename build to a scheme nothing on its machine claims, and the
  flow dead-ends with no error raised anywhere.
- **`allowedReturnUri` pins host and path, never scheme.** Widening the host or
  the path would let a caller name its own destination; narrowing the scheme
  locks out every client that has not updated.
- **A legacy email domain leaves `LEGACY_WORKSTREAM_EMAIL_DOMAINS` only when
  inbound mail to it has stopped.** Dropping one silently discards every message
  to every address issued before the rename, and a discarded message is
  indistinguishable from nobody having written.
- **The sandbox network baseline holds canonical hosts only.** It is bounded by
  `TERMINAL_NETWORK_MAX_TARGETS`, and every baseline entry spends one of the
  twenty slots a workspace could otherwise use for its own domains.

## Boundary

This document owns the hostname inventory and the dual-serving rules. It does
not own what any individual host does: [`regionalization.md`](regionalization.md)
owns the Global/EU split and the shared ingress design,
[`provider-apps.md`](provider-apps.md) owns the registrations,
[`workstream-email-addresses.md`](workstream-email-addresses.md) owns the
address format and allocator, [`workstream-links.md`](workstream-links.md) owns
the canonical link shape, and [`security.md`](security.md) owns the origin
policy. Certificate and DNS procedure is in [`runbook.md`](runbook.md).

It also does not cover the rest of the rebrand. Worker names
(`avalon-api-global`, `avalon-site`), the R2 bucket `avalon-desktop-releases`,
Vectorize index names, the `@avalon/*` package names, and the `Avalon` product
string are deliberately untouched: none of them is addressable from outside, so
none of them carries the constraint that makes a hostname hard to move.

## Failure modes and limits

- **`eu.api.rallywith.ai` serves a TLS error without an ACM pack.** It is two
  labels deep and the zone's Universal SSL covers one. Wrangler creates the
  route and DNS record regardless, so an unreachable EU region looks deployed.
  The certificate is ordered before the deploy —
  [`runbook.md`](runbook.md#order-the-eu-api-certificate-before-deploying-the-rally-routes)
  has the procedure. The other nine hostnames are single-label and covered.
- **Rally senders are rejected until Rally DKIM/SPF is live.** Resend verifies a
  sending domain, not an address, so `invites@rallywith.ai` and
  `notifications@rallywith.ai` do not inherit the Avalon verification.
- **Web analytics attribute every visit to the canonical domain.** A site
  telemetry envelope reports a `pathname` and deliberately nothing else about
  its origin, so `$host` is reconstructed from `PUBLIC_WEB_BASE_URL`. While both
  domains answer, traffic arriving on either is filed under the canonical one.
  Splitting acquisition by domain needs the site to report its own host, which
  is a registered telemetry property and a privacy-boundary decision.
- **A provider switched but not verified is silent.** A webhook pointed at a
  host that does not serve produces no error here — deliveries simply stop.
  Switch one provider at a time and confirm ingress before the next.

## Testing

`apps/site/test/site.test.ts` asserts the full route list, the CSP, the
canonical tags, the sitemap, and both minted deep links —
`declares every production custom domain…` is the one that fails if an Avalon
route is dropped. `packages/contracts/src/workstream-links.test.ts` covers
minting the new scheme and reading the old, including a test that asserts the
*writing* side alone: parsing accepts both, so minting the wrong scheme would
otherwise still round-trip and no other test would notice.
`packages/contracts/src/url-schemas.test.ts` covers the schema pair, and
`apps/api/test/resend-inbound-email.test.ts` covers a legacy-domain recipient
resolving and reporting the domain it arrived on.
`apps/desktop/src/renderer/lib/app-session.test.tsx` covers the renderer
matcher from the *minted* scheme — `completes sign in from the scheme a current
build mints`. Every other deep-link test in that file dispatches the legacy
scheme, which is what let a literal `'avalon:'` comparison there survive the
rename with a full green suite.

Nothing here exercises DNS, certificates, or a provider registration. Those fail
only in production, which is why they are runbook steps with an explicit order
rather than assertions.

## Changelog

### 2026-08-25 — The renderer matches the scheme list too

**What changed:** `apps/desktop/src/renderer/lib/app-session.tsx` compared
`deepLink.protocol` against a literal `'avalon:'` in all eight of its deep-link
branches. All eight now call `isDesktopDeepLinkProtocol`. No behaviour was
intended to change here — this is the renderer catching up to the scheme list
the other four surfaces already read.

**Why:** Sign-in was broken in production for every current build. `SignInScreen`
asks for a `rallywithai://auth/complete` return URI, `allowedReturnUri`
deliberately does not pin the scheme, and the Worker echoes the caller's value
back unchanged — so the completion arrives in the scheme the calling build
minted, which the renderer then refused as "Avalon received an unexpected
sign-in link". Every other link the rename switched failed the same way and for
the same reason: work-stream, invitation, Slack-link, settings, automation, and
the `notes` link the main process mints for a closing meeting window. Connector
OAuth was the one flow that kept working, because `compatibleDesktopDeepLink`
mints the legacy scheme on purpose — which is why the outage read as
"sign-in is broken" rather than "deep links are broken".

The scheme list's own comment predicted this exact shape: a copy that fell
behind "would not fail loudly — it would silently classify a real link as
untrusted, on one surface only". The list was introduced precisely so five
surfaces could stop keeping copies, and four of them were converted. The fifth
is the one furthest from the scheme's definition and the last to see a link, so
nothing upstream of it could fail first and expose the gap.

**Considered and rejected:** Pinning `DESKTOP_DEEP_LINK_URI` back to the legacy
scheme to restore sign-in without touching the client. It would have worked, and
it would have made the renderer's literal correct again by moving the rest of
the product back to the superseded scheme — reverting the migration to avoid
fixing the one surface that had not moved.

**Consequences:** The renderer no longer names a scheme, so it needs no edit
when `avalon:` is finally dropped — the retirement stays a one-line change to
`LEGACY_DESKTOP_DEEP_LINK_PROTOCOLS`. A test dispatching only the legacy scheme
is now known to prove nothing about the scheme builds actually mint; the
matching-side tests are the ones that have to name both, and a new deep-link
branch should be covered from the minted scheme rather than the convenient one.

### 2026-08-25 — Accepting a scheme and answering in it are separated

**What changed:** `allowedReturnUri` accepts any registered deep-link scheme on
the configured host and path, and returns the caller's own value rather than the
configured one. `compatibleDesktopDeepLink` mints
`COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL` wherever the server builds a deep link it
cannot attribute to a calling build — the connector attempt's stored `return_uri`
and the identity error path. `parseWorkstreamLink` accepts a set of origins, and
the Slack unfurl path names both site domains. `configuredEmailDomain` guards
minting against the canonical domain exactly, leaving `acceptedEmailDomains` to
govern receiving. `$current_url` is concatenated onto the origin instead of
resolved against it.

**Why:** Review found that the entry above claimed a compatibility rule the code
did not actually hold on two surfaces, and both of them broke sign-in for
already-installed builds. `allowedReturnUri` compared the caller's scheme against
`DESKTOP_DEEP_LINK_URI`, which had just moved — so every pre-rename client would
have failed `POST /auth/google/start` with `invalid_return_uri` before OAuth
began. No test caught it because every API test env sets the deep-link URI to the
legacy scheme, so client and server agreed everywhere except production.
Connector completion had the same shape with no client value to widen against:
its target is minted server-side, so a pre-rename build was sent to a scheme
nothing on its machine claimed and the flow dead-ended silently.

The distinction that resolves both: accepting a scheme is cheap and belongs
everywhere, but *answering* in one requires knowing what the caller registered.
Where the caller says (`returnUri`), answer in its scheme. Where it cannot, mint
the oldest scheme still registered — every build since the rename registers both,
so that is the one target reaching both generations.

The Slack drop was the same error in the reading direction: the app registers
both site domains for unfurling and Slack delivers `link_shared` for either, but
the parser was given only the canonical origin, so every already-shared Avalon
link was delivered and discarded.

**Considered and rejected:** Carrying the calling build's scheme into the
connector attempt the way `returnUri` does for identity. It is the more complete
answer and remains the right one later, but it needs an optional field on six
separate start schemas plus `/:id/reconnect` (which has no body), a stored value,
and a desktop change — and it *still* needs a default for clients that send
nothing, which is exactly the compatible-scheme rule. The constant achieves the
same result for every live client today and deletes itself when the legacy scheme
is retired.

Also rejected: dropping `with-avalon.com` from Slack's `unfurl_domains` to stop
the dead deliveries. That stops the drop by giving up the unfurl, on links people
are still sharing.

**Consequences:** `COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL` is the one value this
migration deliberately writes in its superseded form; anything minting a deep
link without a caller scheme must use it, and it becomes the current scheme by
itself once the legacy list empties. `allowedReturnUri` must keep pinning host
and path — only the scheme is open. `parseWorkstreamLink`'s default stays narrow;
widening is per-caller and only for callers handed URLs by a third party. And the
minting guard on the email domain is exact on purpose: relaxing it back to
membership in the accepted set lets a deployment issue addresses on a domain it
is migrating off, with nothing to notice.

### 2026-08-25 — The renderer origin and the export scheme move too

**What changed:** The packaged renderer's origin became `app://rallywithai`, with
`app://avalon` added to `ALLOWED_ORIGINS` in both regions rather than replaced.
The message-export scheme became `rallywithai-export://` outright, with no legacy
accepted. `apps/api/test/domain-migration-config.test.ts` now asserts the
deployed configs against both.

**Why:** Neither is a hostname, but one of them behaves like one. `app://rallywithai`
is the `Origin` header on every API request and WebSocket upgrade the desktop
makes, so it is a value a *remote* party checks — and a build shipped before the
rename sends `app://avalon` and cannot be made to send anything else. Renaming it
without widening the allowlist would have rejected every installed client at the
CORS preflight, which fails before any route code runs and therefore leaves no
API request log to diagnose it from.

`rallywithai-export://` has no such party. The scheme is registered, served, and loaded
inside one process against a single-use in-memory token; nothing outside ever
holds one. A compatibility window there would have been dead code from the day
it shipped.

**Considered and rejected:** Treating both the same way for consistency — either
renaming both outright, or giving both a legacy alias. Consistency is the wrong
axis: what decides it is whether something outside this process remembers the
old value. One does, one does not.

**Consequences:** `app://avalon` is now load-bearing in `ALLOWED_ORIGINS` and is
removed on the same evidence as an Avalon hostname — when nothing is observed
arriving on it, which is a decision about shipped clients rather than about this
repository. The config test fails on the edit rather than on the deploy, which is
the only place this class of mistake is cheap to catch.
### 2026-08-25 — Both zones serve, Rally is canonical

**What changed:** All ten public hostnames now serve on `rallywith.ai` and
`with-avalon.com` at once. Every minted URL, compiled default, redirect target,
and registration manifest moved to Rally; every Avalon hostname stays routed and
is never emitted. The desktop deep-link scheme became `rallywithai://` with
`avalon://` still registered and parsed, new work-stream addresses are minted on
`automation.rallywith.ai` with the Avalon domain still received, and the
PostHog adapter's hardcoded `$host` became a read of `PUBLIC_WEB_BASE_URL`.

**Why:** The rename has to happen without a coordinated cutover, because the
callers cannot be coordinated. Three of them are outside our control entirely: a
provider stores one webhook URL and is changed by hand in its own console, a
shipped desktop build carries its API host and its URL scheme compiled in, and a
work-stream email address is stored per row and already printed in someone's
mail client. A flag-day switch would break all three at once, and each would
fail silently — a webhook that stops delivering, a client that cannot complete
authentication, mail that is discarded — with nothing to distinguish any of them
from an ordinary quiet period. Widening what is read while switching what is
written removes the need for the day.

`$host` was included because a literal that names one of two live domains stops
being merely stale and starts being wrong: it would attribute Rally traffic to
Avalon for the entire migration, which is exactly the period the number is
being watched.

**Considered and rejected:** Naming the EU API `eu-api.rallywith.ai` to stay
inside the zone's Universal SSL wildcard and avoid a certificate order. Rejected
because the ACM pack on that zone is already bought, already covers
`*.internal.rallywith.ai`, and holds up to 50 hostnames, so extending it costs
an order rather than money — and the name is public and effectively permanent,
which is a poor thing to trade for one pre-deploy step.

Also rejected: adding the Avalon API hosts to the Terminal sandbox network
baseline alongside the Rally ones. A sandbox reaches Avalon at whatever
`PUBLIC_API_BASE_URL` names, which is Rally in both regions, so the old hosts
would have been unreachable entries — and the baseline is bounded by
`TERMINAL_NETWORK_MAX_TARGETS`, so each one would have taken a slot away from
every workspace's own domain allowance. That is a user-visible limit being
spent on nothing.

**Consequences:** Two zones must stay deployable together: the Cloudflare API
token needs Zone Read and Workers Routes on both, and dropping either zone's
routes 404s addresses that are already indexed and unfurled. `eu.api.rallywith.ai`
cannot be deployed before its certificate is active. Rally DKIM/SPF must be live
before the Rally senders are, since Resend verifies the domain rather than the
address. Provider webhooks remain single-valued and are switched one at a time;
until each is moved, that provider is still calling the Avalon ingress. Web
analytics cannot split acquisition by domain while both answer. And
`downloads.with-avalon.com` is now permanent — every DMG already shipped polls
it — so it is the one hostname on this list that has no retirement.
