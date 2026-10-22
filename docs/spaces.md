# Spaces

> **A Space is now the product's Channel.** The navigation redesign
> ([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)) shows each Space
> as a **Channel**: a list of threads (the stored Channels) that a person starts
> from its composer. The rows, ids, links and Slack bindings are the same; only
> the product words moved, and this document keeps the storage ones. What the
> redesign added on the server is under
> [The Channel's reads](#the-channels-reads) and
> [A Space may be private again](#a-space-may-be-private-again).

A **Space** is how an Organization groups its Channels. It carries a name, an
icon and colour, a scope (Organization-wide, or private to its participants), a
participant list, resources and Sidekick recommendations, and every Channel in
the Organization belongs to at least one. A Channel may belong to several at once; each is a *placement* of the
same Channel rather than a copy, so opening any of them opens the same
transcript.

A Space is not a second container implementation. It is Rally's conversation
parent under a role: its parent state is hosted in `WorkspaceDO` beside every
Channel's, keyed by parent id, with the differences enumerated as fields of its
role ([`hosted-conversation-parents.md`](hosted-conversation-parents.md) owns
that). Unlike a Channel it has no conversation: its name, appearance,
audience, participants and defaults are WorkspaceDO rows and nothing else, so
there is no feed, transcript, agent loop or search result to open.

Spaces replace [Projects](projects.md), which WorkspaceDO migration 64 has
deleted. This document describes the Space authority, its service, the one-time
cutover that gave every existing Organization its hierarchy, and the routes over
them; the product design is in
[the Spaces PRD](PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/spaces.ts` | Space ids, the appearance registry, scope, status, system role, summaries, request shapes, `ChannelAccessSources`, and the closed `SpaceErrorCode` union. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | WorkspaceDO's Space tables (migration 63) and the synchronous transactions over them, including the compatibility-capable `workspace_container_order`; the dashboard's conversation page with its live-for-viewer and Channel-visibility SQL; `spaceReachSql` and the `reach`/`canEdit` pair, which render the listing rules in [`listing-rules.md`](listing-rules.md); the reads a dashboard nudge is addressed with; and the `SPACE_CHANNEL_PAGE_SIZE` and `SPACE_BOOTSTRAP_PAGE_SIZE` page bounds. |
| `apps/api/src/durable-objects/workspace-breakout-storage.ts` | The breakout directory and viewer projections (migration 65), and the generation-fenced applies over them. |
| `packages/contracts/src/conversation-attention.ts` | `conversationNeedsViewer`, the one definition of "this conversation still needs you", and the `HarnessStatus` vocabulary it reads. |
| `apps/api/src/durable-objects/workspace-space-protocol.ts` | Strict RPC requests and results, the Queue message shapes, and the `kind` that makes a resource and a Sidekick default one mechanism. |
| `apps/api/src/durable-objects/workspace-do.ts` | The authenticated Space RPCs, the three server-to-server cutover RPCs, the Space branch of the directory apply (`applyDirectoryBatch`), `publishSpaceSnapshot`, the sidebar payload, the three alarm phases, and migration 64, which retires Projects. |
| `apps/api/src/durable-objects/fenced-target-publication.ts` | The claim/send/accept publisher every Space publisher calls. |
| `apps/api/src/durable-objects/workspace-space-default-publication.ts` | The Space's two arguments to it: default targets, and the cutover's next page of work. |
| `apps/api/src/services/space-service.ts` | Creation, presentation, audience, membership, archive, restore, defaults, and the resume of an interrupted operation. |
| `apps/api/src/services/channel-access-service.ts` | A Channel's own scope and readers: the Manage access read, removing a direct reader, and the narrowing announcement a Channel's scope change publishes. |
| `apps/api/src/durable-objects/system-channels.ts` | The Channels Rally makes on its own (General, the Personal Channel) as data: name, icon, colour and the messages each opens with. |
| `apps/api/src/services/space-bootstrap-service.ts` | `seatOrganizationMember`, which puts a member who joins in General and gives them their Personal Channel (see [The Personal Channel](#the-personal-channel)); the one-time cutover, the fallback that opens a new Organization's General when `initializeWorkspace` could not, and the placement the two creation paths outside the coordinator take for themselves. A new Organization's General is normally made by `initializeWorkspace` itself (see [General](#general)). |
| `apps/api/src/services/workstream-object-creation-service.ts` | Where a Channel is born into its Spaces. [`workstream-creation.md`](workstream-creation.md) owns it. |
| `apps/api/src/routes/spaces.ts` | `/spaces` mutations and the two paginated reads. |
| `apps/api/src/routes/workspace.ts` | `PUT /workspace/pinned-order`, the old desktop's Pinned order, kept for older desktops; pins themselves are [`workstream-pinning.md`](workstream-pinning.md)'s. |
| `apps/api/src/routes/navigation.ts` | The new client's reads: `GET /navigation/threads`, `GET /navigation/channel-stats`, the pin routes and the Activity tab. |
| `apps/api/src/queues/activity-consumer.ts` | The `space_default`, `space_intent_resume` and `space_bootstrap` handlers. |
| `packages/ui/src/components/space-icon.tsx` | The mark both hosts draw a Space with. `docs/shared-ui.md` owns the split. |
| `apps/desktop/src/renderer/components/navigation-sidebar.tsx`, `screens/channel.tsx` | The Channels list and the Channel screen (feed, composer, menu). [`desktop-shell.md`](desktop-shell.md) owns both. |
| `apps/desktop/src/renderer/lib/deep-link-navigation.ts` | The renderer-local signal that distinguishes an externally opened Channel from ordinary in-app navigation so the sidebar reveals it once. |
| `apps/desktop/src/renderer/lib/sidebar-list-store.ts`, `use-space-directories.ts`, `workspace-socket.tsx`, `workspace-directory-cache.ts` | The client's Space state: one versioned receiver, the two socket-owned directories, and the local cache slice. |
| `packages/ui/src/components/conversation-menus.tsx` | The Channel menu's Breakout list, newest activity first; a Breakout opens beside Main. |

## How it works

### Three authorities, in one order

A Space is the agreement of three authorities, and `SpaceService` is where that
agreement is ordered. The relationship, the Space's parent rows and each
Channel's parent rows all live in `WorkspaceDO`, but each is still reached by
its own RPC and keeps its own rows.

**WorkspaceDO owns the relationship.** It holds the Space directory projection,
each person's Space order, the many-to-many Channel memberships with their
staged generations, the default registry and its delivery targets, the staged
operation intents, and the General identity. Neither endpoint of a membership
can answer whether a Channel has *another* Space, so the invariant that every
Channel has a home lives here and nowhere else.

**WorkspaceDO owns what the Space is.** Its name and appearance
(`noteSpacePresentation`), scope and participants (`noteSpaceAudience`),
defaults (`addSpaceDefault`), archive and restore are written straight to
`spaces`, `space_viewers` and `space_defaults`, each authorized from those rows.
A Sidekick default also writes the recommendation on the Space's hosted parent,
the list a Channel created in the Space reads, in the same call. Nothing outside
WorkspaceDO holds a copy.

**Each Channel owns its own audience.** A Space grants none (see
[A Space starts Organization-wide and grants no reader](#a-space-starts-organization-wide-and-grants-no-reader)), so a
membership and a restore change only WorkspaceDO's Space tables. Archiving
also requests canonical archival of threads that have no other active Space;
it does not change their audience. The code that once applied a Space's audience to its
Channels is gone; [`space-access-sources.md`](space-access-sources.md) keeps
what it taught.

### Opening a Channel deep link

The hash route identifies a Channel but cannot say whether it came from an
external deep link. `deep-link-navigation.ts` carries that distinction until
the live Space hierarchy is ready. The Channels sidebar walks its existing
directory pager until the target summary is resident, selects one active Space
that contains it, and asks the sidebar to center the Channel's row.
The signal is revisioned so reopening the current Channel works even though its
hash does not change, and is discarded when the reader navigates elsewhere or
the complete directory does not contain the target. Ordinary in-app navigation
therefore never inherits a delayed reveal.

### Creating a Space

The desktop and web **New channel** dialog picks a random colour from
`SPACE_COLOR_KEYS`; other create paths pass their own.

`SpaceService.create` asks `admitSpaceCreation` first, the gate `reserveSpace`
applies (an active non-guest member, Space tables present), so a refused caller
writes nothing outside WorkspaceDO. Then two steps, the second a single
WorkspaceDO transaction:

1. **The D1 anchor** (`claimParentAnchor`), under an id the service mints (or
   the caller's stable creation id): the same `workstream_authority_routes` row
   and anchor a Channel's creation writes, under `parentKind: "space"`, which
   also claims the id against a Channel create naming the same one. No object
   is opened. It comes first so that a failure here leaves nothing any member
   can see.
2. **`reserveSpace`.** WorkspaceDO reads the regional
   authority generation, then in one `transactionSync` writes the Space's
   directory row, its creator's viewer row and order entry, and its hosted
   parent: `parent_metadata`, the main child `0`, and the provisional
   `directory_common` and `directory_user` projections, which the parent applies
   to the Space directory in the same transaction. The Space row is written at
   **source version zero** and the parent's projection supersedes it at version
   one under the ordinary generation-then-version fence, so version zero never
   commits. An id WorkspaceDO already
   hosts as a Channel is refused `space_not_found`; an authority generation D1
   cannot supply is `space_authority_unreachable`.
That transaction is the whole Space, so a creation either lists it or leaves
nothing but an anchor, and there is no take-back.

Internal setup callers may pass a stable creation id to `SpaceService.create`.
The reservation reuses that identity, and the main child reservation reuses
substream `0`. The reservation reports whether it was newly created;
an inaccessible existing identity is refused as `space_not_found`, never inserted
again. The service refuses a replay whose name, audience or appearance
changed, rather than rewriting an existing Space. Ordinary client creation still
allocates its id; the HTTP request does not expose this option. Demo setup uses
operation-derived ids so retries and two Channels in one Space agree; see
[demo workspaces](demo-workspaces.md#space-placement-and-replacing-older-demos).

### The icon Rally chooses

A request with no `iconKey` asks Rally to choose. The Space is reserved at once
under `circle-dot`, the catalog's neutral mark, and `SpaceService.chooseIcon`
runs after the response (`waitUntil` on the route): the Channel naming call
(`chooseSpaceIcon` in `workstream-naming-service.ts`) reads the Space's name and
answers a key from the same catalog. The pass writes it through
`noteSpacePresentation` with `ifRevision` set to the revision creation returned,
so the write lands only if nothing about the Space moved since. A rename, an
icon a person picked, an audience change or an archive each advance the
revision, and the generated icon stands down rather than undo any of them. The
new icon reaches clients by the ordinary Space snapshot over the workspace
socket.

The service's optional initial `participantUserIds` uses the existing audience
mutation before scheduling icon selection. That creation-time audience change
is included in the captured revision; later user edits still fence the pass.

Only a newly reserved Space gets a pass; a replay of a stable creation id does
not, and skips the icon in its "same Space?" comparison, because the first
attempt's pass may already have written one. The desktop sidebar's **New
space** sends no icon; a caller that sends one keeps it.

### A Space may be private again

The section below described the rule from migration 94 to the navigation
redesign. A Space may now be private (`personal`) through an audience change:
`UpdateSpaceAudienceRequest.scope` accepts both values again, while
`CreateSpaceRequest.scope` still reads every creation as `workspace`, so every
Space starts Organization-wide — including one created by an older desktop
that sends `personal`. A private Space is listed to its participants alone; the
rule is in [`listing-rules.md`](listing-rules.md). General refuses `personal`
with `space_protected`, because it is every Channel's fallback home. Making a
Space private still grants and removes no reader of any Channel in it, and only
a participant may place a Channel into it (`canEdit`). Guests are shown only
Organization-wide Spaces through `sharedNavigationSpaces`.

A participant leaves a private Space by sending its audience without
themselves; any participant but the last may take themselves out, and only an
owner or admin may take out somebody else. The last participant stays: the
people menu disables removal at one person, as it does for a thread, and
`UpdateSpaceAudienceRequestSchema` requires at least one participant. The Space then no longer exists for them, so
WorkspaceDO answers `{ ok: true, left: true }` and `PATCH /spaces/:id/audience`
answers `204` rather than a summary. The desktop adds the actor to the list only
when they turn **Public to organization** off, so that the person making a
Channel private is not locked out of it; their **Leave the channel** sends the
list as it stands. Leaving and removing somebody both ask first, in the same
dialog a thread uses (`RemoveParticipantDialog`).

### A Space starts Organization-wide and grants no reader

A Space (the product's Channel) starts Organization-wide and becomes private
only through an audience change, and in either state it grants no reader to the
threads in it. A thread's audience is its own scope and participants, so a
private thread can sit in any Space, and **Make private** works on a thread in
General. The Space's participants are its listed members, not who reads its
threads: a Space never adds, removes or acts as a thread participant, and every
thread starts with only its creator plus whoever the creator adds. Any active
member may edit an Organization-wide Space; a private one is edited by its
participants.

The contract says so: `CreateSpaceRequest.scope` is `SpaceCreationScopeSchema`,
which reads `personal` from an older desktop as `workspace`, so a creation is
always Organization-wide. `UpdateSpaceAudienceRequest.scope` is
`SpaceRequestScopeSchema`, which accepts both. History: WorkspaceDO migration 94
(`SPACE_PUBLIC_ONLY_MIGRATION`) had widened every Space and opened editing of
formerly private ones to every member, before private Spaces came back as
private Channels. That migration widened every Space, archived ones included,
and touched no Channel: a Channel
that was private through a private Space keeps its seated participants and stays
private. Those seats are ordinary grants now, and removing one revokes it. The
widening does not step a Space's revision, so an add staged against it still
settles. Two things go with the widening. A private Space's resource defaults
are retired, because they were checked against its participants only and any
member can now start a Channel that picks them up; a Sidekick default was
already Organization-wide and stays. And the four hosted-parent tables that
recorded which Space supplied which reader are dropped, receipts included, so
nothing can replay a widening or narrowing the old rule decided.

Because a Space supplies no audience, a create that names none is born with the
scope its caller asked for. `POST /workstreams` asks for `workspace`, so a
Channel somebody starts in Rally is public; an internal caller that names
nothing gets the fail-closed `personal`. A create receipt the previous Worker
hashed as `personal` is replayed by a `workspace` retry. A Slack room's Channel takes the room's
privacy, and a private room past the member-count promotion becomes
Organization-wide (see [`external-conversation-bindings.md`](external-conversation-bindings.md#rooms)).

### The retired hidden conversation

A Space created before 2026-09-26 also has a main conversation object, which
used to hold its title, scope, appearance, participants and resource links and
publish them to WorkspaceDO as `directory_common` and `directory_user` effects.
Nothing writes or opens those objects now, and no new Space gets one. A
directory effect one of them still had in flight reaches the Space's hosted
parent, which records its receipt and applies nothing (`HostedParent.applyChildEnvelope`),
so a stale title, scope or roster cannot overwrite the Space. The objects sit
idle; retiring them, and the `SubstreamAgent` guard that refuses a Space parent
an agent loop, is left for later.

**A failure on the path to a Space's authority is named
`space_authority_unreachable`.** The seam is now the D1 anchor at creation, the
one Space step outside WorkspaceDO. A rejection there that is not its own
refusal arrives with no code on it, and used to reach a person as
`internal_error`. `SpaceService.throughSpaceAuthority` is the one
place that names it; a refusal the object *chose* keeps its own code.

### Membership

A membership records where a Channel is placed and changes no reader, because
[a Space grants none](#a-space-starts-organization-wide-and-grants-no-reader). Adding a Channel that
already exists is one call, `addSpaceChannel`, and one WorkspaceDO transaction
(`WorkspaceSpaceStorage.addMembership`): it checks the caller may edit the
Space, writes the membership active, and stages every current default for the
new member. A Channel being created is placed by its own reservation instead
(see [A Channel's first Space](#a-channels-first-space)). A refusal comes back
to the Worker as a structured refusal rather than as a bare `Error` across the
RPC.

Adding a Channel a Space already holds is the same path and succeeds at the
generation the row already has: a retry, and two people dragging the same
Channel onto the same Space, are ordinary rather than a 404.

Removing one is the same shape in reverse (`removeSpaceChannel`,
`WorkspaceSpaceStorage.removeMembership`), with one refusal in front of it:
`space_membership_final` preserves the invariant that every Channel has a home.
A move and a restore are likewise one transaction each.

**A Channel archive archives its exclusive threads.** In one WorkspaceDO
transaction, `WorkspaceSpaceStorage.archive` captures live threads whose only
active Space is this one, archives the Space, and records one durable archive
intent per exclusive thread. Shared threads remain active in their other
Channels. An unreadable or not-yet-projected exclusive thread refuses the whole
operation without exposing its identity or partially archiving the Channel.
General and Personal Channels remain protected.

Each thread intent reuses the normal idempotent `applyQueuedBatchUpdate`
archive command in its Main SubstreamAgent. That command stops execution and
publishes the canonical archive through the existing parent/directory effects,
including owned-agent and Sidekick cleanup. The request attempts delivery after
arming the retry alarm; failures remain in `space_intents` for the existing
alarm handler. A lost reply replays the same receipt, so a thread manually
restored afterwards is not archived again by an old delivery.

An exclusive thread retains its membership under the archived Space, preventing
the orphan-repair backstop from moving it to General while effects are in
flight. Shared memberships stage to `removing` as before. Restoring a Channel
restores its placements; it does not unarchive the independently archived
threads. There is no move into General and no General defaults applied.

**A placement moves a thread's colour.** For now a thread and its Breakouts
store the colour of the thread's canonical Channel. Triggers on
`space_channel_memberships` and `spaces` mark the thread whenever a placement
or a Channel's colour, archive state or scope changes, and WorkspaceDO writes
the colour into each conversation afterwards; none of the operations above
does anything for it. The mechanism is
[`workstream-appearance.md`](workstream-appearance.md)'s.

**Legacy intents.** Before the Space-source code was removed, these operations
staged a `space_intents` row and finished in a second transaction. A row
staged before the deploy is finished by the alarm in one transaction
(`resumeLegacyIntent`); nothing stages new ones.
A person who may read a Channel or one of its Breakouts may always discover the
presentation metadata of every ancestor above it, so a remaining Space does not
need that person on its own roster. This associative reach exposes only name,
icon, colour and public/private scope; it grants no Space participation, content,
defaults or write capability.

### Participants

Changing a Space's participants is one WorkspaceDO write (`noteSpaceAudience`): the
scope is always `workspace`, and no Channel is asked or walked, because the
Space grants none of them a reader. Removing *somebody else* is an Organization
owner's or admin's to do, and `participant_removal_denied` refuses anybody
else. The revision still advances, so a staged membership fenced on the old one
re-reads the Space.

**Invitees.** A participant is a user id, which someone invited to the
Organization does not have until they accept. The same write may carry
`inviteeEmails`, the whole set of pending invitees the Space lists by address;
absent leaves the stored set as it is, which is what an older client sends.
`SpaceService` refuses an address with no pending Organization invitation
(`space_invitee_not_invited`), and an invitee is taken out under the
participant rule. They live in `space_invitees` (WorkspaceDO migration 96) and
are read through `GET /spaces/:id/invitees`, not on the summary: the summary is
a strict object, and every shipped desktop would drop a Space snapshot carrying
a field it does not know. Accepting the Organization invitation calls
`seatSpaceInvitee` with the address it was sent to, which in one transaction
deletes that address's rows, makes the person a participant of each active
Space that listed them, advances those revisions and publishes the snapshot.
The membership is read from D1 there, not from the object's copy, which can
still say guest until the relationship delivery lands. A failure is logged as
`space_invitee_seat_failed` and leaves them out of those Spaces; an address
listed only in an archived Space is dropped without seating. The desktop shows
only listed addresses whose invitation is still pending, so a revoked or expired
one disappears without a write.

### Per-person ordering

**No list is arranged by hand except Pinned.** The Channels list sorts A–Z,
Recent or Needs attention, a Channel menu lists its Breakouts by latest
activity, and the Pinned parts of each sidebar section are ordered in
`workspace_pins` ([`workstream-pinning.md`](workstream-pinning.md)). The
current client reads none of the snapshot's `ordering`, `pinnedOrder` or
`spacesReady`, and never calls `PUT /workspace/order`. The server still sends
them and still serves the route, because released desktops parse the snapshot
with `ordering` and `spacesReady` required and would drop every snapshot
without them. They go when no build that reads them is in the field.

`workspace_container_order` stays. It is keyed by `(user_id, container_kind,
container_id, item_id)` with a `position`, one mechanism for the three
containers a person once arranged by hand (`organization`, `space`,
`channel`). The Space directory still reads through the `organization` rows,
so every visible Space is appended there on read and a cancelled Space
reservation deletes its row. A Channel leaving a Space deletes that Space's
`space`-kind row for it. Archiving takes nothing. No shipped client reads
the stored order any more, and nothing but the directory's own append writes
it, so a later change may drop the table with the directory join it feeds.

`PUT /workspace/pinned-order` (`workspace_pinned_order`, migration 87) stays
for older desktops; [`workstream-pinning.md`](workstream-pinning.md) owns it.

### Defaults

A resource and a Sidekick recommendation are one mechanism with two consumers,
keyed by `kind` through every row and every message. `addDefault` attaches the
thing to the Space's own authority — the attachment a person sees — after
checking that every effective reader can reach it, then registers it in
WorkspaceDO, which is what stages, fences and settles delivery.

A Sidekick target is written in the same transaction that stages it, by
`addDefault`, `stageDefaultsForMember` (a Channel joining) or a membership move:
the member Channel's `parent_sidekicks` row is in WorkspaceDO's own SQLite, so
the target is marked `applied` and nothing is published. That needs the
Channel's parent hosted here (a `parent_metadata` row),
not archived, and the Sidekick live and workspace-scoped in
`automation_directory`, and the requester able to manage the Channel;
otherwise the target takes the Queue as before. Management is asked in place
the way `setSidekickRecommendation` asks it (a grant on the Channel, or the
participant rule before the grant handoff), from the Organization's relationship
table and the Channel's rows, so it is SQL in the same transaction. It has to
be asked: an Organization-wide Space admits any active member, and a default's
instructions become a skill in every agent in the Channel, including personal
and restricted Channels that member cannot manage. A requester the relationship
table has not heard of, or a refusal, takes the Queue, whose canonical path
asks again and records the reason on the target. Open Sidekick lists are refreshed with
the `automations` sync topic after commit.

Resource targets, and Sidekick targets that did not qualify, are published
through the outbox onto the activity Queue; the consumer rechecks the default
generation, the membership generation and the Space's lifecycle before
attaching through `WorkstreamService.attachResource` or
`setSidekickRecommendation`. A resource keeps the Queue because attaching one
writes the Channel's main conversation, a `SubstreamAgent`.

**A delivery acts as the person who staged it**: whoever put the Channel in the
Space, or added the default. It never acts as a Space participant, because a
Space's roster has no say over its Channels. A requester who is no longer an
active member leaves the target `terminal` with
`space_default_requester_inactive`.

Removing a default advances its generation, which makes every queued target
stale. It does **not** detach it from Channels that already have it: a Channel's
transcript and execution context were built with it.

The desktop Space landing page does not list or edit these defaults, add an
existing Channel, or start a new Channel. The inheritance and Channel-placement
mechanisms and their APIs remain, but the landing page is deliberately a view
of the Channels in the Space rather than a management surface. Defaults that
were configured before this change continue applying to current and future
member Channels; there is currently no desktop surface to inspect or change
them. Retiring that durable behavior would be a separate product decision, not
an incidental consequence of removing its landing-page controls.

### General

`openGeneralSpace` with an id reserves the Organization's one General Space
(named General, Organization-wide, `system_role = 'general'`) with its hosted
parent, or answers with the existing one. It is idempotent, and the unique
partial index on `system_role` is what decides a race between two callers rather
than a check-then-write: there is no read in front of the insert at all. Every
caller reserves, the index refuses all but one, and the loser is answered with
the Space the winner made, re-read outside the transaction its own statement
aborted. Every caller is a retry of another, so the second one through is the
ordinary path rather than the exception.

**`SpaceService.ensureGeneral` is the one caller, and it takes `create`'s steps
in `create`'s order.** It first asks `openGeneralSpace` with no id, which only
answers: General, or `absent`. That one RPC is the whole cost for every caller
after the Organization's first. On `absent` it writes the D1 anchor under a
fresh id and asks again with that id, and WorkspaceDO creates General and its
hosted parent in one transaction; the unique partial index still decides a
race, the loser is answered with the winner's General and its anchor names an id
nothing else will. Everything that needs General (the cutover, a Channel created without
a Space, the connector path) goes through it, so the steps
are never half-done by somebody re-deriving them.

**A new Organization takes the same steps in fewer calls.** The regional create
already knows General is absent, who its creator is and the authority
generation, so it writes General's anchor in the batch that creates the
Organization and passes it to `initializeWorkspace`. The object then checks the
creator the way `openGeneralSpace` does, reserves General under that id through
the same `reserveGeneral` step, and closes the cutover, all in that one call.
It answers `spacesReady`; anything short of `true` (the authority closed, a
guest creator, an authority mid-migration, a cutover that cannot close) sends the caller to
`openGeneralSpaceForNewWorkspace`, which is `ensureGeneral` as above. The
Space half of the call is best effort, as that function is: a failure there is
logged as `space_general_open_failed` (a refusal as
`space_general_open_refused`, with its code) and answers `false`, so it never
fails an Organization whose rows are already committed. An
Organization whose cutover is already complete answers `true` without any of
this, so activating one costs the one call and no D1 read for Spaces.

### The Personal Channel

Every active member who is not a guest is a participant of General and owns
one **Personal Channel**: a Space named "Your Personal Channel" whose scope is
`individual`. Nobody chooses that scope. `CreateSpaceRequest` and
`UpdateSpaceAudienceRequest` take `AudienceScopeSchema` (`personal` or
`workspace`), and only the seating below writes `individual`.

**What the scope means.** A Personal Channel is listed to its owner and
nobody else: not an Organization owner or admin, not somebody who can read a
thread placed in it (no private Space is reached through a thread), and not
anybody given a participant row by mistake. `spaceListedSql` checks
`created_by_user_id` rather than the viewer row for this scope. A guest has no
Personal Channel: seating refuses guests, and an owner who becomes a guest
stops being listed theirs until they are a member again. Its audience never
changes: `noteSpaceAudience` refuses it `space_protected`, so nobody is added,
it is never made public, and its owner cannot leave it. `archive` refuses it
the same way. Its owner may rename and recolour it. A thread started in it is
private, as in any Channel that is not Organization-wide
(`resolveSpaceWorkstreamStart` narrows on `scope <> 'workspace'`). Its hosted parent's
`parent_metadata.scope` is `personal`, the thread vocabulary for "its
participants". `spaces_individual_owner_idx` holds one per member.

**When it is made.** Three paths, all idempotent:

- **Creating an Organization.** `createOwnedWorkspace` writes General's anchor
  and the creator's Personal Channel's in the batch that creates the
  Organization, and `initializeWorkspace` reserves both in the same object
  call. The creator is General's creator, so already its participant.
- **Anyone becoming an active member** (accepting an invitation, a guest
  promoted, the creator's own first relationship event). The relationship
  change handler (`applyWorkspaceRelationshipChange`) calls
  `seatOrganizationMember` last. WorkspaceDO checks its own copy of the
  relationship, seats the person in General and in their Personal Channel if it
  exists, and answers `absent` when it does not; the service then writes the D1
  anchor and asks again with the generation, as `ensureGeneral` does. A failure
  throws, so the relationship delivery retries; every step is fenced against
  applying twice. An Organization whose Spaces are not open answers
  `spaces_not_open` and the delivery settles; when the cutover closes the
  object queues the same seating pass as the backfill
  (`seatEveryoneOnceSpacesOpen`), so somebody who joined meanwhile is seated
  then, and no delivery waits on a cutover that may never close.
- **Every Organization that existed before this** (WorkspaceDO migration 103).
  The migration queues one `personal_channel_backfill` alarm in each object
  with an identity. The alarm reads the active non-guest members from D1, and
  for each one the object's own relationship copy still calls a member, seats
  them in General, writes their Personal Channel's anchor and reserves it. A
  throw retries the whole pass, which redoes nothing. While the Spaces are not
  open the pass settles without seating anybody, and closing the cutover
  queues it again (`seatEveryoneOnceSpacesOpen`).

The Personal Channel's id is `stableUuid(["personal_channel", workspaceId,
userId])`, so the creation path and the relationship event name the same
Space. A member who leaves loses their viewer rows (`applyMemberStatus`); the
Space stays, and seating them again on return makes them its participant
again.

**Older desktops.** A desktop before client contract 5
(`INDIVIDUAL_SPACE_CLIENT_CONTRACT`) parses Space summaries strictly and would
drop every snapshot holding `individual`. The workspace socket ticket records
whether the build reads it (`ind`), the edge forwards that as
`x-rally-socket-reads-individual-spaces`, and `spacesFor` and the `/spaces`
routes serve such a build `personal` through `spaceScopeForClient`. A native
client that declares no contract is served `individual`, as
`requireCurrentClientContract` admits it.

**Rollout.** A migration runs when its object next wakes, so an Organization
nobody opens is backfilled when somebody does. To backfill the whole fleet at
once, force a WorkspaceDO migration from `/migrations`
([`durable-object-migration-tracking.md`](durable-object-migration-tracking.md)).

### Channel messages

A Channel holds messages of its own, outside any thread: a building block
beside its placements, for anything that has something to say in a Channel.
A message is an author (`rally`, or a `member` by user id), a markdown body
and a time, in `space_messages` (WorkspaceDO migration 104). Nothing in the
mechanism knows what a message is for.

- **Posting joins the author.** A member who posts a Channel message becomes a
  participant of that Channel. Starting a thread from the Channel composer also
  joins its author to the Channel; it remains a separate participant of its own
  thread. Rally messages do not subscribe anyone.
- **Posting.** `postMessage(spaceId, draft, postedAt)` writes one, and
  `postMessages` maps it over a list. A draft may carry a `key`; the message id
  is then derived from the Channel and the key, so the same key posts once and
  a retry writes nothing. Without a key every post is new. Four more options,
  from migration 109, each generic:
  - `replace` makes a keyed repost rewrite the body and author and move the
    message to the bottom (a fresh `posted_at`) instead of writing nothing.
  - `news` (default true) gives the message the Channel's next attention
    ordinal, so it lights the dot; see [the read state](#the-channels-read-state).
  - `sourceWorkstreamId` names a thread the message is about. The feed then
    shows it only to who can open that thread.
  - `embeds` stores `[{id, title, kind}]` for the artifacts the body embeds,
    and `operationId` the operation that last wrote the row, so a retry of the
    same operation writes nothing and takes no ordinal.
- **Opening a Channel with messages.** `reserve` takes `messages` and posts
  them in the transaction that makes the Channel, through
  `postStartingMessages`: dated at the Channel's `created_at` so they come
  first, and keyed by position so posting the same list again writes nothing.
  The same call lets a Channel made before it had them catch up, which is how
  migration 103's pass gives an existing General what General opens with.
- **What the Channels Rally makes open with** is data in
  `system-channels.ts`: General and the Personal Channel each have a name, an
  icon, a colour and a list of messages, today one from Rally apiece. Changing
  what one says, or adding a second message, is an edit there, and reaches
  only Channels made after it: a message is keyed by its position, and a key
  already posted writes nothing, so an existing General keeps the words it
  opened with, and a message added at a new position is posted only when
  something calls `postStartingMessages` for that Channel again.
- **In the feed.** `feedPage` reads a Channel's messages under the same seek
  as its placements and merges the two by time, then id, so one order runs
  across both and a cursor ending on either kind resumes correctly. A message
  that is news carries `attentionSequenceNumber`; an opening message and every
  message before migration 109 carries none. Whoever may read the feed sees
  its messages, except a message about a thread they cannot open, which the
  message seek filters with the placement seek's own `mainOpenableSql`
  through a primary-key join. A desktop before client
  contract 6 (`CHANNEL_MESSAGES_CLIENT_CONTRACT`) parses the feed union
  strictly, so `GET /spaces/:id/feed` leaves message items out for it. The
  desktop draws a message as its author speaking, on the leading side, with
  the renderer a thread's messages use.

A thread's merged result is the first caller from outside WorkspaceDO
(`mergeThreadIntoChannel`, `removeChannelMessage`), and a desktop before client
contract 7 (`CHANNEL_MERGES_CLIENT_CONTRACT`) is served each merge as a plain
message without `merge` or `attentionSequenceNumber`. A merge from a thread the
reader cannot open is shown without the thread (`merge.private`), and a desktop
before contract 9 is served the feed without it. That feature is
[`conversation-merge.md`](conversation-merge.md).

### The cutover

Every Organization that predates Spaces has to end up with a hierarchy, and
**the PRD requires the fleet migration to finish without relying on user
access**. So nothing about this hangs off a request. `space_bootstrap` is one
row per Organization, seeded `pending` by migration 63 and driven by the
WorkspaceDO alarm: the migration tracker's forced pass wakes every object, the
alarm claims one page of work, and the activity Queue carries it to
`SpaceBootstrapService`.

The phases are ordered, and the alarm claims exactly one at a time because a
page's cursor is only known once the page before it has been reported:
`pending` → `general` (make the Organization's General Space) → `preflight`
(walk the Channel directory in pages asking whether each Channel has somebody
to act as, and write nothing) → `memberships` (walk it again, placing each
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

**The cutover acts as a person, per Channel.** A placement is the same
WorkspaceDO step a person adding a Channel takes, and it authorizes an actor. A
personal Channel admits only its own participants, so each
placement runs as one of *that Channel's* active participants; an
Organization-wide Channel is acted on by the Organization's driver, chosen
owners-first from active members. A Channel with no active participant left is
recorded as blocked with `space_bootstrap_no_active_actor` rather than forced,
because there is nobody the disclosure could honestly be attributed to.

**Every blocker is found before any Channel is placed.** The PRD's Existing
Organizations section says an unsafe Channel blocks its Organization "without
partial mutation", and rollout step 3 asks the preflight to identify every
blocker before promotion. So `preflight` asks the question a placement asks
(is there an active person to act as) over the same page, the same cursor and
the same claim machinery, and writes nothing. `memberships` is claimed only when
that pass recorded nothing; a pass that recorded something goes to `finalize`,
which reports. `SpaceBootstrapService.admit` is the one implementation both
passes call, and `place` calls it again at the moment of the mutation.

**A blocker is not a retry.** Placing a Channel in General widens nothing,
because a Space grants no reader, so the content fence no longer applies here.
The one blocker is a private Channel with no active participant
(`space_bootstrap_no_active_actor`). It gets no membership row and no mutation,
and the Organization stays short of `complete` until somebody gives it a
participant or deletes it: `spacesReady` stays false and the operator sees the
Channel id on the row. A `preflight` page also reports the Channels it found
*clear*, which takes their blockers off the row: it is the pass that notices a
remediation.

`finalizeSpaceBootstrap` is the close, and it refuses three ways. Both
refusals that leave the cutover open send it **back to the walk**, because the
walk is the only thing that changes any of the facts it refused on. `unplaced`
— a Channel that arrived after the walk passed its id, which a late directory
projection can do — is new work, so the pass restarts with its gate cleared.
`blocked` re-walks through `reopenBootstrap`, which keeps the claim's retry
gate: the preflight reports the Channels it now finds clear, a still-blocked
one is re-recorded, and an Organization nobody remediates re-walks on
`scheduledAlarmRetryDelay`'s interval — about once a minute — rather than
spinning. Leaving the phase at `finalize` instead, which is what this did
first, made a blocked Organization permanent: nothing else takes a Channel off
`blocked_json`, so `spacesReady` stayed false and the opening card stayed up
however the Channel was remediated.

[`runbook.md`](runbook.md) holds the operator's version.

Two paths place a Channel outside a page, and both are the same step a page
would take. Opening General and closing the cutover runs inline on the path that
initializes a new WorkspaceDO, inside `initializeWorkspace` itself when the
create hands it General's anchor and through `openGeneralSpaceForNewWorkspace`
otherwise: the alarm would get there within a Queue round
trip, but the first session inside that window would be shown the
Organization-opening card for an Organization that has nothing to open. It is
best effort on purpose — a Space failure must not cost somebody the Organization
they just created, and the alarm is the backstop running the same code.
`placeConnectorChannelInGeneral` covers the two creation paths that do not go
through the creation coordinator: the Slack agent, when it opens a Channel for a
Slack member with no Rally identity in a room that is not linked to a Space and
provisions the conversation itself, and the local development seed route, which restores a captured fixture into objects
it provisions under the ids the fixture chose. **A refusal there reopens the
cutover** rather than only logging: a `complete` Organization is never walked
again, so a Channel this step could not place would stay homeless for good. The
walk reaches it with the Organization's own directory projection — which knows
participants the connector's record may not — and the Organization is not
`spacesReady` while that runs, which is the honest answer for an Organization
holding a Channel in no Space.

**Both of those paths have to make the Channel's own authority exist before they
place it**, which the coordinator gets for free by reserving and placing in one
transaction. A placement addresses the
Channel's hosted parent in `WorkspaceDO`, which learns the Channel exists
either from `reserveChild` — which writes its identity row synchronously — or
from an effect that drifts up the conversation's outbox some time later.
Provisioning the conversation alone and placing immediately is refused
`conversation_parent_missing` every time, and because a refusal reopens the
cutover, that is not a lost placement but every member's sidebar behind the
opening card until the walk catches up.

The Slack path calls `reserveChild` first, as the coordinator's one call does
before `initialize`, and defers the provisional directory delivery until after
the placement so the Channel is never listed while it is in no Space. A Slack
room linked to a Space is different on both counts: the Channel is reserved
straight into that Space with `reserveChannelInSpaces`, acting as the Space's
creator, and General is never involved.

**A Slack room can create a Space.** Inviting the workspace bot to a room calls
`linkExternalRoom`, which writes an Organization-wide Space for the room, seating
nobody, and the room's binding in one transaction, under an id derived
from the room so a racing invitation reads the same Space back.
[`external-conversation-bindings.md`](external-conversation-bindings.md) owns
the link. Nothing
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
memberships and the row commit in one transaction, so the row can only arrive
placed; on a connector path the reservation comes *before*
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
means General. **The whole Organization-side birth is one WorkspaceDO call,
`reserveChannelInSpaces`, in one transaction**: it resolves General, writes each
membership straight to `active` (`WorkspaceSpaceStorage.enterMembershipAtBirth`),
stages every current default for the new member, reserves the Channel's parent
with its provisional directory row.

There is no `joining` row, no `add` intent and no cancellation on this path,
because nothing runs between the stages any more: every row the staged calls
wrote lives in this one database, so a Channel is never listed outside a Space
and a refused Space leaves nothing behind. Adding a Channel that already exists
is `addSpaceChannel` instead, which observes the Channel between the plan and
the commit. The one case the call cannot finish
alone is an Organization with no General yet: making one
provisions General's own conversation, so the call answers `general_missing`,
the coordinator runs `SpaceService.ensureGeneral`, and asks again.
[`workstream-creation.md`](workstream-creation.md) owns the ordering.

### Resuming an interrupted operation

Every Space operation is now one WorkspaceDO transaction, so none can die half
way and none stages an intent. The resume path is left for `space_intents` rows
staged before that change.

**The alarm finishes a legacy intent in place, one transaction per intent.** It
claims unsettled intents, advancing their retry gate first, and runs each
through `WorkspaceSpaceStorage.resumeLegacyIntent`, as the requester read from
`workspace_member_status`. An `add` activates its `joining` row and stages the
Space's defaults for it; a `remove` settles the removal; a `move` switches both
memberships, or cancels as `move_superseded` when a competing move won; an
`archive` finalizes the archive, or puts its memberships back and settles
`archive_abandoned` when it cannot; a `restore` or `audience` intent only
settles, because the Space write already happened and there is nothing to carry
to a Channel. An intent a request or a Queue delivery is running is skipped (an
in-memory single-flight keyed by operation id, `spaceIntentRuns`).

A requester who has left the Organization has nothing run as them: the alarm
and the Queue consumer both leave the intent pending with
`space_intent_requester_inactive` on the row. Every such intent was staged
before migration 94, and nothing stages one now. An `archive` intent still asks
`canEdit` as it finishes, so one whose Space has gone private since finishes
only for a participant and is otherwise taken back as `archive_abandoned`. A
resume that fails for any other reason records its code on the row and
logs `space_intent_resume_failed`, and the advanced retry gate brings it back.

Nothing publishes `space_intent_resume` any more. The consumer still accepts
every kind, so messages already on the Queue finish: it calls
`resumeSpaceIntent` until the intent stops progressing, which is the same
in-place path.

### Reads

Space state comes down the workspace socket, not over HTTP, and there is no
second read path for a test to use either — the directory is asserted through
the same payload a client is handed. The connect payload
carries `spaces`, both directories at one waterline and shaped for the
viewer, and every Space write republishes them to every subscribed socket. A
read acknowledgement or a pin write changes one person's view only, so it
sends that person's sockets a small per-person frame rather than a whole Space
snapshot, and `channelStats` do not ride the broadcast snapshot at all. There is deliberately no `GET /spaces`: a client that fetched
one would hold a second answer to a question the socket already answers, and the
two would disagree across a mutation.

Both payloads are shaped for the viewer in two ways. **A guest
gets the same directories by the same rules**, with Organization-wide scope
admitting nobody: the Spaces they take part in or reach through a Channel they
may list ([`listing-rules.md`](listing-rules.md)). The relationship is read at
accept time and pinned on the socket attachment, because nothing re-asks on the way out — an open socket
is closed by the access-revocation queue rather than by a publisher querying D1
again. And a Channel's `spaceIds` name only the Spaces *that* viewer may see,
which is the section below.

### Who may see a Space, and why

**Three ways, and the third is what makes the hierarchy true of every Channel a
person can read.** `spaceListedSql` in `listing-rules.ts` is the one text;
every query that decides this renders it.

1. The Space's scope is `workspace`, so every active member of the Organization
   reaches it. A guest never does.
2. This person is one of its participants.
3. This person may list a Channel placed in it — an **active** membership whose
   Channel directory row is not archived and passes `channelListedSql`: its
   Main is theirs to open, or a Breakout in it is.

The third exists because without it a Channel in somebody's participants-only
Space is drawn under no Space at all for every *other* reader of that Channel.
Every Channel belongs to at least one Space and the sidebar's whole job is to
say where each one lives, so such a Channel fell out of the hierarchy into
**Other channels** — a flat list whose only purpose was to keep it reachable —
and the product could not say the obvious thing: it is in that Space.

**The third clause makes a Space's visibility move on an event nothing used to
republish on.** The first two change only when the Space itself does, and every
Space write already republishes the snapshot. The third changes when a
*Channel's* viewer row does: taking somebody out of the last Channel that
reached them into a Space takes the Space with it, and putting them into one
brings it. `applyWorkstreamDirectoryEffects` therefore republishes the Space
snapshot to exactly the people whose participation moved in that batch — the
per-user `publishSpaceSnapshot(userId)`, not the whole-Organization one, because
this is one person's relationship to one Channel and a broadcast rebuilds both
directories per socket for a snapshot everybody else already holds. Only
participation, never an unread count or a mention: those arrive on every
message, and the Channel half of the predicate is `scope = 'workspace' OR
is_participant`. And only when one of the Channels is in a Space at all, the
same membership test that keeps the archival republication off the sockets.

Without it the withdrawn Space kept its mark and name on that person's sidebar
until they reconnected — and the desktop mirrors the snapshot into its local
cache, so the name survived an app restart. Nothing was ever *readable*: every
server-side predicate is live. The name is the disclosure, and it outlived the
reach that justified it.

**What that discloses, and what it does not.** `SpaceSummary.reach` names why
this viewer can see the Space: `participant`, `organization`, or
`through_channel`. The strongest relationship wins, so a participant of an
Organization-wide Space reads `participant`; only `through_channel` changes
what a surface may draw, and the other two are told apart because "you are in
this Space" is a fact "everyone is" does not imply. It is computed as a column
by the query that selects the row — three comparisons over columns already
joined — rather than asked per summary, which would be one more statement per
Space per socket publication.

A `through_channel` viewer's summary carries the id, name, icon, colour, scope,
status, system role and revision, and **nothing else**: `participants` empty,
`defaultResourceIds` and `defaultSidekickIds` empty, and a `channelCount` taken
over the Channels *that viewer* can see. One summary shape with fields emptied
rather than a second schema — empty is a state each of those fields already
has, and a second shape is a second thing every reader has to branch on.

The narrowed count is not a rounding of the disclosure; it is the disclosure
this rule would otherwise make. `spaceIdsByChannel` shapes a Channel's
`spaceIds` per viewer precisely so that a personal Space's id, *and through
`channelCount` its size*, does not ride a Channel row to every reader. The id
now does ride it, on purpose; the size still does not.

**A `through_channel` reach implies an active Space.** An archive stages every
membership out of `active` before it commits, so nobody reaches an archived
Space through a Channel in it — and nothing draws a Channel under an archived
Space, so there would be nothing for its mark and name to explain. The inactive
list renders the same visibility text anyway, so a future change to what an
archive stages carries here rather than being re-derived. A Channel whose every
Space is archived therefore stays in **Other channels**, with the Channels of
an Organization that is still opening.

**Every write is refused, by name.** Each storage predicate that decided "may I
see this Space" was also the whole of the check on a write, and it now answers
yes for somebody nothing about the Space is theirs to change. `reach()` is the
one predicate all of it is derived from; `canEdit` is `reach` that is not
`through_channel`, and it is what those write paths ask. The *word* comes from
two places, because two layers can reach a write first:
`WorkspaceDO.spaceRefusalCode` takes the Space a write names and answers
`space_access_denied` — the existing code for "you may not edit this Space",
and the honest one, since `space_not_found` about a row the caller is looking
at is a diagnosis nobody can act on. `SpaceService.editable` answers the same
ahead of a rename, an audience change and a default, from the summary it
already reads, so a caller who reaches the Space only through a Channel is
refused before anything is asked.

Two writes deliberately do not name a Space to that gate. A creation has none
yet, and `reorderContainer` is a person arranging their own view of a list —
the Organization's Spaces, a Space's Channels, a Channel's Breakouts — which is
theirs whatever their reach is, and whose per-kind filters already keep it to
what they can see.

**An Organization that has not reached migration 63 answers empty rather than
failing.** The meeting-notes retirement holds an object at schema 57 until its
external cleanup finishes, and the connect payload reads the Space tables before
anything product-shaped can refuse. Every Space read therefore goes through
`WorkspaceSpaceStorage`, which answers empty state when its tables are absent;
the Channel badge aggregate independently answers empty until the Breakout
projection tables exist;
every Space *write* is refused by name with `space_bootstrap_pending`.
Breakout directory projections are also writes, but their Queue contract has a
retryable answer: while those tables are absent, WorkspaceDO omits the envelope
from `accepted` and writes no receipt. The activity consumer then retries the
same envelope after migration 63 instead of permanently dropping a quiet
Breakout's once-only migration replay.

The two exceptions are paginated and therefore cannot ride the socket: a Space's
member Channels (`GET /spaces/:id/channels`) and a Channel's access sources
(`GET /workstreams/:id/access`).

`GET /spaces/:id/channels` answers **conversations**, not ids and not only
Channels. The path keeps the word `channels` because it is a shipped route and
renaming one to describe its payload buys a reader nothing; what it returns is
`SpaceChannelPageSchema`, a page of `SpaceConversation` rows. The next section
is what that page is. A Breakout row carries both its own appearance and its
parent Channel's appearance, so a hierarchy treatment never has to
guess either identity from an id when the person has chosen an icon and colour.

WorkspaceDO decides which conversations the page is about and in what order,
then projects the Channels through the same directory select and mapper the
sidebar's own list uses and the breakouts through their equivalent, chunked
against the bound-parameter ceiling — so a Space page and a sidebar row are the
same shape built by the same code rather than two projections that can drift.
The visibility predicate travels with it: a Channel row is answered only if the
Channel is Organization-wide or the viewer is one of its participants, which is
what keeps a Space page from being a way to enumerate Channels the viewer
cannot open.

### The dashboard list: every conversation that needs you

The Space dashboard's list is **every conversation in the Space that currently
needs the viewer** — its member Channels *and those Channels' breakouts, in one
list* — ordered by most recent activity first, with everything else left out
entirely. A conversation that is stale for this reader is not greyed out or
pushed to the bottom; it is absent, and stays reachable from the sidebar under
its Space and from search.

Internal callers can reuse this reader for a complete directory:
`SpaceService.listChannels` accepts optional `kind` (`channel` or `breakout`)
and `needsViewerOnly: false`. The query applies these filters inside each arm
before pagination, retaining the same visibility ladder, activity ordering,
page size and cursor. Engineering MCP uses this mode for its user-scoped Thread
and Breakout lists; the app route omits the options and keeps the dashboard's
attention-only behavior. `SpaceService.list` exposes the existing active
Channel directory from WorkspaceSpaceStorage.list, exactly as the workspace
socket reads it, with its waterline and personal ordering.

**Stale is a state, not an age.** A conversation is *live* for a viewer when
its harness status is `scheduled`, `running` or `needs_input`, or it is unread
for them, or it is unseen (new to them), or they are mentioned in it. That is
exactly the set of markers ranked above `completed` in `MARKER_PRECEDENCE`
(`apps/desktop/src/renderer/lib/format.ts`), which is deliberate rather than a
coincidence to preserve: the ranking decides which of several true things a
person is shown, and this decides whether any of them is true at all. Everything
else — `completed`, `stopped`, `failed`, `idle`, all read — is stale. Age was
rejected as the input: a conversation nobody has touched for a month whose run
is waiting on an answer still wants that answer, and one that was busy a minute
ago and has been read wants nothing.

**The predicate is defined once and mirrored once.** `conversationNeedsViewer`
in `@rally/contracts` is a pure function over the four summary fields
(`harnessStatus`, `hasUnread`, `unseen`, `youAreMentioned`). WorkspaceDO's page
query renders the same decision in SQL, through `liveForViewerSql`, once per
table alias. **The SQL is the authority**,
because the SQL is what decides the page: a client-side filter over a
server-ordered page would hand back arbitrarily short pages and a cursor that
had already skipped rows. Nothing in the type system makes the two agree —
what does is
`apps/api/test-workers/space-conversation-page.test.ts`, which walks every
combination of harness status × unread × unseen × mentioned and asserts the
query and the function reach the same answer. **Nothing on the client calls
`conversationNeedsViewer`** — the desktop draws the rows the server has already
filtered — so it is the definition the page query is held to rather than a
second implementation in use. That test is the contract; if it
is deleted the two implementations start drifting the same day.

The hierarchy sidebar counts that same set. `SpaceSummary.attentionCount` is
the number of admitted Channel and Breakout rows in the Space;
`Workstream.breakoutAttentionCount` is the admitted Breakouts under one
Channel. Both are viewer-specific WorkspaceDO reads rendered from the same
`liveForViewerSql` text as the dashboard page. The opening socket carries both
totals. Space totals are grouped into one aggregate query for the visible
directory instead of one query per Space. A Channel total also requires the
parent Channel to be visible, and a guest counts only Breakouts carrying that
guest's explicit viewer grant. Later child projections republish the parent Channel row, while the
existing `space_conversations_changed` nudge carries the current Space totals,
so ordinary attention changes do not rebuild and resend both Space directories.
Zero remains a real count on the wire and is an absent badge in presentation.

**One page query, one order, one cursor.** `conversationPage` is a `UNION ALL`
of the Space's active member Channels that are not archived and those Channels'
breakouts that are not archived, each joined to the viewer's row, filtered to
live-for-viewer, ordered by `last_activity_at DESC` and then by kind and id.
The cursor is a keyset over that whole sort key rather than an offset or an id:
a Channel and the breakout that produced its activity share a timestamp to the
millisecond, so a cursor carrying only the timestamp would repeat or skip the
rows on either side of it. `SPACE_CHANNEL_PAGE_SIZE` still bounds the page.

**Each arm takes its own page and the union merges two of them.** The cursor
and the `LIMIT` are inside each arm, before the `UNION ALL`. Within an arm
`kind` is constant, so the three-part cursor collapses to a range over that
arm's own `(last_activity_at, id)`, and the arm's `ORDER BY` is exactly the
restriction of the page's order to it — which is what makes merging the two
arms' heads the globally first page. Without that the whole live set of the
Space was materialised and sorted on every request, including for page five.

**What one page costs, and what it does not.** The planner drives both arms
from `space_channel_memberships(space_id, state, workstream_id)`, so one page
is one pass over the Space's *active membership set*, with a primary-key lookup
into the Channel directory and into the viewer row per member, plus the
breakouts hanging off those Channels. **General's membership is the whole
Organization**, so for General that pass is O(Channels) — on every dashboard
open, on every **Load more**, and on every refetch a nudge causes. What the
restructure removed is the sort and the materialisation: those are now bounded
by the page. Removing the pass itself needs an index that orders one Space's
members by activity, which does not exist; adding one is a decision for
somebody with Organization sizes in hand, not a guess to make here.

**A breakout is visible only through its parent.** The Channel's own visibility
predicate is applied to the breakout arm too — the same
`scope = 'workspace' OR is_participant` test against the same Channel row — and
then the breakout has to pass a gate of its own. Two gates because they answer
different questions: the first is whether this person may know the Channel
exists, the second is whether the breakout is one of theirs. Without the first,
a private Channel's side thread would be listed to somebody who cannot open the
Channel.

The second gate is `scope = 'workspace' OR listable`, over a **left-joined**
viewer row under the generation fence — the same shape as the Channel's,
because a missing viewer row and `listable = 0` are two different answers and
only the second is the authority saying no. `directory_user` effects go out
only for the users an update affects, so when a Channel's authority generation
advances, a breakout's next message carries its shared row forward and leaves
every unaffected person's viewer row a generation behind; under an inner join
each of them lost the row until they happened to become an affected user, with
nothing to report it. An Organization-wide breakout is granted by its own scope
and survives that. A personal one still needs the row and is left out without
it — the same answer a personal Channel gets, and the safe one, because nothing
in the Organization knows who a private child's participants are.

The desktop draws both kinds as one row type: a status dot from the shared
marker function, a title, an activity time. Neither row carries a management
control on the landing page. A breakout row also carries the ↳ glyph the middle
column uses, its parent Channel's name, and a link to
`/workstreams/<channel>?substream=<breakout>`. Two empty states are distinguished
by `channelCount`: a Space with no Channels says "No channels yet", and a Space
whose conversations are all stale says "Nothing here needs you right now",
because telling somebody a Space with forty Channels in it is empty sends them
looking for a bug.

**A desktop build older than this change draws a breakout as a Channel.**
`WorkstreamSchema` is a `z.object`, so a client that predates `kind` and
`breakoutOf` strips both and is left with a row whose `id` is a substream id —
which it links to `/workstreams/<substreamId>`, a Channel that does not exist.
Nothing on the server can prevent that, because the row is only distinguishable
by the fields the old client throws away. If desktop builds can lag the Worker
by long enough to matter, the answer is to have the page leave breakouts out
for a client that has not declared this contract version, the way
`client-contract.test.ts` already decides what the cutover answers which
builds — not to reshape the row.

### Breakouts reach the Organization

A Channel's hosted parent folds only the main conversation into the Channel's
own row; a breakout's `directory_common` and `directory_user` projections are
stored in `parent_child_projections`. Until migration 65 they stopped there. A
Channel now **forwards** them as well, through `HostedParent.forwardsChildProjection`:
the child's own payload, under its own projection key (`substream:<id>:common`
and `substream:<id>:user:<userId>`), through the same `parent_outbox` →
`applyWorkstreamDirectoryEffects` path every Channel projection takes, with the
substream id on the envelope. The two hooks are separate questions and a parent
answers them independently — a breakout must not move its Channel's title or
state, and must still be listable — which is why forwarding it is not a change
to what is aggregated.

The envelope's `substreamId` is what routes it. Absent means the parent's own
aggregate, which is every envelope that existed before this; present, and never
`"0"`, means one breakout. The handoff refuses `"0"` and refuses a Space's
envelope carrying one at all: the main conversation's projection is what the
aggregate is built from, so an envelope naming it would ask the Organization to
store the Channel twice, and a Space has no breakout any surface draws.

**Background agents are not forwarded.** A background agent is a worker the
Channel starts — counted in `backgroundAgentCounts`, drawn nowhere as a row —
and forwarding one would put a Queue message and a workspace row on every step
it takes. The flag is read back from the child's own stored projection, which
the apply has just written, so a common effect is classified by the payload
that arrived with it. An agent marks itself before its first projection, and an
agent a Channel had already forwarded is retracted: WorkspaceDO archives the
breakout's row as a tombstone and deletes its viewer rows when a projection
flagged `backgroundAgent` arrives, so it never counts toward the Channel's
badge.
[`workstream-durable-object.md`](workstream-durable-object.md) has the detail.

WorkspaceDO stores them in **two tables beside the Channel ones**,
`breakouts` and `breakout_viewers`, keyed by
`(workstream_id, substream_id[, user_id])`. Not a `substream_id` column on
`channels`: every sidebar page, pin, watch registration,
retirement enumeration and cutover query reads that table as "one row per
Channel", and the first one that forgot the new filter would have listed a
breakout as a Channel. Redelivery stays idempotent through the receipt the
Channel directory already keeps — `workspace_workstream_effect_receipts`, keyed
by the envelope's message id — rather than a second receipt table that would be
a second thing to expire and a second way for the two to disagree. Nothing
publishes a breakout row to the sidebar socket; no surface draws one there.

### The refresh signal

A Space has no socket, and a Channel's feed (and the older desktop's dashboard
page) is the one list on that screen the socket cannot replace. It changes on
more than a membership: a thread's description or audience changes what its
row shows, and a thread placed or removed changes which rows there are.

So WorkspaceDO sends a **nudge**: `space_conversations_changed`, carrying
nothing but the Space ids whose page may have moved *for the socket it is sent
to*. The client re-reads each named Channel's feed. Only a nudge that reports
a placement change also re-reads the Threads tab (`GET /navigation/threads`)
and Activity, because a placement is how a thread arrives in either; a nudge
about a message or a read leaves them alone. A reconnect re-reads every loaded
feed, the Threads tab and Activity, since the socket may have missed a nudge.
It goes out when a directory batch changes a member Channel's shared row, when
a breakout's forwarded projection changes its, when one person's viewer row on
either changes, and when a membership settles, is removed, or is taken away and
given back by a Space archive and restore. Who each of those reaches is below.

**Nothing durable stands behind it, deliberately.** The page is re-read on
mount, on socket reconnect and on this nudge, so a nudge lost to a closing
socket costs one stale view until the next change or the next reconnect — and
those three reads are what make that recoverable rather than permanent. The
alternative shipped first and was withdrawn: a per-Space counter and a
per-(Space, person) counter, summed into a `conversationWaterline` on the Space
summary. It cost a durable write on the hottest path this object has — every
message in every member Channel, which for General is every message in the
Organization — it needed the Space snapshot to deliver it, which rebuilds both
Space directories per socket, and it did not work: the snapshot is dropped by
the client as a replay whenever the *directory* waterline has not moved, which
is exactly the case the counter existed for. A counter is also the more
expensive thing to reverse. If the nudge turns out to be too little, what
replaces it is a version the client compares — not a second mechanism beside
it.

**It is addressed, not broadcast.** A socket hears about a Channel only if its
viewer can list that Channel — the same `scope = 'workspace' OR is_participant`
test the page applies, from the one code-owned text both render — and about a
Space only if its viewer can see that Space. A Channel id never leaves the
publisher; only the Spaces it is placed in do. That keeps two people's fast
exchange in a private Channel off every other member's screen. A guest's socket carries the Space snapshot the listing rules give
them, and the same nudges.

**"Can see that Space" is the wrong address for a membership, because of the
third clause.** Somebody who reaches a Space only through one Channel in it
sees the same page before and after a *different* Channel is placed into or
taken out of it — so a nudge tells them something their own refetch does not:
that something was just put into or taken out of this Space. Repeated, that is
a live feed of a participants-only Space's membership to a person who is told
only its name, which is the disclosure the viewer-scoped `channelCount` is
narrowed to avoid, reopened in the time dimension. A membership settling or
being removed is therefore addressed **through the Channel that moved** — the
viewers who can list it, which is exactly the set whose page changed — and the
Space is named alongside it rather than resolved from it, because by the time a
removal publishes the membership is `removed` and the Channel no longer
resolves to the Space it just left. An archive and a restore keep the
see-the-Space address: the Space's own disappearance and return are visible to
everybody who reaches it, however they reach it.

The cost is two local reads per subscribed socket and no write, plus two more
per Channel addressed that way — one Channel, on the two membership
settlements, beside a Space snapshot on the same line that rebuilds both
directories per socket. The page itself
is never pushed: that would put one Channel's traffic on every reader of every
Space that holds it, and would put breakouts on a socket nothing else draws
them on.

The nudge **subsumes `channelCount`** as a staleness signal, because a settled
membership sends one too — so a feed has one refetch trigger rather than
one for Channels and a second for breakouts. `channelCount` stays on the
summary for what it is actually good at: telling the two empty states apart.

**A refetch reloads every page the reader has scrolled to.** A feed's
query is a React Query infinite query, and invalidating one refetches all its
loaded pages; a reader three pages into General pays three page reads per
nudge. That is left as it is. The coalescing that exists is React Query's own
in-flight dedupe — a burst of messages in one Space costs one refetch while it
is in flight — and anything more would be a debounce interval nobody here can
derive. If it has to come down, the thing to change is the page size or the
query shape, not to add a timer.

### The desktop surfaces

The client draws a Space as the product's Channel: a row in the sidebar's
Channels list and a Channel screen with a feed of its threads and a composer.
[`desktop-shell.md`](desktop-shell.md) owns both. This section keeps what they
take from the Space authority.

Every shell, member or guest, on either host, is handed the socket's Space
directory. A guest's holds only the Organization-wide Spaces the listing rules
give them, each a `through_channel` or `participant` summary, and nothing a
guest is shown carries a Space write.

**A placement is not a copy.** A thread in two Channels is one record listed in
both feeds, with one unread state, one running state and one destination. The
server takes a thread out of any Channel but its last, refusing the last with
`space_membership_final`; the desktop no longer offers adding or removing a
placement from the thread menu. The move RPC (`moveSpaceMembership`)
stays for older desktops' drag between Space pills: when both Spaces grant the
same scope and roster it switches both placements in one WorkspaceDO
transaction, and otherwise it answers `moved: false` and the server adds the
destination before it removes the source, so a thread always has a home if the
second step is interrupted.

`spaceIds` travels on the *common* half of `workspace_workstream_state`: it is
the Organization's fact about the thread, not the reader's, and WorkspaceDO
republishes the row after every membership settlement. **That republication is
at the waterline the row already had**, because a placement changes nothing the
thread's own authority projects. The client's versioned receiver reads an
unadvanced waterline as a duplicate, so `applyVersionedWorkstreamState` takes
the placements off a row it is otherwise rejecting. Without that the thread
stayed under the Channels it had for the session, and the local cache carried
the stale row through a reload.

**A Space this reader reaches only through a thread in it is drawn, never
changed.** Its Channel screen shows the threads they may open and no composer;
the menu carries no write, and the thread menu does not offer it as a place to
add a thread. The server refuses every write by name either way.

Every Space refusal on every surface goes through one copy table,
`lib/space-failure-copy.ts`, exhaustive over the closed `SpaceErrorCode` plus an
`unavailable` fallback, so a refusal names what has to change first rather than
printing the diagnostic a Worker wrote for a log. A surface that knows what was
being attempted supplies its own sentence for a refusal that carried no code.
`space_audience_incompatible` remains in the wire vocabulary for older
deployments, and nothing current emits it.

**A thread reached only through a Breakout is a socket row like any other**,
for a member or a guest. The conversation directory (`/sharing/navigation`)
adds no rows; it says which conversation such a row opens on. It opens on the
first one listed and never on Main, and the socket pool does not hold its Main.

### The Channel's reads

Three reads serve the new sidebar and Channel screen, each one synchronous SQL
read over the listing rules:

- **`feedPage`** (`GET /spaces/:id/feed`, `listChannelFeed`): the Channels
  placed in a Space, newest placement first, ordered by migration 97's
  `space_channel_memberships(space_id, state, joined_at, workstream_id)` index.
  A Channel the viewer may open comes back whole, with its description as the
  one-to-two-line summary; one the viewer may not open is left out, for a member
  as for a guest. Archived and system Channels are left out. Every row carries
  its placement's `attentionSequenceNumber` ([read state](#the-channels-read-state)).
- **`participatingPage`** (`GET /navigation/threads`, `listMyThreads`): the
  Channels and breakouts a person takes part in or pinned, newest activity
  first — the conversation page's two-arm shape started from the person, through
  migration 97's `(user_id, is_participant)` indexes on both viewer tables.
- **`channelStats`**: per listed Space, how many Channels in it the viewer may
  list, when the newest of those last moved, the viewer's
  [read state](#the-channels-read-state) in it, and `newThreadCount`: how many
  of the feed's rows sit above their read position, zero for a guest.
  `hasUnread` is true only while that count is above zero: a private placement
  the viewer cannot see moves the Channel's latest number but is not news. It rides the connect payload
  as `channelStats`, beside the Spaces rather than on `SpaceSummary`, which
  shipped desktops parse strictly. It does not ride the broadcast Space
  snapshot: that goes to every member, and the stats are one person's. After
  connect `GET /navigation/channel-stats` (`listChannelStats`) reads it on its
  own, which the desktop does on the same placement nudge that rereads a feed.

`listSpaceChannels` and `listMyThreads` share one projection,
`conversationRows` in `workspace-do.ts`. The feed and the stats each cost one
pass over a Space's active memberships, which for General is every Channel in
the Organization, as the older desktop's dashboard page already did.

### The Channel's read state

A product Channel (a stored Space) has an unread waterline and a per-person read
position, in the **same columns and with the same meaning** a thread and a
breakout carry, so the client draws one unread dot from one set of fields and a
future Channel SubstreamAgent could write them through directory effects
unchanged. Migration 98 (`workspace-channel-read-storage.ts`) adds them:

- `spaces.latest_attention_ordinal` and `spaces.unread_tracking_start_ordinal`,
  the waterline and where unread tracking began.
- `space_channel_memberships.attention_ordinal`, the ordinal a placement took.
- `space_reads(space_id, user_id, seen_attention_ordinal, updated_at)`, each
  person's position. There is no manual-unread pair: a Channel cannot be marked
  unread. It is a table of its own rather than columns on
  `space_viewers` because a member reaches an Organization-wide Space with no
  viewer row at all, and that table is the Space authority's projection: a row
  is deleted when the projection goes inactive and replaced at each newer
  source version, which would erase a read position on an unrelated audience
  change. No foreign key, for the reason `space_invitees` gives.

**Channel news advances the waterline: a placement, or a message that is
news.** The waterline is one counter for news of any kind. `stampChannelNews`
takes the Channel's next ordinal and reads its member author through it; Rally
as author reads nobody through. Every transition of a membership
into `active` — `enterMembershipAtBirth`, `finalizeMembership` (and so
`addMembership`), a move's target, a
restore, an abandoned archive putting its rows back, a legacy `add` intent —
goes through `stampPlacements`, which takes an ordinal per placement in the same
transaction and stamps it on that membership. `postMessage` takes one for a
message posted with `news` and stamps it on `space_messages.attention_ordinal`;
a Channel's opening messages are posted with `news: false`. An idempotent settle of a row that was already active
takes no ordinal, a re-add after a removal takes a fresh, higher one, and a
removal never lowers the waterline. The placer's own position rises to the new
ordinal: your own placement is not news to you. Activity inside a placed thread
does not move the Channel; the thread carries its own unread state.

**Derivation.** `channelStats` counts fresh rows in two arms, visible
placements and visible news messages above the reader's position, and takes the
first unread ordinal across both; `newThreadCount` stays the placements alone.
It answers `latestAttentionSequenceNumber`,
`readThroughSequenceNumber`, `firstUnreadSequenceNumber` and `hasUnread` per
Channel, from `unreadState` in `unread-state.ts` — the one helper
`directoryWorkstream` and `breakoutConversation` use too. `seen` falls back to
the tracking start when the person has no `space_reads` row, which is why a
Channel nobody has opened is not unread to everyone. **A guest is never
unread**: they reach a Channel only through threads they may list, so their
read position is reported as the waterline.

**Acknowledgement.** `PATCH /spaces/:id/read-state` (body
`AcknowledgeWorkstreamReadRequestSchema`, RPC `acknowledgeSpaceRead`) moves the
position to `MAX(old, MIN(requested, latest))` — clamped rather than refused,
unlike a thread's, because a feed row can outlive the waterline it was read
from by a moment. It refuses a Channel the person cannot list as
`space_not_found`, answers the person's `ChannelStats` row, and sends that
person's sockets a small per-person frame carrying the row (the path a pin
change takes too), so another window's dot follows without rebuilding a whole
Space snapshot. There is no mark-unread route. A support session reads without moving the
person's position (`docs/impersonation.md`).

**What the reader acknowledges.** The Channel opens at the server's first unread
row, with preceding context; a caught-up Channel opens at the end. The client
captures that opening position before acknowledging any rows, and advances the
read waterline only through rows overlapping the visible feed viewport.
The feed's first page carries
`latestAttentionSequenceNumber`, the Channel's waterline read in the same
synchronous turn as the page. When the reader reaches the end, the client
acknowledges the higher of it and the newest row it holds, covering placements
that have since been removed or archived. Acknowledging only listed rows left the dot standing for good
once the newest placement was removed or its thread archived. Neither a Channel
hidden behind its thread or a breakout nor a thread hidden behind its breakout
acknowledges anything (`PaneVisibility`).

**Backfill.** Migration 98 numbers each Space's active placements by
`(joined_at, workstream_id)` from one and sets both the waterline and the
tracking start to the count, so nothing is unread on deploy. Rows that were not
active keep `NULL`, which the feed reports as zero.

## Invariants

- **Seeing a Space is not access to anything in it, and is not permission to
  change it.** A person who reaches a Space only through a Channel placed in it
  is told its mark, colour, name, audience setting and lifecycle, so that
  Channel can be drawn where it lives. They are told no participant, no
  default, no Channel they could not already read, and not how many Channels
  are in it; every Space write is refused them `space_access_denied`. A future
  field on `SpaceSummary` has to say which side of that line it is on.
- **WorkspaceDO is the sole Space relationship authority.** Copying membership
  into a child object or D1 would give two objects an answer to "does this
  Channel have another Space", which is the question both the final-membership
  and the archive refusals turn on.
- **Every mutating Space RPC rechecks active
  Organization membership and refuses a guest.** The reads (`spaceSummary`,
  `listSpaceChannels`, `channelSpaces`) take the caller's relationship and
  apply the listing rules, which give a guest no Organization-wide reach.
  `listSharedNavigationSpaces` first re-intersects caller IDs with that
  relationship's grant candidates. The other exceptions have no person on the request: `recordSpaceIntentReceipt`,
  `spaceBootstrapStatus` and the default-target settlements are server-to-server,
  and each says so where it is defined.
- **A Space's retired conversation is not addressable as a Channel.** Every
  product request carries the parent kind the caller expects and is refused
  `conversation_parent_kind_mismatch` when the object disagrees. A conversation
  is reached by id, every member is handed every Space id on the socket, and the
  PRD gives that conversation no product surface at all — so without this,
  `PATCH /workstreams/<spaceId>` archives General behind the Space authority's
  back.
- **One person's view state reaches that person's sockets and nobody else's.**
  A read acknowledgement and a pin write publish a per-person frame, never the
  broadcast Space snapshot. Broadcasting one person's change rebuilt every
  directory for every member on every read.
- **A membership is invisible until it is active.** A `joining` row (only a
  legacy intent can leave one) is not counted, not listed, and not on the
  snapshot.
- **No Channel audience is written except through the Channel's canonical
  operations**, from the Worker, which is where the retained-content
  containment preflight and its SQL triggers run. Nothing in the Space code
  writes one.
- **A Space grants no reader, Organization-wide or private.** Joining,
  leaving, making private, archiving and restoring change nobody's access to a
  thread. The thread's own scope and participants are its whole audience. A
  Space's scope decides only who lists the Space. A feature that lets a Space
  grant readers again should start from
  [`space-access-sources.md`](space-access-sources.md).
- **An active thread has a home, or a durable archive in flight.** Removing its
  last membership is refused `space_membership_final`. Archiving its last
  Channel instead records its canonical archive request in the same transaction
  as the Channel archive and preserves its placement there. A shared thread
  keeps its other active Channels. An exclusive thread the requester cannot
  read, or whose directory row has not arrived, still refuses the operation.
  Tests: the archive cases in `space-routes.test.ts` and
  `channels-threads-navigation.test.ts`, and the refusal/intent cases in
  `space-authority.test.ts`.
- **A private Space is not found through a thread in it.** A reader of one
  thread in a private Space does not list the Space, so a thread's `spaceIds`
  can name fewer Spaces than it sits in. A reader who keeps access to a thread
  finds it through the Threads tab, a link or search, not necessarily through
  a Channel; [`listing-rules.md`](listing-rules.md#invariants) holds the rule.
- **General is one per Organization and cannot be archived.**
  The unique partial index on `system_role` is what makes a race between two
  idempotent creators produce one Space rather than two fallbacks. Its name may
  be edited; its identity, lifecycle and audience may not.
- **Space effects other than the two directory effects never reach the
  workspace.** The role drops them at the parent, and the workspace handoff
  refuses them by name. A Space has no feed for an activity event to appear in
  and no notification anyone asked for.
- **Space attachments are monotonic.** Leaving a Space, removing a default, or
  archiving a Space stops future delivery; it never removes a resource or Sidekick a Channel already has.
- **No product surface opens a Space's conversation.** The Channel screen's
  composer starts a new thread; it never posts into the Space, and the screen
  has no transcript, feed socket, Main link or Breakout list of its own.
- **The older desktop's dashboard page filter is the SQL, and the contracts
  predicate is a copy of it.** Two implementations of one decision exist because the page is
  decided on the server and drawn on the client; the only thing keeping them
  equal is the combination walk in
  `space-conversation-page.test.ts`. A change to either without the other is a
  list whose rows disagree with the rows it contains.
- **A breakout is never a row in the Channel directory.** Its projection lands
  in `breakouts`, and every query that reads
  `channels` may go on assuming one row per Channel. A
  `substream_id` column there would make that assumption a filter every
  existing query has to learn.
- **A viewer sees a breakout only if they see its parent Channel.** The
  Channel's own visibility is checked on the breakout arm of the page as well
  as the breakout's `listable`. A breakout's own viewer row cannot grant
  discovery of a Channel its reader may not open.
- **A breakout has no membership of its own.** Its Spaces are its parent
  Channel's, and the Space authority has no operation that adds or removes one.
  A **Remove** control on a breakout row would be offering a write nothing
  implements.
- **A Personal Channel's audience is its owner, and never changes.** Only
  seating writes `individual`; no request names it, and `noteSpaceAudience`
  and archive refuse it `space_protected`, as they refuse to make General
  private or archive it. It is listed to `created_by_user_id` alone, and only while they are
  an active member ([`listing-rules.md`](listing-rules.md)). Nothing else names
  it, a shared link included.
- **A thread started in a Channel that is not Organization-wide starts
  private.** `resolveSpaceWorkstreamStart` narrows on `scope <> 'workspace'`,
  so a scope added later is private until it says otherwise.
- **Seating is idempotent per member.** A Personal Channel's id is derived from
  the Organization and the member, and `spaces_individual_owner_idx` holds one
  per member, so a redelivery, a second seating path or the backfill finds the
  one they have rather than making another.

## Boundary

This module owns the Space relationship inside one Organization: identity,
directory projection, per-person order, membership, the default registry and its
delivery, and the staged intents that make a cross-object operation resumable.

It also owns what a Space *is*: the name, appearance, scope, participants and
defaults are rows in the same tables, and a Sidekick default's recommendation
is written on the Space's hosted parent in the same call
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)). It does not own
a Channel's audience; that is the Channel's own authority, reached through its
canonical operations and documented in
[`authorization.md`](authorization.md) and
[`scope-grant-directory.md`](scope-grant-directory.md). It does not own
resources, which stay with the regional resource authority.

Regional HTTP routes call the service, which calls typed RPCs; nothing outside
`workspace-space-storage.ts` touches the Space tables, and nothing outside
WorkspaceDO reads them. Regional D1 remains the authority for active
Organization membership and access class only.

## Failure modes and limits

A malformed input fails strict contract parsing at the object boundary. Every
refusal is one of the fourteen closed `SpaceErrorCode` values, which is the code a
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
`pending` intent that the alarm finishes.

### Numbers handed to the team

| Number | Value | What it bounds | What deciding it needs |
| --- | --- | --- | --- |
| `SPACE_CHANNEL_PAGE_SIZE` | 250 | Rows in one `GET /spaces/:id/channels` answer, and therefore one RPC result and one HTTP body. | Round trips against bytes per answer, weighed against the Organization sizes nobody here has. |
| `SPACE_BOOTSTRAP_PAGE_SIZE` | 50 | Channels in one page of the cutover's walk. | Fewer alarm wakes against a longer invocation, given per-Channel timings and Organization sizes nobody here has. |
| *(none)* — attempts before an unsettleable intent stops being republished | no ceiling | How long a staged operation that can never succeed keeps costing an alarm wake and a dead-letter message. | What an operator is expected to do about a `last_error_code` that never changes, weighed against a ceiling abandoning work nobody agreed to abandon. |
| *(none)* — items in one person's order for one container | no bound | How many rows one `PUT /workspace/order` writes, and how much of the `ordering` field one container can take up on every socket payload this person receives. | What the largest list somebody would actually arrange looks like — an Organization's Spaces, a Space's Channels, a Channel's Breakouts — against what a payload can carry. |
| *(none)* — active memberships one Space may hold, which the third visibility clause scans for a viewer it cannot admit | no bound | How much work one Space snapshot publication does: a correlated existence test over that Space's active memberships, twice, per subscribed socket. | How many Channels one Space actually holds and how many sockets an Organization keeps open, against what a publication may cost — neither of which anybody here has. |
| *(none)* — containers one person may have arranged at once | no bound | The `ordering` field's whole size, which rides the connect payload of every session and every republication to it, and the rows one person keeps in `workspace_container_order` for the life of their membership. | What the oldest plausible account looks like — how many Spaces an Organization has, how many of its Channels one person arranges Breakouts in over a year — against what a payload can carry, and what dropping the least recently touched container would cost somebody who comes back to it. |

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

**`SPACE_BOOTSTRAP_PAGE_SIZE` is 50, and the number is the team's to set.**
Without it the cutover would claim the whole Organization in one message, and an
Organization larger than one invocation's budget could never finish — each
redelivery would restart the same unbounded pass. Nothing is visible when it
trips: the page ends and the cursor continues it on the next alarm. It sits
between two ceilings, a Queue consumer invocation and a WorkspaceDO alarm, and
each Channel costs a cross-object placement in WorkspaceDO. 50 is a
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
Channels they can read, and only `channel` is stored unchecked. What a cap would cost is a person
whose real list is longer than it silently losing its tail, which is worse than
the row it would prevent; what deciding one needs is the largest list somebody
would actually arrange, against what one socket payload can carry. The guard is
written open.

**The third visibility clause is a correlated existence test, and nothing
bounds what it scans.** `spaceReachedThroughChannelSql` is an `EXISTS` over
`space_channel_memberships` for one Space, with a directory lookup and a viewer
lookup per candidate row, and, once Breakouts are projected, a Breakout
existence test per Channel whose Main the viewer cannot open. `list()` renders the clause twice — once in
`visibleSpaceIds` and once in `directory()` — and `spacesFor` runs `list()` per
socket, which `publishSpaceSnapshot` does for every subscribed socket on every
Space write in the Organization. So a publication costs

> 2 × subscribed sockets × Σ over the Spaces each viewer *cannot* reach of
> that Space's active membership count

plus two indexed lookups per row scanned. A Space the viewer *can* reach costs
almost nothing: `EXISTS` stops at the first visible member. The whole of the
cost is the Spaces they cannot reach, because proving a negative means looking
at every member. A member reaches every Organization-wide Space by its scope,
and the thread clause never applies to a private Space, so that is a guest's
view of the Organization-wide Spaces that hold none of their threads.

**What bounds it is the index, and only as far as one Space.**
`space_channel_memberships_space_state_idx` on `(space_id, state,
workstream_id)` makes the scan a range over that one Space's active
memberships rather than over the table, and it covers the subquery's own
column. Past that there is no bound: nothing caps the Channels one Space holds,
nothing caps the sockets an Organization keeps open, and no limit is set on
either. Deciding one needs the two numbers nobody here has — how large a Space
actually gets, and how many sockets a publication fans out to. If it has to
come down, the thing to change is the shape rather than a ceiling: the reach
could be materialized per (viewer, Space) the way the Channel viewer rows are,
which is a durable write on the path that places and removes Channels in
exchange for a lookup here.

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
request body's scope is parsed by a route nothing else drives, and a real
object refuses in ways no double reproduces.
A behaviour that a route, a real session or a cold Durable Object could break
belongs in the route suite as well as wherever its authority is proved.

The archive route cases cover exclusive private threads, shared threads, no
placement in General, Channel restoration retaining independent thread archives,
and a lost reply replayed after a thread was manually restored. Authority and
navigation cases cover unreadable-thread refusals without partial intents.

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/space-routes.test.ts` | The `/spaces` routes as a signed-in member drives them against real objects: creation (Organization-wide, including when a released client asks for a personal Space; a caller WorkspaceDO refuses writes no D1 anchor), audience (a participant change stages nothing for a member Channel and leaves its audience alone; a personal audience is refused), rename, archive and restore, and an equal-audience one-request Channel move whose returned summaries match the settled memberships. That a Space whose parent reservation fails commits no Space row, and that `openGeneralSpace` writes General once and is reused. `POST /workstreams` in a Space makes an Organization-wide Channel. The WorkspaceDO-driven membership calls: a private Channel added to a Space that lists somebody else stays private and settles; a private or Organization-wide Channel leaving a Space keeps every reader. A Space created without an icon gets the one the naming double answers, and keeps the icon a person picks while that call is still in flight. |
| `apps/api/test-workers/space-authority.test.ts` | Every RPC against real Durable Object storage and real D1 membership, including the four negative controls, the Channel page's viewer predicate, that a placement reaches an already-open socket rather than waiting for a reload, that an archive whose only leftover Channel is archived is accepted, that an archive whose only Channel has no directory row is refused, and that one `addSpaceChannel` call activates the membership and stages the Space's defaults with no intent left behind. Reach: a participants-only Space named to somebody who can read a Channel in it and not to somebody who cannot, the summary that viewer is handed carrying the mark and neither participants nor defaults nor a count of what they cannot see, the reach on each row of the socket snapshot, every write refused `space_access_denied` with the Space left as its participant had it, a Channel that viewer cannot see moving into and out of the Space nudging them not at all while the Space's participant is nudged by every move, the Space leaving and returning to that viewer's snapshot as their participation in the one Channel reaching them into it moves — and staying put across an unread change — an audience that leaves its own caller out refused before anything is written, the single-Space read refusing a Space this viewer has no reach into rather than labelling it one, the ordering write that is not refused, and an archive taking the Space off that viewer's active list without putting it on their inactive one. Ordering: a write for each of the three container kinds coming back on that person's sidebar and on nobody else's, a Space's list dropping a Channel it does not hold and one the viewer cannot read, a write naming part of a list leaving the rest of it behind the part that moved, a write reaching a second session of the same person without it asking and no session of anybody else, and a Channel removed from a Space taking its place in that Space's list with it for everybody, and archive taking neither — the arrangement is still there when the Space is restored. Opening a new Organization: `initializeWorkspace` with General's anchor answers `spacesReady` with General listed and the cutover complete, without one answers not ready and creates nothing, refuses a guest creator, and answers an already-open Organization ready with no anchor. The Space directories are read off the workspace socket's connect payload rather than through a read of their own, because that is the only path a client has. |
| `apps/api/test-workers/space-conversation-page.test.ts` | The dashboard list on real workerd, plus all-visible reads by kind with settled member/guest cases and complete per-kind cursor walks: a breakout projection forwarded by its Channel landing in the breakout tables and nowhere else, a redelivery acked and leaving the row as it was, a breakout invisible to somebody who cannot see its parent Channel and to somebody whose own viewer row is not listable, Channel badge totals respecting that parent boundary and requiring an explicit guest grant, one activity-ordered list across both kinds, an Organization-wide breakout surviving a viewer row a generation behind while a personal one does not, a keyset walk whose page boundary falls inside a four-way tie of two breakouts and two Channels, the combination walk that keeps the page's SQL and `conversationNeedsViewer` equal — run against both renderings of the predicate, with unread produced by an attention ordinal and by a manual mark — and the dashboard nudge on real sockets — Channel activity, breakout activity, one person's read state, a membership settling, and the two cases where it must not arrive. |
| `packages/contracts/src/conversation-attention.test.ts` | The predicate itself over all 56 combinations, and that the three reader fields default to false rather than to unknown. |
| `apps/api/test-workers/space-object.test.ts` | The role's differences, that what a Space's retired conversation still publishes is acknowledged and applied nowhere, that a Space's directory effect lands in the Space directory rather than the Channel one, and that a Channel product request aimed at a Space's conversation is refused by name. |
| `apps/api/test/workspace-space-schema.test.ts` | Migration 61 against the real ledger: the CHECK vocabularies — including the containers a person can arrange — the order row's compound key, General's unique partial index, the default-target foreign key, and the retirement-graph rebuild carrying its `retired_at` receipts. |
| `apps/api/test/regional-workspace-create.test.ts` | The regional create against the real migrations: one batch writes the Organization, its owner, General's anchor and route at the authority generation, and a session row the returned refresh token hashes to, and the object is handed that anchor; with the authority closed, no route is written and the object is handed none. |
| `apps/api/test/space-service.test.ts` | The service's *ordering* against capability doubles: what is not written when an earlier step refuses (a D1 anchor failure reserves nothing), that a move, an add, an archive and a restore are each one WorkspaceDO call that reaches no Channel, that each kind of structured refusal is rendered with its own code, that a queued resume calls WorkspaceDO until the intent stops progressing, and that a refused creation anchors and reserves nothing. |
| `apps/api/test/workspace-space-move-migration.test.ts` | Migration 68 preserving existing intents while adding the move kind and requiring all three source-side fences on every move row. |
| `apps/api/test/workspace-space-public-migration.test.ts` | Migration 94 against the real ledger: every private Space widened, archived ones too, with nothing staged for their Channels; a private Space's resource defaults retired and every other default kept; the four Space-source tables dropped; an Organization with no private Space left as it was; and a stale directory effect that still says personal not narrowing a Space. |
| `apps/api/test/channel-access-service.test.ts` | Against capability doubles: removing a direct reader is a plain removal gated on management access, and **Make private** publishes the socket narrowing only when the Channel was Organization-wide before the update. |
| `apps/api/test/space-default-publication.test.ts` | Claim, send, accept — for default targets and for the cutover's page claim — and that a rejected send leaves its rows pending. |
| `apps/api/test-workers/helpers/space-membership.ts` | Not a suite: the fixture that puts a Channel in a Space's membership through WorkspaceDO's own storage calls and publications, for the suites above whose Channels have no conversation. `space-routes.test.ts` proves the product path. |
| `apps/api/test-workers/space-legacy-intents.test.ts` | Intents staged before every Space operation became one transaction, finished by the alarm: a stored `add` activating its membership and staging the Space's defaults, a stored `move` switching both memberships, two moves racing for one placement, and a requester who is no longer an active member having nothing run as them, by the alarm and by the Queue consumer, with `space_intent_requester_inactive` on the row; and a Space default's Queue delivery failing as `space_default_requester_inactive` when the person who staged it is inactive, rather than acting as a Space participant. |
| `apps/api/test-workers/space-bootstrap.test.ts` | The cutover on real workerd: one General for every Channel including archived ones, one of them archived in its own conversation so only the directory can say who reads it; a Channel whose retained content is fenced to one reader still placed, because placement widens nothing; a connector placement's refusal reopening a finished cutover; an interrupted pass making no second General and no second membership; the refusal to close while a Channel is outside every Space; the directory handoff's guard reopening a finished cutover for a Channel whose row is committed while it is in no Space, and leaving it closed for a placed Channel, for a Channel arriving in the directory for the first time, and for a system one; that the development seed route places the Channels it restores; and that an Organization short of `complete` arms its own alarm on construction, due now, which is what "the fleet migration finishes without relying on user access" rests on. |
| `apps/api/test-workers/space-creation.test.ts` | A Channel born in General with an active membership and the private audience it asked for; one General across creations; a Channel born in a named Space keeping its own audience and inheriting the Space's defaults; and that a creation whose membership cannot settle publishes no directory row by either path. |
| `apps/api/test/workspace-space-retirement-migration.test.ts` | Migration 62 against the real ledger: a queued Project default settled before the drops rather than dropped under, an applied default leaving the Channel's own attachment alone, and the consumer's tombstone acknowledging a redelivered Project message by name. |
| `apps/api/test/client-contract.test.ts` | Which builds the cutover still answers: a browser build that declares nothing or declares an older contract is told to update; a native client that declares nothing is admitted. |
| `apps/api/test-workers/personal-channel.test.ts` | General and a Personal Channel on real workerd: a new Organization's creator gets both; seating a member asks for an anchor, then seats them once, and a guest gets neither; a member who joins while Spaces are not open is seated when the cutover closes; a member who left and came back is seated again; a Personal Channel is listed only to its owner and never named by a link; Channel messages post once per key and merge into the feed by time; and migrations 102 and 103 against a pre-upgrade store, workstream pins included. |
| `packages/contracts/src/spaces.test.ts` | The closed schemas, the appearance registry, and the container address: a Space's and a Channel's need an id, the Organization's is refused one. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` | That a nudge invalidates the named Channels' feeds and no others. |
| `apps/desktop/src/renderer/screens/channel.test.tsx` | The Channel screen over the feed: thread rows, the composer's absence for a reader who reaches the Channel only through a thread, and the read acknowledgement. [`desktop-shell.md`](desktop-shell.md) owns the screen. |
| `apps/desktop/src/renderer/lib/browser-collaboration.test.tsx` | The cookie-scoped browser's single sidebar and split Breakout pane; selected-Space filtering and accessibility state; multi-Space route stability; active-before-archived selection; and the local fallback that keeps an admitted Channel reachable when no visible Space is returned. |
| `apps/desktop/src/renderer/lib/personal-order.test.ts` | The one arrangement rule: stored ids first, the rest in their natural order, an id the list does not carry dropped, an empty arrangement as the identity, and a container addressed by both halves of its key. |

```bash
pnpm --filter @rally/api exec vitest run test/workspace-space-schema.test.ts
pnpm --filter @rally/api exec vitest run test/space-service.test.ts
pnpm --filter @rally/api exec vitest run test/space-default-publication.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-space-public-migration.test.ts
pnpm --filter @rally/api exec vitest run test/channel-access-service.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-routes.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-authority.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-conversation-page.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-object.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-legacy-intents.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-bootstrap.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-creation.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-space-retirement-migration.test.ts
pnpm --filter @rally/api exec vitest run test/client-contract.test.ts
pnpm --filter @rally/contracts test -- spaces.test.ts
```

The two new workerd files are there for the same reason the archive fan-out is.
The cutover's fenced-content case needs the Channel's own authority and its
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

Two cases in `space-authority.test.ts` go past the Space rows on purpose,
because the property is not the Space's alone. The archive fan-out opens each
member Channel's hosted parent so "the source is gone from each member Channel"
is read from the Channel rather than inferred from a membership row, and the
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
`test/helpers/space-creation-rpcs.ts`: the WorkspaceDO RPCs a create passes
through, doubled in their steady case for a file whose subject is Slack
assignment or origin attachment.

The service tests double the object stubs rather than the namespaces, and they
are not where a fence is proved. A fence is a property of real storage; what the
service tests hold is which authority is asked first and what is left unwritten
when one of them refuses.

## Data model

Ten tables in WorkspaceDO's migration 63, and two more in migration 65.

`spaces` (created as `workspace_space_directory` and renamed by migration 72;
see [`hosted-conversation-parents.md`](hosted-conversation-parents.md#table-map))
is one row per Space: the name, appearance and scope
a projection wrote, the archive timestamp (written only by `finalizeArchive`
and `restore`; a projection never changes it), the protected `system_role`, the
generation/source-version/payload-hash triple every projection is fenced on, and
one `revision` that advances on every accepted change. A unique partial index on
`system_role` makes General singular. `space_viewers` is the
per-person half of the same projection and is where a Space's participants live.
`workspace_container_order` is `(user_id, container_kind, container_id,
item_id) → position` — every list a person arranges by hand, keyed by the
container it belongs to, with a `CHECK` narrowing `container_kind` to the three
containers the product lets somebody arrange. All's Pinned order is a table of
its own (`workspace_pinned_order`, migration 87), for the reason above. It replaced a Space-only
`workspace_space_order` **in place** in migration 63 rather than beside it,
because 61 is unreleased and a rename dance would have been migration
bookkeeping for a table nothing had yet stored.
`workspace_space_state` holds the one waterline both directories share.

`space_channel_memberships` is keyed by `(space_id, workstream_id)` with **no**
uniqueness on the Channel, because a Channel belongs to as many Spaces as it was
added to. `space_intents` is one row per staged cross-object operation, keyed by
the caller's operation id, carrying its kind, its target fences, the three
source-side fences required only by a move, its
receipts, the `cursor` its member walk reached, the `last_error_code` of its
most recent failed resume, and the retry gate the alarm claims on. The kind
vocabulary is exactly the six operations that stage one — `add`, `remove`,
`move`, `audience`, `archive`, `restore` — because a default's delivery and the cutover
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

**Migration 63 adds the two tables the dashboard list needs.**
`breakouts` is one row per `(workstream_id, substream_id)`
carrying what the forwarded effect carries — title, description, scope, state,
`last_activity_at`, `completed_at`, `archived_at`, the attention ordinals, the
created and updated instants — under the same generation/waterline/payload-hash
fence the Channel directory applies. `breakout_viewers` is the
per-person half, keyed by that pair plus `user_id`, holding `is_participant`,
`unread_count`, `you_are_mentioned`, `unseen`, `listable`,
`seen_attention_ordinal`, the manual-unread pair and the mention ordinal. The
columns are spelled the way the Channel directory spells the same facts on
purpose: one code-owned predicate text is rendered against both aliases, and a
column named differently here would be a second predicate pretending to be one.

There is no third table for [the refresh signal](#the-refresh-signal), and that
is the decision rather than an omission: the dashboard is told to re-read
itself, and nothing about that is worth a row.

Neither breakout table is a node in `workspace_retirement_graph`. That graph
enumerates parents whose conversations must be closed (a Channel, a Sidekick,
a Space), and a breakout is a conversation under a Channel, already walked as
one of its children. These are projections
in WorkspaceDO's own database, closed by WorkspaceDO's own tombstone like every
other row in it. What a new WorkspaceDO table does owe is a routing decision in
`apps/api/test/workspace-runtime-database.test.ts`, and both are declared there
as reached by typed RPC only.

**Migration 98 adds a Channel's read state**: two waterline columns on
`spaces`, `attention_ordinal` on `space_channel_memberships`, and the
`space_reads` table; see [The Channel's read state](#the-channels-read-state).

**Migration 64 deletes the eight Project tables**, after the invalidation
described under [Operations](#operations) and children-before-parents, because
`PRAGMA foreign_keys = OFF` is a no-op once a Durable Object event has touched
SQLite. [`projects.md`](projects.md) records what was deleted and what survived
it.

**Migration 102 rebuilds `spaces`** so its scope check admits `individual`, and
adds `spaces_individual_owner_idx`, unique on `created_by_user_id` where the
scope is `individual`. The rebuild holds `workspace_workstream_pins` aside and
puts it back, because those rows reference `spaces` with `ON DELETE CASCADE`
and the drop would otherwise empty them. **Migration 103** queues the one-time
seating alarm. **Migration 104 adds `space_messages`**: one row per Channel
message, keyed by `message_id`, with `space_id`, an optional `message_key`,
`author_kind` (`rally` or `member`), `author_user_id`, `body` and `posted_at`.
**Migration 109** adds four nullable columns to `space_messages`:
`source_workstream_id` (the thread a message is about), `attention_ordinal`
(its place on the waterline, `NULL` for a message that is not news and for
every row before it, read as zero), `embeds_json` (`[{id, title, kind}]` at
posting time) and `merge_operation_id` (the operation that last wrote the row).
It also adds `space_message_operations (message_id, operation_id, created_at)`,
a receipt for every operation that ever wrote a message, so a late retry of an
older one writes nothing.

## Regional impact

A Space lives in the same configured deployment as its Organization and its
Channels. Its id, membership, projections, grants, resources and Sidekicks do
not cross the regional boundary, and the Global identity service routes an
Organization before its `WorkspaceDO`, which hosts every Space, is addressed. No global Space index and no
cross-region Space exists. Every external hop a Space path makes is to the same
region's D1:

- **The membership and access-class check**, on every Space write RPC — the one
  read every Space path makes, and on most of them the only one.
- **Two `workstream_authority_control` reads and one `workstream_authority_routes`
  write**, when a Space is created or `ensureGeneral` finds no General:
  `bootstrapWorkstreamRuntimeEnvironment` reads the authority control row and
  writes the route anchor batch, and WorkspaceDO reads the control row again for
  the generation the Space's parent is born at. For General this is the
  fallback path (a new Organization's General is anchored in the create's own
  batch and passed its generation), so it is not on an ordinary Organization
  creation. The anchor batch carries the Channel-receipt claim read, so a
  Space create pays two control reads and one batch.
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

A version-zero reservation is cancellable only by the person who made it. `source_version = 0`
is a window every Space passes through between being reserved and its first
projection, so a cancel that named only the id could delete whatever anybody
else was in the middle of creating.

**A Space's mark and name are disclosed by a Channel inside it.** A person who
can read one Channel placed in a Space is told that Space's id, name, icon,
colour, scope and lifecycle, whether or not they are a participant — because a
Channel has to be drawn where it lives. Nothing else about the Space crosses:
its participants, its defaults and the Channels this reader cannot see are all
withheld, and its `channelCount` is narrowed to what they can see, so the size
of a participants-only Space is not inferable from a Channel row. Every write
is refused `space_access_denied` at two layers. The rule composes the other way
too: a Space name is the one thing its participants choose that its member
Channels' readers will see.

WorkspaceDO's directory and membership projections are discovery and
coordination state. **They never authorize Channel content**:
[a Space grants no reader](#a-space-starts-organization-wide-and-grants-no-reader). A grant a Space
seated before migration 94 keeps that provenance and is never published to the
shared scope-grant directory. A direct add of such a reader promotes the grant
to `direct` and publishes it, and an ordinary removal revokes it.

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

Migrations 61, 62 and 63 are visible through the existing Durable Object
migration tracker, and **the tracker's forced pass is what starts the cutover**: it wakes
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
`space_bootstrap_publication_failed` and `space_intent_resume_claim_failed`
with the Organization id, and each intent a resume could not finish logs
`space_intent_resume_failed` with its reason, which is also written on the row. The cutover's own progress logs
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

The engineering MCP lists Spaces with `list_spaces`, and a Space's parent
state is read with `run_workspace_sql` from the `parent_*` tables; see
[`engineering-mcp.md`](engineering-mcp.md). Everything a Space holds is in
those tables and `spaces`, `space_viewers` and `space_defaults`; a Space
created before 2026-09-26 also has an idle conversation the substream tools can
still open under the Space id.

A non-empty regional activity dead-letter queue remains the terminal failure
signal for default delivery and for a `move` intent's resumption. Every other
intent is resumed in WorkspaceDO and never reaches a queue, so its signal is
`space_intent_resume_failed`, which carries the Space id and the refusal's code,
and `last_error_code` on the `space_intents` row, which holds the same word for
whoever reads it afterwards; `space_default_delivery_failed` does the same for a
default target.

The Personal Channel backfill is one alarm (`personal_channel_backfill`) per
Organization. A member it cannot seat logs `space_personal_reserve_refused`
with the reason and throws, so the alarm retries; it settles without seating
while Spaces are not open, and closing the cutover queues it again when a
member is still unseated.

## Changelog

### 2026-10-21 — Archive exclusive threads with their Channel

**What changed:** A Channel archive records durable archive commands for its
exclusive threads and leaves shared threads active elsewhere. Each command uses
the normal thread archival path and a stable receipt; the existing intent alarm
retries interrupted deliveries. Exclusive placements stay under the archived
Channel, and restoring the Channel does not unarchive those threads.

**Why:** Archiving Blog during an experiment cleanup moved its content-calendar
thread into General, leaving the experiment active in another place. The person
asked to archive the container and its exclusive work together instead.

**Considered and rejected:** Keeping the move to General preserved the unwanted
work. Changing only directory rows would let the canonical conversation keep
running and later overwrite the apparent archive. A new archive queue would
duplicate the existing intent retries and thread-command receipts.

**Consequences:** Thread archive delivery crosses an object boundary and is
recoverable after the Channel transaction commits. Shared threads are never
selected. A retry must reuse its original receipt, and a Channel restore must
not undo an independent thread archive.

### 2026-10-21 — Reuse directories for user-scoped MCP lists

**What changed:** SpaceService exposes the socket's active Channel directory.
The existing conversation-page entryway accepts a kind and an optional all-visible
mode, filtering within the authoritative query before paging. App callers retain
the attention-only default. Creation accepts initial participants through the
ordinary audience update before starting icon selection with the updated revision.

**Why:** Engineers need a selected user's complete Channel/Thread/Breakout
hierarchy through MCP. The attention dashboard omits settled, read conversations,
and filtering a mixed page in an adapter would produce short or skipped pages.
Applying initial participants after starting icon selection would invalidate
creation's own revision fence and discard the generated icon.

**Considered and rejected:** New directory SQL or custom guest rules in MCP.
Reusing the app's readers preserves personal ordering, visibility and cursors.

**Consequences:** Ordinary membership and child-listing rules remain the gates;
all-visible means all unarchived, admitted rows, without the attention predicate.


### 2026-10-20 — Posting is the participation action

**What changed:** A member posting a Channel message, or starting a thread from
its composer, is seated in that Channel through the existing membership primitive.
Thread and breakout message admission already seats its author independently.

**Why:** Participation is the notification subscription. A person contributing
should receive later replies without a separate join action or author-history rule.

**Considered and rejected:** Deriving subscriptions from every past message would
duplicate membership and make leaving ambiguous. The ordinary participant row is
the durable subscription, and leaving removes it normally.

**Consequences:** Channel membership does not grant participation in other threads.
Rally messages do not join any user; message retries do not rejoin somebody who left.


### 2026-10-16: The Channel waterline counts news of any kind

**What changed:** A Channel message can be news. It takes the Channel's next
attention ordinal, lights the unread dot for everyone but its author, and
counts in `channelStats` beside placements. `stampPlacements` became a caller
of `stampChannelNews`, and `postMessage` gained `replace`, `news`,
`sourceWorkstreamId`, `embeds` and `operationId` (migration 109).

**Why:** Merge-back puts a thread's result into its Channel as a message, and
people need to see that it arrived. The earlier rule, only a placement advances
the waterline, would have left the merge silent. The product owner asked for
the waterline to be generic enough for the platform messages added a few days
before, so the counter now knows nothing about what a message is for.

**Considered and rejected:** Storing the merge on the thread's placement row.
That keeps the merge where the thread was placed, out of time order; a Channel
must read chronologically, with the merge at the bottom when it was merged.
A second counter for messages was rejected because the client reads one
waterline and one read position, and two would need two acknowledgements.

**Consequences:** An opening message passes `news: false`, and rows before
migration 109 have no ordinal, so no Channel turns unread on deploy. A message
about a thread is filtered by that thread's openability in both the feed and
the stats arm; a future message about something else needs its own visibility
rule in both. `newThreadCount` still counts placements only.

Design: [`docs/PRDs/2026-10-16_merge-back/prd.md`](PRDs/2026-10-16_merge-back/prd.md).
Mechanism: [`conversation-merge.md`](conversation-merge.md).

### 2026-10-13: Every member gets General and a Personal Channel

**What changed:** `SpaceScopeSchema` gains `individual`. A new Organization
reserves its creator's Personal Channel beside General in `initializeWorkspace`,
and every relationship change that leaves somebody an active member runs
`seatOrganizationMember`, which seats them in General and creates their
Personal Channel. WorkspaceDO migration 102 rebuilds `spaces` to widen its
scope check and adds `spaces_individual_owner_idx`; migration 103 queues a one-time alarm that
seats every existing member the same way. A Personal Channel is listed to its
owner alone, never to a guest. A Space's own
`directory_common` projection no longer writes `spaces.scope`. Client contract
5 marks a build that reads `individual`; older desktops are served `personal`.
Migration 104 adds Channel messages (`space_messages`), a building block any
Channel can carry; General and every Personal Channel open with one from
Rally, defined as data in `system-channels.ts`. The feed carries them as
`message` items, and client contract 6 marks a build that reads one.

**Why:** Product asked for a public General every member is in, and a private
channel per member that is theirs alone. A new scope rather than a
`personal` Space with one participant, because what makes it different is
that its audience can never change, and that has to be readable from the row
rather than inferred from a participant count.

The opening messages are ordinary Channel messages, not a welcome feature: a
generic author, body and time, posted through the same call anything else
will use, with the copy kept as data beside each Channel's name and icon.
Copy the desktop drew for an empty General was rejected for the same reason:
it would be a one-off, not something a Channel is made of.

**Considered and rejected:** A second `system_role`. The unique index on
`system_role` allows one row per role, so General's index would have needed a
rebuild as well, and the role would not have said who may see it. Storing
`personal` with an owner column, which leaves a scope the product treats as
its own kind unnamed in the schema. Raising `MINIMUM_SERVED_CLIENT_CONTRACT`
so old desktops never see the value, which would lock every not-yet-updated
build out of every Organization.

**Consequences:** The projection change also stops a private Space turning
public when its parent next publishes; `applyAudience` and the reservation are
the only writers of scope. Anything that compares `scope = 'personal'` to mean
"private" must use `scope <> 'workspace'`. A change to General's or a Personal
Channel's creation has to hold for all three paths. Dormant Organizations are
backfilled when they wake unless the WorkspaceDO migration is forced.

### 2026-10-13: Channel stats count the new rows

**What changed:** `ChannelStats` gains `newThreadCount`, counted in
`channelStats` with the feed's member predicate above the read position
`unreadState` derives (the reader's own, else the tracking start).

**Why:** The Channels tab now shows "N new threads" rather than a total. The
client could not derive it: a placement moved out keeps its ordinal, and
`threadCount` leaves out the private threads a member sees as locked rows, so
a Channel with only new private threads drew as read.

**Considered and rejected:** Deriving it on the client from the waterline,
for the reason above. Making the field optional, which would not help: the
risk is the other way round, an older desktop parsing the HTTP stats strictly.

**Consequences:** `ChannelStatsSchema` is strict, so a desktop build older
than this change rejects `GET /navigation/channel-stats` and the read
acknowledgement's answer until it updates; the socket's receive-only parser
takes the new field. A change to which rows the feed shows has to change this
count with it.

Shipped in [#1205](https://github.com/juno-ai-labs/avalon/pull/1205).

### 2026-10-13: A participant can leave a private Space

**What changed:** An audience change that takes the actor out of a private
Space answers `left` from WorkspaceDO and `204` from the route, and publishes
the Space snapshot like any other audience change. The desktop no longer adds
the actor back on every audience change to a private Space, only when making
one private.

**Why:** **Leave the channel** did nothing on a private Channel. The desktop
put the actor back into every `personal` audience it sent, so the request asked
for no change. Had it reached the server without them, the write committed but
the read-back could not render the Space for its former participant, so the
route answered `space_not_found` and skipped the snapshot that tells other
sockets.

**Considered and rejected:** Answering the leaver with the Space's summary as
the authority holds it. That labels a non-participant `participant` and names
the remaining participants to somebody who just lost the right to see them.

**Consequences:** A released desktop never sends a leave, so it never meets the
`204`. Any new client that sends an audience without its own user must accept
a `204`. The last participant still cannot leave; that would need an answer for
a private Space nobody can open.

Shipped in [#1207](https://github.com/juno-ai-labs/avalon/pull/1207).

### 2026-10-10: A Space is the product's Channel, and may be private again

**What changed:** A Space's audience may be `personal` again, by audience
change only; a private Space is listed to its participants alone; General
cannot be made private. The feed, participating and stats reads serve the new
navigation. Archiving a Space moves into General each thread it would strand
that is Organization-wide and that the archiver can list; any other stranded
thread keeps the archive refused, and a refused archive rolls back whole. A
Space now has an unread waterline that only a thread's placement advances and
a per-person read position in `space_reads`, in breakout-identical columns
(migration 98), with an acknowledge route and no mark-unread. The desktop's
Space pills, single sidebar and Space dashboard are deleted, and with them
every reader of the hand-arranged order; the snapshot keeps `ordering`,
`pinnedOrder` and `spacesReady`, and `PUT /workspace/order` stays, for
released desktops that require them. A read or a pin write publishes a small
per-person frame (`workspace_navigation_state`) rather than a Space snapshot,
`channelStats` leave the broadcast snapshot, and `space_conversations_changed`
says whether a placement moved, so a message re-reads only the open feed.

**Why:** The navigation redesign turns each Space into a Channel and lets a
Channel be private
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). Every Space
already had the parts a Channel needs: rows with no conversation of their own,
many-to-many placement, General, Slack room bindings and canonical links. A
thread started from a Channel's composer has that Channel as its only home, so
refusing every archive that strands one would have made archive unusable, and
General is where every member already looks. The move stops at threads that
are Organization-wide and listable by the archiver: moving a private thread
would show it as a locked row to every General reader, and moving one the
archiver cannot list would let them act on work they cannot see. The
waterline exists because the redesign asks for an unread dot on Channel rows
and Recent and Needs-attention sorts, and a Channel's news is a thread
arriving in it. Republishing a whole Space snapshot for one person's read
rebuilt every directory on every acknowledgement, and re-reading the Threads
and Activity lists on every message cost each open client a full read per
message in the Organization. Dropping the order fields from the wire was
considered and deferred: a released desktop's snapshot schema requires
`ordering` and `spacesReady`, so removing them would have stopped those
desktops hearing any Space change.

**Considered and rejected:** A new channel table, which would copy rows,
re-key pins, move hosted parents and D1 anchors, re-point Slack bindings and
rewrite links for no product gain. Delta member routes beside the audience
route: `noteSpaceAudience` already sets the scope and the whole participant set
in one transaction. Moving every stranded thread into General, private ones
included, for the disclosure above. Advancing the waterline on activity inside
placed threads, which would make every Channel unread whenever any thread in
it moved and duplicate the thread's own unread state. Read-position columns on
`space_viewers`: most readers of an Organization-wide Space have no viewer row,
and that table is a projection that deletes rows. A Channel SubstreamAgent of
its own: the feed is a per-viewer projection of mutable placements, and
WorkspaceDO already owns the listing rules, so an agent would add a hop and a
second authority over the same fact. Channel mark-unread, cut with its columns
and route: nothing in the product asked for it, and two unused columns in a
new table are cheaper never to add than to drop.

**Consequences:** Migration 94's "every Space is Organization-wide" no longer
holds; its migration is not touched. Only a placement may advance a Channel's
waterline, and only through `stampPlacements`; a new path into `active` that
skips it is a Channel that never turns unread. The columns are spelled as a
breakout spells them, so a future Channel SubstreamAgent under the Space's
existing parent (`hostedParent(spaceId)`) can write them through directory
effects; revisit the WorkspaceDO decision when Channels gain chat, mentions or
typing. An archive that rehomes must stay one transaction with the archive
itself. `workspace_container_order` is kept only because the directory still
reads through its `organization` rows. Storage names stay, and the product
words differ from them.

### 2026-10-08: A Space lists Organization invitees until they join

**What changed:** WorkspaceDO migration 96 adds `space_invitees`. The audience
write takes an optional `inviteeEmails`, `GET /spaces/:id/invitees` reads them,
and accepting an Organization invitation seats the person in every Space that
listed their address.

**Why:** Every people picker now offers people invited to the Organization
before they join, and a Space's participants editor was the one that could
not, because a Space participant is a user id.

**Considered and rejected:** A field on `SpaceSummary`, which shipped desktops
parse strictly and would reject. A D1 table beside `workspace_invitations`,
which would put Space membership state outside the object that owns every other
part of it. Sharing each of the Space's Channels instead, which would grant
access a Space never grants.

### 2026-10-07: A new Organization opens General in its one object call

**What changed:** `initializeWorkspace` takes an optional `general` (creator,
space id, authority generation) and answers `{ spacesReady }`. With it, a new
Organization's object reserves General through `reserveGeneral` (the write half
of `openGeneralSpace`, now shared) and closes the cutover in that call, after
the regional create wrote General's D1 anchor and route in the batch that made
the Organization. The Space half of the call is best effort.
`openGeneralSpaceForNewWorkspace` is now the fallback for `spacesReady: false`.
`claimParentAnchor` puts its Channel-receipt read in the anchor batch, and the
`workstreams` anchor writer lost its pre-0090 schema probe and retry.

**Why:** Organization creation was slow. `ensureGeneral` asked whether General
existed in an Organization made a moment earlier, the placement affinity was
looked up twice though the caller had it, the object re-read the authority
control row, and `runFinalize` was a call of its own. Every activation of an
existing Organization paid the same calls and a snapshot publish for nothing.

**Considered and rejected:** Moving the D1 anchor write into the object. The
anchor has to exist before the object writes General, the order
`ensureGeneral` keeps, and the create's batch already writes D1 in that order
at no cost.

**Consequences:** `ensureGeneral` is no longer the only path that creates
General. Both go through `reserveGeneral` and the same creator check, and the
unique index still decides a race between them; a change to how General is
made has to hold for both. The fast path runs only while the authority accepts
new work. The anchor writer assumes the post-0090 shape; a database still
before 0090 can no longer be written to.

Shipped in #1142.

### 2026-10-06 — Every Space is Organization-wide and grants no reader

**What changed:** A Space can only be Organization-wide: the create and
participants requests accept only `workspace`, and WorkspaceDO migration 94
widened every existing Space. A Space no longer grants its audience to its
Channels, so the code that applied it (`SpaceChannelAccess`, the source plans,
the hosted parent's source tables, member walks and the containment preview)
was deleted and migration 94 drops its tables. Add, remove, move, archive and
restore are each one WorkspaceDO transaction; `space_intents` rows staged before
the deploy are finished by `resumeLegacyIntent`. A default's Queue delivery acts
as the person who staged it rather than as a Space participant.
`channel_scope_locked_by_space` is no longer raised, and the cutover no longer
asks containment before placing a private Channel in General.
`POST /workstreams` asks for `workspace` itself, since General no longer makes
new Channels public. Slack rooms all get Organization-wide Spaces, and a room's
Channel takes the room's own privacy.

**Why:** A product decision that Spaces are public and only public. Under the
old rule a public Space made every Channel in it public and a Channel inside one
could not be made private, so "Spaces are public" would have meant "every
Channel is public". Private work belongs to the Channel, including a private
Slack room's.

**Considered and rejected:** Making new Spaces public by default and widening
existing ones through the audience walk (the first version of this change). It
kept Spaces granting access, so it would have opened every private Channel in a
formerly private Space to the whole Organization. Keeping the Space-source
code with empty plans: it cost two transactions and a Channel round trip on
every drag, archive and restore, and kept stored plans that could replay the
old rule. What it taught is in
[`space-access-sources.md`](space-access-sources.md).

**Consequences:** A Channel's own scope is its whole audience. Formerly private
Spaces lose their resource defaults, which somebody re-adds against the
Organization-wide audience check. Readers a private
Space seated before migration 94 stay seated as the Channel's own, and nothing
withdraws them when the Channel leaves that Space. Internal creators that name
`personal` (digests, imports, a Sidekick's suggestions shown to one person) now
get private Channels where General used to make them public. `SpaceScopeSchema`
still reads `personal` for old rows, and the desktop keeps the copy for the
three retired refusal codes for an older server during a rolling deploy.

Pull request: [#1119](https://github.com/juno-ai-labs/avalon/pull/1119).

### 2026-10-05 — Rally chooses a new Space's icon from its name

**What changed:** `iconKey` is optional on `CreateSpaceRequest`. Without one,
the Space is created under `circle-dot` and the Channel naming call picks an
icon from its name in the background, written through `noteSpacePresentation`
under a new `ifRevision` fence. The sidebar's **New space** stops sending
`briefcase`.

**Why:** The sidebar creates a Space from a name alone, so every Space it made
carried the same briefcase until somebody changed it by hand. Channels already
get an icon from the naming call; reusing that call, prompt and catalog keeps
one policy for generated icons.

**Considered and rejected:** Choosing the icon on the create path, which would
put a model call in front of the response. A Space-specific prompt, which would
drift from the Channel one. Fencing on "the stored icon is still the
placeholder" instead of the revision: a Space has no provenance on its icon,
and the revision already moves on every edit a person can make.

**Consequences:** A person who edits the Space (any field the revision covers)
inside the second or two the call takes keeps `circle-dot` unless they picked
an icon. With no `OPENROUTER_API_KEY` or an unreachable model the Space keeps
`circle-dot`. A new revision-advancing write that runs automatically right after
creation would silently disable this pass.

Pull request: [#1099](https://github.com/juno-ai-labs/avalon/pull/1099).

### 2026-09-30 — Archived leftover Channels do not block Space archive

**What changed:** `prepareArchive` tests final membership against Channels that
are not known to be archived. A membership whose directory row has not landed
still blocks: the guard fails closed. Known-archived members still stage to
`removing` with the rest, so restoring the Space still returns them. Archive
and restore walks that reach an archived Channel retract or re-apply its
hosted-parent source from the directory projection and skip conversation
seating, because the product read answers 404. The archive confirmation looks
up a blocked Channel's title from the sidebar directory as well as the
dashboard's Needs attention page, instead of printing "A channel not loaded on
this device" for one that is merely idle.

**Why:** The dashboard's empty Needs attention list is not a catalog of the
Space. A Space whose Channels are all archived reports `channelCount` 0 and
draws "No channels yet", then refuses archive because an archived Channel still
has a membership — the row that would return it if it were unarchived. Nobody
can add that Channel to another Space first: it is on no list. The same dialog
looked titles up only in the Needs attention page, so even a live idle Channel
the sidebar already knew was named as unloaded.

**Considered and rejected:** Rehoming archived leftovers into General so the
invariant stayed "every Channel, including archived ones." General is
Organization-wide, and seating a personal Channel there would lock its scope
public. Keeping the membership on the archived Space, staged rather than
dropped, is the restore path that already existed. Inner-joining `channels` the
way `channelCount` does was also rejected: undercounting a dashboard number is
harmless, and dropping an unprojected live Channel from the guard would
archive the Space out from under it.

**Consequences:** Unarchiving a Channel whose only Space is itself archived is
still not a product path — the Channel would come back with no live home.
Restore the Space first. A live Channel whose only Space is this one still
blocks archive, including while its directory projection is still in flight,
and the confirmation now names it from whichever catalog this device has
already loaded.

Shipped in [#1033](https://github.com/juno-ai-labs/avalon/pull/1033).

### 2026-09-26 — A Space is WorkspaceDO rows only; its hidden conversation is retired

**What changed:** `SpaceService` no longer writes a Space's hidden main
conversation. Creation writes the D1 anchor (`claimParentAnchor`, split out of
`bootstrapWorkstreamRuntimeEnvironment`) and reserves the Space in WorkspaceDO,
and opens no object. A rename, an audience change and a default are one
WorkspaceDO write each; a Sidekick default's recommendation on the Space's
hosted parent is written inside `addSpaceDefault`/`removeSpaceDefault`,
authorized from the Space rows. A resource default refuses an upload draft
(`attachment_draft_requires_message`, `ResourceService.getAttachable`), the
check the conversation's `attachResource` used to make. A directory effect a legacy Space conversation still has in flight is
acknowledged by the Space's hosted parent and applied nowhere. Deleted:
`provisionSpaceConversation`, `provisionOrTakeBack`, the audience rollbacks,
`WorkstreamObjectClient.forSpace`, and the take-back path
(`cancelSpaceReservation`, `discardCreation`, `discardUnopenedReservation`).

**Why:** Every Space read already came from WorkspaceDO (`spaces`,
`space_viewers`, `space_defaults`), so the conversation was a second authority
nothing read, whose projections could only overwrite the first. That is how a
rename un-archived an archived Space (the entry below). It also cost each Space
edit a cross-object write and a rollback path, and each creation a Durable
Object and a take-back for when provisioning failed. Before the change, all 31
Spaces in all 20 Organizations were compared against their conversations:
title, scope, appearance, participants and resources matched everywhere, no
conversation had an undelivered effect, and the only difference was the
`archived_at` the conversation never records.

**Considered and rejected:** Dropping Space envelopes in
`applySpaceDirectoryEnvelope` instead. A Space's reservation publishes its own
first projection through that path, so the drop sits where only the
conversation's effects arrive: the hosted parent's child `0`. Deleting the
legacy conversation objects and the D1 anchor in the same change: the objects
cost only storage, and the anchor is still the claim that stops a Channel
create taking a Space's id.

**Consequences:** A Space has no conversation to fail, so there is no
take-back and no `space_authority_unreachable` from an edit; the seam is now
the anchor. The Space's hosted parent holds no current copy of its audience,
so nothing may authorize a Space write there: a Sidekick recommendation
authorized by the hosted parent refused a participant added after creation. Anything new a Space needs to hold
goes in WorkspaceDO. Retiring the idle objects, and the `SubstreamAgent`
guard that refuses a Space parent a loop, is left for later.

### 2026-09-26 — A Space's projection no longer un-archives it

**What changed:** `applyDirectoryProjection` keeps a Space's stored
`archived_at` rather than taking the projection's, and an archive-only
difference no longer counts as a change. Archival is now written by
`finalizeArchive` and `restore` alone.

**Why:** The hidden conversation reports every Space unarchived, and
`finalizeArchive` and `restore` write `archived_at` without advancing
`source_version`. Renaming an archived Space, or changing its defaults or
audience, made the conversation publish a projection at a newer version, and
the fence let it write `archived_at = NULL`. The Space then listed as active
while its memberships stayed withdrawn, and `restore` refused it because it
was not archived: the Space was stuck.

**Considered and rejected:** Advancing `source_version` on archive and restore.
The conversation's next projection would still claim a newer version and carry
the same null. Refusing edits to an archived Space would hide the symptom for
rename but not for the paths that reach the conversation before WorkspaceDO
refuses.

**Consequences:** Renaming an archived Space is still allowed and leaves it
archived. Anything that needs to archive a Space goes through WorkspaceDO's
own archive and restore; a projection cannot. Moving a Space's remaining facts
out of its hidden conversation is the follow-up that removes the projection
entirely.

### 2026-09-25 — Space operations run in WorkspaceDO, and the Worker's Space-source saga is deleted

**What changed:** Creating a Space, an equal-audience move and a Channel's birth
each commit in one WorkspaceDO transaction (`reserveSpace`, `openGeneralSpace`,
`moveSpaceMembership`, `reserveChannelInSpaces`; the birth is recorded in
[`workstream-creation.md`](workstream-creation.md#changelog)). Adding, removing
and walking Channels, and the cutover's placements, are one call each (a walk
one per page) driven by `SpaceChannelAccess`, whose plan is recorded under ids
derived from the intent and commits an application with its planned seats. The
alarm resumes every intent kind in place, stored `move`s included, one step per
intent per alarm, single-flight per operation id. Creation asks
`admitSpaceCreation` before it anchors, and takes a Space back when its
conversation cannot be provisioned. A Sidekick default on a hosted Channel is
written in the staging transaction. Deleted: the staged membership, removal and
move RPCs, `ensureGeneralSpace`, the version-zero `reserveSpace`, the Worker's
`applySpaceSource`/`retractSpaceSource` and the alarm's resume publication.

**Why:** The Space rows, the memberships and every Channel's provenance are one
SQLite database since [hosted conversation parents](hosted-conversation-parents.md),
and each saga step had become a hop back into the same object. An add went from
five Worker calls to one, a removal from three or more to one, a walk to one per
page, and a resume from a Queue round trip to none. A resume that planned again
found the departing source already deleted, so it withdrew nobody.

**Considered and rejected:** Keeping the Worker as the relay for the
conversation calls; keeping the old RPCs through a rollout (the deploy promotes
at 100%, so only data at rest needs them: queued messages and stored intents);
anchoring after reserving, which turns a D1 failure into a listed Space.

**Consequences:** Never ship this as a percentage split. Until an add settles,
its source names readers who may not be seated yet. A take-back is refused once
a Channel is in the Space or its conversation has published; a conversation that
initialized before the failure and publishes after the take-back recreates the
Space. The in-place Sidekick default trusts `automation_directory`.

### 2026-09-23 — Resume internal Space creation under a stable identity

**What changed:** Internal `SpaceService.create` callers may supply an identity;
replays reuse the reservation, preserve it on provisioning failure, and refuse
changed creation attributes or an inaccessible identity. The HTTP
create contract is unchanged.

**Why:** Two demo Channels need one account Space even after interrupted setup.
[Demo workspaces](demo-workspaces.md#2026-09-23--demonstrate-human-intervention-in-shared-outcomes)
records the owning decision.

**Considered and rejected:** Looking up Spaces by title, which would make a
mutable display name the creation identity.

**Consequences:** Internal callers own identity stability. Replaying creation is
not an update API; audience and appearance changes use their normal writers.

Shipped in [#956](https://github.com/juno-ai-labs/avalon/pull/956).

### 2026-09-22 — Needs attention shows the Channel-to-Breakout identity

**What changed:** Every Needs attention row now puts its conversation identity
before the name. A Channel is its icon inside the shared pebble. A Breakout is
its parent Channel pebble, the `chevrons-right` mark, and its own bare icon.
Each icon opens the same identity tooltip used by the Channel rail. Breakout
projections now preserve their selected appearance, and the Space page joins
the parent Channel's appearance into the Breakout row. WorkspaceDO migration
69 adds the nullable projection column; older rows use the id-derived fallback
until their next projection arrives. A breakout projection can still be
accepted against the older table while an Organization is held before the
appearance migration; that write omits the new column until it exists.

**Why:** The icons make a Breakout's relationship to its Channel scannable
alongside the existing `in Channel` text. Reusing the rail's marks and tooltip
keeps the identity consistent, while projecting saved appearances prevents the
table from disagreeing with the conversation after it opens.

**Considered and rejected:** Deriving both marks from ids only. That would have
needed no projection change, but a person who had customized either appearance
would see a different identity in Needs attention. A new one-line tooltip was
also rejected because Channel and Breakout marks already have a purpose-built
identity card.

PR #941. Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.

### 2026-09-22 — Deep links reveal their hierarchy selection

**What changed:** A desktop deep link to a Channel now carries a renderer-local
navigation signal until the destination directory is mounted. Once the Channel
row is available, the left rail selects a containing Space and both that Space
row and the active Channel row are centered in their respective scroll views,
clamped naturally near either end of a short list. Ordinary in-app navigation
does not recenter either rail.

**Why:** The route alone selected the Channel surface, but it could leave the
Space rail describing a different container and both selected rows outside the
visible part of long navigation lists. Treating every route change as a reveal
was rejected because clicking an already visible row should not move the lists
under the reader.

**Consequences:** The signal is retained across an Organization switch until
the live Space hierarchy arrives, walks existing directory pages until the
matching Channel row is found, and is discarded if the target is absent or the
reader navigates elsewhere. Repeated deep links to the already-open Channel
rearm the reveal even though the hash itself does not change.

### 2026-09-22 — Pre-Space Organizations retain breakout projection retries

**What changed:** WorkspaceDO now leaves a breakout directory envelope
unaccepted, without writing its receipt, while meeting-notes cleanup holds the
Organization before migration 63 and its breakout tables do not exist. The
activity consumer's existing incomplete-acceptance check retries the same
envelope after the Organization advances.

**Why:** WorkstreamDO migration 19 emits each quiet existing Breakout only once.
The earlier compatibility guard accepted and dropped every breakout projection
while the destination tables were absent, which was tolerable for ordinary live
updates that later supersede the row but permanently lost that once-only
backfill. Those Breakouts would therefore remain absent from Space pages and
Channel attention badges even after both migrations completed.

**Considered and rejected:** Receipting the replay and relying on a future child
update repeats the bug for quiet Breakouts. Adding a second backfill mechanism
or destination-readiness RPC to every Channel duplicates the Queue's existing
retry contract and adds a cross-object check to the source migration.

**Consequences:** A breakout projection that reaches an Organization still at
schema 57 retries instead of terminating successfully. Other directory effects
in the same request retain their normal acceptance, and once migration 63 is
present the unchanged receipt and projection fences apply the retry exactly
once.

### 2026-09-22 — Space selection keeps the Spaces rail open

**What changed:** Selecting a Space in the desktop's left rail now keeps that
rail expanded while updating the Channels shown in the middle rail. Opening a
Channel from the middle rail still compacts Spaces; manual and responsive
collapse behavior is unchanged.

**Why:** A Space selection is still active navigation within the left rail. It
needs to remain visible while the person compares Spaces and their Channels;
conversation width becomes useful only after a Channel destination is chosen.

**Considered and rejected:** Keeping the previous collapse on both Space and
Channel selection. That hid the list before the hierarchy choice was complete.

**Consequences:** Automatic desktop compaction now marks the transition from
hierarchy selection to a Channel, rather than every selection within the
hierarchy. Browser navigation keeps its existing host-specific behavior.

### 2026-09-22 — Desktop Channels and shared React Breakouts use alphabetical navigation order

**What changed:** The desktop selected Space's unpinned Channels and the shared
React Channel rail's Breakouts now sort case-insensitively by title with one
fixed locale and stable identity tie-break. Main remains the first row in the
Breakout rail and **New breakout** remains last. Pinned Channels keep their
separate manually ordered section, and an unpinned Channel can be dragged from
the alphabetical list into Pinned even when that section starts empty; the
alphabetical Channel and Breakout lists no longer offer pointer or keyboard
reordering.

**Why:** Activity and per-person arrangements made the hierarchy move between
visits and disagree between people. These rails are navigation directories, so
stable title order makes a destination predictable while preserving the one
explicit prominence choice: pinning.

**Considered and rejected:** Applying A–Z only as the fallback behind stored
orders would leave existing users in the previous order and preserve a gesture
that contradicts the new rule. Dropping the stored rows or narrowing the wire
contract was also rejected: the rows are harmless compatibility data and a
destructive migration is not needed for a presentation change.

**Consequences:** `space` and `channel` container orders may remain stored but
are ignored by these desktop/shared-React rails. Only the Space rail and Pinned
section currently expose manual ordering; cross-Space Channel movement is
unchanged. Native iOS has its own navigation presentation and is not governed
by this React component contract.

### 2026-09-22 — Cross-Space drops leave the source rail immediately

**What changed:** Moving a Channel between Spaces now patches its placement in
the desktop cache as soon as the drop is accepted and rolls that patch back if
the server refuses it. The destination pulse begins with the drop rather than
after the network response. If the moved Channel is open, navigation continues
to the next Channel down in the selected Space, otherwise the one above; moving
the Space's last Channel opens the New channel home.

**Why:** Waiting for the authority round trip left the dragged row in its old
Space after the gesture and made the destination feedback arrive late. Once the
row disappears immediately, an open route also needs an explicit adjacent
destination instead of continuing to display a Channel the selected rail no
longer contains.

**Considered and rejected:** Waiting for success before changing either rail or
route preserves a literal server-confirmed view, but makes a direct manipulation
feel unresponsive and leaves the current screen out of step with the optimistic
sidebar. Choosing the globally most recent Channel was rejected because the
gesture is scoped to the selected Space and already has a visible local order.

**Consequences:** A refusal restores both the source placement and an
optimistically displaced route, then presents the existing acknowledged failure
dialog. The route transition is decided from the pre-drop displayed order,
with lower preferred over upper, and replaces the current history entry so Back
cannot reopen the displaced selection. When that lower row belongs to a page
still in flight, navigation waits for the row rather than mistaking the loaded
slice for an empty Space. Moves of the same Channel settle in gesture order,
and each destination pulse owns its timer, so an older settlement cannot
overwrite a newer placement or strand newer feedback.

### 2026-09-22 — Equal-audience Channel moves replace provenance instead of rebuilding access

**What changed:** A move between Spaces with the same scope and participant
roster now stages one `move` intent in WorkspaceDO, replaces the Space access
source and its supplied-reader attribution in one WorkstreamDO transaction, and
atomically activates the target membership while removing the source. The
intent carries both Space revisions and membership generations and is resumed
by the existing alarm path. A stale source fence switches that same intent to
a durable audience-convergence mode rather than spawning separate add and
remove intents: it restores the source if the fast swap already removed it,
using only the audience already stored on the target rather than the source's
possibly widened live roster, rebuilds the destination through canonical
audience operations, then retires the source and finalizes the original
membership generations. The fast swap also proves the prepared source revision
and membership generation before deleting it, so a same-audience source that
was removed and re-added cannot satisfy a stale move. Recovery reads persisted
provenance directly from WorkstreamDO and spends the WorkspaceDO-staged intent;
it does not re-authorize against the initiating user's mutable Channel access
after provenance may already have moved.

**Why:** The prior server-side operation removed an HTTP boundary but still
performed a complete add followed by a complete remove. For the common move
between equivalent personal Spaces, that paid repeated Channel reads and two
plan/apply/confirm authority conversations even though no reader or scope was
changing. The new primitive makes the synchronous path one WorkspaceDO prepare,
one WorkstreamDO provenance transaction, and one WorkspaceDO finalize.

**Considered and rejected:** Running add and remove concurrently would let a
source removal strand the Channel when the destination failed, and returning
before either authority settled would report a move that had not happened.
Blindly renaming the source without comparing the stored roster was rejected
because stale provenance could silently grant the wrong audience.

**Consequences:** Equal-audience moves do not invoke canonical Channel audience
mutations or SubstreamAgent writes; unequal audiences still do and retain their
content and grant fences. Move finalization and cancellation authorize against
the exact persisted actor, Space ids, Channel id, and generation fences rather
than mutable Space reach after WorkstreamDO has committed. A fallback or crash
remains on the original intent, and every interrupted move resume repeats the
convergent path. Competing moves cannot treat another move's
source removal as their own replay: only an already-active target may replay a
settled source. Migration 68 rebuilds `space_intents` to admit `move` and
require its source-side fences.

### 2026-09-21 — Space archive Channel retractions overlap within the platform envelope

**What changed:** A Space archive now retracts its source from as many as six
member Channels concurrently, in bounded batches within the existing paged
walk. The request and an alarm resume use the same path, wait for every started
retraction with settled-promise semantics, and advance the durable cursor or
finalize the Space only after the whole batch succeeds.

**Why:** The prior walk paid each Channel authority round trip serially, so
archive latency grew as their sum even though the retractions are independent.
Six matches Cloudflare's simultaneous outgoing-connection limit and changes the
common one-to-six-Channel path to the slowest retraction rather than the sum,
supporting the 500 ms P50 target without relaxing an authorization, preflight,
or synchronous-convergence rule.

**Considered and rejected:** Finalizing the Space before source retractions
finish would return sooner, but would turn a synchronous authority transition
into background convergence and allow the archived Space's access source to
remain live after success. Unbounded fan-out was rejected because the runtime
would queue work past its connection limit and failure could leave unobserved
sibling writes.

**Consequences:** Archive batches may issue six independent Channel RPC chains
at once, but all are joined before failure propagates. Audience and restore
walks remain sequential because they apply mutable revisions rather than only
withdraw an independent source. The 500 ms P50 remains a live-performance
target, not a claim established by capability-double timing.

### 2026-09-21 — Move Channels server-side and make ancestor metadata associative

**What changed:** Cross-Space movement is one server request. The server validates
the source without mutation, then settles the destination before retracting it,
while the client patches the two
Space summaries and Channel placement immediately from that response. Removal
and archive no longer perform the obsolete audience-discoverability preflight.
Any person who may read a Channel or Breakout now receives the name, icon,
colour and public/private scope of its Channel and Space ancestors in desktop
and browser navigation. Realtime and directory convergence run after the
durable membership answer instead of extending its latency. Guest hierarchy
refreshes reuse existing Organization and open-conversation socket nudges, and
breakout-only grants synthesize their Channel ancestor without requiring Main.

**Why:** Client composition paid two HTTP boundaries, repeated authority reads,
then waited for a directory refetch. The discoverability refusal also encoded
the opposite of the product rule: a readable descendant must make its hierarchy
identifiable even when the reader is not a Space participant.

**Considered and rejected:** Returning before the destination grant or source
retraction was rejected because it would report a move while access was still
wrong. Making ancestor visibility imply participation was rejected because it
would disclose rosters, defaults and content and grant writes merely from a
descendant share.

**Consequences:** The synchronous boundary is one local source preflight,
durable staging plus the two
Channel access-source writes, in destination-first order. An interruption can
leave an extra placement but never a homeless Channel. Ancestor reads are
metadata-only and `through_channel`; all controls remain withheld. Live socket
Channel fields win over an older associative read; the latter owns containment,
authorized conversation destinations, and missing ancestor rows.

### 2026-09-21 — Sidebar recovery stays actionable and free of warnings

**What changed:** Reorder, placement and cross-rail move failures no longer
render error copy as a row inside either Space or Channel sidebar. They open one
acknowledged error dialog with stable action-specific copy, an **OK** action and
focus on that action; the optimistic arrangement still falls back to the order
the authority last confirmed. Errors that belong to an already-open edit or
archive dialog remain in that dialog. A stale Space directory likewise keeps
its last known rows, but now presents a normal **Refresh** row instead of an
inline warning and retry block. The same recovery row replaces stale-data copy
in the Sidekick section, including when no Sidekick rows arrived.

**Why:** Navigation is persistent product structure, so inserting transient
failure text into it makes an operational error look like a Space or Channel
and shifts the very list the person was arranging. A modal interruption is the
honest shape for a failed gesture that needs acknowledgement, and a shared
dialog primitive keeps new sidebar actions from reintroducing inline errors.
When no error needs acknowledgement, the sidebar exposes recovery as an action
rather than writing diagnostic state into persistent navigation.

**Considered and rejected:** Leaving stable warning copy in the rail was
rejected because it still becomes persistent navigation content. Clearing the
directory until a reconnect succeeds was rejected because the last confirmed
rows remain more truthful and useful than an empty hierarchy.

**Consequences:** New sidebar mutations must route failures through the shared
acknowledgement dialog rather than append copy to a list. Stale directory
states keep confirmed rows and expose the shared Refresh row; the Space
directory's action remains a socket reconnect rather than a second fetch path.

PR [#919](https://github.com/juno-ai-labs/avalon/pull/919).

### 2026-09-21 — Hierarchy rows carry live attention totals

**What changed:** Space summaries now carry the number of Channels and
Breakouts the Space dashboard would admit for the viewer, and Channel summaries
carry the matching count of admitted Breakouts. The opening workspace payload
contains both; later projection changes update Channel rows and add Space totals
to the existing dashboard nudge.

**Why:** Deriving badges from the device's loaded rows undercounts paginated
Spaces and cannot see unopened Breakouts. Republishing the complete Space
snapshot on every message would put a directory rebuild on the hottest
projection path. WorkspaceDO already owns the complete viewer-scoped tables and
the exact dashboard predicate, so its aggregate is both cheaper to trust and
impossible for the two surfaces to define differently.

**Considered and rejected:** A client-side filter over Channel markers, which
has no complete child directory; a durable counter updated on every message,
which duplicates state already queryable in one authority; and full Space
snapshot republication for every attention change.

**Consequences:** Space summary reads pay one local aggregate query per visible
Space, while directory Channel pages load Breakout totals in bounded fan-in
queries. A future change to what “Needs attention” means must change the shared
SQL predicate and keep the aggregate/page equivalence test able to fail.

### 2026-09-21 — A cross-rail drag moves its Channel

**What changed:** Dragging a Channel from the selected Space's center rail onto
a different Space in the left rail now adds the destination membership and then
removes the source membership. The context-menu **Add to space** action remains
additive. An eligible Space holds a visible target highlight while the Channel
is over it, then pulses the accent colour three times in quick succession when
the membership move settles successfully. Each pulse eases through its rise and
fall rather than switching the accent on and off; reduced-motion settings replace
the pulses with the same accepted state held briefly. Read-only source placements
do not advertise the cross-rail move, and a cross-rail drop always abandons any
pinned or unpinned order preview built while the pointer crossed Channel rows.

**Why:** The adjacent rails present the Channel as a member of the selected
Space and the destination as a peer container. In that layout, carrying the row
across reads as moving it between containers; leaving the source membership in
place made the gesture silently duplicate the placement instead.

**Considered and rejected:** A new server-side move primitive. Space membership
already has durable, idempotent add and remove operations, and composing them
destination-first preserves the final-membership invariant without adding a
second implementation of those authority transitions.

**Consequences:** A failure after the destination settles can leave the Channel
in both Spaces, which is visible and recoverable; it cannot leave the Channel in
neither. The drag payload carries its source Space explicitly, while ordinary
Space reordering and within-Space Channel ordering retain their existing paths.

### 2026-09-21 — Pin state follows the Space placement

**What changed:** A Channel pin is now keyed by person and Space as well as
Channel. Space membership removal deletes the pin for that placement, and a
Channel shared by two Spaces can be pinned independently in either one.

**Why:** The sidebar presents Channels inside the selected Space. A global pin
made one placement's navigation choice leak into every other container that
happened to include the same Channel.

**Considered and rejected:** Treating pinning as another
`workspace_container_order` kind. That primitive arranges members but does not
own membership; a pin row deliberately owns both “included in the shortlist”
and its position.

**Consequences:** Migration 66 clears legacy pins because they carry no Space
identity. A placement removal must keep deleting its pin in the same
WorkspaceDO transaction, while other placements remain untouched.

### 2026-09-21 — Place guest browser Channels in visible Spaces

**What changed:** WorkspaceDO can project the name, icon, colour and authorized
Channel IDs of every active, viewer-visible Space containing a guest's
canonically admitted Channels. The browser uses that bounded projection for its
Space and Channel rails; it receives no participant, default, audience or
lifecycle fields.

**Why:** Direct Breakout grants are indexed by Channel owner, so the browser had
enough authority to open conversations but not enough containment information to
group two shared Channels under two different Spaces.

**Considered and rejected:** Reusing the member Space directory would disclose
more Space state than browser navigation needs. Omitting the existing viewer
predicate would let an admitted Channel name somebody else's unrelated personal
Space. Trusting caller-supplied Channel IDs would turn a containment lookup into
a Space-name oracle, so WorkspaceDO intersects them with the guest's current
membership-incarnation candidate index.

**Consequences:** Space identity follows the existing `through_channel`
disclosure rule, but this browser projection is intentionally smaller than a
`SpaceSummary`. Canonical WorkstreamDO reads remain the label and conversation
authority, and the final relationship revision fence empties the whole response
if guest membership changes while the read is in flight.

### 2026-09-21 — Add to space shows the whole visible directory

**What changed:** **Add to space** lists every Space visible to the reader.
Spaces the Channel already belongs to stay checked and disabled; Spaces reached
only through one of their Channels stay disabled, with a tooltip explaining
that only Space participants may add Channels. Disabled rows remain in keyboard
navigation so the same explanation is available without a pointer.

**Why:** Removing unavailable destinations made the submenu disagree with the
Space rail. A reader could see Engineering beside General and VCs, then open
**Add to space** and find only VCs, which looked like stale membership data
rather than an access boundary.

**Considered and rejected:** Continuing to hide read-only and existing
placements. That keeps the menu shorter, but leaves no place to explain why a
visible Space is absent and makes an existing placement indistinguishable from
a permission refusal.

**Consequences:** The submenu is now a directory as well as an action list.
Future unavailable Space states must remain visible there with a specific
disabled reason; the server's `through_channel` refusal remains the authority,
and drag-and-drop continues to expose only writable destinations.

### 2026-09-21 — Only the Spaces rail auto-collapses during navigation

**What changed:** In both desktop and browser navigation, selecting a Space or
opening or re-entering a Channel now compacts the Spaces rail without changing
the Channels rail's expanded/collapsed preference. Selecting Main, a Breakout,
or **New breakout** likewise leaves the Breakouts rail at the width the person
chose. Explicit collapse controls, edge gestures, and responsive narrow-window
compaction remain unchanged on every rail.

**Why:** Automatic compaction at every selection made the two contextual rails
disappear while the person was actively navigating their contents. The Spaces
rail is the hierarchy level navigation moves away from, so it alone recovers
conversation width automatically; the Channels and Breakouts rails stay under
direct user control.

### 2026-09-20 — Archive is available from a live Space row

**What changed:** An editable, non-General Space row opens a context menu whose
single danger action is **Archive space**. The confirmation keeps its dialog
open when the write fails, maps named Space refusals through the shared copy,
and names affected Channels the authority safely returned. General, a Space
reached only through one of its Channels, and rows still sourced only from the
local directory cache expose no menu. A compatible sidebar payload that omits
its optional Space snapshot does not mark those cached rows live; a disconnect
or a newly opened transport revokes the prior connection's authority until its
own snapshot arrives. If that happens with confirmation open, the dialog stays
open, disables its write, and names the reconnect needed rather than ignoring
the click. The same reconciliation disables the dialog if that Space leaves the
active directory or becomes reachable only through a Channel while it is open.

**Why:** Archiving was available only after opening the Space dashboard, even
though the sidebar row is the natural place to act on the container. A direct
menu mutation with a disappearing error was rejected because a failed request
would look like a click that did nothing; offering an action before live
authority or on a protected/read-only row was rejected because Rally controls
are not suggestions.

**Consequences:** A successful response moves the Space from the active cache
to the archived cache without duplicating or reordering a socket publication,
and leaves the Space route when that was the page open. A response older than a
socket-delivered
restore, later archive, or authoritative removal from both directories is
discarded rather than reintroducing stale access or moving newer state across
directories. Route fallback reads a layout-synchronized pathname when the
archive answers, so a late response neither replaces navigation made while it
was pending nor strands the reader on a Space they opened meanwhile. A response
that returns after its Organization shell unmounts is ignored before touching
shared caches or navigation; layout cleanup revokes that shell token in the
same commit rather than waiting for passive effects. Transport and unexpected
failures use stable action-specific copy rather than raw server text.

### 2026-09-20 — A Channel placement can be removed where it is shown

**What changed:** A Channel row rendered under a Space now offers **Remove from
space** in its context menu, immediately above **Archive channel**. The action
removes that specific placement through the existing Space membership mutation.
If it is the Channel's final placement, the server's `space_membership_final`
refusal is shown in a modal as **A channel must be in at least one space.** The
action is withheld for system Channels and for placements in a Space reached
only through that Channel, where the viewer cannot edit the membership.

**Why:** The membership authority already allowed a Channel to leave one of
several Spaces, but the sidebar exposed that operation only through **Manage
access**. A placement is the clearest place to name which Space is being left;
deriving one from the Channel's membership list was rejected because the same
Channel can be rendered under several Spaces at once. The authority remains the
source of truth for the final-Space invariant rather than duplicating that
decision in the client.

### 2026-09-20 — Consolidate creation in the sidebar launcher

**What changed:** The desktop removed the plus from the Spaces heading and from
every Space row. The main sidebar plus now starts a Channel, imports one, or
creates a Space; Channel flows require an explicit destination Space, and a new
Space uses the existing personal, blue-briefcase defaults. The launcher waits
for Space bootstrap, is unavailable in a guest shell with no Space capability,
and omits Spaces reached only through a shared Channel because those projections
are readable but not editable.

**Why:** Three placements of the same creation capability made the hierarchy
itself look editable in place and split closely related actions across different
menus. One launcher is the reversible UI primitive; Space membership and
creation remain on their existing authoritative service paths.

**Considered and rejected:** Retaining optional Space-row and section-heading
actions for a future host. No host uses them after consolidation, so preserving
them would keep dead component API and layout rather than a reusable primitive.

**Consequences:** Creation requires the Space directory to be ready and uses
the global launcher in every sidebar layout. Space rows no longer carry or
reserve room for creation; any future row-local action is a new product choice.

Shipped in #876.

### 2026-09-20 — The Space landing page is about Channels

**What changed:** The desktop Space landing page no longer renders Resources or
Sidekicks sections, their add/remove controls, or their pickers. The Channels
section also no longer offers **Add channel** or the adjacent new-Channel plus
control, and Channel rows no longer offer **Remove**. The unused shared list
components and desktop default API wrappers left behind by those controls were
removed too. The underlying default inheritance and Channel-placement authority
remain unchanged.

**Why:** The landing page should orient a person around the Channels in a Space.
Default and Channel-placement controls made it a management surface as well,
adding dependencies to every open without helping that primary job. Existing
configured defaults continue to apply even though no desktop surface currently
inspects or changes them; retiring that durable behavior was rejected as a
separate product decision. Future management surfaces can reuse the authority,
but they must be introduced where that job belongs rather than silently
restoring these controls.
### 2026-09-20 — Spaces, Channels, and Breakouts become adjacent navigation levels

**What changed:** The desktop no longer expands Channels inside Space accordion
rows. It draws a dedicated Space sidebar, an adjacent Channel sidebar filtered
by the selected Space, and the existing Channel context sidebar for Main and
Breakouts. Selecting a row compacts the level it came from; every compact level
keeps the same 96px square-mark geometry and can be reopened manually. Space
rows use the Channel hover-card language with scope and Channel count, each
Breakout row shows its stored icon and colour or derives a stable fallback from
its identity, and **New breakout** uses the blue enter mark instead of a generic
plus. The original left sidebar keeps
the original Organization-level Search and New Channel controls and their
compact motion, standalone Sidekick shortcuts, and the user footer. The newly
inserted Channel sidebar contains only the selected Space's Channels and uses
that Space's name as its sole heading; the Breakout sidebar names the active
Channel in its header. Those two headers share the left rail's top-action
centerline while expanded, and both leave the same 8px interval before their
first row. In compact mode each becomes its Space or Channel mark above a
divider, so the level remains identifiable before its rows begin. The left
rail retains the original Create handoff: its expanded titlebar control exits
through the right edge as the compact command-row control enters from the
left, and expansion reverses both paths.
The Space width is a registered shell property, so both dependent rails move
with its collapse instead of jumping to their final offsets. A Space selection
has one navigation owner (its link), and leaving then re-entering the same
Channel rearms automatic compaction. The selected-Space list keeps requesting
directory pages until it has the Space's Channels or reaches the end, including
when the first page is too short to scroll. Space ordering exposes its
Alt+Arrow instruction to assistive technology, while a Space reached only
through one of its Channels refuses Channel drops before any mutation is sent.
The shell owns the Space rail's collapsed state so its narrow-window threshold
reserves the rail actually on screen, and a stale archived-Space URL falls back
to a valid sidebar selection without competing route and directory effects.
Channel reorder state, failures, placement menus, and keyboard instructions stay
scoped to the selected Space; the Space rail keeps loading placeholders until
the first directory arrives, and placement drops remain copies rather than
accidental pinned-list reorders.

**Why:** The accordion made containment and destination the same gesture: a
Space row both opened a Space and disclosed an indented copy of every Channel
under it. That stopped scaling visually as the product gained the third
Channel-to-Breakout level. Adjacent rails make each relationship one reusable
navigation primitive, preserve the authoritative Space placements, and recover
conversation width automatically as a person moves deeper.

**Consequences:** A Channel in several Spaces is still one authoritative row,
but it appears in the Channel rail for whichever Space is selected instead of
being duplicated under simultaneously open accordions. Future hierarchy levels
must preserve this selection-and-compaction rule rather than nesting another
disclosure list inside an existing row. The lite guest browser reuses the
adjacent hierarchy with a smaller, cookie-scoped projection containing only
the Space marks and Channels its direct conversation grants make visible.

### 2026-09-19 — A Space's mark reaches whoever can see a Channel in it, and nothing else does

**What changed:** `WorkspaceSpaceStorage`'s visibility predicate gained a third
clause — an active membership whose Channel this viewer can see, through the
Channel directory's own `channelVisibleToViewerSql` text — and `SpaceSummary`
gained one field, `reach`, naming which of the three ways admitted this viewer:
`participant`, `organization`, or `through_channel`. A `through_channel`
summary carries the id, name, icon, colour, scope, status, system role and
revision, an empty participant list, no defaults, and a `channelCount` taken
over the Channels *that viewer* can see. `reach()` is the one predicate every
Space authorization decision is now derived from, and `canEdit` — `reach` that
is not `through_channel` — is what every write predicate asks. The refusal is
named twice: `WorkspaceDO.spaceRefusalCode` takes the Space a write is about,
and `SpaceService.editable` guards the four operations that write on the
Space's own object before WorkspaceDO sees them. The desktop draws such a Space
as an ordinary sidebar row with no **+**, no drop, and no **Add to space**
entry; its dashboard as header-and-list; and **Manage access** names it instead
of saying "a space you can't see", without the participant count every other
row on that screen keeps. The local cache's `directory` slice went to
version 4.

**Why:** Every Channel belongs to at least one Space, and the sidebar's whole
job is to say where each one lives — but a Channel placed only in somebody
else's participants-only Space had nowhere to be drawn, because its Space was
invisible to every other reader of that Channel. **Other channels** existed for
exactly that case, which meant the product's answer to "where does this live?"
was a flat list that declined to say. The disclosure the third clause makes is
the Space's *mark*: you already know the Channel exists, and being told the
name of the folder it is in is what turns a homeless row into a placed one.

The count is where the line actually is. `spaceIdsByChannel` has always shaped
a Channel's `spaceIds` per viewer for one reason: a personal Space's id, *and
through `channelCount` its size*, riding a Channel row to everybody who can
read it. The id now rides it on purpose. Narrowing the count to the viewer is
what keeps the second half from riding with it — and it makes the two agree by
construction, because the narrowed count is exactly the set the third clause
tests for existence, so such a viewer's count is never zero.

`reach` is a field rather than something each surface re-derives because the
inputs are withheld. A surface computing "am I a participant?" from `scope` and
`participants` gets the wrong answer the moment `participants` is empty, and
for this viewer it always is.

**Considered and rejected:** *A separate metadata endpoint* — `GET
/spaces/:id/card`, or a `spaceCards` field beside the directory, answering just
the mark for Spaces the viewer cannot otherwise see. It is a second read path
for a question the socket already answers, which is the thing
[Reads](#reads) exists to refuse: the two would disagree across a mutation,
and the client would have to merge two lists into one sidebar section and
decide which one a row came from. *A second summary schema* — `SpacePlacement`,
or `SpaceSummary` with half its fields optional. Optional fields are worse than
empty ones here: `participants: []` and `defaultResourceIds: []` are states
those fields already have and every existing reader already handles, while an
absent field is a new branch at every call site and a strict client that
predates it rejects the row outright. One shape with one field naming the
reach is the smaller change and the one a future relationship extends.

*Admitting a `removing` membership, so an archived Space stays reachable.* An
archive stages every membership out of `active` before it commits, so today a
`through_channel` reach implies an active Space. Widening to `removing` would
put an archived Space in that viewer's inactive list with no Channel drawn
under it anywhere, and a single-Channel removal in flight would keep a Space
visible while the Channel leaves it. The inactive list renders the same
visibility text anyway, so a future change to what an archive stages carries
without being re-derived.

*Refusing the ordering write too.* It was in the audit with every other write,
and it is not one of them: an arrangement is one person's view preference,
stored under their own user id and read by no other socket. Refusing it would
mean a row they can see and cannot move.

**Consequences:** **Other channels** is now two transient states — an
Organization still opening, and a Channel whose every Space is archived —
rather than the standing case it was written for. A Space name is now something
its participants choose that every reader of its member Channels will see;
that is the product decision the PRD's decision log records, and a future
change that wants to hide a Space's name has nothing left to hide it behind.
`SpaceRow`'s plus is optional, which is the first capability
[`shared-ui.md`](shared-ui.md) lets a host withhold on that component. The
`directory` local-cache slice is at version 4 because `reach` is a per-viewer
fact a device cannot derive, so every device pays one cold launch;
[`local-cache.md`](local-cache.md) holds that reasoning. And the guard that
names a refusal now lives at two depths: a future Space write that reaches the
Space's own object before WorkspaceDO has to go through `SpaceService.editable`
or it will be answered `workstream_not_found` by the wrong authority.

**Found in review, in the half of the audit this change nearly missed.** Every
*write* gate that `canRead` used to serve was re-narrowed; what was left were
the server-side consumers of the widened *read*, which went on treating a
now-viewer-scoped answer as the Organization's fact. `SpaceService.resumeIntent`
was the one that mattered: it reads the Space as the person who staged the
intent, and a requester taken out of the Space in the meantime now reads
`through_channel` — so the audience and restore walks re-applied an empty
roster, withdrew every reader the Space supplied from every member Channel, and
settled the intent as a success. It is now refused by name,
`requester_reach_lost`, terminal the way `requester_inactive` is, with the
roster read fenced a second time where it is used so the next consumer fails
loudly instead. The change that widened the read is what created this: before
it, that same read refused the requester and the resume failed where somebody
would see it.

`WorkspaceSpaceStorage.members()` was the same omission one layer down: still
gated on "may I see this Space", and with no viewer predicate in its query, so
it would hand a `through_channel` viewer the complete membership of a
participants-only Space. It is what made the resume defect reachable, and no
route reaches it today — but `memberPage` is a public service method and the
first surface that counts "the Channels in this Space" would be the one to find
out. It is `canEdit` now, it answers that refusal apart from "no such Space" so
`listSpaceMembers` can name it, and it says why there is no viewer-scoped
variant to narrow to instead: every caller is a walk that has to reach the
whole Space or it converges on nothing.

`WorkspaceSpaceStorage.space` — the read that renders one Space row for the
person who just changed it — was the one renderer of `spaceReachSql` without
`spaceVisibleToViewerSql` beside it, against that helper's own stated
precondition: its `ELSE 'through_channel'` is the label for a row that reached
it *having passed the filter*, so a row selected without the filter is labelled
`through_channel` whether it is reachable at all or not. The route into it was
an actor narrowing a Space to `personal` without listing themselves, who was
answered a summary claiming a reach they did not have, with an empty roster and
a viewer-scoped count that could be zero — which the contract says such a
viewer's count never is. Both halves are closed: that narrowing is refused by
name, and the read renders the predicate, so `readable` is one gate rather than
two and every mutation that cannot see its own answer passes on "no such Space"
rather than a row it cannot account for. Driving the refusal in a real window
found the third half: **Space participants** closed on it, and the sentence
that names it is drawn inside that dialog, so a person saw nothing happen at
all. It closes on success only now. The three other dialogs on that screen
close the same way for the same reason and are left as they are — none of them
is where this change's refusal lands, and each is its own decision about what a
half-applied multi-item add should leave on screen.

**Manage access** was the same disclosure through the client. Its Space row
carries a count of the readers that source seated on the Channel — the
Channel's own record, and argued for above — but this change gave the row the
Space's *name*, and for a personal Space the count is the size of its
participant list. "A space you can't see — the 1 person in this space" attaches
a number to nothing; "Side work — the 1 person in this space" is the
participant count the PRD entry shipping in this change says such a viewer is
never told. The number is now drawn only for a Space the viewer is in or one
the whole Organization is in.

A Space reached that way also appeared and disappeared only on reconnect. The
first two clauses move only when the Space does, and every Space write
republishes; the third moves when a *Channel's* viewer row does, and nothing
republished on that. `applyWorkstreamDirectoryEffects` now sends the per-user
snapshot to exactly the people whose participation changed in the batch, never
on an unread or a mention, and only when one of those Channels is in a Space —
the same membership test the archival republication already uses.

The dashboard nudge was the third. Its `spaceIds` arm addresses everybody who
can *see* a Space, which the third clause widened — so every Channel placed
into or taken out of a participants-only Space told the people who reach it
through one other Channel that something had moved in it, one event at a time.
The narrowed `channelCount` refuses that disclosure as a number and the nudge
was making it again over time. A membership settling now addresses the viewers
of the Channel that moved; an archive and a restore still address everybody,
because the Space's own disappearance is visible to them anyway.

The remaining review items are the small ones: the **Restore archived space**
modal lists only the Spaces this person could actually restore, so a change to
what an archive stages cannot put a control there that can only fail; two
comments said something no longer true (`canEdit` does not read `archived_at`,
and the sidebar's `channelCount` is viewer-scoped for one of the three
reaches); the walk's `active | reaching` is `MemberWalkReach` now, because it
sat three lines from the viewer's own reach and a reader auditing the gate
between them would conclude the page was already viewer-scoped; the refusal
enumeration covers the two settlement RPCs it claimed to; and
`space_access_denied`'s sentence is true of a read now, which is what a guest
and a removed member get from the same gate.

**Deploy the API before the desktop.** `reach` is the first *required* field
added to the Space snapshot's shape, and `safeParseSocketEvent` tolerates
fields a newer sender added but not ones a newer receiver requires — so a
desktop that auto-updates ahead of its API rejects every
`workspace_space_snapshot` and shows no Spaces at all. The silent drop is
pre-existing and is now named: a message whose `type` a schema in the handler
claims and whose body it then rejects is logged with the field
`describeZodIssues` puts on it, rather than falling off the end of the chain.
A message of a type nothing there knows stays silent, which is the ordinary
forward-compatible case.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.

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
It replaced `workspace_space_order` in migration 63 in place; 63 is unreleased,
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

Removing the time-grouped list took the sidebar's only page trigger with it: the
nav's scroll reached the bottom of a list of every Channel, and a member's nav
is now short. An expanded Space that lists fewer placements than its
`channelCount` asks the existing loader for the next page instead, until the
pages run out — the count is the Organization's rather than the viewer's, so it
is the pages running out that has to stop it and not the count being reached.

A write merges rather than replaces, for every kind. The `organization` list
always did; the other two did not, and the justification — "an item nobody
mentioned belongs at its natural position" — was about a caller that does not
exist. The only client sends the ids it is *drawing*, so every id it cannot
draw was silently deleted by the next drag: an archived Channel lost the place
it was being kept in, and a person arranging 60 Channels on one machine lost
them all by nudging one row on another that had loaded fewer pages. What a
future change has to respect is that the request says where the named ids go
and nothing at all about the rest.

A stored list has no length bound, and neither has the number of containers one
person may accumulate. Capping a list would silently lose the tail of one
somebody actually arranged, which is worse than the row it prevents; both
numbers, and what deciding them needs, are in "Numbers handed to the team"
above. What is bounded is the part that can be: a `space` row goes when the
placement does, and a cancelled reservation takes its container with it. Archive
takes nothing on purpose — the row is already invisible through `directory()`,
and a restore is supposed to bring the arrangement back rather than a recency
list. A `channel` container has nothing to prune it, because nothing in the
product deletes a Channel; if something ever does, that is the path this delete
belongs on.

The Space dashboard's paginated Channel list keeps its server order. Arranging a
list whose later pages have not arrived is a different feature: the client can
only order the page in front of it, and the stored ids would name Channels no
page had fetched.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.

### 2026-09-19 — The Space dashboard lists what needs you, breakouts included

**What changed:** The dashboard's Channels section is now every conversation in
the Space that currently needs the viewer — member Channels and those Channels'
breakouts in one list, ordered by most recent activity, with everything stale
for that reader left out. "Stale" is the conversation's current state for that
person, not its age: live is `scheduled`, `running` or `needs_input`, or
unread, or unseen, or mentioned, which is exactly the set of markers ranked
above `completed` in `MARKER_PRECEDENCE`. The predicate is
`conversationNeedsViewer` in `@rally/contracts`, mirrored by the page query's
SQL. Migration 63 adds `workspace_breakout_directory` and
`workspace_breakout_viewers`, which a Channel now fills by forwarding its
breakouts' own directory projections over the outbox path it already had, with
the substream id on the envelope. `GET /spaces/:id/channels` keeps its name and
answers `SpaceConversation` rows carrying `kind` and, for a breakout, its
parent Channel, its substream id and the parent's title. The page is refetched
on a `space_conversations_changed` nudge naming its Space and on socket
reconnect, and nothing durable is written for that signal.

**Why:** The section listed every Channel in the Space in id order, which is
the least useful ordering a list of conversations can have and is not what
anybody opens a Space to find out. The question a Space dashboard answers is
"what in here wants me", and the Organization already held every fact needed to
answer it for Channels — it just had none of them for breakouts, because a
breakout's projection reached its Channel's `substream_directory` and stopped.
A breakout is where most of the work that needs an answer actually happens, so
a list that could not show one was answering the question with half the data.
Hiding stale rows rather than ranking them down is the same decision the
sidebar already makes by hiding `completed`: a list you have to read to find
the three rows that matter is a list you stop reading.

**Considered and rejected:** *Age-based staleness* — hide anything older than
some window. It needs a number nobody here can derive, and it is wrong in both
directions: a run that has been waiting three weeks for an answer still wants
it, and a conversation that was busy a minute ago and has been read wants
nothing. State is the honest input and needs no number. *A client-side filter
over an id-ordered page* — keep the existing query and drop the stale rows
where the list is drawn. That makes every page arbitrarily short, makes the
cursor a promise about rows the client has already thrown away, and makes the
**Load more** control unable to say whether there is more. The filter has to be
where the page is decided. *Widening `workspace_workstream_directory` with a
`substream_id` column* — one directory table for both kinds. Every sidebar
page, pin, watch registration, retirement enumeration and cutover query in
WorkspaceDO reads that table as "one row per Channel"; each would have had to
learn a filter, and the first one that forgot would list a breakout as a
Channel in somebody's sidebar. Two tables means only the query that
deliberately lists both has to know both exist. *Pushing the page over the
socket* — it would put one member Channel's traffic on every reader of every
Space holding it, and would put breakouts on a socket nothing else draws them
on. *A second refresh mechanism for breakouts* — one nudge covers both kinds
and subsumes `channelCount`, so there is one trigger rather than three. *A
durable per-viewer counter on the Space summary* — this is what shipped first
and was withdrawn in review. It wrote a row on every message in every member
Channel (for General, every message in the Organization), it needed the Space
snapshot to reach a client, which rebuilds both Space directories per socket,
and the client dropped that snapshot as a replay whenever the directory
waterline had not moved — which is every case the counter existed for. A nudge
with nothing behind it is cheaper to send, cheaper to reverse, and the failure
it can have is one stale view rather than a number two authorities disagree
about.

**Consequences:** The page's SQL is the authority for what is listed and
`conversationNeedsViewer` is a copy of it; the combination walk in
`space-conversation-page.test.ts` is the only thing keeping them equal, and a
change to either without the other is a defect that test is there to catch.
Every message in a member Channel or breakout now costs one small socket
message per reader who can see it, and one page read from each reader who has
that Space's dashboard open — three page reads if they have scrolled three
pages, because invalidating an infinite query refetches all of them. That is
the cost the activity-ordered list buys, and it is bounded by who can see the
conversation rather than by who is in the Space. A dashboard is only ever
*told* to re-read itself, so any future change that needs a client to detect a
gap has to add a version to compare, not a second nudge. A test fixture that publishes an idle, fully-read Channel and expects
it on the page will now fail, correctly: `space-authority.test.ts` publishes
`needs_input` for exactly that reason. A future conversation kind — a Sidekick
run, say — joins the list by adding an arm to `conversationPage` and a branch
to the mapper, not by widening either directory table.

### 2026-09-19 — Every Channel gets a home: the Organization owns the hierarchy, the desktop draws it, and Projects are deleted

**What changed:** Migration 63 adds the Space directory and viewer projections,
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
WorkspaceDO migration 64 deletes the eight Project tables after settling every
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
Narrowing a SQLite CHECK after migration 63 ships needs the table rebuild the
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
