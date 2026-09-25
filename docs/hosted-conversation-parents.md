# Hosted conversation parents

A **Channel** and a **Space** are conversation parents: each owns who may read
its conversations, its breakout registry, its grants, invitations and Space
access provenance, and the per-viewer state the sidebar and the Channel control
socket draw. Until this change each parent was its own Durable Object
(`WorkstreamDO`, and `SpaceDO`, which was `WorkstreamDO` under a role). This
document owns how that state now lives inside the Organization's `WorkspaceDO`,
keyed by parent id, and how existing objects were moved there.

The conversations themselves do not move. Every Channel main conversation, every
breakout, every Sidekick run and every Space's hidden conversation is still a
`SubstreamAgent`: a transcript and an agent loop are a real concurrency and size
boundary, and they stay one object each. `SidekickDO` is also unchanged; it
keeps its own parent object ([`automation-lifecycle.md`](automation-lifecycle.md)).

## Why

The parent objects were the middle layer of `WorkspaceDO → WorkstreamDO →
SubstreamAgent`, and almost every one of their facts either came from the
Organization or was copied back into it:

- **Every conversation request paid two sequential calls to the parent**
  (`authority`, then `authorizeViewer`) before reaching the conversation, often
  against a cold object that then woke its main conversation.
- **Sidebar state crossed two Queue hops.** A conversation's projection went
  conversation → Queue → parent (outbox, receipts, waterline fences) → Queue →
  `WorkspaceDO`, which kept a second copy in its directory.
- **Space changes were cross-object sagas.** Moving a Space's audience onto its
  Channels took four cross-object awaits per Channel, staged intents, a resume
  loop, and apply/confirm/retract fences, because the Space membership lived in
  `WorkspaceDO` and each Channel's audience provenance lived in its own object.
- **A Space was a Channel with every product surface switched off**, replaying
  the whole Channel migration ledger for four methods it used.
- **Kind was found by probing.** `resolveParent` asked `WorkstreamDO` first, and
  the authorization projection asked `SpaceDO` first under every Channel id,
  creating and migrating an empty object each time.

The size argument that justified small objects applies to transcripts, which
stay in `SubstreamAgent`. Measured in production on 2026-09-25, the busiest
Channel parent held 4 children, 11 viewer rows and 1,083 state changes; its
only large table was the Queue receipt ledger this change removes. What does
threaten the 10 GB object limit is `workspace_connector_events` (about 2.1 GB in
eight weeks in one Organization), which is unrelated to this change and tracked
separately.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/hosted-parent.ts` | `HostedParent`: one Channel's or Space's parent authority, scoped to a `parent_id` inside `WorkspaceDO`'s SQLite. The port of what `WorkstreamDO` and `ConversationParentDurableObject` did for one object. |
| `apps/api/src/durable-objects/hosted-parent-schema.ts` | `WorkspaceDO` migration 72: the `parent_*` tables, the directory renames, and the seeded import ledger. |
| `apps/api/src/durable-objects/hosted-parent-import.ts` | Moving one legacy object's rows into the hosted tables, and the ledger that says which parents still need it. |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPC facade: every conversation-parent method now answers here, dispatching to `HostedParent` for its `parentId`. Also the Channel control socket, the in-transaction apply of what a parent publishes, the outbox drain, and the workspace relationship table. |
| `apps/api/src/durable-objects/workstream-do.ts`, `space-do.ts` | **Legacy.** Kept deployed only so existing objects can be exported. Everything but `exportParentState`, the receive-forward, and fleet operations is gone. |
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

Each envelope is applied in its own savepoint, so one that throws is rolled
back alone and the parent change still commits. The sends that follow a
directory change (socket publishes, Space snapshots, schedule refresh, watch
reconciliation, archival notices to owned Sidekicks) cannot run inside a
transaction. They are recorded as a `workspace_directory_followups` row in the
same transaction, run straight after the commit, and taken by the alarm's
`directory_followup` phase if that run did not finish.

### The outbox is the fallback

`parent_outbox` now holds only what could not land in the transaction or has
to leave the object:

- a viewer row for someone the member table has never heard of (the drain
  learns their relationship with one D1 read, then applies it);
- a row whose apply threw, such as a viewer row whose Channel row is not there
  yet (made due again the moment that Channel row lands);
- a notification to deliver and a mention to snapshot, which the activity
  Queue's consumer does in a Worker (its apply is a replay: the record is
  already here);
- a revoked Channel grant, whose Sidekick revocation is a Queue send.

The drain keeps the legacy drain's limits: directory rows are applied at most
`MAX_DIRECTORY_APPLY_ENVELOPES` at a time, Queue rows go in `sendBatch` calls
under the Queue's per-call size, and a single row too large for one Queue
message is deleted with a `parent_effect_oversized` warning. One drain runs at
a time, so a drain started by a request's import and one started by the alarm
cannot send the same rows.

### Workspace relationships are local

`workspace_member_status` holds each person's workspace relationship
(incarnation, revision, access class, role, status) as this object last heard
it. The relationship change events keep it current: the relationship consumer
calls `WorkspaceDO.applyMemberStatus` in D1's sequence order, and someone who
stops being an active member leaves every viewer directory in that
transaction. `readRelationship` answers access checks, Space checks and the
directory's member filter from it; D1 is read once, for someone it has never
heard of (a member from before the table existed), and that answer never
replaces an event's. The team accepts up to five minutes between a D1 change
and this table and chose to trust the events rather than re-read on a timer. A
request that has just written a relationship to D1 (accepting an invitation)
records it here itself, so its own next checks see it.

### Moving an existing parent

Migration 72 seeds `parent_imports` with one `pending` row for every Channel and
Space the Organization's directory already held. A legacy parent effect for an
id the ledger does not know (from a legacy object that was mid-delivery at
deploy) adds a `pending` row too, and so does a child effect for a parent with
no row: every parent created in `WorkspaceDO` has its row before its first child
effect, so such an effect names a Channel whose provisional directory row never
arrived before the move, and creating an empty row would lose what its legacy
object holds. An id no legacy object holds imports empty, once.

Importing one parent:

1. `WorkspaceDO` calls `exportParentState` on the legacy object. The legacy
   object marks itself moved and returns every row, in one transaction. From
   then on it refuses everything except export (idempotent: a second export
   returns the same frozen rows) and forwards any child effect it is handed to
   `WorkspaceDO`.
2. `WorkspaceDO` inserts the rows under the parent id and marks the ledger row
   `imported`, in one transaction. Pending outbox rows come with it and are
   drained locally.

This is the write freeze: one parent at a time, for the length of one RPC. A
request for a `pending` parent imports it before it is served. The alarm also
imports pending parents in pages, last in its run so a page of cold legacy
calls does not hold up the rest of its work, and an Organization converges
without anyone opening anything. A failed import, before or after the export,
records its code and backs off; a request that arrives during the backoff fails
with `parent_import_unavailable` and that code rather than asking the legacy
object again. Child-effect receipts are not imported: a replay older than
the import converges on the per-key waterlines, which is the rule the legacy
receipts already fell back to past their retention.

## Invariants

- **Every hosted table leads with `parent_id`, and every statement names it.**
  A statement without it reads or writes every Channel in the Organization; the
  worst case is `claimReaderAsDirect`, which deletes a reader's Space
  attribution and would do so across every Channel.
- **A parent is imported before anything reads its hosted rows.** Serving a
  `pending` parent from empty tables would answer "not found" for a Channel
  that exists, and a write would create rows the import then collides with.
- **The legacy object answers nothing after export but export.** A write that
  landed there after the rows were copied would be lost silently.
- **What a parent publishes commits with the parent change.** The directory,
  grant directory, activity and notification rows are applied in its
  transaction; anything that cannot be (a follow-up send, a row that has to
  wait, work that leaves the object) is recorded durably in that same
  transaction, as a follow-up row or an outbox row.
- **An event's relationship is never replaced by a D1 read.** Events carry D1's
  sequence; a D1 read is only for someone never heard of.
- **Parent-kind is carried, never probed.** A lookup that tries a namespace to
  see whether something is there creates the object it asked about.

## Boundary

This module owns Channel and Space parent state inside `WorkspaceDO`, the
Channel control socket, and the move out of the legacy objects. It does not own
the conversations ([`workstream-durable-object.md`](workstream-durable-object.md)),
Space membership, ordering and defaults ([`spaces.md`](spaces.md)), the grant
directory ([`scope-grant-directory.md`](scope-grant-directory.md)), invitations
([`scope-invitations.md`](scope-invitations.md)) or Sidekick parents
([`automation-lifecycle.md`](automation-lifecycle.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| The legacy object cannot be reached during an import | The request that needed the parent fails with `parent_import_unavailable`; the ledger row stays `pending` and the next request or alarm retries it. |
| A legacy object that was never created (an id the directory knew but no object held) | Its export returns no metadata; the parent is marked `imported` empty. |
| The directory apply fails after a parent commit | The `parent_outbox` row stays and the alarm reapplies it; the apply is idempotent on generation, waterline and payload hash. |
| A Queue message addressed to the legacy object arrives after export | The legacy object forwards it to `WorkspaceDO`. |
| An Organization held below schema 58 by the meeting-notes cleanup | Migration 72 has not run, so there are no `channels` or `parent_*` tables and every Channel request fails with `no such table`. The object itself still starts and its alarm skips the hosted-parent phases, so the operator retirement RPCs can finish it. Every production object was at schema 70 before this change, so none should be held; the error is loud if one is. |
| The Organization object is unavailable | Channels and Spaces cannot be opened, listed or changed. That was already true of the sidebar; it is now true of a Channel's viewer check too. |

## Testing

`apps/api/test-workers/hosted-parent-import.test.ts` seeds a legacy
`WorkstreamDO` with its own migration ledger and rows, then proves on real
workerd that the first request to the Organization object imports it, that the
legacy object is frozen and answers 410, and that a parent whose legacy object
never existed closes its ledger row without creating that object. A Space uses
the same code with a different namespace and is not covered separately.
`conversation-effect-queue.test.ts` proves the outbox drain: directory rows
applied in the object, activity and notification rows sent to the Queue. The
conversation-parent contract tests (`conversation-parent-contract.test.ts` and
its neighbours) run against the hosted parent. Run with
`pnpm --filter @rally/api test:workers`.

## Open questions

- Retiring the legacy classes: once every Organization reports no `pending`
  row, a follow-up change deletes `WorkstreamDO` and `SpaceDO` with a
  `deleted_classes` migration.
- A Space's hidden conversation still holds its participants and resources.
  Moving them into `spaces` is the next step, and removes a `SubstreamAgent` per
  Space.
- `parent_metadata` and `channels` still hold the same presentation columns,
  written back to back rather than in one transaction. Folding them into one
  row is follow-up work.

## Changelog

### 2026-09-25 — Channel and Space parents move into WorkspaceDO

**What changed:** Every `WorkstreamDO` and `SpaceDO` responsibility now runs
inside the Organization's `WorkspaceDO`, keyed by parent id. The directory
tables took the product's names (`channels`, `channel_viewers`, `breakouts`,
`breakout_viewers`, `spaces`, `space_viewers`). The legacy objects are reduced
to a one-time export, and each is imported on first touch or by the alarm.

**Why:** The parent objects were a middle layer whose facts mostly came from or
went back to the Organization. It cost two sequential calls on every
conversation request, two Queue hops on every sidebar update, and staged
cross-object sagas on every Space change, and the Space object was a Channel
object with its features switched off. The small-object design was meant to
protect transcripts, which stay in their own objects.

**Considered and rejected:** Folding each Channel parent into its own main
conversation instead. It removes the same parent round trip but leaves Space
changes as cross-object sagas, since the Space membership and the Channel
audience would still live in different objects. Zero-downtime dual writes for
the move were rejected for the per-parent export: a parent is frozen for one
RPC, which is cheaper to build and to verify.

**Consequences:** The Organization object now answers every Channel viewer
check, so its handlers have to stay short. The Channel control socket is served
by the Organization object, which is also where it is revoked. The legacy
parent warmed a Channel's Main conversation whenever it woke; the Organization
object is rarely asleep, so it now warms Main when a Channel control socket
opens instead. The legacy
classes stay deployed until every Organization has imported.
