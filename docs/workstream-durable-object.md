# Work-stream Durable Object storage

Avalon has one regional SQLite-backed `WorkstreamRoom` Durable Object for each
work stream. The object name is
`<region>:<workspace-id>:<workstream-id>` in the existing `WORKSTREAM_ROOMS`
namespace. The class and object identities do not change during this migration.

The migration has two distinct inputs:

- the room's old hidden key/value records are moved locally into named SQL on
  first activation; and
- regional D1 work-stream product rows are copied during an announced
  maintenance window, verified, and activated as one authority generation.

Before the regional authority switch, D1 remains the serving authority. Each
WorkstreamDO becomes the local authority when its verified generation is
activated, but it remains unavailable behind the regional maintenance fence.
After the guarded `durable_object_open` switch, the named tables serve the
product and the legacy D1 product tables reject every insert, update, and
delete. Those product tables are already write-fenced when import begins so the
multi-page snapshot cannot drift. D1 then retains workspace authorization and
routing, schedules and connector delivery state, user pins, and rebuildable
common/user directory projections for the sidebar.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Object-local DDL, immutable schema fingerprints, and lazy additive schema application. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Authoritative product repository for reads, mutations, message admission, and sidebar-effect creation. |
| `apps/api/src/durable-objects/workstream-runtime-compat-schema.ts` | Temporary SQL views/triggers that map established repository names onto normalized local tables without storing a second copy. |
| `apps/api/src/services/workstream-runtime-database.ts` | D1-compatible port that sends work-stream-owned statements to the owning object and leaves regional statements in D1. Mixed-authority batches are rejected. |
| `apps/api/src/services/workstream-object-client.ts` | Typed Worker-to-object product RPCs used by REST, queues, schedulers, and connector ingress after cutover. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | Existing KV-to-SQL migration plus current room operations for cursors, active output, due work, ticket receipts, and the transactional regional-effect outbox. |
| `apps/api/src/durable-objects/workstream-regional-effect.ts` | Versioned regional-effect contract, opaque Queue wake-up, and canonical payload hash. |
| `apps/api/src/durable-objects/workstream-authority-import.ts` | Fixed import-stage contract, reset order, page receipts, verification, and activation. It accepts no arbitrary SQL. |
| `apps/api/src/services/workstream-authority.ts` | Regional authority phase reader and HTTP/queue maintenance fence. |
| `apps/api/src/services/workstream-authority-migration.ts` | Bounded D1 source paging, normalization, DO delivery, fleet progress, quarantine, and initial directory projection creation. |
| `apps/api/src/services/workstream-regional-effect-service.ts` | Idempotent regional D1 inbox, projection/activity application, current-recipient resolution, and mention delivery. |
| `packages/db/migrations/0077_workstream_do_authority_cutover.sql` | Regional control/route ledgers, legal phase transitions, drain/open guards, D1 directory projections, and legacy writer fences. |
| `packages/db/migrations/0078_workstream_do_regional_effects.sql` | Regional effect receipts, short-lived notification intents, and projection version/hash guards. |
| `apps/api/src/durable-objects/workstream-room.ts` | Existing sockets, the shared due-work/outbox alarm, and internal import/effect delivery/ack endpoints. |

## Storage ownership

### WorkstreamDO authority

The WorkstreamDO schema stores the product state that is intrinsically owned by
one work stream:

- root metadata, lifecycle, origin, model choice, and sequence allocators;
- participants, viewer attention/read waterlines, and HyperSight preferences;
- substreams, ordered parts, attachments, mentions, and content references;
- runs, immutable run scopes and memory context, lifecycle and inference events,
  plugin activations, tool effects, and checkpoints;
- active output chunks and durable run/event replay receipts;
- compaction jobs/checkpoints and resource-inventory revisions;
- linked resource descriptors, activity-delivery receipts, and suggested actions;
- one-shot wakeups and description-refresh state; and
- the Daytona Terminal workspace, tasks, imported resources, selected repository,
  publication grants, and publication receipts.

The main conversation is substream `0`. Importing the D1 transcript does not
invent substreams: every existing message becomes one `parts` row in substream
`0`, preserving its ID and sequence. New chat/agent substreams may be created
only for an actual isolated model context or child interaction. They are not
folders, UI grouping, participants, runs, or a workaround for large history.

The named local tables are grouped by responsibility below. The column-level
contract, constraints, and indexes live in `workstream-object-schema.ts`; this
catalog explains relationships and ownership rather than maintaining a second
copy of the DDL.

| Local tables | Meaning and relationships |
| --- | --- |
| `_sql_schema_migrations`, `_data_migrations`, `_migration_command_receipts`, `object_versions` | Object-local schema/data versioning and idempotent fleet-import receipts. They never contain product-visible rows. |
| `workstream` | The single root row. It pins the workspace/work-stream identity and authority generation, owns title/description/scope/exact lifecycle, sequence and attention allocators, origin/model/email metadata, and lifecycle timestamps. Every product row belongs to this implicit root. |
| `participants`, `grant_sessions`, `member_attention` | Current explicit participants, bounded grant snapshots, and one viewer's seen/manual-unread/mention waterlines. A workspace membership is still checked in D1; a personal-stream participant decision is local. |
| `content_refs`, `substreams`, `parts`, `part_attachments`, `part_mentions` | LLM-shaped conversation storage. `parts` is the ordered heterogeneous message array for one substream; attachment and mention joins hang off an exact part. `content_refs` points to large R2 content. Substream `0` is canonical chat. |
| `runs`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts`, `run_events` | One durable full-loop record and its frozen authority/context, lifecycle ledger, provider attempts, and replayable execution events. Runs point to a substream and an optional trigger part. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Exactly-once tool plans/checkpoints, attachment-version dependencies, resumable plugin hints, and human-input pauses. They join to a run and, where visible in chat, to a part. |
| `active_output_turns`, `active_output_chunks`, `realtime_state`, `workstream_events` | Reconnect-safe partial inference state and sequenced room events. Chunks bound row size; the active-turn cursor and accumulated text commit together. Final assistant output becomes an ordinary `parts` row. |
| `compaction_jobs`, `compaction_checkpoints`, `description_refresh_state` | Revision-fenced background derivations. A compaction freezes its transcript boundary; later messages remain above that boundary and are never overwritten by the resulting summary. |
| `workstream_resource_links`, `resource_inventory_revision`, `activity_delivery_receipts`, `suggested_actions`, `legacy_artifacts` | Local links to workspace-owned D1 resources, the authorization revision protecting context/replay, connector-activity admission receipts, and work-stream-specific suggestions. `legacy_artifacts` exists only to preserve imported historical rows. |
| `hypersight_configuration_versions`, `hypersight_block_runs`, `hypersight_user_preferences` | Versioned HyperSight execution and per-viewer preferences scoped to this work stream. |
| `workstream_wakeups`, `due_work` | One-shot agent wakeups and the object's bounded alarm schedule. The common directory projection carries only the next due timestamp needed by the workspace scheduler. |
| `terminal_workspace`, `terminal_commands`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | The Daytona-backed coding workspace, command/task receipts, imports, selected repository, grants, and publication convergence for this work stream. Provider execution remains on Daytona; only its durable Avalon state moved local. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Monotonic projection versions plus at-least-once cross-authority delivery. A product transaction writes its D1-bound effect to the outbox; a stable inbox receipt deduplicates inbound commands such as socket tickets. |

The compatibility views named `_runtime_workstreams`, `_runtime_messages`,
`_runtime_harness_runs`, and similar are an implementation bridge for existing
repositories. Their `INSTEAD OF` triggers translate into the normalized rows
above. They do not create legacy-shaped storage and must not be queried as an
independent authority.

### Regional D1 after cutover

D1 remains authoritative for workspace membership and roles, global/regional
routing, connector identities and credentials, schedules/resource watches,
automation definitions and deliveries, email/Slack ingress receipts, audit and
telemetry, user pins, and workspace-owned resources. A WorkstreamDO stores a
resource link and descriptor snapshot, not a second connector credential or
workspace resource catalog.

The D1 `workstreams` row is retained as a non-product identity anchor because
older workspace/control tables have foreign keys to its ID. New post-cutover
anchors set `do_identity_anchor = 1`; product code must not read metadata or
lifecycle from that row. `workstream_create_receipts` makes creation retryable
while the object is initialized, the anchor is inserted, and the first directory
projection is delivered. `workstream_authority_control` and
`workstream_authority_routes` select the generation and deterministic object;
the import-page tables prove the maintenance copy. None is a product fallback.

`workstream_directory_projections` stores common sidebar fields such as title,
description, preview, last activity, lifecycle state, completion, scope, and
system kind. `workstream_directory_user_projections` stores only the viewer
overlay: participation, unread count, `you_are_mentioned`, and listability.
Both rows carry authority generation and monotonic version. They are
rebuildable; they are never a fallback product authority.

The first maintenance import seeds these projections from the frozen D1 source
at bootstrap version `0`; the first object-emitted value starts at version `1`.
After cutover, `commitWithRegionalEffects` writes each versioned projection or
immutable activity/notification intent into `durable_outbox` in the same local
SQLite transaction as its product mutation. Delivery never sits on the user
response path.

The room alarm sends an opaque wake-up through the existing Cloudflare Queue:
region/workspace/work-stream/generation/message IDs and a payload hash only.
Product text and display metadata remain in the regional object. The Queue
consumer RPCs `/internal/regional-effect-delivery` to fetch the envelope,
verifies the route generation and payload hash, then commits the D1 effect and
`workstream_regional_effect_receipts` row in one D1 batch. It finally calls the
originating object at `/internal/regional-effect-ack`; only that acknowledgement
deletes the local outbox row. Queue delivery may duplicate or reorder messages.
Stable message IDs make immutable effects idempotent, while
`(generation, version)` ordering prevents an old common or viewer projection
from overwriting a newer one. A mention also names the exact recipient-directory
version committed ahead of it. The delivery intent waits until that version is
visible; if a later participant-removal/listability projection arrived first,
that newer state wins and delivery is skipped.

Effects have four v1 shapes:

| Effect | Regional result |
| --- | --- |
| `directory_common` | Title, description, preview, lifecycle, last activity, completion, archive, scope, and system kind for workspace-wide sidebar queries. |
| `directory_user` | Participation, unread count, mention flag, and listability for Home and the sidebar's work-streams-of-interest views. |
| `activity_event` | An idempotent first-party `activity_events` row and named targets, used by digests and future notification feeds. |
| `mention_notification` | A short-lived delivery intent. D1 revalidates active membership and resolves the current user, workspace, Slack connection, email address, and work-stream reply address before delivery. |

The same bridge is the only supported WorkstreamDO-to-workspace update path.
Sidebar state, Home lists, notifications, email/Slack delivery, digests, and
cross-work-stream routing do not synchronously query every object:

```text
local product transaction
  -> durable_outbox
  -> WorkstreamRoom alarm
  -> Cloudflare Queue opaque wake-up
  -> regional Worker fetches the effect by authenticated DO RPC
  -> D1 effect + hash receipt commit atomically
  -> Worker acknowledges the owning DO
  -> local outbox row is deleted
```

Common directory projections drive workspace-wide sections such as Work
Streams, In Progress, and Completed. User directory projections drive You Are
Mentioned, unread counts past the viewer waterline, participation, and each
user's work-streams-of-interest list. The resource-link projection is the
workspace-queryable inverted index for connector activity. Suggestion feedback
is projected only for cross-work-stream routing quality; the suggestion body and
lifecycle remain local. First-party activity effects become regional
`activity_events`, where digest and suggested-action systems can scan them
without reading every object.

Token/`stream_delta` frames never create regional effects. A run may project a
semantic state transition such as started, needs input, failed, or completed,
and repeated common/user payloads coalesce in the object before Queue delivery.
The sidebar therefore does not inherit the 10/20/30 fps rendering cadence.

The DO never receives connector credentials or a user's email address.
`workstream_notification_intents.payload_json` exists only while delivery is
pending or retrying and is erased after delivery or a terminal skip, so D1 does
not become a second transcript. Slack and Resend retain their existing stable
message/recipient idempotency keys. After the acknowledgement RPC succeeds, D1
marks its receipt acknowledged; acknowledged receipts and terminal payload-free
notification rows are reaped after 30 days. Pending effects and delivery
failures have no time-based deletion.

## Schema evolution

The constructor runs only local bounded work inside
`DurableObjectState.blockConcurrencyWhile()`:

1. create `_sql_schema_migrations` if needed;
2. compare every applied implementation fingerprint;
3. apply missing additive DDL with `storage.sql`;
4. update `object_versions` only when a code/contract/schema value changed; and
5. run the small legacy KV import or resume its cleanup.

A schema version is immutable after deployment. Changing its SQL without a new
version fails with `workstream_schema_hash_mismatch:<version>`. A data rewrite
does not run in the constructor; it is a bounded `_data_migrations` campaign.

### Existing hidden KV import

| Old key | Named SQL owner |
| --- | --- |
| `roomIdentity` | `workstream` plus main `substreams` row |
| `eventSequence` | transitional `realtime_state` |
| `activeStreamCheckpoints` and numbered text chunks | `runs`, `active_output_turns`, `active_output_chunks` |
| `pendingHyperSightRefresh` | `due_work` |
| `socket-ticket:<jti>` | `durable_inbox_receipts` |

The importer commits the relational copy and `phase = copied`, deletes only
those known key families, then records `completed` and `data_version = 1`. A
restart during deletion resumes cleanup from SQL and never reparses a partial
chunk set. Invalid old values fail closed and remain untouched.

## Maintenance-window authority migration

The maintenance window intentionally removes live tailing, holding queues, and
dual-write reconciliation from the cutover.

```text
legacy_open
  -> maintenance_draining
  -> maintenance_importing
  -> maintenance_verified
  -> durable_object_open
```

`quarantined` is reachable from an importing, verified, or open generation. A
new attempt from quarantine must use a larger generation.

### 1. Compatibility deployment

Deploy the schema/import-capable Worker and apply D1 migration `0077` while the
control row is `legacy_open`. The application continues using D1. Missing
`workstream_authority_control` is tolerated only for this deployment ordering;
other read errors fail closed as quarantined.

### 2. Drain

An operator moves the singleton control row to `maintenance_draining` with a
new generation. Every non-health HTTP request receives 503 with `Retry-After`,
Queues retry rather than being acknowledged, named regional connector/email RPC
entrypoints return retryable maintenance failures, and workspace/room alarms
park for five minutes instead of admitting new work. Existing Workflows may
finish. The transition to import is rejected while any root or inline
`harness_runs` row is still scheduled/running and not terminalized.

The operator must also confirm the Cloudflare Queue has no in-flight consumer
and no external deployment is still running old code. That fact is not present
in D1 and must not be inferred from an empty run query.

### 3. Import

Moving to `maintenance_importing` atomically creates one route row for every
archived and unarchived work stream with its deterministic object name and
`next_sequence_number - 1` source fence. Cron processes at most 100 route
operations per invocation in waves of at most five. That stays below the
Worker invocation's six simultaneous outbound-connection limit and preserves
one slot for control-plane work. Migration and telemetry execute sequentially
during this phase so their connection demand cannot overlap. One object request
may bundle up to 40 consecutive allow-listed stages, while the whole request
still contains at most 200 source rows.

The same phase transition activates D1 triggers that reject every legacy
work-stream product mutation. This closes the scheduler/Workflow/RPC time-of-
check gap at the database linearization point; workspace/control rows that are
not part of the snapshot remain writable.

The first request to an object closes every hibernating WebSocket with 1012,
pins its workspace/work-stream identity, resets only product/transitional rows,
and records the generation. Each subsequent page names one allow-listed source
stage, its exact prior/source cursor, and exact target columns. A
`(generation, stage, source cursor)` receipt makes retries idempotent; the body
hash rejects a reused command ID with different data. Bundled pages commit
independently, so a retry safely resumes at the first uncommitted page.
Arbitrary SQL, table names, or columns never cross the endpoint.

The stage order satisfies dependencies: root and participants; runs/scopes and
run events; HyperSight; transcript parts/attachments/mentions/attention; tools
and elicitations; resource links/compaction/actions; wakeups/descriptions; then
Terminal and publication state.

### 4. Verify and activate

An object verifies all source/target counts, the chained page hash, SQLite
foreign keys, run-lineage references, and the root/message sequence fence.
Only then does its route become `verified`. Any parse, constraint, hash, count,
identity, or delivery failure quarantines the object and regional campaign.

When every route is verified the control row enters `maintenance_verified`.
Cron activates each object locally, changing `authority_mode` from `preparing`
to `authoritative`, and records the route as active. The region deliberately
stays in maintenance after the final activation. Import success is not
permission to expose a new owner: deploy and verify the DO-serving application
path before the operator performs the final one-row `durable_object_open`
transition. The Worker carries a compile-time serving-contract version and cron
attests it into D1 only after every route is active. This import deployment
carries version `0`; it cannot reopen the region. The complete serving
deployment must carry at least the control row's required version (initially
`1`). Both the Worker request gate and the D1 open trigger check that version,
and the trigger also rejects opening unless every route in the generation is
active.

Once open, all legacy D1 work-stream product tables have insert/update/delete
triggers that raise `workstream_do_authoritative`. There is no automatic
fallback to D1. Repair the owning object or quarantine the region; silently
reopening old writers would create two authorities.

## Realtime and streaming

Hibernating WebSockets, serialized socket attachments, auto-response
`ping`/`pong`, and the bounded in-memory replay window remain. The replay window
is an optimization, not a write per token.

The foreground desktop also submits each authored `create_message` command over
that work stream's existing socket. The command carries an operation ID and a
stable `clientMessageId`; the room revalidates the current regional session and
workspace membership on every command, and the persistence layer rechecks
work-stream visibility. A private, unsequenced command receipt tells only the
submitting socket whether the complete write-and-launch operation succeeded.
The canonical `message_created` event is still sequenced, replayable, and
broadcast to every reader, including the sender. The desktop reconciles that
event with its optimistic row but waits for the private receipt before declaring
the send successful.

A transport disconnect does not fail an in-flight send immediately. The desktop
reconnects, subscribes from its last room cursor, and resends the identical
command; message persistence is idempotent on `clientMessageId`, so this cannot
create a second transcript row. It gives up after 120 seconds or when the work
stream is closed or access is revoked. A socket accepted by an older deployment
has no serialized session ID, so its first command receives
`socket_reconnect_required` and closes with 1012 rather than being trusted.
REST message creation remains a compatibility ingress for non-desktop callers.
After contract 1 it invokes the same object-local authoritative transaction and
regional-effect outbox as the socket command. It never delegates a product write
to D1. The socket and REST paths therefore share `clientMessageId` idempotency,
queue/steering semantics, participant updates, and run launch.

Active inference is the durable exception. Batched model frames update the room
cursor, one `active_output_turns` row, and bounded `active_output_chunks` in one
synchronous local transaction. Chunks are at most 60 KiB UTF-8 and never split
a Unicode scalar. Clients may render at 10, 20, or 30 frames per second while
the durable checkpoint cadence remains coarser; they animate the delta within a
batch. At 100 tokens/second for 10,000 tokens this avoids 10,000 rows and avoids
30 durable writes/second. A reconnect receives the current accumulated prefix
before later deltas, so switching between two streaming work streams does not
lose or duplicate text.

## Invariants

- One object is permanently pinned to one region/workspace/work-stream tuple.
- A schema version and an import command ID are immutable once observed.
- Legacy KV is deleted only after its SQL copy commits.
- D1 product rows are writable only in `legacy_open` and during drain; import
  freezes them permanently. Directory projections remain writable after open.
- No import begins until every agent/tool run has terminalized.
- No region opens until every object in the same generation is active.
- No region opens until the deployed Worker attests the required DO serving
  contract; an operator cannot substitute a phase edit for code support.
- The room cursor and active text checkpoint commit together.
- A desktop user message enters through its foreground WorkstreamDO socket; its
  canonical event is sequenced even though its private command receipt is not.
- Retrying a socket command preserves `clientMessageId`; changing it on
  reconnect would turn transport recovery into a duplicate authored message.
- Every message command rechecks the live session and workspace authority;
  socket admission alone is not authorization to mutate indefinitely.
- Every regional side effect commits to the local outbox with its product
  mutation; direct best-effort D1 writes from an authoritative mutation are
  forbidden.
- A regional effect is removed locally only after D1 has durably applied or
  replayed the matching message ID and payload hash.
- Constructor initialization never waits on D1, R2, a provider, or another DO.
- A quarantine never falls back to the old product rows.

## Failure and recovery

- `copied/running` for the KV campaign means cleanup can resume from SQL.
- A D1 import route in `pending` or `importing` is safe to retry; its page
  receipts prevent duplicate inserts.
- `quarantined` requires repair and a new generation. Do not edit target product
  rows merely to make counts match.
- D1 PITR is the source rollback while still in maintenance and before open.
  After open, object PITR/repair is the product recovery path; D1 is only a
  projection/control recovery source.
- Objects activated before the regional open remain unavailable behind the
  maintenance fence. This is safe and intentional.
- Queue retry exhaustion is not data loss: an unacknowledged object outbox row
  re-arms its alarm and republishes. A poison envelope remains visible in both
  the Queue DLQ and the owning object until repaired.
- Equal projection generation/version with different payload hashes raises
  `workstream_projection_version_conflict`; it never resolves by arrival order.

## Cloudflare limit and cost validation

The schema and importer are kept inside the paid-plan Durable Object limits by
executable tests and explicit batch bounds:

| Platform constraint | Design response |
| --- | --- |
| 10 GB SQLite storage per object | One object owns one work stream; telemetry must alert before an individual object approaches the limit. A later archival/export design is required rather than silently splitting one authority. |
| 100 columns per table | The schema test inspects every table and rejects a wider table. |
| 2 MB per row, string, or BLOB | Active output chunks are capped at 60 KiB UTF-8. Imported product rows preserve the already-limited D1 row boundary instead of combining many source rows. |
| 100 bound parameters and 100 KB per SQL statement | Import tests reject a stage with more than 100 target columns; schema tests measure every DDL statement. The current widest import stage has 47 columns. |
| Six simultaneous outbound connections per invocation | Import waves use at most five routes and run separately from telemetry. |
| Billed SQL rows and active object duration | Token deltas mutate bounded chunks at a coarser durable cadence rather than writing per token. WebSockets use hibernation, so an idle background client does not keep object duration billing active. |
| Queue operations | Only opaque semantic-effect wake-ups enter Queue; token frames never do, and replaceable sidebar projections coalesce per common/user key. |

Schema installation runs `PRAGMA optimize` only after applying new DDL. The
constructor does no remote work, and each authority import request is capped at
200 source rows so it remains bounded under the normal request CPU budget.

## Testing

| Suite | Covers |
| --- | --- |
| `test/workstream-object-schema.test.ts` | Complete table manifest, schema hash drift, KV migration/recovery, identity fencing, output chunking, and an import/verify/activate generation. |
| `test/workstream-authority-migration.test.ts` | Every source query against the fully migrated D1 schema and exact normalized target column sets. |
| `test/workstream-regional-effect-service.test.ts` | Unordered sidebar projection application, D1 receipts, activity ingestion, notification resolution, and payload erasure. |
| `packages/db/test/migrations.test.ts` | Phase/drain/open guards, route population, legacy writer rejection, and projection writability. |
| `test/workstream-room-authorization.test.ts` | Socket authorization/revocation on the SQL-backed room. |
| `test/runtime-components.test.ts` | Cursor/checkpoint folding, chunk bounds, ticket receipts, and replay behavior. |

Both regional Wrangler dry runs remain required because Node SQLite does not
prove D1 or workerd behavior.

## Changelog

### 2026-08-17 — Serving contract 1 removes D1 product fallback

**What changed:** REST, socket, Workflow, queue, scheduler, connector, Terminal,
compaction, suggestion, and notification-producing paths now route every
work-stream-owned read and mutation to the normalized SQL database in the owning
`WorkstreamRoom`. D1 keeps only identity anchors, control rows, workspace-owned
data, and rebuildable cross-work-stream projections. The full table catalog and
the regional-effect path are recorded above.

**Why:** Copying rows into SQLite without moving every serving path leaves D1 as
the practical authority and permits the two stores to diverge immediately after
maintenance.

**Considered and rejected:** Permanent dual writes, a read fallback to frozen D1
rows, and synchronous D1 writes inside product transactions. Each creates either
split authority or a cross-system partial-commit window.

**Consequences:** An unavailable or quarantined WorkstreamDO fails closed. Legacy
D1 product-table triggers are now intentional tripwires. Existing repositories
may use the local compatibility views, but new code should prefer typed product
RPCs and normalized local tables. Cross-work-stream behavior must use the durable
outbox/projection bridge.

### 2026-08-17 — Foreground user messages enter through the work-stream socket

**What changed:** The existing hibernating WorkstreamDO socket now accepts
idempotent `create_message` commands, revalidates the session for each command,
and returns a private receipt alongside the normal sequenced canonical event.
The desktop retains an unconfirmed command across reconnects and resends it
with the same client message ID.

**Why:** The foreground work stream already owns the ordered realtime channel
used for its transcript and active inference. Sending the mutation over a
separate REST request created two transports for one interaction and left a
dropped response with no protocol-level way to distinguish an uncommitted write
from a committed message whose acknowledgment was lost.

**Considered and rejected:** A WorkspaceDO socket for user messages would route
every foreground mutation through an unrelated object before reaching its
single work-stream authority. Treating `message_created` as the command receipt
was also rejected because that event is broadcast before harness launch, so it
cannot prove the complete operation succeeded.

**Consequences:** Socket attachments carry the verified regional session ID,
old attachments reconnect before their first write, private receipts remain
outside room replay ordering, and the 120-second client timeout bounds an
unconfirmed send. Reconnect resends the same `clientMessageId`, which converges
on one local part and one run. Contract 1 performs the transaction directly in
the owning object.

### 2026-08-17 — Durable regional effects feed sidebar and notifications

**What changed:** Authoritative WorkstreamDO mutations gain a transactional
local outbox. A regional Queue bridge applies versioned common/user directory
projections, first-party activity events, and mention-delivery intents to D1,
then acknowledges the originating object.

**Why:** Moving product authority into one object per work stream does not move
workspace-wide queries, user identity, notification preferences, connector
credentials, or email delivery into that object. A synchronous post-commit D1
call could be lost, while a D1-first call would expose metadata before the
canonical mutation existed.

**Considered and rejected:** Direct best-effort D1 calls, synchronous external
notification delivery inside the object, and using D1 as a second product
writer. The first loses failures, the second couples user latency and secrets to
the object, and the third reintroduces split authority.

**Consequences:** Sidebar and notification state is eventually consistent with
the object, but durable and replayable. Queue order is irrelevant. D1 stores
only query projections, activity records, receipts, and short-lived delivery
payloads; the WorkstreamDO remains product authority.

### 2026-08-17 — Maintenance-fenced D1 to WorkstreamDO authority migration

**What changed:** The existing one-workstream-per-object namespace gains the
complete work-stream-down schema, a fixed staged D1 importer, regional route and
phase ledgers, hard drain/open guards, initial sidebar projections, and
post-cutover D1 writer fences. PRDs used during the architecture exploration
were removed; this module document is the maintained implementation contract.

**Why:** Copying data without changing every authority path would leave D1 as a
silent second writer. The accepted maintenance window makes one frozen snapshot
and one verified fleet generation cheaper and safer than dual writes plus a
live tail across many independently activated objects.

**Considered and rejected:** A new DO namespace would copy object identities for
no storage benefit. Lazy per-object D1 imports in constructors would hold input
gates across network I/O. A live migration would require holding queues, route
CAS, tail reconciliation, and conflict policy. Automatic opening immediately
after import was rejected because data verification does not verify the serving
Worker.

**Consequences:** The regional maintenance window lasts through drain, import,
verification, activation, and the serving deploy. The import deployment's
serving-contract version is intentionally zero, so it cannot be opened by
mistake. One bad object quarantines the campaign. After open, D1 product writes
fail loudly and recovery never silently changes authority.

### 2026-08-16 — Existing room KV moves into named local SQL

**What changed:** Identity, room sequence, active output, HyperSight due work,
and socket receipts migrate from hidden KV into explicit local tables.

**Why:** The namespace was already SQLite-backed, but unstructured values had no
inspectable constraints or independently evolvable data migration ledger.

**Considered and rejected:** Continuing free-form KV and allocating a new class.

**Consequences:** Old objects pay one bounded lazy migration and all current room
operations use the named SQL owners immediately afterward.
