# Canva connector

> Created 2026-09-17.
>
> Rally connects to Canva twice: a personal connection to Canva's hosted MCP
> server that gives a member their own design tools, and a workspace connection
> over the Connect APIs that brings design collaboration — comments, mentions,
> suggestions, approvals, shares — into work streams as activity a Sidekick can
> trigger on. Companions: [`design.md`](design.md) for the ingress, schemas, tool
> catalog and trigger manifest; [`research.md`](research.md) for what Canva's
> platform does and does not offer. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A Rally member connects their own Canva account and gets Canva's live tools in
any work stream — create a design, find one, export it, comment on it — the same
pass-through shape Fireflies, Granola, Slack and Notion personal connections
already use. Separately, an administrator connects the workspace, and Canva's
collaboration events start arriving: a comment on the launch deck, a mention, a
suggestion, an approval requested or answered, a design or folder shared. Those
become Rally activity, so they can be digested, watched on a work stream, and —
the reason this connector is worth building — used as a **trigger** for a
Sidekick that then acts back on Canva through a fixed set of reviewed tools.

What becomes possible that was not before: a Sidekick that answers a suggestion
on a specific deck, chases a stalled approval, triages a folder access request,
or builds and exports a launch kit from a brand template when a Linear project
ships. Today none of that is expressible, because Canva is not a connector and
design work is invisible to Rally.

## Motivation

Rally's connectors cover where work is *discussed* (Slack), *tracked* (Linear,
GitHub, Ashby), *written* (Notion, Google), and *recorded* (Granola, Fireflies).
Design work is the obvious hole: it is where the largest share of marketing and
brand output actually happens, it is intensely collaborative, and its
collaboration is already event-shaped — Canva emits comments, mentions,
suggestions, approvals and shares as webhooks, which is precisely the raw
material Rally's trigger engine consumes.

The cost of leaving it alone is that the loop stays manual in both directions. A
suggestion on a deck waits for someone to open Canva and see it; nothing in Rally
knows a design is blocked on an approval; and when a Sidekick has produced the
content for a launch, a person still has to make the graphic by hand. A connector
closes both: Canva becomes something Rally can hear and something it can act in.

**One honesty about this section.** The evidence a motivation is supposed to cite
— the support thread, the recurring request, the count — is not recorded anywhere
in this repository, and inventing one would be worse than naming its absence.
Whoever owns this decision should attach the demand evidence here before the PRD
is approved, or say plainly that the case is the structural one above.

The timing argument is separate and real: Canva's MCP access is gated behind a
review queue Rally does not control, and its webhook notifications are a preview
API that bars a *public* integration from review. Both are calendar items with
lead times, and both start the day someone applies. Deciding to build this later
is fine; applying later is what makes it later still.

## Goals

1. A member can connect their own Canva account and use Canva's live tool surface
   in a work stream, with no Canva tool catalog checked into Rally.
2. An administrator can connect the workspace and, from that moment, Canva
   collaboration events reach Rally as normalized activity.
3. Seven of Canva's eleven notification types are digestible, three are
   operational, and one is refused — each with a stated reason, and a refusal
   that names the event it refused.
4. A Sidekick rule can select Canva events by family, filter them by design,
   folder, actor, thread type, approval outcome and external-group involvement,
   and narrow itself to one named design or folder.
5. A Sidekick run can act back on Canva through a fixed reviewed tool set,
   including replying to the comment that triggered it and autofilling and
   exporting a brand template.
6. A webhook delivery that cannot be verified, cannot be parsed, or cannot be
   routed to a known tenant leaves no row in any workspace, and says which of
   those three it was.
7. An asynchronous Canva job that does not finish inside a tool call returns its
   job id and a next action that reads the job, never one that creates a second.

## Non-goals

1. **A workspace-level Canva credential.** Canva has none: every token on both
   platforms belongs to one Canva user. The workspace connection is one named
   Canva account acting for the workspace, the setup copy says so, and the
   uncertainty about what that account can see is stated rather than guessed —
   the posture Fireflies' copy already takes. Rejected outright; nothing to
   defer.
2. **Knowing that a design changed.** Canva publishes collaboration
   notifications, not content-change events. There is no `design.updated` to
   subscribe to, and Rally will not poll design lists to synthesize one. Deferred
   until Canva publishes such an event.
3. **A Canva browser inside Rally.** No design library, no asset browser, no
   searchable replica. `list_designs` exists to find the design a task names, not
   to be paged through. This is the zero-copy boundary in
   [`provider-apps.md`](../../provider-apps.md#the-zero-copy-connector-boundary).
4. **Rendering or storing Canva images.** Thumbnail URLs expire in 15 minutes and
   export URLs expire too; both are transient and neither becomes a resource's
   canonical URL. Deferred — durable design artifacts are their own question.
5. **Design imports, resizes, merges, analytics, asset deletion, folder deletion
   and brand template publishing.** All real Connect APIs, none with a named job
   to do yet. Deferred; each is a later tool definition, not a later redesign.
6. **`team_invite` events.** Ingested by nobody: the event names no design and no
   folder, so it has no Rally resource and cannot narrow a rule, and its
   recipient is often not a Rally member. Rejected outright.
7. **A public Canva integration.** Webhook notifications and the Keys API are
   preview, and Canva bars preview-using integrations from public review. Rally's
   integration is private until that changes. Deferred by the provider, not by us.
8. **Per-event subscription control.** Canva does not offer it; enabling
   `collaboration:event` enables all eleven types. Rally's only lever is
   disposition on arrival, and pretending otherwise in settings copy would
   mislead.

## Product behavior

### Connecting

Settings shows one **Canva** connector with the two connection cards the
catalog already renders.

- **Personal.** Any member may connect. The browser OAuth flow returns to the
  shared Canva callback host, and the connection reports its live tool count once
  activated. Empty state: the card offers Connect. Error state: an authorization
  that returns no refresh token marks the connection reconnect-required when its
  access expires, and says so — the Fireflies condition, handled the same way.
- **Workspace.** Owners and administrators only. The setup copy states, without
  hedging, that the connection acts as the connecting Canva account, sees what
  that account sees, and that every member of the Rally workspace can use it.
  One active workspace connection per Rally workspace; one active personal
  connection per member per workspace.

### Events arriving

Once the workspace connection exists and Canva's portal is pointed at Rally's
ingress, deliveries route by the Canva user and team in the payload. A member who
is matched to the recipient sees the activity attributed to them; an unmatched
recipient still produces workspace-scoped activity, because the design is the
workspace's even when the recipient is not a Rally member.

- **Digest.** The seven digestible types appear as one line each, naming the
  design or folder, the person, and — for a comment, suggestion or share with a
  message — a bounded snippet.
- **Watched work stream.** A work stream watching a `canva_design` or
  `canva_folder` receives its events as activity, with a link to `view_url`.
- **Operational types** never enter a digest and still trigger Sidekicks.
- **Offline / delivery failure.** Canva retries; Rally's ingress is idempotent on
  the notification id, and a redelivery answers `200` without a second activity.
  A delivery that arrives while Rally cannot reach the owning region fails with a
  `5xx` so Canva retries, which is the only backstop available — Canva exposes no
  delivery log to reconcile against.

### Sidekicks

In a Sidekick's authoring conversation, Canva appears as four event families —
design discussed, approval changed, design shared, folder shared — with filter
fields for design, folder, actor, thread type, approval outcome and whether an
external group responded. A rule may name one design or one folder. On a run, the
Sidekick holds the workspace tools and can reply to the thread that triggered it.

## Impact on the product contract

None. This adds a connector within the existing contract: a connection with two
scopes, normalized activity, work-stream-scoped delivery, and typed tools under
existing authorization. It introduces no channel, no global inbox, no global
search, and no tool-confirmation step — Canva's writes execute within existing
authorization like every other connector's, per the tool execution policy in
`CLAUDE.md`.

One clause is worth checking explicitly because it looks close: a design shared
with one member does not create a private surface. Canva activity is
workspace-scoped, and the audience rules in
[`connectors.md`](../../connectors.md#a-work-streams-audience-is-the-conversation-it-started-in)
apply unchanged.

## Decision log

None yet.

## Key design decisions

1. **The webhook URL is shared, and Notion's ingress is the precedent.** Canva
   allows one webhook URL and one redirect URI set per integration, for every
   Canva team. So `canva.rallywith.ai` binds to the Global Worker and hands each
   callback and delivery to the owning region, exactly as
   [`notion-ingress.md`](../../notion-ingress.md) does. *Rejected:* one Canva
   integration per Rally region. It doubles the manual portal work, and a private
   integration is bound to one Canva Enterprise team anyway.
2. **A delivery's tenant comes from the payload, and an unroutable one is
   refused.** `content.receiving_team_user` (`user_id`, `team_id`) resolves
   against a Global routing directory. No match is `404` with no row written.
   *Rejected:* inferring the tenant from anything else, or defaulting to the sole
   connection when only one exists — a default that works while there is one
   customer is a cross-tenant leak the day there are two.
3. **`canva_design` is a bindable container, not a leaf.** Comments, mentions,
   suggestions and approvals happen *inside* a design the way they happen inside
   a Notion page, and both declared resource types materialize on every ingested
   delivery. *Rejected:* declaring only `canva_folder`, which would make a rule
   unable to say "this deck" — the single most natural thing a person wants to
   say.
4. **Seven digestible, three operational, one refused.** Access requests and a
   system-generated approval invalidation are real and worth triggering on, and
   are not news. `team_invite` has no Rally resource at all. *Rejected:*
   ingesting everything, which puts account administration into a design digest.
5. **One async-job primitive, declared over.** Six Connect families are
   create-then-poll with no idempotency key, so the connector gets one
   `runProviderJob` helper and each job tool is a declaration. *Rejected:*
   writing the poll loop per tool, which is where a retry quietly creates a second
   design.
6. **Fixed reviewed tools for the workspace scope, pass-through for personal.**
   The split every two-scope connector already has: the personal scope's catalog
   is `tools/list` and is never checked in; the workspace scope's is small,
   reviewed, and bounded.
7. **No hydration inside the acknowledgement window.** Canva's payload already
   carries the design's title, URLs and thumbnail, so nothing is fetched on the
   delivery path. `hydrateResource` re-reads current state when something later
   asks.

## Data model

- `canva_connection_routes` in **Global** D1: `(canva_team_id, canva_user_id)` →
  region and connection id. Written on workspace authorization, deleted on
  disconnect. Nothing else in Global.
- Connector rows, encrypted credentials, ingress receipts, payload storage,
  activity and resources all use the existing regional and WorkspaceDO tables; no
  new regional table.
- Resource types `canva_design` and `canva_folder` are added to the resource type
  registry. No backfill: there is nothing to backfill.

## Regional impact

The callback and the ingress are Global; everything else is regional. The
plaintext of a delivery crosses from the Global Worker to the owning region over
the authenticated internal binding and comes to rest only there — payload
storage, activity, and resources are all regional. Global holds the routing
directory and nothing else: no payloads, no credentials, no design content. Read
[`regionalization.md`](../../regionalization.md) before changing that split.

## Security and trust model

- **Verification is Canva's rotating Ed25519 JWKS** from the public
  `GET /rest/v1/connect/keys`, cached, `kid`-selected, refetched only on an
  unrecognized key and rate-limited so an attacker cannot use unknown `kid`s to
  aim Rally at Canva. **The exact signature envelope is unresolved in Canva's
  published documentation and must be observed live before verification code is
  written** — see [`research.md`](research.md#verification). This is the one open
  item that can invalidate a piece of the design.
- **Order is the security property.** Verify, then freshness, then parse, then
  route, then receipt, then forward. Nothing writes before routing succeeds.
- **One ingress, many tenants.** The shared URL is the highest-risk thing in this
  change: a routing mistake is a cross-tenant leak, not a bug. Coverage in
  `test-workers/` proves a delivery for team A never produces a row in workspace
  B, and that an unknown team produces no row at all.
- **Untrusted content.** Comment text, share messages and display names are
  provider-controlled and reach the model. They are bounded, truncation-flagged,
  and carry no authority — a comment asking the Sidekick to do something is a
  comment, and the harness's existing treatment of provider payloads applies.
- **Credentials.** Client secret and per-connection tokens are encrypted at rest
  with connection-ID additional authenticated data, never returned to the
  desktop, never in routing metadata, never logged. Canva's own guidance to store
  access and refresh tokens separately from each other is noted and is not how
  Rally's existing scheme works; the deviation is deliberate and recorded here
  rather than silently ignored.
- **Scopes requested are the minimum for the events and tools named**, and
  include `folder:permission:write` for one reason only: Canva requires that
  write scope to *receive* folder access request notifications. That is a write
  scope held for a read, and it is the kind of thing a reviewer should see stated.

## Agent behavior

The workspace connection's tools are catalogued in
[`design.md`](design.md#6-workspace-tool-catalog) with modes, idempotency
classes, endpoints and the full failure vocabulary; the personal connection's are
whatever `tools/list` returns and are never enumerated in source. Both follow
[`agent-tools.md`](../../agent-tools.md): every parameter described, unknown
fields rejected, one provider page per call with the cursor exposed, and every
error sentence carrying the shortest safe next action. The one that matters most:
a timed-out job returns its job id and instructs the model to read the job, never
to create another, because Canva offers no idempotency key and a blind retry
produces a second design.

What the agent still may not do: delete Canva content, publish brand templates,
or act on a personal connection belonging to anyone but its owner.

## Provider configuration

Outside the repository, in this order:

1. **Apply to Canva's MCP waitlist** for the personal connection's redirect URI.
   Nothing about the personal scope can be built past OAuth discovery until this
   is granted, and the queue is Canva's.
2. **Create a private integration** in the Canva Developer Portal (requires MFA
   on the Canva account, and a Canva Enterprise plan for private use). Record the
   client ID; generate and store the client secret as a regional Worker secret.
3. **Set scopes**: `design:meta:read`, `design:content:read`,
   `design:content:write`, `folder:read`, `folder:write`,
   `folder:permission:write`, `comment:read`, `comment:write`, `asset:read`,
   `asset:write`, `brandtemplate:meta:read`, `brandtemplate:content:read`,
   `collaboration:event`, plus `profile`/`email` for identity.
4. **Enable `collaboration:event`** under Notifications and set the webhook URL to
   the shared ingress.
5. **Add the shared redirect URI.**

If step 4 is not applied, the workspace connection's tools work and no event ever
arrives — the connection reports healthy with a warning naming that condition,
the way Granola's does, because a health check must not claim a delivery path it
cannot see. Registration, rotation and removal are all manual: the adapter
declares create, update, remove and rotate **manual**, and inspect and reconcile
**unsupported**, per
[`connector-installation-lifecycle.md`](../../connector-installation-lifecycle.md).

The settings and portal steps belong in
[`provider-apps.md`](../../provider-apps.md) in the change that registers them,
with the date each observation was made.

## Rollout

Both scopes are gated region by region on the non-secret
`CANVA_CONNECTOR_ENABLED` variable, following Fireflies exactly: unset, the type
is absent from the catalog and creation is refused, while any existing rows are
retained and inert. This is the precedent for a connector whose availability is
an operational fact per region, not an audience-targeted product flag — but the
question *"does this ship behind a Flagship flag instead"* is the product owner's
to answer, and it is recorded as unanswered in Open questions rather than decided
here.

Phased, if a `plan.md` is written after approval: the workspace read tools and the
connection first, then the ingress and events, then the job-based writes, then the
personal pass-through — which is last only because its calendar is Canva's.

Turning it off is unsetting the variable; deliveries then refuse and nothing is
lost that Canva will not retry.

## Acceptance

1. A member connects personally and a work stream lists Canva tools that were
   never checked into the repository.
2. An administrator connects the workspace; `list_designs` returns designs and
   `get_brand_template_dataset` names a template's fields.
3. A real comment on a real design in Canva reaches a Rally work stream, naming
   the design and quoting the comment.
4. The same delivery replayed produces no second activity.
5. A delivery for a Canva team with no Rally connection produces no row anywhere,
   and the refusal names `unrouted_delivery`.
6. A `team_invite` delivery is refused with `unsupported_webhook_event:
   team_invite`.
7. A Sidekick with a rule naming one design and `threadType equals suggestion`
   runs on a suggestion to that design, and not on a comment to another.
8. That Sidekick's run replies on the Canva thread, and the reply is visible in
   Canva.
9. `autofill_brand_template` produces a design; a call that reaches the poll
   ceiling returns the job id and the instruction to read it.

## Open questions

- **What is Canva's webhook signature envelope?** Header names, and whether the
  body is a signed JWT or JSON with a detached signature. Blocks the ingress.
  Answered by one observed delivery, not by more reading.
- **What does `design_approval_requested` actually contain?** Its documentation
  page publishes no property list. Blocks freezing that one schema; everything
  else can proceed.
- **Does Rally hold, or can it obtain, a Canva Enterprise plan?** A private
  integration requires one, and a public integration is barred while webhooks are
  preview. If neither is available, the workspace scope cannot ship at all and
  this PRD narrows to the personal connection. This is the largest single risk in
  the document.
- **Does Canva's MCP authorization server issue refresh tokens, and does it
  publish `offline_access`?** Decides whether a personal connection renews or
  must be reconnected.
- **Flag or regional variable?** Recorded above as the regional variable by
  precedent; the product owner's answer replaces this line either way.
- **The numbers in [`design.md`](design.md#7-limits-to-be-set-not-guessed)** —
  freshness window, JWKS cache TTL and refetch floor, job poll ceiling and
  backoff, page-size ceilings, string caps. Each guard is written open and each
  number is the team's.
