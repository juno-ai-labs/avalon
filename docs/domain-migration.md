# Domain migration

Avalon is becoming Rally, and its legacy public hostnames are moving from
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
| `apps/site/wrangler.jsonc` | The four site routes: both Rally and both Avalon. |
| `packages/contracts/src/desktop-deep-link.ts` | The one list of deep-link schemes — minted, legacy, and accepted. Every other surface reads it. |
| `apps/api/src/lib/workstream-email-address.ts` | The minted email domain and the legacy domains still accepted inbound. |
| `apps/api/src/services/terminal/network-policy.ts` | The sandbox baseline allowlist, which holds the canonical API hosts only. |
| `apps/desktop/src/main/index.ts` | `rendererHost` — the `app://rallywithai` origin the Workers' `ALLOWED_ORIGINS` must admit. |
| `apps/desktop/src/main/message-export.ts` | `MESSAGE_EXPORT_SCHEME` — `rallywithai-export`, in-process only and renamed outright. |
| `packages/contracts/src/http-headers.ts` | The product header prefix, the superseded prefixes, and `readRallyHeader` — the one way a product header is read. |
| `packages/contracts/src/telemetry.ts` | `TELEMETRY_ENVELOPE_SCHEMA` and the superseded identifiers the envelope parser still accepts. |
| `apps/desktop/src/main/user-data-path.ts` | The canonical userData directory, the superseded ones, and the launch-time adoption that moves them. |
| `apps/desktop/src/main/session-file.ts` | `rally-data`, and the one-shot rename of the superseded session directory. |
| `apps/desktop/src/main/session-encryption.ts` | The minted session envelope headers and the superseded ones, which are also the AES-GCM AAD. |
| `apps/api/src/lib/desktop-handoff.ts` | `compatibleDesktopDeepLink` — the one place a deep link is minted in its superseded scheme, for targets the server cannot attribute to a calling build. |
| `apps/api/src/services/auth-service.ts` | `allowedReturnUri` — pins the sign-in destination's host and path, deliberately not its scheme. |
| `apps/site/public/_headers` | The site's CSP `connect-src`, which permits both API origins. |
| `config/provider-apps/*.json` | The provider registrations to apply by hand, per provider. |

### The migrated hostnames

| Canonical hostname | Serves | Superseded hostname, still served |
| --- | --- | --- |
| `rallywith.ai` | Public marketing and legal site; `PUBLIC_WEB_BASE_URL`; the origin every canonical work-stream link is minted on | `with-avalon.com` |
| `www.rallywith.ai` | Second custom domain on the same site Worker | `www.with-avalon.com` |
| `api.rallywith.ai` | Global regional API; packaged desktop default; site telemetry ingest; sandbox allowlist | `api.with-avalon.com` |
| `github.rallywith.ai` | GitHub App smart ingress — `/ingest/github` and the setup URL | `github.with-avalon.com` |
| `linear.rallywith.ai` | Linear webhook ingress | `linear.with-avalon.com` |
| `notion.rallywith.ai` | Notion callback and webhook, answering for configured deployments | `notion.with-avalon.com` |
| `slack.rallywith.ai` | Slack events, interactivity, commands | `slack.with-avalon.com` |
| `automation.rallywith.ai` | Inbound work-stream and automation mail (Resend MX) | `automation.with-avalon.com` |
| `downloads.rallywith.ai` | R2 custom domain for desktop installers and the update feed | `downloads.with-avalon.com` |

Seven are attached to a Worker by a `routes` entry, listing the Rally pattern
and the Avalon pattern side by side. `automation.` is mail only and carries no
Worker route. `downloads.` is an R2 custom domain, configured outside this
repository.

### New Ashby hostname

`ashby.rallywith.ai` is a new hostname with no Avalon predecessor. Its custom
domain belongs to `avalon-connector-ashby-global`, configured by
`apps/api/wrangler.ashby.global.jsonc`. It must not also be assigned to the Global
API Worker. The dedicated entry point routes exact signed webhook bytes to the
owning regional service and serves no connection-management or model endpoints.
OAuth callbacks stay on the regional API hosts. Granola registrations retain their
existing regional API URLs; adoption does not rewrite provider subscriptions.

### New browser hostname

`app.rallywith.ai` belongs to the `rally-browser` Worker and has no Avalon
predecessor. It is the canonical guest invitation and browser sign-in origin;
`rallywith.ai/app/*` remains the marketing site's desktop handoff. Global
`BROWSER_APP_ORIGIN` and `ALLOWED_ORIGINS` include the browser origin. See
[browser-client.md](browser-client.md) for deployment and rollback.

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
- **Connector OAuth records the caller's handoff grammar, but still mints the
  compatible scheme.** A current connector start adds
  `desktopHandoffVersion=2`; an older API ignores that query field safely, and
  an older desktop omits it. The accepting API stores either the versioned
  workspace-addressed path or the legacy unaddressed path in `return_uri` and
  uses that same value after the provider returns. There is still no caller
  scheme to record, so `compatibleDesktopDeepLink` mints
  `COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL`: the oldest scheme still registered,
  which is the only one both build generations answer, because every build since
  the rename registers the current scheme *and* the legacy one. The same applies
  to the identity error path, which is reached when no stored return URI can be
  consumed.

The versioned path has host `workspace`; builds released before workspace
addressing do not recognize it and fail closed. This cannot be a query pair on a
known host: the previous work-stream reader accepted extra query fields but
ignored them, which would turn an addressed link into an active-workspace link.

That constant is the single place this migration writes a superseded value on
purpose, and it retires itself — when the last legacy scheme leaves the list, it
becomes the current scheme with no other edit.

### The two internal schemes

`app://rallywithai` is the packaged renderer's origin, and it is **not** purely
internal: it is the `Origin` header on every API request and WebSocket upgrade
the desktop makes, so configured regional Workers list `app://rallywithai` and `app://avalon`
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
the full normalized address, so the old and current domains retain independent
namespaces even when a local part repeats. The accepted-domain set decides which
recipients may be looked up; it does not disappear from the lookup key.

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
configured deployments and a connection completes on whichever origin the client used.

## Invariants

- **An Avalon hostname is removed only when nothing is observed arriving on it.**
  Removing one is not reversible on the timescale that matters: DNS and caches
  have already handed it out. A route costs nothing to keep.
- **`downloads.with-avalon.com` can never be retired.** The update feed URL is
  compiled into every shipped DMG, so binaries in the field poll it forever. It
  outlives every other Avalon hostname.
- **Every origin a live client sends appears in `ALLOWED_ORIGINS`.** That is the
  four site origins, the browser app origin, and both renderer origins. An
  origin the browser actually
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
owns the configured deployment split and the shared ingress design,
[`provider-apps.md`](provider-apps.md) owns the registrations,
[`workstream-email-addresses.md`](workstream-email-addresses.md) owns the
address format and allocator, [`links.md`](links.md) owns
the canonical link shape, and [`security.md`](security.md) owns the origin
policy. Certificate and DNS procedure is in [`runbook.md`](runbook.md).

It also does not own the rest of the rebrand, but three things that were listed
here as untouched have since moved and are covered above because they carry the
same constraint a hostname does: the product HTTP header prefix, the telemetry
envelope schema identifier, and the desktop's stored-data namespace. The package
scope (`@rally/*`) and the `Rally` product string moved too, and neither needed a
compatibility window — nothing outside a build reads either.

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

No automated test covers the site's route list, CSP, canonical tags, sitemap or
deep-link hostnames. Those are deploy configuration, and the deploy is their
test ([`testing.md`](testing.md#what-to-test-and-what-not-to)). `packages/contracts/src/links.test.ts` covers
minting the new scheme and reading the old, including a test that asserts the
*writing* side alone: parsing accepts both, so minting the wrong scheme would
otherwise still round-trip and no other test would notice.
`packages/contracts/src/url-schemas.test.ts` covers the schema pair, and
`apps/api/test/resend-inbound-email.test.ts` covers a legacy-domain recipient
resolving and reporting the domain it arrived on.

Nothing here exercises DNS, certificates, or a provider registration. Those fail
only in production, which is why they are runbook steps with an explicit order
rather than assertions.

## Apple association

The Apple association is another hostname-coupled release surface. Only
`rallywith.ai` and `www.rallywith.ai` appear in desktop associated-domain
entitlements. Moving either requires serving the association on the new host
before releasing the corresponding entitlement; legacy origins remain browser
handoffs. See [links](links.md#apple-universal-links).

## Changelog

### 2026-08-27 — The raster pipeline regenerates from the new vector

**What changed:** `assets/brand/rally-mark-source.png` was redrawn from the new
vector and `scripts/generate-brand-assets.py` rerun, so every generated raster
asset — the mark PNGs, favicon, touch icon, social card, and desktop icons —
now carries the redesigned mark in `#CCFF00`. The out-of-band PNG replacement
recorded in the entry below is superseded: the generator is the source of
truth again, and rerunning it is safe.

**Why:** The previous entry left a standing hazard — a generator whose output
would regress the served mark. Closing it in the immediate follow-up was the
condition under which the out-of-band replacement was acceptable at all.

**Consequences:** The browser tab, the social unfurl, and the served mark now
agree. Icons uploaded to providers (Notion, Slack, GitHub) still hold old
copies until re-uploaded from `assets/brand/rally-mark.png`.

### 2026-08-27 — Public pages render the vector mark while manifests keep the raster URL

**What changed:** Every public HTML page now references the redesigned vector
mark — `/brand/rally-mark.svg`, with `/brand/rally-mark-small.svg` as the
thicker-stroke cut for placements narrower than 24 px. The public mark path for
provider manifests is unchanged, and the PNG served there was re-rendered from
the new vector (1024 px, transparent, the mark at the same ~68 % scale the
previous raster used), so hotlinking providers pick up the new mark on their
next fetch without any registration change. `assets/brand/rally-mark.png` — the
copy the provider setup docs say to upload — was replaced with the same render.

**Why:** The mark itself was redesigned (a single continuous line replacing the
woven ring), delivered as SVG. Pages we control were switched in one pass;
Linear manifests hotlink the PNG URL by absolute address, so new bytes at the
same URL are what updates them. Icons that were *uploaded* to a provider
(Notion, Slack, GitHub) hold their own copy and must be re-uploaded in each
provider's settings.

**Considered and rejected:** Deleting the PNG in the same change. It would
break the provider icons silently — nothing in this repository fails when a
hotlinked asset disappears.

**Consequences:** The PNG was replaced out of band of
`scripts/generate-brand-assets.py`, whose source mask still holds the woven
mark — rerunning the generator before that mask is redrawn would silently
regress `/brand/rally-mark.png` to the old mark. The favicon, social card, and
desktop icons still carry the woven mark until that regeneration happens. The
site tests enforce the split: pages must reference the SVGs and must not
reference the PNG, while the PNG file must continue to exist.

### 2026-08-25 — Email compatibility retains the domain in route identity

**What changed:** The Global email registry and inbound resolver now key claims
by full address. Existing Avalon-domain addresses and newly minted Rally-domain
addresses remain distinct permanent routes.

**Why:** Discarding the domain caused detail reconciliation to rebuild every
legacy route using the current Rally domain, producing a conflict with the exact
address already stored regionally. It would also prevent future custom domains
from using a local part present on any other domain.

**Considered and rejected:** Making legacy and Rally domains compare equal. That
would suppress the visible error while preserving the ambiguous routing model.

**Consequences:** Every compatibility domain remains part of route identity.
Adding a custom domain widens ingress acceptance and creates exact-address claims;
it does not require a new registry key.

### 2026-08-25 — Public pages write Rally while compatibility routes keep reading Avalon

**What changed:** Every public HTML surface, Trust Center contact, desktop
handoff label, canonical tag, and social unfurl now emits Rally and
`rallywith.ai`. The public mark path is `/brand/rally-mark.png`. The site still
serves both zones, accepts both desktop schemes, permits both packaged renderer
origins, and retains the already-published installer manifest exactly as issued.

**Why:** The migration had already made Rally canonical at the routing layer,
but the canonical page introduced itself as Avalon. The mismatch was visible in
Slack unfurls and in the reinstall instruction for the new Rally desktop app:
people followed a Rally URL and saw a different product name. Public content is
a writer, not a compatibility reader, so continuing to emit the old name had no
migration benefit and created fresh stale references on every share.

**Considered and rejected:** Renaming the legacy routes, schemes, bucket, and
published installer objects to make a repository-wide string search empty.
Those values are held by shipped clients, third parties, or immutable release
records. Changing them would turn a cosmetic cleanup into broken sign-in,
downloads, CORS, and already-shared links.

**Consequences:** New public content and metadata must use Rally exclusively.
An Avalon string in the site package is acceptable only when a compatibility
test or deployment record names the external value that still exists; it must
not reach rendered HTML. The test suite checks the distinction.

### 2026-08-25 — The header prefix, the envelope schema, and the desktop's namespace

**What changed:** The product HTTP header prefix moved from `x-avalon-` to
`x-rally-`, with every reader going through `readRallyHeader` in
`packages/contracts/src/http-headers.ts` and both spellings listed in the CORS
`allowHeaders`. The telemetry envelope's `schema` identifier moved to
`ai.rallywith.telemetry.event`, with `com.rally.telemetry.event` and
`com.avalon.telemetry.event` still parsed. The
desktop app renamed itself: `Rally`/`Rally Development` userData directories,
`rally-data` for the encrypted session files, `rally-session/*` envelope headers,
the bundle identifier `ai.rallywith.desktop`, and the `@rally/*` package scope
across the workspace.

**Why:** The rebrand had reached the hostnames and stopped. Everything left was
described here as un-addressable and therefore free to rename, and for the
package scope and the product string that was true. For three of them it was
not, and each fails in the way this document already describes:

- A **header name** is written by a build and read by a deployment, and a desktop
  build carries its header names compiled in. Renaming only the reader drops the
  operation ID, the draft ID, and the region assertion from every installed
  client — and the region assertion is the one that matters, because losing it
  means a pre-rename client's request is no longer checked against the region it
  meant to reach. `x-avalon-signature` is worse still: it is set by a third party
  from their own webhook console, so nothing here can make it change.
- The **envelope schema identifier** is validated with a literal, and the desktop
  spools envelopes to disk before sending. A spool written by the previous build
  and drained by the next one would have failed validation and been discarded, so
  the rename would have silently eaten telemetry across every update.
- The desktop's **stored-data namespace** is not a wire value but behaves like
  one: it is written by the previous build and read by the next. Everything a
  launch needs lives in that directory — Chromium profile, IndexedDB, settings,
  drafts, the encrypted session — so renaming it without moving it signs everyone
  out and loses their local state.

**Considered and rejected:** A per-file migration of the userData directory
instead of one rename. It has to enumerate every file correctly to avoid losing
something, and the list is not knowable from this repository — Chromium writes
into that directory too. The rename is atomic, carries what nobody thought to
list, and is idempotent.

Also rejected: rewriting stored session envelopes to the current header in a
migration pass. Every session write already re-seals under the current header, so
stored values converge as people use the app, and a migration pass is a chance to
fail with a credential half-moved for no gain.

Also rejected: renaming the Worker names, R2 buckets, and PostHog event names in
the same change — see the Boundary section for why each is a different kind of
decision.

**Consequences:** `readRallyHeader` is the only way a product header is read; a
new one is added to `RALLY_HEADERS` and reaches both spellings for free, and
retiring the superseded prefix is one edit to `LEGACY_RALLY_HEADER_PREFIXES`. The
CORS allowlist must keep listing both, because Chromium matches the preflight
list literally and rejects before any route code runs. One consequence cannot be
mitigated: macOS derives the safeStorage keychain entry from the application
name, so `Avalon Safe Storage` is unreadable to a build named Rally and there is
no Electron API that names it independently. Lockdown mode is the only mode that
binds a session to that key, so Lockdown users sign in once more after updating;
the default global mode uses a compiled key and is carried across by the
directory rename. `docs/security.md` owns that boundary.

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
`app://avalon` added to `ALLOWED_ORIGINS` in configured deployments rather than replaced.
The message-export scheme became `rallywithai-export://` outright, with no legacy
accepted. No automated check asserts the
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

Also rejected: adding the Avalon API hosts to the Terminal sandbox network
baseline alongside the Rally ones. A sandbox reaches Avalon at whatever
`PUBLIC_API_BASE_URL` names, which is Rally in configured deployments, so the old hosts
would have been unreachable entries — and the baseline is bounded by
`TERMINAL_NETWORK_MAX_TARGETS`, so each one would have taken a slot away from
every workspace's own domain allowance. That is a user-visible limit being
spent on nothing.
