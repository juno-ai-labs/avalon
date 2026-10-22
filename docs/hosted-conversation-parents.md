# Hosted conversation parents

A **Channel**, a **Space** and a **Sidekick** are conversation parents. A
Channel and a Space each each owns who may read
its conversations, its breakout registry, its grants, invitations and Space
access provenance, and the per-viewer state the sidebar and the Channel screen
draw. That state lives inside the Organization's `WorkspaceDO`, keyed by
parent id, in the same SQLite database as the directory, the Space membership
and the grants it is derived from or copied into, so a conversation request
asks one warm object instead of two parent calls, sidebar state takes one Queue
hop instead of two, and a Space change is a transaction instead of a
cross-object saga. This document owns that hosting. Each parent used to be its
own Durable Object (`WorkstreamDO`, and `SpaceDO`, which was `WorkstreamDO`
under a role); both classes are deleted, and [How the parents
moved](#how-the-parents-moved) records how their rows got here.

A Sidekick's parent, its definition, revisions, schedules and runs, moved in
beside them ([A Sidekick is hosted beside them](#a-sidekick-is-hosted-beside-them)).
Its legacy `SidekickDO` was deleted once every Sidekick outside a retired
Organization had been imported.

The conversations themselves do not move. Every Channel main conversation, every
breakout and every Sidekick run is still a `SubstreamAgent`: a transcript and an agent loop are a real concurrency and size
boundary, and they stay one object each. What a Sidekick does, and who may do
it, is [`automation-lifecycle.md`](automation-lifecycle.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/hosted-parent.ts` | `HostedParent`: one Channel's or Space's parent authority, scoped to a `parent_id` inside `WorkspaceDO`'s SQLite. The port of what `WorkstreamDO` and `ConversationParentDurableObject` did for one object. Also the batch readers for what a Channel row adds per viewer (`visiblePrivateChildren`, `runningBackgroundAgents`, `channelViewerStates`). |
| `apps/api/src/durable-objects/channel-rails.ts` | A Channel's rail: the set reads a `channel_rails` answer is built from, the frame packer, and migration 82 (`CHANNEL_RAIL_MIGRATION`: the rail tables, `rail_waterline` and its triggers). |
| `apps/api/src/durable-objects/sql-write-observer.ts` | `observeSqlWrites`: the state `WorkspaceDO` hands everything, whose SQL handle schedules the rail drain after every write. |
| `apps/api/src/durable-objects/hosted-parent-schema.ts` | `WorkspaceDO` migration 72: the `parent_*` tables and the directory renames. |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPC facade: every conversation-parent method now answers here, dispatching to `HostedParent` for its `parentId`. Also the Channel rows on the workspace socket (with each viewer's breakouts and running background agents), the retired Channel control socket kept for older clients, the in-transaction apply of what a parent publishes, the outbox drain, and the workspace relationship table. |
| `apps/api/src/durable-objects/scope-grant-storage.ts`, `scope-invitation-storage.ts`, `scope-invitation-service.ts` | The grant and invitation repositories, now scoped by `parent_id`. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | `HostedSidekick`: one Sidekick's parent and lifecycle, scoped to a `sidekick_id` inside `WorkspaceDO`'s SQLite. The port of what `SidekickDO` did for one object. Also `sidekickReaderAllows`, the read rule the library listing shares. |
| `apps/api/src/durable-objects/hosted-sidekick-schema.ts` | `WorkspaceDO` migration 91: the definition columns on `automation_directory`, the `sidekick_*` tables and the `sidekick_imports` ledger, which migration 92 drops. |
| `apps/api/src/services/sidekick-run-provisioning.ts` | `provisionSidekickRun`: the Queue consumer step that opens a run's conversation and starts its loop, off the Organization's alarm. |
| `apps/api/src/services/conversation-parent-client.ts` | `hostedParentStub` and `conversationParentStub`: `WorkspaceDO` for every parent. |
| `apps/api/src/queues/activity-consumer.ts` | A `conversation_effect` for any parent goes to `WorkspaceDO.receiveChildEffects`; a `sidekick_run_provision` message to `provisionSidekickRun`. |

## How it works

### One parent, many rows

`HostedParent` is constructed per call with the `WorkspaceDO`'s storage, the
parent id, and the parent's role (Channel or Space). Every table it touches has
`parent_id` as the leading key column, so what was one object's database is now
one parent's slice of the Organization's. The logic, fences and error codes are
the ones `WorkstreamDO` had; the port changed where rows live, not what they
mean.

### Table map

The directory tables `WorkspaceDO` already held were renamed to the product's
names:

| Before | After |
| --- | --- |
| `workspace_workstream_directory` | `channels` |
| `workspace_workstream_viewers` | `channel_viewers` |
| `workspace_breakout_directory` | `breakouts` |
| `workspace_breakout_viewers` | `breakout_viewers` |
| `workspace_space_directory` | `spaces` |
| `workspace_space_viewers` | `space_viewers` |

The parent state moved in under a `parent_` prefix, one row set per parent:

| Legacy table (one object) | Hosted table (keyed by `parent_id`) |
| --- | --- |
| `workstream_metadata` (`id = 1`) | `parent_metadata` |
| `conversation_children` | `parent_children` |
| `substream_directory`, `substream_user_directory` | `parent_child_projections`, `parent_child_viewer_projections` |
| `child_effect_receipts` | `parent_child_receipts` |
| `projection_keys` | `parent_projection_keys` |
| `workstream_state_clock` (`id = 1`), `workstream_state_changes` | `parent_state_clock`, `parent_state_changes` |
| `durable_outbox` | `parent_outbox` |
| `private_child_preparations`, `private_child_memberships`, `private_child_membership_effects` | `parent_breakout_preparations`, `parent_breakout_members`, `parent_breakout_member_effects` |
| `scope_grant_revision`, `scope_grants`, `scope_grant_operations`, `scope_grant_imports` | `parent_grant_revision`, `parent_grants`, `parent_grant_operations`, `parent_grant_imports` |
| `participant_projection_targets`, `participant_projection_deliveries` | `parent_participant_targets`, `parent_participant_deliveries` |
| `main_participant_migration`, `child_participant_migrations` | `parent_participant_migrations` (substream `0` is Main) |
| `scope_invitations`, `scope_invitation_operations` | `parent_invitations`, `parent_invitation_operations` |
| `connector_participant_admissions` | `parent_connector_admissions` |
| `workstream_sidekick_attachments` | `parent_sidekicks` |
| `workstream_direct_audience`, `workstream_space_access_sources`, `workstream_space_supplied_readers`, `workstream_access_operations` | `parent_direct_audience`, `parent_space_sources`, `parent_space_readers`, `parent_access_operations` (dropped by WorkspaceDO migration 94) |
| `workstream_socket_ticket_receipts` | `workspace_socket_ticket_receipts` (already existed) |
| `scope_grant_deliveries` | dropped; nothing had written it since WorkstreamDO migration 17 |

### What stopped crossing an object boundary

| Flow | Before | Now |
| --- | --- | --- |
| A viewer check on a conversation request | two calls to the parent object, after probing which namespace owns the id, each reading D1 for the relationship | one call to `WorkspaceDO`, which resolves the kind and answers the viewer together from its own relationship table |
| A conversation's title, preview or unread reaching the sidebar | conversation → Queue → parent → Queue → `WorkspaceDO` | conversation → Queue → `WorkspaceDO`, which applies the parent step and the directory step in one transaction |
| A grant reaching the grant directory | grant in the parent, Queue message, directory in `WorkspaceDO` | one transaction in `WorkspaceDO` |
| Creating a Channel | reserve in the parent, a synchronous call back to `WorkspaceDO` for the provisional directory row | one `WorkspaceDO` call |
| Breakout creation | about ten calls to the parent | the same calls, now answered by the warm Organization object |

What still crosses: anything that touches a conversation (`initialize`, the
participant projection pushed into a conversation, breakout lifecycle and
membership pushes, `stopOwnedAgent`), the conversation's own effects (the Queue
is still the durable handoff out of a `SubstreamAgent`), and activity and
notification effects, which still leave through the Queue so their delivery runs
in a Worker rather than in the Organization object.

### Effects land in the parent's transaction

Everything a hosted parent publishes lands in the same transaction as the
parent change that caused it. `HostedParent` wraps its writes in `tx()`; at the
end of the outermost one it hands what it published to
`WorkspaceDO.applyLocalEffects`, which writes:

- the directory rows (`channels`, `channel_viewers`, `breakouts`, `spaces`,
  `space_viewers`) through the synchronous core `applyDirectoryBatch`, Channel
  rows before viewer rows;
- the grant directory (`scope_grant_directory`);
- the activity row and the notification record
  (`applyWorkstreamRegionalEnvelope`).

All of it lands or none of it does. An apply that throws fails the parent
transaction: a child's effects are then redelivered by their Queue message (the
receipts answer the envelopes of the batch that already committed), and a
request's write fails where the caller sees it. A viewer row whose Channel row
is not there yet is such a failure, and the redelivery after the Channel row
lands applies it.

The sends that follow a directory change (socket publishes, Space snapshots,
schedule refresh, watch reconciliation, archival notices to owned Sidekicks)
cannot run inside a transaction. They are recorded as a
`workspace_directory_followups` row in the same transaction, run straight after
the commit, and taken by the alarm's `directory_followup` phase if that run did
not finish. A row is parsed when it is read back; one that does not parse is
kept as `failed` with its code (`directory_followup_unreadable` is logged) and
never run again.

### People the member table has never heard of

The directory filters viewer rows by the Organization's own member table (see
below), so a transaction that has to write a viewer row must know the person.
The people a delivery or a request names are learned before the transaction:
`receiveChildEffects` reads the member table for every viewer and notification
recipient its envelopes name, and asks D1 once for each it has never heard of
(`readRelationship`, which records the answer). A transaction that still meets
somebody unknown, such as a creator's row published inside `reserveChild`,
throws `UnknownMembersError` and rolls back whole; `withMembersLearned` learns
the ids it names with one D1 read each and runs the operation once more from
the same state. Every facade write goes through `parentWrite`, which is that
retry followed by the post-commit follow-ups.

### The outbox is work that leaves the object

`parent_outbox` holds only work that has to leave the Organization object, each
row written in the transaction that caused it:

- a notification to deliver and a mention to snapshot, which the activity
  Queue's consumer does in a Worker (its apply there is a replay: the record is
  already here);
- a revoked Channel grant, whose Sidekick revocation is a Queue send.

A directory row is never written here, because it applies in its parent's own
transaction. One found here was never going to land, so the drain marks it
`failed` with the code `parent_outbox_directory_row` and does not apply it.

A write does not drain it: the rows are due at once, and the alarm sends them.
A failed send puts the row off on the alarm's retry schedule
(`scheduledAlarmRetryDelay`, by the row's own attempt count) and records its
code. A row that does not parse, or whose destination refuses its shape, is
kept as `failed` with its code
(`parent_outbox_row_unreadable` is logged), is never due again, and does not
hold up the rows behind it. Queue rows go in `sendBatch` calls under the
Queue's per-call size, and a single row too large for one Queue message is
deleted with a `parent_effect_oversized` warning. Rows are not claimed: the
alarm is the only drain, and an alarm never runs beside another. Rows are keyed
by `(parent_id, message_id)`.

### The alarm's phases

The alarm runs the hosted phases (`parent_outbox`, `parent_breakouts`,
`directory_followup`) first. Each phase's throw is caught and logged as `workspace_alarm_phase_failed` with
the phase and its code, and the phases after it still run; the first throw is
rethrown once they have, so the alarm fails and retries as before instead of
re-arming at once for rows the failed phase left due.

### A Channel's state reaches its readers as its row

A reader learns a Channel's state from its row on the workspace socket, not
from a socket of the Channel's own. The row the directory already sent every
reader (common and viewer state, waterlined) also carries, for that reader,
`privateChildren` with `privateChildrenWaterline` and `backgroundAgentCounts`.
`channelViewerStates` reads both for any number of Channels in three queries,
so the connect sidebar costs the same per Channel as one row.

Each breakout in `privateChildren` carries, besides its title and state,
`originTurnId` — the Main turn it was branched through, read from its
`parent_breakout_preparations` request's `sourceThroughTurnId`, and null when it
was branched through none or has no preparation row — and `lastActivityAt`, from
its `directory_common` projection and absent until one has arrived. Both are in
the hashed breakout list, so a breakout's activity alone moves
`privateChildrenWaterline`. The guest navigation read (`readSharedWorkstream`)
gives each Breakout the same `originTurnId`. A reply count is deliberately not
carried.

Most changes reach the row through the directory apply. Two do not, and the
parent republishes the row itself when they happen: a breakout list that moved
for someone (`advancePrivateChildrenVersion` notes whom; the row goes to that
person's sockets), and the running background agents changing across a batch of
child effects (compared before and after; the row goes to every reader). A
batch of child effects collects both republishes into the same plan as its
directory follow-ups, so the Channel goes out once per socket for the whole
batch: `HostedParentHost.publishChannelRow` queues into that plan rather than
sending, and whoever constructs the parent with a plan owns sending it
(`receiveChildEffects`, through `afterParentWrite`). The reasoning is
[`websocket-architecture.md`](websocket-architecture.md#who-the-workspace-socket-tells-and-how-often)'s.
A reader bringing a Channel to the foreground wakes its Main.

Losing a Channel is its row's tombstone, sent to the people the write took it
from and to nobody else: the client evicts its cached Channel, and the
workspace socket stays open for the sidebar. Who that is, per kind of write,
and why nobody who never saw the Channel is sent one, is in
[`websocket-architecture.md`](websocket-architecture.md#who-the-workspace-socket-tells-and-how-often).

The Channel control socket (`/parent-socket`, tagged `parent-control:<id>`)
still works for desktops released before this and for the iOS client, and its
revocation paths (`revokeNarrowedAudienceAccess`, `revokeSocketAccess`) still
close it. No current desktop opens one.

### A Channel's rail and its waterline

A Channel's rail lists Main's participants, its Sidekicks and Main's
resources. `channelRails` builds any number of them from this object's SQLite
with set reads over `json_each`, and the workspace socket answers
`channel_rails` with it ([`realtime-sockets.md`](realtime-sockets.md)):

- **Visible** is the row's rule and nothing else: hosted, not archived, and
  Organization-wide or the viewer a participant at the Channel's generation.
  Anything else asked for is `unavailable`.
- **Participants** are `channel_viewers` at that generation, newest first, the
  same read the facepile uses.
- **Sidekicks**: `owned` is the room's automations, and only for a member who
  is a participant, as the REST read answers everyone else with 403; it omits
  the run times, which move on every scheduled run. `recommended` is
  `parent_sidekicks` then the owned ids. `attached` is what Main last reported
  (`channel_sidekick_attachments`), and absent until Main has reported
  (`channels.sidekick_attachments_reported`). Main reports on every
  `directory_common`; a Main that has never reported is asked to when its
  Channel is opened (`wakeMainConversation` passes `reportAttachments` while
  `mainAttachmentsUnreported` holds). Until a Main reports, its rail omits
  `attached` and the desktop reads that list over REST. Recommended and attached
  entries are shown under the Sidekick audience predicate `HostedSidekick` shares
  ([`automation-lifecycle.md`](automation-lifecycle.md)).
- **Resources** are Main's links in `workspace_workstream_resource_links`
  rowid order (the table is replaced whole, so rowid is display order),
  joined to `resources`, without notes or unlisted resources, as the
  conversation detail enumerates them.

`channels.rail_waterline` advances whenever any of that moves, and rides the
row as `railWaterline` (`channelViewerStates`). The triggers in
`CHANNEL_RAIL_MIGRATION` advance it for every rail source whose writers are not
already Channel-row writers; Main's link and attachment lists are compared in
`applyDirectoryEnvelope` instead, because every Main effect rewrites them.

Every advance also notes the Channel in `channel_rail_changes`, and one
mechanism drains it: `WorkspaceDO` wraps its state in `observeSqlWrites`, so any
statement that is not a `SELECT`, from any entry point, schedules one drain as
a microtask, which runs once the synchronous code that wrote (and any
transaction around it) has finished. The drain takes the whole table and pushes
each Channel's row to its readers. A directory batch takes its own Channels off
the ledger before that drain runs and hands them to its follow-up pass, which
sends them with the rows it owes anyway, so a Channel's row is not pushed twice
for one effect (`railRowsHeld`, in memory: a pass that never runs leaves them
for the next). A writer therefore
owes the rail nothing but its trigger.

### Workspace relationships are local

`workspace_member_status` holds each person's workspace relationship
(incarnation, revision, access class, role, status) as this object last heard
it. The relationship change events keep it current: the relationship consumer
calls `WorkspaceDO.applyMemberStatus` in D1's sequence order, and someone who
stops being an active member leaves every viewer directory in that
transaction. The consumer applies the event before it walks a revocation, so
a walk that fails and retries (or dead-letters) has not left the table saying
active. `readRelationship` answers access checks, Space checks and the
directory's member filter from it; D1 is read once, for someone it has never
heard of (a member from before the table existed). The team accepts up to five
minutes between a D1 change and this table and chose to trust the events
rather than re-read on a timer.

A request that has just read a relationship from D1 or written one there
(accepting an invitation creates a guest relationship) records it with
`noteRelationship`, so its own next checks see it. That replaces the stored
row only when it is provably newer: the stored relationship was removed and
this is a different incarnation (a guest removed and invited again), or it is
the same incarnation at a higher revision. A removed incarnation never comes
back, which is why a removal keeps `removed_incarnation`; a live row of another
incarnation is left alone, since an event may have landed while the request
waited on D1. The row keeps its sequence, so the events after it still apply,
and an event carrying an older revision of the incarnation the row holds
advances the sequence without moving the answer back. The invitation route
also dispatches the relationship's delivery as soon as it responds, rather
than leaving it to the five-minute cron.

A Sidekick default a Space applies in place asks the requester's management
of each member Channel from this table and the Channel's grants, in the same
transaction (`canManageChannelNow`). Somebody the table has not heard of, or a
refusal, takes the Queue's canonical path instead.

Abandoning a workspace (its last active member leaving) suspends that member
in D1, which bumps the relationship's revision and dispatches its event, so
the table learns it like any other suspension. Access checks here do not read
`workspaces.abandoned_at`. An operator retirement or an abandoned demo
preparation sets `abandoned_at` with no member change; both then retire the
Organization object itself, whose tombstone refuses every request, so the
table is never asked. The window between the D1 write and the tombstone (one
RPC, repeated by the operator's retry if it fails) is accepted.

### How the parents moved

Migration 72 seeded a `parent_imports` ledger with one `pending` row for every
Channel and Space the directory held. Each parent was moved once: the legacy
object exported every row and froze itself, and `WorkspaceDO` inserted them
under the parent id, re-armed what the legacy alarm owed and replayed the
breakout projections and direct grants the legacy migrations 17, 19 and 20 once
replayed, in one transaction. A request imported the parent it needed first;
the alarm imported the rest in pages. A failed import stayed `pending` with its
code until an operator repaired it.

By 2026-09-26 every live Organization had imported every parent; the only
`pending` rows left were in six retired demo Organizations, whose retirement had
dropped their imports. The wrangler `v12` tag then deleted both classes and
every object in their namespaces, and `WorkspaceDO` migration 75 dropped the
ledger. A parent id with no `parent_metadata` row is now simply a parent this
object does not host.

Child-effect receipts are not imported: a replay older than the import
converges on the per-key waterlines, which is the rule the legacy receipts
already fell back to past their retention. The hosted parent keeps its own
receipt ledger, `parent_child_receipts`, with the legacy 180-day retention; see
[Performance and cost](#performance-and-cost).

### A Sidekick is hosted beside them

`HostedSidekick` is constructed per call, like `HostedParent`, with the
Organization's storage and the Sidekick's id. It is a sibling class rather than
a third `HostedParent` role: a Sidekick's lifecycle (drafts, revisions,
schedules, runs, inbound email) shares nothing with a Channel's, and Channel
code scans the `parent_*` tables across every parent, where a Sidekick's runs
would read as Breakouts.

| Legacy `SidekickDO` table | Hosted |
| --- | --- |
| `automation` (`id = 1`) | `automation_directory`, which gains the definition columns: the sidebar row and the definition row are one row, so there is no copy to publish |
| `definition_revisions`, `schedules`, `runs`, `inbound_email_receipts` | `sidekick_revisions`, `sidekick_schedules`, `sidekick_runs`, `sidekick_email_receipts` |
| `conversation_children`, `substream_directory`, `child_effect_receipts` | `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts` |
| `_internal_durable_alarms` | the Organization's own, keyed `<sidekickId>:<key>`; `sidekick_publication` became `sidekick_memory_tables` |
| `durable_outbox` | none: the directory row is written in place |

The facade answers each Sidekick method as `sidekick*` (`sidekickPause`,
`sidekickRunNow`) and the parent contract under the shared names, with the
Sidekick tried before the Channel fallback. Callers hold the Organization's
stub and call it directly. Three rules keep it fast:

- **A read does no write's work.** A write (`sidekickCall`) publishes the
  sidebar if the row moved and re-arms the alarm once, after the Sidekick's
  own code; a read (`sidekickRead`) does neither. A run reads its state before
  every provider write.
- **Several Sidekicks are one call.** Every Sidekick in an Organization is
  answered by this one object, which runs one request at a time, so a caller
  that fanned out one call per Sidekick now queues them behind each other.
  `sidekickReadSkillSummaries`, `sidekickReadSkillSources` and
  `sidekickReadDetails` take a list of ids, a Channel (whose recommended and
  owned Sidekicks are read here), or every loadable Sidekick, and answer from
  local rows. Resolving a run's skills is one call on the common path, and the
  summaries and sources are one statement inside it: `selectSidekickRows`
  picks and orders the Sidekicks and joins each one's accepted revision, and
  the pure `skillSummary` and `skillSource` decide each row.
- **One read per question, one statement per change.** A question that needs
  several of a Sidekick's rows joins them (`runView`, `withAccepted`), and a
  change writes with a returned witness (`UPDATE ... RETURNING`, an upsert's
  returned row) rather than reading first.
- **A check rides the write it guards.** A Channel or Space recommendation
  checks the Sidekick's scope inside `setSidekickRecommendation` and
  `addSpaceDefault`; an external event is admitted in one call, whose unjudged
  refusal carries the written conditions for the classifier, so only a gated
  event costs a second.

A run's conversation is opened off the alarm: the run's entry registers its
child and sends a `sidekick_run_provision` message, whose consumer bootstraps
the conversation, starts its loop and reports `sidekickRunProvisioned`. The
entry is moved later after each send, since the drain deletes an entry at the
instant that ran whatever its handler returned; the wait grows with the run's
age, and the report settles it.

A Channel-scoped Sidekick keeps the two access rules it had: who may manage the
owning Channel (its grants and an archive included) manages it and reads its
detail, and the Channel's participant rows decide who views it and sees it
listed, which costs no read beyond this object's. A Breakout-homed one admits
the Breakout's members for both. The library listing takes the caller's access
class and role from its authentication rather than reading them again.

**How Sidekicks moved.** Migration 91 put every Sidekick the directory held on
a `sidekick_imports` ledger, and each one was imported from its legacy
`SidekickDO` on first use or on the alarm. Once every Organization outside a
retired one had imported, the class was deleted (Wrangler tag `v13`) and
migration 92 dropped the ledger. A Sidekick still pending in a retired
Organization was never imported; the Organization refuses new work, so nothing
reads it.

Resolution suggestions reuse `resolveConversation` and read the same bit through
`readConversationResolved`. Conversation resolution is owned by [merge-back](conversation-merge.md#resolution-and-archiving)
and saved on the parent child registry independently of execution and archive state.

## Invariants

- **A hosted Sidekick reads the Organization's tables with `sql.exec`.** Not
  through the runtime database adapter (`localWorkspaceEnv(...).DB`), which
  parses every statement, applies the typed-table guard and does the sidebar
  bookkeeping a request needs and an in-object read does not. A read after an
  `await` reads again: another call may have changed the row meanwhile.
- **A parent's presentation is read from its directory row.** A Channel's
  title, scope, archive state and every other presentation column come from
  `channels`; a Space's title, scope and archive state from `spaces`
  (`HostedParent.metadataRow()`). `parent_metadata` holds only identity,
  generation and revision (migration 79). Before the directory row exists a
  parent reads constants: `personal`, untitled, not archived, so a parent
  nobody has described admits its participants and nobody else. A fixture or
  tool that changes a parent's scope or archive state writes the directory row.
- **Every hosted table leads with `parent_id`, and every statement names it.**
  A statement without it reads or writes every Channel in the Organization; the
  worst case is `claimReaderAsDirect`, which deletes a reader's Space
  attribution and would do so across every Channel.
- **What a parent publishes commits with the parent change, or the change does
  not commit.** The directory, grant directory, activity and notification rows
  are applied in its transaction, and an apply that throws fails it; work that
  cannot run inside a transaction (a follow-up send, work that leaves the
  object) is recorded durably in that same transaction, as a follow-up row or
  an outbox row. Nothing is parked in the outbox to hide a failure.
- **A hosted-parent write runs through `parentWrite` or `withMembersLearned`.**
  Anything else meets `UnknownMembersError` on the first person the member
  table has not heard of, and fails.
- **A D1 read replaces a stored relationship only when provably newer.** Events
  carry D1's sequence; a read or write a request made replaces a row only with
  a new incarnation over a removed one or a higher revision of the same one.
- **Grants, invitations and sharing are Channel-only.** The facade refuses
  them for a Space id with `channel_parent_required`; the Space role does not
  refuse them itself.
- **A per-viewer Channel fact rides the Channel's row.** A second socket or
  subscription per Channel would bring back the second copy of the row, and its
  second authorization path, that retiring the control socket removed.
- **Anything a rail lists advances `rail_waterline` in the write that changes
  it.** A client holds a rail until the row's waterline passes it, so a change
  that moves neither a trigger nor an explicit bump is invisible until
  something unrelated moves it. A new rail source adds its trigger or bump in
  the same change; the drain needs nothing from it.
- **Every `sidekick_*` statement names `sidekick_id`, and a Sidekick's alarm
  entries are keyed `<sidekickId>:`.** Without it a pause or a cancel reaches
  every Sidekick in the Organization; `cancelSidekickAlarms` cancels by that
  prefix, never by kind.
- **A Sidekick's alarm is re-armed by the facade, once per call.**
  `HostedSidekick` writes entries; it does not arm the native alarm.
- **Parent-kind is carried, never probed.** A lookup that tries a namespace to
  see whether something is there creates the object it asked about.

## Boundary

This module owns Channel, Space and Sidekick parent state inside `WorkspaceDO`,
what a Channel's workspace-socket row carries for each
viewer, and the retired Channel control socket. It does not own
the conversations ([`workstream-durable-object.md`](workstream-durable-object.md)),
Space membership, ordering and defaults ([`spaces.md`](spaces.md)), the grant
directory ([`scope-grant-directory.md`](scope-grant-directory.md)), invitations
([`scope-invitations.md`](scope-invitations.md)) or what a Sidekick does
([`automation-lifecycle.md`](automation-lifecycle.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| A local apply fails inside a parent write (a viewer row before its Channel row, a constraint, a schema rejection) | The parent transaction rolls back. A child's delivery throws and the Queue redelivers it; a request fails with the error. Nothing is left in the outbox. |
| A write meets somebody the member table has never heard of | The transaction rolls back with `workspace_member_unknown`; the ids are learned with one D1 read each and the write runs once more. A second miss fails the write with that code. |
| One Sidekick's pause or resume fails during a Channel archive | That Sidekick's transaction rolls back and `sidekick_owning_room_archival_failed` names it; the archive and every other Sidekick's pause stand. |
| A `parent_outbox` send fails | The row stays `pending`, with its code in `last_error_code`, and is due again on the alarm's retry schedule. `parent_effect_delivery_deferred` names the rows. |
| A `parent_outbox` or `workspace_directory_followups` row does not parse (a follow-up row in the shape written before #989 is one), or an outbox row's destination refuses its shape | It is kept as `failed` with a `zodDiagnosticCode` naming the field, logged (`parent_outbox_row_unreadable`, `directory_followup_unreadable`), and never retried. An operator reads it with `run_workspace_sql` and deletes or repairs it. |
| A directory row is found in `parent_outbox` | It is kept as `failed` with `parent_outbox_directory_row` and not applied. Directory rows apply in the parent's own transaction, so nothing writes one there. |
| One alarm phase throws | `workspace_alarm_phase_failed` names the phase; the other phases still run, and the alarm then fails and retries. |
| An Organization held below schema 58 by the meeting-notes cleanup | Migration 72 has not run, so there are no `channels` or `parent_*` tables and every Channel request fails with `no such table`. The object itself still starts and its alarm skips the hosted-parent phases, so the operator retirement RPCs can finish it. Every production object was at schema 70 before this change, so none should be held; the error is loud if one is. |
| A rail larger than a socket frame | It is named in its frame's `oversized` list with its waterline, logged `channel_rail_oversized` with its size, and the client paints that Channel from its snapshot. |
| A stored row fails the rail's schema | That rail is sent as `oversized` and logged `channel_rail_invalid` naming the field; the answer still ends with its `final` frame. A Sidekick whose stored appearance no longer parses is listed without one and logged `automation_directory_appearance_invalid`. |
| A drained rail change's row push fails | Logged `channel_rows_publish_failed`; nothing retries it, because rows are best effort and a reconnect reads the current waterline. The change is not lost, only the prompt to ask for it. |
| The drain itself throws | Logged `channel_rail_drain_failed`. The ledger keeps its rows and the next write's drain takes them; nothing arms the alarm for them. |
| A run's provisioning message is lost | The run's entry sends it again; the wait grows with the run's age until `sidekickRunProvisioned` settles it. |
| The Organization object is unavailable | Channels and Spaces cannot be opened, listed or changed. That was already true of the sidebar; it is now true of a Channel's viewer check too. |

## Testing

Fixtures seed a Channel's `channels` row beside its identity row in
`parent_metadata` (`insertChannelRow` in `test-workers/helpers/hosted-parent.ts`)
and change scope or archive state on the directory row.
`hosted-parent-migration.test.ts` upgrades a populated v78 object and proves
migration 79 keeps every parent's identity row and leaves only the identity
columns. `hosted-parent-isolation.test.ts` proves a parent with no directory row
refuses a non-participant and admits them once its row says `workspace`. `automation-post-result.test.ts` proves a Channel archived only on
`channels` refuses a child; `space-authority.test.ts` proves the same for a Space
archived only on `spaces`, and that a member Channel archived only on
`channels` takes the Queue for a Sidekick default; `scope-invitations.test.ts`
proves a Main invitation names the Channel from `channels`.
`hosted-parent-migration.test.ts` upgrades a populated v70 object and proves
migration 72 carries every directory row into the renamed tables and migration
75 leaves no import ledger behind.
`channel-viewer-state.test.ts` proves a Channel's row on a real workspace
socket: each viewer's own breakouts per Channel, a roster change reaching only
that breakout's members, running agents reaching every reader counted where
each can look, a lost Channel tombstoned while the socket stays open, the
current list after a resubscribe, and Main woken by a foreground. Each case
uses a separate Organization identity: reset alone can interleave with a prior
case's live socket or alarm and leave the reused authority populated. `workspace-socket-fanout.test.ts` proves who else a row
reaches ([`websocket-architecture.md`](websocket-architecture.md#testing)).
`conversation-effect-queue.test.ts` proves directory and activity rows land in
the write and a mention leaves on the Queue; `hosted-parent-outbox.test.ts`
proves the drain's limits, the retry schedule, the `failed` state, the alarm's
phase isolation and that a viewer effect before its Channel row fails its
delivery; `hosted-parent-local-effects.test.ts` proves the all-or-nothing
write, learning an unknown person before the transaction and by retry, and the
follow-up rows. The
conversation-parent contract tests (`conversation-parent-contract.test.ts` and
its neighbours) run against the hosted parent.
`channel-rails.test.ts` proves `channel_rails` answers on a real socket (a
guest's, a large Space's bounded pages, a corrupt stored row's) and the row
pushed with a higher waterline for each trigger family and explicit bump, and
none for a Channel rename or an owned Sidekick's next run;
`channel-rail-migration.test.ts` upgrades a populated v79 object across 80, 81
and 82 in one wake and proves migration 82's defaults and live triggers.
`hosted-sidekick.test.ts` drives a Sidekick through the Organization object's
`sidekick*` surface: publish, a refused registration leaving nothing applied, a
refused memory-table step finishing from its entry, pause and resume, a run
provisioned off the alarm and asked about again until it reports, a pause that
leaves another Sidekick's run armed, a run's terminal deadline, a principal
claim that rebinds a plugin whose connection is gone and unbinds one whose
connection is another member's, and a child effect redelivered with different
bytes refused. `automation-directory.test.ts` lists a Channel's Sidekick to its
participants and reads a batch in the order asked, and `scheduled-alarms.test.ts`
cancels by key prefix only in the kinds named.
`workspace-do-schema.test.ts` proves migration 92 drops the import ledger and
keeps every directory row, and `forced-migration.test.ts` that a queued
migration command for `SidekickDO` or `AutomationDO` is acknowledged rather
than retried.
`workspace-member-status.test.ts` proves which writer may replace a
relationship row (a removed incarnation never returns, a new one replaces it,
an older event does not move a newer revision back) and that the consumer
records a removal even when the revocation walk fails. Run with
`pnpm --filter @rally/api test:workers`.

## Operations

**Deleting the legacy classes cannot be undone.** The wrangler `v12` tag
destroyed every `WorkstreamDO` and `SpaceDO` object with its storage, and `v13`
every `SidekickDO` object, and a
build from before it still binds those classes, so it cannot be deployed
again. Rollback past this change is forward-fix only, as it already was past
migration 72, which renamed the directory tables in the same migration as the
code that uses the new names.

## Performance and cost

The design is bounded by one Durable Object's limits, since every Channel and
Space in an Organization now shares one SQLite database and one socket set.

- **Parent state is small.** Measured in production on 2026-09-25, the busiest
  Channel parent held 4 children, 11 viewer rows and 1,083 state changes. Its
  largest table was the child-effect receipt ledger, which the move did not
  import and which the hosted parent keeps as `parent_child_receipts` with the
  legacy 180-day retention. It is a replay fence for activity and notification
  effects, and those are idempotent downstream too (`workstream_notification_intents`
  is `ON CONFLICT (intent_id) DO NOTHING` and keeps its delivered state;
  activity dedupes on `dedupe_key`), so dropping the ledger is open if it ever
  grows.
- **Connector events, not parents, are what fill the 10 GB object.**
  `workspace_connector_events` grows about 0.26 GB a week in the busiest
  Organization. A full object refuses every write, and since the move that
  includes every Channel and Space parent in the Organization, not only
  connector ingest. Processed rows now age out after 90 days, through the
  alarm's `connector_event_reap` phase, so that Organization holds about
  3.3 GB of them at steady state (90 / 7 × 0.26). Pending, processing and
  failed rows never age out. The retention and its arithmetic are owned by
  [`workstream-durable-object.md`](workstream-durable-object.md);
  `PRAGMA page_count` times `page_size` through `run_workspace_sql` is the
  reading.
- **Sockets.** Cloudflare allows 32,768 hibernatable WebSockets per object. The
  Organization object holds every workspace socket and every Channel control
  socket in its Organization: roughly two per open client window, so about 16,000
  windows open at once in one Organization. Conversation feed sockets are on the
  `SubstreamAgent`s and do not count.

## Open questions

- Retiring the Channel control socket: `/parent-socket`,
  `HostedParent.acceptSocket`/`onSocketMessage`/`broadcastMetadata`'s socket
  loop, `WorkstreamControlSocketService` and `GET /workstreams/:id/control-socket`
  can go once the oldest supported desktop is the one that stopped opening it
  and the iOS client reads its child directory from its workspace socket.
- Spaces created before 2026-09-26 still have an idle hidden conversation
  object. Nothing writes or reads it ([`spaces.md`](spaces.md#the-retired-hidden-conversation));
  deleting those objects is its own decision.

## Changelog

### 2026-10-06 — Hosted Sidekick SQL reads and writes as one object

**What changed:** `HostedSidekick` and the `WorkspaceDO` Sidekick facade answer
each question with one read that joins what it needs, and make each change
with one statement that returns its witness. Connector and resource reads use
`sql.exec` instead of the runtime database adapter, a principal claim reads and
rebinds in one transaction, batch skill reads select every Sidekick in one
statement, and `ScheduledAlarmStore.cancelByKeyPrefix` cancels a Sidekick's
entries in one. The schedule-kind refresh after a Sidekick's registrations
change is gone.

**Why:** The move kept `SidekickDO`'s method shapes, which read the row again
in every helper and reached the Organization's tables through the runtime
database adapter. In one object, each re-read is a statement that buys nothing,
and each adapter call pays a Zod parse, the typed-table guard and sidebar
bookkeeping meant for requests. Every Sidekick in an Organization queues behind
them. The refresh rebuilt the `schedules` table's entries, which no Sidekick
writes: a Sidekick's schedule entries are written in its own transaction.
Reading the bindings and the connections in the claim's own transaction also
closes a gap where a connection could move between the read and the rebind.

**Considered and rejected:** One transaction for every Sidekick a Channel
archive moves: a failure would roll back the others' pauses, so each keeps its
own. Folding the child projection's version check into its upsert: the reuse
warning needs the old version, which an upsert's `RETURNING` does not give.

**Consequences:** A new Sidekick read that needs several rows joins them; a
helper that re-reads the row inside a method that already has it is the
pattern this removed. A read that comes after an `await` is the exception: it
must read again, because another call may have changed the row meanwhile.

Shipped in [#1111](https://github.com/juno-ai-labs/avalon/pull/1111).

### 2026-10-06 — `SidekickDO` and the Sidekick import are deleted

**What changed:** The `SidekickDO` class, its `AUTOMATION_DOS` binding and its
export are gone; Wrangler tag `v13` deletes the class. `WorkspaceDO` loses the
import (`ensureSidekickImported`, the alarm's `sidekick_import` phase,
`retrySidekickImport`, the `sidekick_parent_moved` refusal, and the legacy
directory receiver `applyAutomationDirectory`), and migration 92 drops
`sidekick_imports`. The engineering MCP loses `run_sidekick_sql` and
`retry_sidekick_import`. A late `directory_automation` message is acknowledged
and logged as ignored.

**Why:** This is step 3 of the PRD. Step 2's checks found every Organization at
schema 91 and 46 of 48 Sidekicks imported; the two still pending belong to
retired Organizations, which refuse new work. Keeping the class kept a second
code path for every Sidekick request alive for objects nothing reads.

**Considered and rejected:** Importing the two pending Sidekicks first. Their
Organizations are retired, so an import would move rows nobody can reach.

**Consequences:** The deletion cannot be undone: `v13` destroys every
`SidekickDO` object with its storage, and a build from before this change
binds the class, so it cannot be deployed again. Migration 91 still creates
`sidekick_imports` for a new object, and 92 drops it at once; neither is ever
edited.

### 2026-10-05 — Sidekick parents move into WorkspaceDO

**What changed:** A Sidekick's parent, definition, revisions, schedules, runs,
inbound-email receipts and child registry live in `WorkspaceDO` (migration 91,
`HostedSidekick`), beside Channels and Spaces. `automation_directory` became the
Sidekick's definition row. Each Sidekick moves on first use or on the alarm's
`sidekick_import` phase, from a legacy `SidekickDO` that freezes on export and
otherwise answers `sidekick_parent_moved`. Callers call the Organization's
`sidekick*` methods directly; reads that fanned out per Sidekick are batch
calls; pure reads skip the alarm re-arm; a run's conversation is provisioned on
the activity Queue rather than awaited in the alarm. The engineering MCP gains
`retry_sidekick_import`. `ConversationParentDurableObject` is deleted with its
last subclass's methods.

**Why:** The PRD (`docs/PRDs/2026-10-03_sidekick-parent-into-workspace-do/`)
records the case: a Sidekick's parent was the last parent in its own object,
and every request that touched one paid a cross-object hop and a second copy of
its directory row. Three choices differ from the PRD's design and are
recorded in its decision log: the definition row is `automation_directory`
rather than a new `sidekicks` table, so every reader of the directory keeps
working and a pending Sidekick is served by the row it already had; a Sidekick's
child rows have their own tables, because Channel code scans `parent_*` across
every parent; and `HostedSidekick` is a sibling class, not a `HostedParent`
role. A compatibility client that kept `SidekickDO`'s method names was
written and removed in the same change: it hid that every call landed on one
single-threaded object, which is how per-Sidekick fan-outs survived the move.
Writing the tests found that returning `waitMs` from an entry whose source is
not re-derived drops the entry, so a run's entry is moved later instead.

**Consequences:** Every `sidekick_*` statement names `sidekick_id`, and a
Sidekick's alarm keys start `<id>:`. A caller that needs several Sidekicks uses
a batch method, or adds one, rather than a loop of calls. A Channel-scoped
Sidekick's managers are the Channel's managers, and its viewers the Channel's
participants; collapsing those two rules changes who may act. The legacy class,
its binding, `run_sidekick_sql` and `retry_sidekick_import` are deleted only in
the PRD's step 3, after every Organization has imported, and that deletion
cannot be undone.

### 2026-10-01 — A breakout row says where it branched and when it last moved

**What changed:** `visiblePrivateChildren` joins `parent_breakout_preparations`
and lists each breakout's `originTurnId` (the preparation request's
`sourceThroughTurnId`) and `lastActivityAt` (from its `directory_common`
projection; epoch milliseconds on the RPC, ISO on the workspace-socket row and
control metadata). `readSharedWorkstream` adds `originTurnId` to each Breakout in
the guest navigation, and the navigation's Spaces carry `systemRole`. No
migration: both values were already stored.

**Why:** The desktop and browser redesign draws a breakout's chip under the Main
message it branched from and a tick bar of breakout activity, from the rows they
already hold rather than a read per Channel. The origin was only in the
preparation request, which nothing listed.

**Considered and rejected:** A reply count per breakout: it would need a read of
each breakout's transcript or a new projected counter, and the redesign does not
need it yet. A column for the origin: the preparation row is the one record of
it and is kept for the breakout's life.

**Consequences:** `lastActivityAt` is part of the hashed breakout list, so a
directory effect that moves only a breakout's activity now advances
`children:<user>` and republishes the Channel row to that breakout's members,
where before it changed nothing. The first advance after deploy moves every
list once because the hashed shape grew. A breakout whose preparation row is
gone lists `originTurnId: null`, indistinguishable from one branched through no
turn. `/sharing/navigation` also carries `originTurnId` and a Space's
`systemRole`, but only when the request asks with `shell=1`. Released desktops
parse that response strictly and reject a key they do not know, so for them the
read keeps its old shape; a guest's whole sidebar is this read. A future field
here takes the same route: an opt-in flag, never an unconditional addition.

### 2026-09-28 — A Channel's rail is answered here, and its row says when it moved

**What changed:** `WorkspaceDO` migration 82 adds `channels.rail_waterline`,
`channels.sidekick_attachments_reported`, `channel_sidekick_attachments` and
`channel_rail_changes`, with triggers that advance the waterline for every rail
source whose writers are not already Channel-row writers. `channelRails`
answers the socket's `channel_rails` from local reads. The ledger is drained by
one mechanism: `WorkspaceDO`'s state is wrapped so every write schedules a drain
at the end of its turn. This object reads `sidekickAttachmentIds`; nothing sends
it yet.

**Why:** The desktop paints a Channel's rail from the Organization socket
before the conversation opens, and needs to know when a rail it holds is stale
without polling. The rail's sources are five tables with different writers,
several of which (a recommendation, a Sidekick's directory row, a resource
rename) never republished a Channel row. A trigger per source is the one place
such a write cannot forget, and the first draft showed the drain needed the
same treatment: eight writers each called it and a ninth
(`resolveConnectorResource`) did not. The attachment list is read here before
any SubstreamAgent sends it because `directory_common` is strict: during a
rolling deploy an older consumer would refuse an effect carrying the field and
ack it, losing the whole directory projection.

**Considered and rejected:** A trigger on `workspace_workstream_resource_links`:
it is rewritten on every Main effect, so it is compared in the apply instead.
Hashing the rail on each read: it would need the whole read to learn nothing
moved. A drain call per writer, or an alarm armed by each: both depend on every
writer remembering. A hook after each entry point: a Durable Object has none after
an RPC method returns, and wrapping every method would be the per-writer call
again, one level up. The wrapper chosen
costs a flag check per statement and one microtask per synchronous run that
wrote. A `setTimeout` was tried first and outlived the Node suite's in-memory
databases, draining after a test had closed its own.
Owned Sidekicks keep `next_run_at` and `projected_at` out of the triggers: they
move on every scheduled run, and the rail no longer shows run times, so every
run would have pushed the owning Channel's row to all its readers. A Space
answer pages only Channels this viewer may see, so a Space of hidden Channels
cannot make one request walk all of it, and `nextAfter` is always one they may
see.

**Consequences:** A new rail source must advance the waterline in the write
that changes it (see Invariants); a new writer needs nothing. Operator SQL
through `runInspectionSql` bypasses the wrapper, so its rail changes wait for the
next write. The owned list is ordered by `projected_at`, which no longer
advances the waterline, so its order can be as old as the rail. The
personal-Sidekick audience reads the directory's `run_as_user_id`, which is null
until the Sidekick next publishes; until then only the author counts. Every
Main's rail omits `attached` until SubstreamAgent emits the list, in a later
deploy ([`workstream-durable-object.md`](workstream-durable-object.md)).
Channels upgraded by this migration start at waterline 0.

### 2026-09-26 — `parent_metadata` holds identity only

**What changed:** `WorkspaceDO` migration 79 rebuilds `parent_metadata` down to
`parent_id`, `parent_kind`, `workspace_id`, `region`, `authority_generation`,
`revision`, `created_at` and `updated_at`, dropping the 19 presentation columns
`channels` holds. A Main common effect now only advances the identity row's
revision; the provisional reservation and a child's placeholder insert identity
only. A Space's parent reads the columns `spaces` lacks as the values a Space
has (untitled description, `idle`, no schedule), and a parent with no directory
row reads constants with scope `personal`. `forwardChildTerminalDeadline` drops
its own compare and publishes through `enqueueProjection`, whose payload-hash
check already skips an unchanged deadline.

**Why:** The previous change moved every read to the directory row, so the
columns were a second copy written on every Main effect and read by nothing.
Nothing references the table, so a plain create-copy-drop-rename keeps every
row with foreign keys enforced.

**Considered and rejected:** Reconciling `channels` from `parent_metadata`
first. The 2026-09-26 audit found the two identical for every Channel, and
where they differed (the two archived Spaces) the directory row was right.
Keeping `next_terminal_action_at` as bookkeeping: the projection's hash check
already answers "did this change". Keeping the placeholder's `workspace` scope:
a parent nothing has described now fails closed.

**Consequences:** Irreversible: a build before this one reads columns that no
longer exist, so it cannot be redeployed over an upgraded object. A fixture
that seeds a parent inserts identity into `parent_metadata` and presentation
into `channels` or `spaces`.

### 2026-09-26 — A parent reads its presentation from its directory row

**What changed:** `HostedParent.metadataRow()` reads a Channel's presentation
from `channels`, and a Space's title, scope and archive state from `spaces`,
with identity from `parent_metadata`; one query per kind. Before a directory
row exists it reads `parent_metadata` alone. The invitation title and the
in-place Sidekick default read `channels` directly.
`forwardChildTerminalDeadline` keeps its own column, a change-detection check
against the parent's bookkeeping.

**Why:** Two copies of a Channel's scope, archive state and title meant the
parent's own gates (child reservation, management access, viewer admission)
could disagree with every sidebar and search reader, which already trusts the
directory row. A read-only audit of all 20 Organizations on 2026-09-26 found
the copies identical on all 19 columns for every Channel. The only difference
was the two archived Spaces: `parent_metadata` never recorded their archive,
because a Space's archive is WorkspaceDO's own write. Reading `spaces` makes a
Space's parent agree with it.

**Considered and rejected:** Rewriting each of the ~30 readers to name the
table it wants: changing `metadataRow()` keeps every reader unchanged, at one
statement of primary-key lookups. A `COALESCE` fallback: `archived_at` and the
other optional columns are NULL on purpose, so the fallback keys on whether the
directory row exists. Dropping the columns in the same change: the read switch
is reversible on its own, the migration is not, so they ship apart.

**Consequences:** An archived Space's parent now reports `archived` and is not
writable, refuses a child, and on its next child effect runs the archived
parent's stop loop over its children; a Space hosts no loop, so that stops
nothing. A test or tool that changes a parent's scope or archive state by
writing `parent_metadata` now changes nothing a parent reads. Dropping the
columns waits on the three readers the open question names.

### 2026-09-26 — The legacy parent classes and the import are deleted

**What changed:** Every live Organization had imported every Channel and Space
parent, so `WorkstreamDO` and `SpaceDO` are deleted with the wrangler `v12`
`deleted_classes` tag, and with them the import: the request-path and alarm
import, `retryParentImport`, the `parent_imports` guards in the Channel row,
revocation, authorization-discovery and Sidekick-default reads, and the
engineering MCP's `retry_parent_import`, `run_workstream_sql` and
`run_space_sql`. `WorkspaceDO` migration 75 drops the ledger. The migration
tracker and the forced-migration consumer no longer name either class.

**Why:** After the imports finished, the legacy classes answered only the
export, and every hosted-parent request still read the ledger before it was
served. Leaving a class bound keeps its namespace, and every object in it,
alive for good, and parks those objects in the tracker's `unreported` count.
The deletion was gated on the runbook's check, run across all 20 Organizations:
each at schema 72 or later, and no `pending` row outside the six retired demo
Organizations, whose rows were residue because retirement had dropped their
imports.

**Considered and rejected:** Keeping the ledger table with nothing reading it.
Dropping it costs one migration and removes the last trace of a mechanism that
cannot run again.

**Consequences:** The deletion is irreversible and a build from before it cannot
be deployed again. A child or directory effect for a parent id with no row no
longer queues an import; the parent is served as one this object does not host,
the state an empty import used to leave. The outbox drain lost its single-flight
guard, which existed only for a request's import draining beside the alarm:
the alarm is now the only drain. A change that drains the outbox from a request
again has to claim rows or bring the guard back, or the two drains will send
the same rows twice.

### 2026-09-25 — Channel and Space parents move into WorkspaceDO

**What changed:** Every `WorkstreamDO` and `SpaceDO` responsibility now runs
inside the Organization's `WorkspaceDO`, keyed by parent id. The directory
tables took the product's names (`channels`, `channel_viewers`, `breakouts`,
`breakout_viewers`, `spaces`, `space_viewers`). The legacy objects are reduced
to a one-time export, and each is imported on first touch or by the alarm.

**Why:** The parent objects were the middle layer of `WorkspaceDO →
WorkstreamDO → SubstreamAgent`, and almost every one of their facts either came
from the Organization or was copied back into it. Every conversation request
paid two sequential calls to the parent (`authority`, then `authorizeViewer`),
often against a cold object that then woke its main conversation. Sidebar state
crossed two Queue hops (conversation → Queue → parent → Queue → `WorkspaceDO`,
which kept a second copy). Moving a Space's audience onto its Channels took four
cross-object awaits per Channel, staged intents, a resume loop and
apply/confirm/retract fences, because the Space membership and each Channel's
audience provenance lived in different objects. A Space was a Channel with
every product surface switched off, replaying the whole Channel migration
ledger for four methods. And kind was found by probing: `resolveParent` asked
`WorkstreamDO` first and the authorization projection asked `SpaceDO` first,
creating and migrating an empty object each time. The small-object design was
meant to protect transcripts, which stay in their own objects; the busiest
Channel parent in production held 4 children, 11 viewer rows and 1,083 state
changes.

**Considered and rejected:** Folding each Channel parent into its own main
conversation instead. It removes the same parent round trip but leaves Space
changes as cross-object sagas, since the Space membership and the Channel
audience would still live in different objects. Zero-downtime dual writes for
the move were rejected for the per-parent export: a parent is frozen for one
RPC, which is cheaper to build and to verify. For a failed import, a backoff
the request path waited out (5 s doubling to 300 s) was rejected: it was a new
limit nobody owned, and it made the person who opened the Channel wait for a
schedule meant for background retries. A request retries at once; only the
alarm backs off, on the shared `scheduledAlarmRetryDelay`. A frozen legacy
object whose import fails the same way every time is repaired by an operator
and retried with `retry_parent_import`, rather than importing what fits and
skipping the rest, which would lose rows silently.

A parent's published effects land in its own transaction, all or nothing, and
`parent_outbox` keeps only work that leaves the object. An earlier cut of this
change applied each effect in its own savepoint and parked any that threw in
the outbox, with deferral, member-resolution and release machinery around it,
and one unparseable row there stopped every write in the Organization. Failing
the write instead lets the Queue's redelivery or the caller see the failure;
unknown people are learned before the transaction or by one retry.

**Consequences:** The Organization object now answers every Channel viewer
check, so its handlers have to stay short. A hosted-parent write has to go
through `parentWrite` or `withMembersLearned`, and a local apply that can fail
fails the write. The legacy parent warmed a Channel's
Main conversation whenever it woke; the Organization object is rarely asleep,
so it now warms Main when a reader brings the Channel to the foreground. Access
checks read the object's own relationship table, so a removal is applied there
before its revocation walk, and a request's own D1 answer replaces a row only
when provably newer (a guest invited again after removal would otherwise be
refused until the next event). The legacy classes stay deployed until every
Organization has imported. The change ships only at 100% and rolls back only
forward (see [Operations](#operations)), and connector-event retention becomes
a precondition of the Organization object's storage budget (see
[Performance and cost](#performance-and-cost)).

With the Channel control socket and the workspace socket landing in the same
object, the control socket was retired in the same change: what it added to
the Channel's row (the viewer's breakouts and the running background agents)
now rides the row on the workspace socket, so a desktop holds one feed per
Channel and no second socket. Per-Channel subscriptions on the workspace socket
were considered and rejected: the row already reaches every reader, and the
added fields are a few breakouts per viewer that change when breakouts are
created, archived or rejoined, and agent counts that change when a run starts
or ends. The control socket stays served for released desktops and iOS until
they stop opening it.
