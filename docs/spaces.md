# Spaces

A **Space** is how an Organization groups its Channels. It carries a name, an
icon and colour, a personal or Organization-wide audience, resources and
Sidekick recommendations, and every Channel in the Organization belongs to at
least one. A Channel may belong to several at once; each is a *placement* of the
same Channel rather than a copy, so opening any of them opens the same
transcript.

A Space is not a second container implementation. It is Rally's work-stream
primitive under a role: `SpaceDO` is `WorkstreamDO` with the differences
enumerated as fields (`docs/workstream-durable-object.md` owns that), and its
hidden main conversation holds its participants and resources exactly as a
Channel's does. What makes it a Space is that nothing in the product opens that
conversation — no feed, no transcript, no agent loop, no search result.

Spaces replace [Projects](projects.md). This document describes the Space
authority, its service, and the routes over them; the product design is in
[the Spaces PRD](PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/spaces.ts` | Space ids, the appearance registry, scope, status, system role, summaries, request shapes, `ChannelAccessSources`, and the closed `SpaceErrorCode` union. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | WorkspaceDO's Space tables (migration 61) and the synchronous transactions over them, including the `SPACE_CHANNEL_PAGE_SIZE` page bound. |
| `apps/api/src/durable-objects/workspace-space-protocol.ts` | Strict RPC requests and results, the Queue message shapes, and the `kind` that makes a resource and a Sidekick default one mechanism. |
| `apps/api/src/durable-objects/workspace-do.ts` | The authenticated Space RPCs, the Space branch of `applyWorkstreamDirectoryEffects`, `publishSpaceSnapshot`, the sidebar payload, and the two alarm phases. |
| `apps/api/src/durable-objects/fenced-target-publication.ts` | The claim/send/accept publisher both the Project and the Space default publishers call. |
| `apps/api/src/durable-objects/workspace-space-default-publication.ts` | The Space's two arguments to it: default targets, and unsettled intent resumes. |
| `apps/api/src/services/space-service.ts` | Creation, presentation, audience, membership, archive, restore, defaults, and the resume of an interrupted operation. |
| `apps/api/src/services/channel-access-service.ts` | The one seam a Space reaches a Channel's audience through. `docs/spaces.md` never writes an audience itself. |
| `apps/api/src/routes/spaces.ts` | `/spaces` mutations and the two paginated reads. |
| `apps/api/src/queues/activity-consumer.ts` | The `space_default` and `space_intent_resume` handlers. |
| `packages/ui/src/components/space-row.tsx`, `space-appearance-picker.tsx`, `space-dashboard.tsx`, `space-icons.ts` | The shared presentation both hosts draw a Space with. `docs/shared-ui.md` owns the split. |
| `apps/desktop/src/renderer/components/space-sidebar-section.tsx` | The **Spaces** section: rows, placements, drag, reorder, **New space**, restore, and the Organization-opening card. |
| `apps/desktop/src/renderer/screens/space-dashboard.tsx` | The `/spaces/:spaceId` dashboard. |
| `apps/desktop/src/renderer/components/manage-access-dialog.tsx` | **Manage access**: `GET /workstreams/:id/access`, rendered as one union of sources. |
| `apps/desktop/src/renderer/lib/sidebar-list-store.ts`, `use-space-directories.ts`, `workspace-socket.tsx`, `workspace-directory-cache.ts` | The client's Space state: one versioned receiver, the two socket-owned directories, `spacesReady`, and the local cache slice. |

## How it works

### Three authorities, in one order

A Space is the agreement of three objects, and `SpaceService` is where that
agreement is ordered.

**WorkspaceDO owns the relationship.** It holds the Space directory projection,
each person's Space order, the many-to-many Channel memberships with their
staged generations, the default registry and its delivery targets, the staged
operation intents, and the General identity. Neither endpoint of a membership
can answer whether a Channel has *another* Space, so the invariant that every
Channel has a home lives here and nowhere else.

**The Space's own object owns what the Space is.** Its name, appearance, scope,
participants and attachments are written on `SpaceDO` and its hidden main
conversation, and reach WorkspaceDO as the same `directory_common` and
`directory_user` effects a Channel publishes — routed by parent kind in
`applyWorkstreamDirectoryEffects`.

**Each Channel owns its own audience.** A Space never writes one. Every
membership, audience change, archive and restore goes through
`ChannelAccessService`, which asks the Channel's own authority for the delta its
provenance implies and applies it through the Channel's canonical scope and
participant operations — where the retained-content containment preflight and
its SQL triggers already run.

### Creating a Space

`SpaceService.create` reserves the Space in WorkspaceDO first, so the id is the
Organization's and a failure has something to undo. The reservation writes a
directory row at **source version zero**; every real projection is version one
or higher, so the Space's own first `directory_common` effect supersedes it
under the ordinary generation-then-version fence instead of colliding with it at
the same version under a different payload hash.

It then provisions the object: the same D1 anchor and `workstream_authority_routes`
row a Channel's creation writes, under `parentKind: "space"`; `reserveChild("0",
kind: "main")` on the `SpaceDO`, which enqueues and synchronously delivers the
provisional directory projection; `provisionWorkstreamObject` for the
conversation's title, scope and creator — **with no opening message and no run
admitted**; and finally the appearance, through the same writer a Channel's icon
and colour go through. Any failure cancels the reservation, so nothing ever
renders a Space whose object never opened.

### Membership

Adding a Channel is staged. `prepareSpaceMembership` writes a `joining` row and
returns the Space and the membership generation; `ChannelAccessService.applySpaceSource`
applies the audience that membership implies; `finalizeSpaceMembership` activates
it, re-reading both the Space revision and the membership generation, and stages
every current default for the new member. A membership is invisible until it is
finalized — no summary counts it and no page lists it — because a placement whose
readers have not been granted anything must not reach a client.

Removing one is the same shape in reverse, with two refusals in front of it.
`space_membership_final` is the invariant that every Channel has a home.
`space_audience_incompatible` is the weaker one that also has to hold: a reader
who keeps access through some other source must still be able to *find* the
Channel, which means discovering one of the Spaces it stays in. The service
computes the remaining audience from the Channel's own access sources with this
Space taken out, because WorkspaceDO cannot see a Channel's direct source.

### Audience

Changing a Space's audience is preflight, accept, converge.

Every member Channel is asked first, through the read-only
`previewAudienceContainment` RPC, whether its retained content would still be
contained. Widening cannot be undone — somebody may have read — so discovering a
fence on the fourth Channel after three are already wider is not a failure
anybody can recover from. The preflight is an early-out and not the fence: the
fence is the canonical operations, which run the same predicate inside the
transaction that changes the audience.

The Space's own authority then accepts the change, which advances the revision
every staged membership is fenced on and stages an `audience` intent.

Each member Channel then converges by **retract-then-apply**.
`audienceSourceApplicationPlan` only widens and seats — by construction, because
a source that could narrow would be able to revoke access another source still
supplies — so re-applying a shrunken roster would leave the readers it no longer
names seated with nothing accounting for them. Withdrawing the source first is
what takes them out, and the retraction plan seats every surviving reader before
it narrows anything.

### Defaults

A resource and a Sidekick recommendation are one mechanism with two consumers,
keyed by `kind` through every row and every message. `addDefault` attaches the
thing to the Space's own authority — the attachment a person sees — after
checking that every effective reader can reach it, then registers it in
WorkspaceDO, which is what stages, fences and settles delivery. Targets are
published through the outbox onto the activity Queue; the consumer rechecks the
default generation, the membership generation and the Space's lifecycle before
attaching through `WorkstreamService.attachResource` or
`setSidekickRecommendation`.

Removing a default advances its generation, which makes every queued target
stale. It does **not** detach it from Channels that already have it: a Channel's
transcript and execution context were built with it.

### General

`ensureGeneralSpace` reserves the Organization's one General Space — named
General, Organization-wide, `system_role = 'general'` — or answers with the
existing one. It is idempotent, and the unique partial index on `system_role` is
what decides a race between two callers rather than a check-then-write.

**It reserves; it does not provision.** Opening the object is the caller's, the
way it is for any other reservation, and nothing in this phase calls it: the
cutover and the creation paths that need General are Phase 4 and Phase 5 of
[the plan](PRDs/2026-09-18_spaces-and-product-hierarchy/plan.md). A caller that
reserves General without then provisioning its object leaves a Space in every
member's sidebar that answers nothing, exactly as a cancelled `create` would.

### Resuming an interrupted operation

Every cross-object Space operation stages an intent in WorkspaceDO before it
touches another object. A request that dies between the two leaves that intent
`pending`, and nothing else would notice — the caller is gone and the Channel was
never asked. The WorkspaceDO alarm claims unsettled intents, advancing their
retry gate before the send, and republishes them as `space_intent_resume`
messages; the consumer re-runs the same steps as the requester, against the
fences the intent recorded. A redelivery is safe because those steps are
idempotent deltas and the settlement refuses a generation or revision that has
moved.

### Reads

Space state comes down the workspace socket, not over HTTP. The connect payload
carries `spaces` — both directories at one waterline, shaped for the viewer —
and `spacesReady`, and every Space write republishes the same pair to every
subscribed socket. There is deliberately no `GET /spaces`: a client that fetched
one would hold a second answer to a question the socket already answers, and the
two would disagree across a mutation.

The two exceptions are paginated and therefore cannot ride the socket: a Space's
member Channels (`GET /spaces/:id/channels`) and a Channel's access sources
(`GET /workstreams/:id/access`).

### The desktop surfaces

The sidebar's **Spaces** section sits where Projects were and is drawn in every
shell, the conversation-only one included: every Channel belongs to at least one
Space, so a sidebar without it cannot say where anything lives. General is in the
directory like any other Space and the section has no case for it.

A placement is not a copy. The rows under an expanded Space are the Channel list
the sections below already render, filtered by the Channel's own `spaceIds`, and
they go through the same row — so a Channel in two Spaces is one record shown
twice, with one unread state, one running state and one destination. That is why
`spaceIds` travels on the *common* half of `workspace_workstream_state`: it is
the Organization's fact about the Channel, not the reader's, and WorkspaceDO
republishes the row after every membership settlement.

A Space's own count, not this device's page of the directory, is the authority on
how many Channels it holds. The sidebar holds one page of the Organization, so an
expanded Space lists what it has and says how many more the dashboard would show.

**Manage access** replaces **Make private**, because a row cannot say whether a
Channel is private: its readers are the union of its own scope and every active
Space that holds it. The dialog reads `GET /workstreams/:id/access` and renders
the Channel's own provenance and the Organization's memberships as one union —
they agree in the steady state and disagree exactly while an operation is in
flight, which is the thing it exists to show. Its copy table is exhaustive over
the closed `SpaceErrorCode`, so every refusal names what has to change first.

While `spacesReady` is false the sidebar section and the dashboard show the
Organization-opening card *instead of* the hierarchy, and the **New space**
control is not drawn: a Space directory missing General, or a Channel with no
Space, is not a state any surface may render, and creation is refused with
`space_bootstrap_pending` anyway. The flag is optional on the wire and read as
ready when absent, so a client talking to a server without the cutover is not
permanently opening.

## Invariants

- **WorkspaceDO is the sole Space relationship authority.** Copying membership
  into a child object or D1 would give two objects an answer to "does this
  Channel have another Space", which is the question both the final-membership
  and the archive refusals turn on.
- **Every Space RPC rechecks active Organization membership and refuses a
  guest.** Guest access to Spaces is deferred; a guest holds explicit Channel
  grants and no Organization-wide discovery, so admitting one would put every
  Organization-wide Space in their sidebar.
- **A membership is invisible until it is finalized.** A `joining` row is not
  counted, not listed, and not on the snapshot. Publishing one before its
  audience was applied would show a placement to people who were granted
  nothing.
- **Every staged operation is fenced on the Space revision and the membership
  generation it was staged against, and both are re-read at settlement.** An
  external await can interleave; a finalize whose Space moved is refused with
  `space_revision_conflict` rather than publishing a placement granted from an
  audience that no longer exists.
- **No Channel audience is written outside `ChannelAccessService`.** That seam
  applies every delta through the Channel's canonical operations, which is where
  the retained-content containment preflight and its SQL triggers run. A second
  writer would be a second place an audience could widen without the fence.
- **A source only ever widens.** The effective audience is the union of the
  Channel's direct source and every active Space source, so one Space cannot
  revoke what another supplies. Narrowing is expressed as a *retraction* of one
  source, never as a smaller application of it.
- **Every non-deleted Channel has at least one active Space.** Removal from the
  last one, and an archive that would produce one, are refused.
- **A reader who keeps access must keep a way to find it.** After a retraction,
  every remaining reader has to be able to discover one of the Spaces the
  Channel stays in — an Organization-wide Space is discoverable by any active
  member, a personal Space by its participants.
- **General is one per Organization and cannot be archived or made personal.**
  The unique partial index on `system_role` is what makes a race between two
  idempotent creators produce one Space rather than two fallbacks. Its name may
  be edited; its identity, lifecycle and audience may not.
- **Space effects other than the two directory effects never reach the
  workspace.** The role drops them at the parent, and the workspace handoff
  refuses them by name. A Space has no feed for an activity event to appear in
  and no notification anyone asked for.
- **Space attachments are monotonic.** Leaving a Space, removing a default, or
  archiving a Space stops future delivery and retracts the live access source;
  it never removes a resource or Sidekick a Channel already has.
- **No surface says a Channel is private while an active Organization-wide Space
  grants access to it.** The Channel's own scope is one source among several,
  and a control that described it alone would contradict the Space beside it.
- **No product surface opens a Space's conversation.** The dashboard carries no
  composer, transcript, feed socket, Main link or Breakout list.

## Boundary

This module owns the Space relationship inside one Organization: identity,
directory projection, per-person order, membership, the default registry and its
delivery, and the staged intents that make a cross-object operation resumable.

It does **not** own what a Space *is* — the name, appearance, scope,
participants and attachments belong to `SpaceDO` and its hidden main
conversation, documented in
[`workstream-durable-object.md`](workstream-durable-object.md). It does not own
a Channel's audience; that is the Channel's own authority, reached through
`ChannelAccessService` and documented in
[`authorization.md`](authorization.md) and
[`scope-grant-directory.md`](scope-grant-directory.md). It does not own
resources, which stay with the regional resource authority.

Regional HTTP routes call the service, which calls typed RPCs; nothing outside
`workspace-space-storage.ts` touches the Space tables, and nothing outside
WorkspaceDO reads them. Regional D1 remains the authority for active
Organization membership and access class only.

## Failure modes and limits

A malformed input fails strict contract parsing at the object boundary. Every
refusal is one of the nine closed `SpaceErrorCode` values, which is the code a
route renders, a log line carries, and a Queue consumer branches on; the
sentence around it is written about whichever object the caller acted on —
`spaceRefusal` for a Space, `spaceAccessError` for a Channel.

A transaction is local to one WorkspaceDO, so a failed write leaves no partial
Space, membership or ordering row. A cross-object operation is not a
transaction, and that is what the intents are for: an interruption leaves a
`pending` intent that the alarm republishes.

**`SPACE_CHANNEL_PAGE_SIZE` is 250, and the number is the team's to set.** It
bounds one page of `GET /spaces/:id/channels`, which without it grows with the
Organization — General holds every Channel — until one RPC result exceeds what a
single answer can carry, failing the whole page rather than slowing it. 250 is
transcribed from the Channel directory page beside it
(`WorkspaceDirectoryListRequestSchema` caps its `limit` at 250 and
`WorkspaceDirectoryVisibleIdsPageSchema` caps its items at the same number)
rather than chosen; what a different number buys is round trips against bytes
per answer, and nobody here has the Organization sizes to weigh them.

**`SPACE_INTENT_RESUME_DELAY_MS` is 30 seconds, and the number is the team's to
set.** It is how long a staged operation may sit half-applied before the alarm
republishes it — a lower bound, so a healthy request settles its intent before
this fires and nothing is published at all. The arithmetic the team needs: how
long the slowest healthy operation takes end to end (an audience change walks
every member Channel) against how long a half-applied audience may persist.

There is no product ceiling on the number of Spaces in an Organization, the
number of Spaces a Channel may belong to, or the number of defaults a Space may
hand down. Those are product decisions and are not invented here.

Two limits are known gaps rather than decisions, and are named in the changelog
below: the archive preflight tests the departing Space's own audience rather
than each member Channel's remaining readers, and narrowing a Channel that has
migrated to grant authority requires the acting person to hold a grant on it.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/space-authority.test.ts` | Every RPC against real Durable Object storage and real D1 membership, including the four negative controls. |
| `apps/api/test-workers/space-object.test.ts` | The role's differences, and that a Space's directory effect lands in the Space directory rather than the Channel one. |
| `apps/api/test/workspace-space-schema.test.ts` | Migration 61 against the real ledger: the CHECK vocabularies, General's unique partial index, the default-target foreign key, and the retirement-graph rebuild carrying its `retired_at` receipts. |
| `apps/api/test/space-service.test.ts` | The service's *ordering* against capability doubles: what is not written when an earlier step refuses. |
| `apps/api/test/space-default-publication.test.ts` | Claim, send, accept — and that a rejected send leaves its rows pending. |
| `packages/contracts/src/spaces.test.ts` | The closed schemas and the appearance registry. |
| `apps/desktop/src/renderer/components/space-sidebar-section.test.tsx` | The section: General as an ordinary row, placements, drag, reorder, **New space**, restore, loading, a failed refresh, and the Organization-opening state. |
| `apps/desktop/src/renderer/screens/space-dashboard.test.tsx` | Each section, the blocked-archive copy, and General's protections. |
| `apps/desktop/src/renderer/components/manage-access-dialog.test.tsx` | The sources, the never-claims-private rule, and each actionable refusal. |

```bash
pnpm --filter @rally/api exec vitest run test/workspace-space-schema.test.ts
pnpm --filter @rally/api exec vitest run test/space-service.test.ts
pnpm --filter @rally/api exec vitest run test/space-default-publication.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-authority.test.ts
pnpm --filter @rally/contracts test -- spaces.test.ts
```

The workerd fixture uses its own workspace id literal and `beforeEach(reset)`,
so object storage is clean per case while object *names* are still shared across
files. Its `workspace_members` fixture declares `access_class` deliberately:
without the column the suite would prove the membership check and not the guest
one.

The service tests double the object stubs rather than the namespaces, and they
are not where a fence is proved. A fence is a property of real storage; what the
service tests hold is which authority is asked first and what is left unwritten
when one of them refuses.

## Data model

Eleven tables, all in WorkspaceDO's migration 61.

`workspace_space_directory` is one row per Space: the name, appearance and scope
a projection wrote, the archive timestamp, the protected `system_role`, the
generation/source-version/payload-hash triple every projection is fenced on, and
one `revision` that advances on every accepted change. A unique partial index on
`system_role` makes General singular. `workspace_space_viewers` is the
per-person half of the same projection and is where a Space's participants live.
`workspace_space_order` is `(user_id, space_id) → position`;
`workspace_space_state` holds the one waterline both directories share.

`space_channel_memberships` is keyed by `(space_id, workstream_id)` with **no**
uniqueness on the Channel, because a Channel belongs to as many Spaces as it was
added to. `space_intents` is one row per staged cross-object operation, keyed by
the caller's operation id, carrying its kind, its three nullable fences, its
receipts, and the retry gate the alarm claims on.

`space_defaults`, `space_default_targets` and `space_default_publications`
mirror the Project trio with a `kind` column and the same generation fences; the
target and publication rows share a key so their insertion is one transaction
and publication can resume after a failed send. `space_bootstrap` and
`space_bootstrap_receipts` are seeded `pending` for every Organization and
driven by the cutover.

Migration 61 also rebuilds `workspace_retirement_graph` so its `parent_kind`
CHECK admits `'space'`, carrying its rows — and their `retired_at` receipts —
through a scratch table. Migration 42 is released and is not edited.

## Regional impact

A Space lives in the same configured deployment as its Organization and its
Channels. Its id, membership, projections, grants, resources and Sidekicks do
not cross the regional boundary, and the Global identity service routes an
Organization before any `SpaceDO` is addressed. No global Space index and no
cross-region Space exists. The only external read on a Space path is the
same-region D1 membership and access-class check.

## Security and trust model

Every RPC payload is untrusted and parsed at the object boundary. The workspace
identity is pinned by the object and asserted on every call, and active
Organization membership with `access_class = 'member'` is rechecked before any
Space visibility is evaluated.

WorkspaceDO's directory and membership projections are discovery and
coordination state. **They never authorize Channel content by themselves**: a
Space source becomes access only by travelling through `ChannelAccessService` to
the Channel's own grant authority, membership-incarnation fencing, participant
projection and owner admission. A grant written for a Space source carries that
provenance and is never published to the shared scope-grant directory — a
Space-derived reader discovers the Channel through the Space.

Adding a Channel to a Space authorizes both sides: the caller must be able to
edit the Space and to change the Channel's audience. Removing another
participant from a Space requires an Organization owner or administrator;
everything else follows the flat rule Projects used, where anyone who can read a
Space may edit it.

`recordSpaceIntentReceipt` is deliberately server-to-server and carries no
membership recheck, like the default-target settlement RPCs beside it. It grants nothing and reads nothing; the operation
id is the whole address, and every step it settles was authorized when it was
staged. Refusing it on membership would leave an intent pending forever, and the
alarm republishing it forever, whenever the person who started an operation
later left the Organization.

## Operations

Migration 61 is visible through the existing Durable Object migration tracker.
The two alarm phases are `space_default_publish` and `space_intent_resume`;
their failures log `space_default_publication_failed` and
`space_intent_resume_publication_failed` with the Organization id.

The engineering MCP reaches a Space through `list_spaces` and `run_space_sql`,
both fenced on `workspace_space_directory` rather than on naming the object — see
[`engineering-mcp.md`](engineering-mcp.md). A Space's hidden main conversation
is reachable through the substream tools because
`bootstrapWorkstreamRuntimeEnvironment` writes its `workstream_authority_routes`
row under the Space id.

A non-empty regional activity dead-letter queue remains the terminal failure
signal for default delivery and intent resumption.

## Changelog

### 2026-09-19 — The desktop draws the hierarchy, and a row stops claiming to know an audience

**What changed:** The Projects sidebar section, screen, routes, API methods and
cache slice are replaced by the **Spaces** section, the `/spaces/:spaceId`
dashboard, **Add to space**, **Manage access**, and a local cache slice at
version 3. `spaceIds` joins the common half of `workspace_workstream_state`.

**Why:** A Channel's readers are now the union of its own scope and every active
Space that holds it, so **Make private** could no longer describe what it did.
The dialog that replaces it reads the sources and says — including the case the
PRD names explicitly, where an Organization-wide Space keeps a Channel public
that its own scope calls personal. `spaceIds` had to be common state for the
same reason it is WorkspaceDO's to publish: a placement is the Organization's
fact about a Channel, and on the viewer half it would have been re-read per
socket for no gain and missed by every other reader.

**Considered and rejected:** Keeping a direct **Make public to organization** on
the row beside a new **Manage access**. It reads as the smaller change and it is
the one that lies: on a Channel already public through a Space, a row-level
scope toggle describes an audience change that has already happened. Also
rejected: placing a Channel from the launcher by calling `POST /spaces/:id/channels`
after the create. The PRD requires a named Space to be established with the
Channel or the creation to fail without publishing one, and a follow-up call is
neither — so the launcher plumbs `spaceIds` and sends no Space until the
creation contract carries one.

**Consequences:** `WorkstreamCreationFieldsSchema` still carries `projectId` and
has no `spaceIds`, so a Channel started from a Space is not yet placed in it;
that is Phase 4's. `GET /spaces/:id/channels` answers with bare ids, so the
dashboard can name only the Channels already in this device's page of the
directory and counts the rest. A version 2 local-cache row is dropped rather
than migrated: it holds Channel rows written before `spaceIds` existed, and a
Channel in no Space is a state no surface may render.

### 2026-09-19 — WorkspaceDO becomes the Space authority, and a Space reaches a Channel only through the Channel's own operations

**What changed:** Migration 61 adds the Space directory and viewer projections,
per-person order, many-to-many Channel memberships with staged generations, the
kind-keyed default registry with its generation-fenced targets and
publications, the staged operation intents, the bootstrap state, and a rebuilt
retirement graph that admits `parent_kind = 'space'`. `SpaceService` orders the
three authorities, `/spaces` exposes the mutations, and `/projects/*` answers
`410 client_update_required`.

**Why:** The PRD's design decision 3 — the Organization owns the relationship —
is not a preference. Two of the three invariants this module exists to hold
("every Channel has a home", "every remaining reader can still find it") are
questions neither the Space nor the Channel can answer alone, so they have to be
asked of the object that sees both.

Design decision 4 is the other half. On `main`, WorkstreamDO's grant ledger only
becomes a Channel's admission authority after its first share; every other
Channel is still admitted from the scope and participant rows its main
conversation holds. Recording Space sources only in the grant ledger would have
granted nothing on most Channels. So a Space source is *provenance* in
WorkstreamDO, and applying it goes back through the Channel's canonical scope
and participant operations — which is where the retained-content containment
preflight and its SQL triggers already are.

**Considered and rejected:** A narrowing planner beside the widening one. It
reads as the symmetric thing to build and it is the wrong shape: a source that
can narrow can revoke access another source still supplies, and the composition
rule that makes a Space's audience safe to change without auditing every other
Space is exactly that a source only widens. Narrowing is therefore expressed as
retract-then-apply through the same seam, and the retraction plan seats every
surviving reader before it narrows anything.

Three revisions in the Project's shape — presentation, audience, lifecycle. Every
fence here means "the Space as it was when this work was staged", and three
counters meant every fence had to name which of them it meant while a change to
either of the others still invalidated the work.

Publishing the Space directory on every Channel directory projection. Those
arrive on ordinary activity; the membership test is what keeps the republication
off the path every projection takes, exactly as the Project count's does.

A second publisher for Sidekick defaults. The staging, the fence, the currency
recheck and the receipt are identical to a resource's; only the canonical
operation that applies them differs, so `kind` rides on the row and the message
and there is one mechanism.

**Consequences:** Two limits ship known-incomplete and are the next change's to
close. `prepareSpaceArchive` tests the *departing Space's* audience against the
remaining Spaces rather than each member Channel's remaining readers, because
the precise test needs one cross-object read per member inside a refusal;
removal, which has one Channel to ask about, does use the precise test. And
`WorkstreamObjectProductService.update` now seats the narrowing actor through
the grant mutation, which means a person with no grant on a migrated Channel
cannot narrow it — a named refusal where it used to be an abort on
`participant_authority_freeze_insert`, but still a refusal. A Space retraction
whose plan narrows the scope therefore requires the acting person to hold a
grant on that Channel.

`WorkstreamSchema` gains `spaceIds` and `WorkspaceSidebarSchema` gains `spaces`
and `spacesReady`. Both socket payloads are parsed by strict schemas in shipped
clients, so this is a coordinated cutover rather than an additive field: the
PRD's rollout has the client deploy after the fleet gate, and older clients
receive the update-required refusal.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.
