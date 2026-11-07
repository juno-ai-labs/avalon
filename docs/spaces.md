# Spaces (retired)

**Spaces are deleted from the server.** A Space, shown in the product as a
**Channel** after the navigation redesign, grouped an Organization's threads
(the stored Channels). The Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) removed both from the
product; the client stopped reaching them in steps B-1 to B-6, and plan step
C-2 deleted the server half. Nothing in the tree reads or writes a Space any
more.

This document is kept for its changelog. Several decisions in the code that
remains were shaped here — the claim/send/accept publisher the resource version
ledger still uses, the generation fences, the directory waterline, and the rule
that a Space never grants a reader — and the reasoning below is the only record
of why. Do not build on anything it describes; the code is gone.

## What was retired, and what survived

Deleted with C-2: `space-service.ts`, `space-bootstrap-service.ts`,
`workspace-space-storage.ts`, `workspace-space-default-publication.ts`,
`workspace-space-protocol.ts`, `system-channels.ts` (General and the Personal
Channel), `channel-rails.ts`, `workspace-channel-read-storage.ts`,
`unread-state.ts`, `channel-message-search-projection.ts`,
`channel-access-service.ts`, `shared-directory-service.ts`, the WorkspaceDO
Space, rail, Channel-read and directory RPCs, and the `space_channels` and
`channel_rails` socket commands. Onboarding no longer seats a new member
anywhere: there is no General to join and no Personal Channel to make.

What survives, and why:

- **The tables.** Every Space, placement, default, rail, Channel-read and
  Personal-Channel table stays in WorkspaceDO SQLite until plan step C-7's
  append-only drop migration. The Worker that stops reading them deploys
  first.
- **The migration statements.** A WorkspaceDO migration is hashed statement by
  statement, so the statements these modules exported moved byte for byte to
  `apps/api/src/durable-objects/retired-workspace-schema.ts`. Editing one would
  change a shipped migration's hash.
- **Queue tombstones.** A `space_default`, `space_bootstrap` or
  `space_intent_resume` message already in the activity Queue at deploy is
  acknowledged by `RetiredQueueMessageSchema` in `activity-consumer.ts` rather
  than dead-lettered.
- **The Sidekick list SQL.** The sidebar's Sidekick audience and viewer SQL was
  defined in `channel-rails.ts`; it moved, unchanged, to
  `apps/api/src/durable-objects/sidekick-directory-sql.ts`.

[`data-model.md`](data-model.md#changelog) holds the full retirement record.

## Changelog

### 2026-11-05 — A guest may be a Channel's participant, and works in it as a member does

**What changed:** `noteSpaceAudience` accepts a guest in `participantUserIds`;
it used to ask every listed participant to be an active member, and now asks
only for an active relationship. Taking part in a Channel became a path to
reading every Organization-wide thread placed in it (`channelReaderSql`),
beside membership and grants: the read check (`resolveScopedAccess`'s
`channelReader`), the listing leaf (`threadOrganizationWideSql`) and the
socket rows all ask it, and the Space writes that move it publish rows,
`workspace_reach_changed` and a narrowing for what a guest lost. A guest
Channel participant may post in those threads and start threads in the
Channel: `POST /workstreams` moved to the identity layer, and
`reserveChannelInSpaces` admits a guest into Spaces where their reach is
`participant`.

**Why:** Members could share a thread with a guest but not bring a guest into
the Channel around it, and product wants a guest in a Channel to work there
with permissions like a member's: see its public threads, post in them and
start new ones. The desktop people menu already offered
guests from the roster, and the write refused them with a generic error.

**Considered and rejected:** Seating guests as thread participants through
grants when they join a Channel or a thread is placed. That is the retired
Space access sources' shape ([`space-access-sources.md`](space-access-sources.md)):
a write per thread per guest, provenance to keep, plans that replay old rules,
and every guest showing in every thread's face pile and notifications. Read
time costs one indexed subquery on a guest's reads and needs no bookkeeping.
Granting members anything through a Channel was not considered: they already
read every Organization-wide thread.

**Consequences:** The thread-level leaf binds the user id for a guest, so a
statement binding positionally binds it `userIdBindCount` times, and a
numbered one passes its own expression; a new listing statement has to do one
or the other. Any write that moves a placement, a participant or a Space's
archive state owes `guestChannelReachMoved` for the guests it affects. The
read check admits a guest Channel reader as writable, as it does a member.
Memory facts from Organization-wide threads stay
members-only (`readsOrganizationFacts`), and a mention still asks to seat a
guest. Anything reading a Space's participants must not assume they are all
members.

### 2026-10-29 — A Sidekick's review announces a change as a Channel message

**What changed:** `postSidekickChannelMessage` writes one Channel message,
from Rally and opening with the Sidekick's name, in the Channel a Sidekick
announces in: General for an Organization's (`liveGeneralSpaceId`, General
while it is not archived), else its author's Personal Channel; the author's
Personal Channel for a personal one. Keyed on the post's client message id,
so a retried tool call writes nothing.

**Why:** A Sidekick no room owns has no Thread where its people would see a
change its wizard made unattended, and a Channel already holds messages of
its own. The merge was the only writer from outside the object; this is the
second, with the same shape.

**Consequences:** Rally stays the author, so the message seats nobody and
lights the dot as news. A Sidekick may post in exactly one Channel, decided
by the object from its scope and author, never by the model.

### 2026-10-22 — Dispatch invitation seating promptly and treat refused Channel reads as unavailable

**What changed:** Invitation acceptance immediately publishes its durable
membership event, including a retry whose earlier dispatch marker was lost.
The Channel screen treats `space_access_denied` and `space_not_found` as
**Channel not found**, even while its directory row is cached, and reports
read-position failures only after the feed has admitted the reader and its
current fetch has settled. Dispatch read failures leave committed acceptance
successful so Channel invitations and acceptance notifications can still run.

**Why:** Local end-to-end testing found new members waiting for the five-minute
recovery sweep before receiving General participation and their Personal Channel.
Forbidden links also queued feed and read-position dialogs that could outlive
the refused screen and interrupt the next Channel.

**Considered and rejected:** Seating through a second invitation-specific path
would duplicate the relationship consumer's authority and retry handling.
Suppressing every feed error would hide genuine loading failures; only access
refusals use the unavailable state.

**Consequences:** Queue acceptance remains distinct from completed seating, and
failed dispatches retain the existing scheduled recovery. The server's feed
refusal wins over a cached directory row; transport and Organization setup
failures still report errors. Cached feed data during a refetch is not proof
that the reader still has access.

PR: [#1426](https://github.com/juno-ai-labs/avalon/pull/1426).

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
recoverable after the Channel transaction commits, without holding the archive
request open for its RPCs. Delivery rechecks the Channel revision and exclusive
placement; a permanent refusal or independent thread restore releases the hold
for ordinary orphan repair. A retry must reuse its original command receipt,
and a Channel restore must not undo a completed independent thread archive.

PR: [#1398](https://github.com/juno-ai-labs/avalon/pull/1398).

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
Mechanism: `conversation-merge.md` (retired).

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
