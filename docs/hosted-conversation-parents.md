# Hosted conversation parents

A **Channel** and a **Space** are conversation parents: each owns who may read
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

The conversations themselves do not move. Every Channel main conversation, every
breakout, every Sidekick run and every Space's hidden conversation is still a
`SubstreamAgent`: a transcript and an agent loop are a real concurrency and size
boundary, and they stay one object each. `SidekickDO` is also unchanged; it
keeps its own parent object ([`automation-lifecycle.md`](automation-lifecycle.md)).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/hosted-parent.ts` | `HostedParent`: one Channel's or Space's parent authority, scoped to a `parent_id` inside `WorkspaceDO`'s SQLite. The port of what `WorkstreamDO` and `ConversationParentDurableObject` did for one object. Also the batch readers for what a Channel row adds per viewer (`visiblePrivateChildren`, `runningBackgroundAgents`, `channelViewerStates`). |
| `apps/api/src/durable-objects/hosted-parent-schema.ts` | `WorkspaceDO` migration 72: the `parent_*` tables and the directory renames. |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPC facade: every conversation-parent method now answers here, dispatching to `HostedParent` for its `parentId`. Also the Channel rows on the workspace socket (with each viewer's breakouts and running background agents), the retired Channel control socket kept for older clients, the in-transaction apply of what a parent publishes, the outbox drain, and the workspace relationship table. |
| `apps/api/src/durable-objects/scope-grant-storage.ts`, `scope-invitation-storage.ts`, `scope-invitation-service.ts`, `workstream-access-storage.ts` | The grant, invitation and Space-provenance repositories, now scoped by `parent_id`. |
| `apps/api/src/services/conversation-parent-client.ts` | `conversationParentStub`: `WorkspaceDO` for a Channel or a Space, `SidekickDO` for a Sidekick. |
| `apps/api/src/queues/activity-consumer.ts` | A `conversation_effect` for a Channel or a Space goes to `WorkspaceDO.receiveChildEffects`. |

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
| `workstream_direct_audience`, `workstream_space_access_sources`, `workstream_space_supplied_readers`, `workstream_access_operations` | `parent_direct_audience`, `parent_space_sources`, `parent_space_readers`, `parent_access_operations` |
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

## Invariants

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
- **Parent-kind is carried, never probed.** A lookup that tries a namespace to
  see whether something is there creates the object it asked about.

## Boundary

This module owns Channel and Space parent state inside `WorkspaceDO`, what a
Channel's workspace-socket row carries for each viewer, and the retired Channel
control socket. It does not own
the conversations ([`workstream-durable-object.md`](workstream-durable-object.md)),
Space membership, ordering and defaults ([`spaces.md`](spaces.md)), the grant
directory ([`scope-grant-directory.md`](scope-grant-directory.md)), invitations
([`scope-invitations.md`](scope-invitations.md)) or Sidekick parents
([`automation-lifecycle.md`](automation-lifecycle.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| A local apply fails inside a parent write (a viewer row before its Channel row, a constraint, a schema rejection) | The parent transaction rolls back. A child's delivery throws and the Queue redelivers it; a request fails with the error. Nothing is left in the outbox. |
| A write meets somebody the member table has never heard of | The transaction rolls back with `workspace_member_unknown`; the ids are learned with one D1 read each and the write runs once more. A second miss fails the write with that code. |
| A `parent_outbox` send fails | The row stays `pending`, with its code in `last_error_code`, and is due again on the alarm's retry schedule. `parent_effect_delivery_deferred` names the rows. |
| A `parent_outbox` or `workspace_directory_followups` row does not parse (a follow-up row in the shape written before #989 is one), or an outbox row's destination refuses its shape | It is kept as `failed` with a `zodDiagnosticCode` naming the field, logged (`parent_outbox_row_unreadable`, `directory_followup_unreadable`), and never retried. An operator reads it with `run_workspace_sql` and deletes or repairs it. |
| A directory row is found in `parent_outbox` | It is kept as `failed` with `parent_outbox_directory_row` and not applied. Directory rows apply in the parent's own transaction, so nothing writes one there. |
| One alarm phase throws | `workspace_alarm_phase_failed` names the phase; the other phases still run, and the alarm then fails and retries. |
| An Organization held below schema 58 by the meeting-notes cleanup | Migration 72 has not run, so there are no `channels` or `parent_*` tables and every Channel request fails with `no such table`. The object itself still starts and its alarm skips the hosted-parent phases, so the operator retirement RPCs can finish it. Every production object was at schema 70 before this change, so none should be held; the error is loud if one is. |
| The Organization object is unavailable | Channels and Spaces cannot be opened, listed or changed. That was already true of the sidebar; it is now true of a Channel's viewer check too. |

## Testing

`hosted-parent-migration.test.ts` upgrades a populated v70 object and proves
migration 72 carries every directory row into the renamed tables and migration
75 leaves no import ledger behind.
`channel-viewer-state.test.ts` proves a Channel's row on a real workspace
socket: each viewer's own breakouts per Channel, a roster change reaching only
that breakout's members, running agents reaching every reader counted where
each can look, a lost Channel tombstoned while the socket stays open, the
current list after a resubscribe, and Main woken by a foreground. `workspace-socket-fanout.test.ts` proves who else a row
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
`workspace-member-status.test.ts` proves which writer may replace a
relationship row (a removed incarnation never returns, a new one replaces it,
an older event does not move a newer revision back) and that the consumer
records a removal even when the revocation walk fails. Run with
`pnpm --filter @rally/api test:workers`.

## Operations

**Deleting the legacy classes cannot be undone.** The wrangler `v12` tag
destroyed every `WorkstreamDO` and `SpaceDO` object with its storage, and a
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
- A Space's hidden conversation still holds its participants and resources.
  Moving them into `spaces` is the next step, and removes a `SubstreamAgent` per
  Space.
- `parent_metadata` and `channels` still hold the same presentation columns.
  Both are written in the parent's one transaction (the directory apply runs
  inside it through `applyLocalEffects`), but they are two copies of the same
  values under different write rules. Folding them into one row is follow-up
  work.

## Changelog

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
