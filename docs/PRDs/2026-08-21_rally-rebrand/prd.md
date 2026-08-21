# Rally rebrand

> Created 2026-08-21.
>
> Avalon is renamed **Rally** across the product, the domains, the repository,
> and everything they touch — without breaking any link, email address, or
> installed build that was minted under the old name. The rename surface this
> is written against is surveyed in [`research.md`](research.md). Standing
> contract: [the Avalon implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md), which this PRD
> renames in place.

## Summary

The product currently named Avalon becomes **Rally**. A user sees Rally in the
menu bar, the Dock, the public site, exported cards, digest emails, and in how
the agent refers to itself; new work-stream links and automation email
addresses are minted under the `withrally.ai` domain; contributors work in a
repository named `rally` with `@rally/*` packages and `RALLY_*` environment
variables. New brand artwork is being produced separately and lands through
the existing icon pipeline.

The constraint that shapes the whole change: the old name is embedded in
artifacts we no longer control — links pasted into Slack and Linear,
`…@automation.with-avalon.com` addresses in people's forwarding rules, and an
installed desktop fleet that authenticates with `avalon-*` headers and polls
an `avalon`-domain update feed. So the rename is not one sweep but three
moves: teach the servers to accept both names, flip everything user-visible to
Rally in one coordinated release, then rename the contributor surface — while
`with-avalon.com` lives on indefinitely as a redirect and email alias.

## Motivation

The company has decided to rebrand: the Rally name is chosen, the
`withrally.ai` domain is bought for the public product, `rallywith.ai`
already serves internal tooling (`migrations.internal.rallywith.ai`), and a
logo is in production. What makes
this worth doing *now* rather than at leisure is that the cost of the rename
grows with every day of operation. Each new work stream mints a permanent
`with-avalon.com` link and email address; each digest, invitation, and Slack
post distributes the old name further; each desktop release deepens the
installed base keyed to the old update feed and app identity. The
compatibility surface described in this PRD is the size it is *because* the
product has been running for weeks — it only gets bigger.

There is also a coordination cost to a half-renamed product. The migration
tracker already lives on `rallywith.ai` while everything else says Avalon;
until the rename lands, every new document, prompt, provider registration, and
external artifact has to pick a side, and every one that picks Avalon is added
to the pile this PRD has to move.

## Goals

1. A user encounters only the Rally name and mark: app name and icon, Dock and
   menu bar, About panel, public site, exported message cards, digest and
   invitation emails, and the agent's own self-references in every prompt.
2. Every artifact minted from the flip onward carries the new domain: new
   work-stream links at `withrally.ai`, new automation addresses under the
   Rally email domain, and the desktop update feed and downloads under Rally
   hosts.
3. Every artifact minted before the flip keeps working, indefinitely:
   `with-avalon.com` links redirect to their `withrally.ai` equivalents, old
   automation addresses keep delivering to the same work streams, `avalon://`
   deep links keep opening the app, and an installed Avalon build auto-updates
   into Rally with its login, drafts, and settings intact.
4. Shipped desktop builds never break against the servers: every wire-level
   identifier that carries the old name (the `x-avalon-*` headers, the
   `avalon.ticket.v1` socket-ticket sentinel, the `app://avalon` renderer
   origin) is accepted alongside its Rally replacement until the update
   fleet has moved.
5. The contributor surface is renamed: the repository becomes
   `juno-ai-labs/rally`, packages become `@rally/*`, environment variables
   become `RALLY_*`, code symbols and docs say Rally, and CI, release
   tooling, and the sandbox definition all still pass.
6. Provider-facing surfaces — the Slack, GitHub, Linear, Notion, Google, and
   Resend registrations and their callback hosts — present as Rally, with each
   cutover sequenced so no OAuth flow or webhook goes dark.
7. A guard exists that keeps the old name from creeping back: a CI check fails
   on new user-visible "Avalon" strings, with an explicit allowlist for the
   compatibility identifiers this PRD deliberately retains.

## Non-goals

1. **Rewriting history.** Git history, merged pull requests, closed issues,
   and existing release tags keep the Avalon name. Rejected outright: history
   is a record, and GitHub redirects make old references keep resolving.
2. **Editing frozen PRDs or renaming PRD folders.** Completed PRDs are frozen
   and folder paths never change, per [`prds.md`](../../prds.md). The
   implementation brief's *content* is renamed because it is the one living
   PRD; its folder path, and every other PRD folder and body, stay as they
   are. Rejected outright.
3. **Backfilling data at rest.** Stored transcripts, activity events,
   work-stream descriptions, compaction checkpoints, and persisted literals
   such as the `avalon_upload` provider value are not rewritten. Readers stay
   tolerant of the old spellings forever. Rejected outright: fleet-wide data
   rewrites carry real risk for zero behavior change.
4. **Renaming identifiers inside production storage.** Durable Object SQLite
   names, D1 values, and per-work-stream terminal sandbox stable names
   (`avalon-<hash>`) keep their spelling; code refers to them through
   constants whose *symbol* names say Rally. Rejected outright, same reasoning
   as non-goal 3 — a storage rename is a migration in every object of every
   class, and a sandbox rename orphans the sandbox.
5. **Retiring `with-avalon.com`.** The old domain is kept registered, serving
   redirects and accepting email, for as long as any artifact references it —
   which is indefinitely. Goal 3 depends on this non-goal.
6. **Recreating Cloudflare resources that cannot be safely renamed in
   place.** D1 databases, Queues, R2 buckets, Analytics Engine datasets, and
   Worker scripts that own Durable Object state keep their `avalon-*` names;
   the runbook records the name mapping. Deferred: any such resource that is
   re-provisioned later for its own reasons takes the Rally name then, and a
   DO-owning script renames if a control-plane procedure is proven to
   preserve its namespaces (decision 4). The stateless site Worker renames
   in scope (goal 5).
7. **Renaming the company or its external accounts.** Juno AI Labs, the
   `avalon.slack.com` workspace, and the Azure OpenAI resource names are
   organizational assets outside this repository's scope. Deferred to the
   company rebrand at large.

## Product behavior

**Desktop.** The app is Rally: Dock icon and tile plugin, menu-bar status
item, window titles, About panel, and `Rally.app` / `Rally-<version>` release
artifacts. On first launch after the update, the app migrates its existing
user data directory (`…/Application Support/Avalon` → `…/Rally`) so login,
drafts, theme, and caches survive; a fresh install never sees the old path.
Both `rally://` and `avalon://` deep links open the app — the old scheme stays
registered so links and auth flows minted before the flip keep working. The
export renderer moves to a `rally-export` scheme with no compatibility
window — that scheme lives only inside the app's hidden export window and
never appears in a user-held link ([`security.md`](../../security.md));
message cards and their footers say Rally.

**Links.** New work streams get
`https://withrally.ai/app/workstreams/<uuid>` as the canonical link
([`workstream-links.md`](../../workstream-links.md) updated in the same
change). Any `with-avalon.com` URL — app links, site pages, download links —
answers with a permanent redirect to the same path on `withrally.ai`, in both
regions, from the flip onward.

**Email.** New work streams and automations are announced with addresses
under the Rally automation domain. The local part derivation is unchanged, and
inbound accepts **both** domains for the same local part, so an old address
and its Rally-domain twin reach the same work stream. Dual acceptance is a
contract on the *routing*, not just the ingress edge: today regional
ingestion reconstructs one configured full address and requires it to equal
the stored `email_address` row
(`apps/api/src/services/resend-inbound-email-service.ts`), which can only
match one domain. The route identity becomes the immutable local part plus
the target work stream or automation: ingress accepts an allowlisted set of
domains, and regional validation compares the local part of the stored
address rather than one canonical full string — stored rows are not
rewritten (non-goal 3), whichever domain they carry. Outbound mail —
digests, invitations, agent replies — sends from the Rally domain with Rally
naming, and surfaces that display an address show the Rally form.

**The agent.** Prompts, tool catalogs, and skills say Rally; the agent
introduces and refers to itself as Rally. The standing-contract line "Avalon
is inherent in every work stream" becomes Rally's. The model-visible tool
namespace becomes `rally_core.<tool>`; old spellings persist only inside
already-stored transcripts, which nothing replays against the live tool
registry.

**Public site.** Copy, metadata, OpenGraph, and download links say Rally and
point at `withrally.ai`. The old apex serves redirects, not content.

**Wire protocol.** The renderer sends `x-rally-*` headers, offers the
`rally.ticket.v1` sentinel in the socket handshake, and serves itself from
the `app://rally` origin once its build ships; the Workers negotiate
whichever sentinel a client offers, and `ALLOWED_ORIGINS` — enforced exactly
by CORS and by every socket admission path — carries both renderer origins
and both site domains, so both generations succeed for every renamed header,
origin, and scheme (goal 4). The ticket scheme itself is unchanged — only
the sentinel token moves — and the deprecated `ticket` query parameter is
untouched. Each addition follows
[`when-adding-a-new-http-header.md`](../../when-adding-a-new-http-header.md).
The compatibility set is removed only after the release-retention tooling
shows no supported build sending the old forms.

**Contributors.** The repository is `juno-ai-labs/rally` (GitHub redirects
the old name), the root package is `rally`, workspace packages are
`@rally/*`, environment variables and `.dev.vars` keys are `RALLY_*`, and the
docs — index, module documents, brief, rule sheet — describe Rally. Old PRD
folders and history are the only places the old name legitimately remains
(non-goals 1–2), plus the allowlisted compatibility identifiers behind
goal 7's CI guard.

**Failure states.** A redirect or dual-domain path that breaks is a broken
permanent artifact, so both are covered by the e2e smoke flows
([`e2e.md`](../../e2e.md)): old link resolves, old address delivers, old
build updates. If the flip release misbehaves, the desktop rollback is the
previous Avalon build — which is why the old update feed URL keeps serving
(Rollout below) until the fleet has moved.

## Impact on the product contract

The [implementation brief](../2026-08-05_avalon-implementation-brief/prd.md)
is edited in place — its one standing-contract privilege — replacing the
product name throughout, including the "Avalon is inherent in every work
stream" clause and the document's own title. No clause changes meaning: what a
work stream is, what the agent may do, the absence of channels, global inbox,
and global search all stand. Documents that cite "the Avalon implementation
brief" by name are updated to "the Rally implementation brief" in the same
change; the folder path they link to does not move.

## Decision log

None yet.

## Key design decisions

1. **The public domain is `withrally.ai`; `rallywith.ai` stays internal.**
   `withrally.ai` was bought for the rebrand and mirrors the existing
   `with-avalon.com` naming, so the subdomain map carries over one-for-one
   (`api.`, `eu.api.`, `automation.`, `downloads.`, `notion.`, `github.`,
   `slack.`, `linear.`, `www.`). `rallywith.ai`, which already serves
   `migrations.internal.rallywith.ai`, keeps that role: it is Rally-branded,
   operator-only, and moving it buys nothing. Alternative rejected:
   consolidating everything onto one of the two domains — the public estate
   should not share an apex with internal operator surfaces it would
   otherwise have to carve exceptions around, and the tracker is already
   live where it is.
2. **Old-name acceptance is indefinite for user-held artifacts, bounded for
   wire identifiers.** Links, email addresses, and deep-link schemes were
   handed to users with no expiry, so their old forms work forever (non-goal
   5). Headers and subprotocols are held only by our own shipped builds, so
   their old forms are dropped once release retention says the fleet has
   moved. Alternative rejected: a sunset window for links and addresses —
   [`workstream-email-addresses.md`](../../workstream-email-addresses.md)
   calls the addresses permanent, and a rebrand is not licence to break that
   contract.
3. **The macOS bundle identifier stays `app.avalon.desktop`.** It is invisible
   to users, and changing `CFBundleIdentifier` makes macOS treat Rally as a
   different application: keychain items, notification and TCC permission
   grants, and login-item registration are all lost, for every user, to
   rename a string nobody sees. The user-visible identity (`productName`,
   artifacts, icons, Dock plugin) all become Rally. Alternative rejected: a
   full identity migration with keychain re-consent — all cost, no user
   value. The one carried cost, first-run migration of the
   `productName`-derived userData path, is small and testable.
4. **Only provably-safe renames happen; nothing is recreated just for its
   name.** D1, Queues, R2, and Analytics Engine datasets only rename by
   recreate-and-copy, so they keep their names (non-goal 6) and the runbook
   carries the mapping. A Worker script that owns Durable Object namespaces
   or containers — both API Workers, the migration tracker, the crash
   symbolicators — is treated the same way: the script name is bound up with
   the namespaces, their append-only migration histories, and any service
   bindings that address it, and a change through Wrangler's `name` deploys a
   *different* script rather than renaming this one. Those names stay unless
   a Cloudflare-supported control-plane rename is demonstrated, against a
   non-production Worker, to preserve every namespace's stored objects — with
   a pre-cutover check that known object IDs still hold their data.
   `avalon-site`, which owns no state, renames in place. Alternative
   rejected: recreate-and-migrate — a data cutover risked against production
   for cosmetics, exactly the trade the [rule sheet](../../../AGENTS.md)
   says to refuse.
5. **One flip release, not a trickle.** Every user-visible surface — site,
   desktop, emails, links, prompts — changes in one coordinated desktop
   release plus Worker deploy (phase 2), after the acceptance groundwork of
   phase 1 is live. Alternative rejected: surface-by-surface renaming, which
   has the product half-named for weeks and multiplies the states the
   compatibility layer must cover. The prompt rename lands in the same flip:
   [`writing-prompts.md`](../../writing-prompts.md) treats prompt bytes as
   deliberate, and one change is one review.
6. **The rename guard is a CI check with an explicit allowlist**, added in
   phase 2 and tightened in phase 4. Everything this PRD deliberately keeps —
   frozen PRDs, storage literals, compatibility identifiers, the bundle id —
   is listed with a pointer to the decision that keeps it; anything else
   matching the old name fails the build. Alternative rejected: relying on
   review to catch regressions across ~800 files of prior art.

## Regional impact

Both regions move together. Each regional Worker gains its `withrally.ai`
custom domains alongside the existing ones during phase 1; identity, ticket
issuance, and socket admission behave identically on either host. The Notion
ingress ([`notion-ingress.md`](../../notion-ingress.md)) is the delicate one:
one public callback/webhook host serves both regions with region-prefixed
OAuth state, so `notion.withrally.ai` must be registered with Notion and
routed through the same Global route directory before the old host stops
being advertised. Nothing about where data comes to rest changes; no new
cross-region flow is introduced.

## Security and trust model

The trust surface moves but does not widen. New hosts enter the desktop CSP
and any origin allowlists in the same change that adds them; the old hosts
remain listed until their acceptance is dropped. Two deep-link schemes are
registered during the transition, so the desktop's URL handling validates
`rally://` exactly as it does `avalon://` — same parser, both schemes.
Webhook signature verification, session and ticket handling, and renderer
isolation are name-independent and unchanged. Secrets are renamed alongside
`RALLY_*` variables in phase 3 with the same placement rules
([`security.md`](../../security.md)); the Gitleaks history scan is unaffected
by renames going forward.

## Provider configuration

Each registration changes outside the repository; sequence per phase 1/2, and
nothing old is removed until release retention and webhook logs show it idle.

- **Cloudflare** — `withrally.ai` zone: custom domains for both API Workers,
  the site, `downloads.`, and provider ingress hosts; redirect rules on the
  `with-avalon.com` zone; the site Worker renamed, DO-owning Workers kept by
  name (decision 4).
- **Resend** — verify the Rally automation domain for sending; keep the old
  domain verified and receiving indefinitely (decision 2).
- **Slack, GitHub, Linear** (`config/provider-apps/*.json`) — display names,
  branding, and redirect/callback URLs move to `{slack,github,linear}.withrally.ai`;
  add-before-remove so in-flight OAuth completes. The GitHub App rides the
  repository rename; existing installations follow automatically.
- **Notion** — callback and webhook host re-registration per Regional impact;
  public-integration re-review risk is an open question.
- **Google** — OAuth consent screen name, logo, and authorized domains.
- **Apple** — team id (`AVALON_APPLE_TEAM_ID` renames in code only) and
  signing identity unchanged; notarization follows the bundle id, which stays
  (decision 3).
- **GitHub (repository)** — `juno-ai-labs/avalon` → `juno-ai-labs/rally`;
  redirects cover clones and API calls, but Actions references, the sandbox
  definition ([`sandbox.md`](../../sandbox.md)), and webhook payload
  expectations are updated in phase 3.

## Rollout

No feature flag: each phase is a deploy, reversible by redeploying its
predecessor, and sequenced so every state the fleet can observe is valid.

- **Phase 0 — prerequisites.** Confirm the open questions (name clearance,
  domain, repo name); land the logo through the icon pipeline
  ([`desktop-icons.md`](../../desktop-icons.md)); provision zones,
  certificates, and provider-side additions.
- **Phase 1 — accept both.** Workers serve on both domain families; accept
  both header/subprotocol/scheme generations; inbound email accepts both
  domains; desktop registers `rally://` alongside `avalon://`. Nothing
  user-visible changes; everything old still works. Ships first and soaks.
- **Phase 2 — flip.** One coordinated desktop release + Worker deploy:
  product name, artwork, site, prompts, emitted links and addresses, export
  cards, emails all become Rally; `with-avalon.com` becomes redirects; the
  update feed publishes Rally artifacts **at the old feed URL as well as the
  new one** until the fleet moves; userData migrates on first run. The CI
  rename guard lands.
- **Phase 3 — contributor surface.** Repository rename, packages, env vars
  and secrets, symbols, docs sweep, CI/sandbox/release tooling. Coordinated
  with (not inside) a deploy: Worker vars and `.dev.vars` rename with the
  code that reads them.
- **Phase 4 — long tail.** When release retention shows no supported build on
  the old forms: drop `avalon-*` header/subprotocol acceptance and the old
  feed URL, tighten the rename guard's allowlist to the permanent set (links,
  addresses, schemes, bundle id, storage literals, history). The redirects
  and email alias never leave.

## Acceptance

- A pre-flip work-stream link, pasted from a real Slack message, opens the
  right work stream through the redirect; its email address still reaches it;
  the Rally-domain twin of that address reaches it too. Both domains are
  proved against both row generations — a pre-flip row storing the old-domain
  address and a post-flip row storing the Rally one, for a work stream and
  for an automation.
- An installed Avalon build auto-updates to the Rally build and comes back
  signed in, with drafts, pins, and theme intact, app named Rally in Dock and
  menu bar; an `avalon://` auth link completes against the updated app.
- A new work stream mints a `withrally.ai` link and Rally-domain address; the
  agent's messages, digest emails, and exported cards say Rally; screenshots
  of every renamed screen captured per
  [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it).
- Old-generation headers, the old socket sentinel, and the `app://avalon`
  origin succeed against phase-1 Workers, as do their Rally counterparts —
  CORS preflight and every socket role from both exact origins, with
  suffix-lookalike origins still refused (proved in
  `apps/api/test-workers/`); the rename guard fails a seeded user-visible
  "Avalon" string and passes the allowlist.
- Post phase 3: fresh clone of `juno-ai-labs/rally` passes `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both Wrangler dry-run
  builds, and the desktop release invariants.

## Open questions

1. **Is the "Rally" name trademark-cleared?** The domain is settled
   (`withrally.ai`, bought); the name itself still wants a clearance check
   before phase 2 makes it public. Blocks phase 2, not phase 0–1 groundwork.
2. **New repository name — `rally`?** Assumed here. Blocks phase 3 only.
3. **Do the Slack directory listing or Notion public-integration re-reviews
   gate the callback/branding changes, and on what timeline?** May force
   phase 1's provider additions to start earliest of all.
4. **Does outbound email move to the new domain on flip day, or after a
   deliverability warm-up?** A cold sending domain can land digests in spam;
   the answer decides whether phase 2 sends from Rally immediately or keeps
   sending from the old domain briefly while the new one warms.
