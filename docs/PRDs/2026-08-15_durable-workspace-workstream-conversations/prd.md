# Durable workspace and work-stream conversations

> Created 2026-08-15.
>
> Workspace and work-stream product state moves into a regional Durable Object
> hierarchy, and each work stream stores its conversations as substreams and
> ordered message parts that project directly into model message arrays.
> Companions: [`state.md`](state.md), [`flows.md`](flows.md), the normative
> [`migration-control-plane.md`](migration-control-plane.md), and the
> technical/economic
> [`comparison.md`](../2026-08-15_supabase-workspace-workstream-conversations/comparison.md).
> The newer full three-way comparison, including the hybrid design, is
> [`here`](../2026-08-16_hybrid-workstream-do-supabase/comparison.md).

## Summary

Each Avalon workspace has one `WorkspaceDO`, and each work stream in that
workspace has one `WorkstreamDO`. The workspace object is the control pane for
membership, the work-stream directory, and the compact common and per-person
projection needed by the sidebar. A work-stream object is the authority for its
conversation, participants, view waterlines, agent-run coordination, and the
state that clients stream in real time. The existing Global identity and routing
plane remains deliberately thin. Regional Workers remain the execution and data
residency boundary. Regional D1 stops being the authority for workspace and
work-stream product data. It remains only where a workload is genuinely
fleet-wide and product-free, such as migration inventory, operational
telemetry, and rebuildable aggregate indexes. It is not a connector-activity,
digest, suggestion, or cross-object outbox authority.

A work-stream conversation is not stored as several product-specific tables
that must be reconstructed into an LLM prompt. Its conversation core is two
tables inside the `WorkstreamDO`: `substreams` says which conversation a part
belongs to and how that conversation inherits context; `parts` records the
ordered user, assistant, tool, attachment, compaction, and terminal content.
One sequence covers the entire work stream. A deterministic projection at a
specific fence, for a specific principal, produces a provider-valid message
array. The same representation supports the shared main feed, private chats,
human forks, and bounded sub-agent runs without making any of them a second work
stream. User input is also split into durable arrival and durable model
admission, allowing ordinary follow-ups to queue while urgent steering messages
interrupt safely.

One generic Cloudflare Workflow instance drives each full agent loop, normally
two to thirty minutes and rarely two hours or more for coding/research. The full
loop is a resumable sequence of bounded model, tool, compaction, reconcile, and
event-wait steps—not one long retryable step and not one Workflow per model
turn. The domain owner retains conversation and loop authority throughout.

Bind continues to call Avalon's `avalon:terminal` plugin for coding. That plugin
is backed by Daytona; neither the Workflow nor the `WorkstreamDO` runs shell
commands itself. Re-platforming Terminal is outside this PRD.

Because every connector event belongs to exactly one workspace and is never
shared or replicated across workspaces, the `WorkspaceDO` also owns connector
delivery receipts, normalized activity, Avalon's ordered activity log, digest
state, opportunity admission, and per-person suggestion ranking for that
workspace. Regional R2 retains large exact provider bodies; regional Workers,
Queues, and Workflows verify, normalize, wake, and execute bounded work but do
not become product authorities. The parent delivers incorporated activity and
suggested actions to a `WorkstreamDO` through an object-local durable outbox and
idempotent child receipt. This removes a D1-to-object projection plane without
making the object run provider calls or inference while holding a transaction.

A Cloudflare-only fleet migration control plane makes lazy object schema
changes, bounded data backfills, parent/child protocol upgrades, and source-
database cutovers observable and pausable across both object classes. Campaign
Workflows orchestrate phases, Queues wake bounded jurisdictional migration
shards using non-product identifiers, regional D1 indexes the fleet and per-
object jobs, regional R2 holds immutable import chunks, and idempotent object
RPC applies bounded slices. Hibernating `WorkspaceDO` and
`WorkstreamDO` WebSockets remain long-lived; the system does not rotate them on
a timer or require an always-on external server.

## Motivation

Avalon's current regional D1 database is both the product authority and the
cross-product query plane. A work-stream turn spans work-stream rows, messages,
mentions, runs, tool invocations, artifacts, compactions, and read-state rows,
while a realtime Durable Object coordinates activity around those records. That
split makes the serialized work stream wait on a remote relational authority,
requires dual-system recovery reasoning, and reconstructs the model's ordered
message array from storage organized around API resources rather than inference.

The planned move to one Durable Object per work stream creates an opportunity to
make the ownership boundary match the concurrency boundary. It also creates a
new requirement: the application must list a workspace's work streams without
waking and querying every child object. Common sidebar fields such as title,
description, last activity, and state must be available together with
per-person fields such as unread state, mention state, and seen waterline.

This needs a deliberate design before migration begins. Creating large numbers
of objects eagerly, retaining D1 and each object as co-authorities, or storing
tokens and tool calls in shapes that only resemble the eventual model input
would preserve the current complexity while adding another storage system.

## Goals

1. A workspace's common state, member-scoped control state, and complete sidebar
   projection have one regional authority that answers without fan-out to its
   work-stream objects.
2. Each work stream has one regional authority for conversation ordering,
   participants, view waterlines, agent-run coordination, and realtime delivery.
3. Conversation storage projects deterministically into the ordered message
   arrays accepted by Bind and its model providers without reconstructing a turn
   from unrelated product tables.
4. The same conversation model represents the main feed, private contextual
   chats, human forks, fresh sub-agents, and forked sub-agents while enforcing
   their different audiences and inheritance semantics.
5. A user can either queue a message for the next agent turn or send a steering
   message that interrupts the active loop. Both are durable before
   acknowledgement; queued input does not disturb the current turn, while a
   steering request prevents any later tool from beginning against stale context
   and resumes from a provider-valid boundary.
6. A generic durable agent-run host can execute work-stream and non-work-stream
   **full agent loops** that normally last two to thirty minutes and can rarely
   exceed two hours for coding/research, without making the host the authority
   for domain conversation state or treating the whole loop as one retry unit.
7. EU workspace product data, processing, credentials, Avalon-controlled logs,
   projections, and every parent/child/shard authority remain inside the
   documented EU boundary.
   Globally scheduled Workflow/Queue triggers may contain only the reviewed
   non-product tuple `{region, campaign_id, shard_id, wake_nonce}` and can bind
   only the jurisdictional shard namespace. The Global plane is otherwise
   limited to its exact platform identity, reservation, invitation-discovery,
   and opaque regional-routing allowlist; it contains no workspace-derived
   product data. Cloudflare's documented out-of-jurisdiction billing/debug
   logging of opaque Durable Object IDs is an explicit platform-metadata
   exception requiring DPA/SCC, retention, access, and legal review; if the
   contract cannot support it, EU launch fails closed.
8. Existing work streams migrate incrementally and idempotently without
   instantiating the whole fleet at once, losing accepted writes, or leaving two
   long-lived authorities.
9. Storage and compute cost scale with active work streams, semantic parts, and
   sidebar changes rather than streamed token count, total historical object
   count, or repeated cross-object reads.
10. Provider and Avalon activity is ingested once into its owning regional
    `WorkspaceDO`, remains queryable for watches, automations, digests,
    opportunity admission, and audit, and can be incorporated into a work stream
    without making D1 and a child object co-authorities for the conversation.
11. Suggested work streams and suggested actions have explicit authorities,
    audience rules, expiry, feedback, and exactly-once promotion into a real
    work stream. A suggestion is never silently treated as an existing child.
12. Schema and data changes across every regional workspace and work-stream
    object are lazy when safe, explicitly convergent when required, bounded,
    idempotent, pausable, observable, and implemented only with Cloudflare
    primitives.
13. Realtime transport uses one hibernating workspace socket and only the
    foreground work-stream socket, except for a bounded ready-before-close
    overlap while focus changes, with no periodic reconnect churn and no
    database write per model token or rendered frame.

## Non-goals

1. This PRD does not replace Global identity, provider ingress routing, globally
   unique email-address reservation, or the immutable workspace-to-region
   directory. Those remain a minimal Global control plane because their scope is
   inherently above one workspace.
2. This PRD does not move regional telemetry, crash processing, fleet-wide
   audits, or other genuinely cross-workspace analytical data into a
   `WorkspaceDO`. Those remain regional and queryable; removing their D1 storage
   is deferred to a separate decision.
3. This PRD does not create a global work-stream index, global inbox, or global
   search. Cross-workspace product metadata is rejected because it would weaken
   both the ownership model and the regional boundary.
4. This PRD does not expose an arbitrary channel hierarchy. Substreams are
   bounded conversations inside one work stream, with fixed kinds and maximum
   inheritance depth; they are not user-created namespaces or a replacement for
   work streams.
5. This PRD does not preserve provider-specific wire payloads as the canonical
   transcript. Provider adapters may retain bounded receipts, but the durable
   conversation uses Avalon's provider-neutral roles and part kinds.
6. This PRD does not store one row per streamed token. Token deltas are realtime
   transport; durable text parts are bounded, ordered checkpoints that the
   projector joins without changing message semantics.
7. This PRD does not make an active external write safe to repeat merely because
   a run is durable. An ambiguous write remains ambiguous and requires the
   existing explicit recovery path.
8. This PRD does not make every agent loop a work stream. The generic run host is
   shared, while each domain continues to own and project its own state.
9. This PRD does not promise that an existing work stream can move between
   Global and EU after creation. Workspace region remains immutable; regional
   relocation is rejected for this migration.
10. This PRD does not move the activity log, provider delivery receipts,
    opportunity corpus, or ranking tournament into the Global plane or a
    fleet-wide database. They belong to the one regional `WorkspaceDO` that owns
    the event. Large exact bodies remain in regional R2 rather than SQLite.
11. This PRD does not make a suggested-work opportunity appear in **Work
    Streams**, **In Progress**, **Completed**, unread, or mention collections
    before its work stream has actually been created.
12. This PRD does not re-platform the Terminal plugin or replace its current
    Daytona backend. It also does not introduce Railway, EC2, an external
    scheduler, an external WebSocket hub, or an always-on migration service.
13. This PRD does not promise an unbounded agent loop merely because a Workflow
    instance can live indefinitely. Product token, tool, cost, elapsed-time,
    step-count, storage, and idle-wait budgets remain explicit and terminate or
    pause a loop honestly before a Cloudflare platform limit is exhausted.

## Product behavior

### Workspace collections, sidebar, and work streams of interest

Opening a workspace loads one paginated projection snapshot from its
`WorkspaceDO`; neither the sidebar nor the main screen queries every child. In
this section **workspace-common** means the same fact for every member authorized
to list that work stream. It does not mean Avalon's Global plane: all of these
facts remain in the workspace's immutable region.

Each listed work stream has one common card containing its ID, title,
description/objective, scope, origin, creation time, latest people-visible main-
feed activity time, exact run state and blocker/terminal reason, derived
lifecycle family, preview, attention ordinal, and common projection version.
Lifecycle is one total, versioned parent rule rather than overlapping labels:

| Exact state/reason | Lifecycle family |
| --- | --- |
| `scheduled`, `running`, `interrupting`, `preparing_context`, `waiting_capacity` | `active` |
| `needs_input` with an ordinary elicitation or missing human choice | `active` |
| `completed`, or a user-requested clean cancellation | `completed` |
| `archived` | `completed` |
| `failed`, `budget_exhausted`, or `needs_input` with `ambiguous_external_effect` / `intervention_required` | `error` |
| `deleting` or `restoring` | `hidden`; the directory visibility gate, not a client collection, controls access. |

Every supported exact state and blocker reason has exactly one row in the
implementation mapping and a snapshot test. Error is never silently grouped
into Completed; an ambiguous external write cannot also appear as ordinary
active `needs_input`.

The parent derives common collection membership from those facts in the same
transaction that applies a child projection. A child never sends a separate
event for each sidebar heading:

| Product surface | Authority and derivation |
| --- | --- |
| **Work Streams** / all | Every non-system, non-deleted common card the viewer may list. |
| **In Progress** | Common cards whose lifecycle family is `active`. |
| **Completed** | Common cards whose lifecycle family is `completed`. |
| **Error** | Common cards whose lifecycle family is `error`, whether or not the initial UI exposes a dedicated heading. |
| Date/recency groups | Sort by `last_people_activity_at`. The client labels the ordered result in the viewer's locale as Last hour, Today, Yesterday, This week, This month, or Before this month. The object stores timestamps, not locale-dependent labels. If the product later chooses one workspace timezone, that is a versioned parent projection rule rather than a child field. |

Personal collection state is sparse. A workspace-visible work stream creates no
row per member merely because its title or state changed. A `user:<id>` child
projection exists only when needed for personal listing eligibility, read state,
a targeted mention, assignment, mute/notification state, or another explicitly
personal relationship. Parent-owned pin rows and their dense order are merged
at read time; the child does not become a second pin authority.

The initial personal collections are:

| Product surface | Membership rule |
| --- | --- |
| **You Are Mentioned** | The child reports the user's latest valid targeted main-feed mention ordinal. The parent includes the work stream while that ordinal is greater than the user's seen ordinal and the user can still list the work stream. |
| **Unread** | Common `latest_attention_ordinal` is above the user's effective seen waterline, or `manual_unread_from_ordinal` explicitly lowers that waterline. A sparse `unread_tracking_start_ordinal` prevents history before the user first became interested from appearing unread. The count is derived from contiguous attention ordinals and may be capped for display. |
| **Needs Your Input** | The child reports an unresolved elicitation, ambiguity, or suggested action assigned to that user. A common `needs_input` run without a named person does not fan out one personal row per member. |
| **Pinned** | Parent-local per-person membership and dense order, independent of child recency and status. |

A people-visible main-feed message that targets a user commits its part,
attention ordinal, and mention ordinal atomically. The resulting `user:<id>`
projection is sent only for targeted users. It may reach the parent before or
after the common attention update: independent versions let the parent retain
both, and collection membership is recalculated after either apply. Marking a
work stream seen is authorized and committed at the `WorkstreamDO`, where the
part fence is known, with max semantics; a stale device cannot move the
waterline backward. Removal, loss of personal-work-stream participation, and
scope narrowing publish a higher-version `present=false` personal replacement;
parent reads filter or garbage-collect pins for an ineligible item.

The sidebar and main screen consume the same item dictionary and named
collection references from one snapshot revision. A work stream present in
several collections is serialized once and referenced by ID. The main screen's
**work streams of interest** view merges **You Are Mentioned**, **Needs Your
Input**, **Pinned**, **Unread**, and recent participation with deterministic
priority and deduplication; it is not recomputed from a different activity API.
Suggested-work opportunity cards are returned as a separate discriminated item
kind and never enter a work-stream collection until promotion succeeds.

The workspace object streams later card and collection changes to connected
clients from a workspace projection cursor. It does not receive token deltas,
tool output, raw activity, or full conversation parts. Offline, the last locally
cached snapshot may remain visible under its bounded cached-authorization lease
and is labelled stale; the server cannot revoke bytes an offline device already
downloaded. On the next authenticated contact, a membership, listing-scope, or
deletion epoch advance purges affected local cards before rendering. An expired
cursor or authorization lease produces an explicit snapshot reset or locked
offline state. Strong erasure from an offline device would require separately
specified expiring encrypted local storage and is not claimed here.

#### Child-to-parent projection protocol

A `WorkstreamDO` publishes only after committing the source fact. In the same
child transaction it updates the canonical source tables, advances
`projection_keys.next_version`, and inserts an immutable `durable_outbox` row on
channel `workspace_projection`. For a common update, the source tables are
`workstream` and any newly committed attention-bearing `parts`; for a personal
update they include `member_attention`, `part_mentions`, or the affected
`suggested_actions` row. The outbox partition is exactly `common` or
`user:<id>`. A newer complete replacement may mark an older **unsent** row
`superseded`, but it never mutates a sent or ambiguous delivery identity.

Each envelope contains `contract_version`, stable `message_id`, source child DO
ID and generation, work-stream ID, parent generation, child authority/listing/
deletion epochs, projection key, that key's version, payload hash, and a
**complete replacement value for that key**. A common value contains title,
description, preview, scope, exact state/reason, lifecycle family, completion/
state/activity timestamps, and latest attention ordinal. Origin and creation
time remain parent-directory facts and are joined locally. A personal value
contains `present`, listing eligibility, unread-tracking start, seen and manual-
unread waterlines, latest mention ordinal, assignment, needs-input, and
notification facts for only that user. It contains no message text, token,
tool output, or private action body. Complete small values make skipped
coalesced versions and retry reordering safe; a chain of partial patches would
require every intermediate delivery.

The child sends the envelope over an authenticated regional object RPC after
the source transaction. Ordinary conversation and descriptive writes do not
wait for a parent acknowledgement; the deny-first authorization controls below
do. The `WorkspaceDO` handles the RPC in one SQLite transaction and atomically:

1. verifies `workstreams.child_do_id`, child/parent generations, and all three
   epochs, rejecting any envelope below the persisted authority, listing, or
   deletion deny floor;
2. returns the recorded result from `durable_inbox_receipts` for an exact
   duplicate and rejects identity reuse with a different hash;
3. compares the version only with the matching
   `child_projection_keys(workstream_id,projection_key)` after epoch checks;
4. replaces `workstream_cards` for `common`, or upserts/deletes the sparse
   `member_workstream_state` row for `user:<id>`;
5. derives collection predicates from those rows—there is no All/In Progress/
   Completed/You Are Mentioned membership table to update separately;
6. advances `workspace.next_client_event_seq`, appends one authorized bounded
   `workspace_events` diff, stores the new child-key high-water mark, and writes
   the inbox receipt; and
7. returns `applied`, `already_applied`, `superseded`, or a typed epoch or
   registration error.

After that destination commit, the child marks its matching `durable_outbox`
row `acked`. If either RPC direction is lost, the child retries the same
`message_id`; the parent's inbox receipt returns the same result without
emitting a second client event. `due_work` drives bounded retry/backoff and a
targeted reconciliation can enqueue the current complete key at a fresh
version. A current full replacement can repair an arbitrary gap; normal sidebar
reads never fan out to children.

This is intentionally not an atomic write across two Durable Objects. The
source fact can be visible in the open child before its workspace card catches
up, and the product exposes a bounded projection-lag/error state when that
persists. It cannot show a parent state that never committed in the child, lose
a committed update permanently, or apply the same update twice. Common and
personal keys never share a version counter, so an out-of-order status update
cannot erase a mention and an out-of-order mention cannot regress status.

Deletion first installs a parent tombstone whose epoch dominates every key, then
fans out child and payload cleanup, so delayed delivery cannot resurrect a card.
The child remains authoritative: an open work stream may temporarily be newer
than its card, but the parent never invents child state. If the parent is
unavailable, the UI reports a retryable workspace projection error and does not
fall back to waking every child.

Projection lag is never an authorization grace period. A scope narrowing,
participant removal, or other listing-eligibility reduction is a parent-
coordinated deny-first operation: the `WorkspaceDO` advances the affected
listing/scope epoch, removes or masks the common/personal collection references,
and revokes current grants before the child acknowledges the narrowing. The
child then commits the same epoch and rejects old grants. Widening runs in the
opposite safe order: the child commits the new authority first, and the parent
lists it only after receiving that epoch's projection. Membership removal starts
at the parent, and deletion starts with the parent tombstone. Thus eventual
metadata convergence may show stale authorized information after an ordinary
rename, but current server reads and connected sessions cannot keep showing a
card to someone whose authority was removed. An offline cache follows the
bounded, explicit limitation above.

#### Other cross-object state machines

Every other boundary uses the same local-commit, receipt, and reconciliation
rule, but each names its actual authority:

| Situation | Source local commit | Destination local commit | Ambiguity resolution |
| --- | --- | --- | --- |
| Parent authorization or revocation | `WorkspaceDO` updates `workspace`, `members`, `grants`, affected personal projections/events, and one `durable_outbox` child command. | `WorkstreamDO` advances `workstream` epoch floors, invalidates `grant_sessions`, closes affected sockets, fences runs/tools, and records its inbox receipt. | New grants stop immediately at the parent. Active children receive high-priority commands; a missed dormant-child command is bounded by grant expiry and retried from the outbox. The same command ID returns the child receipt. |
| Child creation | `WorkspaceDO` inserts a `workstreams.visibility=hidden` directory row, any applicable `promotion_reservations` row, and a `durable_outbox` `child_initialize` command together. | The child idempotently creates `workstream`, main `substreams` row, initial parts/resources, object versions, and its inbox receipt while remaining side-effect-free. | A repeated initialization with the same hash returns the same receipt; a different hash is rejected. Parent finalization is the only transaction that changes the directory row to visible. |
| Suggested-work promotion | Parent records `child_ready` only after the child initialization receipt, then writes `promoted_origins`, finalizes `promotion_reservations`, exposes `workstreams`, and appends the workspace event together. | The already prepared child opens the matching parent generation/epoch on first routed request or finalization command. | Before parent finalization the child is hidden and disposable; after it, `origin_key` and the promotion receipt force forward reconciliation to exactly one visible child. |
| Workspace activity delivery | `WorkspaceDO` commits the normalized activity/effect and an `activity_deliveries` row under a stable `delivery_id`, after validating current connection, resource, and child-directory epochs. | The child writes `activity_delivery_receipts`, any incorporated `parts`/mentions/attention, and resulting workspace/native-activity outboxes together. | A lost RPC retries the delivery ID and returns the child receipt; the parent settles its local delivery only from that receipt. The activity ID alone is never child authority, and Queue acknowledgement never settles the boundary. |
| Suggested-action disclosure or resolution | Parent advances `workspace.source_authorization_epoch` deny-first on any relevant source/ACL narrowing, rejects older action-derived personal projections, and later emits a targeted cleanup/retraction outbox. A narrow live RPC evaluates the action's complete source vector against current selector principals. | Child rejects epochs below `workstream.source_authorization_floor`; its action-driven `needs_input` replacement carries the source epoch; and it returns a pending card or accepts a resolution only with the parent-signed, action/version/user-specific current decision. | Delayed retraction changes cleanup latency only. Parent unavailability fails closed for the optional card, ordinary transcript reads continue, and the same resolution ID is idempotent after reauthorization. |
| Agent Workflow start/resume | `WorkstreamDO` admits or updates `runs` and records a stable Workflow instance ID and desired next action before invoking the binding. | The Workflow has no product database; each step obtains/commits owner receipts in `runs`, `run_events`, `tool_effects`, and `parts`. | A creation 429 leaves the owner in `waiting_capacity`; stable instance ID and owner status distinguish not-created, running, waiting, and terminal. A step retry asks the owner rather than replaying an effect blindly. |
| Fleet migration | The control object writes desired state plus an outbox command; shard permit and target mutation are separate local transactions. | The target stores `_data_migrations` and `_migration_command_receipts`; the shard and regional/fleet objects store progressively coarser receipts. | Stable command IDs, expiring permits, target-first settlement, and complete aggregate replacements converge the chain. No upper-level counter can manufacture target success. |
| Work-stream deletion or quarantine | Parent first advances `workstreams.deletion_epoch`, removes listing/card/personal visibility, revokes grants, appends a client event, and emits the child command. | Child advances its local deletion/restore floors, stops ingress/runs/outboxes, closes sockets, and records the command before bounded content cleanup. | The parent tombstone dominates every delayed child projection. Retry resumes cleanup; it never republishes the child. Physical row/object cleanup waits through replay, audit, and recovery retention. |

These protocols deliberately choose which side may move first. Visibility
reduction and deletion begin at the parent so stale metadata cannot grant new
access. Visibility widening and child creation begin side-effect-free at the
child and become visible only in a parent transaction. Ordinary title, status,
recency, unread, and mention updates begin at the child because that is where
their source facts and attention fences are known. This ordering is the
substitute for a distributed transaction and is part of each protocol's
correctness, not an incidental retry implementation.

### Activity ingestion and storage

Every connector event has exactly one workspace owner. It is never shared,
replicated, or queried as one product row by two workspaces. Therefore the
workspace—not the region—is the correct atom of coordination: the regional
`WorkspaceDO` is authoritative for provider delivery receipts, normalized
activity, first-party activity events, digest cursors, opportunity evidence,
suggestion rankings, and workspace-local automation/routing decisions.
This follows Cloudflare's guidance to model a Durable Object around the
[atom of coordination](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/);
all of the reads described here span connections, people, work streams, and time
windows **inside one workspace**, not across workspaces.

Activity remains two related but distinct records:

- `activities` is the normalized provider-ingress record: what GitHub, Linear,
  Notion, Google, Granola, a generic webhook, or another connector delivered;
- `activity_events` is Avalon's first-party ordered activity log: what happened
  in Avalon that an authorized person, digest, or audit consumer may need to
  read. Connector activity can project into this log, while work-stream
  messages, mentions, and other native events enter without a connector
  delivery.

Neither record is the authority for a work-stream transcript, sidebar
waterline, or mention badge. The parent owns the workspace-wide log; the child
owns only what was actually incorporated into that work stream.

#### Ingestion and execution path

1. A regional connector endpoint verifies exact webhook bytes and resolves
   exactly one immutable `{region, workspace_do_id, connection_id, route_epoch}`.
   Shared ingress may use Global only for that opaque route; Global never retains
   provider content. It also resolves the connector-domain generation and route
   receipt. The parent accepts connector work only when its singleton
   `connector_domain_authority` row is `open` for those exact values. A regional
   poller, digest claim, replay, and background connector task follows the same
   gate; an already-live workspace object is not evidence that its connector
   domain has cut over.
2. The endpoint writes large exact bytes to a workspace-prefixed,
   content-addressed regional R2 key with SHA-256, byte length, authorization
   selector, source revision, and `retain_until`; bytes are never deduplicated
   across workspaces. It then calls `WorkspaceDO.acceptIngress`. In one short
   transaction, the parent validates current route/connection/source epochs and
   writes the authoritative ingress receipt, normalization generation `1`, a
   `durable_outbox` Queue intent, and a `due_work` normalization watchdog keyed
   by the three-part receipt plus generation. A
   webhook is acknowledged only after that parent commit. If
   the response is lost, the same delivery/hash returns the receipt; a changed
   hash is corruption. If the parent never commits, the webhook is not
   acknowledged and an R2 orphan reaper eventually removes the unreferenced key.
3. The parent outbox sends a regional Queue envelope
   `{workspace_do_id, route_epoch, connector_generation, provider, delivery_id,
   connection_id, payload_ref, payload_hash, payload_bytes}`; its alarm retries
   a missed send.
   Queue is an at-least-once wake, not accepted-event storage or product
   authority. A regional Worker reloads the exact body, normalizes under the
   connector manifest, and calls `WorkspaceDO.completeNormalization` with a
   stable request hash. Normalization and provider calls happen outside the
   object. The parent transaction inserts the normalized activity and initial
   effect/event/batch facts, advances the receipt, and schedules bounded
   `due_work`. Only that terminal transaction clears the watchdog and permits
   R2 retention cleanup. Queue `send()` or DLQ exhaustion never clears it: an
   alarm resends the stable envelope. The frozen retry policy automatically
   enters durable `dead` after its attempt or elapsed-age ceiling, cancels that
   watchdog transactionally, and retains R2 evidence through the dead-letter
   policy. A privileged bounded replay increments the generation and creates a
   new run/watchdog while preserving the dead generation; it cannot reset the
   receipt invisibly. Queue redelivery returns the existing generation receipt.
4. Provider I/O obtains credentials through a narrow regional service RPC to
   the parent. An authorized Worker reads only the connection's encrypted
   credential envelope, decrypts it in Worker memory with a regional Worker
   secret, performs the provider call, and submits a compare-and-set rotated
   envelope. Plaintext credentials never enter SQLite, R2, Queue, Workflow
   input/history, logs, or client responses. Refresh lease and credential
   version make a retry adopt a sibling's completed rotation instead of
   redeeming a single-use refresh token twice. A provider refusal updates the
   source's stored health belief but, except for the explicit `disabled` or
   revoked states, does not permanently suppress future attempts.
5. Deterministic watches, routing, and automation admission run in capped parent
   slices. Expensive provider, model, or Daytona work uses a claim/snapshot/CAS
   protocol: a Worker or one full-loop Workflow claims a stable operation,
   receives a bounded immutable input or R2 reference, performs external I/O,
   then submits a result whose lease, request hash, source revisions, and
   authorization epochs must still match. The object never holds a transaction
   or `blockConcurrencyWhile` across external I/O.
6. Routing into an existing work stream commits `activity_effects`,
   `activity_deliveries`, and a `durable_outbox` command together. The parent
   resolves its own child directory and current visibility/connection/resource
   epochs; it does not ask D1 to authorize the child. The `WorkstreamDO`
   idempotently commits the delivery receipt with any incorporated parts,
   suggested action, mention/attention facts, and return outboxes. Only the child
   receipt settles the parent delivery.
7. Native child events travel in the inverse direction through the child's
   durable outbox. The parent writes an inbox receipt and the deduplicated
   `activity_events` occurrence together. A connector incorporation never emits
   a second human-notifiable connector event.
8. Poll cursors advance only after the parent returns the authoritative ingress
   receipt. A poller may retain a replayable page token in R2/Queue while work is
   pending; it may not skip a provider page because an enqueue or normalization
   attempt occurred.

The Queue consumer batches compatible envelopes by target object and caps count,
bytes, SQL statements, and wall time per RPC. Alarms provide correctness for
`due_work`; Queues accelerate work and DLQs make poison envelopes visible.
No event creates its own Workflow. This keeps bursty ingestion from monopolizing
membership, sidebar, socket, or authorization calls.

#### `WorkspaceDO` connector and activity SQLite schema

These are tables in the owning `WorkspaceDO`, not D1 tables. The workspace ID
is implicit in the object identity and is intentionally absent from every row.
They follow the Durable Object conventions below: epoch-millisecond `INTEGER`
timestamps, foreign keys enabled, explicit checks, bounded canonical JSON only
for values consumed as a unit, and no large provider body in SQLite. Unless a
column is explicitly nullable, it is `NOT NULL`.

##### Ingress, normalization, and effects

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `connector_domain_authority` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`, `generation INTEGER`, `route_epoch INTEGER`, `state TEXT CHECK IN ('legacy_shadow','prepared','open','quarantined','deleted')`, nullable `final_hold_seq INTEGER`, nullable `prepared_hash TEXT`, nullable `route_receipt_hash TEXT`, nullable `opened_at INTEGER`, `updated_at INTEGER`; unique `(generation,route_epoch)`. | Independent authority gate for the connector/activity domain inside an otherwise-live parent. `legacy_shadow` and `prepared` generations may import and verify but cannot accept ingress, poll, refresh credentials, read product activity, schedule a digest, rank, notify, or deliver an effect. Only the D1 route CAS receipt can atomically open the exact prepared generation. Every connector task, receipt, cursor, outbox command, and provider-facing call carries and rechecks this generation. |
| `connector_sources` | `connection_id TEXT PRIMARY KEY`, `provider TEXT`, `connection_scope TEXT CHECK IN ('personal','workspace')`, nullable `owner_user_id TEXT REFERENCES members(user_id)`, `audience_principal_key TEXT`, `connector_generation INTEGER`, `route_epoch INTEGER`, `source_epoch INTEGER`, `authorization_revision TEXT`, `resource_policy_hash TEXT`, `status TEXT CHECK IN ('active','paused','revoked','deleted','disabled','needs_reconnect','error')`, nullable bounded `poll_cursor_json TEXT`, `poll_cursor_version INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; unique `(connection_id,provider)` and `(connection_id,provider,connection_scope,audience_principal_key)`; indexes `(status,provider)` and `(owner_user_id,status)`. | Local connection/routing authority required to accept or expose activity. A shape check requires personal sources to use the canonical `user:<owner_user_id>` principal key and workspace sources to have no owner and key `workspace`. Composite keys make provider and audience inseparable from the connection in imported/normalized rows. The generation/route must equal the open domain row. Cursor CAS uses `poll_cursor_version`; source or policy revocation advances the relevant epoch before cleanup. `disabled` is a user decision; `needs_reconnect` and `error` are retryable health beliefs. |
| `connector_credentials` | `connection_id TEXT PRIMARY KEY REFERENCES connector_sources(connection_id) ON DELETE CASCADE`, `encrypted_credentials TEXT`, `credential_iv TEXT`, `credential_key_version INTEGER`, `credential_version INTEGER`, `granted_scopes_json TEXT`, nullable `expires_at INTEGER`, nullable `refresh_lease_id TEXT`, nullable `refresh_lease_expires_at INTEGER`, nullable `last_refresh_error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`; index `(expires_at)`. | Workspace-local encrypted credential authority replacing the legacy D1 credential columns. A regional Worker secret provides envelope decryption; the object exposes ciphertext only through an authenticated service-binding RPC and accepts rotated ciphertext only by credential-version/lease CAS. It never exposes this table to member APIs. This preserves Avalon's existing one-door refresh/rotation semantics without making regional D1 a product authority. |
| `resource_selectors` | Composite primary key `(selector_id,selector_version)`; `connection_id TEXT REFERENCES connector_sources(connection_id) ON DELETE CASCADE`, `selector_kind TEXT`, `resource_type TEXT`, `provider_resource_id TEXT`, `source_revision TEXT`, `policy_epoch INTEGER`, `selector_hash TEXT`, `status TEXT CHECK IN ('active','superseded','refreshing','revoked','deleted')`, `created_at INTEGER`, `updated_at INTEGER`; unique partial `(selector_id)` and `(connection_id,resource_type,provider_resource_id)` where `status='active'`; indexes `(connection_id,status,policy_epoch)` and `(provider_resource_id,status)`. | Immutable normalized authorization versions, not merely opaque hashes. Refresh atomically supersedes the prior row and inserts one active version; no active row, or a `refreshing`/revoked head, fails closed while historical versions remain referentially valid. Narrowing provider ACLs advances the selector policy/version and `workspace.source_authorization_epoch` in the same transaction before cleanup, brief regeneration, or reranking. A historical hash detects input drift but never answers who may read now. |
| `resource_selector_principals` | Composite primary key `(selector_id,selector_version,principal_key)` with composite foreign key `(selector_id,selector_version) REFERENCES resource_selectors(selector_id,selector_version) ON DELETE CASCADE`; `principal_kind TEXT CHECK IN ('workspace','user','workstream')`, `principal_key TEXT`, nullable `user_id TEXT REFERENCES members(user_id)`, nullable `workstream_id TEXT REFERENCES workstreams(workstream_id)`, `decision TEXT CHECK IN ('allow','deny')`, `policy_epoch INTEGER`, `updated_at INTEGER`; indexes `(principal_key,decision,selector_id)` and `(selector_id,decision,principal_key)`. | Shape checks bind workspace to key `workspace` and no IDs, user to `user:<user_id>` and only `user_id`, and work stream to `workstream:<workstream_id>` and only that ID. A trigger rejects any non-owner allow on a personal source. A current deny dominates every allow. Reads and effects require current membership plus an applicable allow and no deny; provider ACL refresh writes the new version and advances the source deny floor before old grants can be used. |
| `connector_ingress_receipts` | Composite primary key `(connection_id,provider,delivery_id)` with `connection_id TEXT`, `provider TEXT`, composite foreign key `(connection_id,provider) REFERENCES connector_sources(connection_id,provider)`, `connector_generation INTEGER`, `ingress_kind TEXT CHECK IN ('webhook','poll','replay')`, `event_type TEXT`, nullable `payload_ref TEXT`, nullable `payload_hash TEXT`, nullable `payload_bytes INTEGER`, nullable `verification_key_version TEXT`, `request_hash TEXT`, `current_normalization_generation INTEGER`, `status TEXT CHECK IN ('accepted','normalized','processed','retry','dead','ignored')`, nullable `activity_id TEXT REFERENCES activities(id)`, `attempt_count INTEGER`, nullable `next_retry_at INTEGER`, nullable `error_code TEXT`, `received_at INTEGER`, nullable `processed_at INTEGER`, `retain_until INTEGER`; indexes `(status,next_retry_at,received_at)` and `(connection_id,received_at DESC)`. | Authoritative replay/idempotency receipt after exact-byte verification and before webhook acknowledgement. The composite source key prevents provider/connection mismatch and two installations of the same provider from colliding on a provider-local delivery ID. The current generation points to the one active/dead normalization run. Webhooks require a workspace-prefixed payload reference/hash/length; poll items may use replayable provider identity instead. A duplicate request hash under the same three-part key returns the same result; another hash is corruption. |
| `connector_normalization_runs` | Composite primary key `(connection_id,provider,delivery_id,generation)` with composite foreign key `(connection_id,provider,delivery_id) REFERENCES connector_ingress_receipts ON DELETE CASCADE`; `generation INTEGER CHECK(generation>0)`, `request_hash TEXT`, `normalization_outbox_message_id TEXT UNIQUE REFERENCES durable_outbox(message_id)`, `retry_policy_version INTEGER`, `attempt_ceiling INTEGER`, `age_ceiling_ms INTEGER`, `status TEXT CHECK IN ('queued','running','retry','normalized','dead','superseded')`, `attempt_count INTEGER`, nullable `first_attempt_at INTEGER`, nullable `next_retry_at INTEGER`, nullable `error_code TEXT`, nullable `terminal_at INTEGER`, `created_by_kind TEXT CHECK IN ('ingress','operator_replay')`, nullable `created_by_user_id TEXT`, `created_at INTEGER`, `updated_at INTEGER`; unique partial `(connection_id,provider,delivery_id)` where `status IN ('queued','running','retry')`; index `(status,next_retry_at,first_attempt_at)`. | Durable watchdog generation and its Queue-wake intent. The attempt/age ceilings are frozen on creation. Crossing either ceiling writes `dead`, updates the receipt, cancels `due_work`, and preserves payload retention in one parent transaction. A privileged replay creates the next generation/outbox/watchdog with an audit principal and stable request hash; prior generations remain immutable evidence. |
| `activities` | `id TEXT PRIMARY KEY`, `connection_id TEXT`, `connection_scope TEXT CHECK IN ('personal','workspace')`, `audience_principal_key TEXT`, `provider TEXT`, `provider_event_id TEXT`, `event_type TEXT`, nullable `resource_type TEXT`, nullable `provider_resource_id TEXT`, bounded canonical `actor_json TEXT`, `subject_json TEXT`, `occurred_at INTEGER`, `received_at INTEGER`, bounded `title TEXT`, `summary TEXT`, `text_snippet TEXT`, nullable `payload_ref TEXT`, nullable `payload_hash TEXT`, `visibility_json TEXT`, `target_user_ids_json TEXT`, `external_people_json TEXT`, `entity_keys_json TEXT`, `dedupe_key TEXT`, `source_revision TEXT`, `authorization_selector_id TEXT`, `authorization_selector_version INTEGER`, `authorization_selector_hash TEXT`, `digestible INTEGER CHECK IN (0,1)`, `processing_status TEXT CHECK IN ('pending','processing','processed','failed','dead')`, nullable `lease_id TEXT`, nullable `lease_expires_at INTEGER`, `attempt_count INTEGER`, nullable `next_retry_at INTEGER`, nullable `error_code TEXT`, nullable `processed_at INTEGER`, `metadata_json TEXT`; composite foreign keys `(connection_id,provider,connection_scope,audience_principal_key) REFERENCES connector_sources(connection_id,provider,connection_scope,audience_principal_key)` and `(authorization_selector_id,authorization_selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; unique `(connection_id,provider_event_id,event_type)` and `(connection_id,dedupe_key)`; indexes `(processing_status,next_retry_at,received_at)`, `(authorization_selector_id,authorization_selector_version)`, `(provider,provider_resource_id)`, and `(connection_id,received_at DESC)`. | Canonical normalized provider activity. The composite source foreign key makes it impossible for a malformed normalizer/import to change provider or widen a personal connection into workspace audience. `digestible` is frozen from the manifest. A payload reference and selector hash never grant access: the active selector version for that ID, principal decisions, and source revision are rechecked first. |
| `activity_effects` | `effect_id TEXT PRIMARY KEY`, `activity_id TEXT REFERENCES activities`, `effect_kind TEXT CHECK IN ('resource_watch','automation','workstream_delivery','activity_event','opportunity_candidate','ignored')`, `effect_key TEXT`, nullable `target_id TEXT`, `request_hash TEXT`, `source_revision TEXT`, `authorization_selector_id TEXT`, `authorization_selector_version INTEGER`, `authorization_selector_hash TEXT`, `state TEXT CHECK IN ('planned','delivering','applied','rejected','dead')`, nullable `receipt_hash TEXT`, `attempt_count INTEGER`, nullable `next_retry_at INTEGER`, nullable `error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`; composite foreign key `(authorization_selector_id,authorization_selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; unique `(activity_id,effect_kind,effect_key)`; indexes `(state,next_retry_at,created_at)`, `(authorization_selector_id,authorization_selector_version)`, and `(activity_id,state)`. | Durable deterministic decision ledger. A claim must still resolve the recorded selector to a current allow before an external or child effect. `opportunity_candidate` is legal only when no watch, automation, or existing-work routing claimed that processing revision. `ignored` is an explicit terminal decision. |
| `activity_deliveries` | `delivery_id TEXT PRIMARY KEY`, `effect_id TEXT UNIQUE REFERENCES activity_effects`, `activity_id TEXT REFERENCES activities`, `target_kind TEXT CHECK IN ('workstream_part','workstream_suggested_action','automation_run')`, `target_id TEXT`, `target_generation INTEGER`, `authority_epoch INTEGER`, `source_revision TEXT`, `authorization_selector_id TEXT`, `authorization_selector_version INTEGER`, `authorization_selector_hash TEXT`, `request_hash TEXT`, `outbox_message_id TEXT UNIQUE REFERENCES durable_outbox(message_id)`, `state TEXT CHECK IN ('pending','inflight','applied','rejected','dead')`, `attempt_count INTEGER`, `not_before INTEGER`, nullable `receipt_hash TEXT`, nullable `error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`, nullable `settled_at INTEGER`; composite foreign key `(authorization_selector_id,authorization_selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; indexes `(state,not_before,created_at)`, `(authorization_selector_id,authorization_selector_version)`, and `(target_kind,target_id,state)`. | Domain delivery ledger paired with the generic local outbox. Current source, selector, target, and authority epochs are rechecked before send. The destination receipt, not an RPC or Queue acknowledgement, settles the row; a dead row remains inspectable and replayable under the same identity. |
| `suggested_action_feedback_receipts` | `feedback_id TEXT PRIMARY KEY`, `action_id TEXT`, `action_version INTEGER`, `activity_id TEXT REFERENCES activities`, `workstream_id TEXT REFERENCES workstreams(workstream_id)`, `result TEXT CHECK IN ('accepted','dismissed','retracted','expired')`, nullable `resolved_by_user_id TEXT`, nullable `authored_part_id TEXT`, `source_revision TEXT`, `request_hash TEXT`, `receipt_hash TEXT`, `received_at INTEGER`; unique `(action_id,action_version,result,request_hash)`; index `(activity_id,received_at)`. | Parent receipt for a child-owned suggested-action outcome. It can update workspace-local routing/tuning state but cannot rewrite the child's resolved card. |

Within one parent database, `connector_sources` is the authorization/cursor root;
each ingress receipt owns immutable bounded `connector_normalization_runs` and
points to the one normalized `activities` row, which owns stable
`activity_effects`. A cross-child effect owns one `activity_deliveries`
row and one generic `durable_outbox` message. After commit, the parent resolves
the target from its local `workstreams` directory and sends that message. The
child atomically writes its `activity_delivery_receipts` plus any part or
operational action; the recorded receipt settles the parent delivery. Child
resolution travels back through the child's generic outbox and lands in the
parent feedback receipt. There is no row shared across the two SQLite databases
and no foreign key pretending that this RPC boundary is atomic.

The source receipt, normalized activity, deterministic local effects, first-party
event, and opportunity-batch membership for one revision commit in one parent
transaction before `activities.processing_status='processed'`. Cross-object
commands are immutable outbox intents in that transaction. A stale claim may be
stolen, but stable effect, delivery, and inbox identities prevent a second
automation, child part, suggested action, or digest event.

##### First-party activity log and digests

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `activity_events` | `log_sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `id TEXT UNIQUE`, `event_type TEXT`, `subject_type TEXT`, nullable `subject_id TEXT`, nullable `subject_sequence_number INTEGER`, `actor_type TEXT CHECK IN ('user','agent','system','external')`, nullable `actor_user_id TEXT REFERENCES members(user_id)`, `actor_label TEXT`, `title TEXT`, `body TEXT`, nullable `canonical_url TEXT`, `audience_kind TEXT CHECK IN ('workspace','user','workstream')`, `audience_principal_key TEXT`, nullable `audience_user_id TEXT REFERENCES members(user_id)`, nullable `audience_workstream_id TEXT REFERENCES workstreams(workstream_id)`, `digestible INTEGER CHECK IN (0,1)`, `occurred_at INTEGER`, `created_at INTEGER`, `source_kind TEXT`, nullable `source_id TEXT`, `source_revision TEXT`, nullable `authorization_selector_id TEXT`, nullable `authorization_selector_version INTEGER`, `authorization_selector_hash TEXT`, `dedupe_key TEXT UNIQUE`, `metadata_json TEXT`; nullable composite foreign key `(authorization_selector_id,authorization_selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; indexes `(log_sequence)`, `(authorization_selector_id,authorization_selector_version,log_sequence)`, partial `(audience_user_id,log_sequence)`, and partial `(audience_workstream_id,log_sequence)`. | Append-only ordered workspace log. A shape check binds `workspace` to principal `workspace` and no audience ID, `user` to `user:<audience_user_id>`, and `workstream` to `workstream:<audience_workstream_id>`. Native events may have no connector selector; connector-derived events require one and are hidden unless its current version authorizes the reader. `log_sequence`, not provider time, is the digest cursor. |
| `activity_event_targets` | Composite primary key `(event_id,user_id,relation)` with `event_id TEXT REFERENCES activity_events(id) ON DELETE CASCADE`, `user_id TEXT REFERENCES members(user_id)`, open `relation TEXT`, `created_at INTEGER`; index `(user_id,created_at DESC,event_id)`. | Named involvement such as mentioned, assigned, or review-requested. A target affects emphasis and never widens audience. Event and targets commit together. |
| `digest_schedules` | `id TEXT PRIMARY KEY`, `user_id TEXT UNIQUE REFERENCES members(user_id)`, `day_mask INTEGER CHECK BETWEEN 0 AND 127`, `enabled INTEGER CHECK IN (0,1)`, `execution_principal_json TEXT`, `version INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; unique `(id,user_id)`. | One digest policy per workspace member. Timezone remains the account authority. Updating it refreshes bounded `due_work`; alarms are correctness and Queue/Cron may accelerate. The composite identity lets child rows prove that a delivery and target belong to this schedule's user. |
| `digest_schedule_times` | Composite primary key `(digest_schedule_id,minute_of_day)` with `digest_schedule_id TEXT REFERENCES digest_schedules ON DELETE CASCADE` and `minute_of_day INTEGER CHECK BETWEEN 0 AND 1439`. | Local wall-clock occurrence set for the schedule. |
| `digest_delivery_targets` | `id TEXT PRIMARY KEY`, `digest_schedule_id TEXT`, `user_id TEXT REFERENCES members(user_id)`, `target_type TEXT CHECK IN ('email','connector_dm')`, nullable `connection_id TEXT REFERENCES connector_sources(connection_id)`, nullable `provider_tenant_id TEXT`, nullable `provider_user_id TEXT`, nullable `email_address TEXT`, `status TEXT CHECK IN ('active','needs_input','disabled')`, `version INTEGER`, nullable `last_delivered_at INTEGER`, nullable `last_delivered_delivery_id TEXT`, nullable `last_error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`; composite foreign key `(digest_schedule_id,user_id) REFERENCES digest_schedules(id,user_id)`, unique `(digest_schedule_id,target_type)`, `(id,version)`, and `(id,version,digest_schedule_id,user_id)`; index `(connection_id,status)`. | Versioned destination identity. A shape check makes email require only `email_address` and makes connector DM require connection/tenant/provider user while forbidding email. Connector delivery also requires the source to be currently authorized for this same user. Any identity or status change increments `version`. Destination validity and version are rechecked before send. |
| `digest_deliveries` | `id TEXT PRIMARY KEY`, `digest_schedule_id TEXT`, `user_id TEXT REFERENCES members(user_id)`, `planned_for INTEGER`, nullable `cursor_from INTEGER`, `cursor_through INTEGER`, `authorization_revision_hash TEXT`, `event_count INTEGER`, `highlight_count INTEGER`, nullable `brief_ref TEXT`, nullable `brief_hash TEXT`, nullable `workflow_instance_id TEXT UNIQUE`, `status TEXT CHECK IN ('planned','running','delivering','delivered','partial','empty','failed','needs_input')`, nullable `summary_markdown TEXT`, nullable `error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`, nullable `settled_at INTEGER`; composite foreign key `(digest_schedule_id,user_id) REFERENCES digest_schedules(id,user_id)`, unique `(digest_schedule_id,planned_for)` and `(id,digest_schedule_id,user_id)`; index `(digest_schedule_id,status,planned_for DESC)`. | Idempotent occurrence with a frozen log window and generic-loop identity. The composite schedule/user key prevents delivering one member's window through another member's schedule. A brief is a bounded encrypted R2 artifact containing exact authorized input. `empty` advances the digest cursor without inference; this cursor never advances work-stream seen state. |
| `digest_target_deliveries` | Composite primary key `(digest_delivery_id,target_id)` with `digest_delivery_id TEXT`, `target_id TEXT`, `target_version INTEGER`, `digest_schedule_id TEXT`, `user_id TEXT`, `request_hash TEXT`, nullable `provider_operation_id TEXT`, `status TEXT CHECK IN ('pending','inflight','delivered','needs_input','failed','ambiguous')`, `attempt_count INTEGER`, nullable `next_retry_at INTEGER`, nullable `error_code TEXT`, nullable `receipt_hash TEXT`, `created_at INTEGER`, `updated_at INTEGER`, nullable `settled_at INTEGER`; composite foreign keys `(digest_delivery_id,digest_schedule_id,user_id) REFERENCES digest_deliveries(id,digest_schedule_id,user_id)` and `(target_id,target_version,digest_schedule_id,user_id) REFERENCES digest_delivery_targets(id,version,digest_schedule_id,user_id)`; indexes `(status,next_retry_at,created_at)` and `(target_id,created_at DESC)`. | Per-destination settlement frozen to one target version. Composite foreign keys make target, delivery, schedule, and user consistency a database invariant. Before send, the parent also requires that exact target version remain current and active; mismatch becomes `needs_input` or a replanned occurrence rather than delivery to a stale destination. Ambiguous external sends reconcile before retry. |

`activity_events` and targets are the ordered, audience-aware read model derived
from connector activity and native child inboxes; they are not copies of child
parts. A `digest_delivery` freezes a contiguous `log_sequence` window for one
schedule, and its target rows settle external destinations independently. The
brief R2 reference is an immutable execution input; the parent rows remain the
cursor and authorization authority if Workflow history expires.

A digest claim freezes `cursor_through` at the parent's current maximum sequence
and starts after that schedule's newest settled cursor. New activity lands after
the upper bound and belongs to the next occurrence. The parent filters the
window using current membership, child-directory visibility, connection/source
epochs, and the normalized current selector/principal rows, then hands an immutable bounded brief to the generic
agent-loop Workflow. Authorization is rechecked before external delivery;
revocation invalidates or regenerates the brief. Due digests are jittered and
claimed in bounded workspace-local batches, not one simultaneous RPC per member.

##### Opportunity, ranking, and promotion state

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `opportunity_batch_windows` | `id TEXT PRIMARY KEY`, `partition_key TEXT`, `audience_scope TEXT CHECK IN ('personal','workspace')`, `audience_principal_key TEXT`, nullable `audience_user_id TEXT REFERENCES members(user_id)`, `first_event_at INTEGER`, `last_event_at INTEGER`, `process_after INTEGER`, `status TEXT CHECK IN ('queued','processing','completed','failed','dead')`, nullable `lease_id TEXT`, nullable `lease_expires_at INTEGER`, `attempt_count INTEGER`, nullable `error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`, nullable `completed_at INTEGER`; unique partial `(partition_key)` where `status='queued'`; index `(status,process_after)`. | Debounces visibility-compatible evidence before inference. Shape checks bind personal to `user:<audience_user_id>` and workspace to `workspace` with no user; `partition_key` includes that principal. Evidence arriving during processing enters the next window and cannot mutate frozen model input. |
| `opportunity_batch_events` | `id TEXT PRIMARY KEY`, `window_id TEXT REFERENCES opportunity_batch_windows`, `partition_key TEXT`, `source_kind TEXT CHECK IN ('activity','native_event')`, `source_id TEXT`, `source_revision TEXT`, nullable `authorization_selector_id TEXT`, nullable `authorization_selector_version INTEGER`, `authorization_selector_hash TEXT`, `occurred_at INTEGER`, `input_characters INTEGER`, `status TEXT CHECK IN ('pending','processing','completed','failed','dead')`, `attempt_count INTEGER`, nullable `error_code TEXT`, `created_at INTEGER`, `updated_at INTEGER`; nullable composite foreign key `(authorization_selector_id,authorization_selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; unique `(partition_key,source_kind,source_id,source_revision)`; index `(window_id,status,occurred_at,id)`. | Immutable batch membership. It references local facts and R2 payloads rather than copying bodies; connector evidence carries a resolvable selector/version, while native events may omit it. |
| `work_opportunities` | `id TEXT PRIMARY KEY`, `audience_scope TEXT CHECK IN ('personal','workspace')`, `audience_principal_key TEXT`, nullable `audience_user_id TEXT REFERENCES members(user_id)`, bounded `display_prompt TEXT`, `execution_prompt TEXT`, `admission_reasoning TEXT`, `provider_icon TEXT`, `source_label TEXT`, `source_fingerprint TEXT UNIQUE`, `authorization_selector_hash TEXT`, `source_revision_hash TEXT`, `version INTEGER`, `display_prompt_hash TEXT`, `execution_prompt_hash TEXT`, `status TEXT CHECK IN ('active','starting','started','superseded','expired','revoked')`, nullable `created_workstream_id TEXT REFERENCES workstreams(workstream_id)`, nullable `started_by_user_id TEXT REFERENCES members(user_id)`, nullable `start_idempotency_key TEXT`, `expires_at INTEGER`, `created_at INTEGER`, `updated_at INTEGER`, nullable `started_at INTEGER`; index `(status,expires_at,updated_at DESC)`. | Authoritative pre-workstream suggestion. Shape checks bind personal to `user:<audience_user_id>` and workspace to `workspace` with no user. `source_fingerprint` includes that principal plus exact source IDs/revisions, so personal and workspace evidence cannot collide. Model output may narrow but cannot widen its batch audience. Source invalidation moves it to `revoked` before display or promotion. |
| `work_opportunity_source_dependencies` | Composite primary key `(opportunity_id,source_kind,source_id,source_revision)` with `opportunity_id TEXT REFERENCES work_opportunities(id) ON DELETE CASCADE`; nullable `connection_id TEXT REFERENCES connector_sources(connection_id)`, nullable `source_epoch INTEGER`, nullable `selector_id TEXT`, nullable `selector_version INTEGER`, `authorization_hash TEXT`, `created_at INTEGER`; nullable composite foreign key `(selector_id,selector_version) REFERENCES resource_selectors(selector_id,selector_version)`; indexes `(connection_id,source_epoch,opportunity_id)` and `(selector_id,selector_version,opportunity_id)`. | Complete normalized dependency vector for a potentially multi-source opportunity. Connector dependencies require connection epoch plus selector/version; native dependencies forbid them. Display, ranking, and promotion resolve every row against current authority. A scalar source epoch can never stand in for this set. |
| `opportunity_provenance_nodes` | `id TEXT PRIMARY KEY`, `node_kind TEXT`, `source_identity_key TEXT`, nullable `source_kind TEXT`, nullable `source_id TEXT`, nullable `provider TEXT`, nullable `provider_tenant_id TEXT`, nullable `canonical_url TEXT`, bounded `label TEXT`, `occurred_at INTEGER`, `visibility_scope TEXT CHECK IN ('personal','workspace')`, nullable `visibility_user_id TEXT REFERENCES members(user_id)`, `visibility_principal_key TEXT`, `locator_json TEXT`, `authorization_selector_hash TEXT`, `source_revision TEXT`, `created_at INTEGER`; unique `(node_kind,source_identity_key,source_revision,visibility_principal_key)`. | Visibility-scoped evidence node. `source_identity_key` is a canonical non-null source/provider identity. `visibility_principal_key` is exactly `workspace` or `user:<id>` and a shape check requires/forbids `visibility_user_id` accordingly; these keys avoid nullable-unique holes. Locator data is bounded and cannot grant access. |
| `opportunity_provenance_edges` | Composite primary key `(parent_node_id,child_node_id,relationship)`; both node IDs reference `opportunity_provenance_nodes ON DELETE CASCADE`; `relationship TEXT`, `created_at INTEGER`; check parent differs from child; index `(child_node_id,relationship)`. | Evidence relationship only. Traversal intersects each node's visibility and current selector with the opportunity audience. |
| `work_opportunity_provenance_roots` | Composite primary key `(opportunity_id,node_id)`; both IDs reference their owning tables on delete cascade; `position INTEGER`, `created_at INTEGER`; unique `(opportunity_id,position)`. | Stable ordered roots for explanation and promotion snapshotting. |
| `work_opportunity_user_links` | `id TEXT PRIMARY KEY`, `opportunity_id TEXT REFERENCES work_opportunities`, `subject_key TEXT`, nullable `user_id TEXT REFERENCES members(user_id)`, `role TEXT`, `resolution TEXT CHECK IN ('verified','inferred','ambiguous','unresolved')`, bounded `reasoning TEXT`, nullable `provenance_node_id TEXT REFERENCES opportunity_provenance_nodes(id)`, `created_at INTEGER`, `updated_at INTEGER`; unique `(opportunity_id,subject_key,role,resolution)`; index `(user_id,resolution,opportunity_id)`. | Records whom evidence names and how; stable `subject_key` makes unresolved/ambiguous external identities deduplicable even when `user_id` is null. It affects ranking, never authorization. |
| `work_opportunity_user_states` | Composite primary key `(opportunity_id,user_id)` with `opportunity_id TEXT REFERENCES work_opportunities(id) ON DELETE CASCADE`, `user_id TEXT REFERENCES members(user_id)`; `status TEXT CHECK IN ('impressed','dismissed','started')`, `impression_count INTEGER`, nullable `first_impressed_at INTEGER`, nullable `last_impressed_at INTEGER`, nullable `resolved_at INTEGER`, nullable `created_workstream_id TEXT REFERENCES workstreams(workstream_id)`, `updated_at INTEGER`; index `(user_id,status,updated_at DESC)`. | Per-member exposure and preference. One person's dismissal does not erase a workspace-audience opportunity. |
| `suggested_work_sets` | `user_id TEXT PRIMARY KEY REFERENCES members(user_id)`, `set_id TEXT UNIQUE`, `candidate_fingerprint TEXT`, `source_set_version INTEGER`, `request_seq INTEGER`, `authorization_selector_hash TEXT`, `membership_epoch INTEGER`, `source_authorization_epoch INTEGER`, `status TEXT CHECK IN ('stale','ranking','ready','failed','revoked','expired')`, nullable `lease_id TEXT`, nullable `lease_expires_at INTEGER`, nullable `due_at INTEGER`, nullable `last_ranked_at INTEGER`, nullable `expires_at INTEGER`, bounded nullable `ranking_reasoning TEXT`, nullable `model TEXT`, `created_at INTEGER`, `updated_at INTEGER`; unique `(user_id,set_id)` and partial index `(due_at)` where non-null. | Single authoritative stored ranking returned by the workspace/home read. There is no second D1 ranking or parent cache. The workspace-wide epoch is a cheap invalidation signal: on mismatch, the bounded home read revalidates displayed candidates through their normalized dependency rows, omits only failures, marks the set stale, and queues reranking. It never renders stored labels first or scans every set in the deny transaction. |
| `suggested_work_items` | `user_id TEXT`, `set_id TEXT`, `opportunity_id TEXT REFERENCES work_opportunities(id)`, `rank INTEGER`, `opportunity_version INTEGER`, bounded `label TEXT`, `provenance_label TEXT`, `display_hash TEXT`, `authorization_selector_hash TEXT`, `source_dependency_hash TEXT`, `expires_at INTEGER`; primary key `(user_id,set_id,opportunity_id)`, unique `(user_id,set_id,rank)`, composite foreign key `(user_id,set_id) REFERENCES suggested_work_sets(user_id,set_id) ON DELETE CASCADE`; index `(opportunity_id,user_id)`. | Bounded item data served in the same workspace snapshot. Read requires an active matching opportunity version, current set epoch, and current normalized dependency hash. Stale rows are filtered synchronously and compacted asynchronously. |
| `suggested_work_ranking_rounds` | `id TEXT PRIMARY KEY`, `user_id TEXT REFERENCES members(user_id)`, `request_seq INTEGER`, `candidate_ids_json TEXT`, `selected_ids_json TEXT`, bounded `reasoning TEXT`, nullable `model TEXT`, `round_number INTEGER`, `created_at INTEGER`; index `(user_id,request_seq,round_number)`. | Explainable bounded tournament history; never the read authority. |
| `work_opportunity_snapshots` | `id TEXT PRIMARY KEY`, `opportunity_id TEXT REFERENCES work_opportunities`, `opportunity_version INTEGER`, `selected_by_user_id TEXT REFERENCES members(user_id)`, `display_prompt_hash TEXT`, `execution_prompt_hash TEXT`, `authorization_revision_hash TEXT`, `identity_links_json TEXT`, `provenance_json TEXT`, `created_at INTEGER`; unique `(opportunity_id,opportunity_version,selected_by_user_id)`. | Immutable bounded evidence used to initialize a hidden child; never raw provider content and never frozen permission. |

Opportunity derivation is also local: activity/native-event references join one
frozen batch; admitted opportunities own provenance roots and user state;
ranking atomically replaces one person's set and items. Promotion snapshots the
selected local opportunity into `promotion_reservations`, then crosses only the
parent/child initialization boundary described below. No regional coordinator
or D1 receipt sits between a suggestion card and the parent-visible child.

An unclaimed opportunity effect inserts batch membership in the same transaction
that processes the activity. A bounded Worker/Workflow claim reads one frozen,
visibility-compatible window, treats connector text as untrusted evidence, and
submits derived opportunities with their provenance. Ranking likewise claims a
person and writes `suggested_work_sets`, items, and that recipient's
`workspace_events` notification atomically. Home reads never start inference.

A suggested-work promotion is parent-local except for side-effect-free child
initialization:

1. In one parent transaction, validate current membership, the workspace source
   deny floor, and every `work_opportunity_source_dependencies` row; claim the
   exact opportunity/version/idempotency key; write the immutable snapshot and
   `promotion_reservations` with the dependency hash; reserve one hidden
   directory row; and enqueue the stable `child_initialize` command.
2. The child idempotently creates its work-stream row, main substream, opening
   attributed user part, provenance attachments, and inbox receipt while
   remaining unlistable.
3. On that receipt, the parent revalidates every current source dependency and
   in **one bounded** transaction marks the opportunity started, advances its
   version, writes `promoted_origins`, resolves only the initiating user's
   state, exposes the directory row, and emits the workspace event. Read paths
   immediately reject the now-non-active opportunity/version from every stored
   set. Bounded `due_work` slices subsequently invalidate or compact stale set
   items; finalization never fans out over an unbounded member population.
4. A retry resolves the same reservation and child. Revocation, expiry, or an
   unrecoverable initialization error atomically changes the reservation to
   `retiring`, hides the Starting state, and schedules bounded `due_work`.
   Retirement sends one idempotent `child_retire` command; the hidden child
   fences runs/outboxes, tombstones and removes its unpublished content/R2
   references, and returns a cleanup receipt. The parent then tombstones the
   hidden directory row, records `retired_promotion_origins`, and marks the
   reservation `retired`. Physical rows wait through the maximum delayed-command
   and audit window. The exact opportunity/version origin remains consumed; an
   intentional retry requires a newly admitted opportunity version/origin and
   can never revive the retired child. Snapshot content never overrides current
   permission.

There is therefore one parent-visible commit point and no D1 promotion
coordinator. A workspace-audience origin creates at most one shared child;
personal opportunities are startable only by their audience user.

An in-workstream **suggested action** remains different. The parent owns its
classifier/admission/evidence and commits one `activity_delivery`; after the
child receipt, the child exclusively owns the pending, accepted, dismissed,
retracted, or expired overlay. A user-audience action is absent from the shared
transcript, other users' events, model projection, export, search, digest, and
compaction. Acceptance authors a shared evidence part only when the source
already covers the work-stream audience or the user explicitly confirms
**Share with work stream**. Child feedback returns through its durable outbox
and the parent's idempotent feedback receipt. A targeted pending action may
drive **Needs Your Input**; a general action does not create one row per member.

Suggested-work cards, suggested-action cards, and actual work-stream references
use distinct IDs and variants. An opportunity cannot be mentioned, unread,
pinned as a work stream, compacted, or used as a substream.

#### Authorization, retention, capacity, and fallback

An activity page is served directly by its `WorkspaceDO`, so it can intersect
stored event audience with current membership, local connection/source epochs,
the child-directory visibility index, and normalized current
selector/principal rows without D1 or child fan-out. An opaque selector hash is
only an integrity fingerprint. Named targets affect digest emphasis but never
grant access. Personal connector activity stays one-user audience through
ingestion, opportunity admission, ranking, inference, and feedback.

Raw bodies and immutable inference briefs live in regional R2. SQLite retains
bounded normalized metadata, indexes, receipts, log windows, opportunities, and
operational state under explicit policies. Source revocation first advances a
local deny epoch and masks affected reads/suggestions; asynchronous redaction,
R2 deletion, and compaction cannot make stale data visible again.

A workspace object is now a deliberate product and ingestion hotspot, so launch
capacity is an admission contract rather than an assumption:

- parent RPCs cap rows, bytes, SQL statements, and execution time; ingestion,
  digest, ranking, cleanup, and outbox tasks use resumable cursors;
- Queue batching and jitter prevent webhook or digest bursts from issuing an
  unbounded call per event or member;
- interactive membership/sidebar/socket work never waits for provider/model
  calls and receives service-level latency/error telemetry separate from
  background lag;
- the object tracks SQLite bytes, activity rate, backlog age, batch latency, and
  R2 retention. Product tiers have soft admission/retention limits below
  Cloudflare's current paid
  [10 GB SQLite-per-object limit](https://developers.cloudflare.com/durable-objects/platform/limits/);
- the architecture must pass the launch envelope and skew tests below before
  admitting a larger workspace tier.

The synchronous receipt commit is intentionally the acceptance bottleneck and
is not protected by downstream Queue batching. Before launch Avalon publishes,
per connector/provider, the supported one-workspace sustained events/second,
burst size, p95/p99 acknowledgement latency, maximum body size, and retry window,
then tests those values while sidebar and socket SLOs are loaded concurrently.
Over admission, the endpoint returns the provider's retryable status (normally
`429` or `5xx`) without acknowledging or advancing a poll cursor. A provider
whose retry contract cannot cover the measured envelope is not enabled for that
workspace tier. The PRD does not claim admission-shard safety; exceeding this
single-object envelope requires the separately specified shard facade below.

There is no silent spill of workspace activity into D1. If measured workspace
skew cannot satisfy the envelope, a later design may introduce a
`WorkspaceActivityDO` or deterministic activity shards behind the stable
`WorkspaceDO` facade, but it must specify shard keys, authorization,
transactions, ordered-log semantics, digest/ranking queries, migration, and
cross-object receipts before that tier launches. The default and this PRD remain
one workspace product authority.

Storage ownership is consequently:

| Store | Authoritative contents |
| --- | --- |
| `WorkspaceDO` | Connector-domain authority generation; sources/cursors; encrypted credential envelopes and rotation leases; normalized resource selectors/principals; ingress receipts/watchdogs; normalized activity/effects; workspace activity log and targets; digest state; opportunity/provenance/ranking state; suggestion sets; local child-delivery outboxes and receipts. |
| `WorkstreamDO` | Only activity actually incorporated into that work stream, its delivery receipt/provenance, and audience-scoped pending suggested-action state and resolution. |
| Regional R2 | Large exact provider bodies, immutable authorized model briefs, imports, and other bounded content behind opaque hashed references. |
| Regional Queue/Workers/Workflows | At-least-once wake/replay and bounded execution. They are never product or authorization authority. |
| Regional D1 | Product-free fleet/migration inventory, operational telemetry, and explicitly rebuildable cross-workspace aggregates only; no connector event, digest, opportunity, suggestion, or child-delivery authority. |
| Global plane | Opaque regional ingress routes and bounded receipts only; no activity title, actor, subject, target, payload, suggestion, or work-stream metadata. |

### Main conversation

Every work stream has substream `0`, the shared main feed. Sending a message
appends one idempotent `user` text turn to `0` before the client receives an
acknowledgement. The sender sees it optimistically, and reconciliation replaces
the optimistic item with the committed part and sequence number.

Only people-visible attention-bearing activity committed to `0` advances the
sidebar's last activity and its monotonic `attention_ordinal`. The ordinal is
separate from the complete audit sequence, so hidden, tool, and control parts do
not create false unread counts. Marking seen advances a person's ordinal using
max semantics. A mention is unread when its targeted attention ordinal is past
the same waterline. Hidden sub-agent work does not make the work stream appear
unread or active; a people-visible result it eventually returns to `0` can.

When the transcript is empty, the existing empty work-stream composer remains.
While a run is active, assistant text, tool calls, tool results, and terminal
state arrive in sequence. After reconnect, the client resumes from its last
work-stream sequence rather than fetching a separately assembled final message.

### Queued and steering messages

Input delivery is explicit and scoped to one substream:

- **Queue** commits the user message immediately and shows it to participants as
  `Queued`. It does not advance the active run's input revision, abort inference,
  or prevent the next already-admitted tool.
- **Steer** commits the user message and a steering request atomically, shows it
  as `Steering`, advances the input revision, and asks the active run to stop at
  the earliest safe provider-valid boundary.

When no run is active, either action admits the message immediately and starts
the normal next turn. During a run, queued messages retain FIFO arrival order
across participants. At a completed-turn boundary the owner atomically selects
an admission cut and appends one system-only `input_admission` control part with
an `input_batch_id` and the ordered message IDs. A normal completion admits all
eligible queued messages through that cut. A steering cut admits the steering
message and all earlier eligible queued messages, so urgent input never silently
jumps over context already waiting. Messages committed after the cut remain
queued for the following turn.

The admitted batch becomes one logical user turn for the model, with each
message's authorship and order rendered explicitly. The people-visible
transcript continues to show the original individual messages. Before admission,
a sender may cancel any of their pending messages or promote a queued message to
steering; both actions append control parts rather than deleting or rewriting
accepted history. Cancelling a steering message can exclude it from the next
batch but cannot resume inference that its revision already superseded. One
participant cannot cancel or directly promote another participant's message.
Reconnect derives `Queued`, `Steering`, `Admitted`, or `Cancelled` from durable
parts rather than client memory.

### Chats and forks

A private chat is a `chat` substream owned by one participant. By default it
receives a document projection of the main feed and has read-only tools. The
main transcript is rendered inside that document with authorship, timestamps,
attachments, and tool structure preserved, but not as literal assistant and
tool messages. This prevents the model in the chat from believing it performed
calls made by the main agent.

A participant may instead create a fork at a completed main-feed turn. A fork
inherits literal model-visible turns through that immutable fence, so the model
continues the same conversation. Forks do not write into the main feed and do
not advance workspace attention. A private chat notifies its owner only.

An inherited substream can only narrow its parent's audience; it cannot broaden
owner-only content into the workspace. Inheritance follows the recursive
lineage through an immutable fence at each edge, rejects cycles and depth above
four, and applies exactly one current system policy at projection time.

Closed chats and forks remain readable by their authorized audience and accept
no new turns. They are retained with the work stream until the work stream's
retention or deletion policy removes them; closing is not deletion.

### Sub-agents

An agent may spawn a bounded `agent` substream through a recorded tool call. A
fresh sub-agent inherits no literal conversation and receives only its explicit
task and attachments. A forked sub-agent inherits literal turns through a
completed-turn fence. Both return exactly one tool result to the spawning call
in their parent substream.

An agent substream is system work, not a second participant feed. Its effective
audience is the intersection of its requested audience and every ancestor: an
agent spawned from the main feed may be workspace-audience, while one spawned
inside an owner-only chat remains owner-only. Its intermediate parts are
available only to debug and audit surfaces authorized for that same audience and
do not notify participants or advance sidebar attention. Depth is limited to
four. A completed tool result inherited before a fork is inherited with its
call; a fork never contains an unanswered historical tool call.

### How substreams should and should not be used

A substream is justified only when Avalon needs a distinct model-visible
conversation window inside one work stream with explicit inheritance, audience,
tool, and return semantics. The supported uses are closed and intentional:

| Use | Representation | Why it is a substream |
| --- | --- | --- |
| Shared work-stream conversation | The one permanent `main` row, `id=0`. | It is the work stream's participant-visible collaboration and attention source. |
| Private contextual exploration | Owner-only `chat` with `document` inheritance, created by an explicit user action. | It discusses shared evidence without claiming the main agent's literal history or writing back implicitly. |
| Private alternate continuation | Owner-only `chat` with `fork` inheritance through a completed-turn fence. | It needs literal model continuity while remaining isolated from the main feed. |
| Bounded child-agent task | `agent` with `none` or `fork` inheritance, created by a recorded parent tool call. | It has a separate bounded model window and returns exactly one result to its origin call. |

Substreams must not be used as:

- channels, topics, reply threads, group-private rooms, or extra sidebar items;
  sustained collaboration with a distinct participant set is a new work stream,
  while ordinary replies remain parts in the main feed;
- one container per run, retry, model iteration, tool call, or queued input;
  those are runs, attempts, parts, and admission controls inside the existing
  substream;
- storage shards, archive segments, compaction buckets, or a workaround for a
  `WorkstreamDO` approaching capacity; physical partitioning remains invisible
  behind the owner, and a user-visible continuation is a successor work stream;
- generic homes for digests, meetings, automations, ranking, naming, or other
  non-work-stream inference; those use the generic run host with their own domain
  owner;
- pending suggested actions, notifications, assignments, approvals, or other
  mutable workflow cards; those use audience-scoped operational state and enter
  a conversation only through an explicit newly authored part;
- a permissions escape hatch or implicit publish/merge mechanism. Inheritance
  only narrows audience, and moving a result into the main feed requires an
  explicit, newly authored main-feed part;
- cross-workstream branches or references. Inheritance foreign keys never leave
  one `WorkstreamDO`; authorized cross-workstream material is attached or
  rendered as referenced evidence rather than inherited as conversation state.

One semantic substream survives executor retries and multiple model turns until
it is explicitly closed. It has no independent workspace membership, sidebar
card, notification stream, or Durable Object identity. Creation APIs accept only
the valid kind/inheritance/audience/origin combinations above, enforce depth and
aggregate-count budgets, and reject invented kinds rather than treating them as
generic namespaces. A future group branch, thread, or publish-back feature
requires a new product decision and migration; it must not emerge by relaxing
validation on `chat`.

### Active runs, streaming, and steering

The `WorkstreamDO` admits one state-mutating agent turn at a time for a given
substream. It snapshots a projection fence and starts the regional generic
agent-run host with a target kind plus opaque target, substream, run, and fence
identifiers. The host asks the domain owner for the projected message array,
runs Bind, and sends two ordered output lanes back to that owner. A provisional
stream frame carries `(run_id, attempt_epoch, frame_seq,
base_durable_event_seq)` and is retained by the executor but may be broadcast
without advancing durable state. A durable checkpoint or semantic event carries
`(run_id, attempt_epoch, event_seq, through_frame_seq)`; the owner rejects stale
epochs, buffers gaps, and atomically commits its active text/semantic fact and
durable cursor. Only that second lane is acknowledged as durable. It does not
receive the conversation in its durable Workflow input and does not become the
transcript authority.

The full loop may remain `running` for two to thirty minutes and, rarely, more
than two hours. It is not coupled to the browser socket or one in-memory DO
activation: the user may close the foreground work stream or the whole app, the
workspace card continues to show durable running/waiting/progress state, and
reopen resumes from owner cursors. Real provider and Terminal-tool work continues
to consume its measured compute budget; an idle human, passive Workflow wait, or
background socket does not keep an executor step alive. Steering or cancellation
from a later session addresses the same loop ID and current operation epoch.

Assistant text streams through the `WorkstreamDO` to connected clients. The
first token is flushed immediately, after the normal one-to-five-second model
wait. Later executor and client deltas coalesce for 50-75 milliseconds by
default and never exceed 30 WebSocket frames per second. Frame cadence is not
storage cadence. The owner updates an operational mutable active-output tail at
a load-tested 250-500 millisecond cadence while observed, up to one second
without a foreground observer, at a bounded byte threshold, and at every tool,
steering, reset, or terminal boundary. Only the current roughly 64 KiB tail
chunk mutates; it seals before another chunk begins. On completion, one
transaction writes immutable final text `parts`, commits the terminal and
executor cursor, and deletes the active rows. Adjacent final text parts in one
turn still project as one assistant content segment.

The executor retains events after the last durable owner acknowledgement. If the
`WorkstreamDO` restarts while that executor and provider stream survive, the
client may rewind at most one provisional checkpoint interval; event-sequence
replay then reconstructs the active output without duplication. Executor or
provider-process loss is different: a nondeterministic model stream is not
replayable. The owner transactionally discards that incomplete attempt's active
text, emits an explicit reset, preserves every acknowledged user message and
committed semantic boundary, and starts a new attempt epoch from the last
provider-valid fence. The UI may therefore rewind the entire incomplete
assistant attempt, never acknowledged durable history. Typical time to first
token remains dominated by inference, not D1 reconstruction or a fleet control
object. The object remains active while it
processes inference batches, an executing tool connection, or client delivery;
during quiet gaps and after the run it has no polling loop that prevents
hibernation. The exact batching, checkpoint, chunk, and failure-rewind values
are release measurements defined in
[`migration-control-plane.md`](migration-control-plane.md), not assumptions
that one rendered frame requires one SQLite write.

When a participant queues a message, the object commits it to the arrival
sequence without changing the active input revision. When a participant steers,
the object commits the message and steering request before advancing the
revision and signalling interruption. In either case, if the older turn has an
outstanding tool call, new input is durable and visible but is not admitted into
the model array between that call and its result. Projection groups complete
logical turns by their opening sequence and parts within a turn by `part_index`;
the total sequence continues to preserve what actually arrived while the tool
ran.

The executing Workflow step opens an authenticated internal `run-control`
WebSocket to the `WorkstreamDO` and holds its client half beside the active
provider/tool `AbortController`; the owner accepts the server half using Durable
Object WebSocket hibernation. After committing a steer, the owner sends the new
revision over that connection so a safe adapter can abort immediately. A
Workflow event alone is not the cancellation carrier, and the control socket is
best effort rather than authority.
If the live connection is lost, revision checks still make late inference output
discardable, but visible cancellation may wait until the next durable boundary.
The executor half is outbound and does not hibernate, so it exists only while
that step already owns a live cancellable provider/tool operation; it closes at
run termination or before a passive Workflow event wait. It never stays open for
an idle user. A detached non-Terminal operation must expose the same cancel/
settle adapter contract or declare cancellation unavailable; Terminal commands
remain attached and bounded by their fifteen-minute cap.
No tool begins based on a separate check followed by an unguarded
call: the executor must obtain an atomic `beginTool(call, expectedRevision)`
admission from the domain owner immediately before execution. A tool already
running is cancelled only when its adapter has safe cancellation semantics;
otherwise it is allowed to settle and its completed, failed, or ambiguous result
is recorded. The interrupted logical turn then closes, and the atomic steering
cut admits its input batch at the next provider-valid boundary. A queued-only
batch waits for normal completion and does not cause cancellation. Parallel tool
results may arrive out of order but retain the provider call order through
`part_index`.

Most tools settle in seconds. Terminal execution may last three to five minutes,
although its expected p95 is under one minute. During that interval the UI shows
`Interrupting` or `Waiting for the current tool` rather than claiming the new
message was ignored. An ambiguous write stops in `needs_input`; it is never
blindly retried by the resumed loop.

### Compaction while messages continue

Compaction itself never locks the composer, pauses realtime delivery, or keeps
the `WorkstreamDO` active for the duration of a model call. Client or executor
connections may independently keep it active. In one owner transaction, the
object chooses a completed logical-turn fence `C` and appends
`compaction_start` with the exact projected-input hash, projection key,
authorization and lineage revision vector, and `through_turn_id`. The generic
regional host computes the summary from that immutable input. The object may
hibernate between the start and completion callbacks.

Message and compaction commits are serialized briefly by the owner, but
compaction inference is not. A message committed before the start transaction is
included only if it was already model-admitted and inside `C`. A message queued,
steered, streamed, or admitted after `C` remains ordinary tail history. It is
acknowledged and delivered normally, and steering still controls the active
agent run; it does not cancel maintenance work whose fenced prefix remains
valid.

When the summary returns, the object appends `compaction_complete` only if it
answers the active start and its input hash, authorization revisions, immutable
lineage fences, model family, renderer, and template still match. Ordinary
same-substream tail growth does not invalidate the result. Authorization
revocation, redaction or replacement inside the summarized prefix, deletion, or
a changed source revision for live `document` inheritance does invalidate it.
An invalid or duplicate completion is recorded diagnostically or rejected but
never advances the waterline.

A projection after a valid completion emits the summary through `C`, followed by
every authorized, model-admitted logical turn after `C`. Consequently a message
sent while compaction runs is not accidentally absorbed into a summary that
never saw it and is not omitted merely because the completion committed later.
A still-queued message remains people-visible but model-ineligible until its
input-admission part; once admitted, it appears in the raw tail after the
summary.

At most one compaction is active per `(substream, projection_key)`. Additional
demand coalesces into a later requested fence and is reconsidered after the
active job settles and token thresholds are recalculated. A crash leaves only a
non-governing start. Repeated invalidation backs off and falls back to authorized
raw history when it fits. If no eligible projection fits the model context, the
run shows `Preparing context` and waits for a current-fence compaction while
message queueing and steering remain available; after bounded failures it stops
as `needs_input` rather than using a stale summary or dropping recent turns.

### Completion, errors, and offline recovery

A run ends with a terminal part whose reason is `completed`, `needs_input`,
`failed`, `cancelled`, or `budget`. The main work-stream state shown in the
sidebar is derived from committed main-feed terminal and run state. A private or
agent substream failure does not mark the entire work stream failed unless its
result is returned to the main feed as a failure requiring participant action.

If the run host fails before producing output, the durable run remains
reconcilable from the owner and may be retried under the same run identity. If it
fails after an external write with no durable answer, the invocation is
ambiguous. If the client disconnects, the owner continues the admitted run and
the client later replays committed parts from its cursor. A disconnected client
does not keep a run alive by itself.

### Realtime socket lifecycle

The selected workspace has one hibernating `WorkspaceDO` socket for the sidebar
and main-screen work-streams-of-interest projection. Only the foreground-open
work stream has a direct `WorkstreamDO` socket for transcript, active output,
presence, and control, except for a bounded overlap during a foreground
handoff. The desktop does not subscribe to every running, mentioned, unread, or
pinned child. Background completion, error, mention, unread, and needs-input
changes arrive through the child's durable projection outbox and the parent
socket; tokens never traverse the parent.

Both objects use the Durable Object Hibernation API, serialized versioned socket
attachments, automatic application ping responses, cursor replay, and snapshot
reset. A handshake ticket's short lifetime does not rotate an established
socket. Foreground heartbeat frequency is measured against actual network
behavior and is expressed in minutes when possible. Background mode stops
application heartbeat traffic and closes the child socket after a short grace;
the one parent socket may remain hibernated for sparse interest changes. A
network or stateful deployment can still disconnect it, so reconnect is
jittered and cursor-based, but no timer intentionally ejects clients every two
or three minutes. The detailed platform and billing contract is in
[`migration-control-plane.md`](migration-control-plane.md).

### Switching between two streaming work streams

Suppose work streams A and B are both running and emitting assistant output.
Selecting either work stream changes observation only: neither full agent loop,
Workflow, provider request, tool, or Daytona command is restarted or cancelled.
The Electron main process keeps independent per-work-stream caches keyed by
`workstream_id`, with the current `run_id`, `attempt_epoch`, durable event
cursor, through-frame cursor, content hash, and active text. The renderer never
reuses one global streaming buffer for both work streams.

For an A-to-B switch, A remains connected while the client obtains a fresh
target-bound capability and opens B's hibernating `WorkstreamDO` socket. B
serializes the socket admission with its local state and sends a `ready`
envelope containing an authorized snapshot of immutable parts, the current
`active_output_turns`/`active_output_chunks` attempt, and the durable
`workstream_events` high watermark. Later committed events have higher
sequences and follow on the same socket. The object does not add the new session
to ordinary live fan-out until its `ready` envelope is queued; provisional
frames arriving during admission are buffered/coalesced behind `ready` with
their run, epoch, and frame coordinates. The client buffers events received
during hydration, installs the snapshot, discards buffered durable events at or
below the snapshot watermark, applies newer events, and requests cursor replay
if it detects a gap. An expired cursor receives an explicit snapshot reset
instead of silently skipping history.

Only after B is ready does the renderer select B and the main process begin the
short grace period before closing A. This ready-before-close overlap is an
intentional exception to the one-foreground-child policy; it is bounded and
does not authorize retaining sockets for every running, pinned, unread, or
mentioned work stream. Rapid switching back to A may reuse its per-work-stream
cache during the grace period. After eviction, the same capability, snapshot,
and cursor protocol reconstructs A.

A UI-only switch therefore loses no accepted message, immutable part, or
durably checkpointed provisional byte. Direct frames newer than the last
checkpoint remain provisional and may be held in the process-local A/B cache;
the owner normally confirms them at the next 250-500 millisecond observed
checkpoint or within one second after observation stops. They are not promoted
to durable history merely because a renderer displayed them. If the executor
or provider attempt fails, either work stream may still perform the already
documented whole-attempt reset; the client must discard the old epoch rather
than splice cached text into the replacement. That is inference recovery, not
loss caused by switching. Final sealing remains atomic inside each
`WorkstreamDO`, so hydration observes either the active attempt or its immutable
final parts, never an invented cross-object transaction between A and B.

### Authorization, capacity, and backpressure

Every external child session first asks the `WorkspaceDO` for authority and
refreshes it before expiry. The parent returns a short-lived, target-bound
capability containing the member, session, membership, scope, and authority
epochs plus bounded permitted operations. The child validates each action under
that grant locally, so user messages, token events, and executor traffic do not
pass through the parent. Membership removal advances the epoch, revokes the
session and active grants, and durably fans out socket eviction and run/tool
revocation only to children recorded against that member's active grants,
sockets, or runs. Dormant children are not awakened; they cannot accept a new
session without a fresh parent grant. A missed notification is bounded by the
capability expiry; all new grants fail at the parent immediately. Exact expiry
and eviction SLOs are release acceptance values, not implementation defaults.

The one-parent/one-child hierarchy is subject to a measured capacity envelope.
Before production canaries, load tests publish supported members, work streams,
connections, update rate, projection bytes, and per-child conversation size.
Sparse personal state and derived unread counts are mandatory. Launch supports
only the measured one-parent envelope. A projection/subscription-shard design
may later sit behind the stable `WorkspaceDO` API, but it is not an unnamed
sixth object type in this PRD: its schema, routing, reconciliation, and bounded
parent-to-shard fan-out require an explicit amendment before admitting a larger
tier. Clients must still issue one logical workspace request and never fan out
to children.

Current platform inputs make this gate concrete: Cloudflare documents a 10 GB
maximum for each SQLite-backed object and a soft limit around 1,000 requests per
second to one object ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
Cloudflare bills duration while an object is active, including while an outbound
connection keeps it active, and does not bill duration while it is inactive
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
Avalon therefore keeps token and tool streams off the parent, permits inactive
children to hibernate, and validates its lower product limits below the platform
ceiling rather than treating the ceiling as an operating target.

A `WorkstreamDO` rejects new large payloads and new runs at a configured
high-water mark before storage exhaustion. Existing history remains readable,
exportable, and deletable; the UI offers to continue in a successor work stream
seeded only with an authorized summary and link. Generic-run admission also
exposes `Waiting for capacity` with a durable run position when regional
Workflow or provider capacity is saturated; this is distinct from a user's
queued message. Neither condition is reported as an unexplained agent failure.

## Impact on the product contract

This changes the internal and user-visible definition of a work stream from one
flat conversation to one shared main conversation plus bounded, explicitly
scoped substreams. It preserves the work stream as the primary unit of
collaboration, context, and agent action. It does not introduce
channels, a global inbox, or implicit participation.

The participant-visible main feed remains the source of workspace attention.
Private chats and agent branches are contained work-stream context, not new
top-level resources. The regional promise becomes more explicit: a workspace
and all of its work streams have one immutable regional authority, while the
Global plane retains only an enumerated identity and routing projection.

## Decision log

None yet.

## Key design decisions

1. **The hierarchy is `WorkspaceDO` to `WorkstreamDO`, not one workspace-sized
   conversation object.** A workspace object gives the sidebar and membership a
   single control pane, while one object per work stream isolates serialization,
   storage growth, sockets, and agent loops. One workspace-sized object was
   rejected because unrelated active work streams would share one concurrency
   and failure domain.
2. **Regional execution remains even as regional D1 loses product authority.**
   EU jurisdiction on a child object constrains that object, not every Worker,
   Workflow, log, or subrequest that can reach it. A single globally executing
   platform Worker was rejected because it makes regional enforcement an
   application convention rather than a deployment and binding boundary.
3. **The workspace object stores a projection, not a synchronous mirror.** A
   work-stream commit and its sidebar update cannot be one transaction across
   two objects. A monotonic child outbox makes the child authoritative and the
   parent rebuildable. Synchronous dual writes were rejected because an
   ambiguous second write creates two authorities.
4. **Conversation storage is organized around model parts.** `substreams` plus
   ordered `parts` preserve roles, content ordering, tool-call/result pairing,
   attachment placement, and compaction fences. Separate canonical message,
   invocation, artifact, and compaction histories were rejected because every
   run would have to infer one ordering across them.
5. **One arrival sequence spans every substream, while logical turns preserve
   model protocol order.** The sequence is the audit and realtime clock. A
   projector orders complete logical turns by their opening sequence and their
   parts by explicit index, so an interrupt committed during a tool cannot split
   the call from its later result. Independent substream counters were rejected
   because fork fences, export, and causal debugging would require vector clocks
   or timestamp guesses; using arrival order directly as provider order was
   rejected because the two orders legitimately diverge during interruption.
6. **Document inheritance and fork inheritance are different.** Document mode
   describes another transcript as evidence; fork mode replays literal turns.
   Treating both as literal messages was rejected because a model would claim
   another agent's tool history as its own. Treating both as documents was
   rejected because a genuine continuation would lose native tool and turn
   semantics.
7. **Compaction is a completed pair keyed by every authorization-sensitive
   projection revision.** The start records a turn-boundary waterline before
   inference, and only a matching completion committed through the requested
   fence governs later projections. Audience, resource inventory, connector
   authority, lineage source, tool policy, model family, renderer, and template
   revisions participate in the key. A single mutable summary row was rejected
   because a crash could advance truncation without producing replacement
   context and because a stale summary can launder revoked content.
8. **The durable run host is generic and the domain owner remains authoritative.**
   Work-stream, digest, meeting, naming, ranking, and other agent loops can share
   admission, retry, limits, Bind integration, and receipts without being forced
   into a work-stream schema. One custom executor per feature and one universal
   `AgentDO` that owns every domain were both rejected.
9. **Active text has a mutable chunked tail; final conversation text is
   immutable.** Provider tokens and UI frames are independent from the
   250-1000 ms durable checkpoint policy. The owner mutates only one bounded
   operational tail chunk, seals coarse chunks, and transactionally replaces
   active state with final `parts` at completion. One row per delta was rejected
   on cost; one unbounded mutable row was rejected on row limits and rewrite
   amplification; retaining a mutable message beside a duplicate final was
   rejected because replay and projection would have competing truths.
10. **Closed substreams are retained and completed tool results cross fork
    fences with their calls.** Deleting closed chats would make conversation
    history and audit depend on UI state. Omitting historical tool results would
    create provider-invalid message arrays and tempt repeated external writes.
11. **Native Durable Object and Workflow contracts are the foundation.** The
    Cloudflare Actors framework is not required for identity, storage,
    jurisdiction routing, migration, or run lifecycle. Making it foundational
    was rejected because these correctness boundaries still need explicit
    application contracts and direct platform control. The narrowly imported
    Actors SQL migration utility may implement the local migration ledger behind
    Avalon's interface and conformance suite; the Actor base, handler, routing,
    persistent-property, and lifecycle abstractions remain out of scope while
    the upstream project describes itself as under active development.
12. **Write idempotency follows a causal effect intent, not input equality.** A
    durable `effect_intent_id` is allocated before an external write and remains
    stable across transport retries, Workflow attempts, and an explicitly cloned
    fork of that action. A later intentional action with identical tool input
    receives a new ID. A timeless hash of tool and input was rejected because it
    suppresses legitimate repeated actions.
13. **The workspace parent grants authority without proxying child traffic.**
    Short-lived, epoch-bound capabilities and a durable revocation fan-out let a
    child validate requests locally while membership remains authoritative in
    one place. Stale embedded membership claims were rejected as unsafe; routing
    every stream event through the parent was rejected as a workspace bottleneck.
14. **One workspace facade and one physical index ship inside a measured
    envelope.** Sparse personal rows and derived attention state are the
    baseline. A future projection/subscription shard may appear behind the
    facade only after a new specification names its object class, tables, and
    cross-object repair protocol. An unbounded single-object promise and an
    implicit unspecced shard were rejected because storage and serialized
    throughput are finite platform resources.
15. **User-input arrival and model admission are separate durable facts.** Queue
    commits content without disturbing the active turn; steer additionally
    advances the revision and requests a safe-boundary stop. An atomic admission
    control part maps one ordered input batch into one logical model turn.
    Treating every message as an interrupt was rejected because follow-ups would
    waste completed work; keeping the queue only in client memory was rejected
    because reconnect and multi-user ordering would be ambiguous.
16. **Substreams are semantic conversation windows, not generic containers.**
    Their valid kinds and creation reasons are closed: main, owner-only chat or
    fork, and bounded agent child. Runs, retries, jobs, threads, channels, storage
    segments, and cross-workstream branches use their own existing abstractions.
    An extensible namespace was rejected because it would turn local inheritance
    into an accidental product hierarchy, permission system, and scaling API.
17. **Compaction is optimistic over a fenced prefix, never a conversation
    lock.** Same-substream messages accepted during compaction remain raw tail
    turns after the summary; they neither block nor invalidate a valid prefix.
    Changes to the summarized prefix, its authorization, or a live inherited
    source invalidate completion. Blocking sends until summary completion was
    rejected on latency and availability grounds; restarting for every benign
    tail append was rejected because a busy work stream could never compact.
18. **Workspace collections are derived from facts, not published by children
    as UI sections.** A child sends one common replacement and only affected
    personal replacements. The parent indexes All, In Progress, Completed,
    Error, recency, mention, unread, and assigned-input views. Sending one child
    event per heading was rejected because it duplicates product rules, multiplies
    writes, and can leave headings disagreeing after partial delivery.
19. **Workspace-owned activity belongs to the `WorkspaceDO`.** Every provider
    event has exactly one workspace owner; its cross-connection, person,
    work-stream, and time-window reads are therefore local to that atom of
    coordination. A regional D1 activity authority plus parent projections was
    rejected because it adds a second product boundary without enabling a real
    cross-workspace product query. Raw bodies still live in regional R2, and
    bounded asynchronous slices protect the parent's interactive paths. The
    connection's encrypted credential envelope and normalized resource ACL also
    belong to this owner; regional D1 cannot be called product-free while
    retaining them. Independent legacy D1 `connector_authority` and target
    connector-domain generation gates permit safe import into an already-live
    parent without reusing its workspace route. A larger tier may add explicitly
    specified activity shards behind the parent facade; it may not silently
    spill product data back to D1.
20. **A suggestion is parent-owned but is not a work stream.** `WorkspaceDO`
    owns pre-workstream opportunities, provenance, ranking, display, promotion,
    and routing feedback; a `WorkstreamDO` owns a delivered audience-scoped
    suggested-action overlay and its resolution. One polymorphic
    suggestion/workstream row was rejected because partial creation would
    produce phantom children and unclear deletion, audience, unread, and
    compaction semantics.
21. **Access reduction is parent-fenced, not eventually projected.** Ordinary
    descriptive updates may tolerate bounded child-to-parent lag; scope,
    participation, membership, and deletion reductions may not. Deny-first
    parent epochs and grant revocation precede the child acknowledgement, while
    widening lists only after child commit. Treating authorization as another
    sidebar patch was rejected because a delayed outbox would become a privacy
    grace period.
22. **A pending suggested action is operational state, not conversation.** It has
    its own audience, version, source authorization, expiry, and resolution in a
    child-owned table, but disclosure/resolution requires a narrow live decision
    from the parent source/selector authority; delayed retraction is cleanup, not
    permission. Only explicit audience-safe acceptance authors a new
    conversation part. Storing the pending card in the main feed or inventing a
    private suggestion substream was rejected because either leaks it to
    participants or abuses substreams for non-conversation workflow state.
23. **Promotion has one parent-visible commit point.** A reserved/initialized
    child stays hidden until its initialization receipt returns and current
    authorization is revalidated; the parent then atomically marks the local
    opportunity/version started, resolves the initiator, and exposes the child.
    Every set filters that version immediately and bounded background slices
    compact stale items; atomically rewriting an unbounded member population was
    rejected. Showing the child after initialization was rejected because a crash
    could show both it and a Starting card. Treating a frozen source snapshot as
    frozen permission was rejected because membership and resource access can
    be revoked mid-promotion.
24. **Activity-log audience is event- and source-specific.** Current parent
    visibility and regional connection/resource authorization both gate reads,
    targets never grant access, and one canonical producer owns each semantic
    event. Work-stream-only visibility and two independent producers were
    rejected because they can leak resource titles and duplicate digests.
25. **Fleet migration is a Cloudflare-native control plane, not a deployment
    loop or an external service.** Fleet/regional control DOs serialize rare
    commands, one campaign Workflow owns phase progress, regional D1 owns
    inventory/jobs, Queues emit opaque shard wake-ups, jurisdictional
    `MigrationShardDO`s own regional admission/resolution, R2 holds large
    manifests, and object RPC records the actual result. Queue/Workflow never
    sees a product/object ID. One Workflow or alarm per product object and
    Railway/EC2 coordinators were rejected on scale, idle cost, authority, and
    residency grounds.
26. **Schema migration is lazy by default and a bounded campaign by choice.**
    Fast additive DDL runs before an object's first request under new code; a
    large transform never runs in the constructor and instead uses idempotent,
    checksummed slices. Eagerly waking every dormant object on each deploy was
    rejected because object count should not become deploy latency or baseline
    compute cost.
27. **Realtime uses one parent socket plus the foreground child socket.** Both
    use Durable Object hibernation, versioned attachments, automatic static
    responses, cursor replay, and snapshot reset. A focus change permits only a
    bounded ready-before-close overlap between the old and new child sockets.
    Keeping child sockets for all running work streams, forcing periodic
    reconnects, and routing token frames through the parent were rejected
    because they spend client/network/platform resources without improving the
    background experience.
28. **Live steering uses an internal run-control WebSocket plus durable
    fencing.** The running Workflow step holds the client half, the hibernating
    `WorkstreamDO` holds the server half, and a committed steer sends an abort to
    an adapter that declares cancellation safe. The socket is the low-latency
    path, not authority: if it is lost, output fencing and atomic owner-side tool
    admission preserve correctness until the next durable boundary. A Workflow
    event alone was rejected because it cannot abort a step already running.
29. **Migration pause is a drained shard barrier, not a remote preflight
    check.** A fixed set of jurisdictional migration shards issues bounded,
    expiring permits. `paused` is acknowledged only after every shard fences and
    every admitted permit settles/expires; prior work is visibly `pausing`.
    Claiming that a control-DO check immediately before target RPC linearizes a
    distributed pause was rejected because pause can race the target start.
30. **Legacy D1 is the sole authority-row and hold gate until one prepared route
    CAS.** Every old writer transactionally mutates source/outbox or inserts a
    stable held command. The hold closes to a finite sequence, the shadow target
    imports/verifies it while side-effect-free, and only then does D1 publish the
    DO route. A post-route release phase was rejected because no transaction can
    atomically couple it to a route change in another database.
31. **PITR is quarantined reconstruction, not rollback.** Restore command and
    bookmark live outside the target; route, parent grants, sockets/runs, and the
    unified alarm scheduler fail closed under a higher external restore
    generation until current deny floors and a complete replay are verified.
    Treating a paused campaign or Worker rollback as sufficient was rejected
    because PITR can restore stale authorization, receipts, due work, and data.
32. **One Workflow instance owns a full agent loop; no single step does.** The
    instance spans normal two-to-thirty-minute loops and rare two-hour coding
    sessions through deterministic model, tool, reconcile, compaction, and
    event-wait boundaries. A detached operation plus `waitForEvent` handles work
    longer than a 30-minute step timeout. Retaining the current one-year
    monolithic Bind step was rejected because restart/retry would replay the
    whole loop and continuously occupy one running slot.

## Data model

### Object identities and directories

The Global plane has an explicit schema allowlist: platform authentication
subject and its minimum account identity fields; opaque workspace locator and
immutable region; email-bound invitation-discovery hash and expiry; opaque
provider-tenant-to-region/workspace/connection routes; globally unique address
reservation or tombstone; and bounded operational routing receipts. Every field
requires a named retention rule. It does not hold workspace names, member lists,
work-stream identifiers, titles, descriptions, activity timestamps, statuses,
mentions, unread state, connector credentials, or conversation data. Platform
identity is not described as workspace product data, but is still regulated data
and remains subject to its own documented residency and privacy obligations.

The regional entrypoint resolves the workspace through the namespace selected
by the authenticated immutable region. The `WorkspaceDO` creates or registers a
child `WorkstreamDO` in the same jurisdiction and persists its opaque child ID.
A name that happens to contain `eu` is not a residency control; the namespace
used to create and resolve both objects is.

The repository already exports Durable Object classes whose disposition must be
explicit rather than leaving hidden sixth and seventh product objects:

| Existing class | Disposition in this transition |
| --- | --- |
| `WorkstreamRoom` | Replaced by `WorkstreamDO`. It is currently a non-canonical realtime coordinator, so authoritative D1 content is imported into the child tables and sockets reconnect with cursors. Its pending HyperSight wake, if any, becomes a `due_work` item or is reconciled from the canonical trigger; its old KV keys do not become a parallel schema. |
| `WorkspaceScheduler` | Folded into the matching `WorkspaceDO` unified `due_work` alarm. The parent also owns workspace-local automation schedules, connector watches, poll cursors, and digest query state; Workers/Queues may accelerate claimed work but do not own it. Dual-refresh compatibility precedes alarm cutover, and the old class is removed only in a later lifecycle campaign. |
| `CrashSymbolicatorContainer` | Unchanged and outside this product-data PRD. It is the existing crash-symbolication Container binding, not a workspace/work-stream authority or a migration-control object; its storage contract remains with the crash/telemetry subsystem. |

Accordingly, the complete target product/migration architecture specified here
has the five SQLite-backed object classes below. Adding another class—including
a future workspace projection shard—requires adding its tables and cross-object
protocol to this contract before deployment.

### Durable Object SQLite conventions

All five Durable Object classes in this architecture—`WorkspaceDO`,
`WorkstreamDO`, `FleetMigrationDO`, `RegionalMigrationDO`, and
`MigrationShardDO`—use SQLite storage. The tables below are the required
physical schema, not examples. An implementation may add an index or an
additive migration field, but it may not silently introduce a second authority,
duplicate canonical content into an operational table, or omit a named receipt,
epoch, or tombstone. The checked-in DDL and a generated schema manifest must
eventually match this contract.

Unless a table says otherwise:

- opaque identifiers, hashes, enum values, and external references are bounded
  `TEXT`; timestamps are Unix milliseconds in `INTEGER`; booleans are `INTEGER`
  constrained to zero or one;
- listed columns are `NOT NULL` unless they are explicitly described as
  nullable; state-dependent nullable fields have `CHECK` constraints tying
  their presence to the relevant lifecycle state;
- JSON is canonical, versioned, size-bounded `TEXT`, used only when its members
  are read and replaced as a unit; independently queried or updated values are
  normalized into rows;
- foreign keys are enabled and checked, enum and shape constraints are SQLite
  `CHECK`s, and every retry identity has a uniqueness constraint rather than an
  application-only check;
- `workspace_id` is not repeated inside a `WorkspaceDO`, and neither
  `workspace_id` nor `workstream_id` is repeated on every child row. Each object
  stores its external key once in its singleton identity row to detect a
  misrouted call;
- product-facing objects use opaque IDs rather than user or workspace names as
  Durable Object names; and
- removal of expired receipts and replay events is bounded by a stored prune
  cursor and the longest retry, offline-replay, audit, migration, and legal-hold
  window that depends on them.

The physical shapes stay below Cloudflare's current SQLite-backed DO limits:
100 columns per table, 100 bound parameters per query, 100 KB SQL statements,
2 MB per string/BLOB/row, 10 GB per object, six simultaneous outgoing
connections per request, 30 seconds default active CPU, and fifteen minutes of
alarm wall time. The widest table here, `parts`, has 43 columns. Launch limits
inline `parts.content` to 256 KiB, each active-output chunk to 64 KiB, each
canonical JSON/outbox/replay payload to 256 KiB, and each fallback summary to
16 KiB; larger data uses `content_refs`/regional R2. Product storage and request
high-water marks remain materially below 10 GB and the platform's soft per-
object request ceiling. Outbox and migration dispatchers issue at most six
simultaneous calls from one invocation, and alarm handlers checkpoint bounded
slices rather than approach their wall limit
([Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
Cloudflare bills an indexed row update as an additional row write, so every
listed index must support a named read or reconciliation path and its write
amplification is part of the canary report. Launch adds no speculative FTS index,
no per-collection membership copies, and no token-level index. Removing or
replacing a listed performance index requires a measured query plan and an
update to this contract; uniqueness, foreign-key, epoch, and receipt constraints
are never optional performance choices.

Every object has the following administration and delivery tables. Product
objects use all of them; a control object may have no ordinary `durable_outbox`
rows when its state machine has nothing to deliver.

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `object_versions` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `worker_version_id TEXT`, `contract_version INTEGER`, `schema_version INTEGER`, `data_version INTEGER`, `projection_version INTEGER`, `restore_generation INTEGER`, `updated_at INTEGER`. | The constructor updates observed code after schema compatibility succeeds. Restore generation can only increase. This row is inventory evidence, not the migration journal. |
| `durable_outbox` | `message_id TEXT PRIMARY KEY`, `channel TEXT`, `destination_kind TEXT` in `durable_object`, `workflow`, `queue`, `regional_service`, `destination_id TEXT`, `partition_key TEXT`, `source_version INTEGER`, `source_epoch INTEGER`, `contract_version INTEGER`, exactly one of nullable bounded `payload_json TEXT` or nullable regional `payload_ref TEXT`, `payload_hash TEXT`, `state TEXT` in `pending`, `inflight`, `acked`, `superseded`, `dead`, `attempts INTEGER`, `not_before INTEGER`, `created_at INTEGER`, nullable `acked_at INTEGER`; index `(state,not_before,created_at)` and `(channel,destination_kind,destination_id,partition_key,source_version)`. | The source fact and immutable delivery intent commit in one local transaction. A newer complete replacement may supersede an unsent older row, but sent or ambiguous rows remain retryable until the destination receipt is observed. `regional_service` is allowed only for named R2 lifecycle, product-free telemetry, or temporary legacy-cutover adapters—never a D1 product projection. Workflow and Queue payloads must also satisfy their separately allowlisted envelopes. |
| `durable_inbox_receipts` | Composite primary key `(channel,source_kind,source_id,source_generation,message_id)` where `source_kind` is `durable_object`, `workflow`, or `regional_service`; `partition_key TEXT`, `source_version INTEGER`, `source_epoch INTEGER`, `request_hash TEXT`, `result_code TEXT`, `result_hash TEXT`, `received_at INTEGER`; index `(channel,source_kind,source_id,partition_key,source_version DESC)`. | A duplicate with the same hash returns its recorded result. Reuse of an identity with another hash is corruption. Domain state and this receipt commit in one destination transaction. |
| `due_work` | `job_key TEXT PRIMARY KEY`, `kind TEXT`, `due_at INTEGER`, `epoch INTEGER`, bounded `payload_json TEXT`, `attempts INTEGER`, nullable `last_error_code TEXT`, `updated_at INTEGER`; index `(due_at,job_key)`. | One table multiplexes the single native DO alarm across outbox delivery, compaction, expiry, reconciliation, and migration continuation. A handler selects bounded due rows and then schedules the next minimum `due_at`. |
| `_sql_schema_migrations` | `version INTEGER PRIMARY KEY`, `implementation_hash TEXT`, `worker_version_id TEXT`, `applied_at INTEGER`. | Records fast constructor DDL; it replaces unsupported `PRAGMA user_version`. |
| `_data_migrations` | `campaign_id TEXT PRIMARY KEY`, `target_version INTEGER`, `phase TEXT`, nullable `cursor TEXT`, nullable `source_fence TEXT`, nullable `source_hash TEXT`, nullable `result_hash TEXT`, nullable `pitr_bookmark TEXT`, `status TEXT`, `attempts INTEGER`, nullable `last_error_code TEXT`, `updated_at INTEGER`. | Authoritative per-object progress for a bounded, restartable transform. |
| `_migration_command_receipts` | `command_id TEXT PRIMARY KEY`, `campaign_id TEXT`, `command_kind TEXT`, `request_hash TEXT`, `result_hash TEXT`, `result_code TEXT`, `completed_at INTEGER`. | Makes inspect/apply/verify/commit RPC idempotent and detects command-ID reuse with changed input. |

There is intentionally no `sockets` table and no alarm-per-feature table.
Cloudflare's Hibernation API owns live WebSocket attachment; its serialized
attachment carries only principal/session IDs, authorization epochs, and replay
cursor, is capped by Avalon at 4 KiB, and remains below Cloudflare's current
16,384-byte attachment maximum. `workspace_events` or `workstream_events` owns
durable replay, while
`grants`/`grant_sessions` owns authorization. The one native alarm is derived
from `due_work`. Likewise Workflow step history is not copied into SQLite;
`runs` and effect receipts contain only the product facts that must outlive
Cloudflare's Workflow retention
([WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

No cross-object RPC occurs inside a SQLite transaction. SQLite atomicity ends at
the object boundary: the source commits a fact and `durable_outbox` row, sends
after commit, and the destination commits its domain mutation with a
`durable_inbox_receipts` row. A lost response therefore causes a harmless retry,
not a guessed rollback. The sender marks `acked` only after receiving the
recorded destination result. Reconciliation compares the source's current
complete replacement and destination's last-applied version; neither Queue
delivery nor RPC success is treated as authority.

### `WorkspaceDO` SQLite schema

The workspace object is the regional authority for workspace policy,
membership, the parent-to-child directory, pins, the materialized sidebar and
home-screen collection model, and the workspace-owned activity/digest/
opportunity domains specified above. It never stores a child transcript, token
stream, tool output, or large exact provider body.

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `workspace` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `workspace_key TEXT UNIQUE`, `region TEXT`, `title TEXT`, `description TEXT`, `policy_json TEXT`, `status TEXT` in `active`, `suspended`, `deleting`, `deleted`, `restoring`, `membership_epoch INTEGER`, `authority_epoch INTEGER`, `source_authorization_epoch INTEGER`, `directory_generation INTEGER`, `next_client_event_seq INTEGER`, `created_at INTEGER`, `updated_at INTEGER`, `deletion_epoch INTEGER`. | Canonical workspace metadata and deny-first epochs. Any source, selector, connector-owner, or resource-ACL narrowing increments `source_authorization_epoch` in the same parent transaction; local activity/suggestion reads fail closed on an older epoch. Region and workspace key are immutable. Deletion and restore epochs never decrease. |
| `members` | `user_id TEXT PRIMARY KEY`, `role TEXT` in `owner`, `admin`, `member`, `status TEXT` in `invited`, `active`, `removed`, `display_name TEXT`, nullable `avatar_ref TEXT`, `membership_version INTEGER`, `grant_floor INTEGER`, `joined_at INTEGER`, nullable `removed_at INTEGER`, `updated_at INTEGER`; indexes `(status,role,user_id)` and `(updated_at,user_id)`. | Regional membership authority. Removal advances the workspace epoch and this member's grant floor before any cleanup fan-out. Profile fields are bounded workspace display projections, not global identity authority. |
| `grants` | `grant_id TEXT PRIMARY KEY`, `grant_hash TEXT UNIQUE`, `user_id TEXT REFERENCES members`, nullable `workstream_id TEXT`, `membership_epoch INTEGER`, `authority_epoch INTEGER`, `scope_epoch INTEGER`, `source_authorization_epoch INTEGER`, `issued_at INTEGER`, `expires_at INTEGER`, nullable `revoked_at INTEGER`, `session_id TEXT`; indexes `(user_id,expires_at)` and `(workstream_id,expires_at)`. | Stores hashes and revocation state for short-lived signed capabilities, never bearer-token plaintext. A current epoch and unexpired, unrevoked row are both required. The source epoch alone does not authorize connector content; it fences cached decisions and is paired with exact parent selector/dependency checks for suggested-action disclosure. |
| `workstreams` | `workstream_id TEXT PRIMARY KEY`, `child_do_id TEXT UNIQUE`, `child_generation INTEGER`, `origin_kind TEXT`, `origin_key TEXT`, `visibility TEXT` in `hidden`, `visible`, `retiring`, `deleted`, `quarantined`, `restoring`, `authority_epoch INTEGER`, `listing_epoch INTEGER`, `deletion_epoch INTEGER`, `parent_contract_version INTEGER`, `child_contract_version INTEGER`, nullable `successor_workstream_id TEXT`, `created_at INTEGER`, nullable `promoted_at INTEGER`, nullable `retired_at INTEGER`; unique partial index on live `(origin_kind,origin_key)` and index `(visibility,created_at,workstream_id)`. | Authoritative parent-to-child relationship and routing floor. A row exists before child initialization; only `visible` rows enter product collections. A deletion tombstone remains through the maximum delayed-delivery window. |
| `workstream_cards` | `workstream_id TEXT PRIMARY KEY REFERENCES workstreams`, `title TEXT`, `description TEXT`, `preview TEXT`, `scope TEXT` in `personal`, `workspace`, `exact_state TEXT` in `scheduled`, `running`, `interrupting`, `preparing_context`, `waiting_capacity`, `needs_input`, `completed`, `cancelled`, `failed`, `budget_exhausted`, `archived`, `deleting`, `restoring`, `lifecycle_family TEXT` in `active`, `completed`, `error`, `hidden`, `state_reason_code TEXT`, `last_people_activity_at INTEGER`, `latest_attention_ordinal INTEGER`, `state_changed_at INTEGER`, nullable `completed_at INTEGER`, `common_projection_version INTEGER`, `projection_hash TEXT`, `updated_at INTEGER`; indexes `(last_people_activity_at DESC,workstream_id)`, `(lifecycle_family,last_people_activity_at DESC,workstream_id)`, and `(exact_state,last_people_activity_at DESC,workstream_id)`. | One shared card per child, joined locally to directory origin/creation fields. **Work Streams**, **In Progress**, **Completed**, Error, and date groupings are indexed predicates over this row; the card is not copied into collection tables. Dates render in the viewer's locale from the stored timestamp. |
| `member_workstream_state` | Composite primary key `(user_id,workstream_id)` referencing `members` and `workstreams`; `listing_eligible INTEGER`, `unread_tracking_start_ordinal INTEGER`, `seen_attention_ordinal INTEGER`, nullable `manual_unread_from_ordinal INTEGER`, `latest_mention_attention_ordinal INTEGER`, `assigned INTEGER`, `needs_input INTEGER`, `notification_pending INTEGER`, `personal_projection_version INTEGER`, `projection_hash TEXT`, `updated_at INTEGER`; indexes `(user_id,listing_eligible,updated_at DESC,workstream_id)`, `(user_id,latest_mention_attention_ordinal,seen_attention_ordinal)`, `(user_id,seen_attention_ordinal,unread_tracking_start_ordinal)`, and `(user_id,assigned,needs_input,updated_at DESC)`. | Sparse per-person overlay. The base waterline is `max(seen_attention_ordinal,unread_tracking_start_ordinal-1)`; a manual-unread ordinal may lower it. Unread is `workstream_cards.latest_attention_ordinal` above that effective waterline. **You Are Mentioned** is `latest_mention_attention_ordinal > seen_attention_ordinal`; interest is the deterministic union of pin, mention, unread, assignment, needs-input, and product policy. Missing rows mean no personal signal and no historical unread, not an all-zero row created for every member/child pair. |
| `workstream_pins` | Composite primary key `(user_id,workstream_id)`; `position INTEGER`, `version INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; unique `(user_id,position)` and index `(user_id,position,workstream_id)`. | Parent-owned personal opinion. Reorder rewrites one user's dense ordered run in one transaction and appends one workspace client event. The child is never involved. |
| `child_projection_keys` | Composite primary key `(workstream_id,projection_key)` where the key is `common` or `user:<id>`; `source_generation INTEGER`, `last_applied_version INTEGER`, `source_epoch INTEGER`, `payload_hash TEXT`, `last_message_id TEXT`, `applied_at INTEGER`. | Destination-side high-water mark for child complete replacements. Versions compare only within the same key. A directory deletion epoch dominates every row even if a delayed replacement has a larger ordinary version. |
| `workspace_events` | `event_seq INTEGER PRIMARY KEY`, `event_id TEXT UNIQUE`, nullable `recipient_user_id TEXT REFERENCES members`, `kind TEXT`, nullable `workstream_id TEXT REFERENCES workstreams`, `projection_key TEXT` equal to `workspace`, `common`, or `user:<id>`, nullable `source_message_id TEXT`, bounded `payload_json TEXT`, `created_at INTEGER`, `expires_at INTEGER`; indexes `(recipient_user_id,event_seq)`, `(workstream_id,event_seq)`, and `(expires_at,event_seq)`. | Cursor-replay log for the hibernating workspace socket. Workspace metadata and membership events use `projection_key=workspace` and no work-stream ID; parent-local pin events use a work-stream ID but need no child source message. Shared events have no recipient; personal events are filtered before serialization. Expired cursors receive a full authorized snapshot reset. |
| Connector/activity families | Exact `connector_domain_authority`, `connector_sources`, `connector_credentials`, `resource_selectors`, `resource_selector_principals`, `connector_ingress_receipts`, `connector_normalization_runs`, `activities`, `activity_effects`, `activity_deliveries`, `activity_events`, and `activity_event_targets` fields and indexes are in **WorkspaceDO connector and activity SQLite schema** above. | Canonical workspace-local connector gate, encrypted credential envelope, current resource authorization, ingress/watchdog generations, normalized activity, effect/delivery, and ordered activity-log state. All cross-child delivery is paired with `durable_outbox`; large bodies stay in R2. |
| Digest families | Exact `digest_schedules`, `digest_schedule_times`, `digest_delivery_targets`, `digest_deliveries`, and `digest_target_deliveries` fields and indexes are in the activity schema above. | Canonical member digest policy, frozen cursor windows, and per-destination settlement inside this workspace. |
| Opportunity families | Exact batch, opportunity, provenance, user-state, ranking, snapshot, `suggested_work_sets`, `suggested_work_items`, and feedback-receipt fields and indexes are in the activity schema above. | Canonical pre-workstream derivation, display, promotion input, and child-feedback state. There is no external opportunity authority or duplicate display cache. |
| `promotion_reservations` | `reservation_id TEXT PRIMARY KEY`, `origin_key TEXT UNIQUE`, `opportunity_id TEXT REFERENCES work_opportunities(id)`, `request_user_id TEXT REFERENCES members(user_id)`, `workstream_id TEXT UNIQUE REFERENCES workstreams`, `request_hash TEXT`, `membership_epoch INTEGER`, `source_authorization_epoch INTEGER`, `source_dependency_hash TEXT`, `phase TEXT` in `reserved`, `initializing`, `child_ready`, `finalized`, `retiring`, `retired`, `quarantined`, nullable `child_receipt_hash TEXT`, nullable `retirement_message_id TEXT UNIQUE REFERENCES durable_outbox(message_id)`, nullable `retirement_receipt_hash TEXT`, nullable `retired_at INTEGER`, `created_at INTEGER`, `expires_at INTEGER`, `updated_at INTEGER`; index `(phase,updated_at)`. | Crash-repairable state machine for creating or retiring one hidden child from a suggestion. Every phase rechecks the workspace deny floor and complete opportunity dependency vector; one scalar connector epoch is insufficient. `retiring` owns a resumable child-cleanup outbox, and only its receipt permits `retired`. It records the initialization receipt before making the directory row visible. |
| `promoted_origins` | `origin_key TEXT PRIMARY KEY`, `reservation_id TEXT UNIQUE`, `workstream_id TEXT UNIQUE REFERENCES workstreams(workstream_id)`, `promotion_receipt_hash TEXT`, `promoted_at INTEGER`, `retire_after INTEGER`. | Durable uniqueness/tombstone preventing two people from promoting the same workspace opportunity into two work streams. |
| `retired_promotion_origins` | `origin_key TEXT PRIMARY KEY`, `reservation_id TEXT UNIQUE`, `opportunity_id TEXT`, `opportunity_version INTEGER`, `workstream_id TEXT`, `terminal_reason TEXT CHECK IN ('revoked','expired','initialization_failed','cancelled')`, `cleanup_receipt_hash TEXT`, `retired_at INTEGER`, `retain_until INTEGER`. | Small non-content tombstone proving an unpublished origin/version was consumed and its hidden child settled. It survives deletion of the bulky reservation/child rows through the idempotency horizon. Retrying product intent requires a new opportunity version and origin key. |

The workspace's table relationships are deliberately local. `workstreams` is
the root for `workstream_cards`, sparse `member_workstream_state`, pins, and
`child_projection_keys`; the latter tables cascade only after the durable
directory tombstone and delayed-message window have been satisfied. `members`
is the root for grants and personal rows. `workspace_events` is downstream of a
successful local mutation and can be rebuilt as a snapshot, but the membership,
directory, pin, and card tables cannot be rebuilt from the replay log.
Membership and directory tombstones live through the maximum grant, offline
snapshot, outbox, migration, recovery, and legal-hold windows. Expired grants
may be removed after their audit window; `workspace_events` is retained only for
the published reconnect window; acknowledged outbox/inbox rows are pruned only
after both replay and reconciliation can no longer refer to them. Suggested
sets are invalidated locally by membership/source epochs and expire with their
source opportunity versions. `promoted_origins` outlives the source opportunity
long enough to preserve exactly-one promotion.

### `WorkstreamDO` SQLite schema

The work-stream object is the canonical owner of one conversation aggregate,
its run state, and facts from which the workspace card and personal overlays are
derived. The physical tables are:

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `workstream` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `workstream_key TEXT UNIQUE`, `parent_workspace_key TEXT`, `parent_do_id TEXT`, `parent_generation INTEGER`, `region TEXT`, `title TEXT`, `description TEXT`, `preview TEXT`, `scope TEXT` in `personal`, `workspace`, `exact_state TEXT` in `scheduled`, `running`, `interrupting`, `preparing_context`, `waiting_capacity`, `needs_input`, `completed`, `cancelled`, `failed`, `budget_exhausted`, `archived`, `deleting`, `restoring`, `state_reason_code TEXT`, `next_sequence_number INTEGER`, `next_attention_ordinal INTEGER`, `authority_epoch INTEGER`, `scope_epoch INTEGER`, `source_authorization_floor INTEGER`, `listing_epoch INTEGER`, `deletion_epoch INTEGER`, `run_revision INTEGER`, `created_at INTEGER`, `last_people_activity_at INTEGER`, `state_changed_at INTEGER`, nullable `completed_at INTEGER`, `updated_at INTEGER`. | Canonical child identity, metadata, state, local counters, and parent fencing values. The source floor rejects stale connector-derived delivery/disclosure decisions but cannot itself prove current authorization. Title/state/activity changes originate here; the parent stores only a versioned projection. Region, keys, and parent relationship cannot change through an ordinary update. |
| `participants` | `user_id TEXT PRIMARY KEY`, `participation_reason TEXT` in `creator`, `explicit`, `message`, `elicitation`, `action`, nullable `added_by_user_id TEXT`, `status TEXT` in `active`, `removed`, `participant_epoch INTEGER`, `added_at INTEGER`, nullable `removed_at INTEGER`, `updated_at INTEGER`; index `(status,participation_reason,user_id)`. | Child scope, subordinate to current workspace membership. Being a participant never restores a member removed by the parent. |
| `grant_sessions` | `grant_id TEXT PRIMARY KEY`, `grant_hash TEXT UNIQUE`, `user_id TEXT`, `membership_epoch INTEGER`, `authority_epoch INTEGER`, `scope_epoch INTEGER`, `source_authorization_epoch INTEGER`, `session_id TEXT`, `issued_at INTEGER`, `expires_at INTEGER`, nullable `revoked_at INTEGER`; indexes `(user_id,expires_at)` and `(expires_at)`. | Bounded cache of parent-issued authority used for socket attachment and child calls. Parent revocation advances local floors and invalidates matching rows/sockets/runs. A cached session never independently authorizes disclosure or acceptance of a connector-derived suggested action. |
| `substreams` | Exact fields and indexes in the dedicated section below. | Defines which conversation exists, inheritance, audience, tool policy, and publish-back behavior. |
| `parts` | Exact fields and indexes in the dedicated section below. | Immutable semantic conversation/control order after finalization. |
| `part_mentions` | Composite primary key `(part_id,mention_index)` with `part_id TEXT REFERENCES parts`, `mention_kind TEXT` in `person`, `connector`, nullable `target_user_id TEXT`, nullable `connector_type TEXT`, `start_offset INTEGER`, `end_offset INTEGER`, `attention_ordinal INTEGER`; indexes `(target_user_id,attention_ordinal)` and `(part_id,mention_index)`, plus shape checks for the selected kind. | Normalized mention index validated against the authored text. Personal parent projections derive from these rows, never by reparsing markdown. |
| `content_refs` | `content_ref_id TEXT PRIMARY KEY`, `storage_kind TEXT` in `r2`, `regional_key TEXT UNIQUE`, `media_type TEXT`, `byte_length INTEGER`, `sha256 TEXT`, `authorization_scope_hash TEXT`, `source_revision TEXT`, `fallback_summary TEXT`, `status TEXT` in `staging`, `ready`, `revoked`, `deleting`, `deleted`, `retain_until INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; indexes `(status,retain_until)` and `(authorization_scope_hash,status)`. | Lifecycle and authorization metadata for large payloads referenced by parts. Authorization precedes both content and fallback summary. R2 bytes are never copied into Workflow state. |
| `member_attention` | `user_id TEXT PRIMARY KEY`, `unread_tracking_start_ordinal INTEGER`, `seen_attention_ordinal INTEGER`, nullable `manual_unread_from_ordinal INTEGER`, `latest_mention_attention_ordinal INTEGER`, `last_seen_at INTEGER`, `version INTEGER`, `updated_at INTEGER`. | Sparse child authority for interest baseline, seen/manual-unread waterlines, and mention derivation. Seen updates are monotonic; explicitly marking unread installs or moves the separate manual floor. A row begins only on participation, open/follow, mention, assignment, or another personal relation—not for every workspace member on every common message. Private chat activity does not enter this table. |
| `runs` | `run_id TEXT PRIMARY KEY`, `substream_id TEXT REFERENCES substreams`, `workflow_instance_id TEXT UNIQUE`, `status TEXT` in `admitted`, `running`, `waiting`, `steering`, `needs_input`, `completed`, `failed`, `cancelled`, `budget`, `attempt_epoch INTEGER`, `model_iteration INTEGER`, `next_action_cursor TEXT`, `input_fence_seq INTEGER`, `revision INTEGER`, `started_at INTEGER`, `active_elapsed_ms INTEGER`, `idle_elapsed_ms INTEGER`, `step_count INTEGER`, `subrequest_count INTEGER`, `retry_count INTEGER`, `tool_count INTEGER`, `input_tokens INTEGER`, `output_tokens INTEGER`, `cost_micros INTEGER`, `output_bytes INTEGER`, nullable `terminal_reason TEXT`, `updated_at INTEGER`; indexes `(status,updated_at)` and `(workflow_instance_id)`. | One durable ledger per full loop. Counters are owner-enforced budgets; Workflow state holds only this row's identifiers and bounded cursors. One partial unique index permits one mutating run per substream. |
| `run_events` | Composite primary key `(run_id,attempt_epoch,event_seq)`; `event_kind TEXT`, `through_frame_seq INTEGER`, `payload_hash TEXT`, nullable `semantic_part_id TEXT`, `received_at INTEGER`; index `(run_id,attempt_epoch,event_seq)`. | Durable executor checkpoint receipt and gap detector, not a second transcript. Payload content lives in active chunks or immutable parts. A stale attempt epoch is ignored. |
| `tool_effects` | `effect_intent_id TEXT PRIMARY KEY`, `run_id TEXT`, `attempt_epoch INTEGER`, `tool_position INTEGER`, `occurrence_key TEXT`, `tool_name TEXT`, `mode TEXT` in `read`, `write`, `request_hash TEXT`, `authority_revision TEXT`, `status TEXT` in `admitted`, `executing`, `completed`, `failed`, `ambiguous`, nullable `result_part_id TEXT`, nullable `provider_operation_id TEXT`, nullable `started_at INTEGER`, nullable `settled_at INTEGER`, nullable `result_hash TEXT`; unique `(run_id,attempt_epoch,tool_position)` and index `(status,started_at)`. | One receipt per intentional tool occurrence. Equal tool input at another position is a different action; retries reuse this row and reconcile before executing again. |
| `terminal_workspace` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `provider TEXT CHECK(provider='daytona')`, nullable `sandbox_id TEXT`, `lifecycle_state TEXT` in `absent`, `acquiring`, `ready`, `busy`, `releasing`, `failed`, `authority_epoch INTEGER`, nullable `last_command_at INTEGER`, nullable `idle_expires_at INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; `sandbox_id` is required in `ready`, `busy`, and `releasing` and absent in `absent`. | Address of the existing Daytona-backed Bind plugin workspace. Acquisition may exist before a provider sandbox ID is returned; the state-dependent shape prevents a fictitious sandbox from becoming authority. It does not make Daytona a conversation or Workflow authority. |
| `terminal_commands` | `command_id TEXT PRIMARY KEY`, `effect_intent_id TEXT UNIQUE REFERENCES tool_effects`, `sandbox_id TEXT`, nullable `provider_command_id TEXT`, `request_hash TEXT`, `timeout_ms INTEGER CHECK(timeout_ms<=900000)`, `status TEXT` in `starting`, `running`, `completed`, `failed`, `timed_out`, `cancelled`, `ambiguous`, nullable `stdout_ref TEXT`, nullable `stderr_ref TEXT`, nullable `exit_code INTEGER`, nullable `result_hash TEXT`, `started_at INTEGER`, nullable `settled_at INTEGER`; indexes `(status,started_at)` and `(sandbox_id,provider_command_id)`. | Stable reconciliation record for bounded Terminal commands. Partial output and possible filesystem effects remain visible after timeout or cancellation. |
| `active_output_turns` | `run_id TEXT PRIMARY KEY REFERENCES runs`, `attempt_epoch INTEGER`, `turn_id TEXT`, `substream_id TEXT`, `status TEXT` in `streaming`, `finalizing`, `resetting`, `durable_event_seq INTEGER`, `durable_through_frame_seq INTEGER`, `next_chunk_index INTEGER`, `started_at INTEGER`, `checkpointed_at INTEGER`, `updated_at INTEGER`; unique `(run_id,attempt_epoch)` and `(turn_id,attempt_epoch)`. | One mutable assistant attempt. The durable event and frame cursors advance only in the transaction that stores all text through the frame. |
| `active_output_chunks` | Composite primary key `(run_id,attempt_epoch,chunk_index)` referencing `active_output_turns`; `text TEXT`, `byte_length INTEGER`, `first_frame_seq INTEGER`, `through_frame_seq INTEGER`, `content_hash TEXT`, `updated_at INTEGER`; index `(run_id,attempt_epoch,chunk_index)`. | Bounded mutable chunks avoid one ever-growing row and token-sized inserts. Finalization atomically emits immutable text parts and deletes the active rows; executor loss resets the entire incomplete attempt. |
| `compaction_jobs` | `job_id TEXT PRIMARY KEY`, `substream_id TEXT`, `projection_key TEXT`, `source_fence_seq INTEGER`, `through_turn_id TEXT`, `projected_input_hash TEXT`, `authorization_revision_hash TEXT`, `status TEXT` in `pending`, `running`, `completed`, `invalidated`, `failed`, `start_part_id TEXT UNIQUE`, nullable `completion_part_id TEXT UNIQUE`, `attempts INTEGER`, `created_at INTEGER`, `updated_at INTEGER`; unique partial index `(substream_id,projection_key)` for pending/running jobs. | Operational lock and retry state around the immutable compaction control parts. New messages never mutate its source fence and never block on this row. |
| `activity_delivery_receipts` | `delivery_id TEXT PRIMARY KEY`, `activity_id TEXT`, `source_revision TEXT`, `source_authorization_epoch INTEGER`, `authorization_selector_hash TEXT`, `request_hash TEXT`, nullable `incorporated_part_id TEXT`, `result_code TEXT`, `received_at INTEGER`; index `(activity_id,source_revision)`. | Makes parent-to-child activity delivery idempotent. The parent checks current normalized selector authority before incorporation and the child rejects an epoch below its floor; the workspace activity ID itself grants no access. |
| `suggested_actions` | Exact fields and indexes in the dedicated section below. | Audience-scoped operational overlay; not conversation content. |
| `projection_keys` | `projection_key TEXT PRIMARY KEY` where the key is `common` or `user:<id>`; `next_version INTEGER`, `last_payload_hash TEXT`, `last_enqueued_message_id TEXT`, `updated_at INTEGER`. | Child-side monotonic sequence for complete parent replacements. Common and each personal key advance independently, preventing an unrelated update from suppressing another key. |
| `workstream_events` | `event_seq INTEGER PRIMARY KEY`, `event_id TEXT UNIQUE`, nullable `recipient_user_id TEXT`, `kind TEXT`, nullable `run_id TEXT`, nullable `attempt_epoch INTEGER`, bounded `payload_json TEXT`, `created_at INTEGER`, `expires_at INTEGER`; indexes `(recipient_user_id,event_seq)` and `(expires_at,event_seq)`. | Cursor-replay log for the foreground child socket. Provider frames may be coalesced before insertion; semantic boundaries and reset/final events are immediate. |

`workstream` is the root identity row. `substreams`, `parts`, and operational
run rows are local children. `parts` is the only completed semantic order;
`part_mentions` is a transactionally maintained query index over validated
authored mention markup, not a third message/content authority;
`run_events`, `tool_effects`, `terminal_commands`, and active-output tables are
receipts or temporary state and may reference a final part, but may not render
as a second message. `member_attention` and `projection_keys` are the precise
bridge from child facts to the workspace's sparse materialized views.
Canonical `parts`, substream lineage, and ready `content_refs` follow the work-
stream retention/legal-hold policy. Active-output rows end at finalization or
attempt reset; socket events end at the reconnect window; expired grants,
settled tool/Terminal receipts, activity receipts, and inbox/outbox rows survive
at least the longest provider, Workflow, migration, and client retry window that
can present their IDs. Content deletion marks the reference revoked before R2
garbage collection, so an old part cannot reauthorize retained bytes.

The `WorkspaceDO` families above retain normalized provider activity, the
ordered activity log, source selectors/targets, watches and automation claims,
delivery outboxes/dead letters, digest cursors, opportunity/provenance/
user-state records, rankings, promotion receipts, and child-feedback receipts.
Regional D1 retains only the opaque workspace/work-stream fleet directory and
migration campaign/job ledger needed for cross-object version, cohort, lease,
cursor, and error queries, plus explicitly product-free telemetry/rebuildable
aggregates. Fleet rows omit titles, descriptions, people, sidebar activity,
mentions, unread state, suggestions, activity content, and conversation data.

### Migration-control Durable Object SQLite schemas

The migration-control hierarchy has three Durable Object types. These schemas
are deliberately smaller than the regional D1 fleet ledger: each control object
serializes a decision or admission boundary, while D1 supplies cross-object SQL
queries. The common administration/delivery tables above are present in each.

#### `FleetMigrationDO`

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `fleet_state` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `control_epoch INTEGER`, nullable `active_campaign_id TEXT`, `state TEXT` in `idle`, `running`, `pausing`, `paused`, `needs_intervention`, `deployment_version_id TEXT`, `next_audit_seq INTEGER`, `updated_at INTEGER`. | Serial fleet command gate. It contains no product region mapping beyond the campaign's allowed-region names. |
| `campaigns` | `campaign_id TEXT PRIMARY KEY`, `manifest_hash TEXT UNIQUE`, `object_class TEXT` in `workspace`, `workstream`, `migration_kind TEXT` in `class_lifecycle`, `schema_lazy`, `schema_sweep`, `online_backfill`, `authority_copy`, `cleanup`, `target_code_version TEXT`, `target_contract_version INTEGER`, `target_schema_version INTEGER`, `target_data_version INTEGER`, `target_projection_version INTEGER`, canonical `allowed_regions_json TEXT`, `state TEXT` in `draft`, `preflight`, `expand_deployed`, `canary`, `ramping`, `verifying`, `committed`, `cleanup_eligible`, `complete`, `pausing`, `paused`, `aborting`, `needs_intervention`, `max_concurrency INTEGER`, `error_ceiling_ppm INTEGER`, `cost_ceiling_micros INTEGER`, nullable `workflow_instance_id TEXT`, `created_at INTEGER`, nullable `committed_at INTEGER`, nullable `completed_at INTEGER`, `updated_at INTEGER`; indexes `(state,created_at)` and a unique partial index on non-null `workflow_instance_id`. | Immutable manifest identity plus fleet-level desired state and ceilings. A draft or failed preflight need not have started a Workflow. Changing manifest content creates a new campaign; it never edits the hash in place. |
| `campaign_approvals` | Composite primary key `(campaign_id,gate,approval_id)`; `operator_subject TEXT`, `artifact_hash TEXT`, `approved_at INTEGER`, nullable `revoked_at INTEGER`; index `(campaign_id,gate,approved_at)`. | Named operator approvals for canary, ramp, commit, cleanup, and exceptional recovery. Subjects are platform operators, not workspace members. |
| `regional_rollups` | Composite primary key `(campaign_id,region)`; `regional_control_do_id TEXT`, `desired_epoch INTEGER`, `acknowledged_epoch INTEGER`, `state TEXT` in `preflight`, `active`, `pausing`, `paused`, `verifying`, `committed`, `aborting`, `needs_intervention`, `complete`, `pending_count INTEGER`, `running_count INTEGER`, `succeeded_count INTEGER`, `failed_count INTEGER`, `deferred_count INTEGER`, nullable `error_code TEXT`, `heartbeat_at INTEGER`, `updated_at INTEGER`. | Product-free aggregate receipt from one regional controller. Counts are monitoring evidence; regional D1/object journals remain migration truth. |
| `fleet_audit_events` | Composite primary key `(campaign_id,event_seq)`; `command_id TEXT UNIQUE`, `operator_subject TEXT`, `event_kind TEXT`, `from_state TEXT`, `to_state TEXT`, `request_hash TEXT`, `result_hash TEXT`, `created_at INTEGER`; index `(created_at,campaign_id,event_seq)`. | Append-only state-transition audit with hashes and enums only—never copied regional error text or object identity. |

An operator command commits the desired fleet state and audit event locally,
then starts or signals the campaign Workflow through `durable_outbox`. The
Workflow input contains only the campaign ID and manifest hash. A lost Workflow
start response is reconciled by the stable `workflow_instance_id`; creating a
second instance for the same campaign is forbidden. Regional rollups arrive as
idempotent complete replacements and do not grant authority to inspect a
workspace.

#### `RegionalMigrationDO`

One object exists per `(campaign_id, region)`.

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `regional_campaign` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `campaign_id TEXT`, `region TEXT`, `manifest_hash TEXT`, `state TEXT` in `preflight`, `active`, `pausing`, `paused`, `verifying`, `committed`, `aborting`, `needs_intervention`, `complete`, `desired_epoch INTEGER`, `max_inflight INTEGER`, `error_ceiling_ppm INTEGER`, `queue_depth_ceiling INTEGER`, `cost_ceiling_micros INTEGER`, `pending_count INTEGER`, `running_count INTEGER`, `succeeded_count INTEGER`, `failed_count INTEGER`, `deferred_count INTEGER`, `created_at INTEGER`, `heartbeat_at INTEGER`, `updated_at INTEGER`; unique `(campaign_id,region)`. | Regional desired phase and pause/drain authority. Counts are updated from shard replacements; they are not used to infer a target object's success without its receipt. |
| `regional_shards` | `shard_id TEXT PRIMARY KEY`, `shard_do_id TEXT UNIQUE`, `state TEXT` in `idle`, `active`, `pausing`, `paused`, `draining`, `complete`, `needs_intervention`, `desired_epoch INTEGER`, `acknowledged_epoch INTEGER`, `inflight_count INTEGER`, `pending_count INTEGER`, `succeeded_count INTEGER`, `failed_count INTEGER`, `deferred_count INTEGER`, `last_message_id TEXT`, `last_replacement_version INTEGER`, `heartbeat_at INTEGER`, `updated_at INTEGER`; indexes `(state,heartbeat_at)` and `(acknowledged_epoch,shard_id)`. | Complete aggregate replacement for each manifest-declared shard. The fixed set is inserted before activation; an unexpected shard cannot self-register into a live campaign. |
| `regional_audit_events` | `event_seq INTEGER PRIMARY KEY`, `command_id TEXT UNIQUE`, nullable `shard_id TEXT`, `event_kind TEXT`, `from_state TEXT`, `to_state TEXT`, `request_hash TEXT`, `result_hash TEXT`, nullable `error_code TEXT`, `created_at INTEGER`; index `(created_at,event_seq)`. | In-region append-only command and pause-drain evidence with enumerated diagnostics. |

The campaign Workflow sends a desired phase/epoch using a stable command ID.
The regional object applies it once, writes one complete command per fixed shard
to `durable_outbox`, and waits for every `regional_shards.acknowledged_epoch` to
converge. It does not declare `paused` merely because its own row changed. Only
after every shard has stopped admission and its in-flight permit count reaches
zero does it commit `paused` and publish the regional rollup to the fleet plane.
This is a message-driven barrier, not a transaction spanning control objects.

#### `MigrationShardDO`

One jurisdictional object exists per manifest-declared `(campaign_id, region,
shard_id)`. It is the first migration component allowed to resolve a regional
job to a target `WorkspaceDO` or `WorkstreamDO`.

| Table | Columns, key, and indexes | Contract |
| --- | --- | --- |
| `migration_shard` | Singleton `id INTEGER PRIMARY KEY CHECK(id=1)`; `campaign_id TEXT`, `region TEXT`, `shard_id TEXT`, `manifest_hash TEXT`, `state TEXT` in `idle`, `active`, `pausing`, `paused`, `draining`, `complete`, `needs_intervention`, `desired_epoch INTEGER`, `acknowledged_epoch INTEGER`, `max_inflight INTEGER`, `inflight_count INTEGER`, `next_replacement_version INTEGER`, `heartbeat_at INTEGER`, `updated_at INTEGER`; unique `(campaign_id,region,shard_id)`. | Local admission authority and pause fence. `inflight_count` changes only with permit state in the same transaction. |
| `migration_permits` | `permit_id TEXT PRIMARY KEY`, `job_id TEXT`, `target_class TEXT` in `workspace`, `workstream`, `target_object_id TEXT`, `command_id TEXT UNIQUE`, `campaign_epoch INTEGER`, `d1_lease_fence TEXT`, bounded `budget_json TEXT`, `request_hash TEXT`, `state TEXT` in `issued`, `started`, `settled`, `expired`, `cancelled`, nullable `result_code TEXT`, nullable `result_hash TEXT`, `issued_at INTEGER`, nullable `started_at INTEGER`, `expires_at INTEGER`, nullable `settled_at INTEGER`; unique `(job_id,d1_lease_fence)` and indexes `(state,expires_at)` and `(target_class,target_object_id,state)`. | Expiring single-use authority for one bounded target RPC slice. Product identifiers remain inside the jurisdictional shard. Settling or expiring a started permit decrements in-flight exactly once. |
| `shard_wake_receipts` | `wake_nonce TEXT PRIMARY KEY`, `request_hash TEXT`, `campaign_epoch INTEGER`, `result_code TEXT`, `received_at INTEGER`; index `(received_at)`. | Deduplicates at-least-once Queue/backstop wake hints. A wake authorizes no object by itself. |
| `shard_replacements` | `replacement_version INTEGER PRIMARY KEY`, `message_id TEXT UNIQUE`, `desired_epoch INTEGER`, `state TEXT` in `idle`, `active`, `pausing`, `paused`, `draining`, `complete`, `needs_intervention`, `inflight_count INTEGER`, `pending_count INTEGER`, `succeeded_count INTEGER`, `failed_count INTEGER`, `deferred_count INTEGER`, `payload_hash TEXT`, `created_at INTEGER`, nullable `acked_at INTEGER`; index `(acked_at,replacement_version)`. | Immutable aggregate snapshots sent to `RegionalMigrationDO`; older versions may arrive late and are ignored there. An unacknowledged snapshot remains retryable and is never overwritten in place. |

The shard first leases a bounded D1 job page under a D1 fencing token. It then
creates each local permit. A crash after the D1 claim but before permit creation
does no target work; the D1 lease eventually expires. To begin a slice, the
target and shard use the stable command ID: the shard atomically changes the
permit from `issued` to `started` and counts it in flight, and the target records
the same command in `_migration_command_receipts` before applying a mutation.
If either response is lost, retry observes one of those receipts. A pause may
allow already issued work to reach `started` while the region visibly says
`pausing`, but the regional controller cannot acknowledge `paused` until every
such permit settles or expires. Thus no slice begins after the paused barrier,
without claiming a cross-DO transaction.

Target settlement updates its local migration journal first and then returns a
hash to the shard; shard settlement and the next aggregate replacement commit
locally. Regional D1 is updated idempotently from the permit/target receipt. A
D1 row, Queue acknowledgement, shard counter, and fleet rollup are all
projections of that chain; only the target journal says that its data changed.
Permit and wake receipts remain through campaign completion plus the maximum
Queue/DLQ replay window. Regional and fleet audits follow the operator/compliance
retention declared by the signed manifest. Cleanup never precedes target-journal
verification, regional/fleet convergence, rollback-window expiry, and an
explicit cleanup approval.

### `substreams`

`substreams` owns which conversation exists and how its model window begins and
returns. Because the database belongs to one work stream, it does not repeat
`workspace_id` or `workstream_id` on every row.

| Column | SQLite shape | Contract |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Local stable ID; `0` is the only main feed. |
| `kind` | `TEXT NOT NULL CHECK IN (main,chat,agent)` | Closed semantic kind; it is not a generic channel type. |
| `inherit_mode` | `TEXT NOT NULL CHECK IN (none,fork,document)` | How the model window begins. |
| `inherit_from_substream_id` | Nullable `TEXT REFERENCES substreams(id)` | Required for `fork` and `document`; absent for `none`. |
| `inherit_fence_seq` | Nullable `INTEGER` | Required and immutable for each fork edge; nullable only for a live document projection. It must name a complete-turn fence in the inherited lineage. |
| `depth` | `INTEGER NOT NULL CHECK BETWEEN 0 AND 4` | Materialized lineage depth validated against the parent on insertion. |
| `return_mode` | `TEXT NOT NULL CHECK IN (none,tool_result)` | Whether closing produces one result for a spawning call. |
| `origin_part_id` | Nullable `TEXT REFERENCES parts(id)` | Spawning tool-call part; required and unique for `tool_result`. The circular foreign key is legal because both tables are created before inserting either row. |
| `owner_user_id` | Nullable `TEXT` | Required for every effective owner-only substream, including an agent spawned from private context. |
| `audience` | `TEXT NOT NULL CHECK IN (owner,workspace,system)` | Requested audience; effective audience is its intersection with recursive parent lineage. |
| `tool_policy` | `TEXT NOT NULL CHECK IN (none,read_only,full)` | Maximum tool authority; a grant and current resource policy may narrow it further. |
| `status` | `TEXT NOT NULL CHECK IN (open,closed)` | Closed substreams accept no new model turns. |
| `created_at`, `closed_at` | `INTEGER NOT NULL`, nullable `INTEGER` | `closed_at` is required exactly when status is closed. |

The main row is exactly `id=0`, `kind=main`, depth zero, no inheritance or
return, workspace audience, and full tool policy. A `chat` always has one owner,
owner audience, no return, and either `document` or `fork` inheritance. An
`agent` always has a recorded origin call and tool-result return; it uses `none`
for a fresh task or `fork` for literal continuation, and its audience is bounded
by its lineage. Foreign keys bind inheritance and origin to rows in the same
work-stream database. Creation rejects unsupported field combinations, cycles,
audience broadening, missing per-edge fences, and lineage depth above four.
Indexes are `(kind,status,id)`, `(owner_user_id,status,id)` for non-null owners,
`(inherit_from_substream_id,id)` for descendants, and a unique partial index on
non-null `origin_part_id`.

### `parts`

`parts` owns what happened. Its rows resemble the content and control parts from
which the projector builds model messages, but remain provider-neutral.

| Column(s) | SQLite shape | Contract |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Stable semantic-part identity. |
| `substream_id` | `TEXT NOT NULL REFERENCES substreams(id)` | Conversation containing the part; defaults to main only at the API boundary, never through an ambiguous database default. |
| `sequence_number` | `INTEGER NOT NULL UNIQUE` | One object-wide arrival/commit order allocated from `workstream.next_sequence_number`. |
| `attention_ordinal` | Nullable `INTEGER UNIQUE` | Contiguous main-feed people-attention order. Non-null only for `substream_id='0'` and people-visible attention-bearing parts. |
| `turn_id`, `turn_open_sequence`, `part_index` | Nullable `TEXT`, nullable `INTEGER`, nullable `INTEGER` | Required together for an admitted user or model-output turn; unique `(turn_id,part_index)`. Pending user input has none until an immutable admission control part groups it. |
| `role` | `TEXT NOT NULL CHECK IN (system,user,assistant,tool,note)` | Provider-neutral semantic role. |
| `kind` | `TEXT NOT NULL CHECK IN (text,tool_call,tool_result,attachment,terminal,steer_request,input_admission,input_cancelled,compaction_start,compaction_complete)` | Closed part kind. Pending suggested actions are deliberately excluded. |
| `author_type`, `author_user_id`, `external_actor_json` | `author_type TEXT CHECK IN (member,agent,connector,system,external)` plus nullable bounded `TEXT` | A member alone may have `author_user_id`; an external actor alone may have canonical address/display JSON. |
| `content`, `content_ref_id`, `content_bytes`, `content_hash` | Nullable bounded `TEXT`; nullable `TEXT REFERENCES content_refs`; nullable `INTEGER`; nullable `TEXT` | Exactly one of inline content or a ready regional reference. A reference requires matching positive size/hash; inline content stays below the selected row budget. |
| `answers_part_id`, `input_part_ids_json` | Nullable `TEXT REFERENCES parts(id)`; nullable canonical JSON array | One tool result answers one call and one compaction completion answers one start. An input control part stores ordered input IDs as one bounded array because order is consumed as a unit. |
| `client_message_id`, `effect_intent_id`, `occurrence_key` | Nullable `TEXT` with kind-specific partial uniqueness | Client retry identity, causal write identity, and read occurrence identity respectively. Equal input hashes are never global action identity. |
| `produced_by_run_id`, `attempt_epoch`, `executor_event_seq`, `model_turn_id`, `tool_position` | Nullable `TEXT`/`INTEGER` provenance fields | `(produced_by_run_id,attempt_epoch,executor_event_seq)` is unique when populated and links the semantic result to `run_events`. |
| `delivery_intent`, `input_batch_id`, `admission_cut_seq` | Nullable `TEXT CHECK delivery_intent IN (queue,steer)`, nullable `TEXT`, nullable `INTEGER` | User input records queue/steer intent. Only admission/cancellation control parts carry the batch identity, immutable cut, and ordered IDs; content rows are not rewritten on admission. |
| `tool_name`, `tool_mode`, `tool_status` | Nullable `TEXT`; `tool_mode` in `read`, `write`; `tool_status` in `pending`, `completed`, `failed`, `ambiguous` | Required only for tool kinds. A pending write call references its pre-recorded `tool_effects.effect_intent_id`. |
| `compacts_through_sequence`, `compacts_through_turn_id`, `projected_input_hash`, `projection_key`, `authorization_revisions_json`, `lineage_fences_json` | Nullable `INTEGER` and bounded `TEXT` | Required on the applicable compaction control part. The source fence is a complete turn and all visibility/resource/lineage revisions participate in eligibility. |
| `terminal_reason` | Nullable `TEXT CHECK IN (completed,needs_input,failed,cancelled,budget)` | Required only for terminal control parts. |
| `visibility`, `pinned` | `TEXT NOT NULL CHECK IN (people,model,both,system)`; `INTEGER NOT NULL CHECK IN (0,1)` | Projection policy. Pinning here means model-context pinning, not the workspace sidebar pin table. |
| `created_at`, `updated_at` | `INTEGER NOT NULL` | Equal for immutable rows except the permitted pending-tool status transition. |

Content and `content_ref_id` are mutually exclusive. A referenced payload may have
a durable summary for bounded degradation, but the part and the selected
representation are authorized first. A summary may replace content only after
authorization succeeds and regional storage is unavailable; it is never a
fallback for denial or revocation. One call has at most one result. One
compaction start has at most one completion. An input appears in at most one
admission batch or one cancellation, and cancellation is legal only before
admission. A write's durable causal intent is created before execution and
reused only for retries or explicit continuation of that same action.
Conversation rows are append-only except the deliberately mutable status of a
pending tool call. Assistant streaming mutates bounded operational active-tail
chunks; normal completion atomically seals their text into immutable `parts`
and removes the operational rows.

Indexes support substream model windows, people-visible transcript reads,
governing compactions by `(substream_id, projection_key, waterline)`, pending
input admission by `(substream_id, sequence_number)`, tool reconciliation,
one active compaction per projection key, producing-run replay, and the unique
total sequence. Partial unique indexes cover non-null `client_message_id`,
write `effect_intent_id`, read `occurrence_key`, answers for tool/compaction
results, and executor provenance. The input-control insertion transaction
validates every `input_part_ids_json` member is an earlier pending user part in
the same substream and that no existing admission or cancellation array already
contains it; schema-conformance tests exercise that invariant even though the
ordered array intentionally remains one model-turn-shaped value.

### `suggested_actions` operational state

Pending suggested actions do not belong in the two-table conversation core
because they are optional workflow overlays, not messages the model or every
participant has observed. The child operational table contains:

| Column(s) | SQLite shape | Contract |
| --- | --- | --- |
| `action_id`, `version` | Composite primary key `(TEXT,INTEGER CHECK(version>0))` | Stable action identity and immutable replacement version. |
| `source_activity_id`, `delivery_id` | `TEXT NOT NULL`; `TEXT NOT NULL UNIQUE` | Opaque parent-workspace source identity and idempotent delivery identity. |
| `audience_kind`, `audience_user_id` | `TEXT NOT NULL CHECK IN (user,workstream)`; nullable `TEXT` | User audience requires exactly one user; work-stream audience forbids it. A higher version may narrow but never silently widen audience. |
| `provenance_ref`, `authorization_selector_hash`, `source_revisions_json`, `source_authorization_epoch` | Bounded `TEXT NOT NULL` for the first three; `INTEGER NOT NULL` for the epoch | Opaque source and canonical membership/connection/resource revision vector. The epoch fences stale cached decisions but does not replace the parent's normalized selector check. |
| `display_title`, `display_body` | Bounded `TEXT NOT NULL` | Authorized display snapshot. It is not a model or shared transcript fallback. |
| `status` | `TEXT NOT NULL CHECK IN (pending,accepted,dismissed,retracted,expired)` | Terminal state never reopens; a higher version is a distinct row and replacement decision. |
| `created_at`, `expires_at`, `resolved_at`, `retracted_at` | Required `INTEGER`, required `INTEGER`, nullable `INTEGER`, nullable `INTEGER` | Pending requires future expiry and no resolution timestamp; each terminal shape has the corresponding timestamp. |
| `resolved_by_user_id`, `resolution_client_id` | Nullable `TEXT` | Required together for accepted or dismissed user resolution and unique as `(action_id,resolution_client_id)` when populated. |
| `share_intent_json`, `authored_part_id` | Nullable bounded `TEXT`; nullable `TEXT REFERENCES parts(id)` | Explicit disclosure target and the newly authored audience-safe main-feed part. Accepting the card alone does not copy its private body. |
| `feedback_message_id` | Nullable `TEXT UNIQUE` | References the durable child-to-parent outbox delivery for workspace feedback. |

Indexes are `(audience_kind,audience_user_id,status,expires_at)`,
`(source_activity_id,version DESC)`, and `(status,expires_at)`. Shape constraints
bind audience, lifecycle timestamps, resolver identity, and explicit sharing.

Any child snapshot that would include a pending suggested action first calls the
parent's narrow `authorizeSuggestedActionDisclosure` RPC with action/version,
recipient, source vector, and the child's source floor. The parent checks current
membership, connection/source epochs, and normalized selector principals, then
returns a short-lived action-specific signed decision carrying the current
`source_authorization_epoch`; failure or parent unavailability omits the card.
Acceptance/dismissal performs the same live check and fails closed. This is a
deliberate RPC only for connector-derived operational overlays, not for ordinary
transcript reads. Parent deny changes advance the epoch before emitting the
best-effort retraction command, so a delayed outbox can affect cleanup but cannot
extend disclosure. Reads and resolutions also use the active child capability.
Expiry and retraction clear personal workspace interest. A private row is
omitted from every shared read by construction rather than returned and hidden
by the client. Retention keeps only the bounded audit fields needed for feedback
and deletion policy after source content has been erased.

### Turn and sequence invariants

1. A sequence number is allocated by the single-threaded `WorkstreamDO` when a
   durable semantic part is emitted. It records arrival and commit order;
   substreams never create a second sequence space.
2. All native parts of a model output turn share `turn_id`; `part_index`
   preserves provider content order inside it. An input-admission part supplies
   the projected user `turn_id`, opening sequence, and ordered inputs. Complete
   logical turns are ordered by `turn_open_sequence`, so a newly admitted user
   turn cannot split an older assistant call from its result.
3. A projection fence, fork fence, or compaction waterline lands only after a
   complete turn. It never separates a tool call from its result.
4. The assistant may produce several adjacent text parts because streaming is
   checkpointed. Projection joins them into the same assistant content segment
   without creating a synthetic final message.
5. Only main-feed parts with people visibility and attention semantics advance
   the contiguous `attention_ordinal`; the full sequence is never used as an
   unread count.
6. Audience and work-stream visibility are checked before every projection,
   transcript, search, export, notification, digest, and debug read.
7. Durable executor checkpoint/semantic events commit exactly once in event
   order for the active attempt epoch and include their `through_frame_seq`.
   Provisional frames may render but are retained upstream. A stale epoch is
   ignored and a gap is buffered rather than guessed.
8. A queued user part is people-visible but excluded from model projection until
   an `input_admission` committed through the fence selects it. A steer request
   changes interruption state but is never itself model content.
9. One admission batch is one logical user turn whose opening sequence is the
   admission control part's sequence. Its ordered inputs preserve
   cross-participant authorship, and its cut makes later arrivals ineligible for
   that turn.
10. A compaction summarizes only the authorized model projection through its
    immutable complete-turn source fence. Later same-substream turns are tail,
    not inputs to that summary, regardless of whether they arrive before or after
    `compaction_complete`.

### Message-array projection

Projection is a pure, versioned operation over a principal, substream, fence,
model family, and template version:

```text
project(substream S, fence F, principal P, template T):
  authorization = authorize(P, S, every referenced resource)
  projection_key = fingerprint(authorization revisions, resource inventory,
                               connector authority, recursive lineage sources,
                               tool policy, model family, renderer, T)

  summary, waterline = eligible completed compaction with greatest waterline for
                       (S, projection_key) whose start, completion, and
                       waterline are all <= F and whose input hash still matches

  base =
    none:     empty
    fork:     recursively resolve literal visible lineage through each edge fence
    document: one authorized rendered transcript-document block from the
              recursively resolved lineage through the document fence or live at F

  own = authorized visible model parts from S through F,
        including user inputs only through their governing admission batch,
        excluding input and compaction control kinds

  emit current system policy
     + governing summary, when present
     + merge(base, own)
         after waterline, plus pinned parts
         grouped into complete logical turns ordered by turn_open_sequence,
         with parts ordered by part_index,
         and mapped into provider-valid roles/content parts
```

The projector validates that every assistant tool call has its corresponding
tool result, that provider role transitions are legal, and that the selected
fence is complete. Failure is an internal invariant violation; the system does
not send a malformed best-effort array to the model.

Compaction first appends a system-only `compaction_start` containing the input
waterline, completed turn, projected-input hash, projection key, authorization
revision vector, and resolved lineage revisions/fences. Only a later system-only
`compaction_complete` answering that start, matching those inputs, and committed
through the requested fence governs a future window. Control rows are excluded
from ordinary projection, so the selected summary appears exactly once. Parts
after the waterline—including messages committed while compaction ran—remain raw
tail and are emitted after the summary when model-admitted. A crashed compaction
therefore leaves a longer prompt, never missing history. If an
authorization-sensitive or live lineage-source revision changes, the summary is
ineligible and the projector uses currently authorized raw history or fails
closed.

### Workspace sidebar projection

After a child commit changes a sidebar field, the `WorkstreamDO` derives a
versioned projection from `workstream`, `member_attention`, `part_mentions`, and
operational assignment/action state. The child advances `projection_keys` and
stores the complete replacement in `durable_outbox`. The parent records its
high-water mark in `child_projection_keys`; it never compares a personal
replacement with a common or different-person version. The parent applies
`workstream_cards` or `member_workstream_state`, `workspace_events`, and the
inbox receipt in one transaction. Deletion in `workstreams` writes an epoch
tombstone that dominates every key so a delayed update cannot resurrect a
removed work stream.

Unsent complete replacements may be coalesced by projection key by marking the
older immutable outbox row superseded. Common title, description, preview,
scope, lifecycle, exact state, attention, and terminal changes publish
immediately. Personal listing eligibility, manual-unread/seen waterlines,
mention, assignment, and notification changes publish only for affected people.
Pin writes go directly to `workstream_pins` in the parent authority. Streaming
assistant text and hidden/tool activity do not publish. Last activity is updated
from attention-bearing people-visible main parts and may be coalesced over a
short interval without changing attention semantics.

The parent stores each common card once and sparse personal overlays separately.
Indexed predicates answer named collections; the storage does not duplicate the
same card body into All, In Progress, Completed, each date bucket, and each
person's interest list. A workspace snapshot serializes an item dictionary plus
stable collection ID lists and independent page cursors. Common and personal
replacement streams share a workspace client cursor only after parent apply,
which is what makes the sidebar and main-screen interest surface converge on the
same snapshot.

## Regional impact

Global and EU use the same classes and contracts but separate regional
deployments, secrets, queues, Workflow bindings, R2 buckets, vector indexes, and
Durable Object jurisdiction selection. An EU request enters the EU regional
hostname and resolves both the workspace and child namespace through
`jurisdiction("eu")`. Location hints are not substitutes for jurisdiction.

The Global plane's stored schema is an allowlist. Adding a field requires a
regional-impact review; absence of a payload body is not enough to classify a
field as non-sensitive. Ordinary authenticated workspace requests do not pass
through Global after activation. Shared provider ingresses retain only their
documented routing envelope and forward accepted deliveries to the owning
regional plane without storing EU workspace content globally.

Workflow inputs and Queue messages contain region plus opaque owner, run, and
record identifiers, never prompts, conversation parts, provider payloads,
credentials, titles, descriptions, member identifiers, or model output. The
regional owner loads the sensitive material after execution begins. Regional
Services, background-trigger placement, outgoing model and tool subrequests,
logs, analytics, support access, and every subprocessor require separate
deployment verification; an EU-pinned DO alone is not an end-to-end residency
claim.

Regional D1 remains during and after this migration only for explicitly
product-free fleet/migration queries, telemetry, and rebuildable aggregates. It
is not copied into one Global database. Provider activity, the first-party
activity log, digests, watches, workspace-local automation matching,
opportunity admission/provenance, suggested-work ranking/feedback, delivery
outboxes, and their dead-letter state remain inside the owning jurisdictional
`WorkspaceDO`; large bodies remain in its regional R2.

## Security and trust model

Knowing a workspace, work-stream, substream, part, or Durable Object ID grants no
access. The regional entrypoint verifies the session and immutable region; the
`WorkspaceDO` verifies active membership and role and issues a short-lived,
operation- and child-bound capability carrying the relevant epochs; the
`WorkstreamDO` verifies that capability, work-stream scope, participation,
substream audience, and tool policy. Capabilities cannot be refreshed at a
child. Membership removal increments the parent's epoch, rejects all new grants,
and durably revokes active child sockets and derived run authority. Internal RPC
inputs are parsed at every hop and carry authority derived by the host, not
chosen by the model.

`audience=owner` is enforced in storage projection and export, not just hidden
in the renderer. A private chat's content does not enter a workspace summary,
another person's compaction, a digest, global telemetry, inference logging, or a
different principal's search. Compaction keys include the visibility
fingerprint and every relevant authorization revision so a summary cannot
launder content across audiences or after resource access is revoked. Recursive
inheritance intersects audiences and rejects any broadening edge.

The same rule applies to child operational overlays. A user-audience suggested
action is authorized before retrieval and never enters shared `parts`, sockets,
search, export, digest, activity title/body, compaction, or model context.
Acceptance is a new disclosure decision, not retroactive permission for the
pending card; current source authority and an explicit target audience are
checked before any shared part is authored.

Large content stays in the owning regional R2 bucket behind opaque references.
References are never URLs or authority tokens. Before either hydration or
fallback selection, projection rechecks the principal, work stream, part,
content hash, allowed kind, resource revision, and size. Authorization denial
fails closed; only an authorized request followed by storage unavailability may
use the bounded fallback. The durable summary is treated as untrusted content,
not instruction.

Tool policy is an upper bound. The normal capability, connector ownership,
approval, idempotency, and record-before-execute checks still apply. A sub-agent
does not gain its parent's credentials merely by inheriting its messages. A
private chat is read-only unless a future explicit product decision broadens it.

Exports and deletion traverse all substreams, referenced payloads, run receipts,
activity incorporations, suggested-action history, and workspace projections.
The parent tombstone precedes or shares the deletion protocol so delayed child,
activity, or suggestion delivery cannot recreate sidebar metadata. Activity and
opportunity retention/delete jobs remove or irreversibly redact the owning
`WorkspaceDO` rows and regional R2 provenance according to their own audience
and legal-retention rules; an opaque receipt is not permission to retain
deleted source content.

## Agent behavior

The model receives one ordered message array projected at an immutable fence.
It never receives raw table rows, storage identifiers without a model-facing
purpose, another audience's substream, or conversation content that arrived
after its fence. Current system policy and tool catalog are generated at
projection time rather than inherited from an old stored system message.

Spawning a sub-agent is a normal recorded tool lifecycle:

1. The parent appends a pending `tool_call` with a stable occurrence key and,
   for an external write, allocates a causal `effect_intent_id` before execution.
2. The owner creates the child substream with explicit task, inheritance,
   audience, depth, and tool-policy fields.
3. The generic run host executes against the child's projection and streams
   ordered events back to the owner.
4. The child appends a terminal part.
5. The owner appends exactly one `tool_result` answering the parent call and
   settles its status.

A retry reads back the existing substream and result. It does not create a
second child or repeat a completed write. The same effect intent crosses retry
attempts only for the same causal action; equal input from a later model turn is
a new intent. A fresh sub-agent receives no ambient main transcript. A forked
sub-agent receives only literal turns through its recursive fenced lineage.
Document inheritance is reserved for evidence-bearing chats, not agent
continuation.

The generic run host owns durable step retry, caller policy, timeout and budget
enforcement, Bind integration, and model/tool execution. Its target adapter
contract supports loading a projection, appending output events, checking the
current input revision, atomically admitting a tool against that revision,
settling a tool, and terminating a run. Every model request and tool execution
is a named durable step. Read and inference steps may retry with deduplicated
owner events; a write records its intent and admission before execution and is
never blindly retried after an ambiguous outcome. The host does not define
work-stream visibility or directly mutate domain storage.

### Full agent-loop lifetime and Workflow step shape

An **agent loop** here is the full execution from owner admission through all
model iterations, tool calls, steering cuts, resumptions, and compactions until
`completed`, `needs_input`, `cancelled`, `failed`, or `budget`. It is not one
human message, one model turn, or one tool call. Avalon must support a normal
two-to-thirty-minute loop and a rare two-hour-or-longer coding/research loop.

One Cloudflare Workflow instance represents that full loop. It does **not** put
the full loop inside one `step.do`. The Workflow is a resumable driver whose
deterministically named durable boundaries include:

1. load/reconcile the owner's current loop ledger and projection fence;
2. execute one provider model request and stream provisional/durable events;
3. commit the model operation outcome and next-action cursor;
4. for each tool occurrence, obtain atomic owner admission, execute under its
   causal effect intent, and durably settle the result;
5. compact or rebuild context through a separately fenced operation when
   required;
6. use `waitForEvent` only when no active provider/tool operation needs a live
   executor; and
7. re-read owner state before the next iteration or terminalize once.

The following Workers Paid limits were verified against Cloudflare's Workflow
limits page as updated June 15, 2026. Product budgets remain below these platform
ceilings; a high limit is not an instruction to consume it.

| Paid-plan limit | Published value | Avalon consequence |
| --- | --- | --- |
| Deployed Workflow script size | 10 MB | Keep the generic host and campaign definitions in measured Worker bundles; enforce Wrangler dry-run size gates. |
| Total scripts per account | 500, shared with Workers | Include regional routers, stateful Workers, and Workflow scripts in one account inventory rather than treating the Workflow quota as separate. |
| Active CPU per step | 30 seconds by default; configurable to 5 minutes | Keep the generic run Workflow at 30 seconds initially. Model and tool waits are I/O, not active CPU; raise only from measured CPU evidence. |
| Wall time per step | Unlimited | Two-to-thirty-minute and rare two-hour full loops are permitted, but retry granularity still requires many steps. |
| Configured step timeout | Authoring guidance: at most 30 minutes | Every attached model/tool step stays at or below 30 minutes; use durable owner settlement plus wait/reconcile for longer operations. |
| Non-stream `step.do` result | 1 MiB | Return bounded references/cursors, never transcript or Terminal output. |
| Event payload | 1 MiB | Steering and wake events carry identifiers/revisions, not projected messages. |
| Persisted state per instance | 1 GB, including streamed step output | Treat this as a failure ceiling; normal Workflow state remains bounded references. |
| Steps per instance | 10,000 default; configurable to 25,000 | Keep 10,000 until measured action/step counts require more; reserve terminalization/recovery capacity. `step.sleep` does not consume this count. |
| Maximum `step.sleep` | 365 days | More than enough for this product, whose elapsed/idle budgets are far shorter. |
| Executions | Unlimited | Admission is constrained by creation, running, queue, subrequest, and product budgets instead. |
| Running instances per account | 50,000 in the Paid limits table | The same page's explanatory prose still says 10,000. Do not hard-code correctness to either number: record the account-confirmed limit, use 10,000 as the conservative release-planning ceiling until Cloudflare confirms 50,000 for the account, and configure a lower product admission cap. Waiting instances do not count. |
| Instance creation | 300/second per account and 100/second per Workflow | Batch starts, rate-limit regional admission, and treat HTTP 429 as non-admission. Creation **and restart** consume this rate. |
| Queued instances | 2,000,000 | Queueing is a pressure valve, not an SLO; Avalon applies a much smaller product queue/age bound. |
| Completed state/log retention | 30 days | Product history and receipts remain in their domain owners and migration-control ledgers, never only Workflow history. |
| Workflow name / instance ID length | 64 / 100 characters | Use short stable Workflow names and opaque hashed instance IDs; validate the documented identifier character set before creation. |
| Subrequests per instance | 10,000 default; configurable to 10,000,000 | Count owner RPC, R2, migration-D1, model, tool, and other service calls in admission. Keep the default until load evidence requires more. |
| Retries per step | 10,000 | Product retry policies stay far lower and side effects still require receipts/reconciliation. |
| Workflow schedules | 100 per account; cron expression at most 256 characters | Agent loops start from durable product admission, not a per-loop schedule. Budget the small number of fleet/digest schedules in the account inventory. |

Cloudflare also excludes Workflows from Workers for Platforms namespaces. The
generic run host and campaign Workflow therefore deploy as ordinary regional
Worker services, not as tenant-dispatched Workers for Platforms scripts.

Instances in `step.sleep`, retry wait, or `waitForEvent` are `waiting` and do not
consume running concurrency. A scheduled Paid-plan instance also has a separate
one-hour cron concurrency budget per firing before it yields to the normal queue.
Cloudflare notes that a very short wait may not transition out of `running`, so
capacity calculations treat short retry/sleep gaps as active time and never add
micro-sleeps merely to release a slot.
Cloudflare says a Workflow instance can run indefinitely provided it stays
within CPU and step limits
([Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/),
[Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/)).

Accordingly, every provider request and attached tool step has an explicit
timeout no greater than 30 minutes. An operation that can exceed that bound is
detached: an idempotent start step records an addressable operation ID in the
domain owner, the Workflow releases its active step and uses a bounded sleep/
reconcile cycle or `waitForEvent`, and a later reconciliation step reads the
authoritative settled state. Completion and steering are durable owner facts
before a best-effort Workflow event; an event sent before the wait, duplicated,
or lost never substitutes for reconciliation. The addressable adapter supplies
live cancellation when safe.

Terminal is a Bind plugin boundary. The `avalon:terminal` implementation uses
Daytona behind `TerminalSandboxProvider`; the Workflow invokes the plugin and
never runs a shell in the `WorkstreamDO`. The owner records the stable tool
occurrence/effect intent and the plugin's sandbox/command settlement so a step
retry reconciles the existing command instead of blindly starting another.

The two-hour case is a **full coding loop**, not one two-hour Terminal command.
It comprises many model iterations and bounded Terminal calls. The current
Terminal contract defaults a command to two minutes and caps it at fifteen
minutes; the Workflow tool step budget, including sandbox acquisition and
reconciliation, remains below 30 minutes. A timed-out or cancelled command
settles with its partial output and possible filesystem effects, and the model
must inspect state before another command. This PRD does not add detached
daemons, background processes, PTYs, or longer per-command limits to Terminal.
Daytona workspace lifecycle, persistence, egress, credentials, residency, and
cost remain governed by the separate Terminal PRD.

Whether the desktop is foreground, background, or closed does not control the
coding loop. The Workflow continues only admitted work, while the Daytona
Terminal lifecycle applies its own active-command and idle-retention policy. A
closed client does not keep a Workflow step or Durable Object active, and it is
not a reason to keep a Terminal workspace warm.

Workflow state contains only bounded cursors, hashes, operation IDs, counters,
and owner/R2 references. It does not accumulate the transcript, Terminal output,
or artifacts. This stays below Cloudflare's one-MiB non-stream step-result and
per-instance state limits and avoids relying on completed-Workflow retention as
product history. Step names derive from stable loop iteration and tool
occurrence IDs; retries return owner receipts, and an incomplete model retry
gets a new attempt epoch after its active text is reset so partial provisional
text cannot become a second canonical answer.

The owner enforces loop-wide elapsed time, model iterations, tool calls, tokens,
cost, output bytes, child breadth/depth, Workflow steps, subrequests, retries,
and terminalization reserve. Admission must keep worst-case planned steps and
subrequests below their configured platform maxima with a reserved
terminalization/recovery margin. Duration alone does not consume steps, and
`step.sleep` is excluded, but a two-hour coding loop with excessive tiny actions
can. Capacity admission also enforces verified account running/creation limits
using the measured arrival rate and active-duration distribution; waiting
sessions release their running slot and show durable `Waiting` state.

The current implementation is not yet this shape. `WorkstreamLoopWorkflow`
wraps `runWorkstreamHarness` in one `run-authorized-bind-loop` step, and
`workstreamWorkflowStepTimeout()` returns one year. Before generic-host cutover,
Bind must expose a checkpoint/resume or next-action driver so model/tool
boundaries become Workflow steps, and the one-year step timeout must be removed.
Unlimited platform wall time makes the present code possible, but does not make
its retry blast radius, runtime-update recovery, steering, or two-hour resource
occupancy acceptable.

Interruption is revision-driven and only steering advances that revision;
queued-only input cannot cancel or invalidate admitted work. The model does not
decide whether new input is urgent or whether an active operation is safe to
cancel. The owner signals the internal per-run `run-control` WebSocket held by
the executing Workflow step; a Workflow event is durable coordination but does
not abort a step already running. The host checks the
revision before starting inference, obtains atomic owner admission before each
tool, checks again after each tool, and checks before continuing a turn. If live
cancellation is unavailable, late inference output from a superseded revision is
discarded rather than appended. The shortest safe outcome is committed: abort,
wait for a safely cancellable tool, record a settled result, or stop as
ambiguous. Only then does the owner append the next input-admission batch and
start its logical user turn.

### Current inference inventory and host boundary

The repository already has more than the main work-stream loop. The migration
must prove the generic contract against the current inventory rather than create
another abstraction that only one feature uses:

| Current inference family | Durable domain owner after this change |
| --- | --- |
| Main work-stream, HyperSight, and inline child-agent loops | `WorkstreamDO` and its substreams. |
| Automation drafting and elicitation loop | Automation-domain record/owner adapter. |
| Live meeting control-tower and final meeting summary | Meeting-domain record/owner adapter. |
| Attachment summary and work-stream naming/description | `WorkstreamDO` through a model-only target adapter. |
| Activity structuring and work-opportunity admission/ranking | The owning `WorkspaceDO` through a model-only target adapter and bounded snapshot/CAS. |
| Activity digest | The owning `WorkspaceDO` through a digest adapter; it no longer needs a synthetic work stream merely to reuse the loop. |

The generic Workflow host is the default for a loop that can outlive an HTTP
request, calls tools, waits for user or provider events, or needs durable step
retry. A bounded model-only inference may still execute in a direct regional
Worker when its caller durably owns admission and retry; it uses the same target
and event contracts so moving it into the host later is mechanical. This keeps
one agent-loop abstraction without paying Workflow orchestration for every
small synchronous classifier.

## Provider configuration

Cloudflare configuration separates the frequently deployed stateless regional
router from the stable stateful Worker that exports `WorkspaceDO` and
`WorkstreamDO`. It adds regional bindings for those classes, the generic agent-
run Workflow, fleet/regional migration control objects, campaign Workflow,
opaque shard-wake Queue/DLQ, jurisdictional `MigrationShardDO`s, regional D1
directory/ledger, regional R2 manifests, and a version metadata binding. The
wake Worker binds only the shard namespace; only the shard may bind regional
D1/R2 and product-object namespaces. Production EU resolution must exercise
those jurisdictional namespaces. Regional Services is used for browser/user
ingress and is not claimed to regionalize a Worker subrequest; local-development
fallbacks do not weaken the production assertion.

The generic run Workflow is configured for one instance per full loop. It starts
with the Workers Paid defaults of 30 seconds active CPU, 10,000 steps, and 10,000
subrequests; each is raised only from measured evidence, never merely because
Cloudflare permits up to five minutes of CPU, 25,000 steps, or 10,000,000
subrequests. No step has the current one-year timeout. Provider and attached-
tool steps stay at or below 30 minutes; longer operations use an addressable
adapter plus Workflow sleep/event wait and owner reconciliation. Terminal calls
use the existing Daytona-backed plugin and its maximum fifteen-minute command
contract, so they never require that longer-operation path. Workflow inputs and
step results contain bounded identifiers, cursors, hashes, and references rather
than transcripts or tool output. Daytona configuration and EU availability
remain governed by the Terminal subsystem's existing regional contract and
fail-closed gate.

Regional admission is configured below both published creation ceilings: 300
creates or restarts per second for the account and 100 per second for this
Workflow definition. Bulk starts use the binding's batch API, stable instance
IDs prevent duplicate logical starts, and HTTP 429 means the loop was not
admitted and must be retried through the durable owner. The release records the
account-confirmed running-instance limit; until Cloudflare resolves its own
50,000-table-versus-10,000-prose discrepancy, planning uses 10,000 and product
admission stays lower. Avalon also enforces a far smaller queue count and age
than Cloudflare's two-million-instance platform maximum so a platform queue is
never presented as a latency guarantee.

Durable Object class lifecycle uses Cloudflare's declarative `exports` only
after a dedicated parity release converts the current legacy migration array.
Lifecycle deployment is separate from per-object SQLite migrations and data
campaigns. The object constructor tracks fast local DDL in a real migration
table because Durable Object SQLite does not support `PRAGMA user_version`.
Heavy transforms use bounded RPC slices. The complete release, inventory,
compatibility, rollback, and realtime contracts are normative in
[`migration-control-plane.md`](migration-control-plane.md).

The EU custom hostname, Customer Metadata Boundary, jurisdictional DOs, D1/R2,
the allowlisted Workflow/Queue wake envelope, log destinations, model providers,
Terminal provider, and connector subprocessors must be verified against the
promised EU boundary before EU cutover. A product without a sufficient
background-execution guarantee remains disabled for EU workspaces rather than
falling back to Global.

Cloudflare documents that opaque Durable Object IDs may be logged outside their
jurisdiction for billing/debugging. They never encode a customer/resource name,
and Avalon does not copy their regional mapping to Global. The transfer is still
treated as pseudonymous platform metadata and must pass the EU/EEA data
inventory, DPA/SCC, retention, support-access, and legal review; jurisdiction is
not presented as eliminating it.

No connector registration or OAuth scope changes merely because storage moves.
Shared callback routes continue using the existing minimal regional routing
directories.

No new Railway, EC2, external scheduler, external WebSocket hub, or always-on
migration process is configured. Daytona remains the existing implementation
dependency of the Terminal plugin under its separate subsystem contract. If a
bounded data transformation needs a runtime that a Worker cannot supply, it may
use a scale-to-zero Cloudflare Container behind the same regional opaque-job
contract; that container is not an authority, coordinator, Terminal backend, or
client socket endpoint.

## Rollout

1. **Introduce authority primitives and measure eligibility.** Deploy the two
   regional object classes in the stable stateful Worker, jurisdiction
   selection, generic run-host contract, writer registry, per-work-stream
   authority epochs, hibernating socket protocol, and Cloudflare-native fleet
   migration plane. Install allocation/version outboxes, regional D1 inventory
   and job ledger, control DOs, fixed jurisdictional migration shards, campaign
   Workflow, opaque shard-wake Queue/DLQ, R2 manifest format, and stale-campaign
   backstop. The wake Worker receives no product binding.
   Convert class lifecycle configuration in an isolated release. Load tests
   publish the parent/child capacity, constructor DDL, socket/reconnect, stream-
   checkpoint, migration-slice, and authorization expiry/eviction envelopes
   before production canary. D1 remains authoritative and no production request
   routes to an unmigrated object. `WorkstreamRoom` and `WorkspaceScheduler`
   remain the compatible legacy socket/alarm paths during this phase; they do
   not acquire any new product authority.
2. **Create the parent membership authority.** Import and continuously shadow
   workspace membership, roles, policy, child directory, authority epochs, and
   revocation outbox into the `WorkspaceDO`. A child must be registered and its
   authorization path verified before its route can change. Sidebar reads may
   remain on D1 until workspace-wide projection parity.
3. **Build and verify child projection parity.** In shadow mode, import selected
   test work streams, project their transcripts and model arrays, and compare
   them with the current user-visible transcript and captured inference
   requests. Import normalization is immutable and audited: a dangling legacy
   tool call receives a synthetic non-executable failure result; an orphan
   result is quarantined from model projection. Normalization never executes or
   retries a historical tool. Shadow objects perform no tools, notifications,
   or writes outside themselves. Socket cursor/reset fixtures prove a client can
   reconnect from `WorkstreamRoom` to `WorkstreamDO`; any pending HyperSight
   wake is reconciled into `due_work` exactly once.
4. **Canary one fenced authority change.** Require every legacy writer to read
   and mutate through the same regional D1 authority-row transaction. Import an
   idempotent snapshot and outbox tail into a side-effect-free child, register
   it with the parent, and compare sidebar keys. Advance `legacy -> holding` so
   acknowledged ingress receives a durable `accepted_pending_migration` hold;
   then enter `closing_hold`, stop acknowledging new ingress, record the final
   hold sequence, and import/verify every held command. Prepare the child
   without exposing it, then publish exactly one D1 CAS to the DO route. The
   first routed request opens that prepared epoch. There is no post-route hold
   release. A late legacy producer is fenced and retries through the current
   route, never silently lost or committed to stale D1.
5. **Switch the workspace control pane.** Build common and sparse per-person
   projections from registered children, derive All/In Progress/Completed/Error
   and personal mention/unread/input collections, and import parent-owned pins.
   The desktop switches both sidebar and main-screen work-stream-of-interest
   reads to the shared workspace snapshot only after authorization, pagination,
   per-key ordering, deletion, and projection parity pass for that workspace.
   The same cohort dual-refreshes the legacy `WorkspaceScheduler` and
   `WorkspaceDO.due_work`, compares due/retry decisions, then switches the native
   alarm only after parity and one deliberately lost-refresh recovery pass.
6. **Migrate on demand and in bounded batches.** Access, a provider delivery, a
   scheduled run, or an explicit operator batch may claim a dormant work stream.
   Fast additive DDL runs lazily before the first object event under new code;
   an explicit schema sweep is required only when fleet convergence matters.
   Large local transforms and D1-to-DO copies use idempotent, checksummed object
   slices and stable-hash cohorts. No deployment enumerates and instantiates
   every `WorkstreamDO`. Campaigns enter `pausing` on their concurrency, error,
   latency, Queue-depth, or cost budget. Every fixed migration shard fences new
   permits and drains/expires already admitted bounded slices before the regional
   state acknowledges `paused`; stale Queue wakes cannot bypass that shard-local
   gate.
7. **Move agent execution.** Route canary work-stream runs through the generic
   host only after Bind exposes resumable model/tool/compaction boundaries and
   the current one-year `run-authorized-bind-loop` step is removed. Exercise a
   two-minute loop, a thirty-minute loop, and a fault-injected two-hour coding
   loop across runtime restart, model retry, repeated bounded Daytona Terminal
   calls, steering, event loss/duplication, and capacity queueing. Then migrate
   other agent loops through their own target adapters. Direct legacy loops
   remain available only for unmigrated authorities during the bounded
   transition.
8. **Move activity and suggestions into each workspace owner.** Add the parent
   connector-domain gate, encrypted credential and normalized resource-ACL
   tables, activity/digest/opportunity tables, R2-before-parent-receipt ingress
   with a same-transaction Queue outbox plus normalization watchdog, bounded
   normalization and claim RPCs, child delivery/outbox receipts in both
   directions, dead-letter observability, source deny epochs, canonical event
   producers, audience-scoped suggested-action delivery/retraction, local
   suggestion sets, and the parent-local promotion gate. Snapshot and tail one
   workspace's legacy D1 rows into `connector_domain_authority=legacy_shadow`
   inside its potentially already-live parent under a separate D1
   `connector_authority` row and connector hold/route-receipt journal. It uses
   the same hold/prepare/CAS mechanics as product cutover but never mutates the
   already-live `workspace_authority` route. The gate, rather than the whole
   object, makes this generation side-effect-free. Shadow-compare
   normalized rows, ordered log cursors, digest windows, ranks, resolutions,
   targets, credential versions, selector grants, and child receipts; then
   prepare the connector domain and route that workspace's ingress/read/write
   paths together. The `connector_authority` CAS receipt atomically opens the prepared connector
   generation on first routed request. After that CAS, D1 is a fenced legacy
   source, not a fallback authority.
9. **Retire legacy authority and coordination.** After every route, provider
   ingress, scheduler, export, deletion, and repair path resolves the object
   authority, stop writing migrated conversation tables. After inventory proves
   no legacy room socket, pending room alarm, scheduler retry state, or caller
   remains, retire `WorkstreamRoom` and `WorkspaceScheduler` in a separate class-
   lifecycle release. Retain immutable migration manifests and tombstones for
   reconciliation. Drop old D1 tables only in a later change after the rollback
   and retention window expires.

Before a work stream is cut over, rollback discards its shadow object and leaves
D1 authoritative. After the atomic route changes, migration is forward-only;
recovery repairs or exports the object rather than silently routing writes back
to a stale D1 copy. Object-local SQLite PITR is an operator-approved emergency
tool requiring an external restore command/bookmark, route and parent-grant
quarantine, a complete replay source, restored current authorization/deletion
floors, a fail-closed external restore-generation check before any restored
unified alarm work, and a fenced reopen; it is not a fleet rollback primitive.
Full fleet mechanics and recovery gates
are defined in [`migration-control-plane.md`](migration-control-plane.md).

## Acceptance

1. A workspace with many work streams loads a complete first page for **Work
   Streams**, recency/date ordering, **In Progress**, **Completed**, and **Error**
   from one `WorkspaceDO` request and no child fan-out. Date labels match the
   viewer's locale while pagination order remains stable. A table-driven test
   maps every exact state/reason to exactly one lifecycle family, including
   ordinary `needs_input` versus an ambiguous external effect.
2. Creating, renaming, messaging, mentioning, marking seen, pinning, running,
   failing, completing, and deleting a work stream converges the sidebar through
   monotonic per-key projection updates, including retry after parent
   unavailability. Reordering full common, Alice, and Bob replacements cannot
   drop one key's update; pin membership and dense order remain parent-owned and
   person-specific. The sidebar and main-screen interest view consume the same
   item and collection revision.
3. Main, private-document, human-fork, fresh-agent, and forked-agent fixtures
   project into snapshot-tested provider message arrays with correct roles,
   content order, tool pairs, recursive per-edge fences, audience intersection,
   and exactly one current system policy. An owner-only chat cannot spawn a
   workspace-visible child.
4. Projection refuses a mid-turn fence, an unanswered inherited tool call, an
   audience violation, a stale or mismatched compaction, and a region mismatch.
5. Compaction failure after its start preserves all uncompacted history; a later
   successful completion governs only at a fence containing both control parts
   and only for its matching authorization and resource revisions. Revoking an
   attachment or connector invalidates its summary; denial never returns a
   `content_ref` fallback.
6. A queued message accepted during inference is visible immediately, does not
   change the active revision, and enters the next input batch after normal
   completion. A steering message interrupts before the next tool. Steering
   during a long Terminal operation produces the correct waiting state, records
   the tool's safe outcome, and resumes without blind write repetition. The
   exact arrival `assistant tool_call -> steering correction -> late tool_result`
   projects as a provider-valid completed tool turn followed by the admitted
   input batch; parallel tool results arriving out of order retain provider call
   order.
7. A disconnected client replays the exact committed part sequence without a
   duplicate final assistant message. Simulated object loss while its executor
   survives rewinds at most one configured provisional checkpoint interval, then
   upstream event replay restores the exact active text. Simulated executor or
   provider-stream loss resets the entire incomplete assistant attempt under a
   new epoch and restarts from the last provider-valid fence; it does not claim
   to reproduce a nondeterministic stream. Neither case loses acknowledged user
   input or a committed semantic boundary.
   Duplicate, stale-attempt, and out-of-order executor events are respectively
   deduplicated, rejected, and gap-buffered. A durable acknowledgement advances
   only in the transaction that stores text through its `through_frame_seq`;
   UI-delivery cursors never let the executor discard undurable text.
   Finalization leaves immutable text `parts` and no competing mutable/final
   message.
8. A sub-agent retry reuses its existing child and tool result. Depth five is
   rejected. Hidden sub-agent activity does not change unread or last-active
   state before its main-feed result lands.
9. Removing a member immediately denies new parent grants, evicts their active
   child sockets and stops derived runs before the next tool. A deliberately
   dropped revocation message cannot authorize beyond the configured capability
   expiry, and ordinary stream traffic never routes through the parent.
10. Two deliberate equal write requests on different days receive different
    effect intents, while retrying one request across attempts returns its one
    receipt. An ambiguous write remains `needs_input` and is not replayed.
11. Migration canaries prove snapshot/tail hashes, immutable malformed-tool
    normalization, idempotent retry, enforced writer-registry coverage, D1
    `holding`/`closing_hold`, target preparation, one route CAS, no post-route
    hold release, and pre-cutover rollback. A blocked legacy tool cannot commit
    under a stale epoch or duplicate its effect. A fleet test shows bounded
    migration without eager object creation. Pause visibly drains already
    admitted shard permits and acknowledges `paused` only after every fixed
    shard is fenced; no stale wake starts later work.
12. EU acceptance proves the EU hostname and jurisdictional workspace, child,
    and migration-shard IDs; regional R2/D1 destinations; the exact non-product
    Workflow/Queue wake schema; the wake Worker's absence of product bindings;
    regional object-ID resolution only inside the shard; the Global schema
    allowlist/retention; and fail-closed behavior for an unsupported regional
    dependency. It does not rely on Regional Services for Worker subrequests.
    The audit separately records Cloudflare's documented external billing/debug
    logging of opaque DO IDs and the approved contractual/legal controls.
13. Load tests cover simultaneous active work streams in one large workspace,
    sidebar projection bursts, jittered workspace-batched digest/audit
    authorization for many members, typical one-to-five-second time to first
    token, ordinary tools measured in seconds, Terminal p95 under one minute,
    and Terminal operations up to five minutes without parent-plane token
    traffic. They publish supported parent and child envelopes, including
    per-provider one-workspace sustained/burst ingress, p95/p99 webhook
    acknowledgement, body size, provider retry horizon, and the interactive SLO
    under that burst. Before a shard facade exists, excess ingress receives a
    documented retryable response and no acknowledgement; the test does not
    attribute protection to downstream normalization batching.
14. Storage accounting demonstrates that durable write count follows bounded
    mutable-tail checkpoints and semantic final parts rather than token deltas
    or UI frames. Tests publish row/index writes, latency, fragmentation, PITR
    growth, provisional rewind, and replay at 250 ms, 500 ms, and one second.
    An inactive historical work stream incurs no periodic wake-up.
15. Capacity tests reject before object storage exhaustion while preserving
    read, export, deletion, and authorized successor creation. Run-host
    saturation displays durable `Waiting for capacity` state and resumes within
    configured admission policy rather than failing or starting duplicate
    Workflows.
16. Multi-user queue tests deterministically admit FIFO messages through one
    recorded cut, preserve individual authorship inside one logical user turn,
    and leave later arrivals queued. Promotion to steering includes earlier
    queued context; pre-admission cancellation, reconnect, duplicate submission,
    and repeated steering signals cannot lose input, admit it twice, or create
    one replacement run per message.
17. Substream conformance tests permit only main, owner-only document chat,
    owner-only completed-turn fork, fresh agent, and forked agent combinations.
    They reject channel, group-chat, reply-thread, run-per-substream,
    storage-segment, and cross-workstream-inheritance attempts. Retries and later
    turns reuse the same semantic substream; only main-feed attention reaches the
    sidebar, and publish-back creates an explicit new main-feed part.
18. A compaction concurrency fixture starts through fence `C`, then accepts a
    queued message, a steering message, assistant checkpoints, and an admission
    batch before completion. Send acknowledgement and realtime delivery do not
    wait for compaction. A valid completion projects exactly as summary-through-
    `C` plus admitted raw tail; pending input remains excluded until admission.
    The same fixture proves benign tail growth keeps the summary eligible while
    attachment revocation, prefix redaction, live-document source change,
    deletion, duplicate completion, and mismatched input hash cannot advance its
    waterline. Concurrent compaction requests coalesce to one active job per key.
19. A targeted mention updates **You Are Mentioned** for only the target, even
    when its personal replacement reaches the parent before the common attention
    replacement. Reading through it clears mention and unread on both sidebar and
    main screen; a stale device cannot restore them. A private or hidden-substream
    mention creates neither signal. Scope narrowing and participant removal
    install the parent deny epoch before acknowledging the child change, so no
    current server response, connected client, pin, or old grant preserves
    listing access. An offline device purges the card on its next authenticated
    contact; the system does not claim remote erasure of already cached bytes.
20. Activity-ingestion fixtures prove exact-byte verification or checkpointed
    polling, `(connection_id,provider,delivery_id)` and normalized-event
    uniqueness across two same-provider installations, regional R2 payload retention,
    R2-before-parent-receipt ordering, parent receipt/outbox before webhook
    acknowledgement, a same-transaction local normalization watchdog that
    survives Queue/DLQ loss, automatically dead-letters at its frozen
    attempt/age ceiling, cancels without releasing dead-letter evidence, and
    can be restarted only as an explicit next replay generation,
    compact `WorkspaceDO` normalization, bounded Queue
    envelopes and parent RPCs, deterministic claims, child
    delivery idempotency, and ordered local `activity_events`. Replays create one
    incorporated part, one log event, and one effect. Poison activity is visible
    in local dead-letter state and can be replayed in a bounded scope. A target
    ID cannot authorize child delivery, and a digest page filters work-stream
    audiences plus current normalized selector/principal rows without D1 or
    child fan-out. A selector hash alone never authorizes a read or effect.
    Provider and child producers cannot double-log one semantic occurrence.
21. Personal connector activity remains visible only to its owner through
    admission, ranking, workspace suggestion set, opportunity start, provenance,
    digest, and feedback. A workspace-audience activity remains resource-
    authorized. No activity title, actor, target, opportunity, or projection is
    stored in Global. Member removal synchronously invalidates the parent's
    authoritative personal set; source revocation advances a local deny epoch
    and masks sensitive display fields before asynchronous cleanup completes.
    Schema-shape tests prove a normalizer cannot attach personal-source content
    to the workspace principal. Credential tests prove ciphertext-only parent
    RPCs, lease/version-CAS refresh, no plaintext Queue/Workflow/log payload,
    and fail-closed use of a revoked or disabled source.
22. Suggested-work tests rank and store a set before the request path, keep
    per-person impression and dismissal independent, and never place an
    opportunity into real work-stream collections. Crashes after the parent
    claim/reservation, child initialization, receipt, or parent finalization all
    reconcile to one initialized child and one opening user turn, with no child
    visible before the parent's final promotion transaction. Every stage
    revalidates the recorded membership epoch and complete normalized source
    dependency vector; pre-publication revocation terminalizes
    into bounded `retiring`, settles one idempotent child-cleanup receipt, and
    leaves a non-content retired-origin tombstone rather than unreachable child
    storage. The old origin cannot retry; a newly admitted version can.
    Concurrent starts by two members with
    different request keys still resolve one workspace-opportunity origin; a
    personal opportunity refuses a different user.
23. Suggested-action tests deliver one pending card to one existing child,
    represent it and one accept/dismiss/retract outcome in the child operational
    table, and project a targeted **Needs Your Input** signal only to the
    assignee. A personal card is absent from shared transcript, export, search,
    digest, compaction, model projection, and other participants' realtime.
    Version, expiry, and current source authorization are checked through the
    narrow live parent disclosure RPC on every read and accept; parent
    unavailability omits the optional card, and a delayed retraction cannot
    extend its visibility. A retraction wins idempotently. Parent feedback eventually converges
    without controlling the open-work-stream read. With contextual routing
    disabled, all producers and readers expose no new pending cards. Acceptance
    shares evidence only through an explicit audience-safe newly authored part
    and never implies external-write approval without an action-specific contract.
24. Storage and deletion tests prove that provider bodies live only in regional
    R2, normalized/query/suggestion/digest state only in the owning
    `WorkspaceDO`, and incorporated content only in its child. Regional D1 has no
    connector-event or suggestion authority. Deleting or narrowing any source
    cannot be undone by delayed activity, suggestion, or child delivery.
25. Fleet-control tests cover a lazy additive table/column migration, an
    explicit convergence sweep, a restartable local transform, parent-before-
    child wire-version expansion, and an authority-copy import from D1/R2.
    Regional inventory reports schema/data/protocol versions and coarse
    operational size/state but contains no title, description, member, mention,
    unread, suggestion, activity text, or conversation content.
    A connector-domain fixture first makes membership/sidebar live, then imports
    connector data under `legacy_shadow`; no ingress, read, credential refresh,
    poll, digest, rank, or effect executes before the exact D1 route receipt
    opens the prepared singleton generation. The fixture proves the independent
    D1 `connector_authority` remains `legacy/holding` while
    `workspace_authority` already routes to the parent, and that connector CAS
    does not disturb the workspace route.
26. A migration failure at every phase proves automatic `pausing` plus permit
    drain, bounded/DLQ retry, pre-cutover abort, compatible code rollback, and
    post-cutover forward repair. A PITR rehearsal records bookmark/command
    outside the target, quarantines route and parent grants before restore,
    proves a complete replay source, reinstalls current authorization/listing/
    deletion/run floors, and reopens with a fenced CAS. No test assumes Worker
    rollback restores storage or that PITR is safe without replay evidence. An
    alarm forced immediately after restore consults the external recovery
    generation and cannot run a tool, notification, projection, outbox,
    compaction, deletion, or retry before reconciliation.
27. Realtime lifecycle tests keep one hibernating socket for the selected
    workspace and one for only the foreground work stream in steady state.
    With A and B both streaming, an A-to-B switch opens B, receives and
    reconciles its snapshot/cursor while A remains live, renders B's latest
    checkpoint and any newer buffered frames, and only then closes A after the
    grace period. Rapid A-to-B-to-A switching never mixes run/attempt caches,
    loses accepted input or committed bytes, duplicates final output, or
    restarts either loop. Injected disconnects, expired cursors, out-of-order
    frames, completion during hydration, and attempt reset all converge by
    snapshot/replay and epoch fencing. Background mode closes the child and
    emits no application heartbeat loop; completion, errors, mention/unread,
    and needs-input still converge through the parent. No authentication or
    liveness timer rotates a healthy socket every two or three minutes.
28. Streaming tests flush the first token immediately after ordinary one-to-
    five-second inference latency, coalesce later events to at most 30 frames
    per second, expose ordinary seconds-long tools, and preserve steering during
    Terminal p95 below one minute and a three-to-five-minute tail without
    coupling frames to SQLite writes. The executing Workflow step receives a
    committed steer over its internal run-control WebSocket when connected;
    simulated control-channel loss falls back to revision fencing and cannot
    admit a new stale tool, while the UI honestly shows delayed interruption.
29. Full-loop tests run representative two-minute and thirty-minute agent loops
    plus a fault-injected two-hour coding loop in one Workflow instance but many
    deterministic steps. They cross a Workflow/Worker restart during model
    streaming, ordinary tool execution, bounded Daytona Terminal calls,
    compaction, and steering. An interrupted incomplete model attempt visibly
    resets under a new epoch; settled tool work resumes from owner and Terminal
    receipts without blindly repeating an external write, losing accepted input,
    or creating a second final answer. No `step.do` timeout exceeds 30 minutes,
    every Terminal command respects its fifteen-minute cap, passive waits release
    running concurrency, Workflow state contains only bounded references/
    cursors, and worst-case action count retains the configured terminalization/
    recovery step reserve. A maximal permitted fixture remains below 1 GB of
    Workflow state, one MiB for every event and non-stream step result, and the
    configured step and subrequest ceilings with an explicit recovery reserve.
30. A concurrency test uses the measured two-to-thirty-minute distribution and
    rare two-hour tail to size regional/account Workflow admission. Saturation
    durably shows `Waiting for capacity`, waiting instances do not retain a
    run-control socket, and admission recovers without duplicate Workflow
    instances or starvation of older resumptions. The test covers account and
    per-Workflow creation/restart rate limits, HTTP 429 as non-admission, the
    product queue count/age bound, and the account-confirmed running-instance
    limit; sleeping, retry-waiting, and event-waiting instances do not count as
    running. Expiry of Cloudflare's 30-day completed-instance history does not
    remove product state or receipts from their domain owners.
31. The workspace/work-stream data, realtime, and fleet-migration architecture
    contains no Railway, EC2, external scheduler, external WebSocket hub, or
    always-on migration service. Daytona remains only the separately governed
    Terminal plugin backend. Any optional heavy data transform uses a bounded
    scale-to-zero Cloudflare Container behind the regional opaque-job contract,
    never gains product authority, and is not a Terminal runtime.
32. A schema-conformance test instantiates every Durable Object class and
    compares `sqlite_master`, `PRAGMA table_info`, `index_list`,
    `foreign_key_list`, and `foreign_key_check` with the versioned manifest for
    every table in this PRD. It exercises each enum/shape/uniqueness constraint,
    singleton row, partial index, cascade/tombstone rule, and constructor
    migration from the oldest supported schema. No implementation-only table is
    permitted without updating this contract.
33. A child-to-parent projection test crashes before and after the child source
    commit, outbox send, parent inbox/card/overlay/event transaction, response,
    and child acknowledgement. Duplicate, missing, reversed, and coalesced
    common and personal replacements converge to the child state; a status
    update cannot erase **You Are Mentioned**, a mention cannot regress status,
    and a deletion tombstone prevents resurrection. The sidebar and interest
    view still load from one parent snapshot without child fan-out.
34. Fault-injection tests cover every row in the cross-object state-machine
    table: revocation, hidden child initialization, opportunity promotion,
    activity delivery, Workflow creation/resume, migration permit/settlement,
    and deletion. Each source fact has a same-transaction delivery intent, each
    destination mutation has a same-transaction inbox/command receipt, changed
    input under a reused identity is rejected, and reconciliation reaches one
    terminal outcome without assuming a distributed transaction.
35. Retention tests prove that pruning replay/outbox/inbox/grant/tool/migration
    receipts cannot precede their maximum retry or recovery window, while
    canonical conversation/product state remains independent of Workflow-log,
    socket-event, R2-body, and migration-control retention.
36. Legacy-object cutover tests migrate a `WorkstreamRoom` socket cursor and
    pending HyperSight wake into `WorkstreamDO` replay/`due_work`, and compare a
    `WorkspaceScheduler` alarm/retry set with `WorkspaceDO.due_work` through a
    lost refresh. Inventory must prove no caller, socket, alarm, or retry state
    remains before either old class lifecycle is retired; crash symbolication is
    unchanged and receives no workspace/work-stream binding.
37. Workspace-schema conformance tests compare every connector-source/ingress,
    activity, effect/delivery, event-log, digest, opportunity, ranking, snapshot,
    and action-feedback table in `WorkspaceDO` with this contract. They prove
    that the same provider delivery and bytes resolve one receipt/activity,
    changed bytes under that delivery ID are rejected, an R2-before-parent crash
    leaves only a reapable orphan, a parent-before-Queue crash is repaired by the
    local outbox/alarm, Queue redelivery returns the existing receipt, and stale
    processing leases recreate no automation,
    event, child delivery, opportunity candidate, or action. D1 schema tests
    prove none of those product tables remain after retention-gated cleanup.
38. Digest-storage tests insert events with tied provider timestamps and prove
    `log_sequence` loses none; atomically insert event targets; freeze a cursor
    while later events arrive; withhold non-digestible machinery; and keep digest
    cursors independent of seen waterlines. Multi-target delivery settles each
    destination independently, reconciles an ambiguous provider operation, and
    reports partial delivery honestly. Membership, participant, connection, or
    resource revocation between brief creation and send prevents stale source
    content from leaving Avalon.
39. Opportunity/action lineage tests follow one connector activity through its
    normalized revision, exclusive effect decision, immutable batch reference,
    provenance graph, per-person ranking, parent suggestion set, hidden-child
    promotion, or existing-child suggested-action delivery. Personal audience is
    preserved at every row and delivery. Reordered or repeated child feedback
    writes one parent receipt and cannot reopen a terminal action, while
    invalidating a suggestion set does not delete its retained local opportunity
    evidence before policy allows.

## Open questions

1. **What exact parent and child capacity envelopes are supported?** This blocks
   production canary, not schema and shadow work. Load testing must set supported
   member, work-stream, socket, sidebar-update, connector-event, burst-rate,
   activity-backlog, digest-batch, SQLite-byte, projection-byte,
   conversation-byte, and run-admission values, plus the high-water marks that
   shed/slow connector ingress or require a separately specified activity-shard
   tier or successor work stream. Any
   future sharding remains behind the `WorkspaceDO`; it never permits client
   fan-out to work streams and cannot ship without its own complete table and
   reconciliation contract.
2. **What are the maximum membership-revocation windows?** Production canary
   requires capability TTL, active-socket eviction, executor cancellation, and
   missed-fan-out recovery SLOs. New actions are denied immediately at the
   parent, but the bounded stale-child window must be explicit and verified.
3. **Which Cloudflare background products can satisfy the full EU execution
   claim at launch?** This blocks EU cutover for the generic run host and any
   content-bearing Queue, Workflow, cron, analytics, model/tool, Container, or
   subrequest path whose processing region cannot be verified. Migration wake
   triggers carry only the reviewed non-product shard tuple and product
   resolution begins inside a jurisdictional DO; Regional Services does not
   localize Worker subrequests. This does not block Global canaries or EU
   storage import in disabled-execution mode.
4. **What product limits apply to one pending input batch?** Before broad rollout
   the product must set maximum queued messages and bytes, steering rate limits,
   batch-rendering limits, and the UI behavior for editing a message after it has
   been admitted. These limits may reject or split a batch but cannot change its
   recorded order or silently drop input.
5. **What compaction scheduling limits prevent cost spikes and starvation?** Set
   token and part thresholds, maximum active projection keys per substream,
   coalescing and backoff windows, maximum `Preparing context` duration, and the
   terminal behavior when rapid authorization or live-document revisions make
   repeated summaries ineligible. These limits may delay inference but never
   message acknowledgement or durable ordering.
6. **What sidebar collection and interest presentation ships first?** The total
   lifecycle mapping is fixed, but decide whether Error has a dedicated heading,
   the exact precedence and caps in work streams of interest, count versus
   boolean unread display, and whether recency uses device timezone or a stored
   member timezone. These are versioned parent/UI rules, not child schema
   changes.
7. **What are the activity, payload, event-log, opportunity, feedback, and
   object-receipt retention periods?** The launch policy must cover per-source
   deletion, connection removal, member removal, legal holds, content-hash
   erasure, regional R2 garbage collection, and expired local suggestion/event
   cleanup without making opaque receipts permanent content proxies. Separately,
   set encrypted credential-envelope/key-version retention and prove plaintext
   never enters migration manifests, Queue/Workflow inputs, logs, or exports.
8. **Which suggested actions exist at launch?** Contextual routing is currently
   paused. Re-enabling it requires product names, action kinds, target/assignee
   semantics, acceptance effects, expiry, notification behavior, and a quality
   gate. Until then the architecture retains the delivery/feedback boundary but
   exposes no new card.
9. **What are the activity and suggestion recovery SLOs?** Set delivery retry and
   dead-letter thresholds, normalization-watchdog interval, maximum sidebar/
   opportunity projection lag, replay authorization, ranking freshness,
   asynchronous stale-set cleanup, and the terminal UX for an opportunity whose
   source is revoked during `Starting`.
10. **What is the offline snapshot authorization lease?** Set its duration,
    screen-lock and local-encryption expectations, behavior after expiry without
    connectivity, and purge proof on the next authenticated epoch change. The
    system cannot promise remote erasure of bytes already downloaded offline.
11. **What are activity authorization batch limits?** Define the event-selector
    and principal snapshot refresh contract, resource-policy revision source,
    deny precedence, fail-closed timeout, digest jitter window, users/events per
    parent request, priority lane, and sharding threshold so digest traffic
    cannot starve membership or sidebar operations.
12. **What are the fleet campaign safety envelopes?** Measure constructor DDL,
    fixed jurisdictional shard count, Queue wake batching, permit TTL/
    concurrency, object RPC slice size, defer-busy policy, error/latency/
    backlog/cost pause-drain thresholds, and approvals needed to resume or
    contract a representation.
13. **What constitutes fleet convergence?** Define directory completeness,
    namespace reconciliation tolerance, observed-version freshness, per-object
    hash verification, and the proof required before removing an old protocol,
    column, table, route, or source database.
14. **What exact Cloudflare-only EU contract is sufficient for migration?** The
    Queue/Workflow wake is the exact non-product shard tuple, its Worker binds
    only a jurisdictional migration shard, and product resolution begins inside
    that DO. Production still requires contractual evidence for jurisdictional
    bindings, triggers, logs, Analytics Engine, and any optional Container;
    Regional Services does not regionalize Worker subrequests. An unsupported
    path remains disabled, not externally hosted.
15. **What heartbeat and background socket policy survives real networks at the
    lowest idle cost?** Test foreground NAT survival in minutes, background
    parent retention versus close-on-background, OS sleep/wake, offline backoff,
    and deploy reconnect storms. There is no periodic reconnect fallback.
16. **What streaming checkpoint policy ships?** Compare 250 ms, 500 ms, and one
    second plus byte/semantic boundaries for row and index writes, SQLite page
    amplification, provisional rewind, upstream frame/event retention, atomic
    text-through-frame acknowledgement, prompt reads, and PITR growth. UI output
    remains capped at 30 frames per second independently.
17. **When, if ever, may migration use a Cloudflare Container?** Define the
    Worker CPU/runtime threshold, scale-to-zero timeout, regional/R2-only input,
    output checkpoint, and residency gate. It cannot become a long-lived
    coordinator, authority, or client WebSocket endpoint.
18. **When is object PITR actually recoverable?** Measure restore throughput and
    require external command/bookmark durability, route plus parent-grant
    quarantine, a fail-closed external generation check before restored alarm
    work, a complete post-bookmark replay source, reinstall of current
    authorization/listing/deletion/run floors, grant rotation, projection
    reconciliation, and a fenced reopen. Without these, repair-forward is the
    supported operation.
19. **What full-loop budgets and concurrency envelope ship?** Measure the real
    two-to-thirty-minute distribution and rare two-hour coding tail, then set
    elapsed, idle-wait, model-iteration, tool, token, cost, output, child, and
    Workflow-step, subrequest, retry, state, event, and result limits; configured
    ceilings/reserves; account and per-Workflow creation/restart rates; product
    queue count/age; account-confirmed running concurrency; active-versus-waiting
    capacity; regional admission; and the user-visible budget/capacity states.
    The current 1,000-model-iteration limit is not proof that its worst-case
    Workflow action count fits below 10,000 or 25,000 steps or its calls fit
    below the configured subrequest ceiling.
