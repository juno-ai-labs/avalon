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

`rallywithai://` is minted; `avalon://` is parsed and never emitted. The desktop
registers **both** with the operating system.

A URL scheme is claimed by an *installed* build, which is what makes it unlike a
hostname: nothing on the server can make an older client answer to a scheme it
never registered. A build shipped before the rename knows `avalon:` alone, and
the links it minted are sitting in inboxes and Slack history that nobody can
reissue. So the Worker's `DESKTOP_DEEP_LINK_URI` moved to `rallywithai://`, and
every parser on every surface accepts either.

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
- **Every served site origin appears in `ALLOWED_ORIGINS`.** An origin the
  browser actually used but the Worker does not list is rejected by Chromium
  before any route code runs — the renderer sees a transport failure and no API
  request is logged.
- **The deep-link scheme list lives in one module.** Five surfaces must agree on
  it and none can check the others; a copy that fell behind would silently
  classify a real link as untrusted, on one surface only.
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
Vectorize index names, the `app://avalon` renderer origin, the `avalon-export://`
scheme, the `@avalon/*` package names, and the `Avalon` product string are
deliberately untouched: none of them is addressable from outside, so none of
them carries the constraint that makes a hostname hard to move.

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

Nothing here exercises DNS, certificates, or a provider registration. Those fail
only in production, which is why they are runbook steps with an explicit order
rather than assertions.

## Changelog

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
