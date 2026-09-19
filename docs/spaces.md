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

Spaces replace [Projects](projects.md), which WorkspaceDO migration 62 has
deleted. This document describes the Space authority, its service, the one-time
cutover that gave every existing Organization its hierarchy, and the routes over
them; the product design is in
[the Spaces PRD](PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/spaces.ts` | Space ids, the appearance registry, scope, status, system role, summaries, request shapes, `ChannelAccessSources`, and the closed `SpaceErrorCode` union. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | WorkspaceDO's Space tables (migration 61) and the synchronous transactions over them, including `workspace_container_order` — every list a person arranges by hand — and the `SPACE_CHANNEL_PAGE_SIZE` and `SPACE_BOOTSTRAP_PAGE_SIZE` page bounds. |
| `apps/api/src/durable-objects/workspace-space-protocol.ts` | Strict RPC requests and results, the Queue message shapes, and the `kind` that makes a resource and a Sidekick default one mechanism. |
| `apps/api/src/durable-objects/workspace-do.ts` | The authenticated Space RPCs, the three server-to-server cutover RPCs, the Space branch of `applyWorkstreamDirectoryEffects`, `publishSpaceSnapshot`, the sidebar payload, the three alarm phases, and migration 62, which retires Projects. |
| `apps/api/src/durable-objects/fenced-target-publication.ts` | The claim/send/accept publisher every Space publisher calls. |
| `apps/api/src/durable-objects/workspace-space-default-publication.ts` | The Space's three arguments to it: default targets, unsettled intent resumes, and the cutover's next page of work. |
| `apps/api/src/services/space-service.ts` | Creation, presentation, audience, membership, archive, restore, defaults, and the resume of an interrupted operation. |
| `apps/api/src/services/channel-access-service.ts` | The one seam a Space reaches a Channel's audience through. `docs/spaces.md` never writes an audience itself. |
| `apps/api/src/services/space-bootstrap-service.ts` | The one-time cutover, the new-Organization General, and the placement the two creation paths outside the coordinator take for themselves. |
| `apps/api/src/services/workstream-object-creation-service.ts` | Where a Channel is born into its Spaces. [`workstream-creation.md`](workstream-creation.md) owns it. |
| `apps/api/src/routes/spaces.ts` | `/spaces` mutations and the two paginated reads. |
| `apps/api/src/routes/workspace.ts` | `PUT /workspace/order`, the one write for all three hand-arranged lists. It is a workspace route because two of the three containers are not Spaces. |
| `apps/api/src/queues/activity-consumer.ts` | The `space_default`, `space_intent_resume` and `space_bootstrap` handlers. |
| `packages/ui/src/components/space-row.tsx`, `space-appearance-picker.tsx`, `space-dashboard.tsx`, `space-icons.ts` | The shared presentation both hosts draw a Space with. `docs/shared-ui.md` owns the split. |
| `apps/desktop/src/renderer/components/space-sidebar-section.tsx` | The **Spaces** section: rows, placements, drag, reorder, **New space**, restore, and the Organization-opening card. |
| `apps/desktop/src/renderer/screens/space-dashboard.tsx` | The `/spaces/:spaceId` dashboard. |
| `apps/desktop/src/renderer/components/manage-access-dialog.tsx` | **Manage access**: `GET /workstreams/:id/access`, rendered as one union of sources. |
| `apps/desktop/src/renderer/lib/sidebar-list-store.ts`, `use-space-directories.ts`, `workspace-socket.tsx`, `workspace-directory-cache.ts` | The client's Space state: one versioned receiver, the two socket-owned directories, `spacesReady`, this person's whole ordering, and the local cache slice. |
| `apps/desktop/src/renderer/lib/personal-order.ts` | `orderByStoredIds`, the one rule every hand-arranged list in the client is drawn by, and `storedOrderFor`, which finds one container's arrangement in it. |
| `packages/ui/src/components/workstream-sidebar.tsx` | The Breakout rail, including the `substreamDrag` a host supplies to let a person arrange it. |

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

### What the hidden conversation is asked

Nothing in the product opens a Space's main conversation, but the Space
authority writes six things on it, and those six are the whole of the traffic it
has:

| Operation | Reached from | What it writes |
| --- | --- | --- |
| `provision` and `setAppearance` at creation | `SpaceService.provisionSpaceObject` | the title, scope, creator and appearance that make the object a Space |
| `update({ title })` and `setAppearance` | `PATCH /spaces/:id` | the name, icon and colour |
| `update({ scope })` | `PATCH /spaces/:id/audience` | who the Space is for |
| `addParticipant` / `removeParticipant` | `PATCH /spaces/:id/audience` | the Space's participants |
| `attachResource` / `detachResource` | `POST`/`DELETE /spaces/:id/defaults` | a default resource |
| `previewAudienceContainment` | the audience preflight | nothing — it is a read, and it is asked of a *member Channel's* conversation rather than this one |

Everything else a conversation can do is not a Space operation: no message, no
socket, no run, no archive through `/workstreams/:id`, and **no agent loop**.
`ensurePersistentLoop` is the one place a loop is minted and it refuses a Space
parent by name, which is the invariant rather than an optimization.

**A refusal is not free where construction can reach it.** That refusal used to
be reached from `SubstreamAgent`'s constructor, which mints the loop for every
object that already has an identity so an isolate replacing another finds its
run where it left it. A throw there is inside `blockConcurrencyWhile`, so it
breaks the object's input gate — and the first time a Space's conversation was
rebuilt from storage it could not be constructed at all. That is *every* time:
nothing opens it, so it is evicted seconds after it is made. Every operation in
the table above then answered 500, and the object's own drain could not run, so
the Space's `directory_common` and `directory_user` effects stayed in its outbox
and the Organization was left holding whatever the reservation had said. The
guard is on the constructor rather than inside `ensurePersistentLoop`, because
every other caller is asking to *run* something and the refusal is right for
them; this one was only asking to recover, and a Space has nothing of the kind
to recover.

**A failure of this object is named `space_authority_unreachable`.** It is
reached over Durable Object RPC, so a rejection that is not the object's own
refusal arrives with no code on it, and a 500 from the object is the object
saying it does not know what went wrong. Both used to reach a person as
`internal_error` — the same word the Worker uses for every unhandled failure it
has — so a Space whose authority could not answer was indistinguishable in a log
from a bug in the route beside it, and the five operations above cost five
separate diagnoses of one cause. `SpaceService.throughSpaceAuthority` is the one
seam that names it; a refusal the object *chose* keeps its own code, because
replacing `space_protected` or a content fence with a generic word would be the
same mistake in the other direction.

### Membership

Adding a Channel is staged. `prepareSpaceMembership` writes a `joining` row and
returns the Space and the membership generation; `ChannelAccessService.applySpaceSource`
applies the audience that membership implies; `finalizeSpaceMembership` activates
it, re-reading both the Space revision and the membership generation, and stages
every current default for the new member. A membership is invisible until it is
finalized — no summary counts it and no page lists it — because a placement whose
readers have not been granted anything must not reach a client.

Adding a Channel a Space already holds is the same path and succeeds. The
preflight answers an already-active row with the generation it already has
rather than staging a new one, and the settlement accepts that row at *that*
generation: a retry, and two people dragging the same Channel onto the same
Space, are ordinary rather than a 404.

Removing one is the same shape in reverse, with two refusals in front of it.
`space_membership_final` is the invariant that every Channel has a home.
`space_audience_incompatible` is the weaker one that also has to hold: a reader
who keeps access through some other source must still be able to *find* the
Channel, which means discovering one of the Spaces it stays in. The service
computes the remaining audience from the Channel's own access sources with this
Space taken out, because WorkspaceDO cannot see a Channel's direct source.

A removal and an archive both *stage* before they ask a Channel for anything:
the preflight flips the membership out of `active` and only then does the
fan-out withdraw the source. So the set a staged operation still has work for is
`active` plus `removing`, which is what `listSpaceMembers` answers for a
`reaching` read — an archive that asked for the Space's active members would
walk nothing and leave its source live on every Channel it had. An audience
change and a restore mean the active set and ask for it.

Every fan-out carries the membership generation the row it is about is actually
at. Both halves of the fence are the caller's to supply and the Channel's to
re-read, and a constant in that position is a fence against a generation the row
may have left behind.

### Audience

Changing a Space's audience is preflight, accept, converge.

Every member Channel is asked first, through the read-only
`previewAudienceContainment` RPC, whether its retained content would still be
contained. That RPC is a tri-state and only `true` admits: `false` is the
content fence, and `null` is the object saying it is not that Channel's main
conversation — which means the question was never asked. The request path
refuses a `null` with `space_conversation_unreachable` and the cutover with
`space_bootstrap_conversation_unreachable`: one reading, two names, because the
cutover records a blocker on a row and the request answers a person. Widening cannot be undone — somebody may have read — so discovering a
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

The retraction carries the Space revision too, and that is not symmetry. It is
the step that *deletes* the source row the application and its confirmation
fence on, so an older audience change interleaved behind a newer one would
otherwise find nothing to lose to and install its stale roster unfenced. A
removal and an archive withdraw a source rather than replace it and pass no
revision: there is no newer application for them to race. The walk also re-reads
the Space between Channels and abandons when the revision moves, because the
change that overtook it walks every member itself.

**The walk is paged, and the page is recorded on the intent.** An audience
change, an archive and a restore all walk every member Channel, and every
Channel on that walk costs several cross-object awaits — so a Space large
enough puts the walk past one invocation's subrequest budget. `SpaceService`
therefore reads `SPACE_BOOTSTRAP_PAGE_SIZE` members at a time and writes the
cursor the page ended at onto the `space_intents` row before it asks for the
next one. A Space under that ceiling still settles inside the request exactly as
it did; past it the invocation fails, the intent stays unsettled carrying its
cursor, and the alarm's resume continues from that page rather than starting
over. One walk function serves the request and the resume, because a request and
its resume that walked differently would be two implementations of the same
convergence and the resume is the one nobody watches.

### Per-person ordering

Three lists in the product are arranged by hand, and they are **one mechanism
rather than three**: the Organization's Spaces, the Channels placed in one
Space, and the Breakouts under one Channel. Each asks the same question — in
what order does *this* person want the items of *this* container — so
`workspace_container_order` is keyed by `(user_id, container_kind, container_id,
item_id)` with a `position`. `container_kind` is one of `organization`, `space`
and `channel`; `container_id` is the workspace id, the Space id, or the Channel
id, so a row says what it is about without the object it is stored in being part
of its key.

**What may be in each list is the only thing that differs by kind**, and each
answer is one this object already holds:

- `organization` keeps the Space ordering's original semantics exactly. Every
  visible Space is appended first, on the read as well as on the write, because
  the Space directory is read *through* these rows and a Space with no row is
  one the join cannot answer with. The request is then filtered to the Spaces
  this viewer can see, and the ids nobody mentioned keep their relative order
  behind the ones that were — which is what a sidebar sends when a search has
  hidden rows.
- `space` keeps the Channels actually placed in that Space that this viewer can
  read. `spaceIdsByChannel` — the read the sidebar payload already makes for
  every row it draws — answers the active membership and the Space's own
  visibility, and `listableChannelIds` — which a Space refusal already uses to
  decide what it may name — answers the Channel's. A membership cannot answer
  the second: a placement is the Organization's fact about a Channel, and
  visibility is the reader's.
- `channel` **is stored as given.** A Channel's Breakouts are its own object's
  children and WorkspaceDO has never seen one, so there is nothing here to
  validate against. The client drops the ids it is not drawing. Storing an id
  that names nothing costs this person one row and nobody else anything: the
  rows are theirs, and the only reader is their own sidebar.

The Organization's list is *updated in place* and the other two are *replaced*.
Nothing but the client's own helper reads the second and third, so an item
nobody mentioned belongs at its natural position rather than pinned to a stale
one; the Organization's rows, by contrast, are what the directory join needs to
exist at all.

**Authorization is what every other Space write has**: an active non-guest
member of this Organization, through `spaceRefusalCode(..., "write")`. A
Breakout's order is not a Space fact, and it is kept behind the same gate
deliberately — the rows live in this object, they ride the Space snapshot, and a
second authorization rule for one of three kinds is a second thing to get wrong.

**One delivery shape.** The whole ordering rides the per-viewer
`workspace_space_snapshot` and the connect payload that seeds it, as one
`ordering` field: a list of `{ container, itemIds }`, one entry per container
this person has arranged. A list rather than a map because the key is a *pair*,
and a map would have to encode it into a string every reader parses back. The
Organization's own list is in there too, although the Space directory beside it
already arrives sorted by the same rows. That redundancy is the point: with it
the client has one rule — apply the stored order to the list you are drawing —
and without it the Spaces would be the one list whose arrangement came from the
order the server happened to serialize, which is not something a drag can move
optimistically or roll back. A write republishes the whole ordering to every
socket this person holds, which is what makes a drag in one window move the
list in another without a reload.

**One client helper.** `orderByStoredIds` puts the stored ids first in stored
order, then everything the arrangement never mentioned in the order the list
already had, and drops a stored id the list is not carrying. It is also what
`orderPinnedWorkstreams` is built on, so the pinned section and these three are
one arrangement rule rather than four. A drag writes its arrangement locally
first and drops it if the server refuses; the list then shows what the
Organization holds, which is what this person's other windows are showing.

**The Space dashboard's paginated Channel list is not ordered per person.** It
is a server-paged read, and arranging a list whose later pages have not arrived
is a different feature from arranging one the client holds whole — the client
could only ever order the page in front of it, and the stored ids would name
Channels no page had fetched. It keeps its server order.

The per-person pinned Channel order (`workspace_workstream_pins`) is a separate
table and stays one; [`workstream-pinning.md`](workstream-pinning.md) records
what folding it in would need.

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
what decides a race between two callers rather than a check-then-write: there is
no read in front of the insert at all. Every caller reserves, the index refuses
all but one, and the loser is answered with the Space the winner made, re-read
outside the transaction its own statement aborted. Three callers reach this RPC
and each is a retry of another, so the second one through is the ordinary path
rather than the exception.

**It reserves; it does not provision.** Opening the object is the caller's, the
way it is for any other reservation — a caller that reserves General without then
provisioning it leaves a Space in every member's sidebar that answers nothing,
exactly as a cancelled `create` would. `SpaceService.ensureGeneral` is the one
caller that does both: it reserves, provisions **only** when the reservation
says `created`, and cancels the reservation if provisioning fails. Everything
that needs General — the cutover, a Channel created without a Space, a new
Organization, the connector path — goes through it, so the two steps are never
half-done by somebody re-deriving them.

### The cutover

Every Organization that predates Spaces has to end up with a hierarchy, and
**the PRD requires the fleet migration to finish without relying on user
access**. So nothing about this hangs off a request. `space_bootstrap` is one
row per Organization, seeded `pending` by migration 61 and driven by the
WorkspaceDO alarm: the migration tracker's forced pass wakes every object, the
alarm claims one page of work, and the activity Queue carries it to
`SpaceBootstrapService`.

The phases are ordered, and the alarm claims exactly one at a time because a
page's cursor is only known once the page before it has been reported:
`pending` → `general` (make the Organization's General Space) → `preflight`
(walk the Channel directory in pages asking whether each Channel may be
widened, and write nothing) → `memberships` (walk it again, placing each
Channel in General) → `finalize` (close the cutover, or say why it cannot) →
`complete`. `not_before`
and `attempts` are the same retry gate every other staged fan-out in this object
uses — advanced *before* the send, cleared by progress — so a rejected batch is
retried rather than spinning the alarm, and a page delivered but never reported
is republished rather than lost. What makes a redelivery cost nothing is the
membership row itself: a Channel some Space already holds is skipped, which
covers both a replayed page and a Channel the ordinary creation path placed
while the cutover was running. There is no second receipt table, because the
membership is the state a placement produces and cannot disagree with.

**The cutover acts as a person, per Channel.** The audience change a placement
implies goes through the Channel's canonical scope operation, which authorizes
an actor — and a personal Channel admits only its own participants. So each
placement runs as one of *that Channel's* active participants; an
Organization-wide Channel is acted on by the Organization's driver, chosen
owners-first from active members. A Channel with no active participant left is
recorded as blocked with `space_bootstrap_no_active_actor` rather than forced,
because there is nobody the disclosure could honestly be attributed to.

**Every blocker is found before any Channel is widened.** The PRD's Existing
Organizations section says an unsafe Channel blocks its Organization "without
partial mutation", and rollout step 3 asks the preflight to identify every
blocker before promotion. A walk that discovered its blockers one placement at a
time could do neither: by the time the fenced Channel refused, the Channels
before it in the page would already be Organization-wide. So `preflight` asks
the same two questions a placement asks — is there an active person to attribute
the disclosure to, and does `previewAudienceContainment({ scope: "workspace" })`
admit this Channel's retained content — over the same page, the same cursor and
the same claim machinery, and writes nothing. `memberships` is claimed only when
that pass recorded nothing; a pass that recorded something goes to `finalize`,
which reports. `SpaceBootstrapService.admit` is the one implementation both
passes call, and `place` calls it again at the moment of the mutation because
the fence is a trigger inside the conversation and content can arrive between
the two.

**A blocker is not a retry.** A Channel whose retained content the Organization
may not read keeps its own audience, gets no membership row and no mutation at
all, and is recorded as blocked with `space_membership_content_fence`. The PRD
is explicit that the cutover never deletes or bypasses those fences, so the
Organization stays short of `complete` until somebody remediates it — which is
the point: `spacesReady` stays false, the operator sees the Channel id on the
row, and the fence is a product decision rather than a migration's to make. A
`preflight` page also reports the Channels it found *clear*, which takes their
blockers off the row: it is the pass that notices a remediation.

`finalizeSpaceBootstrap` is the close, and it refuses three ways. Both
refusals that leave the cutover open send it **back to the walk**, because the
walk is the only thing that changes any of the facts it refused on. `unplaced`
— a Channel that arrived after the walk passed its id, which a late directory
projection can do — is new work, so the pass restarts with its gate cleared.
`blocked` re-walks through `reopenBootstrap`, which keeps the claim's retry
gate: the preflight reports the Channels it now finds clear, a still-fenced one
is re-recorded, and an Organization nobody remediates re-walks on
`scheduledAlarmRetryDelay`'s interval — about once a minute — rather than
spinning. Leaving the phase at `finalize` instead, which is what this did
first, made a blocked Organization permanent: nothing else takes a Channel off
`blocked_json`, so `spacesReady` stayed false and the opening card stayed up
however the Channel was remediated.

**What remediating a fence actually means.** The fence is immutable and General
is Organization-wide, so a fenced Channel can never enter General — adding it
to an Organization-wide Space is the same widening and is refused by the same
fence. What clears the blocker is giving the Channel a home whose audience the
fence already admits (a personal Space whose participants it allows) or
deleting the Channel: the invariant the cutover closes on is that every Channel
has *a* Space, not that every Channel is in General.
[`runbook.md`](runbook.md) holds the operator's version.

Two paths place a Channel outside a page, and both are the same step a page
would take. `openGeneralSpaceForNewWorkspace` runs inline on the path that
initializes a new WorkspaceDO: the alarm would get there within a Queue round
trip, but the first session inside that window would be shown the
Organization-opening card for an Organization that has nothing to open. It is
best effort on purpose — a Space failure must not cost somebody the Organization
they just created, and the alarm is the backstop running the same code.
`placeConnectorChannelInGeneral` covers the two creation paths that do not go
through the creation coordinator: the Slack agent, which opens a Channel for a
Slack member with no Rally identity and provisions the conversation itself, and
the local development seed route, which restores a captured fixture into objects
it provisions under the ids the fixture chose. **A refusal there reopens the
cutover** rather than only logging: a `complete` Organization is never walked
again, so a Channel this step could not place would stay homeless for good. The
walk reaches it with the Organization's own directory projection — which knows
participants the connector's record may not — and the Organization is not
`spacesReady` while that runs, which is the honest answer for an Organization
holding a Channel in no Space.

**Both of those paths have to make the Channel's own authority exist before they
place it**, which the coordinator gets for free. A placement addresses the
Channel's `WorkstreamDO` directly, and that object learns the Channel exists
either from `reserveChild` — which writes its identity row synchronously — or
from an effect that drifts up the conversation's outbox some time later.
Provisioning the conversation alone and placing immediately is refused
`conversation_parent_missing` every time, and because a refusal reopens the
cutover, that is not a lost placement but every member's sidebar behind the
opening card until the walk catches up.

The Slack path calls `reserveChild` first, exactly as the coordinator does
before `initialize`, and defers the provisional directory delivery until after
the placement so the Channel is never listed while it is in no Space. Nothing
polls: a production ingest path must not wait for a projection to appear. The
conversation's own effect arrives afterwards and finds the metadata already
written, so it updates the row rather than creating it and nothing is
provisioned twice.

The seed route instead waits for the Channel to appear on one page of the
cutover's own view, which is acceptable only because that route is
development-only. It buys a second property there: because the close asks
whether any Channel *in the directory* is outside every Space, a walk that a
refusal reopens cannot find an empty directory and close over it.

**And the directory handoff itself is the backstop under all of them.** Every
path above is a path that knows it has to place a Channel; what has no such
path is a Channel that simply *stays* in the directory unplaced, which a future
creation path that forgets to place would produce and which the development
seed already did. `applyWorkstreamDirectoryEffects` therefore asks, after it
commits a batch's channel envelopes, whether a `directory_common` effect in it
was for a Channel that is now outside every Space — the close's own predicate,
`unplacedChannelExists`, narrowed to those ids so there is one SQL text rather
than two descriptions of the same question — and reopens the cutover when one
was. The row is still committed: the guard is a backstop, not a refusal, and
dropping the Organization's projection of a Channel would be a worse state than
the one it is reacting to. It reads this object's own SQLite and nothing else,
so an ordinary projection pays two local queries.

**It asks only about Channels the batch did not introduce**, and that is the
difference between a backstop and a false alarm. A Channel *arriving* in the
directory is a creation in flight. `reserveChild` enqueues the provisional
`directory_common` row, and both creation paths defer its delivery until after
the placement — but the Channel authority's own recovery alarm delivers that
row directly if it wins the race with the coordinator's flush, which is exactly
what `drainParentOutboxWithCreationFence` is for. On the coordinator path the
memberships are already settled by the time `reserveChild` runs, so the row can
only arrive placed; on a connector path the reservation comes *before*
`placeConnectorChannelInGeneral` and the conversation is provisioned in
between, so that alarm has a wide window in which to deliver a row for a
Channel whose placement has not started — and it takes it: a guard that fired
on arrivals reopened the cutover on every run of `space-creation.test.ts`'s
Slack creation. Reopening there takes `spacesReady` away from every member's
sidebar until the walk catches up, which is the same cost that made the old
Slack ordering a bug rather than a slow path. A row the Organization was
**already** holding that is still in no Space is a different claim: it is about
a broken invariant rather than an unfinished creation, and it is the one
nothing else is going to fix. The price is that a Channel a forgetful path
creates is caught on its next common projection rather than its first.

### A Channel's first Space

Creation is the other half of "every Channel belongs to at least one Space", and
it is the half that has to hold for every Channel made after the cutover.
`WorkstreamCreationFields` carries `spaceIds`, defaulted to empty, and empty
means General: the creation coordinator resolves it, stages a membership per
Space, and **settles them before the Channel's main conversation is reserved**.
Reserving one arms the parent's recovery alarm, which delivers the deferred
provisional directory row itself if it wins the race with the coordinator, so a
settlement any later could publish a Channel that is Organization-wide and in no
Space at all. [`workstream-creation.md`](workstream-creation.md) owns the
ordering and the audience the named Spaces imply.

### Resuming an interrupted operation

Every cross-object Space operation — an add, a removal, an audience change, an
archive and a restore — stages an intent in WorkspaceDO before it touches
another object. A request that dies between the two leaves that intent
`pending`, and nothing else would notice — the caller is gone and the Channel was
never asked. The WorkspaceDO alarm claims unsettled intents, advancing their
retry gate before the send, and republishes them as `space_intent_resume`
messages; the consumer re-runs the same steps as the requester, against the
fences the intent recorded and from the cursor its member walk reached — the
same paged walk, continued rather than restarted. A redelivery is safe because those steps are
idempotent deltas and the settlement refuses a generation or revision that has
moved.

The operation id is the caller's, minted once and carried to both halves. An
archive used to derive it at settlement from the Space revision minus one, which
made two writes in two objects agree by arithmetic; anything that moved the
revision in between left the intent pending and the alarm republishing an
archive that had already happened.

An intent whose Space has moved is not abandoned. A superseded audience change
is still an *interrupted* one — its walk stopped part way, so some member
Channels carry the roster it was applying and the rest do not — so the resume
converges against the Space as it is now and settles `audience_superseded`,
naming the Space and both revisions in the log. A resume that fails for any
other reason names its reason too, rather than being retried in silence until it
reaches the dead-letter queue with nothing on it.

### Reads

Space state comes down the workspace socket, not over HTTP, and there is no
second read path for a test to use either — the directory is asserted through
the same payload a client is handed. The connect payload
carries `spaces` — both directories at one waterline, shaped for the viewer —
and `spacesReady`, and every Space write republishes the same pair to every
subscribed socket. There is deliberately no `GET /spaces`: a client that fetched
one would hold a second answer to a question the socket already answers, and the
two would disagree across a mutation.

Both payloads are shaped for the viewer in two ways beyond ordering. **A guest
is sent nothing**: both directories empty and `spacesReady` true, because a
guest holds explicit Channel grants and no Organization-wide discovery, and is
not waiting on a cutover. The relationship is read at accept time and pinned on
the socket attachment, because nothing re-asks on the way out — an open socket
is closed by the access-revocation queue rather than by a publisher querying D1
again. And a Channel's `spaceIds` name only the Spaces *that* viewer may see: a
Channel in somebody's personal Space would otherwise put that Space's id, and
through `channelCount` its size, on every reader's row.

**An Organization that has not reached migration 61 answers empty rather than
failing.** The meeting-notes retirement holds an object at schema 57 until its
external cleanup finishes, and the connect payload reads the Space tables before
anything product-shaped can refuse. Every Space read therefore goes through
`WorkspaceSpaceStorage`, which answers empty state when its tables are absent;
every Space *write* is refused by name with `space_bootstrap_pending`.

The two exceptions are paginated and therefore cannot ride the socket: a Space's
member Channels (`GET /spaces/:id/channels`) and a Channel's access sources
(`GET /workstreams/:id/access`).

`GET /spaces/:id/channels` answers **Channels**, not ids. WorkspaceDO pages the
membership rows for their ids and then projects those ids through the same
directory select and mapper the sidebar's own list uses, chunked against the
bound-parameter ceiling, so a Space page and a sidebar row are the same shape
built by the same code rather than two projections that can drift. The
visibility predicate travels with it: a row is answered only if the Channel is
Organization-wide or the viewer is one of its participants, which is what keeps
a Space page from being a way to enumerate Channels the viewer cannot open.

### The desktop surfaces

The sidebar's **Spaces** section sits where Projects were and is drawn in every
shell the host hands a directory to, the conversation-only one included: every
Channel belongs to at least one Space, so a sidebar without it cannot say where
anything lives. General is in the directory like any other Space and the section
has no case for it.

A guest is handed none. Guest access to Spaces is deferred, every Space RPC
refuses a guest, and design decision 9 makes that the host's call rather than
something the components infer from a refusal — so `spacesEnabledForSession`
decides it once in the shell and the sidebar draws no heading, no **New space**,
no **Add to space** and no draggable row. Absent is not empty: an empty
directory is an Organization whose first Space has not been made yet, and it
still gets all four.

A placement is not a copy. The rows under an expanded Space are the Channel list
the sections below already render, filtered by the Channel's own `spaceIds`, and
they go through the same row — so a Channel in two Spaces is one record shown
twice, with one unread state, one running state and one destination. That is why
`spaceIds` travels on the *common* half of `workspace_workstream_state`: it is
the Organization's fact about the Channel, not the reader's, and WorkspaceDO
republishes the row after every membership settlement.

**That republication is at the waterline the row already had**, because a
placement changes nothing the Channel's own authority projects — adding an
already Organization-wide Channel to a second Organization-wide Space moves no
audience. The client's versioned receiver reads an unadvanced waterline as a
duplicate, so `applyVersionedWorkstreamState` takes the placements off a row it
is otherwise rejecting, exactly as it fills an empty participant pile at a
pinned waterline. Without that the Channel stayed under the Spaces it had for
the session, and the local cache carried the stale row through a reload.

The Space dashboard's own Channel page is the one thing on that screen the
socket cannot replace, so it is refetched when the Space snapshot's
`channelCount` moves — the Organization saying the membership changed somewhere
else, which **Add to space** on a sidebar row and a drag both are.

The sidebar holds one page of the Organization's Channels, so an expanded Space
lists the placements this device has and says nothing about the rest. It does
not print the Space's `channelCount`: that total is not viewer-scoped, so a
number drawn from it would count Channels the reader may not read. The count is
still what keeps an expansion holding no rows from claiming the Space is empty.

**Manage access** replaces **Make private**, because a row cannot say whether a
Channel is private: its readers are the union of its own scope and every active
Space that holds it. The dialog reads `GET /workstreams/:id/access` and renders
the Channel's own provenance and the Organization's memberships as one union —
they agree in the steady state and disagree exactly while an operation is in
flight, which is the thing it exists to show.

The dialog offers **Make private** only while no Space source is
Organization-wide. The server refuses that narrowing with
`channel_scope_locked_by_space` in exactly that state, and the sources saying so
are the ones on screen; the sentence beside the missing control names the Space
to change first. The refusal copy stays for the race where a Space widened after
the read answered.

Every Space refusal on every one of these surfaces goes through one copy table,
`lib/space-failure-copy.ts`, exhaustive over the closed `SpaceErrorCode` plus an
`unavailable` fallback, so a refusal names what has to change first rather than
printing the diagnostic a Worker wrote for a log. A surface that knows what was
being attempted supplies its own sentence for a refusal that carried no code —
"Spaces couldn't be reordered" also accounts for the row that snapped back.

Each dashboard action reports into its own slot, so a refused rename stays with
the name instead of appearing inside every modal that is opened afterwards. The
slots are cleared when the screen changes Space: one component draws every
Space, so a refusal about the Space somebody just left would otherwise be read
as being about the one they just opened.

While `spacesReady` is false the sidebar section and the dashboard show the
Organization-opening card *instead of* the hierarchy, and the **New space**
control is not drawn: a Space directory missing General, or a Channel with no
Space, is not a state any surface may render, and creation is refused with
`space_bootstrap_pending` anyway. The Channel rows are handed no Space list
while it is false for the same reason, which is what takes **Add to space** and
the drag with it. The flag is optional on the wire and read as ready when
absent, so a client talking to a server without the cutover is not permanently
opening.

A Channel row is draggable exactly while a pinned reorder, a placement or a
placement reorder is possible; a system Channel offers neither Space control,
because the subsystem that writes it decides both its audience and its home.

**There is no time-grouped list of Channels under the hierarchy.** Every Channel
belongs to a Space, so the section above already says where each one lives and a
second list of the same rows ordered by time was the same sidebar twice. What is
left in its place is **Other channels**: the Channels whose `spaceIds` intersect
this viewer's visible directory in nothing. A member can read a Channel whose
only Spaces are ones they cannot see — **Manage access** already draws such a
placement as a Space the viewer cannot see — and without that section the
Channel would be in the sidebar nowhere at all. It is flat, ordered by recency,
carries no group headings, and is absent when empty, which is the ordinary
state. Pinned Channels are left out of it, as they were left out of the list it
replaces: the section above already has them.

**"Visible directory" means the one that is on screen, not the one that
arrived.** While the Organization is still opening, the Spaces section draws its
opening card *instead of* the rows, and the directory already carries General —
so the set the fallback tests against is `spaces` **and** `spacesReady`, the
same pair that decides where a row's **Add to space** may place a Channel. Read
without the readiness, every Channel the cutover placed would leave **Other
channels** for a hierarchy nobody can see yet: a member with the desktop open
would watch their sidebar empty itself one page of 50 at a time, and get it back
at `complete`. The one value both sections read is `placementSpaces` in
`sidebar.tsx`.

The name is the plainest one the product's own language offers. "Unplaced" and
"Unfiled" describe the Organization's hierarchy rather than the reader's view,
and both are wrong about what is actually going on — the Channel *is* placed,
in a Space this person cannot see.

**A guest keeps the flat list.** A guest is handed no Space directory at all, so
there is no hierarchy to say where anything lives; their sidebar is the
time-grouped list exactly as it was, with its group headings and their bulk
actions. The member session loses those bulk actions with the headings that
carried them.

**Three lists are arranged by drag, and each has the keyboard's version of the
same gesture** — Alt with the up or down arrow, the mechanism the pinned list
already had, said once per section rather than on every row. A drop inside the
list a Channel is already in is a reorder; a drop on another Space is the
placement it has always been. The row itself claims a release its own list took,
so the event never reaches the Space underneath; a release anywhere else falls
through to the Space row, which is what a placement is.

## Invariants

- **WorkspaceDO is the sole Space relationship authority.** Copying membership
  into a child object or D1 would give two objects an answer to "does this
  Channel have another Space", which is the question both the final-membership
  and the archive refusals turn on.
- **Every Space RPC a person can reach rechecks active Organization membership
  and refuses a guest.** Guest access to Spaces is deferred; a guest holds
  explicit Channel grants and no Organization-wide discovery, so admitting one
  would put every Organization-wide Space in their sidebar — through an RPC or
  through the socket, which is why the snapshot is shaped for the relationship
  too. The exceptions are named and have no person on the request:
  `recordSpaceIntentReceipt`, `spaceBootstrapStatus` and the default-target
  settlements are server-to-server, and each says so where it is defined.
- **A Space's hidden main conversation is not addressable as a Channel.** Every
  product request carries the parent kind the caller expects and is refused
  `conversation_parent_kind_mismatch` when the object disagrees. A conversation
  is reached by id, every member is handed every Space id on the socket, and the
  PRD gives that conversation no product surface at all — so without this,
  `PATCH /workstreams/<spaceId>` archives General behind the Space authority's
  back.
- **One person's order for one container is stored under that container, and
  read by nobody else.** The rows are per viewer and reach only that viewer's
  own sockets. A Breakout's order is stored unchecked because this object cannot
  see a Channel's children; that is safe precisely because nothing but the
  person's own sidebar ever reads it, and a second reader would make an
  unvalidated id somebody else's problem.
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
refusal is one of the twelve closed `SpaceErrorCode` values, which is the code a
route renders, a log line carries, and a Queue consumer branches on; the
sentence around it is written about whichever object the caller acted on —
`spaceRefusal` for a Space, `spaceAccessError` for a Channel. A Queue handler
that fails for a reason outside that union records `diagnosticErrorCode` rather
than a fixed literal, and writes it on the row it is about: `last_error_code` on
a default target and on an intent is the durable record of *why* a delivery or a
resume has not finished, and the `space_default_delivery_failed` and
`space_intent_resume_failed` log lines carry the same word for whoever is
watching at the time.

A transaction is local to one WorkspaceDO, so a failed write leaves no partial
Space, membership or ordering row. A cross-object operation is not a
transaction, and that is what the intents are for: an interruption leaves a
`pending` intent that the alarm republishes.

### Numbers handed to the team

| Number | Value | What it bounds | What deciding it needs |
| --- | --- | --- | --- |
| `SPACE_CHANNEL_PAGE_SIZE` | 250 | Rows in one `GET /spaces/:id/channels` answer, and therefore one RPC result and one HTTP body. | Round trips against bytes per answer, weighed against the Organization sizes nobody here has. |
| `SPACE_INTENT_RESUME_DELAY_MS` | 30 seconds | How long a staged cross-object operation may sit half-applied before the alarm republishes it. | How long the slowest healthy operation takes end to end against how long a half-applied audience may persist. |
| `SPACE_BOOTSTRAP_PAGE_SIZE` | 50 | Channels in one page of a cross-object walk: the cutover's Queue message, and one page of an audience change, archive or restore fan-out. | Fewer alarm wakes against a longer invocation, given per-Channel timings and Organization sizes nobody here has. |
| *(none)* — attempts before an unsettleable intent stops being republished | no ceiling | How long a staged operation that can never succeed keeps costing an alarm wake and a dead-letter message. | What an operator is expected to do about a `last_error_code` that never changes, weighed against a ceiling abandoning work nobody agreed to abandon. |
| *(none)* — items in one person's order for one container | no bound | How many rows one `PUT /workspace/order` writes, and how much of the `ordering` field one container can take up on every socket payload this person receives. | What the largest list somebody would actually arrange looks like — an Organization's Spaces, a Space's Channels, a Channel's Breakouts — against what a payload can carry. |

Each is a lower bound rather than a budget, and each is a transcription rather
than a measurement — the sections below say what each was transcribed from.

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

**`SPACE_BOOTSTRAP_PAGE_SIZE` is 50, and the number is the team's to set.**
Without it the cutover would claim the whole Organization in one message, and an
Organization larger than one invocation's budget could never finish — each
redelivery would restart the same unbounded pass. Nothing is visible when it
trips: the page ends and the cursor continues it on the next alarm. It sits
between two ceilings, a Queue consumer invocation and a WorkspaceDO alarm, and
each Channel costs four cross-object awaits — one containment preflight, one
membership staging, one canonical audience operation, one settlement. 50 is a
quarter of `SPACE_CHANNEL_PAGE_SIZE`, which bounds a *read* rather than a walk
of cross-object writes; what a different number buys is fewer alarm wakes
against a longer invocation, and nobody here has the Organization sizes or the
per-Channel timings to weigh them.

**It bounds the Space fan-outs too**, for the same arithmetic rather than for
tidiness: an audience change retracts and re-applies this Space's source on
every member Channel, and each of those is a plan-apply-confirm conversation
with the Channel's own authority. That is the same several-hops-per-Channel
shape the cutover has, so it takes the same page — one number to move rather
than two that have to be kept in step.

**There is no attempt ceiling on an intent resume, and the number is the team's
to set.** An intent that can never settle is claimed by the alarm forever: the
retry gate backs off to `SCHEDULED_ALARM_RETRY_MAX_MS` — thirty minutes — and
stays there, so the standing cost is one Queue message and one dead-letter
message every half hour, indefinitely, with `last_error_code` on the row saying
why each time. That is deliberate rather than unfinished: the sibling
`space_default_targets` has no ceiling either, and the one condition that ends
either of them without success is a *named* one — no active person left to act
as — which the consumer settles by name rather than counting up to. A ceiling
here would be a decision to abandon a half-applied audience change, which is a
product decision and is not invented here. What deciding it needs: what an
operator is expected to do about an intent whose `last_error_code` never
changes, against what abandoning one costs.

**A stored order has no length bound, and the number is the team's to set.**
Nothing caps the `itemIds` a person may store for one container. In practice the
list is what one person dragged — the `organization` and `space` lists are
filtered to what that person can see, so they cannot exceed the Spaces or the
Channels they can read, and only `channel` is stored unchecked, because
WorkspaceDO cannot see a Channel's Breakouts. What a cap would cost is a person
whose real list is longer than it silently losing its tail, which is worse than
the row it would prevent; what deciding one needs is the largest list somebody
would actually arrange, against what one socket payload can carry. The guard is
written open.

There is no product ceiling on the number of Spaces in an Organization, the
number of Spaces a Channel may belong to, or the number of defaults a Space may
hand down. Those are product decisions and are not invented here.

Three limits are known gaps rather than decisions, and are named in the
changelog below: the archive preflight tests the departing Space's own audience
rather than each member Channel's remaining readers; narrowing a Channel that
has migrated to grant authority requires the acting person to hold a grant on
it; and a Channel narrowed through `PATCH /workstreams/:id` — its own scope
rather than a Space's retraction — announces that narrowing with nothing durable
behind the send. A Space path that narrows fails its step, so the intent stays
unsettled and the alarm republishes the whole operation; the direct path has no
intent and no other record, so a refused send is logged
`channel_narrowing_publish_unannounced` and the Organization's non-participant
readers keep their open sockets until they reconnect.
[`access-revocation.md`](access-revocation.md) owns that gap.

## Testing

**Each suite below proves one layer, and only that layer: the WorkspaceDO
suites enter at an RPC, `space-service.test.ts` enters at the service with the
objects around it doubled, and `space-routes.test.ts` is the only one that
enters where a person does.** That gap is not academic — it is where both
defects of 2026-09-19 lived, and each of them passed every suite above it: a
request body's scope is parsed by a route nothing else drives, and a Space's
hidden conversation refuses from a real object in a way no double reproduces.
A behaviour that a route, a real session or a cold Durable Object could break
belongs in the route suite as well as wherever its authority is proved.

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/space-routes.test.ts` | The `/spaces` routes as a signed-in member drives them, against real objects: that a created Space's own projection reaches the Organization carrying the scope the request asked for, that a second member is sent it or not according to that scope, and that an audience change, a rename and an archive all work on a Space whose conversation has been evicted — which is the state it is in for all but the seconds after it is made. And that a Space's own authority failing is answered by name rather than as `internal_error`. |
| `apps/api/test-workers/space-authority.test.ts` | Every RPC against real Durable Object storage and real D1 membership, including the four negative controls, the Channel page's viewer predicate, and that a placement reaches an already-open socket rather than waiting for a reload. Ordering: a write for each of the three container kinds coming back on that person's sidebar and on nobody else's, a Space's list dropping a Channel it does not hold and one the viewer cannot read, and a write reaching a second session of the same person without it asking. The Space directories are read off the workspace socket's connect payload rather than through a read of their own, because that is the only path a client has. |
| `apps/api/test-workers/space-object.test.ts` | The role's differences, that a Space's directory effect lands in the Space directory rather than the Channel one, and that a Channel product request aimed at its hidden conversation is refused by name. |
| `apps/api/test-workers/channel-access-sources.test.ts` | The Channel end of a Space source: the union every plan is computed against, and the revision fence a retract-then-apply convergence carries. |
| `apps/api/test/workspace-space-schema.test.ts` | Migration 61 against the real ledger: the CHECK vocabularies — including the three containers a person can arrange — the order row's compound key, General's unique partial index, the default-target foreign key, and the retirement-graph rebuild carrying its `retired_at` receipts. |
| `apps/api/test/space-service.test.ts` | The service's *ordering* against capability doubles: what is not written when an earlier step refuses. |
| `apps/api/test/space-default-publication.test.ts` | Claim, send, accept — for default targets and for the cutover's page claim — and that a rejected send leaves its rows pending. |
| `apps/api/test-workers/space-member-walk.test.ts` | A fan-out over more member Channels than one page holds: that the walk crosses the page bound, that the intent's cursor names the page it reached, and that a resume continues from it — read off each Channel's own access-operation receipts rather than off the cursor under test. And the `restore` resume, which re-applies the source from the cursor on and leaves the page behind it alone; and that a resume the activity consumer catches leaves its reason on the intent row. |
| `apps/api/test-workers/space-bootstrap.test.ts` | The cutover on real workerd: one General for every Channel including archived ones; a fenced personal Channel found by the preflight with *no* Channel widened or placed, and the Organization closing once that Channel has a home the fence admits; a connector placement's refusal reopening a finished cutover; an interrupted pass making no second General and no second membership; the refusal to close while a Channel is outside every Space; the directory handoff's guard reopening a finished cutover for a Channel whose row is committed while it is in no Space, and leaving it closed for a placed Channel, for a Channel arriving in the directory for the first time, and for a system one; that the development seed route places the Channels it restores; and that an Organization short of `complete` arms its own alarm on construction, due now, which is what "the fleet migration finishes without relying on user access" rests on. |
| `apps/api/test-workers/space-creation.test.ts` | A Channel born in General with an active membership, a recorded source and the audience that implies; one General across creations; a Channel born in a named Space; and that a creation whose membership cannot settle publishes no directory row by either path. |
| `apps/api/test/workspace-space-retirement-migration.test.ts` | Migration 62 against the real ledger: a queued Project default settled before the drops rather than dropped under, an applied default leaving the Channel's own attachment alone, and the consumer's tombstone acknowledging a redelivered Project message by name. |
| `apps/api/test/client-contract.test.ts` | Which builds the cutover still answers: a browser build that declares nothing or declares an older contract is told to update; a native client that declares nothing is admitted. |
| `packages/contracts/src/spaces.test.ts` | The closed schemas and the appearance registry. |
| `apps/desktop/src/renderer/components/space-sidebar-section.test.tsx` | The section: General as an ordinary row, placements, drag, reorder, **New space**, restore, loading, a failed refresh, the Organization-opening state, route-derived expansion, and that a Channel dragged out of a Space does not reorder Spaces. |
| `apps/desktop/src/renderer/screens/space-dashboard.test.tsx` | Each section, the blocked-archive copy, General's protections, and that one refusal appears once. |
| `apps/desktop/src/renderer/components/manage-access-dialog.test.tsx` | The sources, the never-claims-private rule, the withheld narrowing control, and each actionable refusal. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | The row's Space controls: **Add to space**, the drag, the system-Channel and Organization-opening cases, and a shell with no directory. Also the sidebar's shape — no time-grouped list for a member and the flat list untouched for a guest, **Other channels** present only for a Channel with no visible placement, absent otherwise, and holding every Channel while the Organization is still opening — and the placement drag: a drop inside a Space reorders, a drop on another Space places and reorders nothing, Alt+Arrow does the same without a pointer, and a refusal snaps the list back. |
| `apps/desktop/src/renderer/lib/personal-order.test.ts` | The one arrangement rule: stored ids first, the rest in their natural order, an id the list does not carry dropped, an empty arrangement as the identity, and a container addressed by both halves of its key. |
| `apps/desktop/src/renderer/components/workstream-sidebar.test.tsx` | The Breakout rail's drag: the move reported as the pointer crosses, a backed-out drag reported as cancelled, Alt+Arrow, and no gesture at all for a reader who cannot store an order. |

```bash
pnpm --filter @rally/api exec vitest run test/workspace-space-schema.test.ts
pnpm --filter @rally/api exec vitest run test/space-service.test.ts
pnpm --filter @rally/api exec vitest run test/space-default-publication.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-routes.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-authority.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-object.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/channel-access-sources.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-member-walk.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-bootstrap.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-creation.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-space-retirement-migration.test.ts
pnpm --filter @rally/api exec vitest run test/client-contract.test.ts
pnpm --filter @rally/contracts test -- spaces.test.ts
```

The two new workerd files are there for the same reason the archive fan-out is.
The cutover's fence case needs the Channel's own authority and its
conversation's containment trigger, and the creation ordering property needs a
real recovery alarm — a double would be asserting on its own configuration in
both. `workspace-space-retirement-migration.test.ts` is Node because what is
under test is the checked-in statements themselves: a CHECK constraint's name,
the order the drops run in, and whether a cascade fires. It runs with
`PRAGMA foreign_keys = ON`, because the drops are ordered children-before-parents
precisely on the fact that a Durable Object event cannot turn them off.

The workerd fixture uses its own workspace id literal and `beforeEach(reset)`,
so object storage is clean per case while object *names* are still shared across
files. Its `workspace_members` fixture declares `access_class` deliberately:
without the column the suite would prove the membership check and not the guest
one — and, since the workspace socket reads the relationship at accept time,
every fixture in `test-workers/` that opens one declares it too.

Two cases in `space-authority.test.ts` reach outside WorkspaceDO on purpose,
because the property is not WorkspaceDO's alone. The archive fan-out drives a
real `WorkstreamDO` so "the source is gone from each member Channel" is read
from the Channel rather than inferred from a membership row, and the
schema-57 case pins the object the way `meeting-notes-retirement.test.ts` holds
one — an unfinished external cleanup, the ledger at 57 — then connects a socket,
because a guarded read that answers empty and an unguarded one that throws look
identical until something asks.

**A pending cutover is a due alarm, and a fixture has to account for it.** The
`space_bootstrap` row is a derived alarm candidate whose `not_before` migration
61 leaves at the epoch, so constructing a WorkspaceDO arms a wake-up that the
platform delivers immediately and that runs the object's whole alarm handler.
That is the mechanism rather than an accident — it is how the fleet migration
starts with nobody signed in — so a workerd fixture whose subject is something
else closes the cutover after `initializeWorkspace`, the way the path that opens
a new Organization does, and disarms what construction already armed.
`scheduled-alarms.test.ts` and `workspace-resources-inventory.test.ts` both do,
the second because that handler's resource sweep would otherwise reap the drafts
its cases are about. In the Node suite the equivalent is
`test/helpers/space-creation-rpcs.ts`: the three WorkspaceDO RPCs and the room
RPCs a create now passes through, doubled in their steady case for a file whose
subject is Slack assignment or origin attachment. It doubles both shapes of the
provenance call, because an ordinary create takes one — `applySpaceAccessSource`
in its birth mode — and the connector placement beside it still takes two.

The service tests double the object stubs rather than the namespaces, and they
are not where a fence is proved. A fence is a property of real storage; what the
service tests hold is which authority is asked first and what is left unwritten
when one of them refuses.

## Data model

Ten tables, all in WorkspaceDO's migration 61.

`workspace_space_directory` is one row per Space: the name, appearance and scope
a projection wrote, the archive timestamp, the protected `system_role`, the
generation/source-version/payload-hash triple every projection is fenced on, and
one `revision` that advances on every accepted change. A unique partial index on
`system_role` makes General singular. `workspace_space_viewers` is the
per-person half of the same projection and is where a Space's participants live.
`workspace_container_order` is `(user_id, container_kind, container_id,
item_id) → position` — every list a person arranges by hand, keyed by the
container it belongs to, with a `CHECK` narrowing `container_kind` to the three
containers the product lets somebody arrange. It replaced a Space-only
`workspace_space_order` **in place** in migration 61 rather than beside it,
because 61 is unreleased and a rename dance would have been migration
bookkeeping for a table nothing had yet stored.
`workspace_space_state` holds the one waterline both directories share.

`space_channel_memberships` is keyed by `(space_id, workstream_id)` with **no**
uniqueness on the Channel, because a Channel belongs to as many Spaces as it was
added to. `space_intents` is one row per staged cross-object operation, keyed by
the caller's operation id, carrying its kind, its three nullable fences, its
receipts, the `cursor` its member walk reached, the `last_error_code` of its
most recent failed resume, and the retry gate the alarm claims on. The kind
vocabulary is exactly the five operations that stage one — `add`, `remove`,
`audience`, `archive`, `restore` — because a default's delivery and the cutover
each have staging, a retry gate and a consumer leg of their own. The cursor is the same shape `space_bootstrap` carries for the
cutover's walk — the Channel id the last finished page stopped at — and it is
what a resume reads; the receipts are one per page rather than one per Channel,
because `receipts_json` is rewritten whole by `json_insert` and a receipt per
member cost O(N²) bytes in one row for something no resume read.

`space_defaults`, `space_default_targets` and `space_default_publications`
carry a `kind` column and the same generation fences; the target and publication
rows share a key so their insertion is one transaction and publication can
resume after a failed send.

`space_bootstrap` is the singleton cutover row, seeded `pending` for every
Organization: the phase (`pending`, `general`, `preflight`, `memberships`,
`finalize`, `complete`), General's id once it exists, the walk's cursor, the blocked
Channels as JSON, and `not_before`/`attempts` — the retry gate the alarm claims
on, advanced before the send and cleared by progress. A redelivered page
costs nothing because the membership row says what is already placed; there is
no receipt table beside it.

Migration 61 also rebuilds `workspace_retirement_graph` so its `parent_kind`
CHECK admits `'space'`, carrying its rows — and their `retired_at` receipts —
through a scratch table. Migration 42 is released and is not edited.

**Migration 62 deletes the eight Project tables**, after the invalidation
described under [Operations](#operations) and children-before-parents, because
`PRAGMA foreign_keys = OFF` is a no-op once a Durable Object event has touched
SQLite. [`projects.md`](projects.md) records what was deleted and what survived
it.

## Regional impact

A Space lives in the same configured deployment as its Organization and its
Channels. Its id, membership, projections, grants, resources and Sidekicks do
not cross the regional boundary, and the Global identity service routes an
Organization before any `SpaceDO` is addressed. No global Space index and no
cross-region Space exists. Every external hop a Space path makes is to the same
region's D1:

- **The membership and access-class check**, on every Space write RPC — the one
  read every Space path makes, and on most of them the only one.
- **Two `workstream_authority_control` reads and one `workstream_authority_routes`
  write**, when `ensureGeneral` finds no General and provisions the Space's own
  object: `bootstrapWorkstreamRuntimeEnvironment` reads the authority control row
  and writes the route anchor batch, and `provisionSpaceObject` reads the control
  row again for the generation it fences `reserveChild` with. This is the
  fallback path — `openGeneralSpaceForNewWorkspace` is meant to have run when the
  Organization opened — so it is not on an ordinary creation.
- **A second `workspace_members` read** in the cutover driver, which has no
  session and reads the Organization's owner or administrator in order to act as
  somebody.

## Security and trust model

Every RPC payload is untrusted and parsed at the object boundary. The workspace
identity is pinned by the object and asserted on every call, and active
Organization membership with `access_class = 'member'` is rechecked before any
Space visibility is evaluated. That recheck and the migration-61 readiness check
are one gate, so a Space write on an Organization the cutover has not reached
answers `space_bootstrap_pending` rather than aborting on a missing table.

**A Space id is not an address for a Channel operation.** Every member holds
every Space id — they arrive on the workspace socket — and a conversation object
is reached by id alone, so the Space's hidden main conversation was reachable
through `/workstreams/:id`: archivable, narrowable, readable, none of it through
the Space authority and none of it a surface the PRD admits. Every product
request now states the parent kind it expects and is answered `404
conversation_parent_kind_mismatch` when the object's own identity disagrees,
before authentication, because the answer is about the address rather than about
the caller.

A reservation is cancellable only by the person who made it. `source_version = 0`
is a window every Space passes through between being reserved and its first
projection, so a cancel that named only the id could delete whatever anybody
else was in the middle of creating.

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

`spaceBootstrapStatus` is the other one, for a different reason: there is no
person on the request at all. The cutover runs with nobody signed in and the
workspace id is the whole address; what it answers is the cutover's own state,
and the `spacesReady` a client sees comes off the socket shaped for that viewer
rather than from here.

## Operations

Migrations 61 and 62 are visible through the existing Durable Object migration
tracker, and **the tracker's forced pass is what starts the cutover**: it wakes
every WorkspaceDO, and the alarm armed by construction claims the first page.
The napkin sum for that fleet-wide burst on the shared activity Queue — one
in-flight page per Organization, against the platform's published per-queue
throughput — is in the comment beside the producer, in
`workspace-space-default-publication.ts`, where
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#deciding-without-measurement)
asks for it.
[`runbook.md`](runbook.md) holds the operator sequence — force the class, watch
`spaceBootstrapStatus`, remediate blockers, confirm an empty dead-letter queue.

The three alarm phases are `space_default_publish`, `space_bootstrap` and
`space_intent_resume`; their failures log `space_default_publication_failed`,
`space_bootstrap_publication_failed` and `space_intent_resume_publication_failed`
with the Organization id. The cutover's own progress logs
`space_bootstrap_general_ready`, `space_bootstrap_channels_blocked`,
`space_bootstrap_not_ready` and `space_bootstrap_complete`; an Organization that
stops moving has its reason on the `space_bootstrap` row rather than only in a
log line.

**How Project effects are shut down.** The PRD makes "zero unsettled Project
effects" a cutover gate, because a default still queued for delivery is work
aimed at a Channel whose audience the Space cutover has just changed. Two
things meet it, and neither is an assertion. Migration 62 invalidates every
undelivered row in the same transaction that drops the tables — pending targets
to `terminal` with `last_error_code = 'project_retired'`, pending publications
to `accepted` — and the activity consumer keeps a tombstone leg for the
platform's retry window, acknowledging a message published before the cutover
with `reason: "projects_retired"` rather than retrying it to the dead-letter
queue.

**There is no barrier, and the two that shipped could not fire.** Migration 62
carried a scratch table whose CHECK counted `pending` rows immediately after
the statements that settled every one of them, so the count was zero by
construction; `finalizeSpaceBootstrap` carried a matching
`project_effects_pending` gate that ran after the constructor had already
dropped the tables. Both are deleted rather than repaired, because nothing is
owed: PRD non-goal 5 deletes Projects rather than converting them, so a default
that never reached a Channel is discarded on purpose, and a gate that held
every Organization's hierarchy closed over it would be protecting work the PRD
says to drop. [`projects.md`](projects.md) records what went.

**Which builds are still answered.** The sidebar payload and the Channel page
both gained fields, and a shipped desktop parses them with strict schemas, which
reject an object carrying a field they have never heard of rather than ignoring
it. `GET /workstreams` and `GET /workspace/socket` therefore answer a build that
declares no current contract with `426 client_update_required` — the two
surfaces the changed payloads travel on, rather than a middleware, so a build
that cannot render the sidebar can still be signed in, still post a message, and
still be told to update.

The gate reads `x-rally-client-contract`: absent, or below
`MINIMUM_SERVED_CLIENT_CONTRACT` in `packages/contracts/src/http-headers.ts`,
is a refusal. `Origin` is not the gate — it only separates a browser context
from a native one, so that a request with neither header is admitted, because
iOS and the desktop main process decode with schemas that ignore unknown keys.

**`426` is a wire-level refusal, not an update prompt.** No build that predates
this release knows the code, so a pre-cutover desktop shows whatever it shows
for a transport failure. The prompt is what a build shipped *after* this can
render, because it declares a contract and can read the answer; the PRD's
"explicit update-required response rather than a malformed or partial payload"
is satisfied by refusing rather than by what the old build draws.

The engineering MCP reaches a Space through `list_spaces` and `run_space_sql`,
both fenced on `workspace_space_directory` rather than on naming the object — see
[`engineering-mcp.md`](engineering-mcp.md). A Space's hidden main conversation
is reachable through the substream tools because
`bootstrapWorkstreamRuntimeEnvironment` writes its `workstream_authority_routes`
row under the Space id.

A non-empty regional activity dead-letter queue remains the terminal failure
signal for default delivery and intent resumption, and is no longer the only
one: `space_default_delivery_failed` and `space_intent_resume_failed` carry the
Space id and `diagnosticErrorCode`, and `last_error_code` on the default target
or on the `space_intents` row holds the same word for whoever reads it
afterwards.

## Changelog

### 2026-09-19 — A Space's hidden conversation can be rebuilt from storage, and its failures have a name

`SubstreamAgent`'s constructor mints the persistent agent loop for every object
that already has an identity, so an isolate replacing another finds its run
where it left it. `ensurePersistentLoop` refuses a Space parent by name — a
Space's conversation is a participant and resource authority and no agent runs
in it — and that refusal, raised from inside the constructor's
`blockConcurrencyWhile`, broke the object's input gate. A Space's conversation
is evicted within seconds of being made, because nothing opens it, so *every*
rebuild failed: `PATCH /spaces/:id`, `PATCH /spaces/:id/audience`, the
participant writes under it and the resource defaults all answered 500, and the
object's own drain could not run, so the Space's `directory_common` and
`directory_user` effects never left its outbox and the Organization kept
whatever its reservation had said about the Space's name, appearance and scope.
Archive and restore were the only whole-Space operations unaffected, because
they never address that object.

The guard is on the constructor rather than in `ensurePersistentLoop`, and that
is the whole of the decision. Lifting the refusal was the alternative and it is
the wrong one: every other caller of that function is asking to *run* something,
and a Space with an agent loop is the thing that must not exist. The constructor
is the one caller asking only to recover, and there is nothing of the kind to
recover. A future change that adds a caller has to answer the same question the
same way.

The second half is the name. The Space's own authority is reached over Durable
Object RPC, so a rejection that is not its own refusal crosses the hop with no
code on it, and a 500 from the object is the object saying it does not know what
went wrong; both reached a person as `internal_error`, which is what made one
cause cost five diagnoses. `SpaceService.throughSpaceAuthority` names them
`space_authority_unreachable` — a twelfth closed `SpaceErrorCode`, with its own
sentence in the desktop copy table — while a refusal the object *chose* keeps
its own code, because replacing `space_protected` or a content fence with a
generic word is the same mistake pointing the other way. The containment
preflight gets the same treatment: a member Channel's conversation that *throws*
is now the same answer as one that returns `null`, `space_conversation_unreachable`,
because in both the question was never asked.

Found by staging a real window rather than by a suite, which is itself the
finding. `apps/api/test-workers/space-routes.test.ts` is the layer that was
missing: the `/spaces` routes driven with a real session against real objects,
with the Space's conversation evicted first. Five of its six cases failed before
this change. The testing section above now says which layer each Space suite
proves, so the next author does not add the seventh case to a suite that cannot
see the route.

### 2026-09-19 — One ordering primitive, and a sidebar that stopped saying everything twice

**What changed:** The per-person Space order became the per-person order of
*anything*. `workspace_container_order` is keyed by `(user_id, container_kind,
container_id, item_id)` and holds three kinds of list — the Organization's
Spaces, the Channels placed in one Space, the Breakouts under one Channel — with
one RPC (`reorderContainer`), one route (`PUT /workspace/order`, at the
workspace level because two of the three containers are not Spaces), one request
and result (`ContainerOrder`), one field on the workspace socket (`ordering`),
and one client helper (`orderByStoredIds`) that the pinned section now uses too.
It replaced `workspace_space_order` in migration 61 in place; 61 is unreleased,
so a rename dance would have been bookkeeping for a table nothing had stored.
Validation is per kind and reuses reads that already exist; a Channel's
Breakouts are stored unchecked, because this object has never seen one.

The sidebar lost its time-grouped list of Channels for a member session, and the
group headings' bulk actions with it. Every Channel belongs to a Space, so the
hierarchy says where each one lives and the list below it was the same sidebar
twice. **Other channels** replaces it: the Channels whose only placements are
Spaces this reader cannot see, flat and by recency, absent when empty. A guest
is handed no directory and keeps the flat list exactly as it was.

Which Spaces those are is `spaces` *and* `spacesReady` together, and a future
change has to keep them together: the Spaces section draws its opening card
instead of its rows until the cutover completes, so a fallback that tested the
directory alone would draw a placed Channel in neither list — for as long as an
Organization's cutover takes, with the desktop open and rows leaving the sidebar
one page of 50 at a time.

**Why:** Three tables would have been three of everything above them — three
writes, three reads, three deliveries, three authorization decisions, three
client rules — for one question asked of three containers. The alternative that
was rejected outright is putting a Channel's Breakout order in `WorkstreamDO`,
where the Breakouts actually live. It is the wrong owner twice over: the order
is a *view preference of one person*, which the Channel's own authority has no
business holding for every reader of it, and the person's sessions are already
fanned out from WorkspaceDO — so a Channel-owned order would have needed a
second delivery path to reach the same sidebar the other two arrive on. The
price of the decision is exactly one thing: WorkspaceDO cannot check a Breakout
id, so it stores what it is given and the client drops what it cannot draw.
That is affordable only because the rows are per person and read by nobody else;
if a second reader ever appears, the validation has to appear with it.

The `ordering` field carries the Organization's list even though the Space
directory beside it already arrives sorted by the same rows. The duplication is
deliberate: without it the Spaces are the one list whose arrangement comes from
the order the server happened to serialize, which a drag cannot move
optimistically or roll back, and the client would have two rules where it now
has one.

A stored list has no length bound. Capping it would silently lose the tail of a
list somebody actually arranged, which is worse than the row it prevents; the
number, and what deciding it needs, is in "Numbers handed to the team" above.

The Space dashboard's paginated Channel list keeps its server order. Arranging a
list whose later pages have not arrived is a different feature: the client can
only order the page in front of it, and the stored ids would name Channels no
page had fetched.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.

### 2026-09-19 — Every Channel gets a home: the Organization owns the hierarchy, the desktop draws it, and Projects are deleted

**What changed:** Migration 61 adds the Space directory and viewer projections,
per-person order, many-to-many Channel memberships with staged generations, the
kind-keyed default registry with its generation-fenced targets and
publications, the staged operation intents, the bootstrap state, and a rebuilt
retirement graph that admits `parent_kind = 'space'`. `SpaceService` orders the
three authorities, `/spaces` exposes the mutations, and `/projects/*` answers
`410 client_update_required`. Every product request on a conversation carries
the parent kind its caller expects, so a Space id cannot be used as a Channel
address; every Space read in WorkspaceDO goes through `WorkspaceSpaceStorage`,
which answers empty state on an Organization the cutover has not reached; and
the workspace socket's Space payload is shaped for the viewer's relationship as
well as for their visibility.

The hierarchy became true of every Channel rather than of the
ones somebody placed. `WorkstreamCreationFields` carries `spaceIds` in place of
`projectId`, and a Channel created without one lands in General;
`SpaceService.ensureGeneral` reserves *and* provisions in one place. A one-time
cutover — `space_bootstrap`, a WorkspaceDO alarm phase, an activity-Queue
handler and `SpaceBootstrapService` — walks every existing Organization's
Channel directory in pages of 50: once read-only in `preflight`, asking whether
each Channel may be widened, and again in `memberships`, placing each one in
General as one of that Channel's own participants. A new Organization opens
General inline, and the two paths that provision their own Channel — the Slack
agent and the local development seed route — place it the same way. `GET /spaces/:id/channels` answers Channel rows instead
of bare ids, and the archive refusal now carries the Channels that blocked it.
WorkspaceDO migration 62 deletes the eight Project tables after settling every
undelivered Project effect, and `ProjectService`, the Project storage, protocol
and publisher, every Project RPC, the Project snapshot topic and the Project
alarm phase go with them. A pre-cutover browser build is answered
`426 client_update_required` on the two surfaces whose payloads changed.

The Projects sidebar section, screen, routes, API methods and
cache slice are replaced by the **Spaces** section, the `/spaces/:spaceId`
dashboard, **Add to space**, **Manage access**, and a local cache slice at
version 3. `spaceIds` joins the common half of `workspace_workstream_state`.
Every Space refusal on every surface goes through one copy table; the shell
decides once whether a session has Space navigation at all, and hands the
sidebar no directory when it does not.

Two read-only audits of the branch — one on every Queue-versus-RPC
decision it made, one on its whole scope — and a latency audit of four request
paths then closed the findings that were defects rather than preferences. The
member walks behind `updateAudience`, `archive` and `restore` are paged and
carry their cursor on the intent; `restore` stages an intent of its own;
`space_intents` gains `last_error_code`; the narrowing publication's refusal is
acted on rather than dropped; the containment tri-state is read the same way on
both paths, with `space_conversation_unreachable` naming the second negative;
the intent vocabulary is narrowed to the five kinds that are staged; the two
Space list RPCs nothing called are deleted; and the Slack ingress path reserves
its Channel's parent authority before placing it.

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

Every invariant in this document is written about *every* Channel in
the Organization, and until this change none of them held for a Channel nobody
had dragged anywhere. The PRD required the fleet migration to finish without
relying on user access, which is why the cutover hangs off the migration
tracker's forced pass and the alarm rather than off a request — an Organization
whose members never sign in still has to end up with a hierarchy.

The cutover acts as a person per Channel because the canonical scope operation
authorizes an actor and a personal Channel admits only its own participants;
inventing an authority that could place a Channel nobody can act on would have
been inventing a way to disclose one. And it never bypasses a content fence,
which is why an Organization can end the pass *incomplete*: a Channel whose
retained content the Organization may not read stays personal and holds
`spacesReady` false until somebody decides, which is a product decision rather
than a migration's.

Review changed three things about how that incompleteness behaves. The walk now
runs twice, because a single pass discovered its blockers one placement at a
time and left every Channel before the fenced one Organization-wide — the PRD
says an unsafe Channel blocks its Organization "without partial mutation", and
rollout step 3 asks the preflight to find every blocker before promotion. A
`finalize` that refuses now sends the Organization *back* to that walk rather
than leaving the phase where it was: nothing else takes a Channel off
`blocked_json`, so a blocked Organization was permanent whatever anybody did to
the Channel. And a refused placement outside a page reopens a finished cutover,
because those paths have no page behind them and a `complete` Organization is
never walked again.

The development seed route is the second such path and was found by walking the
acceptance flows: it restores a captured fixture through the object ports, so
its Channels reached the sidebar in no Space at all while the Organization
reported itself ready — the one state the PRD forbids rendering. It now takes
the same placement step, after waiting for the Channel to appear in the
Organization's directory. That wait is not politeness: the parent authority a
placement addresses is what publishes that row, and the cutover's close asks
its question about the Channels the directory holds, so without it neither the
placement nor the reopened walk behind it has anything to work from.

**That seed was the second path to be caught by hand, so the third is caught by
the Organization itself.** Each of the fixes above teaches one writer to place
what it creates, and the invariant is written about every Channel rather than
about the writers anybody has enumerated — so the failure was not the seed, it
was that a Channel could reach `workspace_workstream_directory` in no Space and
`spacesReady` went on saying the hierarchy was renderable.
`reopenBootstrap`'s own doc already named that event as one of its two reasons
to exist and nothing called it on one: `applyWorkstreamDirectoryEffects`
committed the row and moved on. It now asks the close's own predicate about the
Channels the batch committed and reopens the cutover when the answer is yes,
which turns a Channel nobody placed into an Organization that walks itself
again rather than one that is quietly wrong. The predicate is the close's,
taking an optional list of ids rather than being rewritten: the guard and the
close have to mean the same thing by "outside every Space", and a second query
is how they come to disagree about a system Channel or a `joining` membership.
The three steps a reopen owes — the row, the published snapshot that takes
`spacesReady` away, the armed alarm — are one helper the `reopenSpaceBootstrap`
RPC shares, because a copy at the second call site is a copy that can lose one
of them and leave a walk scheduled that nobody is told about.

The guard asks its question only of Channels the batch did not introduce, and
that restriction was found by running the suites against the first version of
it rather than reasoned out in advance. A Channel's arrival in the directory is
a creation whose placement has not started yet: `reserveChild` enqueues the
provisional row, and although both creation paths defer its delivery until
after the placement, the Channel authority's recovery alarm delivers it itself
when it wins the race with the coordinator's flush — and a connector path
reserves before it places, with the conversation provisioned in between. So a
guard that fired on an arrival reopened the cutover on every run of the Slack
creation test, putting every member's sidebar behind the opening card until the
walk caught up — precisely the cost the Slack reordering above was for. The
narrower claim — a Channel the
Organization was already holding is still in no Space — is the one that is
about a broken invariant rather than an unfinished one, and it costs a
forgetful creation path one further projection before it is caught.

**Considered and rejected:** refusing the envelope, which would have kept the
Organization consistent by dropping its own projection of a Channel — a worse
state than the one being repaired, and one with no path out, because the walk
that repairs it reads that very row. Also rejected: widening the guard's
predicate to count a `joining` membership so an arrival could be admitted. It
does not close the window it was for — the connector path reserves the Channel
before it stages any membership at all, so there is no row of any state to find
— and it would make the guard and the close disagree about what
"outside every Space" means, which is the drift the shared predicate exists to
stop. Also rejected: making the dev seed's wait-then-place redundant and
deleting it. The guard is a backstop that costs a Queue round trip and an
Organization-wide `spacesReady` blip; a path that knows which Channel it just
created should still place it directly, and the seed is also what keeps the
reopened walk from finding an empty directory.

A pending cutover is also what makes every WorkspaceDO wake immediately: the
`space_bootstrap` row is a derived alarm candidate due at the epoch until the
pass finishes. That is the mechanism, not a side effect, and it is what a test
fixture standing up a WorkspaceDO for some other reason has to account for.

The `426` gate needed a discriminator and no version signal existed. A request
with an `Origin` is a browser context, which is the desktop renderer, which is
the only client whose payload schemas are strict and therefore the only one that
drops a sidebar carrying fields it has never heard of. iOS and the main process
decode with schemas that ignore unknown keys, so a blanket gate would have
broken working clients to protect them from a problem they do not have.

A Channel's readers are now the union of its own scope and every active
Space that holds it, so **Make private** could no longer describe what it did.
The dialog that replaces it reads the sources and says — including the case the
PRD names explicitly, where an Organization-wide Space keeps a Channel public
that its own scope calls personal. `spaceIds` had to be common state for the
same reason it is WorkspaceDO's to publish: a placement is the Organization's
fact about a Channel, and on the viewer half it would have been re-read per
socket for no gain and missed by every other reader.

The client also stopped offering what the server must refuse. **Make private**
is withheld while an Organization-wide Space holds the Channel — the state the
server answers with `channel_scope_locked_by_space`, from sources the dialog is
already holding — and **Add to space**, the drag and the whole section are
withheld wherever there is nothing to place into: a guest session, an
Organization still opening, a system Channel. Drawing a control that can only
fail teaches a reader that Rally's controls are suggestions.

Walking the acceptance flows in a real window found the other half of that
claim missing. `spaceIds` reached the client and the client threw it away: a
placement that implies no audience change republishes the Channel row at the
waterline it already had, and the versioned receiver reads an unadvanced
waterline as a duplicate — so the second placement never appeared, and the
local cache then persisted the stale row through a reload. The receiver now
takes placements off a row it is otherwise rejecting, the way it already fills
an empty participant pile at a pinned waterline. The dashboard's paginated
Channel page had the same gap from the other side and is refetched when the
Space snapshot's `channelCount` moves.

The audits' own verdict was that the branch is proportionate and its
mechanisms are right, so what follows is the short list of places where a
mechanism was not carried all the way through.

**The member walks had no page.** `WorkspaceSpaceStorage.members()` answered
every member Channel in one read while the Channel page beside it is capped, and
each member costs several cross-object awaits — so a Space past roughly a
thousand Channels had an audience change, an archive or a restore that could not
finish, and `resumeIntent` re-read the same uncapped list from the top, redoing
the same prefix on every republish and dying in the same place. The page bound
is `SPACE_BOOTSTRAP_PAGE_SIZE` rather than a new number, because a member walk's
per-Channel cost is the same several-hops shape that bound was derived against;
one walk function serves the request path and the resume, because a request and
its resume that walked differently would be two implementations of one
convergence and the resume is the one nobody watches. A Space under the ceiling
still settles inside the request exactly as it did.

**`restore` staged nothing**, so a restore that died mid-fan-out left the Space
active in every sidebar with half its member Channels holding no source from it,
and `resumeIntent` abandoned it by name. It was the one Space operation whose
half-finished state had no terminal outcome.

**An intent had no durable reason.** The sibling `space_default_targets` has
carried `last_error_code` all along, and an intent's only account of why a resume
kept failing was a log line — so whoever found the unsettled row had the fact
without the reason, which is what
[`naming-a-schema-failure.md`](naming-a-schema-failure.md) exists to stop.

**A settled placement left a wake behind it.** `finalizeSpaceMembership`
re-derived the alarm only when the settlement staged a default of its own, so
every ordinary Channel creation left one WorkspaceDO wake thirty seconds later
that found nothing due. `armNextAlarm` is an exact re-derive and deletes the
alarm when nothing is left, so the settle — the event that removed the reason to
wake — is exactly where it belongs.

**The Slack path could never take the fast path.** It provisioned the
conversation and placed immediately, and a placement addresses the Channel's own
`WorkstreamDO`, which learns the Channel exists from an effect that arrives
later — so `applySpaceAccessSource` was refused `conversation_parent_missing`
every time. That is not a lost placement: a refusal reopens the cutover by
design, so each Slack creation took `spacesReady` away from the whole
Organization and put every member's sidebar behind the opening card until the
walk caught up. It now reserves the parent first, which is the coordinator's own
ordering, and defers its directory delivery until the placement has landed.

**Considered and rejected:** Deriving a staged operation's identity from state
that the operation itself moves. The archive settled its intent at
`${spaceId}:archive:${revision - 1}`, which is two writes in two objects made to
agree by arithmetic; the caller mints one id and hands it to both halves
instead. The same reasoning retired `membershipGeneration: 1` at three fan-out
call sites: a fence this module calls load-bearing, fed a constant that reads as
"generation one" and means "we did not look".

Reading `generalSpaceId()` before reserving General. The check and the write are
two statements and the unique partial index is the decision, so there is no read
in front of the insert at all: every caller reserves, and the one the index
refuses is answered with the Space the winner made. Three callers reach that RPC
and each is a retry of another, so the recovery path is the ordinary one and is
exercised every time.

Re-asking who a socket belongs to when publishing a Space snapshot. Access
revocation closes an open socket through its own queue and
[`access-revocation.md`](access-revocation.md) asks for that not to come back,
so the relationship is read at accept time and pinned on the attachment — which
is also what makes a guest's empty Space payload a property of the socket rather
than a D1 read per publication.

A narrowing planner beside the widening one. It reads as the symmetric thing to
build and it is the wrong shape: a source that
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

A separate `audience` pass in the cutover, after
the memberships, to widen each placed Channel. There is nothing for it to do —
applying General's Organization-wide source *is* the widening, through
`ChannelAccessService` and the Channel's own canonical operation — and running
it second would have meant every fenced Channel was first given a membership and
then found to be unplaceable. The containment preflight moved in front of the
placement instead, so a fenced Channel gets no membership row and no mutation at
all, and the phase slot became `finalize`.

Also rejected: repairing the Project shutdown barrier rather than deleting it.
It asserted that no `pending` Project row was left, counted immediately after
the two statements that settled every one of them, so it read zero by
construction; `finalizeSpaceBootstrap`'s matching `project_effects_pending`
gate ran after the constructor had already dropped the tables. Making either
one work would have held an Organization's whole hierarchy closed over
undelivered Project defaults that PRD non-goal 5 discards on purpose.

Also rejected: dropping the Project tables and letting a queued default fail on
a missing table. The durable half of an at-least-once delivery is exactly what
stops a message still in flight from attaching a resource to a Channel whose
audience this cutover has just changed, so the migration invalidates every
undelivered row in the transaction that drops them and the consumer keeps a
tombstone leg. A barrier asserting the remainder is zero was tried and removed:
it counted rows the statements above it had just settled.

Keeping a direct **Make public to organization** on
the row beside a new **Manage access**. It reads as the smaller change and it is
the one that lies: on a Channel already public through a Space, a row-level
scope toggle describes an audience change that has already happened. Also
rejected: placing a Channel from the launcher by calling `POST /spaces/:id/channels`
after the create. The PRD requires a named Space to be established with the
Channel or the creation to fail without publishing one, and a follow-up call is
neither — so the launcher plumbs `spaceIds` and sends no Space until the
creation contract carries one.

Staging the paged walks as per-Channel rows through
`publishFencedTargets`, the way a default target is delivered. It is the
mechanism already here and it changes the operation's semantics: an audience
change, an archive and a restore would become always-asynchronous, where today a
Space under the ceiling settles inside the request that asked for it and the
caller learns the outcome. The cursor on the intent keeps both — synchronous
under the ceiling, resumable past it — and adds no table.

A `failed` state and an attempt ceiling for an intent. The rule that moves a
default target to `terminal` is a named non-retryable condition rather than a
count, and the intent's mirror of that condition already ends it by name. A
state with no rule that moves anything into it would be dead vocabulary, and a
ceiling is a decision to abandon a half-applied audience change — the team's to
make, not this change's.

A durable gate for the direct narrowing path in `WorkstreamService.update`. At
`66fef78` that path published no revocation at all and nothing durable gated
anything, so the branch's ungated publish is a pre-existing gap it improves on
rather than a regression; building an intent for it is a change with a table
behind it. The gap is recorded in
[`access-revocation.md`](access-revocation.md), which owns it, and among this
document's known limits.

Keeping the per-Channel `recordReceipt` rows for the paged walks. `receipts_json`
is rewritten whole by `json_insert`, so a receipt per member Channel cost O(N²)
bytes in one row and one extra hop into the single-threaded WorkspaceDO per
Channel — for something no resume ever reads, because a resume reads the cursor.
The single-Channel `add` and `remove` intents keep theirs: they have one step,
and the receipt is it.

**Consequences:** A Channel's `spaceIds` and the `channelSpaces` answer are
shaped per viewer, which costs one query per socket on
`publishWorkstreamState` where it used to cost one per publication. The
alternative was a personal Space's id, and through `channelCount` its size,
arriving on every reader's row of a Channel it holds.

Two limits ship known-incomplete and are the next change's to
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

A future change must keep the creation path settling its Space
memberships **before** it reserves the Channel's main conversation. Reserving
arms the parent's recovery alarm, and that alarm delivers the deferred
provisional directory row itself if it wins the race, so a settlement after it
publishes a Channel that is Organization-wide and in no Space — which is what
`space-creation.test.ts` found and now pins. A future change must also keep
`memberships` unreachable except from a `preflight` that recorded nothing, and
keep both re-walks on the claim's retry gate rather than clearing it: an
Organization nobody remediates re-walks about once a minute, and zeroing the
gate would turn that into a spin. Two known gaps stay open: the cutover has no
operator-facing remediation beyond **Add to space** and SQL on the
`space_bootstrap` row, and `"projects"` remains in `WORKSPACE_SYNC_TOPICS` as a
rolling-deploy affordance for clients whose exhaustive maps still name it.

Three limits the desktop work shipped with were closed later
in this same pull request, and are recorded because the reasoning behind each is
still the reasoning that has to hold: `WorkstreamCreationFieldsSchema` carries
`spaceIds` rather than `projectId`, so a Channel started from a Space is placed
in it by the creation contract rather than by a follow-up call;
`GET /spaces/:id/channels` answers Channel rows rather than bare ids, because
`channelCount` is not viewer-scoped and cannot stand in for the Channels a
device has not paged; and the archive refusal carries the Channels that blocked
it, so the confirmation names the sole-member Channel that has to move rather
than describing one. A version 2 local-cache row
is dropped rather than migrated: it holds Channel rows written before `spaceIds`
existed, and a Channel in no Space is a state no surface may render.

A future change must keep `finalizeSpaceMembership`
re-deriving the alarm unconditionally, and must keep any new connector creation
path reserving the Channel's parent authority before it places the Channel —
polling for the parent's directory row is what the development seed route does,
and it is acceptable there only because that route is development-only.
Narrowing a SQLite CHECK after migration 61 ships needs the table rebuild the
retirement graph already does, so the intent vocabulary is fixed in place now
rather than later; the dead `unsupported_${kind}` branch is the exhaustiveness
check that makes a sixth kind fail to compile instead of being abandoned by name
in production. An intent that can never settle republishes on the alarm's
backoff cap forever, one dead-letter message per cycle: what that costs, and
what deciding a ceiling would need, is in "Numbers handed to the team" above.
The latency audit left three suggestions. The first was taken: the creation's
provenance apply and confirm are one call, because the split exists to bracket
the caller's canonical operations and a Channel born into a Space has none —
`initialize` wrote that audience already, so the second hop was a same-object
round trip per Space with nothing in between. It is one *mode* on the existing
RPC rather than a second RPC, sharing the commit body so the revision fence and
the direct-scope seeding cannot drift, and the mode is part of the receipt's
request fence so a redelivery under the other one is refused rather than
converging on the wrong answer;
[`workstream-durable-object.md`](workstream-durable-object.md) owns it. The
other two — deferring the Slack path's inline placement, and the replay path
using the full `addChannel` — are decisions for the team and were deliberately
not taken here.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.
