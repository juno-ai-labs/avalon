# Spaces and the Organization hierarchy

> Created 2026-09-18.
>
> Replace Projects with Spaces, organize every non-deleted Channel under at least
> one Space, and rename Rally's product hierarchy to Organizations, Spaces,
> Channels, and Breakouts. Companions: [state](state.md) and [plan](plan.md).
> Supersedes the
> [Projects PRD](../2026-08-26_projects/prd.md). Related subsystem references:
> [Projects](../../projects.md), [authorization](../../authorization.md),
> [scope-grant directory](../../scope-grant-directory.md),
> [shared UI](../../shared-ui.md), [data model](../../data-model.md), and
> [work-stream creation](../../workstream-creation.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally's visible hierarchy becomes **Organization → Space → Channel → Breakout**.
Spaces replace Projects. They group Channels, carry a shared audience, resources,
and Sidekicks, and appear as the primary organization of work in the sidebar.
A Channel may belong to several Spaces at once and must always belong to at
least one active Space. Breakouts remain private or shared conversations inside
a Channel.

A Space reuses Rally's work-stream primitive rather than becoming a separate
container implementation. It has the same durable presentation, participant,
resource, Sidekick, and child-conversation capabilities, but Rally never exposes
its message feed. Every Organization has an Organization-wide, unarchivable
General Space that receives a Channel when no other Space was selected.

This is a direct replacement, not a compatibility layer. Existing Projects are
deleted rather than converted. Every existing non-deleted work stream, active
or archived, becomes a Channel in General. A formerly personal Channel becomes
visible to the Organization only after the migration proves that its retained
content may safely acquire that audience; an immutable narrower-content fence
blocks the Organization cutover rather than being bypassed or deleted.

## Motivation

Projects introduced a second container abstraction beside work streams even
though the product needs the same reusable capabilities at both levels:
participants, resources, Sidekicks, presentation, lifecycle, and durable
delivery. Extending Projects separately would duplicate those capabilities and
leave each improvement to the work-stream primitive needing a Project-specific
equivalent.

The product direction agreed on 2026-09-17 and 2026-09-18 is that the hierarchy
itself should be legible: an Organization contains Spaces, a Space contains
Channels, and a Channel contains Breakouts. A Channel may participate in several
Spaces because one conversation can contribute to several efforts. The current
Project product deliberately exposes one active assignment even though its
storage anticipated plurality, so it cannot express that relationship.

The same direction requires every Channel to have a home. Today a work stream
can exist only in the flat workspace directory, and a Project is optional. That
makes grouping a secondary annotation rather than the primary product
structure. General supplies a deterministic home without asking every creator,
connector, import, or recovery path to invent one.

There is no usage history or support-ticket count to quantify this pressure.
The evidence is the direct product decision and the architectural duplication
visible in the shipped Project and work-stream models. The change is being made
before more Project-only behavior makes the two abstractions harder to unify.

## Goals

1. Present Rally's hierarchy consistently as Organizations, Spaces, Channels,
   and Breakouts on every user-visible surface.
2. Replace Projects with Spaces backed by the existing work-stream primitive,
   without exposing a Space message feed.
3. Allow one Channel to appear in several Spaces simultaneously and navigate
   every occurrence to the same Channel.
4. Guarantee that every non-deleted Channel, including an archived Channel,
   belongs to at least one active Space across interactive creation, connectors,
   imports, demos, recovery, scheduled automation and Sidekick runs, and
   migration.
5. Give each Space a name, icon, color, personal or Organization-wide audience,
   participant set, resource set, and Sidekick recommendation set.
6. Apply a Space's audience, resources, and Sidekicks to Channels already in it
   and to Channels added later, without duplicate attachments or grants.
7. Compose access from direct Channel grants and every Space membership without
   one Space revoking access still supplied by another source.
8. Create one General Space for every Organization and use it as the fallback
   home when Channel creation does not name another Space.
9. Remove the Project abstraction, its data, and its product protocol in one
   coordinated cutover.
10. Preserve existing internal workspace, workstream, and substream identifiers
    and storage vocabulary where changing them would add migration risk without
    changing the product.

## Non-goals

1. **Nested Spaces are rejected.** Spaces contain Channels; they do not contain
   other Spaces. The many-to-many relationship is between Spaces and Channels,
   not a general container graph.
2. **A Space feed is not a product surface.** The backing primitive may retain
   inherited conversations internally, but Rally does not provide Space chat,
   transcript, search results, activity, notifications, or feed navigation.
3. **Guest access to Spaces is deferred.** Guests continue receiving explicit
   Channel or Breakout grants. Space discovery and management require an active
   Organization membership.
4. **Removing applied resources and Sidekicks is rejected.** Removing a Channel
   from a Space, removing a Space resource or Sidekick, or archiving a Space does
   not detach resources or Sidekicks already applied to the Channel. Access is
   different: it is the live union of current direct and Space-derived sources,
   so a source that no longer exists stops granting access. This preserves
   transcript and execution context without turning participant removal or an
   audience narrowing into a no-op.
5. **Converting Projects is rejected.** Existing Project names, memberships,
   audiences, order, and defaults are not mapped into new Spaces. General is the
   only migration destination.
6. **A Project compatibility protocol is rejected.** Old Project routes,
   socket events, contracts, and clients are not maintained beside Spaces.
7. **Renaming internal tenancy and conversation infrastructure is out of
   scope.** Database columns, Durable Object names, scope values, telemetry,
   and established deep links may continue using workspace, workstream, and
   substream where compatibility requires it.
8. **Space-specific instructions, prompt context, or memory are excluded.** A
   Space supplies audience and durable attachments; it does not silently add
   prompt text or a new memory scope to its Channels.
9. **New Space roles are deferred.** Space mutation follows the current Project
   model and existing Organization owner/admin/member roles.
10. **The lite browser does not gain Organization navigation.** Its v1 surface
    remains the explicitly shared Channels and Breakouts a guest may access.

## Product behavior

### Product language

Every visible surface uses the following hierarchy:

- **Organization** replaces Workspace.
- **Space** replaces Project.
- **Channel** replaces work stream.
- **Breakout** replaces substream.

This includes navigation, setup, settings, invitations, audience descriptions,
empty and error states, tooltips, accessible names, and documentation intended
for users. For example, the public scope action reads **Make public to
organization**, and a child-conversation action reads **New breakout**.

The old **Make private** action becomes **Manage access**. It shows the Channel's
direct and Space-derived sources. A direct Organization-wide source may be
removed only when the resulting audience is still represented by at least one
active Space; an Organization-wide Space source is removed by changing that
Space or leaving it, not by a Channel-local control. The UI never claims a
Channel is private while an active Organization-wide Space still grants access.

### Space navigation

Spaces occupy the sidebar position currently used by Projects. Each active
Space has an expandable row with its icon, color, name, and new-Channel action.
Expanding it shows the Channels the viewer may read in that Space. Opening the
Space selects its dashboard and expands its row.

A Channel belonging to several Spaces appears under every one of them. Those
rows are placements of one Channel, not copies: they share identity, unread and
running state, transcript, participants, resources, and destination URL.
Opening any placement opens that canonical Channel.

Space order remains a per-person server-owned preference. Channel order inside
a Space follows the existing viewer-specific Channel ordering. Pins remain an
independent personal list; Space membership neither pins nor unpins a Channel.

Archived Spaces are absent from the active sidebar, membership pickers, and new
Channel destinations. An archived Channel remains a member but is omitted from
active lists under the same rules used by the Channel directory.

### Creating and editing a Space

**New Space** asks for a name, icon, color, and audience. It starts personal,
with its creator as a participant, and reuses the existing Project appearance
catalog and immediate server-synced editing behavior.

The Space dashboard contains:

- editable name, icon, and color;
- personal or Organization-wide audience and participant management;
- active Channels with controls to create, add, or remove a Channel;
- resources inherited by current and future member Channels;
- Sidekick recommendations inherited by current and future member Channels;
- an archive control when lifecycle rules permit it.

It contains no composer, transcript, feed socket, Main link, or Breakout list.
Inherited backing conversations are not discoverable through the product.

Any active Organization member who can read a Space may edit it, matching the
current Project rule. Removing another participant requires an Organization
owner or administrator. Every such gate treats `owner` and `admin` as
administrators; the desktop role only decides which controls are drawn, while
the server reauthorizes every mutation. This deliberately allows every active
member to rename General; its protected lifecycle and audience remain immutable.

### Channel membership

Creating a Channel from a Space assigns it to that Space. Creating a Channel
from a top-level composer, connector, import, demo, recovery, or scheduled
automation or Sidekick path assigns it to General when no Space was supplied. A
creation that explicitly names one or more Spaces either establishes at least
one valid active membership or fails without publishing a visible Channel.

**Add to Space** offers every active Space the caller may edit that does not
already hold the Channel. Reading either object is insufficient: the server
requires authority to edit the Space and the same Channel-side authority that a
direct audience change requires. Adding does not remove another membership.
Dragging a Channel onto a Space performs the same authorized operation.
Membership controls show all current Spaces rather than one selected assignment.

Removing a Channel from a Space succeeds only when another active Space already
holds it and, after withdrawing the departing Space's access source, every
remaining effective Channel reader can discover at least one of the remaining
Spaces. Rally rejects removal from the final active Space or an audience-
incompatible placement and identifies what must change first. Archiving a Space
applies the same test to every member Channel. Archived Channels retain their
memberships and participate in this invariant, so restoring a Channel cannot
produce an orphan.

Membership removal stops future inheritance from that Space and removes its live
access source. Direct access and access from other active Spaces remain.
Resources and Sidekicks already applied remain on the Channel. Subsequent
changes to the removed Space do not update that Channel.

### Audience, resources, and Sidekicks

Adding a Channel to a personal Space grants every active Space participant
access to the Channel. Adding it to an Organization-wide Space makes the
Channel Organization-wide. Direct Channel access and access supplied by other
Spaces remain independent.

Changing an active Space audience updates the live Space-derived access source
on every current member Channel. Narrowing a Space, removing a participant,
removing a Channel, or archiving a Space retracts only the source that event no
longer supplies; it does not revoke access still provided directly or by another
active Space. The existing WorkstreamDO scope-grant authority, relationship
incarnation, participant projection, and canonical authorization checks remain
the final access decision.

Every audience expansion first runs the existing retained-content containment
preflight at the Channel authority. This includes adding a Channel to a broader
Space, widening a Space, and the General cutover. A Channel with immutable
content-audience fences that exclude any proposed reader is rejected without
changing membership or access. Cutover never deletes or bypasses those fences;
the fleet preflight must identify and safely remediate every blocker before the
unflagged release may proceed.

Adding a resource or Sidekick to a Space applies it to every current Channel
and records it for later members. Duplicate delivery is harmless. Removing it
from the Space stops future application and invalidates undelivered stale work,
but does not remove it from a Channel that already received it.

Resource and Sidekick propagation also preserves audience containment. Adding a
default, adding a Channel, widening a Space, or widening a member Channel
rechecks that every effective Channel reader may use the attachment or Sidekick
through its canonical authority. The mutation fails before publication when the
full audience is not contained; a stale queued delivery rechecks the same facts
and settles as stale rather than attaching inaccessible state.

### General

Every Organization has exactly one Space with the stable system role
`general`. General starts with the display name **General**, is
Organization-wide, and cannot be archived or made personal. Its name may be
edited without changing its fallback identity.

General is a fallback rather than a universal membership. Existing Channels
enter General during cutover. Later Channels created inside another Space do
not also enter General; Channels created without a selected Space do.

### Loading, errors, offline state, and migration

While the Space directory is loading, Rally shows Space skeleton rows and does
not replace a remembered directory with an empty one. An Organization with no
user-created Spaces still shows General. A failed refresh retains previously
known rows, marks them out of date, and offers **Try again**.

Membership and Space-default mutations stay pending until the server returns
their committed result. Optimistic presentation may show the requested state,
but a failed write restores the server-owned membership or order and explains
the failure. Offline clients may read retained Space and Channel placement but
cannot claim that a mutation succeeded.

During the one-time cutover, Rally shows an Organization-opening state until
General exists and every active or archived Channel has an active membership. It never
shows a partially migrated hierarchy or a Channel without a Space. Retrying an
interrupted migration resumes from durable receipts rather than creating
another General Space or duplicating membership effects.

### Existing Organizations

For every existing Organization, cutover creates General, places every active
and archived Channel in it, and makes every formerly personal Channel
Organization-wide. This is an intentional disclosure event, not an incidental
side effect of placement: the alternative of preserving the old personal
audience under an Organization-wide General was rejected because a Space whose
audience did not apply to its Channels would not provide a coherent shared
working context. Fleet-wide retained-content preflight is therefore a release
gate, and any unsafe Channel blocks that Organization without partial mutation.

Existing Project authority and configuration—its rows, ordering, memberships,
participants, and defaults—are deleted after the shutdown barrier. Audience and
resource effects already committed to Channel-owned authorities survive; the
cutover does not cascade-delete established Channel state. There is no
conversion preview or restoration path through the product.

## Impact on the product contract

This changes the standing implementation brief. Rally is no longer described
as organized around work streams “rather than channels.” Its visible product
hierarchy becomes Organizations, Spaces, Channels, and Breakouts, while a
Channel remains the durable multiplayer home in which Rally participates and
acts.

The contract must also state that every non-deleted Channel has at least one Space,
that one Channel may appear in several Spaces, and that Spaces are organizational
and inheritance surfaces rather than conversations. The existing principles
remain: Rally is inherent in every Channel, viewing does not itself create
participation, tools remain typed and authorized, and Rally gains no global
inbox or global activity feed.

The implementation brief's Organization/You subscription badge and every other
Workspace-facing label move to the new product language in the same cutover.

## Decision log

### 2026-09-19 — A Channel created without a named Space is born Organization-wide

**Decided:** Empty `spaceIds` means General, General is Organization-wide, and
a Space source only ever widens — so the Channel opens `workspace` whatever
scope the caller asked for. This is the behavior, not a defect to correct: the
top-level composer, a connector ingress that resolved a personal scope, session
import, `createFromOpportunity` with a personal audience, and the demo seeder
all create Organization-wide Channels unless they name a Space. A Channel that
is meant to stay personal must be born in a personal Space.

**Why:** It follows from three sentences already agreed. Channel membership:
"Creating a Channel from a top-level composer, connector, import, demo,
recovery, or scheduled automation or Sidekick path assigns it to General when
no Space was supplied." General: it "is Organization-wide, and cannot be
archived or made personal." Audience: "Adding it to an Organization-wide Space
makes the Channel Organization-wide." Design decision 6 chose a protected
fallback over asking every creation surface for a bespoke Space, and the
composition rule in decision 4 is a union — a narrower direct scope cannot
subtract from a broader source. Deriving the birth audience any other way would
mean a Channel whose Space's audience does not apply to it, which the Existing
Organizations section rejects for the cutover for the same reason.

**Changes:** Nothing in the agreed goals, and no behavior change. It is
recorded because it is not obvious from any one sentence and because it has one
consequence worth naming: the demo seeder now refuses a pack room declared
`personal` by name rather than seeding it Organization-wide, since the
readiness barrier compares against the scope the pack stated.

### 2026-09-19 — Space-derived access is provenance in WorkstreamDO, applied through the Channel's canonical audience operations

**Decided:** WorkstreamDO records which Space sources currently reach a Channel
and which readers each supplied, and the one effective-audience function
derives the Channel's readers from its direct source plus those Space sources.
Every expansion or retraction is applied through the Channel's existing scope
and participant operations on its main conversation, which is where the
retained-content containment preflight and its SQL triggers already run. Grant
rows written for a Space source carry that provenance and are never published
to the shared scope-grant directory.

**Why:** Design decision 4 extends "the WorkstreamDO grant authority". On
`main` that ledger only becomes the admission authority for a Channel after its
first share; every other Channel is still admitted from the scope and
participant rows its main conversation holds. Recording Space sources only in
the grant ledger would grant nothing on most Channels. Recording provenance in
WorkstreamDO and applying it through the canonical operations reaches both
kinds of Channel with one preflight.

**Changes:** Nothing in the agreed goals. Design decision 4 is implemented as
provenance beside the grant ledger rather than inside it; the "one effective
grant" is the audience the canonical operations converge to.

### 2026-09-19 — Space wire scope keeps the `workspace` value

**Decided:** `SpaceScope` is `personal | workspace`, the vocabulary every
Channel scope, grant, and directory row already uses. The product word is
Organization on every surface.

**Why:** Composing an Organization-wide Space source with a Channel's direct
scope is a comparison between two scope values; two spellings of the same
audience would need a translation at every seam. Non-goal 7 keeps internal
tenancy vocabulary.

**Changes:** Nothing in scope.

### 2026-09-19 — WorkspaceDO's default registry is the delivery authority

**Decided:** A Space's default resources and Sidekicks are attached to the
Space's own authority (its hidden main conversation for resources, its parent
for Sidekick recommendations) and registered in WorkspaceDO with a generation.
The registry is what stages, fences, and settles delivery to member Channels;
the Space's own attachments are the inheritance record a person sees.

**Why:** Delivery needs a generation to fence stale Queue work, and the Space's
own attachment tables have no such counter. Keeping the counter beside the
membership generations, in the object that already coordinates them, avoids a
second fence that would have to be read across an RPC boundary.

**Changes:** Nothing in scope.

### 2026-09-19 — The conversation-object migration is 66 and internal names keep their words

**Decided:** The closed `space` parent kind lands as conversation-object schema
version 66, not "after 62": `main` reached 65 before implementation started.
The `--av-sys-color-project-*` design tokens, the `project` colour helpers, and
the stored `workspace` and `workstream` identifiers are kept; only visible copy
changes. New Space surfaces use `space` in their own class and file names.

**Why:** A token rename touches every glyph and avatar in the desktop client
for no visible change. Non-goal 7 and design decision 8 already keep internal
vocabulary where renaming it buys nothing.

**Changes:** Nothing in scope.

### 2026-09-19 — SpaceDO shares WorkstreamDO's migration ledger under its own component

**Decided:** `SPACE_ROLE.migration.migrations` is
`WORKSTREAM_DO_SCHEMA_MIGRATIONS` — the array `WorkstreamDO` applies — run
under component `space_do` and class name `SpaceDO`. A Space receipts every
version a Channel does, in its own `_sql_schema_migrations`. A migration that
repairs history rather than describing shape is gated on the role in the
`afterMigrations` hook; version 17, which retires grant-directory deliveries a
Space has never queued, is the one that exists.

**Why:** Design decision 1 asks that a Space reuse the work-stream primitive,
which includes its schema. Implementation first rendered that schema's current
shape into a separate one-version `space-do-schema.ts` so a new Space would not
replay three `durable_outbox` rebuilds. That bought milliseconds once per Space
and charged a standing obligation for it: every future table change had to be
written into two ledgers, with only a Node test comparing `sqlite_master`
holding them together. The components stay separate — the tracker rolls up by
component and `forceMigration` fences on class name — but the statements are
one array.

**Changes:** Nothing in the agreed goals or in the acceptance criteria.
`space-do-schema.ts` and its test are deleted; `space_do`'s head is
`workstream_do`'s head.

## Key design decisions

1. **A Space specializes the work-stream primitive.** A thin `SpaceDO` reuses
   presentation, participant, resource, Sidekick, receipt, and lifecycle
   behavior. Its inherited conversation schema and hidden Main are intentional
   costs of exact primitive reuse; a smaller sibling object was rejected because
   it would immediately fork those capabilities into a second authority.
2. **SpaceDO is configured, not behaviorally overridden.** WorkstreamDO gains
   immutable role configuration for namespace, parent kind, migration identity,
   scope-grant-directory publication, client socket admission, and product
   exposure. `SpaceDO` supplies that role in its constructor and adds no method
   overrides. The Space role rejects client socket upgrades, suppresses grant-
   directory and feed publication, and does not eagerly create a child agent for
   a product surface that cannot open; these are base-primitive role behaviors,
   not subclass exceptions.
3. **WorkspaceDO owns the relationship, not the Space or Channel.** The
   Organization object coordinates the many-to-many directory, ordering, final
   membership invariant, and General identity. Neither endpoint can answer
   whether a Channel has another Space without consulting that authority.
4. **Existing scope grants gain provenance.** Space-derived access extends the
   WorkstreamDO grant authority with internal direct/Space sources and derives
   one effective grant. A second permission store was rejected because it would
   compete with canonical grant admission and participant projection.
5. **Attachments are additive; access is live.** A Space applies useful state
   before membership becomes visible. Leaving stops later updates without
   rewriting attached resources or Sidekicks, while the source-aware grant union
   immediately stops access the departed relationship no longer supplies.
6. **General is a protected fallback.** It is not a universal membership for
   future Channels, but its identity, active lifecycle, and Organization-wide
   audience cannot be removed. Rendering zero-Space Channels under an
   exceptional **Uncategorized** section was rejected because it preserves the
   flat directory the hierarchy is replacing and makes the central home
   invariant optional. Requiring every creation surface to choose a bespoke
   Space was also rejected because connectors, scheduled runs, and recovery
   paths create Channels without an interactive choice.
7. **The cutover is intentionally destructive.** Converting Projects would
   preserve two subtly different models and require mappings for audience,
   order, defaults, and one-assignment behavior. A clean General migration is
   easier to reason about before significant usage exists.
8. **Product naming does not force internal renaming.** Stable workspace,
   workstream, and substream storage and transport names remain where they
   prevent unnecessary migrations. Space receives new public contracts because
   it is a new abstraction rather than a label over Project.
9. **Shared components own presentation.** Reusable Space rows and management
   sections belong in `@rally/ui`; desktop and browser hosts retain authority,
   data, routing, and capability decisions. The guest browser omits Spaces
   rather than inferring authorization from missing controls.

## Data model

WorkspaceDO adds authoritative Space directory projections, per-user Space
order, one General identity, many-to-many Space–Channel membership with staged
generations, default-delivery targets, and resumable bootstrap receipts. Active
membership is keyed by Space and Channel with no uniqueness rule on Channel.
Space summaries and member Channels use opaque pagination; the workspace socket
never nests General's complete membership in its opening payload.

SpaceDO uses the WorkstreamDO SQLite schema under its own migration component
and Durable Object namespace. Its ID is the Space ID and the backing parent ID;
there is no second identity mapping. The hidden main conversation remains the
participant and resource authority, while inherited parent state owns Sidekick
recommendations and presentation. Its conversation `parent_kind` is the new
closed value `space`, which requires coordinated contract, routing, stored-
constraint, and populated-upgrade coverage rather than masquerading as a
workstream.

WorkstreamDO's grant storage records internal source provenance for direct and
Space-derived grants. Existing effective grant contracts and grant-directory
effects remain stable. Organization-wide Space sources compose with the
Channel's direct scope so one source cannot narrow another. Existing grant rows
are backfilled as direct sources.

The canonical effective-audience function is the only seam allowed to derive a
Channel's readers from its direct source plus active Space sources. Source
lifecycle is explicit:

| Event | Space-derived access | Applied resources and Sidekicks |
| --- | --- | --- |
| Space audience changes | Recompute that Space source, expanding or narrowing after containment preflight. | Keep applied state; preflight broader audiences. |
| Participant leaves Space | Remove that participant's Space source from every member Channel. | Keep applied state already on each Channel. |
| Channel leaves Space | Remove that Space source from the Channel. | Keep applied state; stop future delivery. |
| Space is archived | Remove that Space source from every member Channel. | Keep applied state; invalidate undelivered work. |

Each authority commits only its own SQLite transaction. WorkspaceDO reserves a
fenced, idempotent intent keyed by operation ID, Space revision, membership
generation, and delivery generation. SpaceDO and WorkstreamDO apply their local
writes and return durable receipts across typed RPC or the existing activity
Queue. WorkspaceDO exposes membership only after all required receipts settle;
alarms and Queue redelivery reconcile an interruption. No contract claims a
transaction spans Durable Objects.

The current expected migration sequence is:

- Cloudflare Durable Object class migration `v11` adds `SpaceDO`.
- WorkstreamDO migration `18` adds source-aware effective grants and scope
  provenance.
- WorkspaceDO migration `61` adds Space projections, memberships, General, and
  bootstrap state.
- The shared conversation-parent/SubstreamAgent schema receives the migration
  after current `62` required to admit the closed `space` parent kind.

These numbers must be rechecked against `main` immediately before implementation.
No regional D1 table is introduced by this design; Organization membership and
relationship incarnations remain in their existing authority.

## Regional impact

A Space lives in the same configured region as its Organization and Channels.
Space IDs, membership, projections, grants, resources, and Sidekicks do not
cross the existing regional boundary. The Global identity service continues to
route an Organization before any SpaceDO is addressed. No global Space index,
cross-region Space, or fallback data copy is introduced.

## Security and trust model

Every Space read and mutation rechecks the caller's current Organization
relationship. Personal Spaces require active participation; Organization-wide
Spaces require `access_class = "member"`; guest relationships are excluded from
Space pickers, reads, and fan-out even when the same person has a direct Channel
grant. Guests receive no implicit Space access.

Space-derived Channel access uses the existing canonical WorkstreamDO grant
authority, membership-incarnation fencing, expected revisions, operation
receipts, participant projection, and final owner admission. WorkspaceDO's
directory and membership projections are discovery and coordination state;
they never authorize Channel content by themselves.

Adding a Channel to a Space authorizes both sides: the caller must be allowed to
edit the Space and to change the Channel's audience. Every audience expansion
is refused when a retained-content fence excludes a proposed reader. Breakouts
that inherit their Channel audience follow the resulting canonical Channel
grant; restricted Breakouts retain their own narrower authority and are never
widened by Space placement.

External awaits during membership and propagation may interleave. The source
Space revision, membership generation, and delivery generation are re-read
after each external boundary before finalization. Grant mutation and effective
union recomputation commit together inside WorkstreamDO; relationship state and
the coordinating intent commit together inside WorkspaceDO. Durable receipts
and generation fences reconcile the cross-object boundary.

Resources retain their existing canonical metadata and attachment authorization.
Space membership does not broaden connector installation or administration
rights, expose personal connector credentials, or create a tool-approval flow.
The full effective Channel audience must fit inside resource and Sidekick access
at default creation, Channel addition, audience change, and delivery.

SpaceDO accepts no product WebSocket, so it adds no socket holder to the access-
revocation walk. It does join Organization retirement: WorkspaceDO enumerates
every Space before tombstoning itself, records Space nodes in the retirement
graph, and the dispatcher retires each Space's hidden Main and children before
the Space. Retirement cannot report complete while any Space node lacks a
receipt. The class, its self-RPC surface, background refusal handling, and gate
policy are registered with the existing retirement coverage.

## Rollout

This is an unflagged coordinated cutover. Running Projects and Spaces beside
each other was rejected because the two directory and inheritance authorities
could disagree about the same Channel.

Deployment proceeds in this order:

1. Ship additive contracts, `SpaceDO`, bindings, append-only Durable Object class
   migration, new object schemas, bootstrap state, and server support before a
   client can request the new hierarchy. Register `SpaceDO` in forced-migration
   tracking, expected-version checks, self-RPC, retirement, and deployment
   bindings in the same release.
2. Freeze new Project mutations. Generation-invalidate uncommitted Project
   targets, drain pending, leased, ambiguously published, retried, and dead-
   lettered audience/default effects, and retain tombstone-aware consumers for
   the platform's complete retry window. Zero unsettled Project effects is a
   cutover gate.
3. Run a fleet-wide retained-content and resource-containment preflight. An
   Organization with an unsafe Channel remains unmodified and blocks release
   promotion until the source content or audience is explicitly remediated;
   immutable fences are never bypassed.
4. Drive every known Organization through the existing forced-migration
   coordinator and the Project-shaped alarm-claimed outbox → activity Queue →
   generation-fenced consumer. Each Organization/phase has one durable
   idempotency key and paginated work; the implementation plan must select the
   batch size rather than guessing one in this PRD. First admitted access may
   resume stalled work but is not the fleet migration driver.
5. New Organizations create General before their first usable session. Existing
   Organizations publish no Space snapshot until General, active and archived
   Channel memberships, audience changes, and delivery receipts are complete.
   Fleet completion is the migration tracker's absence of pending/failed
   Organizations plus zero unsettled or dead-lettered cutover effects.
6. Deploy the client and routing switch only after that fleet gate passes. Older
   Project clients receive an explicit update-required response rather than a
   malformed or partial Project payload.
7. Keep Project rows and settlement handlers dormant through the retry and
   rollback observation window. Then verify the shutdown barrier again, delete
   Project authority/configuration while preserving applied Channel state, and
   remove handlers in a later server cleanup. This operational drain is not a
   product compatibility protocol.
8. Treat bootstrap failures and dead-lettered propagation as release failures;
   do not fall back to a partial Project or flat-Channel experience.

Rollback is safe only before Space-derived audience changes are published. Once
a person has been granted and may have read Channel content, restoring data
cannot undo that disclosure. Project rows remain available for an operational
server rollback during the observation window, but there is no in-product
reverse conversion. Cloudflare point-in-time recovery is an object-level
disaster-recovery input, not a transactional fleet rollback across WorkspaceDO,
SpaceDO, WorkstreamDO, and regional D1. Release verification must therefore
prove the preflight and bootstrap on a representative populated Organization
before promoting the unflagged cutover.

## Acceptance

1. A new Organization opens with one Organization-wide General Space and no
   visible Channel outside a Space.
2. Creating a Channel inside a Space shows it there; top-level, connector, and
   scheduled automation or Sidekick creation without a Space shows it in General.
3. Adding one Channel to two Spaces displays two placements that open the same
   transcript and retain independent Space order.
4. Removing one of several audience-compatible memberships retracts only that
   live access source and preserves applied attachments; removing the final or
   only audience-compatible membership fails with actionable copy.
5. Archiving a Space with an active or archived sole-member Channel fails; after
   adding that Channel to an audience-compatible Space, archiving succeeds.
6. Personal and Organization-wide Space audiences compose with direct and other
   Space grants without accidental revocation.
7. Resources and Sidekicks produce one effective attachment or recommendation
   for current and future member Channels despite duplicate delivery attempts;
   removal stops future delivery without retracting completed delivery.
8. Existing Organizations migrate idempotently to General, make eligible
   formerly personal Channels Organization-wide before rendering, preserve
   applied Project effects, and delete Project authority only after its durable
   effect shutdown barrier passes.
9. General can be renamed but cannot be archived or made personal.
10. No Space transcript, message, Main link, Breakout, search result, activity,
    or notification appears in desktop or browser product surfaces.
11. Desktop surfaces consistently say Organization, Space, Channel, and
    Breakout; internal compatibility names do not leak into visible copy.
12. The lite browser continues to show explicitly shared Channels and Breakouts
    without exposing Space navigation or Organization-wide access to guests.
13. Real-workerd negative controls prove that skipping membership finalization,
    source-union recomputation, post-await generation fencing, or Space-feed
    suppression fails the corresponding integration test.
14. The changed desktop hierarchy is inspected in Electron and shared browser
    presentation is inspected in Chrome before the change is called complete.
15. Adding or widening a Space, migrating to General, and propagating a resource
    each fail closed when retained-content or attachment-audience containment
    would be violated; no partial membership becomes visible.
16. Fleet migration finishes without relying on user access, reports every
    blocked Organization, and cannot report complete while a Project effect or
    cutover dead-letter remains unsettled.
17. Organization retirement enumerates and receipts every Space and hidden
    child before reporting completion, including after an interrupted pass.
18. Space grants never enter the shared scope-grant directory, Space client
    socket upgrades are refused, and paginated General membership never expands
    the workspace socket's opening payload without bound.
