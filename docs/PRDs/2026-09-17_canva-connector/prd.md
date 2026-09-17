# Canva connector

> Created 2026-09-17.
>
> A Rally member connects their own Canva account and gets Canva's live design
> tools in any work stream. One connection scope, personal, over Canva's hosted
> MCP server. Companions: [`design.md`](design.md) for the authorization
> mechanics, the tool surface and its limits; [`research.md`](research.md) for
> what Canva's platform offers, what was measured against it live, and why the
> workspace scope was dropped. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A member connects their own Canva account from Settings and, from then on, can
ask Rally to do design work in any work stream: find a deck, read what is on it,
generate one from a brief, edit it, comment on it, export it, upload an asset.
The tools come from Canva's hosted MCP server and are never copied into Rally —
the same pass-through shape Fireflies, Granola, Slack and Notion personal
connections already use.

This is a **tools-only connector**. Canva sends Rally nothing: no events, no
triggers, no digest rows. A Sidekick can *use* Canva — as the hands at the end of
work that something else started — but nothing that happens in Canva can start
one. That is a deliberate narrowing, and the cost of it is stated in Non-goals 1
and 2.

## Motivation

Rally's connectors cover where work is discussed, tracked, written and recorded.
Design work is the hole. A member who wants a launch graphic, a resized social
asset, or a PDF of the deck they just discussed has to leave Rally, do it by
hand, and come back — even when Rally already holds the content that should go
in it.

The personal MCP connection is the cheapest possible way to close that. Canva's
server is the authority on its own tools, so Rally ships no catalog and no
provider client to maintain. There is no administrator to involve, no plan to
buy, no webhook to register, and no credential for anyone to paste. It is one
OAuth flow and a pass-through the codebase already has.

**One honesty about this section.** The evidence a motivation is supposed to cite
— the support thread, the recurring request, the count — is not recorded anywhere
in this repository, and inventing one would be worse than naming its absence.
Whoever owns this decision should attach the demand evidence here before the PRD
is approved, or say plainly that the case is the structural one above.

The timing argument is separate and measured rather than assumed. Reaching
Canva's MCP server from Rally's own domain requires Canva to allowlist the
redirect URI, and the only route to that is a reviewed waitlist on a calendar
Rally does not control. That was confirmed live on 2026-09-17, not inferred from
the documentation — see [`research.md`](research.md#the-live-probe-2026-09-17).
Deciding to build this later is fine; applying later is what makes it later
still.

## Goals

1. A member can connect their own Canva account and use Canva's live tool
   surface in a work stream, with no Canva tool catalog checked into Rally.
2. Before authorizing, the member is told plainly that Canva grants Rally full
   read *and write* access to their designs, folders, assets and brand kit,
   because Canva offers no narrower consent.
3. The connection renews itself without the member reconnecting, for as long as
   Canva's refresh token lasts.
4. A Sidekick owned by that member can hold the Canva tools and use them as
   actions within a run.
5. The connector declares **no** activity triggers, so no Sidekick is ever built
   on a Canva event that cannot arrive.
6. Rally either reaches Canva's MCP server from a redirect Canva accepts, or the
   connector stays absent from the catalog — never present and silently
   unauthorizable.

## Non-goals

1. **A workspace connection.** Cut deliberately, by the product owner, on
   2026-09-17: the setup is too complicated to ask a customer to do. It would
   require an administrator to create their own Canva developer integration with
   MFA, tick thirteen scopes, paste a client ID and secret into Rally, paste a
   Rally-issued URL back into Canva's portal, hold a Canva Enterprise plan, and
   then get someone to comment on a design to prove any of it worked. The
   research that costed it is kept in [`research.md`](research.md) so the next
   person does not repeat it. Deferred, not rejected outright — the thing that
   would change the answer is Canva shipping either a team-level credential or
   programmatic webhook management.
2. **Canva events, triggers, digests and watched Canva resources.** All of them
   follow from Non-goal 1: Canva delivers webhooks only to a registered
   integration, which is the thing being cut. Deferred with it. The consequence
   is that Canva can never *start* a Sidekick, only be used by one, and that is
   the single biggest thing this connector does not do.
3. **The Connect REST APIs, in their entirety.** Designs, folders, comments,
   brand templates, autofill, exports, assets, analytics, imports, resizes and
   merges are all reachable through the MCP server for a personal connection.
   Building a second path to the same capabilities would be two implementations
   of one thing. Rejected outright for this scope.
4. **Least-privilege scopes.** Canva ignores the scopes an integration requests
   and grants all sixteen. Measured, not assumed. Rally cannot offer a narrower
   connection, and will not imply one. Rejected because it is not ours to
   decide.
5. **A Canva browser inside Rally.** No design library, no asset browser, no
   searchable replica. The tools exist to do the task a person named, not to be
   paged through. This is the zero-copy boundary in
   [`provider-apps.md`](../../provider-apps.md#the-zero-copy-connector-boundary).
6. **Storing or rendering Canva images.** Thumbnail and export URLs expire.
   Rally passes them through as transient and stores none of them. Deferred —
   durable design artifacts are their own question.
7. **An organization-level connection.** Canva does not support one; its own
   documentation says there is no service account and each user must authenticate
   individually. Rejected by the provider.

## Product behavior

### Connecting

Settings shows a **Canva** connector with one card, personal, available to any
member. One active Canva connection per member per workspace.

- **Empty state.** The card offers Connect, and states what connecting grants —
  see below.
- **Connecting.** Clicking Connect opens the member's browser at Canva. They log
  in, approve, and land back in Rally with the connection active and its live
  tool count shown.
- **The consent disclosure is the part that needs care.** Canva grants all
  sixteen of its scopes regardless of what Rally asks for, including write access
  to designs, folders and assets. The card says so before the member clicks, in
  plain words: *connecting lets Rally read and change your Canva designs,
  folders, assets and brand kit.* Anything softer would be false.
- **Error state.** An authorization Canva refuses reports the refusal; a
  connection whose refresh has stopped working reports reconnect-required. A
  member who is not signed into Canva simply signs in.
- **Disconnecting** revokes at Canva and removes local access immediately.

### Using it

In any work stream, the member can ask for design work and the model holds
Canva's live tools. Around thirty of them, covering discovery, generation,
editing transactions, comments, folders, asset upload, export and resize.

- **Plan-gated tools fail at the provider, honestly.** Autofill and brand
  template datasets are Enterprise-only; brand templates, brand kits and resize
  are Pro and above. Rally does not pre-screen for plan — it has no field that
  reports one reliably, and the provider decides per call. A refusal carries
  Canva's own reason, which is accurate in a way a cached plan check could never
  be. This is the judgement the X connector's balance check already settled.
- **Rate limits are Canva's**, per tool per minute, and a limit reached is
  reported as such with the provider's wait.
- **Editing is transactional.** Canva's editing tools open a transaction, apply
  operations, and commit or cancel. A run that opens one and fails must not leave
  it open, so a cancelled or abandoned transaction is cleaned up rather than
  left dangling.

### Sidekicks

A Sidekick owned by the connecting member can bind the connection and use its
tools — a personal connection may be bound by its owner or the run-as principal.
So a Sidekick triggered by a Linear project shipping, or by a schedule, can build
and export the assets for it.

**No Canva trigger is ever offered**, because there is none. The connector
declares zero activity triggers, which is what stops the drafting model from
building a Sidekick on events that can never arrive and leaving it silent
forever — the failure that Granola and Fireflies personal connections already
produced once, and that
[`automation-lifecycle.md`](../../automation-lifecycle.md) records the fix for.

## Impact on the product contract

None. A personal connector with a live tool surface is the shape the contract
already describes: tools under existing authorization, available only to their
owner, with no new surface, no channel, no global inbox, and no tool-confirmation
step.

## Decision log

None yet.

## Key design decisions

1. **Pass-through, with no catalog in source.** `tools/list` is the only
   authority on what Canva offers. Canva's published tool list was read during
   research and is deliberately not enshrined; it had already changed between two
   of its own documentation pages while this PRD was being written.
2. **Apply for the waitlist and build against a server redirect; treat loopback
   as the fallback, not the plan.** Canva enforces its allowlist on the redirect
   URI's *host* at `/authorize`, returning a bare `400 Invalid redirect URI.`
   Loopback (`localhost`, `127.0.0.1`) is unconditionally accepted, so a
   desktop-driven authorization would work today with no approval at all. It is
   the fallback rather than the plan because it only works where Rally runs a
   local process: the iOS client could never use it, and neither could a browser
   session. *Rejected:* shipping loopback-only, which would build the connector's
   authorization on the one client it cannot generalize from.
3. **Zero declared triggers, stated in the adapter.** Not an omission — a
   declaration, for the reason in Product behavior.
4. **The consent breadth is disclosed before the click, not after.** Canva grants
   sixteen scopes whatever Rally requests. *Rejected:* requesting fewer scopes to
   make the card read better, which changes nothing about what is granted and
   makes Rally's own copy misleading.
5. **No pre-screening on Canva plan.** The provider's per-call refusal is the
   accurate answer. *Rejected:* reading a plan at activation, which is the X
   connector's balance mistake in a different costume.
6. **Refresh is expected to work, so the connection is not designed around
   reconnection.** Canva's authorization server publishes `refresh_token` among
   its grant types and does not publish `offline_access`, so refresh is granted
   by default rather than scope-requested — measured live. Unlike Fireflies, this
   connection should renew itself. It still reports reconnect-required if refresh
   fails, because a measurement is not a guarantee.

## Data model

Nothing new. The connection, its encrypted tokens, and its activation row use the
existing connector tables. No resource types, no ingress receipts, no payload
storage, no routing directory, no migration.

## Regional impact

None beyond the ordinary. Authorization and tokens stay in the region that
started the attempt, and MCP calls are made from that region. There is no shared
ingress, no Global state, and nothing crossing a regional boundary — the whole
class of problem that the dropped workspace scope would have introduced.

If the loopback fallback is used, the code is captured on the member's machine
and handed to their own region for exchange; no token is ever held by the
desktop.

## Security and trust model

- **Connecting grants sixteen scopes, including write.** `design:content:write`,
  `folder:write`, `comment:write`, `asset:write`, `brandkit:read` and the rest
  are granted whatever Rally requests. This is the trust surface of the whole
  connector and it is not negotiable, so it is disclosed rather than minimized.
- **Tokens** are encrypted at rest with connection-ID additional authenticated
  data, never returned to the desktop, never logged, never in routing metadata.
- **Canva's allowlist is partner identification, not a security boundary.** It
  matches host with any path, and Canva uses it to tag clients by name. Rally
  should not reason about it as protection for anything.
- **An unknown or revoked client ID returns `500`**, not a 400-class error, so a
  revoked Rally registration surfaces as an opaque server error unless it is
  handled deliberately. Measured live.
- **If loopback is used**, the local listener binds to a loopback address on an
  ephemeral port, accepts exactly one code for one attempt with PKCE, and closes.
  It is never a general local HTTP surface.
- **Untrusted content.** Design titles, comment text and anything else Canva
  returns is provider-controlled, reaches the model, is bounded, and carries no
  authority.

## Agent behavior

The tool surface is Canva's and is discovered live; it is described in
[`design.md`](design.md#the-tool-surface) at the level a reviewer needs, with
its rate limits and plan gating, and is not enumerated in source. Rally's
pass-through applies its own safety classification, serial execution for writes,
durable receipts and uncertain-outcome handling; remote annotations never lower
that policy. Rally never asks the member to confirm a tool call.

The one behavior worth naming: Canva's editing tools are transactional, so a run
that starts an editing transaction owns closing it.

## Provider configuration

1. **Apply to Canva's MCP waitlist** with the redirect URI Rally will use. This
   is the blocking item, it is a reviewed application, and it needs someone who
   can speak for Juno Labs. Nothing about a server-side redirect works until it
   is granted — confirmed live, not inferred.
2. **Decide the client identity**: CIMD, which means publishing a client metadata
   document at an HTTPS URL and holding no client secret, or DCR, which Canva
   documents as deprecated but still serves. CIMD is the recommendation.
3. **No Developer Portal integration, no client secret, no scopes to tick, and no
   webhook URL** — all of that belonged to the workspace scope and is gone with
   it.

Whatever is registered goes into [`provider-apps.md`](../../provider-apps.md) in
the change that registers it, with the date each observation was made.

## Rollout

Gated region by region on the non-secret `CANVA_CONNECTOR_ENABLED` variable,
following Fireflies: unset, the type is absent from the catalog and creation is
refused, while any existing rows are retained and inert. This is the precedent
for a connector whose availability is an operational fact per region rather than
an audience-targeted product flag — and here it is doing real work, because the
connector must stay absent until a redirect Canva accepts exists (Goal 6).

The question *"does this ship behind a Flagship flag instead"* is the product
owner's to answer and is recorded as unanswered in Open questions.

Turning it off is unsetting the variable.

## Acceptance

1. A member connects and a work stream lists Canva tools that were never checked
   into the repository.
2. The connect card states the write access being granted, before the click.
3. `search-designs` returns that member's designs; `export-design` produces a
   file; `generate-design` produces a design from a brief.
4. A tool the member's Canva plan does not cover fails with Canva's own reason,
   not with a Rally-side plan check.
5. The connection survives access-token expiry without the member reconnecting.
6. No Canva trigger is offered anywhere in Sidekick drafting, and a rule naming a
   Canva event is refused naming the scope.
7. A Sidekick owned by that member exports a design inside a run.
8. With `CANVA_CONNECTOR_ENABLED` unset, the connector is absent from the catalog
   and creation is refused.

## Open questions

- **Who submits the waitlist application, and when?** It is the only blocking
  item for the primary path, it cannot be done from inside this repository, and
  the review has no published turnaround.
- **Does the desktop OAuth handoff already support a loopback listener**, or is
  that new work? Decides whether the fallback is cheap or is a project of its
  own.
- **Does CIMD bypass the redirect-host allowlist?** Inconclusive from the live
  probe — it could not be tested without hosting a client metadata document on a
  domain we control, and an unfetchable one returns the same opaque `500` as a
  nonexistent client. If it does bypass it, the waitlist stops being blocking and
  decision 2 changes entirely. **Worth testing before anyone fills in the form.**
- **Are Canva's rate limits per user or per client?** Undocumented. Matters only
  if many members connect and their limits turn out to share a bucket.
- **Flag or regional variable?** Recorded above as the regional variable by
  precedent; the product owner's answer replaces this line either way.
- **The numbers in [`design.md`](design.md#limits-to-be-set-not-guessed)** — MCP
  call timeout, response caps, editing-transaction cleanup delay. Each guard is
  written open and each number is the team's.
