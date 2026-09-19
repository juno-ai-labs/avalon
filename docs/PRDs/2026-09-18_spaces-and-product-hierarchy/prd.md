# Spaces and the Organization hierarchy

> Created 2026-09-18.
>
> Replace Projects with Spaces, organize every visible Channel under at least
> one Space, and rename Rally's product hierarchy to Organizations, Spaces,
> Channels, and Breakouts. Companion: [state](state.md). Supersedes the
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
deleted rather than converted. Every existing visible work stream becomes a
Channel in General and becomes visible to the Organization as part of that
migration.

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
4. Guarantee that every visible Channel belongs to at least one active Space
   across interactive creation, connectors, imports, demos, recovery, and
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
4. **Removing inherited state is rejected.** Removing a Channel from a Space,
   removing a Space resource or Sidekick, or archiving a Space does not retract
   access, resources, or Sidekicks already applied to the Channel. This preserves
   transcript and execution context and matches the additive behavior selected
   for Projects.
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
- archive or restore controls when lifecycle rules permit them.

It contains no composer, transcript, feed socket, Main link, or Breakout list.
Inherited backing conversations are not discoverable through the product.

Any active Organization member who can read a Space may edit it, matching the
current Project rule. Removing another participant requires an Organization
owner or administrator. Every such gate treats `owner` and `admin` as
administrators; the desktop role only decides which controls are drawn, while
the server reauthorizes every mutation.

### Channel membership

Creating a Channel from a Space assigns it to that Space. Creating a Channel
from a top-level composer, connector, import, demo, or recovery path assigns it
to General when no Space was supplied. A creation that explicitly names one or
more Spaces either establishes at least one valid active membership or fails
without publishing a visible Channel.

**Add to Space** allows every readable active Space not already holding the
Channel. Adding does not remove another membership. Dragging a Channel onto a
Space performs the same additive operation. Membership controls show all
current Spaces rather than one selected assignment.

Removing a Channel from a Space succeeds only when another active Space already
holds it. Rally rejects removal from the final active Space and identifies that
another Space must be added first. Archiving a Space is rejected when any member
Channel would otherwise have no active Space.

Membership removal stops future inheritance from that Space. Audience grants,
resources, and Sidekicks already applied remain on the Channel. Subsequent
changes to the removed Space do not update that Channel.

### Audience, resources, and Sidekicks

Adding a Channel to a personal Space grants every active Space participant
access to the Channel. Adding it to an Organization-wide Space makes the
Channel Organization-wide. Direct Channel access and access supplied by other
Spaces remain independent.

Changing an active Space audience updates the Space-derived access source on
every current member Channel. Removing one source does not revoke access still
provided directly or by another Space. The existing WorkstreamDO scope-grant
authority, relationship incarnation, participant projection, and canonical
authorization checks remain the final access decision.

Adding a resource or Sidekick to a Space applies it to every current Channel
and records it for later members. Duplicate delivery is harmless. Removing it
from the Space stops future application and invalidates undelivered stale work,
but does not remove it from a Channel that already received it.

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
General exists and every visible Channel has an active membership. It never
shows a partially migrated hierarchy or a Channel without a Space. Retrying an
interrupted migration resumes from durable receipts rather than creating
another General Space or duplicating membership effects.

### Existing Organizations

For every existing Organization, cutover creates General, places every visible
Channel in it, and makes every formerly personal Channel Organization-wide.
Existing Projects and their ordering, memberships, participants, and defaults
are deleted. There is no conversion preview or restoration path through the
product.

## Impact on the product contract

This changes the standing implementation brief. Rally is no longer described
as organized around work streams “rather than channels.” Its visible product
hierarchy becomes Organizations, Spaces, Channels, and Breakouts, while a
Channel remains the durable multiplayer home in which Rally participates and
acts.

The contract must also state that every visible Channel has at least one Space,
that one Channel may appear in several Spaces, and that Spaces are organizational
and inheritance surfaces rather than conversations. The existing principles
remain: Rally is inherent in every Channel, viewing does not itself create
participation, tools remain typed and authorized, and Rally gains no global
inbox or global activity feed.

## Decision log

None yet.

## Key design decisions

1. **A Space specializes the work-stream primitive.** A thin `SpaceDO` reuses
   presentation, participant, resource, Sidekick, receipt, and lifecycle
   behavior. A separate Project-like implementation was rejected because every
   new capability would need two authorities.
2. **SpaceDO is configured, not behaviorally overridden.** WorkstreamDO gains
   immutable role configuration for namespace, parent kind, migration identity,
   directory publication, and product exposure. `SpaceDO` supplies that role in
   its constructor and adds no method overrides.
3. **WorkspaceDO owns the relationship, not the Space or Channel.** The
   Organization object coordinates the many-to-many directory, ordering, final
   membership invariant, and General identity. Neither endpoint can answer
   whether a Channel has another Space without consulting that authority.
4. **Existing scope grants gain provenance.** Space-derived access extends the
   WorkstreamDO grant authority with internal direct/Space sources and derives
   one effective grant. A second permission store was rejected because it would
   compete with canonical grant admission and participant projection.
5. **Inheritance is additive across membership removal.** A Space applies
   useful state before membership becomes visible; leaving stops later updates
   but does not rewrite a Channel's established execution context.
6. **General is a protected fallback.** It is not a universal membership for
   future Channels, but its identity, active lifecycle, and Organization-wide
   audience cannot be removed. Requiring every creation surface to choose a
   bespoke Space was rejected because connectors and recovery paths also create
   Channels.
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

SpaceDO uses the WorkstreamDO SQLite schema under its own migration component
and Durable Object namespace. Its ID is the Space ID and the backing parent ID;
there is no second identity mapping. The hidden main conversation remains the
participant and resource authority, while inherited parent state owns Sidekick
recommendations and presentation.

WorkstreamDO's grant storage records internal source provenance for direct and
Space-derived grants. Existing effective grant contracts and grant-directory
effects remain stable. Organization-wide Space sources compose with the
Channel's direct scope so one source cannot narrow another. Existing grant rows
are backfilled as direct sources.

The current expected migration sequence is:

- Cloudflare Durable Object class migration `v11` adds `SpaceDO`.
- WorkstreamDO migration `18` adds source-aware effective grants and scope
  provenance.
- WorkspaceDO migration `61` adds Space projections, memberships, General, and
  bootstrap state.
- A SubstreamAgent migration follows its current `62` only if stored parent-kind
  constraints require a schema change.

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
Spaces require active member access. Guests receive no implicit Space access.

Space-derived Channel access uses the existing canonical WorkstreamDO grant
authority, membership-incarnation fencing, expected revisions, operation
receipts, participant projection, and final owner admission. WorkspaceDO's
directory and membership projections are discovery and coordination state;
they never authorize Channel content by themselves.

External awaits during membership and propagation may interleave. The source
Space revision, membership generation, and delivery generation are re-read
after each external boundary before finalization. Grant mutation, effective
union recomputation, participant-delivery intent, and operation receipt commit
in one synchronous object transaction.

Resources retain their existing canonical metadata and attachment authorization.
Space membership does not broaden connector installation or administration
rights, expose personal connector credentials, or create a tool-approval flow.

## Rollout

This is an unflagged coordinated cutover. Running Projects and Spaces beside
each other was rejected because the two directory and inheritance authorities
could disagree about the same Channel.

Deployment proceeds in this order:

1. Ship contracts, `SpaceDO`, bindings, append-only Durable Object class
   migration, new object schemas, bootstrap state, and server support before a
   client can request the new hierarchy.
2. Deploy the client and server release that switches to Space contracts and
   removes Project behavior. Older Project clients are no longer supported.
3. New Organizations create General before their first usable session.
4. Existing Organizations start or resume their durable General bootstrap on
   first admitted access. Space/Channel directory serving waits for completion.
5. After General and every membership are verified, delete Project rows and
   publish the first complete Space snapshot.
6. Treat bootstrap failures and dead-lettered propagation as release failures;
   do not fall back to a partial Project or flat-Channel experience.

Rollback before destructive bootstrap may restore the previous release.
Rollback after Project deletion requires restoring from operational backup; the
product has no dual-write or reverse conversion path. Release verification must
therefore prove bootstrap on a representative populated Organization before
promoting the cutover broadly.

## Acceptance

1. A new Organization opens with one Organization-wide General Space and no
   visible Channel outside a Space.
2. Creating a Channel inside a Space shows it there; top-level and connector
   creation without a Space shows it in General.
3. Adding one Channel to two Spaces displays two placements that open the same
   transcript and retain independent Space order.
4. Removing one of several memberships succeeds without retracting inherited
   state; removing the final membership fails with actionable copy.
5. Archiving a Space with a sole-member Channel fails; after adding that Channel
   elsewhere, archiving succeeds.
6. Personal and Organization-wide Space audiences compose with direct and other
   Space grants without accidental revocation.
7. Resources and Sidekicks reach current and future member Channels once;
   removal stops future delivery without retracting completed delivery.
8. Existing Organizations migrate idempotently to General, delete Projects,
   and make formerly personal Channels Organization-wide before rendering.
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
