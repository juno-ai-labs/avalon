# Hosted conversation parents

A **Sidekick** and a **Canvas** are conversation parents. Each owns who may read
its conversations, the registry of its children, the effects those children
report and each reader's read of its shared conversation (`"0"`). That state
lives inside the Organization's `WorkspaceDO`, keyed by parent id, in the same
SQLite database as the directory row it describes, so a conversation request
asks one warm object. This document owns that hosting: the one primitive both
kinds extend, the conversation-parent contract `WorkspaceDO` answers for them,
and what it answers for an id it does not host.

A Channel, a Space and a Thread were conversation parents too, hosted by
`HostedParent`. The Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) removed them, and plan
step C-2 deleted `HostedParent` and everything that served it
([Retired: the Channel and Space host](#retired-the-channel-and-space-host)).

The conversations themselves are not hosted here. Every Canvas chat and every
Sidekick run is an `AgentLoopDO`: a transcript and an agent loop are a real
concurrency and size boundary, and they stay one object each
([`workstream-durable-object.md`](workstream-durable-object.md)). What a
Sidekick does, and who may do it, is
[`automation-lifecycle.md`](automation-lifecycle.md)'s; what a Canvas is, is
[`canvases.md`](canvases.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/hosted-conversation.ts` | `HostedConversation`: the parent contract both kinds share (authority, the viewer check, child reservation, children's effects and receipts, terminal deadlines, retirement's child list, each reader's read of `"0"`), over the four tables keyed by parent id. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | `HostedSidekick`: one Sidekick's parent and lifecycle. Also `sidekickReaderAllows`, the read rule the library listing shares. |
| `apps/api/src/durable-objects/hosted-canvas.ts`, `canvas-schema.ts` | `HostedCanvas`: one Canvas's parent, and its `canvas_directory` and audience tables. |
| `apps/api/src/durable-objects/hosted-sidekick-schema.ts` | `WorkspaceDO` migrations 91, 132, 135 and 136: the definition columns on `automation_directory` and the `sidekick_*` tables. |
| `apps/api/src/durable-objects/sidekick-directory-sql.ts` | The sidebar's Sidekick audience and viewer SQL and the stored-appearance parse. |
| `apps/api/src/durable-objects/hosted-parent-schema.ts` | `WorkspaceDO` migration 72, kept because the migration list spreads it. Its `parent_*` tables hold retired Channel and Space rows, which the Thread retirement's inventory reads; migration 147 left them for that reason. |
| `apps/api/src/durable-objects/scope-grant-storage.ts`, `scope-invitation-storage.ts`, `scope-invitation-service.ts` | The grant and invitation repositories a Canvas share uses, scoped by `parent_id`. |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPC facade: every conversation-parent method answers here, through `hostedConversationParent`, which resolves a Sidekick or a Canvas. |
| `apps/api/src/services/sidekick-run-provisioning.ts` | `provisionSidekickRun`: the Queue consumer step that opens a run's conversation and starts its loop, off the Organization's alarm. |
| `apps/api/src/services/conversation-parent-client.ts` | `hostedParentStub` and `conversationParentStub`: `WorkspaceDO` for every parent. |
| `apps/api/src/queues/activity-consumer.ts` | A `conversation_effect` goes to `WorkspaceDO.receiveChildEffects`, and each notification intent it names is delivered with `processWorkstreamNotificationIntent`; a `sidekick_run_provision` message to `provisionSidekickRun`; a `sidekick_review` message to `deliverSidekickReview`. |
| `apps/api/src/durable-objects/workspace-notification-intent-storage.ts` | `recordPersonNotificationIntent`: the intent row a mention or an add becomes, written in the envelope's transaction. Delivery is owned by [`push-notifications.md`](push-notifications.md). |

## How it works

### One primitive, two kinds

`HostedConversation` is constructed per call with the Organization's storage
and the parent's id. A kind implements `identity`, `assertParent`,
`admitsViewer`, `onViewerReadChanged` and `onChildProjection`; everything else
in the contract is the base class's. Its tables (`sidekick_children`,
`sidekick_child_projections`, `sidekick_child_receipts`,
`sidekick_viewer_reads`) hold either kind, keyed by the parent id in the column
still called `sidekick_id`.

### An id the Organization does not host

`hostedConversationParent` resolves a Sidekick or a Canvas and nothing else. A
retired Thread's or Space's id, or one never created, gets an answer rather
than a probe of some other object:

| Contract method | Answer for an unhosted id |
| --- | --- |
| `authority`, `resolveHostedParent` | `{ exists: false, authorityGeneration: 0, archived: false }` |
| `authorizeViewer` | `{ authorized: false, archived: false }` |
| `reserveChild`, `reserveAgentChild` | 404 `conversation_parent_not_found` |
| `listChildren`, `childTerminalDeadlines`, `listAuthorizationChildren` | Empty |
| `childrenForRetirement` | `{ status: "missing" }` |
| `receiveChildEffects` naming a `workstream` or `space` parent | 409 `conversation_parent_kind_retired`, diagnostic `conversation_parent_kind_retired:<kind>` |

The effect refusal is loud on purpose: B-7 retired every Thread and Space
conversation, so an effect from one is a defect to find, not traffic to drop.

### Sharing a Canvas

Scope invitations and grants are Canvas-only. `createScopeInvitations` and
`revokeScopeInvitation` require a Canvas parent; `claimScopeInvitations`
answers `[]` for any other id. The invitation index and delivery alarms run for
Canvases ([`scope-invitations.md`](scope-invitations.md)).

### A mention or an add

A conversation tells its parent that somebody was mentioned, or added, with a
`mention_notification` or `participant_notification` effect, one per person.
`applyChildEnvelope` records each as a `pending` row of
`workstream_notification_intents` (`recordPersonNotificationIntent`) in the
transaction that writes the envelope's receipt, and `receiveChildEffects`
names the intent back in `notificationIntentIds`. The activity consumer then
delivers it with `processWorkstreamNotificationIntent`, which decides at that
moment whether the person is still a member, may still open the Canvas or
Sidekick, and is not the author, and queues the notice for each sink they
chose, push or email ([`push-notifications.md`](push-notifications.md#sinks)). Recording asks none of
those questions, so a removal between the message and the delivery is still
honoured.

A redelivered envelope is answered by its receipt and names its intent again:
the Queue's retry is what gives a delivery that failed after the record its
second attempt, and the intent's own state keeps a settled one from sending
twice. A mention is identified by its message and recipient, an add by its
source and recipient, so a re-emission under a new message id converges on the
one row; the same identity under another intent id or other bytes is refused
as `notification_intent_identity_conflict`. Both kinds of parent record them,
for any conversation under them. The same transaction writes the recipient's
Activity row ([`activity.md`](activity.md)) and tells the host
(`noteActivityChanged`), which sends that person their list after the write;
every accepted read report tells it too (`noteActivityReadMoved`), since a read
is what clears a row.

### A reply

A person's message in the shared conversation (`"0"`) arrives as one
`new_message_notification` effect naming everyone else in the conversation
to tell. `applyChildEnvelope` adds it, in the receipt's transaction, to the
parent's open `reply_batch` alarm entry (`addToReplyBatch`); the parent's
host needs its alarm store for that (`HostedConversationHost.alarms`). The
entry is the Organization object's, not the parent's: `WorkspaceDO` runs it
(`sendReplyBatch`), which records the intents and Activity rows and enqueues
the pushes. A redelivered envelope is answered by its receipt and adds
nothing, so a reply joins one batch once. The batching rule is
[`push-notifications.md`](push-notifications.md#a-persons-reply)'s.

### A Sidekick

`HostedSidekick` is constructed per call with the Organization's storage and
the Sidekick's id, and extends `HostedConversation` with a Sidekick's
lifecycle: drafts, revisions, schedules, runs and inbound email.

| Legacy `SidekickDO` table | Hosted |
| --- | --- |
| `automation` (`id = 1`) | `automation_directory`, which gains the definition columns: the sidebar row and the definition row are one row, so there is no copy to publish |
| `definition_revisions`, `schedules`, `runs`, `inbound_email_receipts` | `sidekick_revisions`, `sidekick_schedules`, `sidekick_runs`, `sidekick_email_receipts` |
| `conversation_children`, `substream_directory`, `child_effect_receipts` | `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts` |
| `_internal_durable_alarms` | the Organization's own, keyed `<sidekickId>:<key>`; `sidekick_publication` became `sidekick_memory_tables` |
| `durable_outbox` | none: the directory row is written in place |

Declared execution tables share the activation transaction; [Sidekick publication](automation-lifecycle.md) owns its atomicity and legacy recovery contract.

The facade answers each Sidekick method as `sidekick*` (`sidekickPause`,
`sidekickRunNow`) and the parent contract under the shared names. Callers hold the Organization's
stub and call it directly. Three rules keep it fast:

- **A read does no write's work.** A write (`sidekickCall`) publishes the
  sidebar if the row moved and re-arms the alarm once, after the Sidekick's
  own code; a read (`sidekickRead`) does neither. A run reads its state before
  every provider write.
- **Several Sidekicks are one call.** Every Sidekick in an Organization is
  answered by this one object, which runs one request at a time, so a caller
  that fanned out one call per Sidekick now queues them behind each other.
  `sidekickReadSkillSummaries`, `sidekickReadSkillSources` and
  `sidekickReadDetails` take a list of ids or every loadable Sidekick, and
  answer from local rows. Resolving a run's skills is one call on the common path, and the
  summaries and sources are one statement inside it: `selectSidekickRows`
  picks and orders the Sidekicks and joins each one's accepted revision, and
  the pure `skillSummary` and `skillSource` decide each row.
- **One read per question, one statement per change.** A question that needs
  several of a Sidekick's rows joins them (`runView`, `withAccepted`), and a
  change writes with a returned witness (`UPDATE ... RETURNING`, an upsert's
  returned row) rather than reading first.
- **A check rides the write it guards.** An external event is admitted in one
  call, whose unjudged refusal carries the written conditions for the
  classifier, so only a gated event costs a second.

A run's conversation is opened off the alarm: the run's entry registers its
child and sends a `sidekick_run_provision` message, whose consumer bootstraps
the conversation, starts its loop and reports `sidekickRunProvisioned`. The
entry is moved later after each send, since the drain deletes an entry at the
instant that ran whatever its handler returned; the wait grows with the run's
age, and the report settles it.

A Sidekick is also the one parent that writes into one of its own
conversations. Each run's row in the Sidekick's shared conversation (`"0"`) is
a projection of its `sidekick_runs` row: triggers on that table arm a
`sidekick_run_row` entry on every change (WorkspaceDO migration 135), and the
entry reads the run when it runs and hands the whole row to `"0"`'s
`projectSidekickRunRow`, which drops a projection older than the one it holds
unless a replay armed it. The call is made from the alarm rather than through
the Queue, unlike a run's provisioning, because it is one small idempotent
write to a conversation that already exists, not a cold conversation's
bootstrap; a throw is retried on the scheduler's backoff. [Runs in the shared
conversation](automation-lifecycle.md#runs-in-the-shared-conversation) owns
what the row says.

Who reads a Sidekick is its own audience (`sidekickReaderAllows`): its author,
the person it runs as, the people on its `people` list (`sidekick_audience`,
WorkspaceDO migration 136) and, for an Organization one, every member; a
guest only from the list. WorkspaceDO migration 137 converted every
Thread-owned Sidekick to the Organization's. The library listing takes the
caller's access class and role from its authentication rather than reading them
again. The sidebar's Sidekick audience and viewer SQL is
`sidekick-directory-sql.ts`.

**How Sidekicks moved.** Migration 91 put every Sidekick the directory held on
a `sidekick_imports` ledger, and each one was imported from its legacy
`SidekickDO` on first use or on the alarm. Once every Organization outside a
retired one had imported, the class was deleted (Wrangler tag `v13`) and
migration 92 dropped the ledger. A Sidekick still pending in a retired
Organization was never imported; the Organization refuses new work, so nothing
reads it.


## Invariants

- **A hosted parent reads the Organization's tables with `sql.exec`.** Not
  through the runtime database adapter (`localWorkspaceEnv(...).DB`), which
  parses every statement, applies the typed-table guard and does the sidebar
  bookkeeping a request needs and an in-object read does not. A read after an
  `await` reads again: another call may have changed the row meanwhile.
- **Every statement on the four shared tables names the parent id**, whatever
  its kind. Without it a read or write reaches every parent in the
  Organization.
- **Every `sidekick_*` statement names `sidekick_id`, and a Sidekick's alarm
  entries are keyed `<sidekickId>:`.** Without it a pause or a cancel reaches
  every Sidekick in the Organization; `cancelSidekickAlarms` cancels by that
  prefix, never by kind.
- **A Sidekick's alarm is re-armed by the facade, once per call.**
  `HostedSidekick` writes entries; it does not arm the native alarm.
- **Parent kind is carried, never probed.** A lookup that tries a namespace to
  see whether something is there creates the object it asked about.

## Boundary

This module owns Sidekick and Canvas parent state inside `WorkspaceDO` and the
contract answers for an unhosted id. It does not own the conversations
([`workstream-durable-object.md`](workstream-durable-object.md)), the grant
directory ([`scope-grant-directory.md`](scope-grant-directory.md)), invitations
([`scope-invitations.md`](scope-invitations.md)), what a Canvas is
([`canvases.md`](canvases.md)) or what a Sidekick does
([`automation-lifecycle.md`](automation-lifecycle.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| A child reports an effect for a retired Thread or Space parent, or such a parent's own `parent_effect` arrives late | 409 `conversation_parent_kind_retired:<kind>` (the consumer throws the same name for a `parent_effect`); the Queue retries and dead-letters it, which is the signal. |
| A child is reserved under an id the Organization does not host | 404 `conversation_parent_not_found`. |
| A mention or an add arrives under an identity already recorded with another intent id or other bytes | `notification_intent_identity_conflict`; the Queue retries and dead-letters it. A producer that reuses an identity is the defect. |
| A stored Sidekick appearance no longer parses | The Sidekick is listed without one and logged `automation_directory_appearance_invalid`. |
| One alarm phase throws | `workspace_alarm_phase_failed` names the phase; the other phases still run, and the alarm then fails and retries. |
| A run's provisioning message is lost | The run's entry sends it again; the wait grows with the run's age until `sidekickRunProvisioned` settles it. |
| The Organization object is unavailable | No Sidekick or Canvas can be opened, listed or changed, and no viewer check answers. |

## Testing

`hosted-sidekick.test.ts` drives a Sidekick through the Organization object's
`sidekick*` surface: publish, a refused registration leaving nothing applied, a
refused memory-table write leaving publication unchanged, all-declaration
rollback, consumption of a legacy permanent-conflict entry, pause and resume, a
run provisioned off the alarm and asked about again until it reports, a pause
that leaves another Sidekick's run armed, a run's terminal deadline, a
principal claim that rebinds a plugin whose connection is gone and unbinds one
whose connection is another member's, and a child effect redelivered with
different bytes refused. `scheduled-alarms.test.ts` cancels by key prefix only
in the kinds named. `workspace-do-schema.test.ts` proves migration 92 drops the
import ledger and keeps every directory row, and `forced-migration.test.ts`
that a queued migration command for `SidekickDO` or `AutomationDO` is
acknowledged rather than retried. `hosted-mention-notifications.test.ts` posts a mention in a Canvas's Chat
and in a Sidekick's shared conversation, delivers the conversation's effects
through the real consumer twice, and reads one intent for the recipient and
the push it sent. The Canvas cases are in
[`canvases.md`](canvases.md#testing). Run with
`pnpm --filter @rally/api test:workers`.

## Operations

**Deleting the legacy classes cannot be undone.** The wrangler `v12` tag
destroyed every `WorkstreamDO` and `SpaceDO` object with its storage, and `v13`
every `SidekickDO` object, and a build from before it still binds those
classes, so it cannot be deployed again.

## Performance and cost

The design is bounded by one Durable Object's limits, since every Sidekick and
Canvas parent in an Organization shares one SQLite database and one socket set.

- **Connector events, not parents, are what fill the 10 GB object.**
  `workspace_connector_events` grows about 0.26 GB a week in the busiest
  Organization; processed rows age out after 90 days through the alarm's
  `connector_event_reap` phase, so that Organization holds about 3.3 GB of
  them at steady state (90 / 7 × 0.26). The retention and its arithmetic are
  owned by [`workstream-durable-object.md`](workstream-durable-object.md).
- **Sockets.** Cloudflare allows 32,768 hibernatable WebSockets per object. The
  Organization object holds every workspace socket in its Organization; the
  conversation feed sockets are on the `AgentLoopDO`s and do not count.

## Retired: the Channel and Space host

`HostedParent` (`hosted-parent.ts`) hosted a Channel's and a Space's parent
state: the `parent_*` tables, the directory batch and its in-transaction
apply, the local outbox, the Channel rail and its `railWaterline`, the Channel
control socket, and the per-viewer Channel row on the workspace socket. Plan
step C-2 deleted it with the Thread, Channel, Space, Breakout and Activity
modules ([`data-model.md`](data-model.md#changelog) lists them). WorkspaceDO
migration 147 dropped the Thread-era tables nothing reads; the `parent_*`,
`channels`, `breakouts` and `spaces` rows stay until the operator has run
`retire_threads` in every Organization, since its inventory reads them. The
migration statements of deleted modules moved byte for byte to
`retired-workspace-schema.ts`. The
changelog below records why each of its mechanisms was shaped as it was; the
generation fences and the claim/send/accept publisher survive in the resource
version ledger.

## Changelog

### 2026-11-08 — Retirement record: Starting a work stream

**What changed:** Nothing in the code. `workstream-creation.md`, kept after
its mechanism was deleted only as a record for its changelog, was removed in
the documentation audit; its retirement record is below. Its full text and
changelog is `git show e26aa66:docs/workstream-creation.md`.

**`workstream-creation.md` — Starting a work stream (retired 2026-11-07).** A
person started a Thread (a stored work stream) from a Channel's composer,
through an optimistic pending row and `POST /workstreams`. The Canvases and
Sidekicks pivot removed Threads; the composer path went with the client
cutover (plan steps B-1 to B-6 and C-1), and step C-2 deleted
`workstream-object-creation-service.ts`, the `HostedParent` host that
committed the directory row, and the Slack and connector paths that created
Threads on their own. A conversation now starts as a Canvas's Chat or a
Sidekick's conversation, created by its parent as this document describes. D1
`workstreams` stays as the conversation-parent anchor. Its changelog is the
record of the optimistic hand-off, the rule that everything the response does
not depend on still waits for it, and the email-address reservation.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-08 — A hosted parent batches its shared conversation's replies

**What changed:** `applyChildEnvelope` adds a `new_message_notification`
effect from `"0"` to the parent's `reply_batch` alarm entry, and
`HostedConversationHost` carries the Organization object's alarm store. The
entry's handler lives in `conversation-reply-batch.ts` and is dispatched by
`WorkspaceDO`, beside the Canvas's own entries.

**Why:** Replies notify again (the owner's 2026-11-08 request). The parent is
where the effect lands with its receipt, so adding it to the batch there is
what makes a redelivery add nothing; the batch has to outlive the request, so
it is an alarm entry, as a Sidekick run's notice is.

**Considered and rejected:** Recording the intents as the effect lands, as a
mention is: a burst of replies would push once per message.

**What a future change must respect:** the reply joins its batch in the
receipt's transaction, never after it.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-07 — A hosted parent records its conversations' mentions and adds

**What changed:** `HostedConversation.applyChildEnvelope` records a
`mention_notification` or `participant_notification` effect as a notification
intent in the transaction that writes its receipt, and `receiveChildEffects`
answers `{ accepted, notificationIntentIds }`; the activity consumer delivers
each intent it names. The `parent_effect` apply path the Thread host fed
(`applyWorkstreamRegionalEffect` in the consumer, the service and `WorkspaceDO`,
and `workspace-regional-effect-storage.ts`) is deleted: nothing has sent a
`parent_effect` since the Thread retirement. A late one from a retired Thread
or Space parent is refused as `conversation_parent_kind_retired:<kind>` and
dead-letters; one under a current parent kind is acknowledged as
`parent_effect_producer_retired`. `notificationDirectoryState` reads the
recipient through `readRelationship`, so a member the Organization object had
not yet heard of is no longer read as nobody.

**Why:** The [Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
keeps push for a mention in a Canvas's Chat or a Sidekick's conversation.
`applyChildEnvelope` receipted every kind but applied only the directory ones,
so no intent was written and nothing was sent; the one path that recorded
intents was reached only from the Thread host's `parent_outbox`. The delivery
tests seeded intent rows directly, so none of them saw it. The membership read
surfaced in the same end-to-end test: a Sidekick's admission never reads the
relationship, so an Organization-wide Sidekick's mention was skipped as
`recipient_not_listable`.

**Considered and rejected:** Rerouting the conversation's notification effects
through a `parent_effect` the parent would publish: a second Queue hop and an
outbox for a row the parent can write in the transaction it already holds.
Checking the recipient's membership before recording, as the Thread path did:
delivery reads it again as it is then, so the first read only decided whether a
row existed.

**Consequences:** A new hosted kind records mentions without doing anything.
`workspace_workstream_effect_receipts` is no longer written or read, and can
be dropped with the other Thread-era tables.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-07 — One hosting primitive for a Sidekick and a Canvas; the Channel and Space host is deleted

**What changed:** The conversation-parent contract a Sidekick answered —
authority, the viewer check, children, the children's effects and receipts,
and each reader's read of `"0"` — moved into `HostedConversation`
(`hosted-conversation.ts`), which `HostedSidekick` and the new `HostedCanvas`
extend. Its four tables (`sidekick_children`, `sidekick_child_projections`,
`sidekick_child_receipts`, `sidekick_viewer_reads`) hold either kind of
parent, keyed by the parent id in the column still called `sidekick_id`, and
`hostedConversationAuthorizationFacts` answers authorization for either in one
call. A Sidekick writes a row per run into its shared conversation and keeps
it current: triggers on `sidekick_runs` arm a `sidekick_run_row` entry on
every change, and the entry's handler calls `projectSidekickRunRow` on `"0"`
with the run as it stands. A Sidekick has its own audience, so
`authorizeViewer` no longer asks a home Channel or Breakout, and it keeps each
reader's read of `"0"` (`sidekick_viewer_reads`, from `"0"`'s `directory_user`
effects). Migration 137 made every Thread-owned Sidekick an Organization one,
and the Sidekick parent stopped reading `channels` and `breakouts`.

Then `HostedParent` and every RPC, alarm lane, socket route and socket command
that served a Channel, a Space or a Thread were deleted from `WorkspaceDO`
(plan step C-2), with the Channel control socket that released desktops (and,
before `apps/ios` was deleted, the iOS client's child directory) held open.
The contract resolves only a Sidekick or a Canvas: an id it does not host
reads as not existing and not authorized, has no children, refuses a
reservation with `conversation_parent_not_found`, and refuses a child effect
naming a `workstream` or `space` parent with
`conversation_parent_kind_retired:<kind>`. Sharing (invitations, grants, their
alarms) is Canvas-only. The post-write drain that `sql-write-observer.ts`
schedules covers only the resource version ledger, since the rails it also
drained are gone.

**Why:** A Canvas is a shared conversation with children and readers, exactly
what a Sidekick's parent already hosted (the Canvases and Sidekicks decision
"one hosting primitive in WorkspaceDO for Canvases and Sidekicks"). Cloning
`HostedSidekick` would have meant two copies of the receipt, projection and
read-state logic. The decision log has runs appear as rows in the Sidekick's
shared conversation, carrying their reply; the parent already holds the
authoritative run row and hears every run change, so it is the one place a
projection can be kept from drifting, and arming in the table's own triggers
means a run writer added later cannot forget it. An audience borrowed from a
Thread would have outlived the Thread. After the client cutover nothing opens
a Channel, Space or Thread, and keeping `HostedParent` dormant would have kept
the second hosting implementation every change to the first had to reason
about.

**Considered and rejected:** A third `HostedParent` role: Channel code scanned
the `parent_*` tables across every parent. New `canvas_*` child tables: the
existing ones are keyed by parent id, and every reader that scans them across
parents joins its own directory. Answering a retired kind's child effect with
success and dropping it: a Thread conversation still reporting after its
retirement is a retirement bug, and a quiet acknowledgement would hide it; the
dead-letter queue is the monitoring this team has.

**Consequences:** A new hosted kind implements `identity`, `assertParent`,
`admitsViewer`, `onViewerReadChanged` and `onChildProjection`, and is added to
`hostedConversationParent`; there is no fallback to fall through to. A
statement on the four tables names the parent id, whatever its kind. The only
parent-to-own-conversation write here is an alarm-driven RPC, not an outbox
row: the write is idempotent and versioned by the run's `updated_at`, so the
alarm's retry is all the delivery guarantee it needs, and a change that moves
it onto the Queue must keep the handler reading the run at delivery time. The
owning columns on `automation_directory` stay as dead columns, since released
CHECKs name them. WorkspaceDO migration 147 dropped the Thread-era tables but
kept the `parent_*`, `channels`, `breakouts` and `spaces` rows, which the
Thread retirement's inventory reads, until the operator has run
`retire_threads` in every Organization.

Shipped in juno-ai-labs/avalon#1490. Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-10-23 — Read historical directory projections without retaining obsolete fields

**What changed:** Common and viewer directory schemas strip unknown properties
on both reads and incoming effects, so a newer writer's extra fields are dropped;
projection reads preserve declared-field diagnostics across the Durable Object
RPC boundary.

**Why:** Stored Main projections retained four removed automation fields. Shared
navigation parsed every projection before choosing authorized conversations, so
one otherwise valid legacy row aborted the whole batch with an opaque Zod error.

**Considered and rejected:** Passing unknown properties through would expose
retired data. Rewriting every stored payload would couple compatibility to a
migration and its hashes; stripping at the existing schema boundary needs neither.

**Consequences:** Access decisions stay at the parent. A malformed declared field
still fails with a field-specific code rather than being silently discarded.

### 2026-10-22 — Preserve irreversible archive cascades across restore snapshots

**What changed:** Main's common projection carries the root's monotonic
`archiveGeneration`, retained on restore and backfilled by conversation schema
81. Accepting a higher generation archives owned Sidekicks in the same
transaction as the projection and receipt. Breakout archival applies the
cascade alongside the canonical child registry write; compatibility fan-out
reads that registry rather than a delayed Breakout directory projection.

**Why:** Latest-state projection delivery can legitimately accept a restore
before its archive. Dropping that older snapshot must not drop the permanent
Sidekick archive, or later replay an archive against new work in a restored room.

**Considered and rejected:** Relying on the latest `archivedAt` loses the
transition. A separate event stream would duplicate the existing durable
projection pipeline; a retained generation supplies the missing evidence.

**Consequences:** A failed cascade rolls back projection acceptance, keeping
the work retryable. Already accepted generations never repeat the cascade.
Legacy senders remain accepted; existing room archive markers reconcile on
their next lifecycle notice. Restoration does not restore Sidekicks.

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
