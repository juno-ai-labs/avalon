# Workspace, work-stream, and substream Durable Objects

Rally's regional stateful hierarchy is `WorkspaceDO -> WorkstreamDO ->
{SubstreamAgent, BlockDashboardAgent}`. There is one `WorkspaceDO` per
workspace, one non-agent `WorkstreamDO` per work stream, one `SubstreamAgent`
per independently addressable model context, and one `BlockDashboardAgent`
per stable configured HyperSight block. The main conversation is external
substream `0`.

AutomationAgent is a sibling product authority rather than another node in this
work-stream hierarchy. It installs the same
[ordered transcript schema](ordered-transcript-sqlite.md) for its draft
conversation, and provisions private SubstreamAgent-backed work streams for
accepted runs. See [`automation-lifecycle.md`](automation-lifecycle.md).

`BlockDashboard` is the internal architecture and protocol name for the
user-facing **HyperSight** feature. Durable Object classes, bindings, object
names, SQL tables, RPC contracts, socket audiences, and `/block-dashboard`
routes use the internal name; rendered labels, accessibility copy, and model-
visible product copy continue to say HyperSight.

All four Durable Object classes in this subsystem (`WorkspaceDO`,
`WorkstreamDO`, `SubstreamAgent`, and `BlockDashboardAgent`) use SQLite-backed
namespaces and explicit SQL only.
Durable Object key/value persistence is forbidden by lint. `WorkspaceDO` is the
authoritative cross-work-stream directory and inverted-index owner, first-party
activity/digest log, connector-event store, and complete suggested-work product
authority. It also owns connector credentials and workspace-local handoff,
Terminal egress policy history, automations/digests/schedules,
resources/notes/watches and R2 lifecycle references, memory, and external
delivery attempts. Regional D1 retains identity/membership, opaque ingress and
object routing, migration controls, and bounded audit/telemetry; it does not
serve workspace product state or transcripts after cutover.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/names.ts` | The only constructors for deterministic workspace, work-stream, and substream object names. |
| `apps/api/src/durable-objects/workspace-do.ts` | Authoritative workspace product database, work-stream directory, hibernating synchronization/command socket, typed product SQL RPC, local product alarm, bounded topic replay, and one-time workspace-ticket receipts. |
| `apps/api/src/queues/access-revocation-consumer.ts`, `apps/api/src/services/access-revocation.ts` | The only way an open socket is closed for lost access: a queue message per object, and the `revokeSocketAccess` walk it drives. Owned by [`access-revocation.md`](access-revocation.md). |
| `apps/api/src/durable-objects/workspace-product-schema.ts`, `workspace-product-storage.ts` | Strict WorkspaceDO activity, opportunity/provenance, ranking, and resolved-suggestion schema plus its transaction/lease repository. |
| `apps/api/src/durable-objects/workspace-domain-schema.ts`, `workspace-runtime-sql.ts` | Strict schemas for connector/Terminal/automation/digest/resource/note/memory/delivery domains and the transactionally executed trusted SQL RPC. |
| `apps/api/src/durable-objects/workspace-notification-intent-protocol.ts`, `workspace-notification-intent-storage.ts` | Runtime-validated notification claim/transition/maintenance RPC contract and the private WorkspaceDO SQL state machine behind it. |
| `apps/api/src/services/workspace-runtime-database.ts` | Allowlisted D1-compatible adapter: WorkspaceDO tables use native RPC, underlying control tables use D1, and mixed-authority transactions fail closed. |
| `apps/api/src/services/sidebar-reads.ts` | The one statement and row mapping per sidebar list, used by WorkspaceDO's batch read and by the REST services that route back into it. |
| `apps/api/src/workflows/work-opportunity.ts` | Retryable admission and ranking compute using fenced WorkspaceDO RPC inputs and settlements. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Runtime-validated typed RPC contracts for cross-work-stream lists, visibility, scheduling, resource lookup, routing, feedback, and child effect application. |
| `apps/api/src/durable-objects/workstream-do.ts` | Non-agent aggregation of child directory/user effects, HyperSight configuration and refresh fan-out, complete metadata WebSocket snapshots, and the regional delivery outbox. |
| `apps/api/src/durable-objects/substream-agent.ts` | Authoritative substream SQL, direct Bind loop, hibernating feed socket, streaming checkpoints, timers, pending-input delivery, and child-to-parent effect RPC. |
| `apps/api/src/durable-objects/substream-loop-storage.ts` | Singleton loop lifecycle, execution-epoch and lease fencing, prepared-input admission/delivery state, subordinate execution receipts, and exact assistant-turn sequence reservations. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | One durable Bind execution owner per stable HyperSight block, including dispatch recovery, keep-alive, fenced source-runtime access, resumable token checkpoints, hibernating block sockets, and result settlement. |
| `apps/api/src/durable-objects/durable-agent-runtime.ts` | Shared reference-counted keep-alive and single-flight drain primitives used by both agent Durable Objects. |
| `apps/api/src/durable-objects/agent-run-dispatch-queue.ts` | The HyperSight block agent's leased dispatch claim and row-derived wake-up calculation. Substream execution is owned by `substream_loops`, not this queue. |
| `apps/api/src/durable-objects/block-dashboard-protocol.ts` | Runtime-validated WorkstreamDO control, block dispatch, result, and maintenance-import contracts. |
| `apps/api/src/durable-objects/rpc-result.ts` | Shared typed native-RPC status/body envelope used where former internal HTTP handlers must preserve status semantics without `stub.fetch()`. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Normalized `SubstreamAgent` schema and append-only schema versions. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts`, `workstream-transcript-protocol.ts` | Canonical transcript facts, participant and exact Bind-loop orderings, snapshot-fenced ranges, activity intervals, compaction replacement, and the typed object port. |
| `apps/api/src/durable-objects/workstream-harness-run-storage.ts`, `workstream-harness-run-protocol.ts` | Subordinate execution receipts, attempt leases, terminal settlement, provider-attempt accounting, and typed telemetry reads. |
| `apps/api/src/durable-objects/workstream-semantic-realtime-outbox.ts` | Object-local sequenced references that commit with transcript/pending mutations and are hydrated, broadcast, dashboard-scheduled, and acknowledged afterward. |
| `packages/contracts/src/workstream-transcript.ts` | Socket-safe ordered turn, block, mention, attachment, external-actor, range, and activity schemas. |
| `apps/desktop/src/renderer/lib/transcript.ts` | Flattens canonical ordered blocks into participant-visible rows and composes explicitly identified transient overlays at protocol-declared anchors. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Product transactions, message/run admission, read waterlines, compaction inputs, and local regional-effect creation. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | SQL repositories for replay, active output, alarms, inbox/outbox receipts, and projection versions. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | Shared SQL-only constructor migration runner. |
| `apps/api/src/durable-objects/migration-reporting.ts` | `withMigrationReport`, which wraps every constructor's migration call and reports the outcome to `avalon-migration-tracker`. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| `apps/api/src/lib/durable-object-namespace.ts` | The only product-object stub resolver; applies jurisdiction, persisted workspace affinity, explicit singleton fallback, and runtime jurisdiction validation. |
| `apps/api/src/lib/durable-object-self.ts` | Where an object recognizes *itself* — by the id a name resolves to, against the id it has held since its constructor — so a shared helper addressing "the object that owns this work stream" reaches the caller directly instead of leaving it over RPC and coming back. Every Durable Object class registers here in its constructor. |
| `apps/api/src/runtime/local-authorities.ts` | The one boundary where an object declares what it owns about a work stream — its messages, resources, harness runs, receipts, scheduling, blocks, identity rows, and Terminal — installed on the environment a run is handed, so no port below has to discover whether its authority is local. Holds the ownership rule the endpoints enforce. |
| `apps/api/src/lib/uuid-v7.ts` | RFC 9562 UUIDv7 generation for cross-socket/Queue event identities; ordering correctness remains in authority-local waterlines. |
| `apps/api/src/services/workstream-object-client.ts` | Typed Worker-to-`SubstreamAgent` product RPCs. |
| `apps/api/src/services/workstream-regional-effect-service.ts` | Queue consumer handoff into WorkspaceDO for directory/user/feedback/activity/notification effects. |
| `apps/api/src/durable-objects/workspace-scheduler.ts` | One SQLite-backed alarm coordinator per workspace; due workspace products are loaded from WorkspaceDO. |
| `scripts/eslint-rules/durable-object-sql-storage.mjs` | Rejects Durable Object `get`, `put`, `delete`, `list`, and async `transaction` KV calls, including aliases. |
| `scripts/eslint-rules/durable-object-region-routing.mjs` | Rejects direct/aliased namespace construction and use of the low-level region-only resolver. |
| `scripts/eslint-rules/durable-object-native-rpc.mjs` | Rejects internal Durable Object `fetch()` calls; HTTP `fetch()` remains for WebSocket upgrades and genuine HTTP flows. |
| `scripts/eslint-rules/durable-object-sync-transaction.mjs` | Rejects explicit or type-resolvable Promise-returning callbacks passed to `transactionSync`, `commitRuntimeMutation`, or `commitWithRegionalEffects`. |
| `packages/db/migrations/0043_hypersight.sql` | Immutable deployed HyperSight baseline; its complete filename is the migration identity and must not change. |
| `packages/db/migrations/0078_rename_hypersight_to_block_dashboard.sql` | Forward-only rename from the deployed `hypersight_*` D1 vocabulary to internal `block_dashboard_*` identifiers. |
| `packages/db/migrations/0079_workstream_do_authority_cutover.sql` | Maintenance control, routes, import receipts, identity anchors, and permanent legacy-product/pin writer fences. |
| `packages/db/migrations/0080_workstream_do_regional_effects.sql` | Legacy causally fenced notification-intent shells; the activity/mention effect replay receipt is object-local (`workspace_workstream_effect_receipts`), never a D1 row. |
| `packages/db/migrations/0081_workstream_do_full_serving.sql` | Serving-contract attestation and idempotent workspace-driven work-stream creation receipts; it intentionally creates no directory projection tables. |
| `packages/db/migrations/0082_workspace_durable_object_placement_affinity.sql` | Immutable Global/regional workspace affinity projection and migration/background fallbacks. |
| `packages/db/migrations/0083_workspace_product_do_authority.sql` | Per-workspace product import routes plus permanent D1 writer fences for the migrated activity and opportunity families. |

## How it works

### Ordered transcript authority

Main `SubstreamAgent("0")` owns one canonical transcript substrate. Semantic
payloads and facts are stored once; two projections reference them:
`transcript_sequence` orders participant-visible conversation turns and safe
status entries, while `loop_sequence` orders the exact protocol messages Bind
consumes. Participant rows and Bind rows are indexes over shared facts, not two
transcript sources. Projection-only content is separate only when it is truly
different, such as a participant-safe tool summary versus an exact tool result
or a safe compaction status versus the private replacement.

Participant turns retain the source part's client identity, author user or
validated external actor, and message type. Each participant text block hydrates
its canonical mentions, ordered message-local attachment descriptors, and
validated structured content from the turn's root fact and the
`participant_transcript_mentions` and `participant_transcript_attachments`
relations. The transcript carries presentation-safe metadata, not resource
bytes. Human turns freeze the author's ID, display name, and avatar URL at
admission; the desktop never substitutes a later mutable member profile for
canonical authorship. The message-local
attachment JSON is immutable; the stable work-stream resource row it names may
be renamed, watched, or otherwise updated before delivery and is reused rather
than overwritten or treated as an admission conflict.

Every Bind transition is committed before the adapter returns the accepted
assistant or tool-result message to Bind. At every provider boundary the host
reconstructs the exact array, including the freshly rendered system message,
and requires its canonical SHA-256 to equal the array about to be sent.
Compaction atomically records the private checkpoint, generation replacement,
and safe status transition. Two compactions therefore create two immutable
events while the current loop head advances twice.
`bind_loop_heads` is the only current Bind metadata row. Current ordered message
facts reference it directly. The object validates that small head before reusing
its immutable in-memory suffix chain, so an ordinary append inserts one message
row and reservation-only transitions touch no message row; eviction recovery
and provider-boundary verification are the deliberate full-history reads. The
suffix chain is local to the object/harness call and is not exposed through the
transcript RPC or JSON serialization.

Terminal side effects use an exact internal turn lookup against
`canonical_conversation_turn_details`. They do not page through recent messages
or read the active streaming checkpoint. A connector reply is therefore a
projection of a saved participant-visible turn; when terminal state names no
turn, external status may settle but no reply body leaves Rally.

Anything that can yield while constructing a transcript payload is prepared
before `commitRuntimeMutation`. Its callback is synchronous: it inserts the
prepared canonical fact, advances transcript and root state, and derives the
regional directory effect within the same `transactionSync` commit. Returning
an async storage method's Promise from that callback does not extend the
transaction; it lets the projection commit before the method's post-`await`
writes. Preparation therefore carries immutable inputs into the callback, which
re-checks the attempt, lease, authority generation, or source revision that may
have changed while preparation was in flight.

Participant turns, activity changes, and pending-input admission/removal also
advance the room cursor and insert a reference into the object's existing
durable outbox in that same transaction. Delivery hydrates the canonical row;
it does not persist a second transcript payload. The outbox row is removed only
after the frame has been offered to the room and, for a turn change, the
HyperSight refresh intent is durable. A crash in any later window therefore
replays the same room sequence, while a lower pending canonical sequence holds
back ephemeral stream/presence frames. Reconnect snapshots remain the recovery
authority and client cursors make a repeated sequence idempotent.

Schema v32 verified the canonical transfer and removed the original payload
owners. Schema v33 is the final relational boundary: it adds canonical
conversation metadata, rebuilds every remaining foreign key against
`participant_transcript_turns(turn_id)`, moves attachment
and mention relationships to canonical turn-keyed tables, and deletes the
temporary `workstream_message_records` identity shim and compatibility view.
The v32 boundary had first verified row-for-row equality of the former message,
attachment, mention, and compaction owners against their canonical facts and
projections before removing the original payload tables, views, receipts, and
operator RPCs. That object-local fail-closed guard and the one-time fleet
transfer that satisfied it are historical deployment evidence, not a runtime
read or repair path.

Participant history is read through snapshot-fenced half-open ranges. Opening
creates one fence and returns the first-unread conversation turn with up to five
conversation turns on either side, plus the latest five conversation turns.
The admitted feed socket keeps that fence in its hibernation attachment, so it
survives object eviction but disappears with the reader session instead of
accumulating in an append-only table or depending on an arbitrary TTL.
Safe status entries inside either sequence span are included without counting
against those conversation limits. Each answer reports the interval it
inspected even when no row was returned, so the desktop can distinguish an
empty covered interval from an unknown gap. Range, unread-anchor, latest-tail,
active-activity, and exact-loop reads have query-shape indexes in the object
schema.

Activity edges are durable and nestable: response, assistant turn, plugin,
tool call, thinking, and compaction activities carry UTC interval boundaries,
monotonic revisions, and a snapshot-time elapsed baseline for active intervals.
Opening returns only lifecycle rows referenced by its two loaded islands and
active turns, plus active ancestry. Later range replies carry the lifecycle rows
their turns reference, and interval hydration is one bulk query rather than one
query per historical activity. No clock ticks are streamed. An admitted socket or REST boot performs one
participant authorization decision and reuses it for all transcript slices and
hydration; socket session validation remains the separate connection check.

### Object hierarchy and identity

Names include region for operator clarity and deterministic routing:

```text
WorkspaceDO       <region>:<workspace-id>                    in WORKSPACE_DOS
WorkstreamDO      <region>:<workspace-id>:<workstream-id>    in WORKSTREAM_DOS
SubstreamAgent 0  <region>:<workspace-id>:<workstream-id>    in SUBSTREAM_AGENTS
SubstreamAgent N  <region>:<workspace-id>:<workstream-id>:<substream-id>
HyperSight block  <region>:<workspace-id>:<workstream-id>:block-dashboard:<block-id>
                                                              in BLOCK_DASHBOARD_AGENTS
```

The name is not a residency boundary. Staging and production first restrict the
namespace to `us` or `eu`, derive the ID from that restricted namespace, and
only then call `get()` with the workspace's persisted first-placement affinity.
At workspace creation, request longitude selects `wnam`/`enam` within the US
jurisdiction or `weur`/`eeur` within the EU jurisdiction. The Global binding,
regional workspace row, and `WorkspaceDO.workspace_identity` retain that value;
every descendant lookup reads the regional immutable projection. The same name identifies a
different object in an unrestricted, US, and EU namespace. `WorkstreamDO` has
the same logical suffix in a different binding; binding, jurisdiction, and name
together determine the Durable Object identity.

The main child deliberately retains the historical logical object name under
the `SUBSTREAM_AGENTS` binding. Because this object graph has not shipped,
Wrangler registers only the final class names in one initial migration; there
is no `WorkstreamRoom` class rename or predecessor storage namespace to retain.
The maintenance import populates the locked target graph from frozen D1, then
scrubs the imported workspace-product rows before activating each route, and
never serves an unrestricted predecessor as fallback.

`WorkspaceDO` owns workspace synchronization/commands, all workspace-scoped
product domains, and the authoritative cross-work-stream directory. `WorkstreamDO` owns aggregate metadata plus
HyperSight configuration, refresh fan-out, and published block state; it never runs a model. `SubstreamAgent` owns its
transcript and full conversation loop. Each `BlockDashboardAgent` owns the
durable execution lifecycle for one stable dashboard block. An external
substream ID is immutable once recorded in
`substream_agent_identity`; an object addressed under another ID fails closed.

Existing product data migrates into main child `0`. The current product exposes
only that main context. A future feature may provision another child only when
it needs a genuinely independent ordered message array and agent loop; it must
reserve its deterministic identity in the `WorkstreamDO` control plane and
initialize the child before issuing a socket ticket. The route shape alone is
not permission to create an empty child.

### Control plane and data plane

`WorkspaceDO` and `WorkstreamDO` are the low-volume control plane. They admit
workspace commands, own workspace resources/policies/product scheduling and directory aggregation, coordinate
HyperSight refreshes, and provide the authoritative list/sidebar path plus the
parent outboxes for notification and regional delivery effects. `SubstreamAgent` is the
fine-grained data-plane shard for one ordered conversation and agent loop;
`BlockDashboardAgent` is the independent execution shard for one derived
dashboard block.

The Worker routes feed WebSockets, transcript reads, stream checkpoints, and
other high-volume substream operations directly to the named child. It never
proxies those operations through either parent, so one busy workspace or work
stream cannot serialize unrelated child data planes. Parent updates travel in
the other direction as versioned, idempotent child effects.

Rally uses deterministic `idFromName` identities, so a separate opaque
child-ID mapping is unnecessary. The active main child is recorded by the D1
authority route and converges into `WorkstreamDO.substream_directory` with its
first common projection. When product creation for non-main children is added,
the parent must record the child identity before direct access is issued so
listing and deletion never depend on discovering objects by namespace scan.

### When substreams are appropriate

A substream is a model-context and concurrency boundary. Use one when all of the
following are true:

- it has its own ordered message array and replay cursor;
- its agent may run, stream, compact, steer, and own timers independently; and
- its output can be aggregated into one parent work-stream state.

Do not create a substream for a UI folder, a participant, a tool call, a model
turn, a Terminal command, a retry, a compaction checkpoint, a sidebar section,
or merely because the main transcript is large. Those are rows inside the
owning child. Excessive substreams multiply sockets, SQLite databases, alarms,
projection traffic, and authorization surfaces without creating a useful
context boundary.

HyperSight blocks are not substreams. They do not own a user-visible ordered
message array, accept user messages, or compact independently visible history.
Their direct desktop socket carries only block state/result and resumable token
output, never the source conversation feed. They are stable derived views over a fenced source
transcript. Making one a `SubstreamAgent` would invent a second conversation and
blur user-authored history with unattended dashboard computation.

### Desktop synchronization and command paths

The desktop holds four independent hibernating WebSocket roles:

```text
one persistent workspace connection
  <-> WorkspaceDO synchronization/command socket
  <- authoritative cursor-paged work-stream directory
  <- versioned workspace query-topic invalidations
  -> create_message naming the target work stream/substream

one connection per active, pinned, recent-five, live-state, or retained work stream
  <- WorkstreamDO complete independently waterlined common + viewer metadata

one substream `0` connection for the same proactive and retained work-stream set
  <- SubstreamAgent snapshot / stream frames / product events
  <- direct download and reconnect feed for exactly one substream

one connection per configured HyperSight block while its panel is visible
  <- BlockDashboardAgent run snapshot / stream checkpoint / result
  <- direct reconnect replacement; no source conversation or user commands

user create_message after creation
  -> persistent WorkspaceDO socket
  -> per-command D1 session + membership recheck
  -> WorkstreamObjectClient for the selected SubstreamAgent
  -> local SQLite message/run transaction
```

The workspace socket is opened once per authenticated Electron renderer after
regional session/workspace activation and survives work-stream navigation. Its
SQL owns the workspace directory and contains monotonically increasing topic
waterlines for all other workspace modules. Each event also has a UUIDv7 trace
identity. A reconnect coalesces every missed topic into one newest-waterline
event when the bounded log is available and otherwise invalidates every
workspace query surface; intermediate invalidation states are not product data.
Directory page requests and their cursors resume through that same socket;
Electron does not fall back to a D1 work-stream list. A user message is never accepted on either read socket; a
`create_message` sent there receives `workspace_socket_required`. This keeps
workspace authorization and routing at the parent boundary while keeping the
high-volume read/stream path direct to its child.

The same persistent workspace socket carries explicit foreground presence. Each
hibernation attachment records whether Rally itself is foregrounded and which
work stream, if any, is foreground in that renderer window. WorkspaceDO
validates that work stream against its local viewer directory, reconstructs the
present-user set from all healthy attachments, and sends each connection only
the set for its own foreground work stream. The recipient's user ID is omitted.
Presence is not inferred from the selected work stream's retained metadata or
feed sockets: those remain open in the background precisely to make switching
instantaneous. There is no presence SQL table, alarm, timeout, or expiry guess;
healthy attachments survive hibernation and socket close/error removes their
contribution.
Current Electron feed subscriptions explicitly set `publishPresence: false`,
and the work-stream UI ignores the legacy `presence_changed` event. Older
clients that omit the field keep its compatibility default, but WorkspaceDO is
the sole presence authority for the current client.
No presence state or recovery travels over REST. The existing HTTP ticket
exchange may establish the WebSocket, but every presence update and snapshot
after that handshake is a non-replayed socket frame.

A window that only listens is never re-checked against D1. A socket is authorized
when it connects and then holds until something closes it; no publish path asks
D1 whether the person may still listen, and no object re-checks on a timer. Two
different things can close it. Losing access to the *workspace* is a D1 fact, so
it arrives as a queue message. The one
thing that closes an open socket is a message on the access-revocation queue,
which the Worker that wrote the retraction publishes and a consumer carries to
each object's `revokeSocketAccess`. That method closes the person's sockets with
`WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE` and returns the children the object knows
about, which the consumer turns into further messages. See
[`access-revocation.md`](access-revocation.md) — it is the only mechanism for
that, and nothing here is to grow a second one.

Losing access to *one work stream* is a different fact, held in that object's own
SQL, and the object enforces it itself: `WorkstreamDO.broadcastMetadata` and
`broadcastBlockDashboardEvent` close a socket whose `canRead` has gone false, and
`SubstreamAgent` does the same when an event narrows visibility. These read no
D1 and add no round trip. Without them a reader excluded by a scope change keeps
receiving the live transcript, the title, and the preview until the window
closes, which can be days.

All four socket roles use short-lived, audience-specific, single-use tickets. The
edge Worker verifies the signed ticket and passes only verified headers to the
object. `WorkspaceDO` consumes tickets in `workspace_socket_ticket_receipts`,
`WorkstreamDO` uses `workstream_socket_ticket_receipts`, and `SubstreamAgent`
uses `durable_inbox_receipts`. Each `BlockDashboardAgent` uses
`block_dashboard_socket_ticket_receipts`. A ticket for one purpose cannot be replayed
or used for another.

New work-stream creation is deliberately not a client-side create-then-send
sequence. The desktop's idempotent `POST /workstreams` includes the opening
message. The regional creation coordinator reserves the D1 route/receipt and
email address, then initializes WorkstreamDO and main `SubstreamAgent("0")` with
metadata, audience, attachments, the opening message, and first run. Only later
messages use the already-open WorkspaceDO socket, so a broken second client
request cannot leave an accidental empty work stream.

The WorkspaceDO invalidation catalog covers workspace profile/timezone and
inference logging; member/user directory; invitations; connector identities,
capabilities and health; Terminal access/network policy; digest settings;
automations/drafts/subscriptions; notes; resources and watches; connector
activity; work opportunities/suggested actions; work-stream directory and its
Active/In Progress/Completed, pinned, unread and You Are Mentioned views;
viewer preferences; and effective feature gates. Regional D1 remains authority
only for identity/member/invitation/profile, routing, migration and operational
rows. Product producers mutate WorkspaceDO through typed RPC and append the
affected topic after commit; Electron refetches through its existing
authenticated contract, whose repository is routed back to the same object.

The WorkstreamDO snapshot covers ID/workspace, title/title state, description,
preview, email, origin, creator, automation IDs, planned time, exact/normalized
state, attention baseline, activity/completion/archive/create/update times,
scope/system kind, next wakeup and Terminal action. The viewer overlay covers
participation/listability, unread count, mention state, whether this person has
never opened the work stream (`unseen`, see
[`workstream-markers.md`](workstream-markers.md)), read-through and manual
unread waterlines, and latest mention sequence. It is always a full snapshot;
nullable values clear cached fields rather than behaving like absent patches.

### Full agent-loop execution

Each `SubstreamAgent` owns exactly one durable Bind loop for its entire
lifetime, whether that loop is executing or idle. A message, reconnect, retry,
or wakeup never creates another loop. The loop singleton is its lifecycle and
fencing authority; execution receipts, provider attempts, and tool effects are
subordinate evidence for one activation and may not be used as loop identity.
Bind remains the loop implementation; Rally does not depend on the Agents SDK.

The two execution boundaries are normative. A **step** is one accepted model
response plus settlement of every tool call it already emitted. The persistent
**loop** spans steps and alternates between executing and idle. Steer input is
eligible after a step; queued input is eligible only after the loop reaches
idle. Stop requests prevent another step but do not cancel an in-flight model
request or tool effect. Ordinary work-stream Stop writes only the singleton's
`stop_requested_at` and `stop_after_step_ordinal`; `runs.cancellation_requested_at`
is reserved for subordinate child or generic execution cleanup and is not loop
control. Model, permission, plugin, and tool-surface changes also take effect
only at the next safe step boundary.

Expected wall time is 2–30 minutes. Time to first token is normally 1–5 seconds,
ordinary tools take seconds, and a Daytona Terminal action may take 3–5 minutes
although p95 is expected below one minute. Rare coding sessions may run for more
than two hours. The durable loop, execution lease and receipt, tool receipts,
reserved assistant turn, and canonical transcript—not an in-memory promise—are
the recovery authority for all of those durations.

`substream_loops` is the child-local execution coordinator. Its executing row
names the activation, epoch, lease owner, lease deadline, cycle, step, and Bind
state revision. Recovery keeps the activation and cycle, increments only the
execution epoch after the old lease expires, and resumes from persisted Bind
state. Compaction generation is a separate Bind projection value and never
changes the loop cycle or makes a pending steer stale.

`runs` remains as a subordinate execution receipt. A linked non-terminal row
stores the exact execution context needed to restart one provider/tool attempt,
but its run ID is never the loop ID. Alarms derive recovery from the executing
singleton, its lease, and linked non-terminal receipts. Callers only admit an
input or request activation; they do not hand correctness to an abandoned
in-memory promise. `run_steering` and the SubstreamAgent-local
`agent_run_dispatches` table are retired. The identically named HyperSight
block-agent dispatch ledger remains a separate authority.

`WorkstreamLoopWorkflow` and its binding are gone: every work-stream run
executes inside the SubstreamAgent, and a stack whose authority is not
`durable_object_open` is refused with `workstream_authority_not_open` rather
than routed to retired code. Non-workstream agent loops keep their generic
Workflow abstraction; the retirement changed only the work-stream-down runtime.

### HyperSight block agents

A refresh starts in main `SubstreamAgent("0")`, which debounces transcript
changes and freezes a provider-valid model-array interval. Its lower boundary is
the exact completed compaction checkpoint identity and content hash, or array
start when no eligible checkpoint exists. Its upper boundary is the highest
canonical semantic sequence before any pending tool call; a completed tool row
is a legal upper fence because projection emits its assistant call and tool
result together. The source sends this complete fence in one `schedule_refresh`
control RPC to `WorkstreamDO`; it does not enumerate blocks itself. The parent
owns the configuration version and therefore atomically creates one block run
and durable dispatch-outbox row per non-empty configured block.

Each outbox row resolves a stable `BlockDashboardAgent` name using the
workspace's jurisdiction and placement affinity. That object runs the complete
read-only Bind loop directly. It does not use the Agents SDK or a Cloudflare
Workflow. `BlockDashboardAgent` talks directly to `SubstreamAgent("0")` through
typed transcript, run, receipt, and block-dashboard ports. It resolves the
transcript fence there and stores the harness attempt, scope, inference
attempts, tool receipts, and terminal runtime record beside the source data they reference. The block DO's
own SQL dispatch row is the durable execution and recovery boundary, so an
eviction does not require the parent or source to retain an in-memory promise.
It permits at most one unsettled running dispatch. When a fresher refresh
arrives, all older queued dispatches are durably terminalized as
`block_dashboard_run_superseded`; the current running dispatch is allowed to settle
and only the newest queued refresh remains eligible to start. This bounds stale
paid inference without pretending an already-started provider call can be
atomically cancelled. Freshness is a causal tuple of configuration version,
source trigger sequence, source creation time, and stable run ID—not child
arrival order. WorkstreamDO also enforces per-block head-of-line delivery, so a
retried older outbox row cannot arrive after and displace a newer row.

Executable queued/running rows and terminal-result settlement receipts use
separate drain lanes. Fresh inference is selected before stale terminal receipt
retries; a failed result RPC leaves a terminal row with its own retry deadline
and never reserves the single running slot. This keeps a long settlement
backlog from starving the newest useful refresh.

Results settle in the opposite direction to `WorkstreamDO`, not to the source
feed. The parent accepts only increasing, hash-consistent result versions and
updates its authoritative dashboard run. Live queued/running/terminal state and
token output travel directly from the execution owner to Electron; the initial
socket snapshot includes the committed full checkpoint, so reconnect replaces
rather than concatenates partial text. Thus the exact paths are:

```text
SubstreamAgent("0") -- trigger + transcript fence --> WorkstreamDO
WorkstreamDO -- versioned durable fan-out --> BlockDashboardAgent(block-id)
BlockDashboardAgent -- typed object ports --> SubstreamAgent("0")
BlockDashboardAgent -- versioned result settlement --> WorkstreamDO
BlockDashboardAgent -- state + stream checkpoints --> Electron
```

Block authorization is intentionally outside the checkpoint hot path. Admission
checks current regional membership plus WorkstreamDO's strict block/viewer
authorization RPC, then records the decision time in the hibernation attachment.
A live socket is not revalidated afterwards: it holds until the
[access-revocation queue](access-revocation.md) closes it, or the block itself is
removed from the configuration, which WorkstreamDO still sweeps for at the
configuration-change site. Token/checkpoint broadcasts therefore remain
object-local; they do not issue a D1 or parent RPC per frame.

This is intentionally not a direct source-to-block dispatch. The source owns
message order, not block configuration, user preference, block status, or
workstream-level WebSocket state. Giving it the fan-out would duplicate the
parent's configuration and outbox or make refresh correctness depend on a hot
transcript object. The direct source/block relationship is the high-volume
data path; the parent remains the low-volume control and publication plane.
Saving a new block configuration follows the same rule: WorkstreamDO commits a
singleton, coalescing `block_dashboard_source_refresh_outbox` row before contacting
main `SubstreamAgent("0")`. A crash after configuration commit therefore delays
the refresh but cannot silently lose it.

### Keep-alive without the Agents SDK

`DurableAgentKeepAlive.keepAlive()` and `.while()` are a narrow custom port of
the useful Agents SDK lifecycle behavior shared by `SubstreamAgent` and
`BlockDashboardAgent`. The first reference ensures an alarm no later than 30
seconds; nested long operations share it; the final idempotent disposer
recomputes the alarm only from durable work. The in-isolate drain is
deduplication only: it never suppresses persisted scheduling, and its result is
awaited by the invocation that started it rather than left to `waitUntil`.
Runtime ping/pong is handled by WebSocket auto-response and does not wake the
object.

A keep-alive heartbeat is a separate Durable Object event. When it observes an
already active drain it never awaits that promise: joining would carry the alarm
across a model/tool loop that belongs to another request context, hold unrelated
alarm lanes open, and can invalidate later request-scoped I/O. It instead arms
a heartbeat no sooner than 30 seconds, excluding the already-due run row from
that calculation so the alarm cannot spin at `now + 1` while the run remains
active. Recent in-memory drain progress or an unexpired durable harness attempt
lease proves the owner is still healthy, including legitimate multi-hour runs.
After five minutes without progress, the agent checks durable execution state;
only when no live lease remains does it abandon the stranded promise and start
a fenced successor. The late predecessor cannot clear the successor because
the single-flight promise and persistent execution epoch are identity-fenced.
For a substream, recovery increments `substream_loops.active_execution_epoch`;
the block agent retains its separate dispatch lease and reads the source
WorkstreamDO's runtime lease.

The keep-alive alarm lowers the chance of eviction during a long model request,
external API wait, or computation. It is not correctness state. If a substream
is evicted anyway, the loop lease/epoch, linked execution receipt, persisted
Bind head, tool receipts, streaming checkpoint, and reserved final-turn slot
drive recovery. A HyperSight block uses its own `agent_run_dispatches` ledger.

### Streaming and reconnect

Provider token fragments are coalesced before reaching the child. The current
batcher flushes at 2,048 characters or after approximately 100 ms of arriving
fragments (10 frames/second under a continuous stream), matching the lowest
allowed 10/20/30 fps presentation choice. Tool/status boundaries flush pending
text first, and a route reset is always a standalone frame.

Each accepted `stream_started` or batched `stream_delta` receives a monotonic
room sequence and updates `active_output_turns` plus bounded
`active_output_chunks` in the same SQLite transaction. The cursor therefore
cannot advance past text that was not checkpointed. Final assistant text is
stored once as the canonical Bind conversation turn whose root fact owns the
payload, and the active checkpoint is removed. Run settlement adopts that same
turn; it never authors an aggregate copy.
Token frames never write regional D1 and never update the sidebar.

Streamed assistant bytes are presentation-only until the provider response is
accepted. A failed or interrupted attempt clears its overlay and materializes a
small typed failure pill at the already reserved transcript position; arbitrary
partial prefixes never become canonical assistant messages. Retry or provider
fallback is allowed only before any assistant bytes are published and before
any tool effect begins. Once output or an effect is observable, failure closes
the step and a later attempt is a new step. An already-started tool is allowed
to settle and persist its receipt; stop never claims to cancel or roll back its
external effect.

Compaction uses the same ordered publication boundary but no token checkpoint.
`compaction_started` writes the singleton `active_agent_compaction` with its run,
harness attempt, index, trigger, and start time; the matching
`compaction_finished` deletes it only after the history checkpoint is durable
(or the attempt fails). A finish from an abandoned attempt cannot clear a
recovered attempt at the same run/index. Snapshot and resync frames carry that
singleton. It exists solely to restore the desktop activity indicator and never
substitutes for `transcript_compaction_checkpoints`.

#### Hibernation replay recovery

The child keeps a bounded replay window in class memory. Cloudflare hibernation
preserves the accepted WebSocket, its serialized attachment, SQLite, and the
durable room sequence; it does **not** preserve `recentEvents` or
`replayFloorSequence`. An activated object can therefore receive a valid resume
cursor that is behind its durable sequence while having no in-memory events to
bridge the gap. That is an expected cache miss, not evidence that the socket or
canonical product state is invalid.

`planSocketReplay` handles the four cursor relationships explicitly:

1. A new subscription at sequence zero receives an `initial` canonical
   snapshot.
2. A cursor at the durable sequence needs no frames; a cursor behind it receives
   replay when the complete interval is still in memory.
3. A cursor behind the durable sequence with an absent or incomplete replay
   interval normally receives a canonical snapshot at the durable sequence on
   the same socket. Its required `history_unavailable` reason travels with the
   frame as well as being recorded in `rally.subscribe.snapshot_reason`, so the
   renderer does not mistake bounded recovery state for a continuous refresh.
   If that snapshot cannot be assembled, the same reason becomes the explicit
   `resync_required` fallback.
4. A cursor ahead of the durable sequence receives `resync_required` with reason
   `sequence_ahead`. The current desktop cursor guard would reject a
   lower-sequence snapshot, so this case alone recovers over HTTP.

Snapshot delivery follows the subscribe race boundary: the socket remains
unsubscribed while canonical detail, the newest transcript window, active
output, and compaction state are assembled. Only an initial snapshot also
carries the reader's older unread window; a recovery snapshot must not make a
fresh renderer hook mistake repair for arrival and roll the transcript back.
The child then replays anything published during assembly before serializing
the attachment as subscribed. There is exactly one catch-up stage: if its replay
window has already overflowed, the child retains the old cursor and returns
`resync_required` rather than assembling a second snapshot with an unclosed
race. The same fallback applies when snapshot assembly fails. Otherwise the
next presence event and every later frame use the same open connection.

The correct workaround for hibernation loss is therefore to fall back from the
memory replay optimization to the child's canonical snapshot path. Do not close
and reconnect the restored socket, persist every replay event solely to keep the
cache alive, or suppress presence events to hide cursor movement. Reconnecting
can itself publish subscribe/close presence events, advance the durable cursor,
and recreate the same gap after the next activation; persisting the cache turns
an optimization into a write-ahead event log; suppressing one event producer
leaves every other replayable event exposed. Any future change to this recovery
must preserve canonical snapshot contents, the one-stage post-snapshot
catch-up, failure without cursor advancement, and the separate
`sequence_ahead` resync case.

The renderer may animate a received text batch one token at a time; that
presentation trick does not change durable text or cursor semantics.

Snapshot reason is also the range-retention proof. A `reconciliation` snapshot
was explicitly requested on the same subscribed socket; the one-stage catch-up
closes its assembly window, so Electron may retain already loaded ranges that
fall outside its bounded opening ranges. An `initial` or `history_unavailable`
snapshot has no such continuity proof. Electron replaces the old snapshot in
full, leaving those intervals as gaps to reload under the new snapshot ID.
Canonical turns can revise or retract, so copying even apparently immutable
old-fence rows beneath a new ID would make missed lifecycle events look current.

The initial snapshot carries canonical half-open sequence ranges around the
first unread turn and at the tail. Further history uses correlated
`load_transcript_range` requests naming that snapshot fence, the requested
half-open interval, and the current room event waterline. A
`transcript_range` response reports the exact covered interval; empty intervals
are coverage, not missing data. These direct replies consume no room sequence
because they answer one admitted reader's query rather than publishing shared
state. Electron requests only known gaps and preserves the visible scroll
anchor as adjacent canonical ranges join. If a fresh snapshot supersedes a
range while its reply is in flight, Electron rejects that reply as
`transcript_snapshot_changed` and recomputes the adjacent gap against the new
snapshot. It never resolves a discarded old-fence range as successful.

### Queueing and steering

Incoming human input is first a server-authoritative pending record with a
stable input ID and arrival order. It is not a canonical transcript turn and
does not consume `transcript_sequence` while pending. The desktop may paint an
identified optimistic overlay, but reconnect replaces that set from the
object's pending-input authority.

`WorkstreamObjectProductService` prepares the future canonical payload before
admission and freezes its payload hash, author snapshot, provenance,
authorization, attachment descriptors, and normalized mentions in that pending
row. Admission creates no `runs` row, workflow input, harness-run ID, attention
ordinal, activity, notification, or resource link. It requests activation from
the owning `SubstreamAgent`. If the loop is idle, the activation transaction
promotes the oldest eligible input and creates/starts its subordinate execution
receipt together. If the loop is already executing, the input stays pending;
an eligible steer is promoted at the safe step into that same activation. The
same `client_message_id` is checked against both canonical and pending authority,
so an ambiguous-response retry returns the same future turn ID without
admitting another input or loop.

Every public message-admission response contains only the accepted `turn`
identity and a truthful `deliveryState` of `canonical` or `pending`. A replay
reports the row's current state, not a separate replay outcome. It never reports
`agentInvoked`, a nullable harness-run ID, or an activation flag: committing a
pending input may request an internal loop wake, but admission does not prove
that an execution has started. `activationRequest` and whether this call inserted
the row remain private between the product transaction and its SubstreamAgent
owner.

`steer` means deliver after the current step: the in-flight provider response
finishes, its reserved assistant turn becomes canonical, and every tool call it
already emitted settles before pending steer inputs are promoted in arrival
order and included in the next model request. `queue` means deliver after the
persistent loop next becomes idle; promotion wakes that same loop rather than
creating another one. If failure or stop prevents a steer boundary, the input
falls forward to the next idle activation and is never lost. Multiple inputs
remain distinct; no later steer overwrites an earlier one.
While the loop is executing, Electron always admits a newly composed message
as `queue`. Slack and other external producers still send `steer` when they
mean a safe-step interruption. The pending set is painted as a list attached
to the top of the composer — slightly inset, overlapping the input — with the
author's avatar and a hover drag handle. Reorder is a REST `PUT` of the full
visible `inputIds` list; the object permutes existing `input_sequence` values
and fans `loop_input_upserted` to every connected viewer. Prepared content
stays immutable. Reconnect never infers delivery mode or order from local
composer state.

Promotion is one object-local transaction that validates the loop fence,
creates the immutable canonical participant turn with its exact fact,
provenance, attachments and mentions, allocates transcript and attention order,
replaces the full pending envelope with a minimal immutable delivery receipt,
and enqueues the resulting directory, user,
activity, mention, and non-duplicate participant effects in `durable_outbox`.
A crash can therefore observe none of the canonical turn, delivery receipt,
and effect intents, or all of them. The loop owner persists the corresponding
Bind transition before crossing the next provider boundary.
Prepared fields on `pending_loop_inputs` are immutable and exist only while
pending. `input_sequence` is the exception: it is the live promotion order a
drag rewrites. A changed request is still a new ordered input; it does not
rewrite or silently cancel the earlier one's content. Canonical turns are
immutable afterwards; `delivered_loop_inputs`
retains only the input-to-turn replay identity and allocated delivery ordinals.

### Compaction and concurrent messages

Compaction belongs to the `SubstreamAgent` whose array is being compacted. A
job freezes the highest included sequence, source checkpoint, scope epoch, and
resource-authorization revision. Model summarization may await while the object
accepts a new workspace-routed user message; that message receives a sequence
above the frozen boundary and is never replaced by the summary.

The result commits only if its job still owns the expected revision and the
authorization fence remains valid. Otherwise it is discarded/retried. A valid
checkpoint becomes a synthetic context prefix for later projection while the
canonical `parts` rows remain available for product history. Substreams are not
created to hide or archive compacted history.

Completed checkpoints are retained as immutable event identities by projection
key, run, and compacted-through sequence. Ordinary runs choose the latest
eligible authorized checkpoint. A derived HyperSight run instead carries one
exact checkpoint identity plus hash and fails closed if that event is absent or
changed. It receives exact tool calls and exact tool results from the raw suffix
after that checkpoint; tools before it survive only through the intentionally
lossy summary. Messages committed during compaction remain above the frozen
waterline and join a later projection only when the run's upper fence admits
them.

### Timers and Daytona

Agent-created one-shot timers live in `workstream_wakeups` inside the exact
`SubstreamAgent` that created them. `due_work` contains child-local derived jobs
such as the debounced HyperSight refresh signal. One source alarm is set to the
earliest regional effect, refresh signal, run dispatch, agent timer, or
keep-alive heartbeat. WorkstreamDO separately alarms for block-dispatch outbox
retry, and each block agent alarms for its own run/recovery heartbeat. A due
timer admits work into the same agent that created it, preserving its transcript
and authority.

Terminal remains a Bind plugin backed by Daytona. The child stores the terminal
workspace, command/task receipts, imports, repository selection, publication
grants, and convergence state; actual coding execution remains in Daytona.

### Sidebar, activity, and notifications

A product transaction that changes common metadata, a viewer overlay, activity,
or a person notification — a mention, or somebody being added to the work
stream — writes a versioned envelope to the child
`durable_outbox` in the same SQLite transaction. The child sends those
envelopes by RPC to its parent `WorkstreamDO`.

`WorkstreamDO` deduplicates by child/message/hash, stores the latest common and
per-user projection from each child, and computes one aggregate work-stream
view. Common state uses a deterministic state priority; last activity is the
maximum child timestamp. Viewer unread counts sum across children, while
participation, listability, and “You Are Mentioned” are logical ORs. The
directory `Workstream` that WorkspaceDO pushes for the sidebar carries a
bounded participant preview on personal rows only: at most three user ids,
most recently added first, plus `participantExtraCount` for everyone past that.
Workspace-scoped rows send neither. Directory and `summary()` both sort by
`participants.added_at` (copied onto the overlay as `participant_added_at`) so
a REST merge of the child's summary cannot swap the three faces. Overlay
`projected_at` is not that clock: it moves on every unread. Every
changed aggregate partition gets its own monotonic waterline and UUIDv7 event
ID in `workstream_state_changes`; pending transitions are not coalesced. The
UUID is carried unchanged on the direct WorkstreamDO socket and delayed
workspace path. The parent sends directory common/user changes, suggestion
feedback, activity, and person-notification delivery through one Cloudflare Queue
outbox;
the regional consumer resolves the appropriate destination:

```text
SubstreamAgent SQLite product transaction
  -> child durable_outbox
  -> authenticated RPC to WorkstreamDO
  -> WorkstreamDO child receipt + aggregate + state row + durable_outbox transaction
  -> WorkstreamDO metadata socket publishes common/viewer waterlines immediately
  -> opaque Cloudflare Queue wake-up for every retained effect
     -> regional Worker fetches the envelope from WorkstreamDO
  -> directory/user/feedback: typed RPC from Queue consumer to WorkspaceDO
     -> WorkspaceDO receipt + directory/index transaction + socket publication
     -> acknowledgement deletes the WorkstreamDO outbox item
  -> activity: typed RPC to WorkspaceDO
     -> authoritative activity event/target transaction + local cursor
  -> person notification (mention, participant added): typed RPC to WorkspaceDO
     -> notification intent + object-local delivery state, then thin D1 Queue receipt
     -> acknowledgement deletes the WorkstreamDO outbox item
```

`WorkspaceDO.workspace_workstream_directory` supplies workspace-wide Work
Streams, In Progress, and Completed sections using title,
description/preview, state, and last activity.
`workspace_workstream_viewers` supplies unread count, participation,
listability, “You Are Mentioned,” and the Home/sidebar list of work streams of
interest. Pins and resource links live beside those rows so cross-work-stream
queries are one local SQLite query rather than a
fan-out to every child. Electron requests cursor-paged rows over its existing
WorkspaceDO socket, and receives the sidebar itself on the answer to
`subscribe` — the first page together with the viewer's
`automation_directory` and `notes` rows, since all three are this object's
tables. Opening the sidebar therefore costs no request at all.
[`realtime-sockets.md`](realtime-sockets.md) holds the protocol and its bounds. Common and viewer rows retain separate monotonic waterlines,
because Queue is at-least-once and unordered. Electron keeps one shared
per-work-stream waterline ledger behind the header/detail/sidebar caches. The
active WorkstreamDO socket normally wins first; the later WorkspaceDO event is
ignored if it carries no newer common or viewer waterline. If the work stream
is not open, the WorkspaceDO event advances the same cache and updates the
sidebar, Active/In Progress/Completed groupings, unread state, and You Are
Mentioned without polling. Pins remain WorkspaceDO-owned fields and use the
workspace directory waterline.

Connector events are owned durably by `WorkspaceDO`. A global edge ingress may
fan one raw provider delivery into multiple workspace targets only when the
provider account is independently installed in each workspace; every normalized
event then belongs to exactly one object. The regional Queue carries the bounded
normalized event and hash; its consumer commits the complete event and replay
receipt through typed RPC before sending an ID-only process pointer back to that
same Queue. A later delivery claims, loads, and settles the canonical event
through typed WorkspaceDO RPCs; no new per-event Workflow is created. Large/raw
bytes remain in R2. Regional D1 carries only opaque ingress routes and
provider-global receipts needed before one workspace is known; no live event
body is written there. Connection-scoped webhook replay receipts live in
WorkspaceDO. Legacy D1 activity bodies are imported and scrubbed during the maintenance
cutover. When an event is attached/admitted to a
particular work stream, the child stores its delivery receipt and relevant
resource link; WorkstreamDO sends that link through Queue to WorkspaceDO's
inverted index. Work-stream-specific suggested actions live in that child.
Workspace-level opportunities, their provenance, per-user ranking, impressions,
dismissals, starts, and immutable start snapshots live together in WorkspaceDO.
Accepted/dismissed child-local feedback is also indexed there through the queued
parent handoff. Discovery and ranking never read a D1 product projection after
cutover.

### Durable Object communication: RPC versus Queue

Every addressed object command uses a typed native RPC method; asynchronous
cross-work-stream state signals first use Queue and are then delivered by a
consumer RPC to their named object. HTTP `fetch()` is reserved for WebSocket
upgrades because that platform flow must return a 101 `Response`; lint rejects
`/internal/*` stub fetches. The complete relationship map is:

| Sender | Receiver | Primitive | Durable handoff |
| --- | --- | --- | --- |
| WorkspaceDO/Worker | SubstreamAgent | typed RPC | idempotent child product transaction, pending loop input, or subordinate execution receipt |
| SubstreamAgent | WorkstreamDO | typed RPC | child `durable_outbox`; parent receipt/aggregate/outbox transaction |
| SubstreamAgent("0") | WorkstreamDO | typed RPC | child pending refresh plus parent fan-out rows |
| WorkstreamDO | BlockDashboardAgent | typed RPC | parent dispatch outbox; block dispatch ledger |
| BlockDashboardAgent | SubstreamAgent("0") | typed RPC | block run ledger plus source-local runtime/tool receipts |
| BlockDashboardAgent | WorkstreamDO | typed RPC | terminal outcome retained until the parent result receipt accepts it |
| regional Worker | regional Queue | Cloudflare Queue | a generic member-visible work-stream filter is resolved once in WorkspaceDO, then one bounded update event is published per selected work stream |
| regional Queue Worker | SubstreamAgent("0") | typed RPC | an idempotent, receipt-backed mark-read or archive transaction against that work stream's authoritative SQLite state; membership is rechecked at delivery |
| WorkstreamDO | regional Worker | Cloudflare Queue | every directory/user/feedback/activity/mention change is retained in the parent outbox; the message is an opaque UUIDv7 wake-up |
| regional Queue Worker | WorkspaceDO | typed RPC | unordered directory/user/feedback envelope; generation + per-key waterline, hash receipt, and authoritative directory/index transaction |
| regional Queue Worker | WorkspaceDO | typed RPC | first-party activity event, all target edges, and the replay receipt commit atomically; the object-local sequence is the digest/feed cursor |
| regional Queue Worker | WorkspaceDO | typed RPC | notification intent, bounded destination payload, and the replay receipt commit atomically; current user/member identity is resolved from D1 before the call and crosses as data |
| connector ingress Worker | regional Queue | Cloudflare Queue | one bounded normalized event plus region/workspace/ingress UUID/content hash per workspace target; raw bytes remain in R2 |
| regional Queue Worker | WorkspaceDO | typed RPC | complete normalized connector event plus content hash; object-local provider/dedupe constraints and ingress receipt choose the canonical ID |
| regional Queue Worker | regional Queue | Cloudflare Queue | after authoritative ingress, an ID-only connector-process pointer returns to the same `ACTIVITY_QUEUE`; native per-message retry and the existing DLQ own redelivery |
| regional Queue Worker | WorkspaceDO | typed RPC | claim/load/terminal settlement against the canonical connector event; WorkspaceDO-issued expiring leases fence active duplicates and stale settlement, while Queue attempts remain transport telemetry |
| legacy ConnectorEventWorkflow | WorkspaceDO | typed RPC | drain-only compatibility for instances created before the Queue-processing cutover; no new instance is created |
| WorkspaceDO alarm | WorkOpportunityWorkflow | Workflow binding | a deterministic instance receives only workspace, lease, and attempt fences; no model input body is copied into Workflow state |
| WorkOpportunityWorkflow | WorkspaceDO | typed RPC | loads claimed source state and atomically persists admission/provenance or ranking/resolution settlement |

Queues are deliberately used at the work-stream-to-workspace/regional fan-out boundary, where
buffering many independent work streams, consumer concurrency, and delivery
isolation are useful. A Queue cannot target a particular parent DO; it needs a
Worker consumer to resolve that DO and make another RPC. More importantly,
`queue.send()` cannot commit atomically with a child's SQLite product mutation.
Changing SubstreamAgent-to-WorkstreamDO to Queue would therefore **not delete
the child outbox**: the safe path would be child transaction/outbox, alarm,
Queue, consumer, parent RPC, parent receipt, and acknowledgement. That adds a
hop, cost, latency, route reconstruction, and best-effort Queue ordering while
retaining the code that makes the handoff durable. Direct RPC plus the existing
SQL outbox is smaller and preserves per-stub E-order. The next boundary is
different: one workspace aggregates many independently busy work streams, so
Queue provides useful buffering and failure isolation. WorkspaceDO never trusts
Queue ordering or uniqueness; it accepts only a greater `(authority_generation,
waterline)` for the affected `common` or `user:<id>` key. A synchronous typed
RPC is retained only for the maintenance/bootstrap activation fence that must
materialize the initial directory row before the D1 route opens. Runtime state
transitions never use that shortcut.

Creation replays are repair operations, and they repair the directory only. If
the authoritative child transaction committed but building or delivering its
parent snapshot failed, repeating `initialize` rebuilds the `common` and
`user:<id>` effects and nothing else — the participant activity event and
notification a first pass would have emitted are deliberately not re-enqueued,
because a notification is versioned on a projection key it only reads and would
be refused under a new payload hash. `projection_keys` suppresses an
already-delivered identical snapshot, so retries close a missing directory gap
without producing sidebar churn.

Mention intent delivery rechecks current D1 membership and WorkspaceDO-owned
destination state only after WorkspaceDO reports the required viewer-directory version. This prevents an
out-of-order notification from emailing someone whose access or listability was
removed. Delivery compute remains a regional Worker/service, but intent,
attempt, idempotency key, frozen destination, and provider receipt are
WorkspaceDO rows. They must not be copied into a child.

The handoff is observable at each authority boundary. SubstreamAgent records
forwarded or deferred child outbox batches; WorkstreamDO records Queue enqueue
or enqueue failure; the regional consumer records the effect outcome and
whether acknowledgement actually removed the parent row. Notification intent
logs distinguish an active lease, a missing or already-terminal intent, pending
directory projection, inactive or non-listable recipient, self-notification,
Slack and email transport outcomes, final delivery, and retriable failure.
Correlate `message_id`, `notification_intent_id`, `workspace_id`,
`workstream_id`, and `recipient_user_id`. An empty Queue therefore says nothing
about notification delivery by itself; `workstream_notification_terminal` is
the terminal evidence, while `workstream_notification_deferred` and
`workstream_notification_failed` explain why no terminal result exists yet.

### SQL-only schema migration

Every constructor gates requests with `state.blockConcurrencyWhile()` and calls
the shared migration runner. Its contract is stronger than a bare `MAX(id)`
example:

1. create strict `_sql_schema_migrations` if absent;
2. validate positive, strictly increasing, append-only versions;
3. compare the deterministic implementation hash of every applied version;
4. apply each normal group of versions and its receipts in one
   `transactionSync` transaction;
5. reject an object whose schema is ahead of the Worker or whose historical SQL
   was edited;
6. run `PRAGMA foreign_key_check`, then `PRAGMA optimize` after changes.

Migration definitions may not include their own `BEGIN`, `COMMIT`, or
`ROLLBACK`; the runner owns atomicity. A migration that rebuilds a referenced
parent table must remain valid with enforcement enabled, rebuild dependent rows
child-first, and pass a complete `foreign_key_check` before commit. The released
v32 transcript migration retains its legacy execution marker only because that
marker records its shipped wrapper without changing its stored hash; it is not
a pattern for new migrations. An execution mode participates in a new
migration's hash;
older definitions have no suffix, preserving every deployed receipt.
Constructor migrations are bounded DDL.
Large data rewrites use the fleet maintenance/import control plane and resumable
receipts, never unbounded constructor work. `durable-utils` is intentionally not
a dependency.

The runner is *called* from `MigratableDurableObject`, the base every class in
this hierarchy extends — directly for `BlockDashboardAgent`, and through
`ScheduledDurableObject` for the other three. A subclass declares its schema
once, in `migrationPlan()`, and says when it is ready, in `migrationsReady()`;
in exchange it gets the report to the migration tracker and a public
`forceMigration` RPC without writing either. Both members are abstract, so a new
Durable Object class that reports nothing, or that cannot be asked to catch up,
does not compile. `forceMigration` is called only by the regional queue consumer
behind the tracker's operator site, and it applies nothing itself — waking the
object is what runs its schema, so the method awaits construction and reports
where the object landed. See
[`durable-object-migration-tracking.md`](durable-object-migration-tracking.md).

### Retired maintenance-window cutover

The one-time D1-to-object authority cutover (drain -> import -> verify ->
activate -> open) completed in both regions, and its machinery — the cron
importer, the per-object import RPCs, and the deploy workflow's cutover steps —
has been deleted. What deliberately survives it: the `workstream_authority_control`
row (read on every request, fails closed when missing), the
`workstream_authority_routes` table (now the live work-stream-to-object
directory that creation writes and regional effect delivery fences on), and the
minimal `workstreams(id, workspace_id, do_identity_anchor)` row targeted by
routing and audit foreign keys. Migration 0090 removes the imported product
tables, their writer fences, and the completed import-population triggers; a
misrouted product statement now fails because the table or column is absent.

## Invariants

- **Exactly one object name owns each region/workspace/work-stream/substream tuple.** A second naming formula forks ordering and storage.
- **Every workspace-scoped stub is resolved through `durableObjectStubForWorkspace`.** It combines the hard jurisdiction lock with the parent's immutable affinity; only non-workspace regional singletons use the fallback resolver. ESLint rejects direct namespace and low-level resolver bypasses.
- **The object jurisdiction matches the immutable workspace region.** Product-object constructors fail closed when `ctx.id.jurisdiction` is not `us` for Global or `eu` for EU.
- **`WorkstreamDO` runs no model and owns no transcript.** Putting an agent there recreates one serialization bottleneck across substreams.
- **High-volume child reads and streams never proxy through a parent.** Doing so would turn the control plane into the throughput and availability ceiling for every child.
- **User messages enter through `WorkspaceDO`; aggregate metadata streams from `WorkstreamDO`; transcript/token feeds stream directly from `SubstreamAgent`.** Accepting writes on either read socket creates another authorization and ordering boundary.
- **An open work-stream socket is not foreground presence.** Electron reports application, window, and route foreground explicitly on its WorkspaceDO socket; retained metadata/feed sockets may stay open while their work stream is in the background.
- **Workspace presence is ephemeral, attachment-backed, and viewer-scoped.** WorkspaceDO validates the reported work stream against its local directory, omits the receiving user, and never persists a presence table or sends a workspace-wide personal-work-stream map.
- **Every Durable Object persists through explicit SQL.** KV calls create invisible schema and bypass migration, constraints, inspection, and lint.
- **Room sequence and active text commit atomically.** Advancing only the cursor loses streamed text after eviction.
- **No synchronous product transaction callback may return a Promise.** This includes `transactionSync`, `commitRuntimeMutation`, and `commitWithRegionalEffects`, whether the Promise is visible as `async` or hidden behind a helper. Prepare asynchronous transcript material first, then commit only synchronous SQLite work and revalidate its fences inside the transaction.
- **One unexpired attempt lease owns a child run.** Two owners can duplicate an external tool effect or terminal assistant message.
- **A steering record names the targeted run.** A generic “steer next” flag can stop an unrelated future run.
- **Compaction results cannot cover rows above their input fence.** Otherwise a message accepted during summarization disappears from model context.
- **Child-to-parent and parent-to-workspace effects are hash-deduplicated and versioned.** RPC retries, Queue ordering, and delivery uniqueness are not trusted.
- **Nothing may `await` between a sync waterline's allocation and its send.** The waterline is a monotonic counter and the desktop discards anything at or below the last one it applied, so a publication that allocated first has to send first. `publishSync` allocates in `transactionSync` and sends in the same synchronous run, which is what makes that true; an `await` between the two opens the input gate and lets a later publication overtake, and the desktop then silently drops the parked payload along with every topic it named. This is not hypothetical — it is the bug the revalidation sweep shipped, recorded in the changelog.
- **No publish path asks D1 anything.** Losing workspace access is carried by the queue in [`access-revocation.md`](access-revocation.md) and by nothing else — no object polls, revalidates on a timer, or re-reads `workspace_members` before sending. Putting a D1 query back on a publish path is where the waterline ordering bug came from, and the transcript feed would pay it per token frame. An object enforcing its *own* SQL — `canRead`, `product.canRead` — is not that: it is synchronous, local, and answers a question no queue message carries.
- **D1 workspace membership is rechecked for every workspace subscribe/command and every WorkstreamDO/SubstreamAgent/BlockDashboardAgent admission.** Admission is where authorization is decided, and it is decided fresh every time; no long-lived ticket or attachment is continuing authority for a new write. What an admitted socket then holds is ended by the revocation queue, not by re-asking.
- **A product request names its auth principal, and each is verified against the fact that owns it.** (An *auth* principal — who is asking — is distinct from the run's `ExecutionPrincipal`, which names whose authority a run spends.) A login session (`principal` absent) is re-verified against its `sessions` row joined to membership, which is what makes a revoked login stop working mid-flight. A connector principal (`principal: "connector"`, connector ingress only) has no session row — its standing authority is the connector link, verified by the Worker on the very message being delivered — so the object re-checks membership alone (`connectorPrincipalAuth`) and refuses staleness as `connector_member_revoked`. Sockets never carry a connector principal; tickets are issued to login sessions only.
- **Participant removal leaves an active reader.** Any authorized current reader may remove themself or another participant, but the target check, active count, and state change share one object-local transaction. A client-side disabled action is only presentation; without the authority check, two racing removals could leave a private work stream nobody can open.
- **Legacy D1 product rows do not exist and are never a fallback.** Fallback would silently split authority after an object failure.

## Boundary

This module owns work-stream-down Durable Object identity, SQL, message/run
ordering, sockets, local agent execution, and cross-object projection delivery.
It exposes typed product RPCs, four ticketed socket roles, and hash-checked regional
effects.

Whether a given payload belongs on one of these sockets at all, rather than
behind a REST read, is decided by
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md).

It does not own workspace identity/membership, global provider-to-workspace
routing before a workspace is known, Daytona execution, raw R2 bytes, or
operational audit/telemetry. Those remain regional/global services. It also
does not migrate unrelated agent loops to `SubstreamAgent`.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| Migration hash mismatch/schema ahead/foreign-key violation | Constructor activation fails; no request observes a partially migrated schema. |
| Object ID has the wrong/no jurisdiction in staging or production | Constructor activation fails before serving state; callers cannot silently use the unrestricted graph. |
| Location hint cannot be honored | Cloudflare selects the nearest available location inside the jurisdiction; correctness and residency do not depend on the best-effort hint. |
| Workspace socket hibernates | Runtime restores attachments, including explicit foreground presence; replayed tickets are rejected, topic waterlines resume, and pending commands resend under the same client message ID. |
| Foreground renderer or application moves to the background | Electron sends a revisioned `set_presence` with no foreground work stream; WorkspaceDO immediately rebuilds viewer-scoped presence while the retained work-stream sockets remain open. An unclean socket close/error has the same removal effect, and the renderer clears its last snapshot until a live socket replaces it. |
| Foreground viewer loses work-stream visibility | The applied directory effect revalidates live attachments before yielding, clears the inaccessible foreground state, and rebuilds only for the remaining authorized viewers. Restoring visibility does not resurrect the cleared state; the client must report a newer foreground revision. |
| Workstream metadata socket hibernates | Runtime restores identity; subscribe returns a complete authoritative viewer snapshot and later effects push newer revisions. |
| Child evicted during a 2–30 minute or rare 2+ hour run | Keep-alive reduces occurrence; dispatch ledger plus lease resumes after activation/expiry. |
| Feed replay window lost | Child sends a canonical snapshot on the admitted socket, catches up events published during assembly, and keeps the subscription open. |
| Transcript range requested | The agent accepts a snapshot-fenced half-open sequence interval. A per-socket request times out after 15,000 ms and is queued again after reconnect without advancing the room cursor. If the client accepts a newer snapshot first, it rejects the old-fence reply and retries the newly adjacent gap rather than reporting a successful no-op. |
| Encoded transcript range would exceed the shared 1,000,000-byte realtime-frame limit | The agent removes whole turns from the response tail until the frame fits and reports the exact shorter covered prefix. The original requested interval remains in the response, so Electron leaves the uncovered suffix as a canonical gap. If one turn is itself indivisible at that size, the response retains its exact sequence as a payload-free envelope (`blocksOmitted: true` with the true block count) and the client renders a "too large to display" placeholder, so ordering never depends on payload delivery. |
| Historical-range read loses authorization | The agent returns a correlated authorization error and closes the revoked socket with policy code 1008; cached history is not treated as current authority. |
| Schema v32 finds an unverified legacy payload owner | Constructor activation fails with `transcript_payload_retirement_not_verified`; every legacy row remains intact and the object serves nothing until an operator completes ownership transfer under the pre-retirement Worker. |
| Participant removal targets the final active participant | The object returns `409 workstream_participant_required` and leaves the participant active. The desktop disables the action when its current snapshot already shows only one participant, but that is not the authority fence. |
| Somebody loses access while holding sockets | A queue message per object closes their sockets; a failed hop retries and then dead-letters. Nothing else closes them, so a message that is never published leaves the socket open until the client reconnects. See [`access-revocation.md`](access-revocation.md). |
| RPC or Queue duplicates/reorders effects | Stable IDs/hashes deduplicate immutable effects; generation/version orders WorkspaceDO state and delivery receipts. |
| A synchronous transaction callback returns a Promise | The callback finishes before the Promise continuation, so SQLite can commit an incomplete state transition and later writes can escape the transaction. Prepare all yielding work first; the commit callback performs only synchronous SQLite and revalidates its fences. |
| WorkspaceDO, parent, or Queue unavailable | The source outbox remains pending and alarms retry with bounded backoff. User transcript commits are not rolled back. |
| Crash between `initialize`'s root commit and its effect commit | The work stream exists and the retry replays it, but the invited participants' activity event and notification are lost permanently — the replay re-enqueues directory effects only, and a hand-add of somebody already active is a no-op, so nothing recovers them. Deliberate: the alternative wedges the create. |
| D1 unavailable during a user command | Command fails closed before mutation because current session/membership cannot be established. |
| Model/tool wait exceeds the attempt lease | Heartbeats extend an owned attempt; after genuine abandonment a new executor waits for expiry and replays through receipts. |
| Substream child not provisioned | No feed ticket should be issued; the object must not bootstrap product authority from an untrusted socket route. |
| Object approaches SQLite storage limit | Alert and archive/export; do not split one ordered child implicitly. Cloudflare's per-object limit is 10 GB. |

The realtime in-memory window is an optimization. Canonical message records and active
output are SQL. Provider fragments are batched; regional D1 sees semantic
projection changes only, not token cadence.

## Testing

This inventory does not by itself satisfy the ordered-transcript acceptance
contract. The PRD's focused [test contract](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md#test-contract)
maps persistent loop ownership, reserve-before-await ordering, safe controls,
exact settlement, recovery, atomic realtime delivery, bounded ranges,
authority, and renderer convergence to actual test names. Every focused
scenario now has a named implementation; exact-head CI and the repository's
deliberate-break practice remain the acceptance proof. This documentation pass
ran no suites and recorded no deliberate-break failure proof.

Run:

```bash
pnpm --filter @rally/api test
pnpm lint
pnpm typecheck
```

`apps/api/test/workstream-object-schema.test.ts` covers append-only object-local
schema history and compaction singleton lifecycle. The real runtime suite uses
`apps/api/vitest.workers.config.ts` with Cloudflare's current Vitest pool and
`runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, and
`evictDurableObject`. `test-workers/durable-object-runtime.test.ts` exercises
constructor migrations, per-object SQL isolation across eviction, keep-alive
alarms, `WorkstreamDO` aggregation and metadata snapshots, hibernating workspace
and work-stream control sockets, foreground presence across WorkspaceDO eviction
plus inaccessible-work-stream rejection, typed native-RPC success/conflict envelopes,
complete initial directory delivery across all four live execution states even
past 1,250 combined rows, presence-free proactive feed subscriptions,
snapshot-fenced canonical transcript ranges without room-cursor movement,
range revocation, compaction recovery, HyperSight checkpoint recovery/revocation, socket
revocation across all four roles, obsolete queued
run coalescing, stale-arrival rejection, per-block parent head-of-line delivery,
ticket replay, and the read-only child socket.
`test-workers/participant-notification.test.ts` covers what seating somebody
enqueues, on both the create and the add-afterwards paths, plus identity-bearing
mentions and attachment descriptors in an opening message, and member-authored
elicitation answers. Existing-room cases use runtime bootstrap plus the
system-provision `provision` path;
create-effect cases invoke `initialize` without activating its admitted run; and
the elicitation case seeds a settled parent run. The distinct create ids still
prevent accidental replay, while the replay case reuses `CREATE_REPLAY_ID`
across its own two opens because replay is what it asserts.
`test-workers/unseen-workstream-state.test.ts` covers
self-removal, removal of another participant by a member, and the transactional
final-participant refusal on real Durable Object SQLite. `test-workers/message-authority.test.ts` and
`test-workers/scheduling-authority.test.ts` cover typed part plus participant-turn
atomicity and malformed object-boundary inputs; the runtime suite proves a
subscribed socket receives a typed external append without reconnecting.
`apps/desktop/src/renderer/lib/transcript.test.ts` covers author, mention, and
attachment flattening, routed identity bridging, and elicitation collapse. The
participant-notification suite is also where the
one trap in asserting on effects is recorded: **never read the child's own
`durable_outbox`.** A commit arms the child's alarm for the current instant and
the alarm forwards and then deletes, so any assertion against that table races
the drain and gets quietly greener the fewer effects a path enqueues — an
absence assertion written that way passes vacuously. Flush with
`flushEffectsToWorkstreamDO` and read the parent, and take a projection version
from the parent's `projection_keys` rather than from an outbox row, because the
eager directory delivery inside `acceptSubstreamEffects` acknowledges directory
rows out of the parent outbox without any Queue consumer.
`test-workers/workstream-schema-migration.test.ts` upgrades a populated v32
foreign-key graph through real workerd storage and proves canonical content and
relations survive with an empty `foreign_key_check`. Node tests cover migration
rollback, grouped-failure resume, execution-mode/hash drift and ahead versions,
normalized product SQL, canonical replay deduplication and fenced same-row tool
settlement, authorization — including
the product API's session and connector principals in
`test/workstream-room-authorization.test.ts` —
effect idempotency, streaming checkpoints, and renderer socket switching.
`test-workers/message-to-output-pipeline.test.ts` asserts the exact public
canonical/pending admission envelope across first admission, pending replay,
promotion, and external elicitation delivery while separately inspecting the
private activation state. `test/slack-workspace-assignment.test.ts` proves a
connector replay returns the same pending turn and creates one deterministic
audit row. `packages/contracts/src/index.test.ts` rejects the retired
execution-shaped socket receipt, and
`apps/desktop/src/renderer/lib/workspace-socket.test.tsx` proves pending state
survives reconnect and reaches the composer acknowledgement.
Desktop tests cover canonical range merging, paged-history retention across a
snapshot refresh, rejection and retry of an in-flight old-fence range,
stream-specific completion, reconnect queueing, range errors, scroll
threshold/anchor preservation, compaction reconciliation, and HyperSight
full-checkpoint replacement. `scripts/durable-object-native-rpc.test.mjs`
proves the custom lint rule rejects direct, computed, aliased, optional, and
typed-stub internal fetches without flagging unrelated HTTP clients.
`scripts/durable-object-sync-transaction.test.mjs` proves explicit async and
type-resolvable indirect Promise callbacks are rejected at all three
synchronous transaction boundaries while ordinary synchronous SQL remains
valid. Dynamically dispatched calls whose return has been erased to `unknown`
or `any` still require review; the rule cannot reconstruct discarded type
information.
`test/runtime-components.test.ts` covers US/EU resolution, location-hint
arguments, local workerd behavior, and jurisdiction mismatch rejection.
`pnpm test:scripts` covers the ESLint rule's direct, computed, optional, aliased,
destructured, and typed-namespace bypass cases.

Do not replace workerd lifecycle tests with hand-made state objects. Focused
Node repository tests may use `node:sqlite`, but their `DurableObjectState`
doubles must include real SQL/transaction behavior when constructor migration
is under test.

## Data model

The DDL in source is authoritative. This catalog defines ownership and joins.
Durable Object tables are SQLite `STRICT` tables. Native work-stream-down
schemas use integer Unix milliseconds; WorkspaceDO's imported workspace schema
retains its ISO timestamp columns. Tables use bounded inline/JSON payloads and
keep external object identity in one singleton rather than repeating it on every child row. Live
WebSockets use hibernation attachments and therefore have no `sockets` table.
No RPC or Queue send happens inside a local SQL transaction: the source commits
a fact plus an outbox intent, and the receiver commits its mutation plus a
hash-checked receipt. Work-stream common/viewer state transitions are never
coalesced; specialized replaceable HyperSight refresh/dispatch rows document
their own narrower coalescing rules. An inflight row is retained because it may
already have committed across the object boundary.

### `WorkspaceDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | One row per immutable schema version; shared runner metadata. |
| `workspace_identity` | Singleton row (`id = 1`) binding the object to workspace, region, and immutable placement affinity. |
| `workspace_socket_ticket_receipts` | One consumed workspace-scoped ticket including user, expiry, and consumption time; its expiry index supports bounded cleanup. |
| `workspace_sync_events` | Monotonic `waterline`, UUIDv7 `event_id`, JSON topic set, and occurrence time for the bounded 1,024-event reconciliation window. Rows are invalidations only, never workspace data copies. |
| `workspace_connector_events` | Complete authoritative normalized provider event, connection/workspace scope, bounded JSON/text fields, provider/dedupe unique keys, local insertion sequence, and processing claim/terminal state. It is never shared with another workspace. |
| `workspace_connector_event_ingress_receipts` | One ingress UUID/content-hash to canonical-event mapping. It makes provider replay and at-least-once Queue delivery idempotent even when a second delivery used a different UUIDv7; ingest opportunistically reaps the oldest receipts after 30 days while the provider/dedupe keys continue to resolve the canonical event. |
| `connector_connections`, `external_user_identities` | Workspace connector credentials, cursor/configuration/health, model plugin identity, refresh lease, and verified provider-user mappings. Global/provider ingress routes retain only the opaque fields needed to find this object. |
| `slack_agent_*`, `slack_delivery_preferences`, `slack_user_links`, `slack_ingress_jobs`, `slack_link_challenges`, `slack_unfurled_links` | Workspace-local Slack policy, allowlist, identity, execution session, queued handoff, delivery preference, and shared-link state. Global Slack installation routing remains outside the object because the workspace is not known at initial ingress. |
| `workspace_sandbox_network_policies`, `workspace_sandbox_network_domains`, `workspace_sandbox_network_policy_mutations` | Terminal network/egress authority, current verified revision, domain set, and complete preview/confirm/result history. Substream terminal state stores only the applied revision and rechecks this object before reuse. |
| `automation_templates`, `automation_template_versions` | Shared, publishable automation templates and their immutable versions. Adopting one copies its definition into an independent `AutomationAgent`; nothing subscribes to a version, and no automation's own state lives here. |
| `automation_directory`, `automation_creation_claims`, `workspace_external_event_registrations`, `workspace_external_event_deliveries`, `automation_cutover_campaign` | The workspace's whole remaining automation surface: a content-free directory row per automation (id, author, generation/version coordinate, lifecycle, scope, title, next run, attention) that can locate an object but never authorize a read of one; the creation-key claim that keeps a retried first authoring send from minting a second automation; the typed external-event registration index and its leased delivery ledger, shared with work-stream resource watches; and the one-shot import ledger. Every automation's definition, runs, memory, schedules, and receipts live in its own `AutomationAgent` — see [`automation-lifecycle.md`](automation-lifecycle.md). |
| `digest_schedules`, `digest_schedule_times`, `digest_delivery_targets`, `digest_deliveries`, `schedules` | User digest configuration/cursor/history plus the canonical due-work index for digests and connector polling — automations left `schedules` in the durable-lifecycle cutover and arm their own object's alarm. This object's own alarm reads them directly and mirrors each due time into `_internal_durable_alarms`; see [`durable-object-alarms.md`](durable-object-alarms.md). |
| `resources`, `resource_versions`, `resource_watches` | Workspace resource metadata, monotonic semantic history, and workspace-level attachment/watch relationships. Every numbered version retains its original and derivative regional R2 refs; each SubstreamAgent separately owns its work-stream link and resource inventory revision. |
| `resource_object_deletion_outbox`, `note_resource_deletion_outbox` | Durable lifecycle ownership for original, derivative, receipt, and note-linked R2 refs. Deletion bytes is a regional side effect performed only after an object-owned outbox claim. |
| `notes`, `note_transcript_segments`, `note_privacy_change_outbox` | Note authority, transcript segments and privacy-delivery intent. A note's linked resource is a real local foreign key. |
| `memory_scopes`, `memory_items`, `memory_mutations`, `memory_index_outbox` | Workspace/user/work-stream memory facts — automation memory moved into each `AutomationAgent` — immutable mutation receipts and vector-index side effects. Work-stream/run IDs are opaque provenance, not foreign keys — so this object validates no scope owner, and migration 0036's four owner rules, dropped by 0090 along with the D1 tables, are now held only by `resolveMemoryAccess`. |
| `memory_tables`, `memory_table_columns`, `memory_table_rows`, `memory_table_cells`, `memory_table_mutations` | Typed relational memory tables with local FTS indexes, schema/data revisions and durable mutation history. |
| `workstream_notification_intents` | Causally fenced person-notification intents, `notification_kind` in (`mention`, `participant_added`). Claim, defer, failure, terminal settlement, retention due time, and reap are typed WorkspaceDO RPCs; the generic SQL port refuses this table. Automation and digest transports keep their idempotency receipts on their own target/receipt rows; all variants are WorkspaceDO-owned. Terminal shells are reaped by this object's `notification_intents` maintenance alarm after 30 days. |
| `workstream_email_receipts` | Inbound-email processing idempotency keyed `(resend_email_id, workstream_id)` with the expiring exclusive lease a Worker holds while it fetches, stores, and posts one email. Claim, renewal, settlement, and failure all serialize in this object once the route is open; the legacy pre-cutover branch settles the same shape in one regional D1 batch instead. |
| `realtime_transcription_ticket_receipts`, `realtime_transcription_sessions` | Dictation socket admission: one-time consumption of the signed ticket's `jti` and the short concurrency leases the per-user/per-workspace session caps are counted over. The expiry sweep, ticket consume, and cap-checked insert run as one serialized transaction, which is what makes the caps race-free. Epochs are Unix seconds — the signed ticket's external contract and the one departure from the object's unix-ms rule — so the columns carry the unit (`*_s`); the import maps the unitless D1 names over. |
| `workspace_directory_state` | Singleton monotonically increasing `waterline` used to order page membership/pin reconciliation. |
| `workspace_workstream_directory` | One authoritative common row per work stream, fenced by authority generation, per-common `waterline`, UUIDv7 `source_event_id`, and hash. Supplies title, description/preview, scope/state, provenance, planning, attention, recency, archive, wakeup, and Terminal scheduling fields. |
| `workspace_workstream_viewers` | One authoritative viewer overlay per work stream/user, independently fenced by generation, viewer `waterline`, UUIDv7 source event, and hash. It supplies participation, listability, unread/mention state, and read fences and cascades from the common row. |
| `workspace_workstream_pins` | User-ordered pins referencing the directory row; all pin writes and reorder operations execute in this object. |
| `workspace_workstream_resource_links` | Inverted resource-to-work-stream/watch index derived from authoritative child relationships, enabling connector and authorization lookup without cross-object SQL. |
| `workspace_workstream_effect_receipts` | Message/hash receipts making WorkstreamDO-to-WorkspaceDO effect retries idempotent — directory effects and the regional activity/mention effects alike; each receipt commits in the same transaction as the row it acknowledges, and inserts age receipts out after 30 days. |
| `workspace_batch_dispatches`, `workspace_batch_dispatch_targets` | Frozen generic mass-update intent and one dispatch receipt per selected work stream. The operation/request hash prevents intent reuse; pending rows resume Queue publication after partial failure, while child inbox receipts cover the send-succeeded/progress-write-failed window. The Worker publishes 50 messages per Queue call, below Cloudflare's 100-message platform maximum. WorkspaceDO records the whole chunk atomically through one JSON binding, independent of object SQLite's 100-parameter ceiling. `archived_note_count` is the same operation's note half: notes are rows in this object rather than separate authorities, so `archive` applies them here in one statement and stores the count as its own receipt. `NULL` means no note archive has run for the operation, which is both the pre-migration-26 reading and the permanent state of a `mark_read` operation. |
| `workspace_activity_events` | Append-only first-party event log with a local AUTOINCREMENT cursor, audience rule, derived title/body, digestibility decision, dedupe key, and source reference. |
| `workspace_activity_event_targets` | Involvement edges such as mentioned/assigned; these never grant visibility and cascade with the event. |
| `opportunity_batch_windows`, `opportunity_batch_events` | Debounced connector/message evidence, bounded attempts, Workflow leases, and terminal admission status; both share one not-yet-started token (`pending`), and the import maps legacy `queued` window rows onto it. Repeated mutation or settlement after `completed` is a no-op; a nonterminal lease mismatch remains fenced. |
| `work_opportunities` | Workspace/personal suggestion authority: prompts, hashes, source fingerprint, version, TTL, and idempotent start state. |
| `opportunity_provenance_nodes`, `opportunity_provenance_edges`, `work_opportunity_provenance_roots` | Visibility-scoped evidence graph and ordered roots for each opportunity. |
| `work_opportunity_user_links`, `work_opportunity_user_states` | Resolved/inferred people plus per-member impressions, dismissal, and started state. |
| `suggested_work_sets`, `suggested_work_ranking_rounds` | Per-member due/lease/ranking cache and the audit trail explaining each tournament. |
| `work_opportunity_snapshots` | Immutable evidence/link snapshot and prompt hashes captured when a member starts an opportunity. |

`WorkspaceDO` stores these workspace products directly, not as copies of D1,
and stores no work-stream transcript. `workspace_identity` binds the whole
database. Native directory/activity/opportunity tables omit a repeated
`workspace_id`; compatibility-shaped imported domain rows retain it while
per-table triggers require the singleton value. Activity targets, automation
children, resources/notes and memory use real local foreign keys. User, work-stream,
message, Workflow, and child-agent IDs cross database/object boundaries as
stable text references; code resolves and authorizes them through typed RPC or
the regional control plane rather than pretending SQLite can join another
authority. Its socket attachment contains workspace/session
identity plus the last delivered topic waterline; each subscribe/command
revalidates D1 membership, and each command invokes the selected child through
the Worker-side client. Cross-object relationships carry stable IDs, versions,
and hashes; no SQL join crosses a Durable Object boundary.

Generic visibility enumeration for mass operations is cursor-paged by
work-stream ID with a hard 250-row page limit, and callers follow `nextCursor`.
The desktop directory is a different recency cursor: its first response returns
up to 250 recent unpinned rows plus every visible pin and every visible
`running`, `interrupting`, `preparing_context`, or `waiting_capacity` row. That
combined synchronization response has no separate row cap because those live
rows are authoritative proactive-connection targets; subsequent recency pages
remain bounded and exclude the supplemented rows.

### `WorkstreamDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable parent schema history. |
| `workstream_metadata` | Singleton aggregate identity/generation and revisioned complete common metadata: title/description/preview/email/origin/creator/automation/planning/state/attention/activity/completion/archive/schedule timestamps. |
| `substream_directory` | Latest common envelope per child, keyed by external substream ID. |
| `substream_user_directory` | Latest viewer envelope per child/user pair. |
| `child_effect_receipts` | Child/message/hash inbox proving idempotent RPC acceptance. |
| `projection_keys` | Next version and last hash for parent aggregate partitions such as `common` and `user:<id>`. |
| `workstream_state_clock` | Singleton append sequence and nondecreasing millisecond floor used to create local UUIDv7 trace identities. It is not a distributed causal clock. |
| `workstream_state_changes` | Immutable bounded tail of common and `user:<id>` aggregate rows. `waterline` orders one key; UUIDv7 `event_id` is carried over both socket paths for tracing/deduplication. |
| `durable_outbox` | Hash-checked aggregate or immutable effect waiting for Cloudflare Queue delivery/ack, discriminated by a CHECK-enumerated `effect_kind` column (the drain filters and priority-orders on it; the class is never re-derived from JSON). Every common/viewer state change keeps its own row; the payload itself never enters Queue. Deliberately no dead-letter lane, unlike the child outbox: directory state is latest-wins per key and effects apply idempotently, so a permanently failing receiver is a quarantine-class event rather than a per-message disposal. |
| `workstream_socket_ticket_receipts` | Consumed metadata-socket ticket IDs, users, expiry, and consumption time. |
| `block_dashboard_configuration_versions` | Append-only shared block definitions and optimistic configuration version. This is the product authority for which stable block agents exist. |
| `block_dashboard_block_runs` | Parent-visible queued/running/terminal block state keyed by block run, configuration, block, and transcript trigger. |
| `block_dashboard_user_preferences` | Viewer-specific dashboard visibility, kept with the WorkstreamDO socket authority that publishes it. |
| `block_dashboard_dispatch_outbox` | One retryable, affinity-routed dispatch per block run; deletion means the named block agent durably accepted it. |
| `block_dashboard_block_result_receipts` | Highest accepted result version and hash per block run, preventing a stale retry from rolling back terminal state. |
| `block_dashboard_source_refresh_outbox` | Singleton coalescing configuration-to-main-substream refresh intent; its retry deadline participates in WorkstreamDO's one native alarm. |

The child tables are inputs to `workstream_metadata` and the aggregate
projection. No SQL crosses object databases; the child sends an authenticated
envelope RPC, and the parent commits receipt, child value, aggregate, and outbox
inside its own transaction.

For common/viewer aggregates, that transaction also appends
`workstream_state_changes` before the corresponding `durable_outbox` row can be
observed. Each common or viewer UUIDv7 message/event ID is time sortable to
milliseconds and remains identical for that row on the WorkstreamDO socket,
Queue wake-up, WorkspaceDO source row, and WorkspaceDO socket. A complete
snapshot carries both IDs separately. Independent objects can generate
same-millisecond IDs in random order, so freshness always compares authority
generation and the relevant common/viewer waterline, never UUID lexical order
alone.

HyperSight uses a second parent-owned relationship: the source child sends one
fenced refresh signal, the parent fans out stable block dispatches, each block
agent reads and writes its Bind runtime ledger through the source child's typed
internal SQL port, and versioned results settle back into the parent. No SQL
join crosses an object boundary.

### `SubstreamAgent`

| Table group | Meaning and relationships |
| --- | --- |
| `_sql_schema_migrations`, `object_versions` | Schema versions and the applied-migration receipts. |
| `workstream`, `substream_agent_identity`, `substreams` | Local root/authority, immutable external child identity, and LLM-array context metadata. Existing main data uses local context `0`. |
| `participants`, `member_attention` | Participation and personal read/mention waterlines; active workspace membership remains D1 authority. |
| `participant_transcript_turns`, `participant_transcript_blocks`, `participant_transcript_attachments`, `participant_transcript_mentions`, `transcript_facts`, `transcript_payloads`, `content_refs` | One provider-neutral semantic order whose canonical turns reference content-addressed payloads plus exact attachment, mention, and large-content joins. Accepted human and assistant content, identity, and order never change. One stable tool turn may advance only its explicit lifecycle from started to terminal; a different turn under the same client id remains an ignored replay. Terminal residual-receipt repair asynchronously prepares the replacement payload, then commits its fact and tool metadata synchronously so alarm/reaper settlement cannot leave a started card behind. Tool UI rows project only as complete assistant-call/tool-result pairs; pending messages have no canonical order and enter Bind only through the persistent loop's delivery transaction. |
| `substream_loops`, `pending_loop_inputs`, `delivered_loop_inputs`, `assistant_turn_reservations`, `bind_loop_heads`, `bind_loop_state_messages`, `bind_activation_inputs`, `bind_provider_boundaries` | One persistent loop lifecycle and execution fence, server-authoritative prepared input awaiting atomic promotion, minimal delivery replay identity after promotion, exact canonical slots reserved before assistant generation, the current Bind projection, immutable activation receipts, and provider-boundary hashes. `bind_loop_heads` is the only current Bind metadata authority; ordered message rows reference it directly. Pending inputs have neither transcript nor attention order until delivery. |
| `runs`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts` | Subordinate execution receipts, frozen authority/context, and provider attempts. A run records restart context and loop provenance but is never the loop identity. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Planned/executed tools, replay fences, resumable activation, and human-input pauses. Each elicitation retains the stable Bind tool slot that its eventual answer must close. |
| `active_output_turns`, `active_output_chunks`, `active_agent_compaction`, `realtime_state` | Reconnect-safe partial output keyed by an explicit transient `stream_id`, active compaction phase, and the room sequence. Canonical output identity remains the turn's `turn_id`; `active_agent_compaction` is a singleton operational checkpoint and immutable summary history remains below. |
| `transcript_compaction_checkpoints`, `description_refresh_state` | Sequence/revision-fenced context derivations. Checkpoints reference immutable model-only facts per principal/run/sequence so a derived run can bind an exact compaction event rather than mutable “latest” state. |
| `workstream_wakeups`, `due_work` | Agent-created timers and other child-local alarm jobs. |
| `workstream_resource_links`, `resource_inventory_revision` | Links to workspace resources with a CHECK-constrained relationship (`attachment`, `message_attachment`, `origin`, `generated`, `inbound_email`, or `context`) and the authorization revision every relationship change advances. `generated` derives artifact direction; every other value derives source direction. |
| `block_dashboard_configuration_versions`, `block_dashboard_block_runs`, `block_dashboard_user_preferences` | Source-runtime compatibility records used by the Bind harness and maintenance import. WorkstreamDO is the post-cutover product authority for configuration, published run state, and viewer preference. |
| `terminal_workspace`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | Durable Rally state for the Daytona-backed Terminal plugin. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Versioned child-to-parent effects and inbound dedupe such as feed tickets. |

`participant_transcript_turns.transcript_sequence` is canonical transcript
order, including tool and safe status turns.
`participant_transcript_turns.attention_ordinal` is the independent people-visible main-substream
waterline used by unread tracking. Product messages expose the latter as the
nullable `attentionSequenceNumber`; tool/transient rows carry `null`. Desktop
read receipts and unread anchors must never substitute transcript sequence for
that field, including while an older Worker omits the optional wire property.

There is no work-stream runtime SQL adapter. Worker and sibling-object callers
use typed object ports; a resident `SubstreamAgent` installs the same storage
operations as local authorities, so self-calls do not leave the isolate. The
`_runtime_harness_runs`, `_runtime_inference_attempts`, and `_runtime_users`
views, their triggers, and `_runtime_statement_changes` are retired by the v33
cutover. Their definitions remain only inside immutable migration v1 history so a
new object can replay the shipped fingerprint before the later migration drops
them. They are not a forward read, write, telemetry, or development-fixture
path.

### `BlockDashboardAgent`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable block-agent schema history. |
| `block_dashboard_block_identity` | Singleton immutable region/workspace/work-stream/block identity. A mismatched dispatch fails closed. |
| `agent_run_dispatches` | One durable dispatch per block run with the causal freshness tuple (`configuration_version_number`, `trigger_sequence`, `source_created_at`) as declared columns the run-queue ordering reads, queued/running/terminal state, attempt count, retry deadline, and terminal result waiting to settle into WorkstreamDO. Settled terminal rows age out after 180 days; the freshness-pinned run is never reaped. |
| `latest_dispatch_freshness` | Singleton causal high-water mark for configuration version, source trigger, source time, and run ID. It makes late-retry rejection constant-time even when the immutable dispatch history is large. |
| `agent_stream_checkpoint` | Singleton full-output checkpoint for the active dispatch, foreign-keyed to `agent_run_dispatches`; revision, epoch, sequence, text, and update time allow exact reconnect replacement without replaying token deltas. Terminal completion deletes it after the final result is durable. |
| `block_dashboard_socket_ticket_receipts` | One-time block-socket ticket consumption with expiry cleanup, separate from every other socket audience. |

The block agent stores no source transcript or user preference. It stores only
its derived active-output checkpoint while a run is in progress. Its dispatch identity
points to the source main substream and parent WorkstreamDO by stable names; the
workspace route supplies the same jurisdiction and affinity to all three. Bind
runtime rows live in main `SubstreamAgent("0")` because they reference its
transcript, resources, compaction scope, and tool receipts. The local dispatch
row is what makes the block agent—not the source or parent—the active execution
owner and recovery coordinator.

### `_internal_durable_alarms`

Present in WorkspaceDO, WorkstreamDO, and SubstreamAgent alike, added by each
one's own migration history from the statements
`durable-objects/scheduled-alarms.ts` exports.

| Table | Key and relationship |
| --- | --- |
| `_internal_durable_alarms` | `(kind, alarm_key)`: one row per thing this object wants woken for, with its due instant, optional repeat, and its own attempt/`retry_at` gate. The object's single Cloudflare alarm is always armed for `MIN(MAX(due_at, retry_at))` across these rows and whatever the object derives from its other tables. |

WorkspaceDO reconciles `schedule`, `watch`, `maintenance`, and `terminal`
entries from the tables above; SubstreamAgent reconciles `agent_timer` entries
from its own `workstream_wakeups`. The entry is an index, never the record: each
handler reloads its row, so a cancellation racing an alarm is a no-op.
[`durable-object-alarms.md`](durable-object-alarms.md) owns the mechanism.

### The retired `WorkspaceScheduler`

There was a fifth class: one alarm coordinator per workspace, holding
`workspace_scheduler_state` and `scheduler_retry_states`. Its work moved into
WorkspaceDO — which already owned every table it read — and the class was
deleted, binding and all, by Wrangler migration tag `v4`. Nothing routes to it;
`v1` still names it in `new_sqlite_classes` only because a deployed migration
tag is immutable history.
[`durable-object-alarms.md`](durable-object-alarms.md) records what the deletion
cost and what replaces it.

## Regional impact

Every object is selected through the workspace's immutable region and affinity.
Staging and production Global objects use the US jurisdiction with `wnam` or
`enam`; EU objects use the EU jurisdiction with `weur` or `eeur`. Creation uses
the initiating request longitude. `wnam` and `weur` are defaults only for
preexisting migrations, background creation, or missing Cloudflare metadata.
Jurisdiction is a storage/execution guarantee; the hint is best effort and only
affects the first `get()`. Product constructors verify the actual jurisdiction.
Local workerd omits both options because it does not implement jurisdictional
namespaces. EU D1/R2/Queues process EU workspace data. The global registry
carries only routing/identity metadata; no transcript, token frame, connector
payload, notification body, or full Workflow input crosses it.

## Security and trust model

Socket query parameters are not credentials. The edge verifies signed tickets
and forwards a bounded identity header set. Ticket audiences separate workspace
commands from child feeds. Workspace commands recheck current session and
membership; child reads also apply product visibility and disconnect sockets
after revocation. Parent effects contain display/activity data but no connector
credentials. Workstream parent-effect Queue messages are opaque wake-ups. A
connector-ingress Queue message is the narrow exception: it contains a bounded
normalized workspace event and hash so D1 never becomes the body relay; raw
provider bytes remain in R2.

## Operations

Health endpoints report role and object-local database bytes. Migration errors
include component/version reason. Inspect `_sql_schema_migrations`,
`workspace_directory_state`, `workspace_workstream_effect_receipts`,
`substream_loops`, pending inputs, assistant reservations, linked execution
receipts, BlockDashboardAgent `agent_run_dispatches`, attempt leases, child and
parent `durable_outbox`, WorkspaceDO external-delivery attempts, and authority
route/generation before retrying a quarantined object. The maintenance control
plane can quarantine a failed route;
operators must never reopen legacy D1 writers or an unrestricted predecessor as
recovery. Cloudflare does not move an existing object when a hint changes; a
placement/jurisdiction change requires the same explicit maintenance export,
import, verification, and authority switch used here.

Transcript ownership transfer is no longer an operational endpoint after schema
v32. `transcript_payload_retirement_not_verified` means the object missed the
pre-retirement fleet or final-delta pass; do not bypass the guard or recreate a
fallback reader. Restore the pre-retirement Worker long enough to run the
receipted transfer, verify replay, and only then retry retirement.

## Performance and cost

Hibernating sockets do not bill idle object duration, and runtime auto-response
answers exact ping/pong without waking an object. The 30-second keep-alive alarm
exists only while an in-memory full loop is active. At 100 tokens/second for
10,000 tokens, the 100 ms/2,048-character batcher produces at most roughly 1,000
active-output transactions over about 100 seconds, usually fewer; it does not
produce 10,000 token rows or any D1 token writes. Final text replaces the active
checkpoint with one canonical part.

The parent suppresses only an unchanged aggregate with the same partition hash;
every changed common/user transition retains its own state and outbox row. A streaming work
stream therefore costs realtime child frames and child SQLite checkpoint
writes, while WorkspaceDO directory traffic is bounded by semantic metadata
changes rather than token rate or number of connected viewers. D1 receives no
directory write at all.

## Changelog

### 2026-09-01 — A grouping's action reaches only what that grouping showed

**What changed:** `batchTargetIds` now carries
`directory.origin_type <> 'automation'`, the clause the four sidebar-facing
directory readers — the paged recent list, the pinned rows, the running rows
and the per-row socket push — have always carried. The client's mirror of the
predicate refuses an automation-origin row for the same reason.

**Why:** This was the fifth reader of `workspace_workstream_directory` and the
only one without that clause, so a recency heading's **Archive all** selected
an automation's run work streams — including a *planned* run's, which the
scheduler then cannot find behind its own `archived_at IS NULL` lookup. Those
rows are deliberately kept out of the sidebar and reached from the automation's
own screen, so nobody choosing **Archive all** under a date heading was shown
them, could see them go, or could get them back: the confirmation counted them
among the "work streams in **This month**" and the archive is irreversible. It
was not a decision that notes and automations should be treated differently —
the clause was simply not restated when this fifth reader was written.

**Considered and rejected:** Leaving the selection wider than the list and
fixing the sentence in the dialog instead. There is no sentence that makes an
irreversible archive of rows the reader cannot see acceptable, and the rows are
not merely unloaded — no scroll reaches them.

**Consequences, and what a future change has to respect:** A rule about what
the sidebar shows now lives in five statements, and a sixth reader will have to
restate it. The regression test asserts the batch's targets against
`listWorkstreams`' own answer over the same range rather than restating the
expected set, so the two cannot drift apart again without failing. What stays
deliberately wider is pagination: the confirmation names the complete
server-side total precisely because the client may hold only a page, so
"hidden" and "not yet loaded" must keep being decided differently.

### 2026-09-01 — A grouping's archive takes its notes too, in the object that holds them

**What changed:** `Archive all` on a sidebar recency heading now archives the
notes under that heading as well as the work streams. The same filter selects
both: WorkspaceDO returns the note IDs beside the work-stream IDs from one
`batchUpdateTargets` call, so the confirmation counts each half at the same
instant, and `archiveNotesForBatch` applies the note half in one statement
before the Queue chunks go out. Notes take three fences the range does not —
the viewer must own the note, it must not be recording, and it must not already
be archived — which are the same three refusals the single-note archive makes,
so the preview's count and the archive agree. The dispatch row gained
`archived_note_count` (migration 26) as that half's receipt; `NULL` is "no note
archive has run", which is what every pre-existing row and every `mark_read`
operation means. `mark_read` does not reach notes at all, because a note has no
read state to clear. The apply response and the preview both report the note
half separately, and the client's confirmation names both.

**Why:** The heading is one group to the person reading it. Archiving it and
watching the notes stay was reported as the group coming back half full, and
no other surface clears them in bulk. Nothing about the original design
excluded notes on purpose — the batch was built over the work-stream directory
and notes were simply not part of that index.

**Considered and rejected:** Giving notes their own Queue events, for symmetry
with work streams. Work streams need events because each one is a separate
authority that only its own object may mutate; a note is a row in the workspace
object the request has already reached, so an event would buy nothing but a
second, slower way for the two halves of one grouping to disagree about whether
they happened. Also rejected: freezing note IDs into
`workspace_batch_dispatch_targets` the way work-stream IDs are frozen. Those
rows exist to resume a *partial* Queue publication, which a single statement
cannot have; the only thing a retry can get wrong here is widening the
selection, and one count closes that.

**Consequences, and what a future change has to respect:** A new update kind
must decide explicitly whether it reaches notes, and say so in both the preview
and the confirmation rather than letting one count stand for two authorities.
The note archive must stay ahead of the Queue sends: it is the half that is
finished when the response returns, so a transport failure has to leave a retry
with only work streams outstanding. Its receipt is a count and not a set, so
nothing may come to depend on knowing *which* notes an operation took. The
range is compared against `notes.last_activity_at`, an ISO string, so any
timestamp reaching that comparison has to be re-spelled as canonical UTC first
— an offset that sorts differently would silently select the wrong group.

### 2026-08-31 — Batch receipts fit inside the object SQLite bind ceiling

**What changed:** The Worker publishes at most 50 mass-update messages per Queue
call. WorkspaceDO records a published chunk by expanding one bound JSON array
with `json_each`, rather than expanding its work-stream IDs into separate SQL
parameters. The real-workerd directory suite also exercises 100 IDs directly so
the receipt remains safe if the transport limit changes later. Review of the
same boundary also moved readable-ID, internal directory-lookup, and draft
attachment selection to one JSON binding each.

**Why:** The receipt statement also binds its timestamp and operation ID. A
100-message Queue chunk therefore became 102 SQL parameters, over object
SQLite's 100-parameter ceiling, after the Queue had already accepted every
message. The archive completed but the request returned an internal error and
left those dispatch rows falsely pending. The accepted maxima on the three
reviewed sibling reads produced 101, 252, and 102 parameters respectively, so
they could fail through the same real-runtime ceiling.

The product owner selected 50 messages per call during the incident follow-up;
no load-derived or operational derivation beyond that explicit selection was
recorded. Cloudflare's platform maximum remains 100 messages per `sendBatch`.

**Considered and rejected:** Treating a smaller transport chunk as the only fix
would leave the receipt coupled to the statement's current scalar count and
allow a later batch-size increase to recreate the incident. Splitting one
receipt into smaller SQL updates would make a single successfully published
Queue chunk only partly recorded. The explicit 50-message call limit plus one
JSON binding keeps both boundaries clear and the receipt atomic.

**Consequences:** A 255-item change now uses six Queue calls instead of three.
With the known SQLite failure removed, a retry skips each chunk whose dispatch
receipt committed. A Queue-accepted chunk whose receipt did not commit can
still be republished; child inbox receipts deduplicate it. Changes to this
receipt must retain the real-workerd 100-ID case and must not expand caller IDs
into individual binds alongside other parameters.

### 2026-08-30 — Person mention Markdown uses `person://`

**What changed:** Composer prepare and related writers emit
`[@Name](person://<user-id>)`. Readers still accept bare `person:<user-id>`.

**Why:** Aligns person mentions with the URL-style schemes the rest of the
product teaches (`resource://`), so a model that generalizes does not produce a
form the chip matcher and notification reducers miss.

### 2026-08-30 — Suggested context state was retired from every object layer

**What changed:** SubstreamAgent migration 35 drops `suggested_actions` and
pending suggestion outbox rows; old `suggested_activity` links become ordinary
attachments. Accepted source audiences are copied first into generic immutable
`content_audience_fences`, so participant and scope widening stays fail-closed.
WorkstreamDO migration 4 removes pending feedback rows and WorkspaceDO migration
25 drops the feedback projection. Receivers retain a parse-only feedback
tombstone so older isolates can drain their already-committed envelopes. The
runtime exposes no suggestion RPCs.

**Why:** Removing the Suggested context product requires removing its durable
authority and delivery machinery, not merely hiding its desktop card.

**Considered and rejected:** Retaining the tables for a possible re-enable.
That would preserve unused authorization invariants, alarms, and cross-object
effects as permanent maintenance surface.

**Consequences:** Accepted resources remain attached without suggestion state,
and their original reader boundary still constrains the work stream. Pending
cards and feedback are intentionally discarded, mixed-version deliveries can
settle, and released migration versions remain immutable.

### 2026-08-30 — Sidebar facepile omits the current viewer

**What changed:** The desktop no longer paints the signed-in person in a personal
row's `AvatarStack`. A pile that would only be them is omitted. Overflow treats
them as already shown when they were in the three preview ids, and drops them
from `+x` when they were not. The public globe explains itself with the standard
tooltip ("This is a public work stream"), and each remaining face names that
person the same way.

**Why:** seeing your own initials on every private row you are alone in is not
a membership signal. The preview is still common state — the same three ids for
every participant — so the filter stays in the renderer rather than becoming a
per-recipient directory field.

**Considered and rejected:** computing a viewer-specific preview in WorkspaceDO.
A membership change is common state for everyone who can see the row; splitting
the cap per recipient would make the pile a viewer overlay. Also rejected:
leaving native `title` on the globe and on non-present faces, which is a second
tooltip language the rest of the sidebar row does not use.

**What a future change has to respect:** the wire still includes the viewer.
Do not special-case a solo pile on the directory. Name tooltips live on
`AvatarStack` itself, not a sidebar-only wrapper.

### 2026-08-30 — Pending queue order is live, and in-flight Electron sends default to queue

**What changed:** Schema v34 recreates `pending_loop_inputs_prepared_immutable`
without `input_sequence` in `UPDATE OF`, so a drag can permute promotion order
while prepared content stays frozen. `SubstreamLoopStorage.reorderPendingInputs`
takes the full visible id list, ignores already-delivered ids, keeps unnamed
visible rows behind the named ones, and does not bump loop revision or consume
`next_input_sequence`. REST `PUT /workstreams/:id/pending-inputs` is the
mutation; `loop_input_upserted` is the fan-out. Electron drops the steer/queue
dropdown while a loop is running, always sends `queue`, and paints pending
rows (plus an optimistic send) as an attached list on the composer with the
author's avatar and a hover drag handle. Slack still defaults to `steer`.

**Why:** The dropdown made "interrupt this response" the default of a control
almost nobody needed, and the pending pills lived in the transcript — away
from the composer a second person uses to add to the same queue. Order had
to be live across viewers; that is a sequence rewrite, not a second input.

**Considered and rejected:** Keeping steer as the Electron default and only
changing the label. The request was to default to queue and remove the
choice while a loop is in flight. Also rejected: bumping loop revision on
reorder, which would trip in-flight execution fences. Also rejected:
sorting the composer list by socket `eventSequence`, which is room order,
not FIFO.

**What a future change has to respect:** Hidden pending rows behind a
preparing mailbox head keep the sequences they already hold. Temporary
values during the two-phase unique swap come from `next_input_sequence`
without consuming it. Prepared columns remain in the immutability trigger.
Do not edit shipped v33.

### 2026-08-30 — Facepile order is join time, not overlay recency

**What changed:** WorkspaceDO stores `participants.added_at` on each viewer row
as `participant_added_at` and sorts the sidebar preview by that column, matching
WorkstreamDO `summary()`. `projected_at` is no longer the facepile clock. Adding
or removing a participant publishes the recomputed row to every subscribed
viewer, not only the person whose overlay changed. The preview query is loaded
once per state push and chunked under the engine's 100-parameter bind limit.
The desktop counts unresolved preview ids toward overflow, hides the pile from
the row's accessible name, fills an empty control-socket seed from a later
directory row at the same waterline, and strips leftover ids when a row is
workspace-scoped so a public row cannot keep a personal pile.

**Why:** `projected_at` is rewritten on every viewer projection (unread, mention,
seen). A message fans out to every participant in one envelope batch applied in
one synchronous loop, so workerd hands them the same `Date.now()` and the
tie-break is `user_id` — three lowest UUIDs, not three newest people. The
changelog's split-clocks rationale assumed `summary()` never wrote the field
the sidebar reads; REST merge of the summary does, so the two clocks swapped
faces on a read-ack. Membership was still a per-user overlay, so everyone
else's pile stayed stale until reconnect.

**Considered and rejected:** activity recency as the product meaning of "most
recent". Join time is what both producers already have without a new clock, and
it is stable across unread. Putting the preview on WorkstreamDO control
metadata was rejected because `metadataForUser` cannot see
`participants.added_at`. Clearing the pile from control `common` was already
not happening; the remaining race is a seed that claims empty ids at a
waterline the directory later cannot beat.

**What a future change has to respect:** one clock for the field.
`participant_added_at` is the overlay copy of `participants.added_at`; do not
sort the preview by `projected_at`. A membership change is common state for
everyone who can see the row. Fan-in `IN` lists must use `boundParameterChunks`.
A control snapshot must not be the authority for ids it does not know,
including by seeding empty ones that pin the waterline. A workspace-scoped
row never carries a pile, including leftover ids from when it was personal.

### 2026-08-30 — Sidebar facepile is the existing AvatarStack size

**What changed:** The sidebar trailing slot uses `AvatarStack` at its existing
24px size. The compact size variant added for that slot is gone. `extraCount`
remains so a directory list truncated to three ids can still paint `+x`.

**Why:** a second size was a parallel facepile, not reuse of the one the header
already paints. The Air row is 31px; 24px faces already fit.

**Considered and rejected:** CSS-shrinking only the sidebar stack. That would
still be a second look. Padding dummy members so native overflow could fire
would pollute the accessible name.

**What a future change has to respect:** do not add an `Avatar` size for this
slot. `AvatarStack` with `limit={3}` and `extraCount` is the facepile.

### 2026-08-30 — Personal sidebar rows carry a bounded participant facepile

**What changed:** Directory `Workstream` rows gained `participantUserIds` (max
three) and `participantExtraCount`. WorkspaceDO fills them from active
participant overlay rows ordered by `projected_at DESC, user_id`, and only for
`scope = 'personal'`. WorkstreamDO `summary()` fills the same fields from
`participants.added_at DESC, user_id` so a REST mutation that merges the
summary does not drop the pile. The desktop reuses `AvatarStack` in compact
size for the trailing slot; workspace-scoped rows paint a globe instead. Notes
keep the lock.

**Why:** a lock on every personal work-stream row said "only you", which is the
wrong statement once more than one person is in it. The people in it are
already on the directory overlay, so the sidebar can paint them without a
fetch. Three faces plus `+x` is a product ceiling sized for the 30px Air row,
not a number to guess later.

**Considered and rejected:** a REST members fetch per row, or sending the full
participant list on the directory page. Both grow with roster size; the
sidebar only paints three faces. Also rejected: one sort key shared by the
directory and WorkstreamDO. Overlay recency is the best signal the directory
has; `added_at` is what the child has without a round trip, and mixing them
would make a rename reshuffle faces for no product reason.

**What a future change has to respect:** a workspace-scoped row must not carry
ids. Raising `WORKSTREAM_SIDEBAR_FACEPILE_LIMIT` is a product decision because
it is also the wire cap. Unresolved ids are skipped, not substituted.

### 2026-08-30 — Pre-inference notification tests no longer start model loops

**What changed:** `participant-notification.test.ts` provisions existing rooms
through the real runtime-bootstrap and identity ports, invokes the real
`initialize` product mutation without activating its admitted opening run for
create-only assertions, and gives the elicitation-answer case a settled parent
run row. The file no longer installs a provider double or waits for an unrelated
opening run to settle.

**Why:** Deploy API 33295492419 failed after the object-id isolation below had
landed: one add-to-two-rooms assertion saw no parent receipt and the elicitation
case remained `executing:1`. The shared cause was not object naming. The fixture
started inference for every pre-inference storage assertion, leaving alarm work
to cross `reset()` under shard contention. Different ids made stale roots less
likely to collide; they did not make unnecessary asynchronous work complete.

**Considered and rejected:** More unique ids, a longer poll, and another forced
alarm. The first cut already showed that a draining object per case exhausts the
shard, while the latter two only give unrelated inference more time to finish.
The product paths under test have explicit non-running boundaries, so the test
uses those boundaries instead.

**Consequences:** A test of committed creation state may leave an admitted run
in storage only when it never activates that run. A test of an existing room
uses `provision`; a test of model execution uses the execution pipeline suite.
Do not make a pre-inference assertion depend on alarm timing merely because the
public create endpoint normally proceeds to inference.

### 2026-08-30 — Mention-confirmation and elicitation tests get their own work-stream ids

**What changed:** The three mention-confirmation cases and the elicitation
answer case in `participant-notification.test.ts` each open a distinct
work-stream id (`6b5`–`6b8`). The file's D1 seed is now `CREATE TABLE IF NOT
EXISTS` / `INSERT OR REPLACE`, matching the documented workers-suite seed
shape. Notify-create isolation and deploy worker sharding already landed in
#428.

**Why:** Release Rally for macOS 33290369991 (`pnpm test`, unsharded workers)
failed two poll timeouts after #422 — `waitForCanonicalTurn` (0 vs 1) and
`waitForQuietLoop` (`executing:1`). Those are silent-replay failures:
`initialize` on an already-authoritative root returns 200 with no fresh loop,
and these four still shared `WORKSTREAM_ID` with every add-afterwards
neighbour. A third reported error, `CREATE TABLE workstream_authority_control
already exists`, is a different layer: the next `beforeEach` after an
incomplete `reset()` used plain `CREATE TABLE`. Unique ids do not govern D1,
so isolation alone would leave that cascade standing. Product mention and
elicitation code did not change.

**Considered and rejected:** Minting a fresh id for every test in the file
(`isolatedWorkstream()`). #428's first revision did that and CI shard 1/2 timed
out the same promotion polls, then failed to wipe D1. Also rejected:
`waitForQuietLoop` at the end of the three mention cases so isolation would
not add draining objects. Those tests wait on the canonical turn row only; a
quiet-loop poll would spend the 10s budget on a precondition they do not
assert. Four extra live objects (on top of the six the file already named) is
under the threshold that timed out shard 1/2 (a draining object per all 18
`it`s).

**Consequences:** A new wait-on-promotion case in this file that reuses
`WORKSTREAM_ID` can fail the same poll timeouts on an unsharded workers run
(release `pnpm test`, or a future deploy lane). Isolate that case; do not mint
a unique id for the whole file. The isolation rule lives in
[`testing.md`](testing.md#writing-a-workerd-test). The three
mention-confirmation cases still return with their loops possibly executing —
they poll the turn row only — so isolation costs three extra draining objects.
That is under the 18-object threshold that timed out shard 1/2; do not add
`waitForQuietLoop` there to recoup it. An incomplete `reset()` no longer
fails the next `it` as `CREATE TABLE … already exists` in this file; other
workers tests that still use plain `CREATE TABLE` can still cascade that way.

### 2026-08-29 — Terminal projections read one canonical turn by identity

**What changed:** `WorkstreamObjectProductService.messageForRuntime` hydrates
one participant-visible canonical turn by its opaque transcript ID, while
`openElicitationMessageForRuntime` resolves a pending question through the
canonical turn it created. Agent-run settlement uses those reads before any
external-platform delivery. A terminal outcome that names an unreadable turn
retains `agent_final_turn_not_saved` as a diagnostic, settles provider status,
and emits no result body instead of retrying forever.

**Why:** The previous path loaded the newest 250 messages and parsed each through
a UUID-only message schema before searching for `finalTurnId`. Structured
assistant IDs were valid transcript identities, so the parse failed before the
search and left terminal side effects retrying. Even with the schema corrected,
a recent-page scan is the wrong authority query for an exact terminal key.

**Considered and rejected:** Raising the page limit or looking at the live
stream checkpoint. A limit only moves the transcript-length failure, while the
checkpoint is transient output and cannot authorize an external write.

**What a future change has to respect:** A hydrated canonical turn is the only
source of participant-visible external content. External replies, comments,
notifications, and automation result bodies must remain downstream of that
saved-turn read.

### 2026-08-29 — The origin label is a question to WorkspaceDO, not SQL through the facade

**What changed:** `WorkspaceDO.automationOriginLabel` is a new typed method
returning an automation's current title, or `null` once it is deleted.
`workstream-object-product.ts` calls it in place of the SQL statement it used to
send through the workspace runtime facade, so no statement that facade routes
names `automation_directory` any more. The schemas live beside the other
directory contracts in `workspace-directory-protocol.ts`, and what the method
decides is asserted in `test-workers/workspace-automation-origin-label.test.ts`
against a real object.

**Why:** the facade routes a statement by the table names in it, and its
fallthrough is the regional database. `automation_directory`, added by
WorkspaceDO migration 22, was missing from that allowlist, so the read went to
D1 and answered `no such table` — a 500 on every attempt to open an
automation's run work stream. A method cannot be routed to the wrong database:
its tables are named in the object that has them, and its arguments are a
signature rather than a string a router has to parse.

**Considered and rejected:** one method returning the pin position as well, so
a summary makes one round trip to the workspace instead of two. It is the
better shape and it is not what shipped: the pin read is correct today, and
folding it in makes every summary — automation-generated or not — depend on the
workspace namespace binding, which is a behaviour change to every work stream in
service of a defect in one. Also rejected: leaving the read as SQL and relying
on the routing entry added with the fix. That entry is real and stays, but it
protects one table by remembering to, and this is the third defect of that
family in that router. Also rejected: converting the whole facade at once —
roughly 470 prepared statements across 33 files, spanning connections, memory,
digests, notes, resources, Slack and automations. That is a per-domain
migration, and one diff of it would be neither reviewable nor reversible.

**What a future change has to respect:** `automation_directory` needs both
lists, and they do different jobs. `WORKSPACE_LOCAL_TABLES` decides *where* a
statement goes, so the entry stays even with no facade statement naming it —
without it the read took the regional fallthrough. `WORKSPACE_TYPED_RPC_ONLY_TABLES`
in `workspace-do.ts` decides whether a generic statement is allowed at all, and
the table is added to it here now that the only reader is a typed method: a
statement that arrives anyway is a mistake, and the object says so rather than
executing it. The routing-coverage test in
`apps/api/test/workspace-runtime-database.test.ts` requires every WorkspaceDO
table to be declared on one routing list or the other, so a new table cannot
quietly acquire the regional default.

### 2026-08-28 — Automations leave WorkspaceDO, and their runs become hidden child work streams

**What changed:** `AutomationAgent` provisions each occurrence as a private
generated work stream carrying an immutable run context. Workspace directories
exclude it from the global sidebar; the parent exposes only content-free paged
history, and opening the child rechecks its own current audience. Every generated
child is `personal` with the automation's author as its only participant,
whatever the automation's scope. On this object's side, migration 22 adds
`automation_directory`, `automation_creation_claims`, the external-event
registration and delivery tables, and the cutover ledger; the cutover then drops
the whole `automation_subscriptions` family, rebuilds `schedules` without its
automation column, and deletes automation memory scopes. Shared
`automation_templates` and their versions stay.

**Why:** Runs need the proven work-stream execution loop, but most people care
about the automation rather than implementation work streams in navigation. And
an automation's own state needed one transactional authority, which a workspace
shared by every automation could not be.

**Considered and rejected:** Making the generated child inherit the automation's
scope, which is what the previous producers did. That made a workspace
automation's every run readable by every member, including runs over a
connection they cannot otherwise see, and gave the run's audience a second
answer that could drift from the automation's own.

**Consequences:** SubstreamAgent remains the child execution authority and
AutomationAgent never stores child transcript or participant payloads. This
object's table inventory above is now the *whole* of the workspace's automation
surface — a directory row, a creation claim, an event index and its delivery
ledger — and none of it can authorize a read. A fresh WorkspaceDO still creates
the retired tables from its frozen migration 1 and drops them when it writes its
identity row, so `sqlite_master` rather than the migration list is the honest
answer to whether an object still has them.

### 2026-08-28 — Persistent substream loops over a canonical ordered transcript

**What changed:** One breaking, forward-only cutover (schema v33 from shipped
v32): each substream is one persistent execution loop; runs are subordinate
execution receipts; canonical transcript turns are the only display authority;
pending and streaming state are explicit server-authoritative overlays. The
facets below are the decisions this change is made of — they landed together in
one revision and are recorded per facet because each carries its own rejected
alternative and its own invariant.

**Why:** The message-ordering incident was caused by competing order
authorities — canonical turns, compatibility message records, per-run terminal
aggregates, and arrival-ordered stream state — and by durable positions being
allocated after asynchronous work instead of at admission. No patch inside the
per-message run model could close the class.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

#### Loop time is monotonic bookkeeping and recovery is diagnosable

**What changed:** `#bumpLoop` and every loop/receipt write clamp `updated_at`
monotonically (`MAX(updated_at, ?)`); `nextLoopWorkAt` derives a due receipt's
wake time even when the loop singleton does not exist yet; snapshot assembly
failures are logged (`substream_snapshot_assembly_failed`) before degrading to
a resync; and an external elicitation answer's authorization refusal returns
the product's own status (403) instead of a blanket 409.

**Why:** Loop rows carry `CHECK (updated_at >= created_at)` while callers
supply `now` from clocks that can lag the row's creator (a test's fixed
timestamps; `Date.now()` across isolate replacement), so an unclamped write
can violate the CHECK intermittently. Without the receipt-first wake
derivation, a recovered or pre-activation receipt contributed no alarm and
stalled with nothing left to rediscover it. And a silently swallowed snapshot
failure turns a real assembly defect into an unexplained client resync with no
recorded cause.

**Considered and rejected:** Storing the caller's clock in `updated_at` and
relaxing the CHECK instead. That conflates bookkeeping with event time and
weakens an invariant every reader of the row relies on.

**Consequences, and what a future change has to respect:** `updated_at` on
loop-owned rows is monotonic bookkeeping, not an event time — code that needs
the caller's clock reads a column that stores it. A receipt with
`execution_context_json` must contribute a wake time regardless of loop-row
existence. A snapshot that cannot be assembled is an object defect first and a
client resync second; keep the log line ahead of the degradation.

#### Recovered ambiguous writes stay ambiguous end to end

**What changed:** The unshipped activity projection accepts `ambiguous` as a
terminal state, and recovery propagates it from the tool block through plugin
and assistant activity aggregates. The cutover rebuilds only the derived timing
projection; canonical transcript turns remain untouched.

**Why:** An external write with an unknown result is materially different from
a known failure because Rally must not retry it. Collapsing the activity tree to
`failed` made reconnect and timing surfaces contradict the durable tool block.

**Considered and rejected:** Keeping the narrow old CHECK and translating the
state only for storage. That would make the database, protocol, and renderer
disagree about the same execution outcome.

**Consequences:** Recovery can close the full activity tree without violating a
CHECK, and the no-transparent-retry warning survives live rendering, reconnect,
and cold reload. The forward-only rebuild loses only pre-cutover derived timing
rows, not workspace message history.

#### Failure turns publish atomically and pending inputs reveal in FIFO order

**What changed:** Failed or stopped reserved assistant turns now enqueue their
canonical transcript reference in the same SQLite transaction that materializes
the status turn. Pending-input preparation also publishes only the newly
visible FIFO prefix: a later ready input stays absent from both realtime and
snapshots until every earlier preparation has completed, failed, or been
discarded.

**Why:** A subscribed member could otherwise keep an abandoned partial response
until reconnect even though the explanatory status turn was already durable.
And publishing a later ready input while the snapshot correctly hid it behind
an earlier preparation made a live overlay disappear on reconnect until that
earlier preparation settled.

**Considered and rejected:** Publishing the status turn after the transaction,
which recreates the mutation-without-event crash window; and a separate hidden
900,000-byte transcript ceiling, which had no product requirement and drifted
from the reviewed socket contract.

**Consequences:** Live failure rollback converges in canonical sequence before
`stream_completed`.
Pending overlays now have one FIFO visibility rule across both transports.
Their transcript anchor is reserved alongside `input_sequence` before any
external preparation await, so completion timing cannot invert their rendered
order or make them swap when canonicalized.


#### Required behavior is mapped to the focused shipping contract

**What changed:** The module testing section now points to the PRD's concise
objective/scenario mapping rather than treating a list of related suites as
proof. It names the real SQL, workerd, Desktop, authority, and local-E2E files
for the persistent-loop and canonical-ordering behavior being shipped.

**Why:** The message-ordering defect escaped broad suites that exercised nearby
storage and renderer code. The replacement keeps exact behavior-to-test
traceability while removing compatibility migration, fleet-operation,
benchmark, provider-matrix, and exhaustive-fault gates that conflict with the
approved forward-only product.

**Considered and rejected:** Retaining the 94-case audit as a measure of rigor.
It made unrequested systems release blockers and made the genuine semantic E2E
and observable-failure gaps harder to see.

**Consequences:** The focused contract's original product-path and
bounded-range gaps now have named real-workerd and Desktop implementations. Existing named
tests still require exact-head execution, and new or modified tests still
require the repository's deliberate-break proof.


#### Terminal receipts close execution-owned activity intervals

**What changed:** Run terminalization closes every still-active response,
assistant, plugin, and tool interval rooted in that execution inside the same
SQLite transaction. Recovery-stopped intervals carry
`boundary_source = recovered` and `timing_accuracy = upper_bound`; the desktop
renders their historical duration as “at most …”. Interrupted assistant tool
batches use the same qualified boundary when their durable results are repaired.

**Why:** The ordinary harness finally block closes observed activities, but an
isolate loss can bypass it. The run receipt could therefore become terminal
while a response or child activity remained active forever, making reconnects
continue a clock for work that had already ended.

**Considered and rejected:** A later UI timeout or an independent activity
reaper. Both create a second lifecycle authority and cannot share the terminal
receipt's exact atomic boundary.

**Consequences:** A terminal execution can never retain an active activity tree.
Recovered durations are conservative upper bounds rather than invented exact
stop times, and realtime activity references are enqueued with the settlement.

#### Elicitation promotion and Bind settlement are one transaction

**What changed:** `elicitation_requests` records the stable tool-call receipt ID.
Pending answer promotion derives the provider call ID from the current durable
Bind projection, appends its answer tool result, and promotes the participant
turn only to canonical UI history under the same loop/execution/head fence.

**Why:** Promoting only the participant message left the prior assistant's
`core_request_elicitation` call unanswered. Bind refused that invalid protocol
history, stranding an accepted answer outside the persistent loop.

**Considered and rejected:** Rebuilding or replacing the complete model history
on answer. Canonical transcript and current Bind projection are already the two
durable inputs; replacing history would hide the missing transition instead of
recording it.

**Consequences:** Answer admission may remain pending, but delivery is all or
nothing: the sole model-facing tool result, participant authority, transcript
order, and pending-row removal commit together before the next inference. The
canonical participant turn is deliberately not a second Bind user message.
The cutover
deletes pre-persistent-loop elicitation request rows before making the stable
tool slot required, because those operational rows did not record an identity
that can be backfilled honestly. Their canonical question/answer turns remain
in the independent transcript authority; this is a forward-only execution-state
cutover, not transcript deletion.

#### Lazy transcript ranges and indivisible turns obey one byte budget

**What changed:** Correlated `transcript_range` replies now enforce the same
1,000,000-byte realtime-frame budget as opening transcript snapshots. An
oversized reply removes whole turns from its tail and narrows
`covered.endExclusive` to the first omitted canonical sequence while retaining
the caller's full `requested` interval. A sole turn that cannot fit is
represented by a sequence-owning payload-free envelope: `blocksOmitted: true`
plus the true `blockCount`, with the client rendering a "too large to display"
placeholder in its canonical position. No block payload is copied into a
second authority.

**Why:** The snapshot path enforced the transport ceiling, but the lazy range
path serialized its complete result directly. Twenty individually valid turns
could therefore produce a frame the Electron broker refused, losing the range
without a truthful continuation boundary.

**Considered and rejected:** Marking omitted history covered, which loses
history; splitting the ordered range frame into an unbounded reassembly
protocol, which couples sequence coverage to byte delivery; copying block JSON
into a parallel blob store, which creates duplicate payload authority; and an
out-of-line delivery protocol for the oversized payload itself (immutable
manifest tables plus chunked, hash-verified byte-range hydration). Nothing in
the product can produce an indivisible oversized turn today — provider output
is chunked well below the frame limit and pending inputs are bounded at
admission — so that transport would exist to serve a row no code writes.

**Consequences:** Electron's existing range-union logic leaves any omitted
multi-turn suffix as a requestable gap. An indivisible envelope advances exact
coverage immediately and keeps ordering independent of payload delivery; its
content is deliberately not delivered, and the agent logs
`substream_transcript_turn_oversized` when this fires. The envelope contract
(`blocksOmitted`) is the whole interface at this boundary: a future feature
that can genuinely produce oversized turns builds its delivery mechanism
behind that flag — the envelope already owns the sequence — and the log line
is the signal to design delivery against an actual producer rather than a
guess.

#### Message admission receipts describe admission, not execution

**What changed:** Human HTTP/socket commands and connector ingress now return
the accepted turn plus `deliveryState: canonical | pending`. Replay returns the
same shape with the current durable state. Product-only insertion and activation
facts stay inside SubstreamAgent; public receipts and message-send telemetry no
longer expose `agentInvoked`, nullable harness/workflow placeholders, or
`shouldActivate`.

**Why:** A committed pending input can request a wake without proving that the
persistent loop has claimed an execution. The old receipt crossed that boundary
and could claim work had begun while no execution receipt existed. It also made
replay a historical label instead of answering the caller's useful question:
whether the accepted turn is canonical yet.

**Considered and rejected:** Returning the internal activation request or a
synthetic harness identity for convenience. Both would make admission a second
execution authority and reintroduce per-message run semantics. Callers that need
execution state read the loop and its real subordinate receipts.

**Consequences:** Pending desktop overlays remain visibly pending after command
acknowledgement and converge through server snapshots/realtime promotion. Slack
audit insertion is idempotent by admitted turn identity, so loss of a public
`replayed` outcome cannot duplicate audit rows.

#### Work-stream execution has no compatibility SQL path

**What changed:** The cutover drops the final run/inference/user compatibility
views, their run/inference triggers, and the statement-change counter. The
SubstreamAgent no longer exposes a runtime SQL RPC or rewrites D1 table names.
Memory authorization, automation recovery, telemetry, development fixtures,
Terminal, naming, and source-runtime readers now use explicit typed object
operations over normalized storage.

**Why:** A generic SQL proxy let unrelated callers share an untyped vocabulary,
hid which object owned a read, and kept per-message-era views in the forward
execution path. That was both extra authority and extra work on every routed
statement. A persistent loop needs one durable owner and narrow subordinate
receipt operations, not a database-shaped compatibility surface.

**Considered and rejected:** Keeping the router as a read-only adapter or a test
fixture. A second query vocabulary would still be a second protocol, and tests
of its rewrites would prove the shim rather than the product behavior.
WorkspaceDO's separate rollout adapter is not part of this removal because it
owns distinct workspace-scoped tables and migration history.

**Consequences:** Run and receipt writes reject the retired `waiting` and
`steering` per-run phases at their active operation boundary. The original
`runs` CHECK still names those inert values because removing them alone requires
rebuilding the table and its foreign-key closure; no forward API can create or
interpret them. Run rows remain subordinate execution receipts. Trigger-turn
identity is causal provenance. The loop's stop fields implement ordinary
safe-boundary Stop; receipt cancellation fields remain limited to subordinate
child or generic execution cleanup. Neither makes a run the loop owner.

#### Delivery deletes the pending envelope

**What changed:** Atomic promotion now replaces the full `pending_loop_inputs`
row with a minimal `delivered_loop_inputs` receipt and deletes the ready mailbox
plus attachment-recovery rows. The canonical participant turn/facts remain the
only content, provenance, attachment, mention, and authorization history.
Subordinate runs reference the receipt, and delayed pending-upsert realtime
references converge to a delivered removal through it.

**Why:** A delivered pending row duplicated canonical authority and retained the
whole prepared envelope indefinitely. Crash replay and response-loss recovery
need a stable input-to-turn witness, not a second transcript.

**Considered and rejected:** Leaving `state = delivered` on the prepared row or
copying its payload into a new receipt. Both retain two representations that can
drift and make every reader decide which one wins.

**Consequences:** Pending snapshots list table existence, not lifecycle flags.
Delivery, receipt insertion, temporary-row deletion, canonical effects, and
realtime removal remain one SQLite transaction; failure restores the pending
envelope and its recovery obligation together.

#### Pending attachment admission has a cross-object hold

**What changed:** A human input with drafts writes an object-local recovery row
before calling WorkspaceDO's typed reservation RPC. Preparing and ready mailbox
rows retain the hold. Failed preparations replay an idempotent release;
delivered inputs delete the recovery row in the local commit that enqueues
WorkspaceDO's canonical resource projection, while directly canonical inputs
leave release to that projection.

**Why:** The persistent loop owns input order, but it does not own workspace
resources. Crossing that boundary without a durable reservation allowed a delete
or TTL pass to invalidate an already-acknowledged input.

**Considered and rejected:** Moving resources into the substream and treating
all terminal mailbox states alike. Resource ownership is workspace-scoped, and
`discarded` also describes the successful direct-canonical path whose projection
may still be pending.

**Consequences:** The local recovery table carries no attachment content and no
independent lifecycle. Its only job is to make reserve/release RPC ambiguity
recoverable; WorkspaceDO remains the deletion and canonical-link authority.

#### Current Bind storage has one head and delta message writes

**What changed:** The cutover replaces the interim `bind_loop_states`; `bind_loop_heads` now
owns all current projection metadata and current message facts reference it
directly. `WorkstreamTranscriptStorage` validates a cached immutable projection
against that head, inserts only an appended suffix, updates only a changed
system row, and reserves full-set replacement for initialization or compaction.

**Why:** Maintaining two current metadata rows plus reading and rewriting the
whole message history for one append made both authority and cost grow in the
wrong direction. A persistent substream loop is expected to outlive individual
execution receipts, so ordinary transition work must not scale with every prior
turn.

**Considered and rejected:** A compatibility view/table and a generalized event
store. The cutover is unshipped history, deliberately discards prior run-shaped projections,
and already has the two histories it actually needs: immutable activation
receipts for replay and exact provider-boundary hashes for verification.

**Consequences:** A cold object reconstructs the current chain once, and each
provider request still proves exact full-array equality. Hot ordinary writes are
proportional to their delta. Compaction remains explicitly linear because it
replaces the model context by design.

#### Canonical transcript visibility gets an object-local outbox

**What changed:** Transcript turns, activity updates, and pending-input
admission/delivery now allocate a room sequence and store a canonical reference
in `durable_outbox` in the same SQLite transaction as their authoritative
mutation. `SubstreamAgent` drains those references in sequence, persists the
HyperSight refresh intent before acknowledgement, and derives alarm recovery
from remaining rows. Subordinate execution receipts now persist their actual
substream instead of hardcoding main substream `0`.

**Why:** The prior post-commit `publishAgentRuntimeEvent` call left two invalid
crash windows: a committed transition could disappear from live clients if the
isolate died before publication, and a publication or dashboard-scheduling
failure could be reported as though the already-accepted Bind transition had
failed. The hardcoded receipt also assigned child executions to the wrong
substream authority.

**Considered and rejected:** Copying complete socket payloads into a second
outbox-specific transcript was rejected because it creates another message
authority. Best-effort publication without a durable reference was rejected
because reconnect eventually repairing state does not make the live semantic
change crash-atomic.

**Consequences:** Canonical room events may replay the same sequence after a
crash, which is intentionally idempotent. Ephemeral frames yield behind a
pending canonical reference, and constructor/alarm derivation recovers any row
left after commit.

#### The terminal boundary releases execution ownership

**What changed:** Safe-step settlement now advances only the persistent loop's
step ordinal and Bind revision. The singleton remains executing until the
host-outcome and terminal receipt commit closes execution ownership. Failed or
stopped assistant reservations materialize as typed status pills; partial
provider bytes never become a final assistant turn. Pending inputs remain
immutable prepared facts, so a correction is another FIFO input rather than an
edit or cancellation race.

**Why:** Idling the singleton while its subordinate receipt was still running
created a crash window that stranded the receipt outside the only active loop
authority. Adopting interrupted partial bytes or mutating pending facts would
create equivalent second authorities for assistant content or delivery order.

**Considered and rejected:** Letting the safe step release the loop and teaching
recovery to discover detached receipts, retaining interrupted prefixes as final
turns, and adding mutable pending revisions. Each moves correctness into
reconciliation after the authoritative transaction instead of making the
invalid interleaving impossible.

**Consequences:** Steers may promote at a safe step, but queued input waits until
terminalization makes the singleton idle. A receipt cannot remain running behind
an idle loop, a failed preview always rolls back to its status pill, and pending
replay compares one immutable prepared value.


#### Persistent loop state owns admission, recovery, and transcript delivery

**What changed:** The cutover adds one `substream_loops` singleton, immutable
`pending_loop_inputs`, exact `assistant_turn_reservations`, persisted Bind-head
recovery fields, and loop provenance plus restart context on subordinate
`runs`. Transcript snapshots expose pending inputs as identified overlays.
Delivery atomically materializes the prepared participant fact, payload,
provenance, attachments, mentions, transcript sequence, and attention ordinal,
replaces its prepared envelope with a minimal delivery receipt, and synchronously
enqueues its regional effects in the same SQLite transaction. Bind transition,
assistant-error, and compaction
commits advance the singleton's Bind cursor in that transaction too; exact
replay repairs only the historical head-ahead crash window. SubstreamAgent's
`run_steering` and `agent_run_dispatches` tables are removed;
BlockDashboardAgent's separate dispatch ledger is unchanged.
Every conditional loop, receipt, reservation, and pending-input mutation uses
`UPDATE ... RETURNING` and validates the returned identity or revision. It does
not infer a logical transition from `SqlStorageCursor.rowsWritten`, because
workerd counts index maintenance as physical writes; doing so caused a valid
receipt activation to roll back and immediately re-arm its alarm forever.
The migration also deletes pre-cutover Bind heads and their cascading derived
states/messages/boundaries because those heads used per-run IDs; the first
stable-loop activation rebuilds Bind once from retained canonical participant
history instead of guessing which obsolete run projection should win.
The stable projection keeps one current metadata row and ordered message set;
ordinary transitions insert or update only changed messages, while compaction
alone replaces the set. Immutable `bind_activation_inputs` receipts point to
exact facts and preserve activation identity across replacement without full
state snapshots. The cutover deletes pre-existing operational run rows
outright — canonical participant history is the only carried transcript
input — so forward receipt predicates accept only `admitted` and `running`.

**Why:** A message-owned run and compatibility steering row could not represent
one conversation loop across multiple model steps, crash recovery, queued
inputs, and safe-boundary steering. Assigning canonical or unread order at
admission also let presentation get ahead of what the model had actually
received.

**Considered and rejected:** Retaining the old dispatch tables as a fallback,
using a per-message run ID as loop identity, and assigning a provisional
transcript or attention ordinal to pending input. Each option preserves two
authorities or creates order that must later be moved.

**Consequences:** Pending input survives compaction and executor replacement
without becoming canonical or unread early. Recovery retains the loop cycle and
increments only its execution epoch after lease expiry. Assistant order is
reserved before generation and every slot must materialize as accepted output
or an error. Execution receipts remain queryable evidence, but orchestration
must fence lifecycle and pending-set changes on loop revision. Ordinary Bind
commits instead fence stable execution identity/epoch/lease plus the prior Bind
state revision, so concurrent admission or lease renewal cannot invalidate an
otherwise correct provider transition. If the first executor died before
`state_initialized`, the next activation still promotes the oldest input and
starts its receipt atomically, then initializes Bind exactly once from that
canonical history instead of deadlocking on a missing head.
The loop execution epoch is separate from the receipt's harness-attempt epoch:
activation records the former on both the singleton and receipt, recovery
advances both atomically so product failure/settlement can fence the current
owner, and only a harness attempt claim increments the latter. Cycle ordinal
and execution sequence remain immutable activation provenance. Closing a safe
step advances only the loop's step ordinal and Bind revision; the singleton
stays executing until the terminal receipt commit releases ownership, and
host-outcome publication and attempt terminalization own that receipt's final
status. One receipt may therefore carry any number of assistant-turn
reservations within its cycle rather than storing a singular assistant turn.

#### Product admission stopped publishing invoked input before delivery

**What changed:** The product service now initializes one persistent substream
loop with identity derived from the work stream and substream, independently of
any execution receipt. Addressed messages and
elicitation answers store immutable prepared input and return a typed request to
activate that loop; they no longer create a canonical turn, attention ordinal,
regional effect, execution receipt, or workflow input at admission. Stop writes
only the loop's safe-boundary stop request. Retry creates one subordinate
execution receipt whose immutable execution context is the durable activation
intent, then returns that receipt to the same stable loop; it never creates a
second logical loop. Slack opening messages and follow-ups use the same product
admission boundary instead of appending an external turn and separately asking
the Worker to launch a run. External elicitation answers are decided atomically:
an answer remains canonical while another question is still open, and only the
answer that clears the final open question becomes pending invoked input.

**Why:** A message that was visible and notification-producing before Bind
accepted it could be ordered ahead of the assistant/tool step it actually
steered, and a crash could leave transcript history without corresponding model
state. Minting one harness run per message also confused an execution attempt
with the substream's long-lived conversation identity. Connector ingress had
the same defect through a different service: on an already-initialized Bind
loop, rebuilding execution input did not make a separately appended Slack turn
part of the resumed array, so the acknowledged trigger could be absent from the
model call entirely.

**Considered and rejected:** Keeping the eager canonical write and repairing its
display order, continuing to overwrite `run_steering`, and treating a transient
alarm as the retry's activation authority. Those preserve the split-brain
boundary or let a crash forget an acknowledged retry.

**Consequences:** The loop owner must promote the prepared fact, required
participant/resource projections, exact Bind transition, and delivery receipt
atomically with the regional effect outbox before it creates the subordinate
execution receipt. Activation is
currently handed to that owner as a typed request; it may not be reconstructed
from a message-owned run ID. Product tests assert that pending admission leaves
canonical counters, run rows, and regional outbox state unchanged.
Invoked connector producers must call the typed external-admission RPC rather
than composing a generic transcript append with `launchWorkstreamHarness`;
external messages that intentionally do not invoke Bind may still append
canonically through the generic message port.

#### Snapshot provenance fences retained transcript ranges

**What changed:** Snapshot socket frames now say whether they are an initial
delivery, a same-socket reconciliation, or recovery from unavailable replay
history. Electron retains loaded ranges across a new snapshot ID only for the
reconciliation case; initial and history-recovery snapshots replace old-fence
ranges completely. The shared object-port type now maps only its declared
operation union, matching the methods its runtime factory actually constructs.

**Why:** A bounded recovery snapshot contains the latest five turns, not every
turn a reader previously loaded. Relabelling an uncovered old range with its new
snapshot ID could preserve a missed tool completion, elicitation answer,
revision, or retraction indefinitely. Separately, message and scheduling ports
claimed their resident prepare/commit phases were remotely callable even though
the dispatcher never exposed them.

**Considered and rejected:** Retaining only turns that look immutable, eagerly
copying every prior range, and fixing the two port aliases with unrelated
one-off `Pick` wrappers. Canonical turns may revise or retract; old bytes cannot
prove their own freshness; and the port mismatch originated in the shared
factory return type.

**Consequences:** Rare replay loss may temporarily remove paged-in history until
the reader loads that gap at the new fence. Same-socket reconciliation preserves
it without another read because ordered catch-up proves continuity. Any future
snapshot producer must declare which proof it carries, and adding a local-only
storage method cannot silently widen a Worker-side object port.

#### Forward relation cutovers remain valid under enforcement

**What changed:** The canonical relation cutover now stays valid with
foreign-key enforcement enabled at every statement. It copies dependent tool,
publication, suggestion, steering, attachment, and mention rows first, removes
the old graph child-first, and only then removes the compatibility parent. The
released v32 payload migration retains its legacy execution marker and hash;
new migrations do not inherit that exception. The cutover also recreates the
live run view with current turn vocabulary.

**Why:** A foreign-key toggle is connection state, not a safe forward schema
contract. It can be ineffective inside an object event, and deferred checks do
not suppress `ON DELETE` cascades. A migration can therefore report an empty
`foreign_key_check` while having already deleted valid child rows.

**Considered and rejected:** Generalizing a deferred-constraint migration mode.
That abstraction masked missing child relations and made valid SQL depend on
ambient event state. Rebuilding the actual dependency graph is narrower and is
proved with populated rows for every relation.

**Consequences:** Every new referenced-parent change names and tests its complete
incoming dependency graph. A new object's migration ledger is still bootstrapped
inside the first pending transaction, and every shipped migration through v32
remains fingerprint-pinned. The populated v32 upgrade fixture must retain each
seeded transcript relation and operational receipt rather than relying only on
an empty final `foreign_key_check`.


#### Ordered turns and explicit overlays replace compatibility messages

**What changed:** The cutover adds canonical conversation metadata, rebuilds
every message-related foreign key onto `participant_transcript_turns`, renames
turn-owned attachment and mention
relations, and deletes the `workstream_message_records` key shim and detail
view. The socket contract now exposes canonical snapshots/ranges and typed
transient overlays with explicit identity, provenance, revision, and sequence
anchors. Run settlement adopts the canonical Bind turn instead of persisting a
run-final copy. The final implementation names the atomic operation and recovery
checkpoint `publishHostOutcome` / `host_outcome`, because the same commit may
contain an accepted assistant turn, a participant-visible system notice, both,
or neither. The cutover and the wire protocol name the transient run grouping
as `stream_id` / `streamId` and the durable settlement identity as
`final_turn_id` / `finalTurnId`; neither is allowed to masquerade as a message
ID. External ingress and activity routing rely on the canonical turn upsert
emitted by the object port rather than publishing a second message event. The
creation API likewise returns `turnId`, so the optimistic opening row and its
authoritative replacement share one protocol identity. Canonical block
flattening indexes only singleton protocol identities in linear time; it never
deduplicates ordinary blocks by their shared client submission identity.
Human turns persist the author's display name and avatar as an immutable turn
snapshot, so later participant removal cannot erase authorship or change
own-message layout. The wire schema rejects missing, mismatched, or nonhuman author
provenance. Authenticated product operations are the only human write path; the
generic runtime message port accepts only agent, external, and system authors.
The desktop may consult current membership for a revision-zero optimistic turn,
but never for a canonical revision, and the checked-in development fixture
provides the same immutable snapshot required in production.
Resumed harness attempts rebuild attachment-grounding state
from durable tool receipts before any new delta can be published.

**Why:** The incident was not fundamentally a bad sort. Compatibility pages,
canonical ranges, and live state supplied competing identities and ordering
rules. Persisted rows from an unloaded range could be mistaken for live tail
state, while run settlement could copy an already accepted assistant turn. The
same generic message reconciler also collapsed distinct canonical blocks when
one submitted turn legitimately gave them the same `clientMessageId`.

**Considered and rejected:** Filtering duplicated run finals, deduplicating by
text/time, or retaining an ID-only compatibility table. Those patches leave two
authorities and fail for repeated text, clock skew, partial range coverage, and
legitimate multi-turn runs.

**Consequences:** Canonical `transcript_sequence` is the only durable display
order. An overlay may appear between canonical turns only through its declared
anchor and is retired only by its explicit canonical identity. Retired message
page/feed contracts and old Electron builds are deliberately incompatible.
Terminal settlement accepts assistant content only when Bind accepted that
exact turn and content or when an interrupted provider stream supplied the
explicit identity for its own partial bytes. Host-authored terminal guidance
receives its own system-turn identity and never borrows the stream's. The
host-outcome event is durable even with no transcript write, closing the
recovery gap for failures and stops before an assistant turn.
Tests cover permuted timestamps and arrival order, disjoint/empty ranges,
optimistic and streaming handoff, duplicate/stale revisions, large transcripts,
run-final adoption, hibernation recovery, and deletion/FK integrity.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).
### 2026-08-27 — Participant removal preserves one reader

**What changed:** `removeParticipant` now treats the room as collaborative:
any authorized current reader can remove themself or another participant. It
returns an explicit removal outcome, refuses the final active participant
inside the same synchronous SQLite transaction, and closes newly unauthorized
local sockets before fallible event publication. A retry of an already-removed
participant republishes the idempotent removal event.

**Why:** The desktop had no way to reach the existing removal route, and that
route could transition the sole participant to removed. For a personal work
stream, that creates durable content with no remaining reader and no in-product
way to recover it.

**Considered and rejected:** Keeping owner/admin authority for removing another
participant. A work-stream room is governed by its current readers, who already
share the ability to add participants; that is every active workspace member at
workspace scope and the current participants at personal scope, including an
invitee removing the creator. Workspace roles govern workspace membership
instead. Also rejected relying on the modal's disabled final action, because
stale snapshots and concurrent clients are outside its control.

**Consequences:** The object is the final-participant fence, and callers surface
`workstream_participant_required` without retrying. A target with no participant
row emits no event; an already-removed target republishes so a failed or
response-lost first attempt can complete realtime convergence. Socket access is
revoked synchronously from the committed participant fact, so publication
failure cannot extend a removed reader's transcript access. The one-participant
floor deliberately applies at both scopes, even though workspace visibility
would still make a zero-participant stream readable, so participant lifecycle
does not gain a second empty state.
### 2026-08-27 — Canonical transcript ownership becomes the only runtime path

**What changed:** SubstreamAgent schema v32 first proves exact parity for every
legacy message, relationship, and compaction checkpoint, then removes the old
tables, compatibility reads, transfer receipts, and operator RPCs. Runtime
message and residual-tool settlement now update canonical records and their
content-addressed facts directly.

**Why:** The v30 staging period existed only to transfer historical payload
ownership. Keeping both storage families after the fleet and final delta passes
would retain two plausible authorities and allow future writers to diverge.

**Considered and rejected:** Keeping a permanent legacy fallback or copying
unverified rows during constructor migration. A fallback preserves split brain;
constructor SQL cannot perform the asynchronous hashing and source-fenced
preparation required to create canonical facts faithfully.

**Consequences:** An untransferred object fails closed before deletion. Releases
must complete a final delta transfer immediately before deploying this boundary;
afterward, new objects create only canonical storage and the retired operator
surface no longer exists. Compaction facts, participant status edges, and exact
Bind replacements remain distinct and are not synthesized or rewritten.

Shipped in #353. Design: `docs/PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md`.

### 2026-08-27 — Async transcript preparation stays outside product commits

**What changed:** Transcript-producing paths prepare payload hashes and other
yielding material before `commitRuntimeMutation`, then insert the canonical
payload, transcript/root state, and regional projection in one synchronous
SQLite callback. The invariant, failure mode, review limit, and custom lint
coverage are now explicit in this module document.

**Why:** Four newly asynchronous storage operations were dynamically dispatched
from a callback whose declared result was `unknown`. Returning their Promises
from `commitRuntimeMutation` let `transactionSync` finish before their
post-`await` writes, so related facts no longer shared one atomic commit.

**Considered and rejected:** Allowing async methods to prepare lazily from
inside the callback, and treating an ESLint check as a complete proof. The
platform does not extend `transactionSync` for a returned Promise, and static
analysis cannot recover a Promise return after a dynamic cast erases it to
`unknown`.

**Consequences:** New message-producing operations expose separate async
prepare and synchronous commit phases. The linter catches explicit and
type-resolvable indirect Promise returns; reviewers must still inspect dynamic
`.call()`/`.apply()` paths and refuse type erasure at the boundary.

### 2026-08-27 — Replacement instances resume the attempt their predecessor fenced

**What changed:** SubstreamAgent construction replaces still-live local harness
lease owners left by the previous object instance with a durable
recovery-pending owner and expires those leases together with the dispatch
lease. A later replacement recognizes that marker even though its timestamp is
expired, so it preserves recovery intent across consecutive evictions before a
claim; already-expired unmarked leases remain stale-reaper failures. The
replacement reclaims the same attempt ID under a new owner and epoch before it
runs the stale-lease sweep, preserving frozen scope, completed tool receipts,
and resumable child attempts. If cancellation was requested before the owner
vanished, the replacement uses the recovery-pending owner as the attempt fence
to settle the run as stopped instead of misclassifying it as stale failure. An
exact completed tool receipt remains replayable
while ownership transfers; receipt mutation and mismatched-plan paths still
require the live lease. HyperSight roots remain untouched because their executor
belongs to a separate BlockDashboardAgent.

**Why:** Cloudflare can stop a Durable Object while external I/O is in flight;
that I/O may finish before the next local SQLite access is rejected. Production
recorded a completed Terminal command followed by exactly that storage error.
The dispatch lease was released on reconstruction, but the harness lease was
still honored for five minutes, leaving the tool visibly active until the stale
reaper failed the whole run.

**Considered and rejected:** Waiting for the existing lease, immediately
terminalizing the recovered run, clearing every run in the shared authority,
and creating a new attempt ID. They respectively preserve the five-minute
spinner, discard replayable completed work, steal live HyperSight execution,
or invalidate the frozen scope and receipts keyed to the original attempt.

**Consequences:** An object restart can resume a local run immediately without
weakening ordinary live-owner exclusion. The recovery-pending owner immediately
fences the vanished executor, survives another eviction, and is replaced by the
new instance-nonce lease owner with an advanced epoch when execution resumes.
Normal unmarked expiration still follows the stale-run policy; real-workerd
coverage verifies consecutive replacement, cancellation during handoff, and
that constructor recovery touches only leases whose executor died with this
SubstreamAgent instance.

### 2026-08-27 — Transcript payload ownership transfer is explicit fleet work

**What changed:** Schema v30 stages canonical message records and relations,
dual-populates live message writes, and exposes a main-substream-only operator
RPC that transfers retained message/checkpoint payload ownership under one
object-local transaction. The operation captures a real PITR bookmark, hashes
and re-reads the complete source, refuses active writers or immutable client
snapshots, and records a replay-verifiable receipt. Message payload hashes are
prepared before entering the synchronous SQLite mutation, so tool-card writes,
elicitations, and final assistant messages commit their canonical fact and
regional directory effect atomically. Terminal residual-receipt repair uses the
same prepare-then-commit boundary when it refreshes a visible tool card.

**Why:** The earlier range/index backfill was deliberately projection-only.
Deleting the old tables after it would delete the only copy of historical text,
structured tool cards, attachments, mentions, and exact checkpoint arrays.

**Considered and rejected:** Unbounded constructor work and an implicit
best-effort copy during ordinary requests. Neither gives the operator a complete
fleet witness or an atomic failure boundary.

**Consequences, and what a future change has to respect:** Deploy and run this
transfer before the stacked retirement release. Post-cutover compaction facts
retain their existing identities, historical checkpoint arrays remain exact,
and participant compaction status/activity edges are not synthesized or
rewritten. An unowned legacy checkpoint requires the backfill receipt even when
there are no legacy message rows. Mutable tool metadata and participant-safe
tool summaries must remain consistent with their canonical payload after both
ordinary settlement and terminal repair. The cleanup migration must abort
rather than drop data when the verified receipt or canonical references are
incomplete.

### 2026-08-27 — Resource history stays in WorkspaceDO and direction stays on the child link

**What changed:** WorkspaceDO schema v13 adds numbered `resource_versions` and
SubstreamAgent schema v31 rebuilds `workstream_resource_links` with the closed
relationship CHECK. Contracts derive source/artifact direction from that link.

**Why:** Historical bytes are shared workspace resource state, but whether those
bytes entered or were generated is specific to one work stream.

**Considered and rejected:** A resource-level direction column would collapse
two authorities. A free-text relationship would let new values bypass the
derived-direction contract.

**Consequences, and what a future change has to respect:** New relationship
values require a migration and a direction decision. Resource deletion and R2
cleanup must account for every version; link changes never own resource bytes.

### 2026-08-26 — Foreground presence is visible as soon as the tooltip opens

**What changed:** The face-pile presence signal now follows Tailwind's
`animate-ping` treatment: a translucent filled copy of the avatar expands to
twice its size and fades on a one-second loop. It shares the avatar's stacking
layer, paints beneath its own solid avatar, and follows face-pile order so a
participant's ping stays above earlier avatars and below later avatars or the
overflow badge.
Reduced-motion users keep a static translucent halo.

**Why:** The tooltip opens after 300 ms, but the previous 550 ms inset phase was
fully covered by the avatar. A user could hover a correctly present participant,
see the explanatory tooltip, and see no corresponding sonar pulse.

**Considered and rejected:** Increasing the outlined ring's colour or width
would make the later visible phase louder without matching the familiar radar
ping treatment. The halo stays tokenized and subtle while adopting the filled,
expanding geometry.

**Consequences, and what a future change has to respect:** The looping presence
signal must use the avatar's face-pile layer without obscuring its own face or
crossing later avatars or the overflow count, and remain a non-animated outer
halo in reduced-motion mode.

### 2026-08-26 — Legacy transcript rows gain faithful canonical projections

**What changed:** schema v28 adds one receipt for the explicit pre-v27
transcript backfill. A guarded `SubstreamAgent` RPC projects the exact retained
participant order and compaction checkpoints into the canonical range/checkpoint
indexes, shifts a post-cutover suffix atomically, records a pre-write PITR
bookmark and full source digest, and reconciles every replay. Legacy payloads
remain in their existing owning rows; canonical facts store only stable source
references. Historical Bind state is explicitly unavailable. An operator-only
precursor terminalizes lease-less pre-v27 active rows with an explicit
migration-abandonment reason; it refuses every run that acquired a durable
attempt, lease, heartbeat, or open receipt. Schema v29 adds the singleton cleanup
receipt that makes a cleanup-success/backfill-failure retry auditable.

**Why:** the v27 breaking cutover created the correct durable substrate but did
not make existing work-stream rows visible through it. The old `parts` table
does preserve participant-visible order and the old checkpoint table preserves
exact replacement arrays, so discarding those facts would be unnecessary data
loss. It does not preserve the sequence of private messages Bind consumed, so a
backfill cannot truthfully create that projection.

**Considered and rejected:** copying legacy payloads into new fact payloads,
because that creates two owners for identical semantic data; rebuilding Bind
history from aggregate assistant text or the Global inference archive, because
neither is an exact object-local continuation ledger; and performing the scan in
the constructor, because unbounded content work would put every ordinary object
wake on the migration path.

**What a future change has to respect:** source rows referenced by a completed
receipt are immutable transcript owners. A backfill must be quiescent,
object-local, atomic with its receipt, PITR-recoverable, and replay-reconciled.
Before the first receipt, terminal runs receive the established residual-tool
repair phase, isolated from stale-run reaping; this may settle their `admitted`
or `executing` receipts and make
their legacy cards eligible. A still-open receipt after repair and connected
clients holding immutable transcript snapshots remain quiescence failures: later
receipt settlement would invalidate the recorded source digest, while prefix
insertion would change an open fence's sequence meaning. A historical pending
card without an open receipt has no settlement writer and is projected as the
faithful `started` state it owns. An already committed replay is read-only and
does not require disconnection.
It may never claim exact historical Bind state unless a byte-faithful source for
that loop boundary exists. Pre-cutover run abandonment must remain a separate,
explicit operator action with a strict v27 timestamp plus null
attempt/lease/heartbeat and no-open-receipt fence. It may not be generalized
into ordinary backfill quiescence or used to expire current runs.
Its object-local receipt must commit atomically with the run terminalization and
remain the count returned by every retry; a later transcript failure may not
erase or replace that evidence.

### 2026-08-26 — Proactive feed warmth no longer changes viewer presence

**What changed:** SubstreamAgent subscription attachments now carry a
backward-compatible `publishPresence` flag. Current Electron feeds set it to
false, legacy viewer broadcasts and close updates exclude those sockets, and
the UI resolves current viewers from WorkspaceDO. The first directory response
also accepts every live-state row beyond both the 250-row recent page and 1,250
combined entries.

**Why:** A proactive feed can stay connected for an inactive pin or recent work
stream, so subscriber count is no longer foreground attention. The complete
live-state set can legitimately exceed the former arithmetic parser maximum and
must not make workspace subscription fail.

**Considered and rejected:** Closing background feeds would forfeit the warm
open. Filtering only at render time would retain false presence broadcasts and
durable event churn. Truncating live rows would leave precisely the oldest
active runs cold.

**Consequences, and what a future change has to respect:** WorkspaceDO remains
the current client's sole presence authority. Legacy clients continue working
without the new field, while all new proactive feed clients must opt out. The
recent directory remains paged, but pins and live states are complete on the
first response.

Shipped in #341.

### 2026-08-26 — Opening a work stream no longer clears its sidebar description

**What changed:** Electron now maps the direct WorkstreamDO metadata snapshot's
standing `description` to the sidebar subtitle, matching the WorkspaceDO
directory path. The row renderer also falls back to that description when a
resident cache entry carries an empty legacy `preview`.

**Why:** WorkstreamDO still carries `description` and `preview` as distinct
metadata fields, but newly created object-owned work streams do not populate the
legacy preview. The workspace socket correctly seeded the sidebar from
`description`; selecting the row opened the direct socket, whose newer common
waterline replaced that subtitle with the empty preview. The result looked like
the description was deleted only for the active work stream even though the
authoritative description remained intact.

**Considered and rejected:** Backfilling `preview` from transcript text. The
sidebar is documented to show the standing description, not a last-message
excerpt, and coupling this repair to transcript projection would preserve two
competing values for one surface. Removing the metadata field is a separate
contract migration; this change makes the two current socket readers agree.

**Consequences, and what a future change has to respect:** A common-state update
from either socket must produce the same `WorkstreamSummary.preview` value for
the sidebar. An empty legacy preview must not outrank a non-empty description.

### 2026-08-26 — Ordered transcript reads preserve participant message semantics

**What changed:** Participant transcript text blocks now bulk hydrate the
canonical mentions, attachment descriptors, message type, and render-safe
structured content stored beside their source part. Turns also expose their
client-message identity and validated external actor. The desktop resolves human
authors and person mentions through the workspace roster, using the routed
message's already-authorized identity while that row is present, preserves
attachment tiles, and reconstructs system, elicitation, suggestion, and
external-message rendering. Message-port appends and scheduling's elicitation
messages join their part write to the ordered projection in the same
object-local transaction and publish the committed turn to subscribed readers.
Those object-port message fields reuse the product's existing 100,000-character
message ceiling. If any other committed runtime event still cannot fit the
bounded realtime frame, publication advances the durable cursor, marks that
sequence unavailable for replay, and sends subscribed readers an immediate
`resync_required` frame instead of falsely reporting that the mutation failed.

**Why:** The ordered-transcript cutover projected the human author's ID but
dropped it while flattening a turn for the renderer, and did not project mention
or attachment rows at all. Every human message consequently rendered as an unrelated
“Workspace member,” used its message ID as a new accent identity, failed the
signed-in-user comparison, and reduced canonical person links to plain text.
Uploaded images were still in R2 and linked to the part, but their tiles vanished
as soon as the ordered snapshot replaced the optimistic message. Slack actor
identity and client reconciliation keys were also lost, while system and
elicitation writers that still append through typed object ports did not enter
the ordered projection. Mention attention and notification effects were still
committed correctly; these were read/projection losses of already durable facts.

**Considered and rejected:** Copying display names or avatars into the durable
transcript projection. Those are mutable workspace identity attributes, while
the transcript already stores the stable author and mention user IDs and the
desktop already owns a roster query; the authorized message page bridges
presentation while that roster loads or no longer contains a historical member.
Also rejected was reconstructing attachment
tiles from the work-stream resource rail: that relationship does not say which
message displayed the file or its position. The object returns the durable IDs,
offsets, frozen per-message descriptors, and validated structured fields; the
reader resolves only current person presentation data.

**Consequences, and what a future change has to respect:** Any participant
transcript replacement for `Message` must preserve its complete participant-
visible semantics, not only visible text. Author IDs determine own-versus-
coworker layout and stable person color; mention IDs determine chips independently
of notification delivery; attachment links determine message-local tiles; type
and structured content determine specialized rows. Assistant output remains on
the canonical Bind projection; run settlement may assign attention or create a
missing stopped-stream turn, but must not append a second final-message row. A
transcript contract change must compare its hydrated shape
with the existing message-page mapper and cover both real object snapshots and
the desktop flattening boundary. Rows written during a deployment that omitted
the ordered projection remain readable through the identity-matched message
overlay; that compatibility path is not a durable backfill and must remain until
a historical repair has completed.
Realtime publication must likewise never turn a committed mutation into a
reported failure: an event that cannot be replayed as one bounded frame must
force canonical snapshot repair for current readers and advance the replay
floor for reconnecting readers.

### 2026-08-26 — Foreground presence is explicit on the workspace socket

**What changed:** Electron main now publishes application foreground changes
through the preload bridge. Each renderer combines that signal with its own
window focus and active work-stream route, then sends `set_presence` after its
WorkspaceDO subscription is admitted. WorkspaceDO stores the explicit state in
the socket's hibernation attachment, orders commands by a socket-local revision,
validates foreground work-stream visibility against its local directory on both
focus and directory changes, and broadcasts a viewer-scoped user set. The
work-stream face pile gives other present participants a subtle repeating ring;
hovering that avatar explains that the named participant is viewing this work
stream. The current user is omitted and reduced-motion users receive a static ring.

**Why:** The metadata/feed socket pool deliberately retains recently viewed
work streams, so socket liveness describes warm transport rather than current
attention. Presence must also disappear when Rally or the renderer window is in
the background, and it needs a direct broadcast path compatible with the
500 ms P50 and 1.5 s P90 product targets.

**Considered and rejected:** Inferring presence from any open work-stream socket
would mark pooled background work streams as active. Route state alone would
leave a hidden or unfocused Rally window present. A class-memory map would be
lost when WorkspaceDO hibernates. A SQL presence table plus TTL/alarm would add
writes and guessed expiry behavior even though Cloudflare already preserves
healthy socket attachments and reports close/error.

**Consequences, and what a future change has to respect:** Presence remains
ephemeral and must never become product authority. Every reconnect reasserts it
only after the workspace subscription response, every reported work stream is
authorized locally, directory visibility changes clear stale attachments, and
each recipient receives only the set its visible face pile needs. Client
snapshots are invalidated on route or transport loss. Presence must never gain a
REST read/write or recovery path. The
direct same-object broadcast is designed for the latency target,
but production percentiles still require measurement; a future telemetry change
must not include workspace membership or presence sets in analytics payloads.

### 2026-08-26 — Canonical facts gain participant and exact Bind orderings

**What changed:** `SubstreamAgent` now stores canonical transcript facts with a
participant-visible turn projection and a restricted exact Bind-loop projection.
It serves snapshot-fenced half-open ranges, dual unread/latest opening islands,
nested activity intervals, provider-boundary hashes, and atomic compaction
replacement/status records through one typed local authority.

**Why:** Flat `parts` and aggregate final assistant messages could not preserve
the order in which Bind produced text, tool calls, later text, and parallel tool
lifecycle updates. They also could not prove a downloaded range was empty
rather than missing, or reconstruct Bind's private post-healing/post-compaction
message array exactly after recovery.

**Considered and rejected:** Copying participant text into a second transcript,
deriving historical interleaving from aggregate rows, and authorizing every
returned block. Human text remains owned by its participant part and referenced
by the transcript fact; model and participant projections share facts where the
payload is identical; admission is constant per external read.

**Consequences:** Main-feed readers must use transcript ranges and stable turn
and block identities. Automation-wizard rendering is unchanged. Schema changes
must preserve the single-owner fact invariant, both monotonic sequence domains,
provider-boundary equality, same-fence dual boot ranges, and the indexes that
make those reads bounded. A socket attachment, not durable history, owns each
reader's range fence; activity payload growth must remain proportional to loaded
turns and active ancestry rather than work-stream lifetime.

### 2026-08-26 — Group actions use one generic filter and queued per-stream updates

**What changed:** The work-stream API now accepts a reusable visibility, pin,
and half-open activity-time filter for both preview and application, plus a
discriminated update. WorkspaceDO resolves that filter in one index query and
freezes the selected IDs under the generic operation ID. The regional Worker
publishes one event per selected work stream through the existing regional
Queue, records each successfully published `sendBatch` chunk, and resumes only
undispatched IDs when the same operation is retried. Each consumer delivery asks that work stream's
main SubstreamAgent to apply the update in its authoritative SQLite transaction.
Per-object receipts make delivery idempotent; archive also stops an active run,
and both updates reuse the existing regional-effect outbox for sidebar and
socket convergence.

**Why:** Recency headers need mass actions over rows the client may not have
loaded, but neither a browser loop nor an API loop may read and mutate one work
stream at a time. The workspace directory already owns the complete,
member-visible cross-work-stream index, while each child still owns its product
state. One directory query followed by queued independent events preserves
both authorities and lets Queue provide buffering and delivery isolation.

**Considered and rejected:** Dedicated `this-week` or `mark-group-read`
endpoints would encode one sidebar layout into the backend. A synchronous
Worker loop issuing one child RPC per target would hold the request open and
turn partial fan-out into an HTTP retry problem. A direct workspace-wide SQL
mutation is impossible because the rows belong to separate Durable Objects.

**Consequences, and what a future change has to respect:** New groupings build
the generic filter; they do not add routes. New supported mutations extend the
shared update union and the one child transaction. Preview remains advisory;
the first apply freezes the exact current target set and later transport
retries reuse it. A Queue send may commit before its WorkspaceDO progress RPC,
so the child receipt remains the final duplicate-delivery fence. Queue delivery
may outlive the requesting session, so it rechecks active membership and never
trusts delivery uniqueness or order. Dispatch receipts intentionally persist:
deleting a completed operation would let a late HTTP retry select new targets.

### 2026-08-26 — Connector processing closes over Queue and WorkspaceDO

**What changed:** New canonical connector events no longer create a per-event
Cloudflare Workflow. After ingress commits, the regional consumer sends an
ID-only pointer back to the existing `ACTIVITY_QUEUE`; a later delivery claims,
loads, and settles the event through typed WorkspaceDO RPCs. The claim carries a
stable processing owner for correlation; WorkspaceDO issues a fresh 15-minute
lease per acquisition, returns its exact expiry to active duplicates, and fences
settlement by the lease token. Queue delivery count stays transport telemetry,
not a product attempt generation. The physical `workflow_instance_id` column and
Workflow binding remain temporarily compatible with already-created instances.
The object also accepts their frozen `workflowInstanceId` claim/settlement wire
shape and returns their smaller strict claim result. Queue pointers older than
the object's authoritative product attempt are terminally acknowledged because
no redelivery can make that generation current again. The row persists its
processing orchestrator: Queue leases expire, but a drain-only Workflow remains
exclusive until settlement because its processing step can perform multiple
separately timed retries. An active `NULL` discriminator is a row written before
the migration and therefore a Workflow claim, since Queue claims did not yet
exist.

**Why:** WorkspaceDO already owns the canonical event and terminal state, while
Queue already owns durable retry and dead-letter retention. A one-callback
Workflow duplicated both ledgers and introduced an unnecessary external
instance-ID contract.

**Considered and rejected:** Splitting the regional activity Queue was rejected
at Rally's current scale; no capacity evidence requires it, and strict message
kinds plus terminal logs retain flow identity. Replacing the internal owner
with Cloudflare's Queue message ID was rejected because stability across
redelivery is not a contract this design needs to assume.

**Consequences, and what a future change has to respect:** Connector processing
must remain an ID-only Queue wake followed by typed object RPC, with individual
ack/retry and authoritative, lease-fenced settlement. Do not infer success from
Queue drain, treat Queue delivery count as a product generation, or reintroduce
raw SQL from the consumer. Remove the drain-only Workflow and rename its physical
owner column only after pre-cutover instances are proven gone. Until then, keep
both the legacy Workflow wire adapter and same-instance claim replay: a running
Workflow remains on versioned code and may repeat an RPC whose object mutation
committed before its step result did. Do not replace the persisted orchestrator
with an ID-format inference or a longer guessed Workflow timeout.

### 2026-08-26 — Notification lifecycle becomes a closed WorkspaceDO protocol

**What changed:** Notification delivery no longer routes
`workstream_notification_intents` statements through the D1-shaped workspace
database adapter. WorkspaceDO now returns typed `claimed`, `terminal`, `busy`,
and `missing` outcomes; applies lease-fenced defer, failure, and settlement
transitions; derives the retention alarm target; and returns exact reaped intent
IDs. The generic SQL executor refuses the table, including through the
object-local scheduler adapter.

**Why:** The returned-lease repair stopped one `meta.changes === 1` defect, but
the lifecycle still exposed storage mechanics to every caller and every future
branch. A D1-compatible result cannot make workerd's physical `rowsWritten`
into a domain fact. The object owns the state machine and can return the fact
directly.

**Considered and rejected:** Leaving the generic path open and standardizing on
`UPDATE ... RETURNING`. That statement pattern is correct locally, but it is a
review convention rather than an enforceable boundary; another transition can
still read `meta.changes`, and the alarm would remain a second raw-SQL caller.

**Consequences, and what a future change has to respect:** Notification SQL is
private storage implementation. New delivery states, retry rules, or retention
behavior must extend `workspace-notification-intent-protocol.ts` and the
WorkspaceDO methods rather than issuing SQL through `env.DB`. The Worker owns
regional identity and provider calls; WorkspaceDO owns clocks, leases, and
durable transitions. Real-workerd coverage asserts both that an indexed claim
reaches its terminal decision and that the generic port returns a typed-only
refusal.

### 2026-08-25 — One SubstreamAgent snapshot opens the reader

**What changed:** Selecting a work stream now subscribes its SubstreamAgent
immediately, and the first canonical snapshot supplies both the detail and the
transcript window the renderer needs. `GET /workstreams/:id` invokes the same
room boot only for explicit recovery. It no longer calls WorkstreamDO for the
viewer HyperSight preference; the independent control socket owns that value.

**Why:** The old open called `boot()` over REST, awaited an optional second
object, then admitted a feed whose subscription assembled another room
snapshot. The serial duplication was visible in production timings and spent
the latency budget before the message surface was live.

**Considered and rejected:** Racing the two room boots moves the serialization
inside the object and doubles snapshot work. Reaching from SubstreamAgent into
WorkstreamDO would violate the authority boundary for optional UI metadata.

**Consequences:** The normal open performs one canonical SubstreamAgent read.
The recovery route remains a full twin so a failed first socket attempt exposes
a safe manual path as soon as it enters reconnecting, without an arbitrary
timeout. WorkstreamDO control metadata may arrive before or after the feed
without affecting message readiness.

### 2026-08-25 — Opening messages carry real person mentions

**What changed:** The new-work-stream composer now retains the same selected
mention identities as the in-work-stream composer and sends them through the
same visible-text-to-span resolver. `POST /workstreams` accepts those spans,
and `SubstreamAgent.initialize` resolves their people against active workspace
membership, replaces accepted visible ranges with canonical
`[@Name](person://<user-id>)` Markdown (bare `person:<user-id>` still accepted),
writes `part_mentions` and mention
attention in the opening-message transaction, and emits the normal durable
mention activity and notification. A mentioned person is seated even if a
direct API caller omitted them from `participantUserIds`. In an existing
personal work stream, both Enter and the send button stop before a
nonparticipant mention and ask whether to add the person, explicitly warning
that without access they cannot see either the mention or the work stream;
workspace-visible work streams do not raise that false warning.
The optimistic opening turn carries those same bound spans, and a failed create
restores text and spans only as one submitted draft generation so a newer draft
cannot inherit stale mention identities. Workspace-visible sends accept a
nonparticipant mention without confirmation or seating because active workspace
membership already grants read access; the authority-side confirmation backstop
applies only to personal work streams.

**Why:** Selecting a name in the launch composer previously inserted only plain
`@Name` text and separately added a participant ID. The opening message carried
no identity or offsets, so its persisted text could not render a mention chip,
create mention attention, or reach the Slack mention delivery path. The control
looked like the existing mention autocomplete while producing a different
domain fact.

**Considered and rejected:** Building canonical Markdown in the renderer. That
would make correctness depend on a client template and a possibly stale display
name. The client identifies the intended visible span; the object verifies the
active member and owns the durable spelling, mention row, attention state, and
outbox effects. A separate launch-only span finder was also rejected in favor
of the resolver already used for ordinary workspace messages.

**Consequences, and what a future change has to respect:** Mention identities
must survive draft editing and cross the create API as occurrence-bound spans;
participant IDs alone are not mention metadata, and a display name cannot
disambiguate two people who share it. Hand-typed ambiguous names remain plain
text. Only person spans accepted by authoritative visible-range validation may
derive audience or consume a participant confirmation; raw mention IDs are
candidates, never access grants. A person selected as both participant and
mention receives the specific mention notification, not an additional
participant-added notification. The personal-work-stream confirmation must be
shared by every submit gesture and must run before optimistic insertion; the
object's `participant_confirmation_required` check remains the authority-side
backstop. Empty mention arrays are omitted from creation
receipt hashes for rolling-deploy compatibility, while non-empty spans remain
part of the idempotency identity. The real-workerd test asserts canonical text,
`part_mentions`, attention, directory projection, and the durable notification
branch together. Renderer error recovery must treat draft text and its bound
spans as one snapshot; independently restoring either half can attach an old
identity to new words. Autocomplete and the mention toolbar follow textarea
selection semantics: a non-collapsed selected range is replaced, not retained
after the inserted mention.

### 2026-08-25 — Notification claims prove the lease they wrote

**What changed:** The WorkspaceDO notification claim now returns and verifies
its `intent_id` and newly generated `lease_id`. It no longer decides whether the
claim won from the D1-shaped adapter's `meta.changes`. Exact notification reaper
progress likewise comes from returned intent identities. The same audit moved
WorkspaceDO-routed connector cursor and GitHub policy compare-and-swaps,
automation compensations, draft-resource reaping, and opportunity-window
reaping to returned identities. Slack account-link redemption now routes to its
WorkspaceDO authority and verifies the returned challenge and linked identity
instead of two exact counters. [`durable-object-sqlite.md`](durable-object-sqlite.md)
owns the cross-cutting rule.

**Why:** A production mention claim updated one logical intent row and the
indexes over its delivery and terminal fields. `WorkspaceDO.executeRuntimeSql`
correctly exposed workerd's physical `rowsWritten`, which was greater than one;
the notification service incorrectly required exactly one. It therefore wrote
its lease, diagnosed that successful write as an active competitor, returned
`busy`, and never reached Slack. Queue drain was real but described only the
earlier handoff, not this later terminal outcome.

**Considered and rejected:** Changing the predicate to `changes > 0`. That
would survive index inflation but would still couple a domain ownership decision
to a storage counter. Also rejected: normalizing the adapter globally to
`changes()`. Existing callers and diagnostics already receive `rowsWritten`, and
making the adapter look more like D1 would preserve the architectural mistake:
the provable answer is the returned lease, not a more convenient count.

**Consequences, and what a future change has to respect:** A claim, lease,
compare-and-swap, or exact reaper count on Durable Object SQLite must use
`RETURNING` or a typed object-owned outcome. A Node SQLite double is insufficient
coverage for this rule because its logical affected-row count hides index
writes; the notification regression therefore runs on real workerd and changes
indexed columns. The test was proved by restoring the old exact-count branch and
observing `busy` where the terminal result was `skipped`.
### 2026-08-25 — Being named at creation tells the person, when the caller says to

**What changed:** `initialize` emits, per invited participant, the same activity
event and `participant_notification` that `addParticipant` does, behind that
person's own viewer effect — but only when the caller passes the new
`notifyParticipants`, which `POST /workstreams` sets and nothing else does. Both
paths now build those two effects in one place, `participantAddedEffects`, and
both mint the same identities (`participant:<work stream>:<user>:<epoch>` and
`participant_added:<…>`), with a literal zero epoch at creation because the rows
are inserted by the same call. The notification carries `titleIsProvisional`, and
the Slack and email templates use it to avoid quoting a title the naming agent has
not written yet. The two person-notification emails and both regions' Resend
sender display names now say Rally.

**Why:** the 2026-08-22 entry below, *Being added to a work stream tells the
person*, closed with "Also rejected: notifying people named in
`participantUserIds` at creation, which is a different path with a different
audience question, left for its own change." Half of that was wrong and half was
right, and the split is the whole of this entry.

Wrong: it is not a different path in any way that matters. The new-work-stream
screen has an "Add people" step, so being picked there is how most people are put
in a work stream, and every one of them reached `participants` with only their
sidebar row enqueued — no Slack DM, no email, and no `activity_events` row for the
digest to fall back on. The hole was permanent rather than late, because the
repair anybody reaches for does not work: adding somebody already active is a
deliberate no-op that emits only the viewer effect, so a second, manual add tells
them nothing either. That is the same "a colleague added to a work stream, told by
nobody, who then could not find it" report the entry below was written to close,
arriving through the door it left open.

Right, and this is the part the first attempt at this change got wrong: there
*is* a second audience question, and `participantUserIds` is where it lives.
`CreateWorkstreamRequestSchema` says so where its `.max(25)` used to be — "a
connector conversation is the other kind of caller and is routinely larger — a
Slack channel's resolved audience can be hundreds" — and `slack-agent-service.ts`
is that caller: when a linked member mentions the bot in a channel, the resolved
roster goes straight into this field. Notifying it would have DMed up to fifty
people, on somebody else's behalf, that they were "added" to a work stream nobody
added them to, in a thread they were already reading — and only when the person
who typed had linked their Slack account, because the unlinked branch provisions
instead. So the decision moved to the caller, exactly as `scope` did and for the
same reason: an audience is something an ingress *knows*, never something the
state-holder infers.

**Considered and rejected:** gating on `slackOrigin` being absent. It infers the
answer from a value that means something else, so the next ingress to reach
`initialize` inherits a decision instead of being made to state one.

Also rejected: re-emitting the notification from the replay branch, which repairs
an effect-construction failure through `enqueueDirectorySnapshot`. A directory
effect is safe to re-enqueue because it *writes* the projection key it is
versioned on, so an unchanged snapshot is skipped and a changed one advances. A
notification only *reads* that key, so re-emitting one after the root has moved
recomputes a different `requiredProjectionVersion`, and the parent refuses the
same message id under a new payload hash — `child_effect_receipts` is keyed
`(substream_id, message_id)` and its retention is 180 days, so the naive repair
would wedge that work stream's creation for six months rather than lose one
notification. Closing the window properly means giving `initialize` one
transaction, which it cannot have while `commitWithRegionalEffects` asserts the
authority this call is what establishes.

**Consequences, and what a future change has to respect:**

- **The two paths mint one identity per participation and must keep doing so.**
  The epoch is zero at creation precisely so a later hand-add of the same person
  converges on the intent already enqueued rather than minting a second.
- **A notification effect must appear after its own recipient's viewer effect in
  the returned array — not immediately after it.** The dependency is resolved in
  the same `commitWithRegionalEffects` loop pass that wrote the key, so any
  earlier position in the same array works; `createMessage` groups all viewer
  effects ahead of all notifications and is correct. Adjacency is not the rule,
  and a change that treats it as one will reject a legitimate grouping.
- **A caller that seats somebody decides whether to tell them.** `provision` and
  `admitConnectorAudience` are the two paths that seat people and do not, today,
  and both are live rather than hypothetical: the four system producers each seat
  a single owner the work stream is *for*, where "X added you" would be wrong, and
  the connector audience is people already reading the conversation. Neither
  question is settled here; what is settled is that the object will not answer it
  for them.
- **The crash window between `initialize`'s root commit and its effect commit
  still loses the notification, and losing it is unrepairable by hand** for the
  same no-op reason the original bug was. That is a smaller and quieter failure
  than a create that cannot be retried, and it is the trade this entry accepts.
- **A notification must not name a work stream by a title the naming agent has
  not written.** Creation sets the title to the opening message's first line cut
  at 180 characters and the objective to the same line cut at 4,000, and naming
  runs after these effects commit. Every other surface re-renders when the real
  name lands; an inbox does not, so `titleIsProvisional` exists and the templates
  branch on it rather than quoting a fragment and then printing it twice.

### 2026-08-25 — Durable notification handoffs expose every terminal branch

**What changed:** The child and parent outboxes, regional effect consumer,
WorkspaceDO notification intent, Slack/email transports, and parent
acknowledgement now emit correlated structured outcomes. Inactive,
non-listable, self-originated, replayed, busy, projection-pending, delivered,
and failed branches are individually queryable.

**Why:** Queue drain was being mistaken for end-user delivery even though the
durable path has several later authorities and intentional terminal skips. The
outbox guarantees retry until acknowledgement; it does not guarantee that the
notification authority will choose a transport or that a provider will accept
the intended destination.

**Considered and rejected:** One success log at the Queue consumer and
exception-only logging were rejected. Neither identifies the durable authority
that committed a terminal state, and both erase expected decisions such as
self-notification and inactive-recipient suppression.

**What a future change has to respect:** Every retained effect must be traceable
from child outbox through actual parent-row removal. Every notification branch
must end in a terminal, deferred, or failure event with content-free IDs and a
stable reason; Queue acknowledgement alone must never be presented as provider
delivery.


### 2026-08-25 — Automation opens stay on their authorized workspace state

**What changed:** Automation detail uses its first authorized subscription row
for the stored email address and calls an internal bounded run-history reader.
The standalone run-history route retains the subscription authorization. The
manual, scheduled, and activity-triggered provisioners now copy subscription
scope to each generated WorkstreamDO. One batched WorkspaceDO directory read
filters the bounded history IDs so pre-change personal run objects remain
visible only to their projected participants.

**Why:** Re-reading the same subscription did not change the permission result,
and re-verifying an owner-verified email route made a regional detail read wait
on Global. A generated object's scope must also agree with the automation's
declared user/workspace audience so its native detail, directory, socket, and
resource checks all enforce the same rule.

**Considered and rejected:** Caching Global verification and adding an
automation-specific reader exception inside WorkstreamDO. The former keeps an
unnecessary cross-region dependency; the latter makes stored scope cease to be
the reader authority.

**What a future change has to respect:** Public entry points authorize once,
then use internal helpers for subordinate reads. Route repair remains a
lifecycle operation, and every automation run producer supplies the subscription
scope during object provisioning.

### 2026-08-25 — Automation history stops waking every run object

**What changed:** An authorized automation detail or run-history read now returns
its bounded `automation_runs` rows after one batched WorkspaceDO
directory/viewer query. It no longer calls
`SubstreamAgent.readerAudience` once per run before returning them, while legacy
personal runs retain their narrower projected audience.

**Why:** Reading an automation is the authorization boundary for the work streams
created by that automation. Rechecking every generated work stream did not add a
distinct permission decision, but it did wake one child object per history row.
For an automation with 18 runs, production traces showed 18 child RPCs and
double-digit request latency while cold children initialized their schemas and
alarms.

**Considered and rejected:** Parallelizing the child reads. That keeps the
redundant authorization check, turns one history request into a burst of Durable
Object calls, and retains latency whenever the outbound-connection allowance
bounds the burst.

**What a future change has to respect:** Loading the automation subscription
remains mandatory before returning its runs. Until every historical generated
object has the automation's scope, the single batched directory/viewer read is
also mandatory. Direct content moves and reads that do not derive their
authority from an already-authorized automation still use the current reader
audience owned by the work stream.

### 2026-08-25 — Hibernation replay misses stay on the child socket

**What changed:** When a resume cursor is behind the durable room sequence but
the memory-only replay events are unavailable or incomplete, SubstreamAgent now
serves its canonical snapshot and admits the same socket. `sequence_ahead` and
a snapshot/catch-up failure return `resync_required` without advancing the
attachment cursor. The streaming/reconnect contract now records exactly which
hibernation state survives, the replay-plan outcomes, and the workarounds that
would recreate or merely hide the failure.

**Why:** A hibernated object preserves WebSocket attachments and SQLite but not
class memory. The old response turned that expected state into a reconnect loop:
the close and next subscribe could each publish presence, move the durable
sequence, and leave the next activated instance without the new replay events.

**Considered and rejected:** A durable replay log adds storage writes for every
ephemeral frame. Suppressing presence avoids one producer but leaves the same
failure for every other replayable event. The snapshot path already reads the
child's canonical authorities and already performs a post-assembly catch-up.

**Consequences:** Ordinary replay loss costs snapshot assembly but no
disconnect. Repair snapshots omit the reader's old unread window. Snapshot
failure or catch-up overflow retains the old cursor and falls back through
`history_unavailable`; traces record the attempted snapshot reason, and the
sequence-ahead compatibility path remains a separate HTTP resync.

### 2026-08-25 — Identity decides locality, and an object declares what it owns

**What changed:** Four things, one argument.

*Recognition is on the id.* `durableObjectSelfForId` replaces `durableObjectSelf`:
a resolver derives the id a name resolves to — `idFromName` is a hash and no
I/O — and compares it with the caller's own `state.id`. The name thunk stays for
the stand-in stub's `name` and for diagnostics, and decides no routing.

*A self-address the routing cannot see is fatal outside production.* The refusal
lives in `durableObjectStubForRegion`, the one function every stub in this
repository comes from, and throws in development and test while logging
`durable_object_self_addressed_over_rpc` at error in staging and production.

*An object declares its authorities once.* `runtime/local-authorities.ts` carries
a per-work-stream registry and the ownership rule the endpoints enforce;
`createObjectPort` consults it for whichever authority its contract names, so all
eight ports gained the seam at once, and the Terminal port reads the same
registry. What an object installs is each authority's *endpoint body* —
`schedulingOperationOutcome` and its six siblings, extracted from their `Request`
handlers — never the storage instance under it, so a local call answers the same
`{ ok, value }` or `{ ok: false, error }` a dispatched one does and
`createObjectPort` reads both with one interpretation.
`SubstreamAgent.localRuntimeEnvironment` installs all of them in one call, and
`terminalPortFactory` is gone from the harness options, from `loadHarnessTools`,
and from `createAvalonTerminalPlugin`, along with the
`terminal_resident_runtime_incomplete` pairing it required.

*A platform refusal is its own failure code.* `platform_limit_exceeded`, kind
`platform`, decided in `FatalHarnessPortError` from the platform's own wording.

**Why:** on 2026-08-24 a work stream died mid-run with
`tool_receipt_persistence_failed` and, under it,
`D1_ERROR: Subrequest depth limit exceeded`. Its trace holds one alarm invocation
making fifteen `executeToolReceiptOperation` RPCs to its own object id; from the
fifteenth on, Cloudflare refused every further subrequest that invocation made.
The next run in the same work stream, on the same deployed version, made none and
completed. The full evidence is in
[`durable-object-self-rpc-audit-2026-08-22.md`](durable-object-self-rpc-audit-2026-08-22.md).

Recognition rested on a name, and a name is withheld until an object's durable
facts are recorded — so there was a window where an object could not tell that a
call was to itself, and every call in it went out through the namespace and came
back. That window was not a routing detail; it was the incident. An id has no
window: the object has had `state.id` since its constructor, jurisdiction already
asserted, and the id a name resolves to is computable without reading anything.
The rule that a name is withheld until identity is durably the object's own still
holds for names, and stops being load-bearing for routing.

Making the leftover backstop fatal follows from the same move: once routing
cannot produce a self-address, anything that still reaches one is a caller that
skipped the resolver, which is a defect and not a slow path. It throws where a
human is watching and logs where refusing would turn a latent defect into an
outage.

The authorities boundary is the other half. Locality was being rediscovered per
call by every helper that needed an authority, through mechanisms invented weeks
apart — two SQL executors, a Terminal executor threaded through three signatures
— and the authority that had none is the one that failed. Now the object says
what it owns, once, and no port below asks.

The failure code is what made the incident expensive to read: Cloudflare enforces
its subrequest limits by refusing whichever call asks next, so the refusal landed
on the receipt port and the run blamed a receipt that was never attempted. Same
reasoning as `provider_unavailable` — the code exists so a failure names the
system that produced it.

**How it is proved:** `durable-object-self-reference.test.ts` asserts an object
reaches itself *while it cannot say what it is called* — the incident's state,
inverted into the guarantee — and that the backstop throws in test, logs in
production, and stays silent for a sibling and for the same name under another
binding. `test-workers/durable-object-self-registration.test.ts` proves the same
on real workerd for all four classes, before their durable facts are written.
`workstream-tool-receipt-locality.test.ts` gives a port a `SUBSTREAM_AGENTS`
binding that throws on use, so a port that dispatches fails at the line that
dispatches, and checks each clause of the ownership rule.
`test-workers/tool-receipt-authority.test.ts` and
`test-workers/terminal-authority.test.ts` do the same inside the real object: the
main child answers with the namespace unusable, a non-main child cannot.
`test-workers/scheduling-authority.test.ts` builds a scheduling port over the
environment the real object hands a run and asserts the local call commits the
sidebar projection, re-derives the alarm index, and refuses against a quarantined
object with the same `ObjectPortError` code the wire raises — the three things
carrying the storage would drop, none of which is visible in what the caller gets
back. `packages/agent-harness/src/index.test.ts` fails a run through a receipt
port carrying the platform's wording and expects `platform_limit_exceeded`.

**Considered and rejected:** *Writing both identity facts earlier* so the name is
never withheld — fixes this window and leaves routing keyed on a lookup that can
fail. *Keeping the fatal check in the name-based resolvers* — after id
recognition they cannot produce a self-address, so a check there is unreachable
code that cannot be tested. `durableObjectStubById` had one for the same reason
and it is gone: its `durableObjectSelfForId` call and the refusal walk the same
registrations under the same two conditions, so the refusal could never fire,
and unreachable code shaped like a guard is worse than no guard because the next
reader counts it as one. The refusal stays in `durableObjectStubForRegion`,
which answers nothing locally first and is the one function every stub in the
repository comes from. *Installing each authority's storage* rather than its endpoint — the first shape
this took, and wrong: an endpoint is not a thin wrapper around its table. It
refuses a request against an object whose `authority_mode` is no longer
`authoritative`, runs a mutating operation inside `commitRuntimeMutation` so the
row and the directory projection that renders it are one commit, and — for
scheduling — re-derives the timer index and arms the next alarm before answering.
Carrying the tables would have dropped all three for exactly the callers running
closest to the data: stale sidebar previews, wake-ups that never fire, and writes
accepted against a quarantined object. *Threading every authority as a parameter* rather
than carrying it — the right shape, and it is what `runtimeResourceAttacher` still
does deliberately, because that one carries a *scope* invariant (it refuses an
attachment addressed to another work stream) rather than a location. Doing it for
the rest would rewrite hundreds of signatures for a property the boundary already
provides.

**What a future change has to respect:** an authority that moves into an object
gets a name in `LocalWorkstreamAuthorities` and an `authority` on its port
contract — not a fifth mechanism, and not name recognition, which is now a
backstop rather than the mechanism. What it installs there is its endpoint, and
anything an endpoint does above its storage is part of the operation rather than
a wrapper the local path may skip; a guard added to one belongs in the body both
paths run, not in the `Request` handler. The ownership rule and the endpoints' guards
are one rule. And a new failure code answers "which system produced this",
because that is the only question the code is read to answer.

### 2026-08-25 — Two atomicities a per-item conversion dropped

**What changed:** `createRun` claims its `automation_runs` row before it
provisions the work stream, and `admitConnectorAudience` seats its whole
audience through one `admitParticipants` operation instead of `Promise.all` of
per-member admissions. `admitParticipant`, the plural form and `adoptCreator`
share one private `seat`.

**Why:** both are the same mistake in two places. A routed batch is atomic
across everything it names, and converting it statement by statement into
separate awaits gives that up silently — the code reads fine and every test
passes, because nothing fails partway through in a test.

`createRun` provisioned first. Two requests carrying one idempotency key both
pass the lookup that precedes them; the loser's insert hits the unique index,
and `controlRunInserted` is still false at that point, so the compensation block
below does nothing. What is left is a work stream in a sidebar, with a
`listing_epoch` bump and a reserved email address, for a run that does not
exist and never will. Claiming the control row first makes its unique keys the
thing that decides who provisions, before anything visible has been written.
`main` had this order, and the activity consumer in this same stack kept it;
only this path lost it.

The audience is worse than a lost write, because what it loses is an
*announcement*. Admitting five members as five operations and throwing on the
fourth leaves three seated. The retry recomputes who is new against a roster
that now contains those three, so they fall out of the newly-admitted set and
their `participant_joined` is never published — and nothing anywhere records
that it wasn't. One transaction restores what the batch had.

**What a future change has to respect:** `admitParticipants` returns the rows it
wrote rather than letting the caller read them back. The read was not merely a
round trip — between the writes and it, a removal can land, and the audience
would then publish a joining for somebody no longer on the work stream, or drop
one who is. A caller that needs to know what a write did should be told by the
write.

The storage class keeps its own `transactionSync` even though every write
dispatched through `/internal/identity` is already inside
`commitWithRegionalEffects`'s transaction. That redundancy is deliberate: the
class is a unit whose atomicity should not depend on which caller reached it.
It does mean a test driving the endpoint cannot distinguish the two, so the
workerd spec proves the property the caller depends on — the operation seats all
or none — rather than which layer provides it.

### 2026-08-25 — The last two compatibility views, and what a migration is

**What changed:** migration 26 drops `_runtime_workstreams`,
`_runtime_workstream_participants` and their four write triggers. Nothing is
left in `LOCAL_TABLES` or `TABLE_REWRITES` for either, `packages/db`'s
work-stream repository is gone, and the `/dev` seed seats people through the
identity authority. `compatObjectDrops` is the shape every promotion in
`workstream-object-schema.ts` had written out by hand.

**Why:** the slice before this one left both views declared because their
remaining callers were fixtures, and said so. That was the wrong stopping
point: a view nothing reads is a view a new caller can still reach, and the
routing entry beside it is an invitation. Retiring them turned out to be the
only way to find the two production writers that were left — `packages/db`'s
`workstreams.create`, which the Slack path calls and which I had read as dead,
and the `/dev` seed's participant insert. Neither showed up in a search for
routed SQL, because both went through a repository.

**The mistake worth recording.** The first attempt deleted the retired
statements from `WORKSTREAM_RUNTIME_COMPAT_SCHEMA`. That array is not a
description of today's schema — it is what migration 1 applies, so an object
replaying from empty creates each view before a later migration drops it.
Deleting from it rewrites history, and the damage lands on the *next* migration
that names the view: migration 12 rebuilds the work-stream view and its
triggers, and the participant first-opened migration derives from the rounded
trigger rebuilds. Both broke, 608 suites deep, reporting `no such table:
main._runtime_workstreams` from the schema apply rather than from anything a
test wrote. **A retired compat statement stays in that array forever; the
promotion drops it.** That is what every earlier promotion already did, and
what the assertion inside each one is for.

**What a future change has to respect:** `admitParticipant` bumps
`participant_epoch` and clears `first_opened_at` when a removed person comes
back. That was the retired triggers' behaviour and the conversion nearly lost
it — being put back into a room you were taken out of is being added to it, so
the person is notified again and the work stream is unseen for them again, and
the three facts only agree if one write makes them.

Test fixtures state product identity through `seedWorkstreamObjectRoot`'s own
fields rather than a second statement against a view, and read it back through
`workstreamObjectRootRow` / `workstreamObjectParticipantRows`. Assertions cross
the two vocabularies where they actually differ: `next_attention_ordinal` is
one ahead of the view's `latest_attention_sequence_number`, `exact_state` is
finer than the `harness_status` bucket, and timestamps are unix milliseconds.

### 2026-08-25 — The identity and elicitation slices, and migration 25

**What changed:** `WorkstreamIdentityStorage` gains the three layers the five
authorities before it have — a protocol derived from the storage class, a
Worker-side port, and one `/internal/identity` endpoint — and every routed read
and write of `workstreams` and `workstream_participants` moves onto it.
`WorkstreamSchedulingStorage` gains `openElicitation` and
`answerElicitationExternally`, the last two writers of `_runtime_elicitations`.
Migration 25 drops that view and its two triggers, and `elicitations` leaves
`LOCAL_TABLES` and `TABLE_REWRITES`.

**Why:** every one of these was a statement working around not being able to
read before it wrote.

- The compare-and-swaps — the naming pass on `title_status`, the description
  loop on `objective`, the email adoption on `email_address IS NULL` — fenced
  in a `WHERE` clause and then read `meta.changes` to learn what had happened.
  They decide inside the transaction now and *name* the outcome, and
  `redescribe` hands back what is in force after a refusal rather than leaving
  the caller a second read of a row that can move again.
- The batches that spanned two tables — the Slack creator reconciliation, the
  elicitation create, the elicitation answer, the inbound-email transcript
  write — were sequences whose later statements re-stated the earlier ones'
  effects as `EXISTS` subqueries, because a batch cannot see its own rows. The
  elicitation create was the clearest: an `INSERT … SELECT … FROM workstreams`
  to read the sequence number in the statement that consumed it, then a counter
  update fenced twice more on the part having taken exactly that number.
- The joins proved nothing. Both telemetry emitters joined `workstreams` to
  read one column; the connector audience joined it to re-check a workspace the
  port checks before it dispatches.

`provisionRuntime` goes with them. It was a bespoke RPC that validated its own
body and re-checked identity inside the product service — both of which the
shared dispatcher already does — so a provision could be refused under two
different mismatch codes depending on which layer noticed first.

One behaviour changes on purpose, and one contract narrows.
`assertRunAuthorityStillValid` took `Env | D1Database`, and the regional
`activities` fallback that union made reachable is gone: every caller passes an
`Env`, and the evidence a connector run started from is the WorkspaceDO's, so a
second source for it could only disagree.

**What a future change has to respect:** `_runtime_workstreams` and
`_runtime_workstream_participants` were still declared when this entry was
written, and the deferral was wrong — see the entry above. Migration 26 retires
them, and doing so is what surfaced the two production writers that a search
for routed SQL could not see, because both went through a repository.

### 2026-08-25 — The four system producers provision through the object

**What changed:** `WorkstreamIdentityStorage.provision` is the operation the
four system bootstrap batches become, reached from the Worker as
`provisionWorkstreamObject`. The digest run service, the schedule executor, the
activity consumer and the automation service no longer write `workstreams` or
`workstream_participants` through the compatibility views; the automation
service's opening message goes to the transcript port and its root run to the
harness-run port, and the activity consumer's root run does too.

**Why:** these were the last writers of `_runtime_workstreams` and
`_runtime_workstream_participants` on a creation path, and every one of them
was a batch that had to know things the object owns — that
`next_sequence_number` is 2 when an opening message is coming, that
`latest_attention_sequence_number` is 1, that a fifth `UPDATE` has to follow
the insert to set `automation_run_id`. The transcript authority takes the
sequence number and advances both counters itself, so no producer states them.

Not folded into `WorkstreamObjectCreationService`: that is the member path and
it requires an opening message, a first part and a first run. Three of these
four producers create an empty work stream and two create no run at all, so
sharing one entry would make each of that path's invariants conditional.

Atomicity is what this trades, and it is worth naming. The routed batch was
atomic across tables the object now owns separately — but it was never atomic
with the regional `automation_runs` row beside it, which is why the
compensation path in `createRun` exists at all. Three authoritative writes plus
that same compensation is the guarantee the code already had, expressed where a
failure is visible.

One behaviour changes on purpose: the activity consumer's batch stamped
`harness_status = 'running'` on a work stream whose only run it was inserting
as `scheduled`. The provision writes `scheduled`, and the object moves itself
to running when the run actually starts. The pre-stamp was a Worker's guess
about a run that had not been dispatched yet, and a state the object can derive
is not one a caller should assert.

**What a future change has to respect:** `provision` is idempotent on replay,
keyed on the bootstrap's own `runtime_bootstrap` reason code — a producer that
dies between `bootstrapRuntimeAuthority` and this call retries both, and a
second write would reset counters a first run may have advanced. Its email
columns are `COALESCE`d rather than overwritten, because the digest and
activity batches never named them and `email_route_status` is `NOT NULL`. And
it is a storage class rather than statements inline in a service so the Node
suite's agent double runs the real write; a double that modelled it would be
the second implementation, and the model is what drifts.

### 2026-08-24 — The lifecycle-event migration is 24, and the fifth collision

**What changed:** `runLifecycleAuthorityPromotion` is object schema migration
24, and `WORKSTREAM_OBJECT_SCHEMA_VERSION` is 24. It was written as 22. Also
corrected: the harness-run entry below said its migration was 22 after that
slice renumbered to 23, which is a stale reference that reached `main`.

**Why:** 22 went to the accepted-suggestion audience triggers and 23 to the
harness-run promotion while this branch sat unopened. That is five collisions in
one afternoon, and this one is the clearest case for a gate: the branch adds a
migration, the rebase reported no conflict on the array, and the only symptom
was two entries numbered 22 in a list nothing checks.

It was caught by `grep -oP 'version: \d+' … | sort | uniq -d`, run before the
merge. Twice now that check has been the only thing between a duplicate and
`main` — and the stale doc reference above shows the other half of the cost: a
renumber touches the array, the constant, and every prose mention, and the
prose is the part no gate reads.

**What a future change has to respect:** the check belongs in CI. Comparing a
branch's version list against `main`'s for duplicates is a few lines and would
have caught all five; every one of them was found by hand, and the one time the
list was not checked, a wrong number shipped. That is a decision for the team
rather than something to add inside a conversion slice, but the evidence for it
is now five incidents deep.

### 2026-08-24 — Two reviews on the converted harness runs, and the rule this slice had broken

**What changed:** a code review and a rebase audit, run separately over the same
branch. Between them:

- Eight lease and liveness fences move from `status = 'running'` to
  `BUSY_RUN_STATUSES` / `OPEN_RUN_STATUSES`, and two row-level fences in
  `admitInlineChild` to `BUSY_RUN_STATUS_SET`.
- `recordReceiptReconciliation`'s replay fallback compares `attempt_id` again.
- `cancelDescendants` counts the rows its predicate matches instead of reading
  `cursor.rowsWritten`.
- A cancelled parent answers `cancelled` rather than `ownership_lost`, and a
  live child answers `busy` before `cancelled`.
- `isHarnessStopped` is back to `!= null`.
- Two comments and a changelog number that the rebase had silently dropped.

**Why:** the fences are the one that matters, because the rule was already
written down. An earlier slice in this stack narrowed the receipt and
block-dashboard fences the same way, review caught it, and the entry below
records the conclusion: *a busy run is any of the three, and `running` alone is
the wrong default*. This slice was the first written after that and broke it in
eight places — which is the argument for the named constant rather than eight
correct literals. A rule that lives only in a changelog is a rule the next
conversion breaks.

None of it is reachable today. Nothing writes `waiting` or `steering`, a
terminalized run cannot take a new attempt, `cancelDescendantHarnessRuns` has no
production caller, and `isHarnessStopped` is only reached for a run that exists.
That is exactly why they were worth fixing now: each one is a trap set for
whoever adds the first writer, and the eight would have fired together.

**On the rebase audit, which is the finding worth keeping:** this branch
converts routed SQL by deleting and rewriting whole functions. When `main`
changes those same functions, git reports **no conflict** — the branch's side
wins and the fix vanishes. That happened here: the branch forked before the
residual-receipt work landed and reverted five commits, and every gate stayed
green. `pnpm test`, `pnpm lint`, `pnpm typecheck` and CI cannot see it, because
the reverted code is not the code being tested.

**What a future change has to respect:** a conversion slice that rewrites a
function `main` has touched needs a diff against `main`'s version of that
function, not a clean rebase. The audit's method is the cheap version: list
`main`'s commits since the merge base, intersect their files with the branch's,
and read both sides of every overlap. A comment on `main` saying "do not narrow
this back" marks a fix somebody already paid for, and its absence from the
branch is the tell.

### 2026-08-24 — The harness-run migration renumbers to 23, after two collisions

**What changed:** `harnessRunAuthorityPromotion` is object schema migration 23,
and `WORKSTREAM_OBJECT_SCHEMA_VERSION` is 23. It was written as 21, which the
resource slice took on the way in; 22 then went the same way to the
accepted-suggestion audience triggers while this branch was in review, which is
the fourth time in this stack and the reason the number is 23 rather than 22.

**Why:** the two entries above record the same thing happening to scheduling and
to resources. This one is the silent shape again — the rebase was clean, every
gate passed, and the only symptom was two entries numbered 21 in one array.
Three times in one afternoon is no longer a run of bad luck; it is what a stack
of branches does when the number each one claims is decided when it is written
and nothing rechecks it.

**What a future change has to respect:** the check that catches this is
`grep -oP 'version: \d+' … | sort | uniq -d` against the branch, run
immediately before merging. Nothing in the repository does it, so a duplicate
merges clean and leaves the runner applying whichever entry came first and
skipping the other as already applied. If this keeps happening, the fix is a
CI gate rather than more diligence — but that is a new gate on every pull
request, and the team's call rather than one to add quietly.

### 2026-08-24 — The main child answers current reader-audience questions

**What changed:** `SubstreamAgent.readerAudience` exposes the main child's
authoritative scope and active participant IDs to internal Worker callers.
Direct resource-watch routing, Suggested Work source and target checks, and
automation run history use it immediately before they move or disclose content.
Creator attribution no longer grants private access, and accepted restricted
suggestions block later participant or scope widening. Schema migration 22
enforces that last invariant at the object-storage boundary too, including for
runtime-compatibility writers that bypass the product service. Accepted source
audiences are immutable and cannot be deleted, so the storage fence lasts as
long as the content accepted into the work stream.

**Why:** WorkspaceDO owns cross-work-stream directory serving, but its viewer
rows arrive through durable regional effects after the child commits. That lag
is acceptable for a converging sidebar; it is not acceptable when a stale reader
set permanently injects activity into a transcript or returns a private run ID.

**Considered and rejected:** Synchronous child-to-parent permission updates,
using the directory projection because it is cheaper, and granting creators
permanent access outside participation. Those respectively invert the outbox
boundary, preserve the stale authorization window, or make participant removal
ineffective.

**What a future change has to respect:** Cross-work-stream discovery remains in
WorkspaceDO, but a permanent content move or direct disclosure rechecks the
selected work stream's current authority. Private reader identity comes only
from active participant rows. Direct SQL audience writes remain subject to the
accepted-content triggers; do not replace them with a service-only check.


### 2026-08-24 — The resource migration renumbers to 21, and this time Git said nothing

**What changed:** `resourceAuthorityPromotion` is object schema migration 21,
and `WORKSTREAM_OBJECT_SCHEMA_VERSION` is 21. It was written as 20.

**Why:** the scheduling slice took 20 on the way in. The entry above records the
same thing happening to scheduling itself, where the two claims sat at the same
position in the array and the rebase conflicted — the loud case. This is the
quiet one it warned about: the two entries were appended at *different*
positions, so Git merged them without a word into a list holding two entries
numbered 20, and nothing failed. Not the build, not `pnpm test`, not lint. The
runner would have applied whichever came first and skipped the other as already
applied, and which one that was would have depended on merge order.

It was caught by diffing the branch's version list against `main`'s before
merging, which is now the thing to do rather than the thing to remember.

**What a future change has to respect:** a migration number is not checked by
anything in the repository. Two branches can claim the same one, merge cleanly,
and produce an object whose schema version means different things depending on
which landed first. Until something enforces it, the check is manual and belongs
immediately before the merge, not when the migration is written.

### 2026-08-24 — The scheduling migration renumbers to 20, because 19 was taken

**What changed:** `schedulingAuthorityPromotion` is object schema migration 20,
and `WORKSTREAM_OBJECT_SCHEMA_VERSION` is 20.

**Why:** it was written as 19 and 19 landed on `main` first — the participant
`first_opened_at` migration — while this branch was open. This is the collision
`docs/pull-requests.md` warns about, and it is worth writing down what it looks
like: the two claims are at the same position in the same array, so a *rebase*
conflicts and the renumber is forced. Had they been appended at different
positions, Git would have merged them cleanly into one list with two entries
numbered 19, the runner would have applied whichever came first and skipped the
other as already-applied, and the object would have carried a version number
whose meaning depended on merge order. Nothing would have failed at build time.

**What a future change has to respect:** confirm the number against `main` at
merge time, not only when the migration is written. The gap between the two is
where somebody else's release lands.

### 2026-08-24 — What a review found in the scheduling slice, and one test that was proving nothing

**What changed:** five fixes, from a review of the rebased slice.

- `workstream-scheduling-protocol.ts` folds onto `object-port-protocol.ts`, the
  way the port folded onto `createObjectPort` in the entry below. It had its own
  mapped type, its own `Exhaustive`, its own request envelope, and its own
  `MAX_SCHEDULING_OPERATION_ARGS` — a second copy of a limit that has to change
  in lockstep with the shared one, with nothing enforcing it. 129 lines to 88.
- `isAuthoritative()` now requires `authority_generation > 0` as well as an
  `authoritative` mode.
- `claimDescriptionEvaluation` clears the five decision columns, as the retired
  trigger's conflict arm did.
- `refreshAgentTimerAlarm` no longer takes a substream id.
- The three `test*Port` helpers become one, and it applies the `?? null` the
  real seam applies.

**Why:** the authority one is the substantive fix. The routed fence was written
in two places, and reading only `authority_mode` restored one of them:
`executeWorkstreamRuntimeSql` refused a non-authoritative object outright, and
it then ran *every* batch through `commitRuntimeMutation` — whose
`commitWithRegionalEffects` also refuses generation zero. The wake-up mutations
still reach that function and so kept the generation check by their own route;
the writes that do not — compaction checkpoints, plugin hints, both
description-evaluation writes, and the receipt and block-dashboard writes beside
them — had none. The endpoint docstring and the entry below both claimed the
shared refusal restored what the routed path refused, and until now that was
three-quarters true.

The description-claim columns are the conversion defect this kind of slice
exists to avoid. The retired trigger's `ON CONFLICT(id) DO UPDATE` arm set
`confidence`, `model`, `previous_description`, `description` and `reasoning`
from `excluded.*`, and the routed claim left all five out of its column list —
so `excluded.*` was NULL and a claim wiped the previous evaluation's output. The
converted `UPDATE` simply did not mention them, which reads like the same
deliberate omission that carries `consecutive_keeps` and is the opposite: it
would leave `decision = 'pending'` beside the description and reasoning of an
already-closed evaluation, a row shape production has never produced and one
that reads as current. Nothing selects those columns today, which is why it was
invisible.

`refreshAgentTimerAlarm` took a substream id because the routed insert followed
the caller's substream binding, so the arm had to go where the row went. The
port names the main child for every call, so the parameter had become a way for
the two to disagree — arming an object whose `workstream_wakeups` is empty while
the object holding the row went unarmed. Unreachable today, since every dispatch
passes `"0"`; removed rather than documented, because a parameter that must
always be one value is not a parameter.

**On the test that was proving nothing:** the spec named "leaves the alarm index
alone for an operation that reads" could not fail. Both of its assertions
survive adding `activationHints` to `WAKEUP_MUTATIONS`, and its `toEqual([])`
also passed against a table nobody had seeded. Chasing it turned up something
worth writing down: a misclassified *read* is close to harmless, because
`commitWithRegionalEffects` skips an effect whose payload hash matches the last
one published, so a call that changed nothing publishes nothing. There is no
assertion that catches it because there is nothing to catch. The spec now seeds
a hint, asserts the row it wrote, and says in its own comment that the direction
that does damage is the other one — a mutation missing from the set, which
emptying the set proves.

**What a future change has to respect:** `isAuthoritative()` is the whole fence
those endpoints have, and both halves of it came from somewhere. If a typed
authority ever needs to admit a generation-zero object, that is a decision about
which writes count during import, not a detail to relax here.

### 2026-08-24 — The scheduling port joins the factory, and its writes get the authority fence

**What changed:** `runtime/scheduling-port.ts` is now a contract object handed
to `createObjectPort` rather than its own copy of the dispatch machinery, and
`SchedulingPortError` is gone in favour of `ObjectPortError`. The
`/internal/scheduling` endpoint's docstring records what `objectPortRefusal`
actually refuses, and `scheduling-authority.test.ts` proves the authority half
against `persistCompactionCheckpoint`.

**Why:** ordering. This slice was written against a tree where each typed port
was its own file; the block-dashboard slice landed the one-factory rework
first, so rebasing onto it left this port as a fifth copy of the thing that
rework existed to delete — and a copy that had not picked up the `authority_mode`
check the shared factory's endpoint helper restored. Review had already found
that gap independently: `persistCompactionCheckpoint`, `recordPluginActivation`
and the two description-evaluation writes were the first writes moved off the
routed path whose only fence was `executeWorkstreamRuntimeSql` refusing every
statement against a `preparing` or `quarantined` object. The wake-up mutations
keep an equivalent fence through `commitRuntimeMutation`; those four had none.

Review also asked whether the port should carry a substream id, on the reading
that scheduling calls always resolve to the main child. They do, and that is the
design rather than an omission — these rows live on the main object, and the
shared refusal answers a child substream with a 409 instead of serving it from
an empty table. The docstring now says so where the next reader will look.

**What a future change has to respect:** a new typed authority is a contract
plus an operation list, never a new dispatch function. Writing one by hand is
how this port lost a fence that the shared endpoint helper already had, and the
loss was invisible until someone read two files side by side.

### 2026-08-24 — Opening a work stream writes, so being added to one can be seen

**What changed:** `WorkstreamObjectProductService.get` — the single assembler
behind `GET /workstreams/:id` and the socket snapshot — now commits before it
reads, stamping `participants.first_opened_at` for a viewer who has never opened
this work stream and enqueuing their `directory_user` effect. That effect, and
the viewer overlay on the control socket's metadata frame, carry a new `unseen`
field. Object schema v19 adds the column; WorkspaceDO v10 adds its projection.

**Why:** somebody added to a work stream had no way to tell it apart from the
ones they had already read — the dot showed the run, and unread could not be
made to mean this. Being added does leave the transcript unread (the root's
tracking start is 0 and no per-person attention row is written on the add, so
their waterline is 0 and everything is above it), but unread is a state that
comes back: the next message re-lights it, mark-as-unread sets it by hand, and
neither of those means the room is new. A marker that says "you have never been
here" has to be settled once and stay settled.
The state also had to be cleared by *opening*, which is not the same event the
client reports. `acknowledgeRead` is a statement about what has been read, and
the client withholds it unless the window is focused, the document is visible,
and the transcript has settled at its initial position — so an open can happen
without one. Clearing on the object's own open path removes the dependency on
those conditions entirely: the room was assembled for this person, which is the
fact being recorded.

**Considered and rejected:** clearing it on `acknowledgeRead` and accepting the
gap, which is the same as not shipping the state — the common case for a work
stream somebody was just added to is that nothing new has arrived since. Also
rejected: a separate `POST /workstreams/:id/opened` from the client, which is a
round trip on the open path for something the object already knows is happening,
and which an old client would never send.

**Consequences:** `get` is no longer free of durable writes. It is guarded — the
commit is skipped unless the viewer is an active participant whose
`first_opened_at` is null, so it happens once per person per work stream — but
any future caller of `get` that is not a person looking at the work stream will
record that principal as having seen it. A caller like that wants a read that
does not settle viewer state, which does not exist yet and should be added
rather than worked around.

Shipped in TBD.

### 2026-08-24 — Lease fences keep the projection the compatibility view had

**What changed:** the block dashboard's `#holdsLease` and the tool receipt
storage's `#fence` accept `waiting` and `steering` alongside `running`, spelled
out in a named `LEASE_HOLDING_STATUSES` on the receipt side. Both had narrowed
to `status = 'running'` when they moved off the routed SQL.

**Why:** the routed versions read `_runtime_harness_runs`, whose projection
mapped both statuses onto `running`, so the fences they replaced accepted a run
in any of the three. Nothing writes `waiting` or `steering` today — the `runs`
CHECK constraint admits them and several readers tolerate them, but no code path
produces one — which is why the narrowing was not a behaviour change and why the
first version of this slice left it, with a comment for whoever added the first
writer.

Review made the better argument: retiring a compatibility view should not
quietly narrow what the product accepts, and the two directions are not equally
safe to be wrong about. A fence that does not recognise a status refuses the
write, and both fences report a refusal as a lost lease — so the first writer of
either status would silently drop settled block results and demote returned tool
results to the residual stop fallback, with nothing failing anywhere a person
would look. Carrying three statuses instead of one costs a `Set` membership test
and removes the trap.

**What a future change has to respect:** these two fences and the view's old
`CASE` are one decision. A new lease fence written against `runs.status` decides
the same question, and `running` alone is the wrong default — a busy run is any
of the three. If the product ever settles on a single busy status, retire the
other two from the CHECK constraint rather than from the fences, so the
narrowing is enforced where it can be seen.

### 2026-08-24 — The final message crosses two authorities in one transaction

**What changed:** `persistHarnessFinalMessage` and
`loadPersistedHarnessFinalOutcome` moved onto the ports, through a new
`publishFinalMessage` operation. Migration 22 drops
`_runtime_run_lifecycle_events`, the first of the three views slice 6 could not
retire. `harness-run-runtime.ts` now holds one `D1Database` parameter, and it is
the regional automation one.

**Why it needed a new shape.** This was the last guarded batch and the only one
spanning two authorities: a transcript insert, a lifecycle event whose `JOIN
messages` checked that insert had landed, and a work-stream update whose `EXISTS
(SELECT 1 FROM messages …)` checked the same thing again. Both checks exist only
because a D1 batch cannot branch on its own progress.

`WorkstreamHarnessRunStorage` now composes `WorkstreamMessageStorage` over the
same `DurableObjectStorage`. The decision — whether this attempt may still speak
— belongs to the run's authority; the transcript row belongs to the class that
owns `parts`, so `parts` still has exactly one writer. Both wrap the same
storage, so the nested `transactionSync` is the same transaction rather than a
second one. That is the pattern to reach for when an operation genuinely spans
authorities: compose, do not reimplement, and never let a second class write
another's table.

**The third statement turned out to do nothing.** It assigned
`latest_attention_sequence_number`, which was never a column — the retired view
derived it as `next_attention_ordinal - 1` and its update trigger ignored every
caller that assigned to it. What remains of that statement is `last_activity_at`
and `updated_at`, which `appendMessage` already moves.

**The sequence number is now allocated where it is used.** `ensureSequence` in
`integrations.ts` reserved one first through a bespoke `UPDATE workstreams SET
next_sequence_number = next_sequence_number + 1 … RETURNING` rewrite, then
passed it in — burning a number whenever the write was refused. It had exactly
one caller and its memo variable was read nowhere else, so it deletes outright
and that rewrite loses a consumer.

**What a future change has to respect:** the `final_message` lifecycle event's
`status` is the *published* spelling, unlike the `terminal` event's. That is
load-bearing rather than an inconsistency — this event records the host outcome
the caller reported, and recovery reads it back and compares it against the
published terminal set, while `terminal` records the run's own state in the
object's vocabulary. The two events answer different questions and are spelled
accordingly.


### 2026-08-24 — Four regressions a review caught, and the edits that caused them

**`admitRun` threw where the retired trigger had swallowed.**
`runs_mutating_substream_uq` allows one mutating run per substream and every
root run shares `'0'`, so admitting a second `running` run collides. The retired
`_runtime_harness_runs_insert` trigger used `INSERT OR IGNORE`, which turned
that into a zero-change result the caller reported as a stale request; the bare
`INSERT` that replaced it throws, and a throw takes the whole `transactionSync`
with it — including the supersede immediately above. A superseding Slack message
would have neither started its run nor stopped the one it meant to replace, and
the caller would have seen `harness_run_operation_failed` instead of a 409.

A supersede does not clear the way by itself: it stamps
`cancellation_requested_at` and leaves the incumbent `running` until that run
notices, so the collision is *most* likely in exactly the case supersede exists
for. `mutatingRunHoldsSubstream` now asks before writing and answers `busy`,
mirroring the index including its block-dashboard exemption. `busy` and `stale`
carry the same member-visible 409 for now, because the routed version could not
tell them apart either — splitting what a member is told is a product decision
rather than part of this conversion.

**`memoryContext` read by attempt where the write reads by run.** The table is
`PRIMARY KEY (run_id)`, so a second attempt missed the fast path, paid a full
vector search, and threw the result away when the insert returned the first
attempt's row. Both are keyed by run now: freezing recall exists so every
attempt of a run sees the same memories, which makes that row the later
attempt's answer rather than something to look for under its own id.

**A dead comparison in `terminalizeHarnessAttempt`.** `already_terminal` is
returned only for a run whose stored status already equals the one asked for, so
comparing them again described a case that cannot happen.

**`launchRun` gates the sidebar promotion on the run's origin, where the routed
statement gated it on `input.reason`.** That is a silent tightening rather than
a fix: `reason` is a free-form string on `WorkstreamWorkflowInput`, and the
statement compared it to `'block_dashboard_block'` — a value it could never
hold, because `startWorkstreamWorkflow` is not on the block-dashboard path at
all. Block runs reach `claimAttempt` through `BlockDashboardAgent` and never
pass here. So the old guard excluded nothing, the new one excludes nothing
today, and the difference is only that the new one is asking the run what it is
instead of asking a string what it says. It starts mattering the day a block run
does reach this path.

### 2026-08-24 — Two regressions a review caught, and the edit that caused one

**What changed:** `activeLeaseExpiresAt` no longer excludes the contended run
itself, and `RUN_STATE_WRITES` is back to the seven operations that actually
write the `workstream` row. `harness-run-protocol.test.ts` now holds that set to
its behaviour.

**Why the first was wrong.** A duplicate dispatch of a run that is already being
worked on is refused by the same `busy` branch as a work stream held by someone
else — but in that case the live lease the caller must wait for is *this run's
own*. Excluding it returned null, and both SubstreamAgent and BlockDashboardAgent
read null as "retry in five seconds", so an at-least-once redelivery would wake
and reattempt every five seconds for the whole five-minute lease. The routed
version had no such exclusion; the `status = 'running'` and `lease_expires_at`
predicates already exclude a run that is not holding anything, which is why it
never needed one.

**Why the second happened, which matters more than the fix.** Nine reads and
progress writes — `latestRootRun`, `runIsActive`, `triggerPartId`,
`recordRunProgress`, `bindWorkflowInstance`, all three reaper scans and
`reapStaleInlineChild` — were on `RUN_STATE_WRITES`, so each ran through
`commitRuntimeMutation(…, true)`. That builds the directory projection: every
active participant read, the resource links walked. A usage flush runs every few
seconds of every run, and the reaper scans on every activation.

They got there by a mechanical edit. `DISPATCHED_OPERATIONS` and
`RUN_STATE_WRITES` sit in the same file and share entries at the same
indentation, so a string replacement anchored on one list's entry silently
inserted into both. Nothing caught it: the set had no test, and being on it
changes only how much work an operation does, never its answer.

**What a future change has to respect:** membership in `RUN_STATE_WRITES` is
expensive to get wrong and invisible from an operation's name or its result.
The test asserts the set as a literal rather than deriving it, so adding an
operation is a decision made there rather than a side effect of editing the list
above it, and it checks both directions against real storage — the classified
operations move the `workstream` row, and the unclassified ones leave it byte
for byte unchanged.


### 2026-08-23 — Three of the six harness-run views retire, and why the other three cannot

**What changed:** migration 23 drops `_runtime_run_scopes`,
`_runtime_run_plugin_activations` and `_runtime_run_memory_contexts` with their
insert triggers, and removes all three from `LOCAL_TABLES` and `TABLE_REWRITES`.
`freezeRunMemoryContext` moved onto the port to make the third of them possible.

**Why only three.** The other three are held by *other* slices rather than by
anything this authority still does, and each for a reason worth stating so the
next person does not try again:

- `_runtime_harness_runs` is written by the work-stream bootstrap batch, which
  creates the work stream, its opening transcript row and its first run in one
  atomic routed statement set. Pulling the run out introduces a partial failure
  that does not exist today — a work stream with no run — so it goes when the
  transcript does.
- `_runtime_run_lifecycle_events` is joined to `messages` by the two functions
  that verify a run published its final message. Same slice, same reason.
- `_runtime_inference_attempts` is joined to `_runtime_harness_runs` by run
  telemetry, so it cannot outlive the view it joins.

All three dropped here carried an insert trigger and nothing else: a scope, a
plugin activation and a memory context are written once and never updated, which
is why none of them ever needed more.

**One test's subject had to be restated rather than deleted.** `scoped-memory`
proved a frozen memory context is immutable by showing a routed `UPDATE` was
refused — which worked only because the compat view carried an insert trigger
and no update one. That is a guarantee stated as a *missing* trigger, and it
disappears with the view. The same guarantee is now stated positively:
`persistMemoryContext` answers `reused` and returns the stored row, so the test
asserts the second write neither lands nor is reported as having landed.

**What a future change has to respect:** `persistMemoryContext` returns the
winner's row rather than an outcome to interpret, and that is not convenience.
The value costs a vector search to compute, so the read and the write cannot be
one operation; freezing recall exists so every replay of an attempt sees the
same memories, which makes the row the run will actually use the only useful
answer to give a loser.


### 2026-08-23 — The callers outside the runtime, and what a half-converted path costs

**What changed:** the harness-run callers in `workstream-service`,
`automation-service`, `workspace-schedule-execution`, `activity-consumer`,
`integrations` and both Terminal services moved onto the port, through eight new
operations: `admitRun`, `launchRun`, `bindWorkflowInstance`,
`failUnlaunchedRun`, `recordRunProgress`, `latestRootRun`, `runIsActive` and
`triggerPartId`. `reconcileDueTerminalSandbox` no longer takes a database at
all — it took one solely to ask whether a run was still active, so its first
parameter is now a `HarnessRunPortFactory`.

**Why:** the same guarded-batch shape as everything before it. Admission was a
supersede, an `INSERT … SELECT … WHERE ? = (SELECT latest.id …)` whose subquery
*was* the staleness check, and a sidebar update guarded on `EXISTS (SELECT 1
FROM harness_runs WHERE id = ?)` asking whether the insert had landed. The
staleness check is the one worth naming: expressed as a subquery inside the
insert, it could only answer by writing nothing — which is also what a duplicate
id does — so the caller could not tell "someone else got here first" from "this
is a retry of my own request". `admitRun` answers `stale` and `exists`
separately.

**Two run insertions stay routed, and that decides slice 7's order.** The
automation and inbound-activity paths create their run inside the *work-stream
bootstrap* batch — `workstreams`, `messages` and `harness_runs` in one atomic
routed batch. Pulling the run out would introduce a partial failure that does
not exist today: a work stream with no run. So `_runtime_harness_runs` cannot be
dropped until the transcript and work-stream rows move too, which means slice 6
cannot retire its own view without slice 7. That is a scheduling fact, not a
preference.

**What a half-converted path costs, in one test.** `automation-run-recovery`
hand-builds a model of the regional database and answers the runtime SQL port
from it. With the run still created by a routed statement but now *read* through
the port, the two halves stopped talking about the same run — the write went to
the hand-built model and the read to a real object store. The fixture now
answers `executeHarnessRunOperation` from the same model, and throws on any
operation it has not modelled rather than returning nothing, because a fixture
that answers "no such run" to a question it does not understand makes a passing
test that proves the opposite of what it claims.

**What a future change has to respect:** `failUnlaunchedRun` routes its sidebar
write through `settleWorkstreamState` like every other ending, which adds a
guard the routed version lacked — it will not report `failed` over a work stream
some other live run still holds. That case is unreachable from where it is
called today, because the admission immediately before it superseded everything
else. The guard is there for when that stops being true.


### 2026-08-23 — Terminalization and the reaper, and the end of the changes count

**What changed:** `terminalizeHarnessAttempt`, `terminalizeQueuedHarnessRun`,
`reapStaleHarnessRuns` and the residual-receipt marker moved onto the port, as
`terminalizeAttempt`, `terminalizeQueuedRun`, `reapStaleRoot`,
`reapStaleInlineChild`, two bounded scans and `recordReceiptReconciliation`.
`d1Changes` is deleted: nothing in the runtime interprets a changed-row count
any more.

**Why:** these were the last and worst of the guarded batches. Terminalization
was four statements in which the third and fourth each carried `EXISTS (SELECT 1
FROM harness_runs … AND terminalized_at = ?)` — a correlated subquery whose only
job was to ask whether the batch's own *second* statement had landed, because D1
gives a batch no way to branch on its own progress. The reaper did the same
thing twice more, and spelled its parent-supervision test three times: once in
the scan and twice inside the batch that acted on it, the second copy produced
by rewriting `child.` to `harness_runs.` with a string replacement. That test is
now one private method, read once.

**Two of the three sidebar writes now live together.** `markWorkstreamRunning`
(the claim) and `settleWorkstreamState` (every ending) are the two halves of
what the member sees, and `settleWorkstreamState`'s `NOT EXISTS` is the part
that matters: a superseding turn admitted while this one was finishing must keep
the work stream busy, or the member watches it go idle and immediately start
again. `terminalizeAttempt`, `terminalizeQueuedRun` and `reapStaleRoot` all join
`claimAttempt` in `RUN_STATE_WRITES`, so each commits its projection with its
write.

**What a future change has to respect.** Receipt settlement stays *outside* the
terminalization transaction, and that is not an oversight: the receipts are a
different authority, and of the two possible orderings only "terminalize, then
settle" fails safe. The price is a window where a run is terminal and its tool
card still spins, which is why `already_terminal` reports whether the marker was
ever written and why `residualRepairCandidates` exists at all. Moving the
settlement inside, or dropping the marker, reintroduces a permanently spinning
tool card with nothing to find it.

The lifecycle event's `status` column now holds the object's vocabulary, where
`stopped` is `cancelled`. No production code outside this authority reads it;
the compat view passes it through untranslated, and both are retired together.

**Three functions in `harness-run-runtime.ts` still take a database, and each
for a stated reason.** `persistHarnessFinalMessage` and
`loadPersistedHarnessFinalOutcome` join `messages`, which waits for slice 7.
`settleStaleAutomationRun` writes `automation_runs` — a regional D1 table, not
an object-local one — and is the one place a terminalization instant crosses
back into ISO-8601 text.


### 2026-08-23 — The sub-agent concurrency cap is removed, not renamed

**What changed:** `HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS` is gone — the env
var, its schema entry, both Worker configs, the `maxActiveWorkspaceChildren`
option and the `workspace_child_capacity` refusal. `maxChainRuns` is now the
only bound on sub-agent fan-out.

**Why:** the entry below records that the cap had not meant what its name says
since the per-workspace-database cutover, and left the choice open between
restoring a genuinely workspace-wide limit and accepting the narrowed one. The
team chose neither: remove it. That is the right call, because what it actually
enforced was already implied. A chain may create `maxChainRuns` runs in total
(4 by default), so it can never have more than that many children alive at once
— a separate cap of 8 live children could not bind before the chain budget of 4
did. Keeping it would have meant carrying a second limit, a second refusal
reason and a second count for a rule the first one already made.

**What a future change has to respect:** the two limits are not
interchangeable, and a test now says so by name. The retired cap counted *live*
children, so settling one freed a slot; the chain budget counts every run the
chain has created, so it does not. A run that has answered has still been spent.
Reintroducing slot-freeing behaviour — filtering the chain count by
`terminalized_at IS NULL`, say — turns a lifetime budget into a concurrency
budget and lets a sub-agent tree grow without limit as long as it settles as it
goes.

**Where the remaining exposure is.** One work stream runs one mutating run at a
time, so an interactive conversation tops out at `maxChainRuns - 1` concurrent
sub-agents. HyperSight block runs are the exception the claim rule already
makes: each block owns its own run and therefore its own chain budget, so a work
stream with *N* blocks can reach *N* × (`maxChainRuns` - 1). If that ever needs
bounding, bound it where blocks are dispatched rather than by reviving a
per-child cap here.


### 2026-08-23 — The sub-agent family finishes, and two fences nothing was holding

**What changed:** `terminalizeInlineChildAttempt`, `loadInlineChildResult`,
`cancelDescendantHarnessRuns` and `persistInlineChildScope` moved onto the port.
No function in the inline-child family takes a `D1Database` any more.

**Why:** the settlement was two statements where the second was guarded on the
first — its `UPDATE`'s `WHERE` carried `EXISTS (SELECT 1 FROM
harness_run_lifecycle_events WHERE lifecycle.id = ?1 …)` for no reason except
to ask whether the batch's *own* first statement had landed. That is a
transaction spelled as a correlated subquery, so it became a transaction.

**Two behaviours had no test, and the mutation pass is what found them.**
Deleting the parent's attempt/owner fence from the settlement broke nothing —
so a parent that had already lost its own attempt could still collect its
sub-agent's result. And `cancelDescendants` survived both removing its
`chain_root_run_id` reach (which is the only thing connecting a *grandchild* to
the run being stopped, since its `parent_run_id` is the child) and removing the
`COALESCE` that keeps the first cancellation's reason. All three now have specs
that fail when the behaviour is removed. A fourth — `persistInlineChildScope`
comparing the child's `inherited_scope_hash` against the parent's frozen scope —
was uncovered for the same reason the others were: as a join, its failure was
indistinguishable from the parent having no scope, so nothing had ever asserted
on it separately.

**What a future change has to respect:** `status === "cancelled"` relaxes the
cancellation fence on *both* sides of the settlement, and only for the stop
itself. A stop is exactly when a live owner must still be allowed to write —
refusing it leaves the parent waiting forever on a child that will never answer
— but an ordinary `completed` settlement after a requested cancellation is still
refused, because a child asked to stop must not report success as though nothing
had happened. The two are one line apart and a mutation test separates them.

Two vocabularies now meet in this file. `TERMINAL_RUN_STATUSES` is exported from
the storage class in the object's words, where `stopped` is `cancelled`;
`TERMINAL_STATUSES` in the runtime is the published spelling. Which applies
depends on whether the value came off a `RunRow` or out of a published payload,
and `storedRunStatus`/`publishedRunStatus` are the only sanctioned crossings.


### 2026-08-23 — Sub-agent admission, and a cap that stopped meaning what it says

**What changed:** `admitInlineChildAttempt` became `admitInlineChild` on the
storage class — one transaction returning one of eight named outcomes, replacing
six statements and two diagnostic reads. `heartbeatInlineChildAttempt` and
`InlineChildRunLiveness` came with it, so no part of a sub-agent's lifecycle
still takes a database handle.

**Why:** it was the largest statement the compat layer routed and the clearest
argument for the pattern. Three capacity subqueries lived inside an
`INSERT … SELECT`'s `WHERE`, so a refusal arrived as zero rows and a *second*
read — repeating all three subqueries — had to work out which policy had
refused. The reclaim path then did the same thing again with a fourth subquery.
Reading the policies first and writing after, inside one transaction, is both
shorter and the only way a refusal can name itself.

**A cap that has not meant what it says since the per-workspace-database
cutover.** The routed admission counted active children with
`active_child.workspace_id = parent.workspace_id`, which reads as a
workspace-wide limit and is still configured as
`HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS`. But `harness_runs` is object-local,
so that predicate ran against `_runtime_harness_runs` — a view of *this work
stream's* rows alone — where the comparison is true for every row it can see.
The cap has been per-work-stream ever since, and nothing recorded that.
`activeInlineChildren` counts what the predicate actually counted, so this
change preserves today's behaviour rather than restoring the original intent.

**What a future change has to respect:** restoring a genuinely workspace-wide
cap is not a refactor. Nothing inside one WorkstreamDO can count another work
stream's runs, so it would need WorkspaceDO to hold the count — a product
decision about whether the limit is per-conversation or per-workspace, and a
number that is the team's to set either way. Until that decision is made, the
env var's name is the lie and the behaviour is the truth; do not "fix" the
count to match the name without adding the cross-object query that would make
it real.

The heartbeat is `heartbeatAttempt`'s three-round-trip problem with the double
fence on top — a guarded `UPDATE` carrying an `EXISTS` over the parent, a
`LEFT JOIN` read to tell cancelled from lost, and a third read for the deadline
it had just written. It now composes `inlineChildOwnership` with the write in
one transaction, which is also why the two share a precedence rather than
restating it.


### 2026-08-23 — The sub-agent's double fence, and a substream the fixture forgot

**What changed:** `assertInlineChildAttemptOwned` and `recordInferenceAttempt`
moved onto the port. The first became `inlineChildOwnership` on the storage
class; the second is a plain `INSERT OR IGNORE`.

**Why:** the inline-child assert was a self-join on `harness_runs` with eight
bound parameters and two `lease_expires_at > now` predicates — the fence that
stops a sub-agent outliving the run that delegated to it. Both rows belong to
this object, so the join is two reads and the answer is one of three named
outcomes.

Its **precedence** is the part worth preserving deliberately. A lost lease
answers `ownership_lost` even when the other side was also stopped, because a
caller that no longer owns the run has not *observed* a cancellation — it is
reading a row someone else now controls, and must be told it lost the run rather
than told to settle. Checking cancellation first would invert that, and a
mutation test now holds the order in place.

`recordInferenceAttempt` is the one write in this family with no lease fence,
and deliberately: an attempt row is telemetry about a provider call that already
happened, so dropping it because the lease lapsed mid-call would delete the
record of exactly the failure worth having.

**What a future change has to respect:** a delegated sub-agent runs in **its own
substream**, `run:<id>`, created by the same write that creates the run. That is
not incidental — `runs_mutating_substream_uq` allows one mutating run per
substream, so a child sharing its parent's substream is a `UNIQUE` violation
rather than a queued run. The first version of this change's fixture put the
child in substream `0` and the constraint caught it; `admitInlineChildAttempt`
must create the substream row when it converts.


### 2026-08-23 — The lease stops being a join, and the sidebar write it had lost

**What changed:** the harness-run lease family moved onto the typed port.
`claimHarnessAttempt`, `heartbeatHarnessAttempt`, the two ownership asserts and
`CoalescedRunLiveness` no longer take a `D1Database` — they take a
`HarnessRunObjectPort` and nothing else. `persistImmutableRunScope` and
`persistRunPluginActivation` became `persistScope` and
`persistPluginActivation` on the storage class, and dropped their database
handle with it.

**Why:** these were the clearest instance of the thing this whole conversion is
about — a write whose fence *is* a join. Both scope and activation were
`INSERT INTO … SELECT … FROM harness_runs WHERE lease_owner = ?`, so a row was
written only if the caller still held the run; but the insert's own
`meta.changes` could not say whether zero meant "I already wrote this" or "I no
longer hold it", so each needed a second, diagnostic statement to find out. One
transaction reads the fence, reads the existing row, and returns which of four
states it is. `FencedWriteOutcome` names them once, because they mean the same
thing for every write fenced this way.

**A regression this found, and the reasoning that produced it.** The routed
claim was a three-statement batch, and the third statement set
`workstreams.harness_status = 'running'` — the sidebar's whole answer to
whether a work stream is busy. `claimAttempt` did not reproduce it, and the
comments here and in the protocol asserted that it did not need to, because the
endpoint runs the claim inside `commitRuntimeMutation`. That was wrong:
`commitRuntimeMutation` publishes the directory's *projection* of the work
stream row, it does not set the row's state. Nine tests failed on it.
`markWorkstreamRunning` makes the write, from the claimed row the transaction is
already holding rather than from the `WHERE EXISTS` that re-derived the claim.

**What a future change has to respect:** that write is a *guard*, not an
assignment. `exact_state` distinguishes `interrupting`, `preparing_context` and
`waiting_capacity`, all of which the retired view flattened to one `running` —
which is why its trigger compared the projection on both sides before writing.
Assigning `'running'` unconditionally would silently demote a work stream that
is being stopped. A HyperSight block run never makes this write at all: those
runs sit beside the conversation rather than holding it.

**Still routed, and why.** Thirteen functions in `harness-run-runtime.ts` keep a
`D1Database` — the inline-child family, terminalization, the reaper, and
`persistHarnessFinalMessage`. The last one is not deferred for size: it writes a
message, a lifecycle event and the work stream's attention counters in one
batch, so it straddles the message authority and cannot land before slice 7.

### 2026-08-23 — One object-port factory, and the fence the typed endpoints dropped

**What changed:** the four typed object ports stop being four copies of one
file. `runtime/object-port.ts` and `durable-objects/object-port-protocol.ts`
hold the machinery; each port is now its storage class, an operation list and
an error code. The four `*PortError` classes collapse into one `ObjectPortError`
— none was ever caught by type. And every `/internal/*` endpoint re-checks
`authority_mode`, which the routed path checked and these endpoints had
silently dropped.

**Why:** the normalized diff between two of the port files was twenty-four
lines, all of them comments. That is not four things that might diverge, it is
one thing written four times — so a fix to the pattern had to be made four
times, and a divergence between them was invisible. Three more slices would
have added three more copies.

The authority fence is the concrete cost of that duplication.
`executeWorkstreamRuntimeSql` refuses every statement when the object is
`preparing` or `quarantined`; the first typed endpoint kept the identity check
beside it and dropped this one, and the next three copied that. The wake-up
mutations happen to keep an equivalent check through
`commitWithRegionalEffects`; nothing else did, so compaction, plugin-hint and
description-refresh writes were committing against an object whose writes do
not count.

**What a future change has to respect:** `objectPortRefusal` is the one place
these two checks live. An endpoint that re-implements them inline is how the
fence went missing the first time.

**Two things deliberately *not* built, after review asked for them.** Both are
guards for states this product cannot reach, and the reasoning is the same in
each case as for the `waiting`/`steering` fence recorded below.

`admitDispatch` does not compare `block_id`. `blockRunId` is a fresh `uuidV7()`
per dispatch, so the pair recurring under a different block needs a UUIDv7
collision; the branch, and the error code that fed it, are gone rather than
written for an event that cannot happen.

The object ports do not carry a substream id. Every one of them addresses the
main child and every endpoint refuses a non-main substream, and no non-main
substream is ever created — `workstream-object-storage.ts` inserts `'0'` and
nothing else does. Threading an id through four ports to serve a child object
that cannot exist would be handling for an unreachable path. The first person
to create one revisits this and the two fences below.

**One thing deliberately un-built.** `BlockWriteOutcome` went back to two
members. A third, `already_terminal`, told a caller that a fenced write failed
because the block was already settled rather than because the lease had moved —
which no caller acts on: both throw, and the two error codes it added were
caught nowhere. The distinction is real and the object can make it; it is worth
making when something needs it.

### 2026-08-23 — Resources leave the compatibility layer, and turn out to have been mostly somebody else's

**What changed:** `WorkstreamResourceStorage` owns `workstream_resource_links`
and `resource_inventory_revision`, reached through `/internal/resources` and a
typed port. Object schema migration 21 drops
`_runtime_workstream_resources`, `_runtime_resources` and
`_runtime_resource_revisions` with the first one's two triggers, and both
routing tables lose all three entries. This is slice 5 of
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md).

**Why this slice is a tenth of the size its statement count predicted.** The
PRD counts 73 statements across 22 files for `resources`,
`workstream_resources` and `workstream_resource_inventory_revisions`. Almost
all of them name `resources` *alone*, which routes to WorkspaceDO and belongs
to the notes-and-resources slice. What reached this object was the **link** —
which resources a work stream has attached, why, and whether it is watching
them — and a handful of statements that joined the two.

`_runtime_resources` is what made those joins possible, and it was never a view
over a table this object owns. It projected
`workstream_resource_links.resource_json` — the *frozen copy* the object keeps
of a workspace resource — as though it were the workspace's live `resources`
row. Every caller now asks the authority that owns the half it needs, which is
two reads where there was one join, and which is also the only arrangement that
is true: the frozen copy and the live row have been able to disagree since a
resource could be renamed after being attached.

**The watch toggle is the conversion worth reading.** Turning a watch on
crosses two authorities — the link is this object's, the `resource_watches` row
is regional — so no transaction spans them. The routed version read
`watch_enabled`, wrote the new one, ran the regional write, and on failure wrote
back the value it had read three round trips earlier. `setWatchEnabled` answers
with the value it replaced, so the compensation restores *that*, and the read
and the write are one operation rather than two with a window between them.

**One behaviour deliberately not reproduced.** The retired update trigger
advanced `resource_inventory_revision` on every column it could write,
including `watch_enabled`. That revision is a compaction checkpoint's
visibility fence — `inventory:<revision>` — which exists to invalidate a
checkpoint when what a run is *authorized to see* changes. A watch flag changes
nothing about that, so the endpoint does not bump it, and a checkpoint survives
a toggle that never affected it. The paths that do change the authorized set are
the product service's, and they still bump it. There is a `test-workers/` spec
for exactly this.

**What a future change has to respect.** Two `INSERT INTO workstream_resources`
literals and an inbound-email visibility predicate went with this slice, all
three already dead: the inserts sat behind `if (regional === env.DB)`, which
requires an environment with no workspace runtime database — and production
requires one before request dispatch — while the visibility predicate had been
replaced by a per-row `resourceAccess` call against the workspace object in
`6ff47e62`. That last one is worth knowing about before someone reads the
deletion as a lost rule: **it is enforced, just not in SQL any more**, and
`canReadInboundEmailResource` is where it lives.

`_runtime_workstream_resources` never had an *insert* trigger. Attaching has
gone through the product service since before this slice, which is the clearest
evidence that the link table was already the object's in everything but its
reads.

### 2026-08-23 — The transcript's remaining readers, and the boundary the self-registration had not actually removed

**What changed:** seven more transcript callers left `_runtime_messages` —
naming, the description refresh, Terminal's admission check, creation
telemetry, the HyperSight context fence, the automation opening-message
lookup, and the connected-activity writer. `WorkstreamMessageStorage` gains the
operations they need: `saidMessages`/`saidMessageCount` behind a
`MessageTypeFilter`, `saidWindow`, `messageAtSequence`,
`messageFromParticipant` and `openingAttachmentCount`. `/internal/messages`
answers its RPC entry point without building a `Request` or reading a
`Response`.

**Why:** the slice claimed every reader and writer that is not the product
service, and it had converted six services. The rest were not among the
cross-slice batches it named as deliberately untouched — they were simply not
done, and both the changelog and the PRD were handing slice 5's author a map
that said otherwise.

**`MessageTypeFilter` exists because the two window readers disagree.** Naming
wanted `message_type = 'text'`; the description refresh wanted
`message_type <> 'tool'`. Those are different questions, and `parts.message_type`
carries no CHECK constraint, so they cannot be reconciled into one list: an
`include` list silently drops a type nobody has added yet and an `exclude` list
silently admits one. Each caller states which it means.

**The finding: a port call from inside the object was paying for a boundary the
self-registration exists to remove.** Converting the description window
regressed `message-to-output-pipeline.test.ts` — deterministically, 5 runs in
5 — because the drain runs that refresh at the end of every harness run and the
port made it slower. `durable-object-self.ts` hands an object a stand-in stub so
a call to itself never leaves the isolate; the RPC entry point then serialized
its already-parsed input into a `Request`, read that body back as a stream, and
read a `Response` body back out, which is six serializations to move a value
nowhere. `messageOperationOutcome` is the endpoint's decision without either
wrapper, and both entry points share it.

That was not the whole regression, and chasing it is what found the rest.

**What a future change has to respect.** The remaining `_runtime_messages`
callers are *all* cross-slice, and there are more of them than the three this
slice first named: every `harness-run-runtime.ts` reader joins `messages` to
`harness_runs` or `harness_run_lifecycle_events` inside one statement; Slack's
elicitation answer guards its counter update on `EXISTS (SELECT 1 FROM
messages)`; and inbound email's sequence claim is fenced on
`workstreams.email_address`, which makes it identity's as much as messages'.
`workstream-resource-visibility.ts` names `messages` beside
`workstream_resources` and belongs to the resources slice. None of them is a
plain reader left behind.

The three new window operations take a `limit` and mean it. `saidWindow` asks
for one past the ceiling on purpose: `requested > limit` is how the description
reports that it capped, and a count clamped *at* the ceiling can never say so.

### 2026-08-23 — The transcript gets a typed authority, and the compat layer's ordering turns out to be wrong

**What changed:** `WorkstreamMessageStorage` owns `parts`, `part_mentions` and
`part_attachments` for every reader and writer that is not the product service,
reached through `/internal/messages` and a typed port.
`message-projection.ts` assembles the `Message` shape the retired reader built
inside its query. `packages/db`'s five message functions and their projector are
deleted — nothing calls them. This is slice 4 of
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md).

**Why:** the same case as the slices before it, plus one thing specific to the
transcript. `_runtime_messages`'s insert trigger did not only translate; it
advanced the work stream's `next_attention_ordinal` and
`last_people_activity_at` as a side effect of the insert. That is why every
routed transcript write was a *batch*: the trigger moved one set of counters and
the caller's own second statement moved the other, and the two were one fact
only because the router happened to send them together. An append is one
operation now.

The inline tool card is the same shape one step further on. Its write took the
work stream's next sequence number in an upsert, then advanced the counter in a
*second* statement guarded on the inserted row having actually taken it — which
is how a refresh of a settled card avoided consuming a transcript position. That
guard is a read of what the first statement did, expressed as a `WHERE` clause
because a batch cannot ask. `upsertToolMessage` reads the row first and decides
from it, inside one transaction; and it advances `next_sequence_number` without
`next_attention_ordinal`, because a tool card is machinery a member did not do
and the retired insert trigger, not any caller, drew that line.

**The finding that matters more than the conversion: this slice cannot drop its
views, and neither can slice 3.** Three transcript writes are batches that span
three slices at once — an elicitation and its message and the work stream's
counters; a harness run's final message, its lifecycle event and the work
stream; a work stream's own creation, its opening message and its attachments.
Each one's later statements are guarded on its earlier ones having landed, so
splitting any of them across a port boundary puts a network hop inside a
guarantee. `_runtime_messages`, `_runtime_message_attachments`,
`_runtime_message_mentions` and `_runtime_elicitations` therefore all retire
with the identity and harness-runs slices, not before. The PRD orders messages
before identity; on the evidence of these four views that order is not
available, and the PRD now says so.

**What a future change has to respect:** two behaviours here are faithfully
reproduced rather than fixed, and both are worth fixing on purpose later.

Author identity is fabricated — empty email, the member's own id as their name,
no avatar — because `_runtime_users` fabricated it and every converted reader
has been getting that. The harness's description prompt has been reading UUIDs
where it means names. The object can reach the real profile one layer away, and
the identity slice is where all these readers should start seeing it, together.

An attachment's resource is read from `workstream_resource_links`, the object's
frozen copy, because the retired `JOIN resources` was rewritten onto a view that
`json_extract`ed the same copy. The *product* service reads the live regional
row instead, so a resource renamed after it was attached renders one way in the
app and another in the harness's transcript. Reconciling them is the resources
slice's.

### 2026-08-23 — Scheduling moves onto a typed authority, four views at a time

**What changed:** `WorkstreamSchedulingStorage` owns `workstream_wakeups`,
`compaction_checkpoints`, `description_refresh_state`,
`plugin_activation_hints` and the reads of `elicitation_requests`, reached
through a typed port and an `/internal/scheduling` endpoint. Object schema
migration 20 drops four `_runtime_*` views and their seven triggers, and those
four tables leave the routing and rewrite lists. This is slice 3 of
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md).

**Why:** the same reason slices 1 and 2 give. What is specific here is that
almost every operation in this family is a *claim* — a wake-up, an evaluation,
a compaction's visibility — and a claim written as routed SQL is a
compare-and-swap spelled out in a `WHERE … version = ?` clause whose answer
comes back as a `meta.changes` count. Each of them then needed a second
statement to find out what had actually happened: which wake-up a replay
resolved to, what version a claim had just written, whether zero changes meant
a lost race or an archived work stream. The read and the write are one
transaction now, so each of those questions is the operation's own answer.

**`_runtime_elicitations` deliberately outlives this slice.** Every read of it
is gone; its two writers are batches spanning three slices — an elicitation
row, a transcript message, and the work stream's sequence and attention
counters, written together because the second statement is guarded on the first
having landed. Splitting one onto this port would put a network boundary inside
that batch, and writing the message natively here would mean building the
messages slice's machinery inside this one, beside the richer version
`WorkstreamObjectProductService` already has. It goes with the messages slice.
The PRD's slice table lists five views for slice 3; this is a deliberate
departure from it, not an oversight.

**The alarm path was the one wake-up writer that skipped all of it.** Review
caught this after the slice was pushed. `runScheduledAlarm` built its port with
the in-isolate storage seam, on the stated grounds that an object dispatching an
RPC to itself is a round trip to its own SQLite — which is not true here:
`this.env` is rebound through `withDurableObjectSelf` in the constructor, so the
stub resolves to this instance and the endpoint runs in this isolate anyway.
Taking the seam skipped `commitRuntimeMutation`, so an alarm-fired claim did not
republish the sidebar's next-wake-up marker, and the marker went on advertising
a wake-up that had already fired until some later write moved it. The launched
path hid it — the transcript notice republishes a moment later — but the two
paths that return without appending do not.

The port is built without the seam now, and the endpoint's arming is wrapped in
the same catch-and-log its two siblings use: the operation is already durable,
so a failed `setAlarm` must not tell a caller its committed write failed.

**What a future change has to respect:** the object maintains its own alarm
index and publishes its own sidebar projection for wake-ups, and both used to
be consequences of the routing. A wake-up write arrived as SQL, and the object
matched `workstream_wakeups` in the statement text to decide that the
next-wake-up marker had to be republished and that the timer index had to be
re-derived. `mutatesWakeups` in the protocol names those operations instead,
and the endpoint runs them inside `commitRuntimeMutation` so the projection is
in the same commit as the row. An operation added to that storage class without
a place in that set is a wake-up that silently stops arming — which is why the
set is a named export next to the operation list rather than a condition inside
the endpoint. `test-workers/scheduling-authority.test.ts` is what holds that
down; it fails on all four counts when the set is emptied.

The narrowing that is *not* here: `restUntil` returns an instant rather than an
ISO string, because the object stores instants. The retired read compared
ISO-8601 lexically, which is sound for that format and is why it worked.

### 2026-08-23 — Three block-dashboard answers the compatibility layer could not give

**What changed:** `admitDispatch` gained a `dispatch_conflict` outcome, and the
two fenced writes — `submitMarkdown` and `settleBlockRun` — gained
`already_terminal` alongside `ownership_lost`. `BlockDashboardAgent` throws
`block_dashboard_runtime_initialization_conflict` on the first, and
`integrations.ts` names the second apart from a lost lease at both call sites.

**Why:** review of the slice found the port had quietly lost two distinctions
the code it replaced still made. The retired UNIQUE-violation rescue re-read the
existing row by five columns including `block_id`, and rethrew when it found
none; the first port compared only the row's own identity, so a dispatch naming
an admitted `(blockRunId, harnessRunId)` pair for a *different* block came back
`already_admitted`. `blockRunId` is a fresh `uuidV7()` per dispatch rather than
a value derived from `blockId`, so nothing upstream makes that impossible — and
admitting it would write one block's markdown under another block's row. The
guard that was supposed to catch it had become unreachable, which is worse than
absent: the code asserted a case was handled while the operation could no longer
report it.

The second distinction was cheaper to lose and just as wrong. A fence that holds
over a row that has already settled is a redelivery, not a takeover, and folding
it into `ownership_lost` told a member's tool call that its run had been
superseded when it had not. The routed statements genuinely could not tell the
two apart — one `meta.changes` count, zero either way — so this is a distinction
the object makes because it can, not one that regressed.

**What a future change has to respect:** `already_terminal` also covers a block
row that does not exist, and there is deliberately no fourth outcome for that,
because `admitDispatch` writes the block row in the same transaction as the run
whose lease is fenced — a held lease implies the row. If block rows ever become
writable without their run, that reasoning goes with it. And `#holdsLease` reads
`status = 'running'` where the retired view's projection also accepted `waiting`
and `steering`: inert today because nothing writes those two statuses, so
widening it would be handling for a state the product cannot reach. The first
writer of either revisits this fence and the receipt storage's `#fence`, which
narrowed identically.

### 2026-08-23 — The block dashboard leaves the compatibility layer

**What changed:** `WorkstreamBlockDashboardStorage` owns
`block_dashboard_block_runs`, `block_dashboard_configuration_versions` and
`block_dashboard_user_preferences`, reached through a typed port and an
`/internal/block-dashboard` endpoint. Object schema migration 18 drops the three
`_runtime_block_dashboard_*` views and their four triggers, and the routing
tables lose all three entries. This is slice 2 of
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md).

**Why:** the same reason slice 1 gives, plus one specific to these rows. Every
member-visible write here had to hold the run's lease, and a routed statement has
no transaction to hold that answer in — so each restated the fence as an
`EXISTS (SELECT 1 FROM harness_runs …)` subquery and then compared `meta.changes`
to tell a lost lease from a no-op. The fence is now read once and the write
follows in the same `transactionSync`.

**The decision worth recording** is that `admitDispatch` writes the *run* row as
well as the two block rows, which belongs to the harness-runs slice by the PRD's
table. It had to: the routed dispatch was a three-statement batch spanning both
slices, and the object executed it atomically only because the router happened to
send it as one batch. Converting the two block statements and leaving the run
statement routed would have turned that into two round trips with a real window
between them, in which a block run exists whose `run_id` foreign key points at
nothing. The PRD anticipates this — it lists `block-dashboard + harness-runs` as
a cross-slice pair, and says such statements "decide method ownership rather than
order".

**The repair rides on traffic, not on a schedule.** `#closeOrphanedBlockRuns`
runs from both write paths that can see an orphan: every reap of the work
stream — whatever the reaped run's origin — and every dispatch admitted to it.
Neither alone is enough, which review established after the first version gated
the reap arm on the reaped run's own origin: a work stream whose later stale
runs happen to be ordinary ones would have kept its orphan forever, and a quiet
one may never have another stale run at all. The dispatch arm answers the quiet
case in the way a member experiences it — a dashboard that is refreshing is a
dashboard that dispatches, so their own next refresh clears the block the last
one stranded. The rejected alternative was a durable retry: an outbox row or a
reconciliation alarm, either of which is real machinery to carry an
inconsistency that slice 6 deletes outright by folding the sweep into the
object.

The reason a repaired block records is the repair's own
(`block_run_orphaned`), not the reaping caller's `stale_run_reaped`. An
orphan's run may have ended any way at all, and stamping it with the cause of
whatever run happened to be reaped alongside it would put a story in front of a
member that nobody established.

**What a future change has to respect:** `recordBlockRunProgress` is
deliberately unfenced and `settleBlockRun` is deliberately fenced. They are two
authorities, not an inconsistency — `BlockDashboardAgent` owns the dispatch and
writes `running` before any executor holds a lease, while the executor's claim on
the *result* must prove it is still the attempt entitled to make one. And
`abandonBlockRun`, like `abandonRunReceipts`, is tied to the exact
`terminalized_at` the reaper stamped rather than to a live lease, because an
expired lease is the reaper's whole premise.
### 2026-08-23 — The router learns `tool_effects`, the name migration 17 left it without

**What changed:** `LOCAL_TABLES` in `workstream-runtime-database.ts` gains
`tool_effects`, so a routed statement naming only that table reaches the owning
`SubstreamAgent` instead of falling through to regional D1.

**Why:** Migration 17 removed `tool_invocations` from the router and moved the
dev seed (`/dev/seed-product`) to write `tool_effects` directly — but the new
name was never added to the list, and a bare `INSERT INTO tool_effects` was
classified regional. Regional D1 has held no product tables since migration
0090, so `pnpm db:open-authority` failed on a fresh local state with
`no such table: tool_effects`, leaving local development unseedable. Nothing
in production hit this: the telemetry readers that touch `tool_effects` also
name `harness_runs` or `workstreams` in the same statement, which already
routed them to the object; the dev seed was the only bare-named writer.

**Consequences:** The cross-authority guard now also rejects a regional
mutation that mentions `tool_effects` in a subquery, which is the correct
refusal — the table is the object's. The rule this pins is broader than one
table: *any object-owned table a routed statement may name needs its entry in
`LOCAL_TABLES`, whether or not today's statements happen to name it alone* —
the telemetry readers route correctly only because they incidentally join
`harness_runs`, and an edit that drops that join re-creates this defect
silently. `runs` and `run_steering` are the precedent: object-native names
with no rewrite, listed for the same reason. The entry is also the missing
half of a decision the in-flight compat-retirement PRD
(`docs/PRDs/2026-08-22_retiring-the-runtime-compat-layer/`) already made —
slice 1i retargeted the seed at the real table and named the seed route as a
remaining user; the entry leaves this list when that PRD's slice 6 converts
the last routed users, not before. The routing test pins the bare INSERT and
each table the dev seed writes.

### 2026-08-23 — The product API learned who a connector principal is

**What changed:** `ProductAuthSchema` accepts an optional
`principal: "connector"`. `runProductRequest` verifies that principal with
`connectorPrincipalAuth` — the session query minus the `sessions` join,
against the one `activeMembership` helper the development socket branch now
shares — and then applies the same role and region equality it applies to a
session principal, refusing as `connector_member_revoked` with a 401 whose
body carries a person-readable message. Session principals still go through
`socketAuth` unchanged, and a session payload on the wire is byte-identical to
before. `WorkstreamObjectClient` forwards the marker only when the auth
carries it, and every socket-ticket issuer refuses a connector principal at
the mint.

**Why:** The object cutover made `socketAuth` the product gate, which silently
broke the one caller whose auth never named a `sessions` row: Slack ingress for
linked members, which synthesizes `slack:{team}:{user}` as a correlation id.
Every linked member's mention died as `session_revoked` from 2026-08-17 until
this change (found 2026-08-22).

**Considered and rejected:** Minting real session rows for connector links (a
link is not a login, and the mirror row would need its own lifecycle to stay
honest), and having the object verify the link itself (`slack_user_links` is
WorkspaceDO state — the auth path would gain a DO-to-DO dependency for a fact
the Worker already verified milliseconds earlier, on the very message being
delivered).

**Consequences:** Only connector ingress may set `principal: "connector"`,
always after verifying the link on the message being delivered — the object's
re-check covers membership only, by design. The auth middleware must keep
building its context exclusively from verified token claims, so the marker can
never arrive from outside (`verifyAccessToken` constructs a fresh literal and
provably drops a forged claim). During a deploy, a new Worker naming the
principal to an old object script is refused as `invalid_product_request`;
Slack ingress classifies that — and `connector_member_revoked`, which is
reachable only as a read-to-recheck race — as retryable, so the skew window
and the race both resolve on the durable retry instead of dropping a message.

Shipped in #256.

### 2026-08-23 — The receipt RPC waits on initialization like its five siblings

**What changed:** `executeToolReceiptOperation` now awaits `this.initialized`
before dispatching, which every other RPC entry point on `SubstreamAgent`
already did.

**Why:** two independent reviews flagged it as the one bare method. The stronger
argument is that the class already documents the invariant it broke — the
comment on `objectStore`, `terminal` and `toolReceipts` says every handler
"waits on `initialized` first" as the reason those fields can be `!`-asserted.
One method not doing so made that sentence false, and the fields it reads are
assigned inside the `blockConcurrencyWhile` callback.

In practice workerd queues external requests behind that callback, so this is
unlikely to have been reachable — but an in-isolate self-call reaches the method
through a stub returned by `durableObjectSelfForId`, and that path does not
necessarily queue the same way. No test asserts the difference, because an
honest one would need `blockConcurrencyWhile` not to queue; the value here is
the restored invariant, not an observable change.

**What a future change has to respect:** nothing inside the boot callback may
reach a receipt operation, or this await deadlocks. It does not today — the
callback constructs stores, waits for readiness, settles identity and releases
dispatch leases, and touches no receipts.

### 2026-08-23 — The receipt wire's argument cap becomes a named bound

**What changed:** `args: z.array(z.unknown()).max(4)` on
`ToolReceiptOperationRequestSchema` is now
`MAX_TOOL_RECEIPT_OPERATION_ARGS = 1`, exported, and carrying the fields
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
requires. A workerd spec drives the refusal through the real endpoint.

**Why:** review flagged the 4 as an arbitrary wire limit that would reject a
future method while TypeScript still compiled. The number was worse than
arbitrary — every method on `WorkstreamToolReceiptStorage` takes exactly one
options object, so 4 was slack around a protocol that is 1, and it was a bare
literal where this repository requires a named constant with a stated `Without
it:` and `Trips:`. Tightening it to the real arity makes the array's shape a
fact rather than caller input.

**What a future change has to respect:** an operation that genuinely needs a
second positional argument changes this constant in the same commit rather than
working around it. The reviewer's underlying point stands — the schema can
reject what the mapped type accepts — and the `Exhaustive` guard plus the
dispatch probe are what make that divergence visible rather than silent.

### 2026-08-23 — The rebind gate stops trusting the caller's summary of the mode

**What changed:** `admit` no longer takes `incomingIsRead`. `#mayRebind` derives
both statements of the incoming call's mode itself, from the `mode` column and
the plan blob the object is already handed, through a shared `planMode` helper
that returns undefined for anything unparseable so every reader fails closed.

**Why:** a review of the split gate pointed out that one of its five conditions
arrived as a boolean the caller computed. The caller derived it from a single
policy and could not have disagreed with itself, so this fixed no live defect —
but it was trust the gate did not need, and the object receives both statements
regardless. A widened rebind is the one failure here that is silent: it clears a
settled read's `output_ref` and re-points the receipt at another call, and
nothing downstream can tell that happened.

**What a future change has to respect:** the check is a conjunction of the two
statements, and the spec covering it drives each half separately — asserting only
the both-disagree case would pass against either half being dropped. Keep the
`planMode` failure mode too: an unreadable plan is not a read.

### 2026-08-23 — Residual receipt settlement becomes an object operation

**What changed:** `WorkstreamToolReceiptStorage` gained `settleResidualReceipts`,
which classifies and closes every receipt a run still has open. Stopped-parent,
expired-root, and expired-child cleanup all reach this one operation; the older
root-only `abandonRunReceipts` duplicate is removed. Its fence is the run's exact
`terminalized_at`, and it is called *after* the terminal write rather than before.
`complete` and `fail` also gained `allowCancellationRequested`, and the
attachment-dependency operations gained an `expectedOutputRef` fence.

**Why:** all three arrived on `main` while this branch was open, written as D1
statements against `tool_invocations` — a compatibility view object schema
migration 17 drops. Rebasing could not keep them and could not drop them, so they
moved into the object, and one of them could not move unchanged. The residual
settlement and the terminal lifecycle row were a single D1 batch fenced on each
other; they are now in different stores with no transaction between them, so the
ordering became a real choice. Terminalize-then-settle is the one whose failure is
recoverable: a settle that does not run leaves a terminal run with open receipts,
which the next marker-backed sweep retries through `settleResidualReceipts`,
whereas settle-then-fail closes the receipts of a run that is still live and may
already have a successor.

The marker backfill runs synchronously before a new harness claim and attempts
at most 25 historical rows in one activation. A row whose exact terminal fence
or marker admission is rejected is warned and skipped rather than throwing out
of run admission; its marker remains absent for a later retry. Stale automation
settlement is limited to `scheduled` and `running`, because `needs_input` may
belong to a newer continuation in the same automation work stream.

**What a future change has to respect:** do not move the settlement back ahead of
the terminal write in the name of atomicity — the atomicity is not available, and
that order corrupts live runs rather than delaying dead ones.
`allowCancellationRequested` relaxes exactly one condition of `#fence` and must
keep the rest: a run may not admit new work after a member stop, but the exact
receipt Bind already returned remains settleable so a known result is not
demoted to residual failure or ambiguity.

### 2026-08-22 — Being added to a work stream tells the person

**What changed:** `addParticipant` now emits three effects rather than one. The
viewer projection it always wrote is still first; behind it come a
`workstream_participant_added` activity event and a new
`participant_notification` regional effect, which lands as a
`workstream_notification_intents` row under `notification_kind =
'participant_added'` and is delivered by the same Slack-then-email pair a
mention uses. Two schemas widened a CHECK to admit the kind — WorkspaceDO
version 9 rebuilds `workstream_notification_intents`, WorkstreamDO version 3
rebuilds its `durable_outbox` — and `enqueueImmutable` now recomputes the
projection dependency for both person notifications rather than only for
mentions. Adding somebody who is already an active participant, or adding
yourself, emits only the viewer effect.

**Why:** being added was the one thing that could happen to a person in Rally
that reached them through no channel at all. The work stream appeared in their
sidebar if their client happened to be open and listening, and nothing was
waiting for them if it was not — no Slack DM, no email, and not even an
`activity_events` row, so the daily digest could not mention it either. That is
what a member reported: a colleague added to a work stream, told by nobody, who
then could not find it.

The notification rides the mention pipeline rather than a second one because
that pipeline already answers the question this needs answered — its
`requiredProjectionVersion` gate holds a notification until the recipient's own
directory row has reached the workspace, so nobody is ever told about a work
stream their sidebar cannot yet show them. Emitting the notification *after* the
viewer effect in the same commit is what arms that gate: the version it depends
on is the one the viewer effect just wrote.

**Considered and rejected:** a fourth notification transport for participation,
which would have needed its own retry, lease, and reconnect handling and would
have drifted from the mention path's on the first Slack authorization failure.
Also rejected: notifying on every add. A repeat add of an active participant is
a no-op, and re-announcing it would re-enqueue an effect the parent has already
acknowledged under the same identity but a newer projection version — which the
parent refuses as a hash conflict and then cannot drain. Somebody is told once
per participation, which is what the participant epoch in the effect's
`sourceId` counts. Also rejected: notifying people named in `participantUserIds`
at creation, which is a different path with a different audience question, left
for its own change.

### 2026-08-22 — Every closed-authority arm is gone, and the routing is unconditional

**What changed:** The 83 `authority.phase === "durable_object_open"` gates
outside `workstream-authority.ts` are down to six. `workstreamExecutionEnvironment`
routes at the object without reading the control row;
`bootstrapWorkstreamRuntimeEnvironment` still reads it, for the generation it
fences the bootstrap with, but no longer branches on the phase. The six that
remain are the maintenance fence itself and are not dual implementations: the
alarm deferral and both socket/message refusals in `workspace-do.ts`, the create
service's recheck, `substream-agent.ts`'s bootstrap fence, and `routes/dev.ts`
refusing a seed against a closed authority.

**Why:** Migration 0090 closed the phase permanently, so every non-open arm has
been unreachable since. Keeping them cost a D1 read on hot paths — the flag
targeting attributes read one per work-stream subject — and, worse, kept the
reading burden the 2026-08-19 removal above set out to end: a reader still had
to establish which half was live.

**Consequences, and the part worth reading before the next one:** removing the
gate in `workstreamExecutionEnvironment` is a no-op in production and was not a
no-op in the test tree. A dozen focused unit environments bound no object and
were, without saying so, exercising the un-routed arm — so their fixtures were
regional rows the routed read cannot see. Each was moved to a work-stream object
store (`test/helpers/durable-authority.ts`'s `testWorkstreamObjectStore` and
`objectStores`), or given a stub that runs the routed statements back through
the same double, so the assertions stayed and only the wiring moved. Two ids had
to become real UUIDs, because routing parses them and a label does not parse.

**Rejected:** Keying the helper on `!env.SUBSTREAM_AGENTS` instead, the way
`refreshWorkspaceSchedule` keys on `!env.WORKSPACE_DOS`. It would have kept every
fixture working and cost nothing to write — and it would have replaced a dead
branch with a live one that silently returns the wrong database whenever a
binding is missing. `refreshWorkspaceSchedule` can afford that because skipping
an alarm refresh is recoverable; reading a work stream's product state from the
wrong authority is not.

### 2026-08-22 — Object schema 17: the tool-receipt views retire

**What changed:** Migration 17 drops `_runtime_tool_invocations` with its
insert, update and delete triggers and `_runtime_tool_checkpoints` with its
insert trigger, and first adopts `attachment_tool_receipts` (with its index) and
`tool_effects_run_call_uq` into this object's own schema.
`WORKSTREAM_OBJECT_SCHEMA_VERSION` → 17. `LOCAL_TABLES` and `TABLE_REWRITES`
lose the three table names and two rewrites, so the routers no longer recognize
`tool_invocations` at all.

**Why:** the five receipt writers and every reader now speak to
`WorkstreamToolReceiptStorage` through a typed port, so nothing named the views.
The adoption is the part that is not bookkeeping: both objects live in
`workstream-runtime-compat-schema.ts` and neither is a compatibility object —
one is a real table of live product data, the other the constraint that dedups a
replayed tool call. A migration that derived its drop set from the file would
have taken both.

**Considered and rejected:** dropping the views without moving migration 14's
transcript settlement out of the update trigger first. That trigger projects a
settled receipt into its same-id tool part, and the stale-run sweep depends on
it because it has no event publisher and never rewrites the transcript row. The
projection moved into `settleResidualReceipts` in the preceding change and has
its own spec; dropping the trigger before that would have left reaped runs
showing a spinning tool card with nothing failing.

**Consequences:** migration 16's trigger repair is now historical — it still has
to exist for objects that applied it before 17 arrived, but the allocation it
fixed lives in the typed `admit`. A routed statement against a normalized table
reports workerd's `rowsWritten` rather than a trigger's counter, and
`rowsWritten` counts index writes: the workerd suite pins that at 2 for a
one-row update of an indexed column, because a caller moving a statement off a
view and keeping an `=== 1` check would be wrong in exactly that way.


### 2026-08-22 — What the compat schema holds that is not compat

**What changed:** Documentation only. `workstream-runtime-compat-schema.ts` is
now recorded as holding two objects that must outlive the layer it is named for:
`attachment_tool_receipts`, a real `STRICT` table carrying live product data,
and `tool_effects_run_call_uq`, the unique index that dedups a replayed tool
call. Neither appears in `workstream-object-schema.ts` today; retiring the compat
views has to move both there first.

**Why:** the file's header comment says its statements "deliberately create no
compatibility data tables", three lines above a `CREATE TABLE`. That sentence is
how someone decides what a drop migration should drop, and following it deletes
live attachment-dependency rows. The index has the same shape of problem one
severity lower: dropping it changes nothing observable at the time and silently
permits two receipts for one `(run_id, tool_call_id)`. The general rule, worth
more than either instance: **derive a drop set from what each object is, never
from the file it lives in.** `_runtime_statement_changes` lives in the same array
and genuinely is compat machinery that goes.

**Considered and rejected:** editing the header comment alone. It is accurate
about most of the array and the failure it invites is not a misreading of the
sentence — it is trusting a file's name to classify its contents. The check has
to live where the drop set is chosen, so the claim is recorded in the retirement
PRD's slice-1 inventory as an explicit *keep* and guarded by two specs in
`workstream-tool-receipt-storage.test.ts`.

**Consequences:** the compat schema is no longer a set that can be dropped
wholesale. Any future migration that retires part of it must enumerate what it
drops and justify each object, rather than deriving the list from the array.

### 2026-08-22 — `tool_position` is a high-water mark, not a row count

**What changed:** Object schema migration 16 rebuilds
`_runtime_tool_invocations_insert` so `tool_effects.tool_position` is allocated
as `COALESCE(MAX(tool_position) + 1, 0)` over the run instead of
`COUNT(*)`.

**Why:** The table's uniqueness is `UNIQUE (run_id, attempt_epoch,
tool_position)`, and a count allocates injectively only while nothing is ever
removed. `attachment-tool-receipts.ts` deletes receipts from two paths, and the
compat delete trigger turns each into a `DELETE FROM tool_effects`. One hole in
a run's positions and the next admission computed a number another row already
held; `INSERT OR IGNORE` dropped it, and `persistToolExecutionPlan` — reading
zero changes as "someone else already wrote my receipt" — looked up
`(harness_run_id, tool_call_id)`, found nothing because its row was never
written, and threw `RunOwnershipLostError`. The run ended on a lease failure
that never happened.

That call key *is* a real constraint: the compat schema creates
`tool_effects_run_call_uq ON tool_effects(run_id, tool_call_id)`, which is what
makes the routed `ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING` mean
what it says once the SQL router strips the clause. It is simply not the
constraint a position collision fires — that admission carries a *new*
`tool_call_id` — so the caller's fallback lookup queries for a row the ignored
insert never created. An earlier draft of this entry said the constraint did not
exist; it does, it is load-bearing for replay dedup, and
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md)
has to carry it into the object's own schema rather than drop it with the views.

**Considered and rejected:** Waiting for the tool-receipt slice of
[the compat-layer retirement](PRDs/2026-08-22_retiring-the-runtime-compat-layer/prd.md),
which deletes this trigger outright and allocates the position in a typed
operation. That slice is several changes away and the defect is live, so the
allocation is repaired in place first and the typed operation inherits it. Also
rejected: scoping the high-water mark to `(run_id, attempt_epoch)`. It would
restart numbering at a new attempt, which is defensible on its own but is a
behavior change this repair has no reason to make.

**Consequences:** Migration 14's precedent — rebuilding a compat trigger in a
later migration rather than editing the frozen v1 source — now has a second
user, and the helper reapplies migration 3's epoch rounding because it derives
its text from v1 and would otherwise reinstate the truncation that fixed.
Positions are no longer dense: a run that has had a receipt deleted has a gap,
which nothing reads and the constraint does not mind.

### 2026-08-22 — Every object in the hierarchy shares one migration base

**What changed:** `MigratableDurableObject` is a new base that
`ScheduledDurableObject` and `BlockDashboardAgent` both extend, so all four
classes reach the migration runner through it. Each declares its schema once in
`migrationPlan()`; `scheduleReady()` is renamed `migrationsReady()` and moves
down to the new base, because it was never about scheduling. Every class gains a
public `forceMigration` RPC.

**Why:** four constructors were each wiring up the same `withMigrationReport`
call around their own runner invocation, with the component key, the class name,
and the migration list repeated at every site. That is tolerable duplication
until something needs to be added to all of them — which is what forcing a
migration is — and then the cost is not writing it four times, it is the fifth
class. A class added later would have compiled, deployed, and been silently
unreachable and unreported. Making both members abstract is what removes that
possibility rather than documenting against it.

**The rename is not cosmetic.** `scheduleReady()` promised "the scheduler is
ready" and delivered "the object's migrations have run" — every implementation
returned the constructor's `initialized` promise. With the migration pass now
living one level down, keeping the old name would have left the schema half of
the base awaiting a method named after the half above it.

**What a future change has to respect:** `migrationPlan()` is read during the
subclass's own constructor, before its fields are assigned, so every
implementation must answer with module constants and nothing else. And the
class list here is one of three that have to agree — the others are
`REPORTING_CLASSES` in the tracker's protocol and the dispatcher map in
`apps/api/src/queues/migration-command-consumer.ts`.

### 2026-08-22 — The object-store migration component takes the agent's name

**What changed:** `WORKSTREAM_OBJECT_SCHEMA_COMPONENT` is `substream_agent_do`
rather than `workstream`. Only the migration runner's component key changed —
the schema, its 15 versions, their hashes, the class, and the object graph's
names are untouched. The runner prefixes its own errors with the key, so this
object's failures now read `substream_agent_do_schema_hash_mismatch:<version>`
and the like.

**Why:** the key is what the migration tracker files this object's reports
under, and it was the only one not derived from the class that reports it,
sitting next to `workstream_do` — a genuinely different object — under a name
that read like its parent. It said `workstream` because the history began under
`WorkstreamRoom` and the class rename was deliberately storage-preserving, which
kept the receipts and left the label behind. The other keys are their class,
snake-cased, with `_do` where the class ends in `DO`; `substream_agent_do` takes
that suffix from its siblings rather than from `SubstreamAgent`, and
`block_dashboard_block_agent` carries a `block` its class does not — derivation
is the rule, not equality.

**Considered and rejected:** renaming the constant along with its value. It
still names *which* schema this module owns, which is what a reader here needs;
the value names the class that applies it, which is what an operator reading the
tracker needs. Also rejected: leaving it, on the grounds that the key is only a
label — it is a label on the one screen that gets read during an incident.

**What a future change has to respect:** the component key is read by
`apps/migration-tracker`, which stores it and keys a per-region head on it.
Changing it again means a registry migration in the same change; the tracker
cannot import this constant, because it must not depend on the Worker it
observes. Nothing in the object itself records the key — `_sql_schema_migrations`
holds a version, a hash, and a build — so no rename here can move a receipt.

### 2026-08-22 — An object addressing its own name reaches itself

**What changed:** Every Durable Object class registers itself with
`lib/durable-object-self.ts` in its constructor — the binding it answers on, a
thunk for its own deterministic name, its id, and the instance — and
`durableObjectStubForWorkspace` and `durableObjectStubForRegionalSingleton`
consult that registration before doing anything else. When the name being
resolved is the caller's own, the resolver returns a stand-in stub over the
object itself, so the same method is called with the same arguments and no
request leaves the isolate. Any other name — a sibling work stream, another
workspace, the same name under a different binding — resolves through the
namespace exactly as before, and so does every name until the object has an
identity to compare against. The registration rides on `env`, which is how it
reaches helpers several layers below the object that never hear about it.

Alongside it, the local SQL executors that `WorkspaceDO` and `SubstreamAgent`
already install are now inherited: `withWorkspaceRuntimeDatabase` and
`withWorkstreamRuntimeDatabase` carry the executor on the environment they
return and reuse it when a later caller derives an execution environment for the
same workspace, work stream, and substream without supplying one. A different
work stream or workspace never borrows it.

**Why:** An audit of every stub resolution in `apps/api/src` found twelve paths
that left an object and came straight back into it, in two classes. None was
written as a self-call. Each was a shared helper that addresses an object by
role — `publishWorkstreamEvent`, `launchWorkstreamHarness`, the flag-targeting
attribute loader, `refreshAgentTimerAlarm`, `refreshWorkspaceSchedule`, digest
settlement — which is correct for the Worker, queue consumer, or Workflow that
is almost always calling it, and became a self-call as the objects grew inward:
a work stream's whole agent loop now runs inside its `SubstreamAgent`, and a
workspace's schedule inside its `WorkspaceDO`. The cost was a namespace lookup, a
placement-affinity read, and a round trip to reach storage the caller was already
holding, plus a second concurrent invocation of a single-threaded object, a
statement that could not join the caller's `transactionSync`, and local invariant
violations arriving as foreign-object errors. The report is
[`durable-object-self-rpc-audit-2026-08-22.md`](durable-object-self-rpc-audit-2026-08-22.md).

**How it is proved:** the routing decision in the Node suite, and the four
registrations and name derivations against real objects in
`test-workers/durable-object-self-registration.test.ts` — including that the
collaborators an object builds and keeps hold a registered environment, which is
the case the first draft of this change failed.

**Considered and rejected:** *Threading a local port per method*, as the Terminal
port and the two SQL executors already do. That is the right shape for a hot path
and stays, but there were fourteen distinct methods across thirteen service
modules reachable as self-calls, and the next method added would silently
reintroduce the defect — the previous two rounds of this fix each closed one path
and left the rest. *Refusing a self-call outright*, which the audit floated as
the loud option: it would turn working production paths into errors for a
condition the resolver can simply answer correctly, and the objects would still
need a local route for every one of them. *Leaving it*, on the argument that an
open input gate means these complete: they do complete, and the only thing
holding that up is that no self-call currently sits inside a
`blockConcurrencyWhile` — an invariant nothing stated or tested, and the same
shape as the alarm-joins-drain fault in
[`terminal-production-qa-2026-08-21.md`](terminal-production-qa-2026-08-21.md).

**What a future change has to respect:** A new Durable Object class registers
itself in its constructor, or it is exempt from this without anyone noticing. The
name thunk must return `null` until the object's identity is durably its own —
a name derived too early is a name for a different object. The registration is
compared by binding *identity* and name equality, so a helper resolving a name
that is not the caller's own must keep reaching the namespace: that is what makes
a sibling call still a real hop. And the registration line rebinds the
constructor's `env` parameter as well as assigning the field, so that nothing
below it can hand the unregistered environment to a collaborator that keeps it:
`SubstreamAgent` built `WorkstreamObjectProductService` with the raw parameter in
the first draft of this change, which left that service — and the model routing
it resolves for its own work stream — still going out through the namespace.

### 2026-08-22 — Object-local visibility comes back; only the D1 read stays gone

**What changed:** `broadcastMetadata` and `broadcastBlockDashboardEvent` close a
socket whose `canRead` has gone false, and `SubstreamAgent` closes readers its
own `product.canRead` no longer admits when an event narrows visibility. All
three read this object's own SQL. The `workspace_members` query removed from
these paths in the entry below stays removed. `SubstreamAgent` also stops
exempting a socket whose attachment carries no `sessionId`, and
`BlockDashboardAgent` stops writing the now-unread `authorizedAt`.

**Why:** The entry below removed two different things as if they were one. The
D1 read was right to go: it asked whether somebody is still a workspace member,
which this object cannot answer and the revocation queue now answers properly,
and it cost a round trip on a publish path — the same round trip that produced
the waterline ordering bug. The `canRead` filter was not that. Work-stream scope
and participation live in this object's SQL; no queue message carries them,
because they are not D1 facts. Deleting the filter did not make that retraction
late, it stopped applying it: a reader excluded by a scope change went on
receiving the live transcript, title, description and preview until the window
closed. Review caught it; the previous entry's framing ("takes effect on the
next reconnect") described a delay that was really an absence.

The `sessionId` gap is narrower and sharper: this schema alone makes the field
optional, so `undefined !== "<id>"` skipped exactly the transcript socket on
every logout and expiry.

**Considered and rejected:** Publishing work-stream visibility onto the
revocation queue so there is literally one mechanism. It puts a queue round trip
between a scope change and the reader it excludes, and turns one object's private
SQL into a message contract. The honest model is two questions with two owners,
which is now stated in the invariants.

**Consequences:** The invariant is narrower than "no object re-checks before
publishing" — it is **no D1 read on a publish path**. A future change that
deletes these `canRead` calls on the strength of the queue existing will restore
the regression this entry fixes. A test in
`test/workstream-room-authorization.test.ts` and one on real workerd now pin the
behaviour rather than its absence.

Shipped in #229.

### 2026-08-22 — A queue closes revoked sockets; every object-side sweep is gone

**What changed:** All four socket roles gained `revokeSocketAccess`, called by the
access-revocation queue consumer, and lost every mechanism that re-checked
authorization on an already-open socket. Removed: WorkspaceDO's
revalidate-before-publish sweep with its 30-second interval, single-flight, and
serialized publication queue, together with `workspace-socket-authorization.ts`;
SubstreamAgent's reader eviction on the same interval and its `retractsReadAccess`
topic list; BlockDashboardAgent's 60-second attachment re-authorization;
WorkstreamDO's per-broadcast `workspace_members` reads and its visibility-driven
child sweeps. The block-lifecycle sweep at the configuration-change site stays —
a block leaving the dashboard is this object's own fact, not a D1 one. This
entry overturns [2026-08-21 — WorkspaceDO sweeps the sockets it publishes
to](#2026-08-21--workspacedo-sweeps-the-sockets-it-publishes-to).

**Why:** Every one of those mechanisms was an object trying to discover on its
own something only D1 knew, and each one discovered it late — up to a minute — at
the cost of a D1 read on a publish path. The sweep also caused the ordering bug
its own entry records: an `await` between waterline allocation and send let a
concurrent publication overtake, and the desktop's `waterline <= lastWaterline`
guard dropped the parked invalidation silently. Fixing that needed a publication
queue *inside* the object, which is a lot of machinery in service of asking a
question at the wrong time. The retraction is known exactly once, in the request
that writes it; publishing it there reaches a socket in about a second instead of
thirty, and costs no read at all when nothing has been revoked.

**Considered and rejected:**

- *Keeping the sweep and tightening the interval.* Faster polling multiplies the
  D1 cost of the thing that was already the expensive part, and does nothing
  about the ordering hazard.
- *Each object publishing its own descendants to the queue.* It couples all four
  objects to a queue binding and a message schema for no gain over returning a
  list. They answer with what only they know — a directory, a substream list, a
  block configuration — and the consumer decides what carries it.
- *One RPC chain from the workspace down.* A single invocation would hold the
  whole hierarchy open and one unreachable object would restart the walk.

**Consequences:**

- **A publish path may trust an open socket, and must not re-check.** Putting a
  membership query back in front of a broadcast reintroduces both the cost and
  the ordering hazard. `publishSync` now allocates and sends with no `await`
  between the two, and that has to stay true.
- **Two retractions no longer reach an open socket**: losing participation or
  visibility on a single work stream, and a block's visibility narrowing. Both
  are object-local facts that the D1-fed queue cannot see, so they take effect on
  the next reconnect. Restoring them means giving WorkstreamDO a producer of its
  own.
- **A new socket role owes a `revokeSocketAccess`**, and its parent owes it a
  place in the list it returns, or the new role's sockets survive every
  revocation.
- The reasoning for the removed mechanisms is preserved in the entry below; this
  is a reversal of it, not a correction of the record.

Shipped in #229. Owned by [`access-revocation.md`](access-revocation.md).

### 2026-08-22 — The sidebar push takes the sweep every publisher takes

**What changed:** `publishSidebarList` awaits `revalidateBeforePublish(false)`
before sending, which made `runWorkspaceSql` and both of its callers async.

**Why:** This object has three publish paths and this was the only one sending
without the authorization sweep. It carries a viewer's whole automation or note
list — the same class of product data `publishWorkstreamState` sweeps for — to
sockets that have said nothing since they connected, so a session revoked
without a membership retraction to publish kept receiving those rows on every
write until an unrelated publication swept. The interval-gated form, not the
certain one: a write to `notes` is not a retraction this path can judge.

**Considered and rejected:** Keeping the push synchronous and sweeping on a
timer of its own, which is a second answer to a question `revalidateBeforePublish`
already answers, and would let the two intervals disagree about who is still
allowed to listen. A future publisher added here has to join that sweep too;
the bound is on the object, not on any one path.

### 2026-08-22 — Agent-owned Terminal calls no longer self-RPC

**What changed:** The main `SubstreamAgent` exposes its resident Bind execution
to the Terminal stack through an in-object Terminal port and resource-link
attacher. The Terminal port dispatches into the same identity-fenced
`runTerminalOperation` used by `/internal/terminal`, so transaction rollback,
directory outbox publication, stable failures, and alarm scheduling remain
identical while the executing alarm stays the sole request context. Generated
resource publication and repository backup dispatch into the same
`WorkstreamObjectProductService.attachRuntimeResource` body used by the resource
RPC. Repository helpers receive both resident boundaries rather than quietly
constructing new remote ones.
The factory forwards its caller-supplied workspace/work-stream identity, and
both direct mutation bodies independently fence on external substream ID `0`.
Terminal plugin construction rejects a partial resident boundary rather than
falling one of the two paths back to same-object RPC.

**Why:** Post-deploy verification of #224 proved the active alarm was the
original drain owner for the whole 25-second failed run. It never encountered
the inverse heartbeat ordering covered by the earlier fix. The trace instead
showed repeated same-object Terminal RPC events during the successful first
command, followed by a second tool failing before its executor log. The
resident loop already had an in-object runtime-SQL executor for this reason;
Terminal authority was the remaining self-call path.

**Considered and rejected:** Treating self-RPC as harmless because Durable
Objects serialize storage, or bypassing `commitRuntimeMutation` with direct
storage calls. Serialization does not make promises and I/O portable between
events, while a raw call would strand directory deadlines and blur the
pre-/post-commit retry contract.

**Consequences:** Worker-originated and non-main-substream calls still cross the
RPC boundary to the main child, but a run executing inside that authority never
leaves and re-enters it for Terminal state or generated-resource links. The
operation authority stays single-writer without transferring later D1/provider
work between Durable Object events, and an accidental local port on another
child fails closed instead of creating split product state.

### 2026-08-21 — Heartbeats never join a live run's request context

**What changed:** Both agent objects defer an alarm drain request when their
in-isolate `DurableAgentDrain` is already active, leaving the existing event to
finish a healthy run. They arm the next heartbeat at least 30 seconds out rather
than rescheduling against the already-due row. If the promise makes no progress
for five minutes and its durable harness attempt lease is no longer live, an
identity-fenced successor replaces it without waiting for isolate eviction.
Workstream
schema 14 also projects terminal tool-receipt updates into the visible same-id
part and repairs receipt-only settlements produced before the new trigger. The
runtime-SQL port now separates transaction failure from alarm failure after
commit, and records each under a content-free structured event. Compatibility-
view mutations return their explicit semantic change counter rather than
workerd's count of every internal trigger row.

**Why:** Production multi-step Terminal runs failed only after a long first
operation, and one write remained active until lease reaping. A real-workerd
regression showed the heartbeat alarm was joining the active drain promise
created by the run's other request. The alarm then lived for the rest of that
loop and could make subsequent I/O cross request contexts. Reaping correctly
settled the authoritative receipt, but its generic runtime path had no live
publisher to rewrite the participant-facing part.

**Considered and rejected:** Letting every alarm await the existing single-
flight promise, returning forever while a stranded promise stays active,
rescheduling from the already-due dispatch row, suppressing the heartbeat alarm
while a volatile flag is set, and repairing only the desktop projection. Those
respectively recreate the request-context join, permanently stall a living
isolate, busy-loop its alarm, make scheduling depend on in-memory state, or
leave API and reconnect readers inconsistent.

**Consequences:** An alarm invocation never adopts work already owned by a
different live event, but can replace an owner only after durable liveness has
expired. Recovery remains row-derived and survives eviction, while a
receipt terminalized by recovery converges the transcript in the same SQLite
transaction. Real-workerd tests pin the non-joining heartbeat and Node/runtime
tests pin both the v13-to-v14 repair and ordinary receipt semantics.

### 2026-08-21 — The sidebar rides on the subscribe answer

**What changed:** `subscribe` builds the whole sidebar for that viewer — the
first directory page, the automations, the notes — and attaches it to the
`workspace_sync` event it already sends. The `list_sidebar` message it replaces
is gone. A resume with no topics to report still answers, under a new `resume`
reason, so the payload reaches a socket that was away.

**Why:** The object holds the socket and the rows; the ticket already proved who
connected. Waiting to be asked spends a round trip establishing something the
object had already determined, and it is what
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) asks a connect
exchange not to do.

**Considered and rejected:** Sending the sidebar as its own frame beside the
sync event — one more frame per subscribe, and nothing to attach it to on a
quiet resume; and taking `includeSystem` from the client so the payload could
serve debug viewers too, which puts a preference this object does not hold into
every connect for a case that is rare and internal.

**Consequences:** Every subscribe now performs three reads before it answers,
where before it read a bounded replay log. Reconnect storms therefore cost this
object more than they used to, bounded by 250 rows per list and by the reads
being local and synchronous. The payload is per viewer, so it cannot be built
once and broadcast; a future surface wanting a connect payload of its own should
expect the same shape of cost.

### 2026-08-21 — A write to an automation or note pushes its list

**What changed:** `runWorkspaceSql` — the entry point behind both the
`executeRuntimeSql` RPC method and the in-object `localWorkspaceEnv` the alarm
uses — now notes which sidebar list a statement writes — by the same write-target match the alarm refresh already uses — and
re-sends that list whole to every subscribed socket, read per viewer the way
`publishWorkstreamState` reads its row.

**Why:** These tables had no push at all; the desktop learned about a change
from a topic the Worker derived from the mutating REST request. Writers with no
request were therefore invisible, and the workspace alarm advancing
`next_run_at` after a run is one — it reaches the same tables through the
workspace runtime database like every other writer, which is what makes one
check here cover all of them. The check sits below the RPC method rather than
in it because the alarm runs inside this object and takes `localWorkspaceEnv`
straight to the SQL executor: guarding only the RPC entry point would have left
the writer that motivated the push silent again.

**Considered and rejected:** Emitting from each service that writes these
tables, which spreads the obligation across many call sites and misses the
alarm's own writes entirely; and pushing only the changed rows, which
would need this layer to understand the statement rather than just its target.

**Consequences:** This object now sends product data on a write path that
previously only returned rows, so a slow or large list read is felt by the
writer. Both lists are bounded at 250 and the reads are local and synchronous,
which is what keeps that acceptable. A future table whose rows appear in the
sidebar must be added to `SIDEBAR_LIST_SOURCE_TABLES` or its writes will be
silently invisible to open clients.

Schema v4 adds `workspace_sidebar_list_state`, one waterline per list, advanced
by `executeWorkspaceRuntimeSql` inside the same transaction as the write that
earns it. Inside, not after: a counter that can lag its own write would let the
next push carry a version the client has already applied, and the change would
be dropped as a duplicate. The counters are seeded at zero by the migration so
no reader has to decide what an absent row means.

### 2026-08-21 — The sidebar's three lists are read together in one object

**What changed:** WorkspaceDO answers a new `list_sidebar` socket command with
the directory page, the viewer's automations and the viewer's notes, read from
its own SQLite with no `await` between them. The statement and row mapping for
each list are shared with the REST services rather than written a second time.

**Why:** `automation_subscriptions` and `notes` have been this object's tables
since the authority cutover, but the sidebar still reached them through the
Worker's REST routes, which route back into this object over RPC. The reads
already belonged here; only the transport did not.

**Considered and rejected:** Duplicating each SELECT inside the object, which
puts two copies of one query behind one client cache with no response schema to
catch the drift; and reconciling automation email routes inside the batch, which
would put a Global-registry network call on the socket handler's single thread
alongside the directory read.

**Consequences:** This handler is now the object's widest synchronous read, and
a list added to the sidebar later should join it rather than open a transport.
Anything in it that cannot be answered from local SQL — the email-route
reconciliation is the first such case — stays on the REST path and converges
through the topic that owns it.

### 2026-08-21 — WorkspaceDO sweeps the sockets it publishes to

**What changed:** Both WorkspaceDO publish paths now revalidate the connected
set before sending and close the sockets that no longer pass — immediately when
the payload names a topic that can retract access, otherwise at most once per 30
seconds. A session revoked at sign-out, a session that expired, or a membership
going inactive now ends the socket rather than being invisible to it.

**Why:** `sessionAuth` ran on the upgrade and on each inbound command, so a
window that only listened was authorized as of the last thing it said — and this
object's whole design asks windows to sit and listen. A person whose session was
revoked kept receiving workspace metadata and work-stream rows, including titles,
previews and unread counts, until they closed the window. The desktop already had
the other half of this: `workspace-socket.tsx` treats a `1008` close as final,
stops retrying, and rejects pending commands with `workspace_access_revoked`. It
had simply never been sent one. `architecture.md` also already described an
explicit retraction sweep and bounded revalidation for *all four* socket roles;
it was true of three.

**Considered and rejected:** Authorizing on every push, which is where this
started. For the sync path it would be one D1 query per payload, and the same
rule applied to a transcript feed would put a query on every token frame —
`SubstreamAgent` skips its own revalidation for `stream_delta` precisely to
avoid that. Bounding the staleness instead keeps the hot path clear and makes
the cost proportional to publication rather than to traffic. Also rejected:
asking `sessionAuth` once per socket, which is N queries per sweep where one
batched query answers the whole connected set.

**Consequences:** Sync publication is serialized, and has to stay that way. The
sweep introduced an await between the waterline allocation and the send, which
let a concurrent publication overtake a parked one and take its invalidation
down with it. The obvious repair — moving the sweep ahead of the allocation so
nothing awaits between allocation and send — was tried and abandoned: it makes
workerd die with `kj/async.c++: Promise callback destroyed itself` partway
through the runtime suite, reproducibly, while the queue is stable over repeated
runs. A future change that wants to remove the queue has to answer that crash
first. A push may trust an open socket, and that is now a rule the
next socket-bearing object inherits rather than a property of this one — closing
on retraction is the mechanism, not a per-frame check. Anything that retracts
access needs a topic in `ACCESS_RETRACTING_TOPICS` to be enforced promptly;
without one it waits out the interval, which is the accepted bound and the
reason the interval is short. The batch size of 48 exists because D1 permits 100
bound parameters per statement and the fixed predicate takes four. The
development bypass in `sessionAuth` admits a socket with no session row, so the
sweep carries a matching membership-only branch; a change to either has to move
both or local windows close on the first publication. The unit a sweep decides
about is a session *and* a user, because that bypass gives every user the same
session id — a future authorization path that introduces another shared
credential inherits the same requirement. Sweeps coalesce, so a caller may
assume publishing does not multiply the query, but a *certain* caller never
joins an uncertain sweep: an uncertain sweep leaves everyone connected when its
query fails, which is the wrong answer for a retraction.

Shipped in #220.

### 2026-08-21 — Every scheduling object shares one alarm list, and the workspace's schedule comes home

**What changed:** WorkspaceDO, WorkstreamDO, and SubstreamAgent now extend
`ScheduledDurableObject` and each carry `_internal_durable_alarms` (schema
versions 4, 2, and 15). WorkspaceDO gained `refreshSchedule` and the whole due-
work loop the `WorkspaceScheduler` object used to run — schedules, resource
watches, maintenance passes, Terminal deadlines — with its execution code in
`services/workspace-schedule-execution.ts`. SubstreamAgent's agent timers became
one entry per pending wake-up instead of a derived `MIN(due_at)`. The scheduler
object was deleted outright — binding, class, and Wrangler tag `v4` — and a
one-shot `schedule_bootstrap` entry, carried as WorkspaceDO migration 5 rather
than an amendment to the released version 4, reconciles each carried-over
workspace once instead.
[`durable-object-alarms.md`](durable-object-alarms.md) is the new module
document and holds the full reasoning, including what deleting the class costs.

**Why:** The scheduler held an alarm for tables it did not own. Every tick cost
routed SQL back into WorkspaceDO plus an RPC to its directory, and every writer
of a due time had to remember to poke a *different* object or watch its row go
dark — a coupling that showed up again in every feature that added a schedule.
Meanwhile the three objects had each grown their own arming code and the copies
had drifted: two of them only ever moved an alarm earlier, so a cancelled row
left the object waking for nothing and a deferred target could leave the alarm
pointing at an instant nothing was behind.

What a future change has to respect: an object's alarm is derived in exactly one
place. Adding a wake reason means adding an entry or a derived source, never a
`setAlarm` call — a second writer produces two answers to "what is earliest",
and the loser is silently never run.

### 2026-08-21 — Terminal addresses its own tables through a typed port

**What changed:** The Terminal services no longer hold a `D1Database`. A new
`WorkstreamTerminalStorage` inside the SubstreamAgent is the only reader and
writer of `terminal_workspace`, `terminal_tasks`,
`terminal_imported_resources`, `terminal_repository`,
`terminal_publication_grants`, and `repository_publications`; the services
reach it through `/internal/terminal` and a typed `TerminalObjectPort` whose
operation list is derived from the storage class. WorkstreamDO schema
migration 12 promotes the nine fields that lived in `lifecycle_json` to real
columns and drops the 32 `_runtime_terminal_*` compatibility view and trigger
statements. The dead pre-cutover branches in `workspace-scheduler.ts` and
`connection-service.ts` — which queried tables migration `0090` dropped — go
with them.

**Why:** The vocabulary the code used stopped describing what it did. A
statement reading `UPDATE workstream_sandboxes` named a table that had not
existed in D1 since the legacy product schema was retired; it was rewritten
onto a compatibility view whose INSTEAD OF triggers converted ISO-8601 to unix
milliseconds and packed nine fields into a JSON blob. That layer existed so one
body of code could run against both D1 and the object during the cutover, and
the cutover is over. Its remaining cost was real: `archive_due_at` — a deadline
the workspace scheduler sorts alarms by — had no type, no CHECK, and no index,
because it was a JSON key. Worse, a load-then-claim sequence crossed the Worker
boundary between its two statements, so the operation lease could be decided on
state that had already moved; the same sequence now runs inside one
synchronous object call.

**Considered and rejected:** Keeping the SQL and renaming only the handle. That
removes the misleading signature and nothing else — the blob, the timestamp
conversion, and the split transactions all survive. Also rejected: converting
the whole runtime compatibility vocabulary at once. `tool_invocations`,
`harness_runs`, `resources`, and `notes` are shared by every subsystem, so
retiring them is a change per subsystem rather than a wider version of this
one; `runtime.ts` still reaches `tool_invocations` through the routed handle
and says so.

**Consequences:** Two invariants the blob could not express are now enforced by
the table: a lease or a claim without its deadline is rejected, because an
unreleasable lease holds the workspace forever. `authority_epoch` is gone — the
compatibility triggers set it equal to `version` on every write and nothing
read it back. Terminal state is now reachable only with the agent binding, so
three helpers in `repository.ts` that took `Pick<Env, "DB">` take a full `Env`.
The Node suite keeps its real-SQL coverage through a local-storage seam on the
port; what the runtime decides belongs in `test-workers/`.

### 2026-08-21 — Two workspace tables retired with no reader or writer

**What changed:** WorkspaceDO schema migration 3 drops
`external_delivery_attempts` and `slack_agent_channel_allowlist`, and both
names leave `WORKSPACE_LOCAL_TABLES` so no statement routes to a table that is
gone.

**Why:** `external_delivery_attempts` declared a unified outbound pipeline —
idempotency key, lease, attempt count, five states — covering automation,
digest, mention, and note-privacy sends. Nothing ever wrote it; real delivery
runs through `workstream_notification_intents` and the per-channel services.
`slack_agent_channel_allowlist` was superseded before first use by
`slack_agent_policies.public_channel_mode` and `private_channel_mode`. An empty
table beside a working one is not neutral: it reads as a second authority and
invites the next change to extend the side that has never run.

**Considered and rejected:** Pruning `external_delivery_attempts` from
`WORKSPACE_FENCED_TABLES` as well. That list feeds version 1's identity-fence
triggers, so editing it changes v1's implementation hash and strands every
deployed object on a hash mismatch. The table's drop takes its fences and index
with it; the list keeps the name because version 1 is frozen, not because the
table still exists.

**Consequences:** Reviving either name means writing a fresh migration whose
entry says why the current path is not enough — a unified delivery pipeline now
has to argue against `workstream_notification_intents`, and channel admission
against the policy modes.

### 2026-08-21 — Retire four object tables that no code reads or writes

**What changed:** Schema migration 11 drops `terminal_commands`,
`compaction_jobs`, `_data_migrations`, and `_migration_command_receipts` from
the SubstreamAgent database. The v1 statements still create them — they are
hashed into every deployed object's `_sql_schema_migrations` receipt and cannot
be edited — so a new object now creates and drops them inside one bootstrap
transaction.

**Why:** Each survived the work it was built for. `terminal_commands` was
provisioned for per-command receipts during the D1 retirement, but the Terminal
runtime settles commands through `terminal_tasks`, which already carries the
command hash, deadline, exit, termination reason, byte counts, and head/tail.
`compaction_jobs` modelled compaction as a claimable job row before the agent
settled on the `active_agent_compaction` singleton plus immutable
`compaction_checkpoints`. The two `_`-prefixed tables are bookkeeping for the
one-time authority cutover campaign whose driver was deleted in "Retire the
authority cutover campaign machinery" — the tables outlived it. An empty table
with plausible columns is worse than no table: it invites a future writer to
adopt a shape nothing has ever exercised, and it makes the schema read as
though a second compaction or command authority exists.

**Considered and rejected:** Deleting the `CREATE TABLE` statements from v1.
That changes v1's implementation hash, and `applyDurableObjectSqliteMigrations`
throws `workstream_schema_hash_mismatch:1` on any object whose receipt records
the original — which is every deployed object. Append-only history is the
constraint; the redundant create-then-drop is its price. Also rejected:
dropping `content_refs` in the same migration. It has no reader either, but
`parts.content_ref_id` carries a foreign key, two CHECK constraints, and a
partial index pointing at it, so retiring it means rebuilding the transcript's
hottest table under a maintenance window. That is its own change.

**Consequences:** `terminal_commands` and `compaction_jobs` never had a writer
in this repository's history, so their drop cannot lose a row. The two
`_`-prefixed tables did, and a deployed object may still hold the completed
campaign's receipts; the drop discards them deliberately, because the campaign
finished, its D1 source tables were retired in migration `0090`, and nothing
can replay from them. A future migration must not reuse these four names for a
different shape — a re-`CREATE` under an old name would land beside the drop in
version order and read as a revival. Anything that genuinely needs per-command
receipts or a claimable compaction job should model it fresh, and say in its
own entry why `terminal_tasks` or `compaction_checkpoints` is not enough.

### 2026-08-21 — Stopped runs remain stopped through every projection

**What changed:** The shared harness-status contract now carries `stopped`, and
the WorkstreamDO, WorkspaceDO directory, desktop, Slack task list, and Slack
unfurl projections map the authoritative `cancelled` root state to it. Terminal
checkpoint cleanup also recognizes the status. The desktop labels it “Latest
run stopped” while retaining the detailed retry card.

**Why:** Post-cutover runtime storage correctly recorded a user stop as
`cancelled`, but the public projection fell through to `idle`; the desktop then
normalized `idle` to `completed`. A real Electron run consequently showed “Run
stopped” and “Latest run completed” at the same time.

**Considered and rejected:** Relabeling every completed/idle work stream as
merely “not running” would avoid the contradiction but discard useful outcome
state. Treating a stop as failure would incorrectly imply a fault and route it
to intervention UI.

**Consequences:** Consumers must treat `stopped` as terminal and non-running.
Any new work-stream status surface must preserve it rather than collapsing it
into `idle`, `completed`, or `failed`.

### 2026-08-20 — Same-row tool settlement outranks client-id replay deduplication

**What changed:** Object schema v11 rebuilds `_runtime_messages_insert` so a
`client_message_id` conflict updates the row only when it is the same tool id.
A fresh id under the same client id remains an ignored replay, while the stable
tool row can now advance from `started` to `completed`, `failed`, or
`ambiguous`. The migration also repairs already-stranded transcript rows from
their same-id terminal `tool_effects` receipt, including settlement time,
member-safe output/error, and terminal status. Because the status-specific
activity prose is not reconstructible in SQL, repaired rows clear the stale
started-tense label and use the renderer's neutral tool-name fallback.

**Why:** The v5 replay repair put `ON CONFLICT(client_message_id) DO NOTHING`
before its existing `ON CONFLICT(id) DO UPDATE`. A tool's start and terminal
writes intentionally share both identifiers, so SQLite selected the first arm
and discarded every terminal write. The tool executed successfully and its
answer reached the transcript, but every released UI continued to show it as
started.

**Considered and rejected:** Giving terminal writes a new client id would turn
one invocation into two transcript rows and weaken replay identity. Moving the
id arm first would let a different id under the same client id fall through to
the table constraint instead of preserving the v5 replay guarantee.

**Consequences:** Conflict-arm order is part of the compatibility contract. The
first arm must distinguish same-row lifecycle updates from different-row
replays, and historical migration v5 remains unchanged; deployed objects
receive the repair only through append-only v11. The terminal effect receipt is
the only accepted backfill authority; a started part without one remains
started rather than being guessed complete from the surrounding run. Historical
repair must not leave status-derived presentation fields claiming that a
terminal invocation is still active.

### 2026-08-20 — Transcript order is separated from unread attention

**What changed:** Product message projection now carries nullable
`attentionSequenceNumber` directly from `parts.attention_ordinal`. Desktop
visibility, initial unread anchoring, and socket advancement ignore tool and
transient rows and advance only that ordinal. A real-workerd test projects a
human/tool/agent sequence as `1/null/2`.

**Why:** After the Durable Object cutover, the desktop used transcript sequence
as an attention ordinal. Tool rows consume transcript positions but no
attention positions, so a tool-heavy turn sent an impossible read waterline and
received HTTP 422.

**Considered and rejected:** Clamping the invalid PATCH, assigning attention to
tool rows, and deriving attention from author type on the client. Each hides or
duplicates the authoritative object counter instead of transmitting it.

**Consequences:** Mixed-version responses may omit the optional field and must
not advance attention. New people-visible part types must decide explicitly
whether they receive an attention ordinal, while transcript pagination remains
ordered exclusively by `sequence_number`.

### 2026-08-20 — Regional product shells and viewer code are removed

**What changed:** Migration 0090 removes every D1 product table and reduces the
regional `workstreams` row to its three-column identity anchor. The D1 list,
pin, viewer mapper, and unused shared-package getter paths are deleted;
WorkspaceDO now answers listing,
pinning, and socket visibility, with real workerd coverage for per-user order
and personal system-work-stream filtering.

**Why:** A creator read-state insert still reached D1 after the object-side
create committed and was aborted by the 0079 authority fence. Empty source
tables also made other misrouted reads look valid. Once import and scrub are
complete, absence is the only unambiguous product-schema fence.

**Considered and rejected:** Relaxing the read-state trigger alone or retaining
the tables as tombstones. Both preserve a second schema and leave future
misroutes capable of returning stale or empty product data.

**Consequences:** Product compatibility SQL remains live only behind the
Durable Object runtime ports. Focused Node fixtures pin that frozen through-0089
dialect explicitly; current topology and ownership assertions run against the
final D1 schema and real Durable Object SQLite. The deploy workflow treats 0090
as Worker-first only when it is the sole pending migration, and 0090 itself
refuses a populated region whose authority is not open. The replacement Worker's
regional anchor insert supports both table shapes so either a failed deploy or a
failed migration leaves a serving configuration without moving a later
migration behind its Worker.

### 2026-08-20 — The room opens custom spans for the work a person waits on

**What changed:** `SubstreamAgent` opens named spans for the product operations
on a person's critical path — `initialize`, `create_message`, `get`, and
`messages` — and for socket acceptance, the subscription, and snapshot assembly.
`WorkspaceDO` does the same for the `create_message` command. They are custom
spans on Cloudflare's automatic tracing, so they are already children of the
caller's span: a Durable Object call is a traced binding call, and everything
inside it runs in the caller's async context. `handleProductRequest` takes a
`traced` flag and nothing else — no trace id, no header.
[`performance-tracing.md`](performance-tracing.md) owns the span names.

**Why:** A slow work stream was indistinguishable from a slow room. The object's
side of a create is a `product.initialize`, a run dispatch, a transcript read,
and a broadcast, and none of them were timed; a subscription that spends two
seconds assembling a snapshot was invisible entirely, because it arrives on an
invocation with no request behind it.

**Considered and rejected:** *Propagating a trace id into the object ourselves*,
either as a field on `ProductRequestSchema` or as headers on the request
`rpcRequest` synthesizes. Both were built and removed. The runtime already
propagates context across a Durable Object call, so a hand-made id produced a
second trace that never joined the first — and the schema field had the extra
defect of being carried by the native-RPC door and not by `POST
/internal/product`. *Holding a trace across the socket upgrade and the
`subscribe` that follows.* Those are separate invocations and an isolate
eviction between them is normal, so anything held in memory would be dropped
silently on exactly the hibernation path most worth measuring. They are two
traces joined by an `rally.socket.connection_id` attribute instead.

**Consequences:** An operation outside the three traced flows opens no spans, so
tracing a fourth means naming its flow rather than reusing one. The upgrade and
the subscription only meet through `rally.socket.connection_id`, so anything
that changes what a socket attachment carries must keep it. Span timing measures
I/O and not CPU under workerd's pinned clock, so a future change that puts real
computation inside the room will not show up in these numbers. Importing
`cloudflare:workers` for `tracing` means a Node test of anything on these paths
depends on the alias in `apps/api/test/helpers/cloudflare-workers.ts`.

Shipped in #203.

### 2026-08-20 — Object schema v6–v9: the parity gaps the ported test suite surfaced

**What changed:** Rebasing the API test harness onto the real object schema
(instead of a D1-shaped emulation) surfaced five ways the object's runtime
port diverged from the D1 semantics the harness code was written against; all
five are fixed here.

- **v6 — description-refresh keep ratchet.** A claim omits
  `consecutive_keeps`, but the object's insert trigger coalesced that absence
  to zero and overwrote the standing count in its conflict arm. The rebuilt
  trigger preserves the count for claims while still accepting the settle
  path's explicit value, restoring the D1 contract and making the 24/48-hour
  rest tiers reachable.
- **v7 — `runs_parent_tool_call_uq`.** D1's `harness_runs_parent_tool_call_idx`
  never made it into the object, and the inline-child admission depends on it:
  its INSERT ends in `ON CONFLICT DO NOTHING`, and the zero-change result is
  what routes a replayed admission to the branch that reuses the existing
  child and its settled result. Without it a retried admission inserted a
  duplicate child. The migration cannot delete existing duplicates
  (`tool_effects`, `elicitation_requests`, and parts provenance reference
  `runs` without cascade), so non-newest duplicates get their
  `parent_tool_call_id` suffixed with `:superseded:<run_id>` — still shaped
  like an inline child, so the parent-loss reaper retires them — and the
  index then binds one live child per parent tool call, terminal rows
  included, because result replay needs to find the completed child.
- **v8 — replan columns in `_runtime_tool_invocations_update`.** The v1
  trigger carried only status/output/error, so
  `replanCompletedReadReceipt`'s rebind (tool_name, connection_id, input
  hash/json, execution plan pair, idempotency key) was silently dropped while
  the statement still counted as a change and reported `created`. The trigger
  now maps every column the runtime's UPDATE statements write; unmentioned
  view columns pass their old values through `NEW`, so the added arms are
  identity writes for other callers.
- **v9 — block-dashboard exemption on `runs_mutating_substream_uq`.** The
  claim SQL deliberately admits a block-dashboard run beside a running
  interactive run, but both sit on substream `'0'`, so the index turned the
  second claim into a thrown UNIQUE violation instead of the zero-change
  result the claim's busy branch absorbs. The index now encodes the same
  origin exemption the claim SQL does; D1 had no equivalent index, so block
  runs' concurrency was always governed by the claim predicates alone.
- **Alias-free inline-child updates (code, not schema).** The three
  `UPDATE harness_runs AS child …` statements (inline-child heartbeat,
  terminalize, reap) fail against the object because SQLite cannot resolve an
  alias on an INSTEAD-OF-trigger view target (`no such column: child.id`) —
  verified against stock SQLite. They now qualify by the table/view name,
  which parses identically on both. This had broken every inline-child
  behind background retries.

**Why:** the port's contract is that runtime SQL behaves as it did on D1.
Each of these was a silent divergence — a duplicate row, a dropped write, a
thrown constraint, a failed statement — that only an object-schema-backed
test suite could see. A future migration touching `runs` constraints must
preserve both index predicates: full coverage (including terminal rows) for
the parent-tool-call index, and the block-dashboard exemption for the
mutating-run index.

### 2026-08-20 — The pre-cutover execution arms are removed from the product path

**What changed:** Every phase split in `WorkstreamService` and
`routes/workstreams.ts` now keeps only the Durable-Object arm: the service's
product methods delegate to `WorkstreamObjectClient` /
`WorkstreamObjectCreationService` unconditionally, and a stack whose authority
is not `durable_object_open` is refused with a 503
`workstream_authority_not_open` (`requireOpenWorkstreamAuthority` in
`workstream-authority.ts`) that names the fix: `pnpm db:open-authority`.
`launchWorkstreamHarness` and `startWorkstreamWorkflow` carry the same guard
and dispatch only to the SubstreamAgent. `WorkstreamLoopWorkflow` is deleted —
file, `index.ts` export, `WORKSTREAM_LOOP_WORKFLOW` binding in both Wrangler
configs and the Env contract, and its `/health` probe. Work-stream listing,
pins, and socket-ticket visibility now read WorkspaceDO's directory. Regional
D1 retains only the minimal identity anchor plus the separate email and object
routes. The service's `create` also stopped
letting a failed origin-resource attach fail the create, restoring the
contract the legacy arm kept.

**Why:** Production is fully cut over — `workstream_authority_control.phase =
'durable_object_open'` in both regions — and local development reaches the
same state via `pnpm db:open-authority`. The legacy arms were reachable only
on a local stack that skipped that step, a configuration that is no longer
supported; such calls must fail loudly, not silently run 2,000 lines of code
no deployment executes. Dead arms in a 3,000-line service are where the next
confusion hides: every reader had to re-derive which half was live before
touching anything.

**Considered and rejected:** Keeping the arms behind the phase check "for
safety" — the fences already abort their D1 writes post-cutover, so the arms
could only half-run; and quarantining them into a separate legacy module —
that preserves the reading burden the removal exists to end. Draining code was
not kept either: no legacy Workflow instance can exist since the cutover, so
there is nothing left to drain.

**Deliberate leftovers:** `packages/db` query helpers remain as the SQL dialect
served by WorkstreamDO compatibility views; they are not regional D1 callers.
`bootstrapWorkstreamRuntimeEnvironment` and `workstreamExecutionEnvironment`
kept their non-open fallbacks at the time; both are gone as of the 2026-08-22
entry below.

**Consequences:** Unit tests that exercised the legacy arms were retargeted to
the object boundary (see `test/helpers/durable-authority.ts`, which walks the
phase machine and serves the runtime SQL port from sqlite) or replaced by
`workstream-durable-authority.test.ts`, which pins the refusal across the
member-visible surface. The launch failure path — member-safe copy persisted,
diagnostics logged — is pinned there too. Anything sending product SQL to D1
outside the DO port now fails on an absent table or column and is a routing bug
by definition, not a phase.



### 2026-08-20 — The object creation path schedules the first naming pass

**What changed:** `WorkstreamObjectCreationService.create` now schedules
`nameWorkstream` against the routed runtime environment after the create
response, deferred through the route's `waitUntil` plumbing exactly as the
legacy service documents; a caller with no deferral gets the call awaited.
Failures log `workstream_first_naming_failed`. Both runtime SQL executors now
name the statement a SQLite error came from.

**Why:** The legacy creation path's `nameInBackground` never migrated, so
every post-cutover work stream kept its provisional title in `naming` forever
— the sidebar skeleton shimmer that never resolves, visible in every
screenshot of the incident. The run-settlement repair pass could not rescue
it: it is gated on a five-message transcript that a short work stream never
reaches. The routed environment matters because `advanceTitle` writes
`workstreams`, which post-cutover lives behind the runtime router. Found by
the local end-to-end campaign — thirty of forty campaign work streams stuck
in `naming` — not by any unit suite, because the defect is an *absence* at a
service seam.

**Considered and rejected:** Settling in the run-settlement pass regardless of
message count — it would spend the one automatic retry the naming design
grants on every two-message work stream. A workerd-level test — the seam is
the creation service, above the object; coverage lives in the live-stack
campaign's `happy_title_settles` lane instead, and the vacuous object-level
test that appeared to cover it was removed rather than kept for show.

**Consequences:** New work streams settle their title on creation, `naming`
means what it says again, and a naming failure is a logged event rather than
a permanent shimmer.



### 2026-08-20 — The messages trigger absorbs replayed durable writes

**What changed:** Schema v5 rebuilds `_runtime_messages_insert` with a second
upsert arm: a write whose `client_message_id` already exists under a different
message id is a replay and is ignored; same-id tool updates keep updating in
place. Derived from the frozen v1 body with v3's rounding applied.

**Why:** SQLite ignores an `ON CONFLICT` clause aimed at a view — conflict
handling belongs to the INSTEAD OF trigger. The harness's durable writers rely
on `ON CONFLICT(workstream_id, client_message_id) DO NOTHING` for replay
safety: a retried attempt writes its final message again under the same
`harness:<runId>` client id with a fresh message id. Against the object, that
clause was silently dropped and the trigger's bare INSERT hit
`parts_client_message_uq` — an uncaught crash in the run's settlement, found
within minutes of pointing the local end-to-end campaign's stop/retry lane at
the post-cutover stack. Every runtime view that accepts writes shares this
contract: replay-safety promised by a caller's ON CONFLICT must be
re-expressed inside the trigger, because SQLite will not carry it through.

**Considered and rejected:** Rewriting the callers to probe-before-insert —
races under exactly the concurrency that produces replays; and mapping the
outer conflict clause in the SQL rewriter — the rewriter cannot know which
conflict target survives the view-to-table column mapping.

**Consequences:** Retried runs settle instead of crashing. The pattern is now
load-bearing and documented: an INSTEAD OF trigger owns every conflict its
table can raise. `runtime-compat-views.test.ts` replays a durable write
through the real trigger and fails against the bare-INSERT body.



### 2026-08-20 — Work-stream authority outranks the workspace router, and the resources view becomes selectable

**What changed:** The workspace runtime router defers any statement that
references a work-stream authority table, instead of claiming it because a
workspace table also appears somewhere in the SQL. Schema v4 rebuilds
`_runtime_resources` with qualified columns. The runtime SQL executor names
the statement a SQLite error came from, `runWorkstreamHarness` logs
`workstream_harness_run_failed` with the Bind failure detail its member-safe
outcome strips, and the harness's own catch logs `workstream_harness_threw`
with the real exception. `test/runtime-compat-views.test.ts` selects from
every compat view.

**Why:** Every harness run since the Global cutover failed in ~450 ms without
reaching a model, with nothing logged. Two stacked defects: the harness wraps
the workspace router *outside* the work-stream router, and the workspace
matcher claimed any SQL naming any workspace table anywhere — so the
transcript read (`FROM messages … JOIN resources …`) executed in WorkspaceDO,
which has no `messages`. The work-stream object was always the right home: it
carries compat views (`_runtime_users`, `_runtime_resources`) for exactly the
non-owned halves of such joins. Fixing the routing then exposed the second
defect: `_runtime_resources` read a bare `updated_at` over
`workstream_resource_links CROSS JOIN workstream`, ambiguous since v1 —
SQLite validates a view body on first use, and nothing had ever selected it.

**Considered and rejected:** Splitting `listMessages` into per-authority
queries — correct in principle, but the object's compat views exist precisely
so cross-authority reads need no splitting, and a split fixes one statement
while the routing defect kept every other mixed statement broken. Swapping
the wrapper order at every `runWorkstreamHarness` call site — more churn for
the same precedence rule, stated less explicitly.

**Consequences:** A statement touching both authorities now runs in the
work-stream object; the workspace object serves only statements that touch no
work-stream table. The pipeline suite's boundary oracle is the Bind engine's
member-safe sentence rather than the failure code, because both halves of
this incident carried the same catch-all code. Every layer that converts an
error into a member-safe shape now records what it stripped first — three of
the four hours this took were spent making silent failures speak, and each
speaking layer then named the next defect within minutes.



### 2026-08-20 — Timestamps round-trip exactly, and the pipeline is tested end to end

**What changed:** Schema v3 rebuilds every runtime-compat trigger that converts
an ISO timestamp to epoch milliseconds to round instead of truncate. The
product endpoint sequences `startProductWorkflow` before the socket broadcast
in `initialize`, `create_message`, and `answer_elicitation`, and its catch-all
now logs `workstream_product_request_failed` with the real reason.
`reapAbandonedSubstreamRuns` additionally reaps `admitted` runs with no
dispatch behind them after a one-minute grace.
`test-workers/message-to-output-pipeline.test.ts` drives the whole path —
real D1 session auth, the real product endpoint, the real alarm — and holds
the invariant that a run either reaches the provider boundary or fails
loudly, with the member-visible state following it.

**Why:** `CAST((julianday(x) - 2440587.5) * 86400000 AS INTEGER)` truncates,
and the float product sits up to ~0.03 ms below the true integer, so a
measured 49.7% of timestamps came back one millisecond early through the
view. Every guard comparing a stored timestamp to the string it was written
from then failed — most visibly `terminalizeHarnessAttempt`'s
`terminalized_at = ?` guard, which is what moves the member-facing work
stream out of `running` when a run ends. Half of all settled runs left the
member watching a spinner over a finished run; which half was a coin flip,
which is why it read as intermittent for hours. The pipeline test found it in
its first full pass; no unit suite could, because the truncation happens in a
trigger and the equality in a different layer's SQL.

The broadcast reorder closes a second orphaning found the same way: a refused
broadcast aborted the handler after the run was committed, leaving an
admitted run with no executor and no alarm, and the member a 500 over a work
stream that exists. A broadcast is a courtesy to connected sockets; it must
never gate durable state progression.

**Considered and rejected:** Rewriting the seven `= ?` timestamp guards to
lossless conditions — treating the symptom in one consumer while every other
comparison against these columns stays wrong; and comparing through a
matching round-trip expression, which inverts the breakage on plain D1.
Editing the v1 trigger statements in place is impossible: v1's hash is
immutable. v3 derives the rebuilt triggers from the frozen v1 array, which
cannot drift because any edit to that array breaks v1's own hash first.

**Consequences:** Stored millisecond values are exact from v3 onward;
historical rows may sit one millisecond early, which no surviving comparison
depends on. Work streams already stuck `running` over a finished run heal on
their next run's settlement. The dense round-trip sweep in
`agent-run-dispatch-queue.test.ts` fails deterministically against
truncation (248 of 500 timestamps), so the defect cannot return quietly.



### 2026-08-20 — A run whose executor is gone no longer wedges its substream

**What changed:** Before a claimed dispatch starts, the drain terminalizes runs
on its substream that hold the mutating slot with no dispatch behind them
(`reapAbandonedSubstreamRuns`), logging `workstream_abandoned_runs_reaped`. An
undecodable dispatch payload is now parsed inside the drain's guard and settled
as `agent_run_dispatch_undecodable` instead of throwing out of the loop. Every
run failure logs `agent_run_execution_failed`.

**Why:** The dispatch-queue fix restored the alarm and still left the work
stream spinning, because the run was never the thing that was stuck.
`runs_mutating_substream_uq` permits one mutating run per substream, so a run
imported mid-flight during the cutover — whose Workflow instance did not come
with it — held that slot permanently. Every later run then failed inside
`recordWorkflowStarted`, and the failure belonged to the *new* run, so the work
stream read as busy while nothing executed. `reapStaleHarnessRuns` exists for
this but runs inside `executeAgentRun`, which the wedge prevents from being
reached: the only thing that clears a stuck run was a run. The drain's `catch`
logged nothing at all, which is most of why hours of production telemetry showed
a healthy object doing nothing.

The poison pill was found by running the new suite against workerd rather than
by reading the code: the payload was parsed before the `try`, so a dispatch this
build could not validate threw out of the drain, settled nothing, and was
reclaimed and rethrown on every alarm forever.

**Considered and rejected:** Reaping on a timer, which guesses at a deadline the
writer never declared; and widening the unique index, which is the constraint
that keeps two runs from mutating one substream.

**Consequences:** "Abandoned" is decided by the dispatch ledger — a mutating run
with no queued or running dispatch cannot execute again, whatever its age — so
the reap is safe while another run is legitimately in flight, because that run
has a dispatch. A work stream wedged by an earlier build heals on its next
message rather than needing an operator. `test-workers/agent-run-dispatch-reliability.test.ts`
holds both cases against real alarms, real storage, and real eviction.



### 2026-08-20 — A leased dispatch, and an alarm derived only from the rows

**What changed:** `agent_run_dispatches` gained `lease_token` and
`lease_expires_at` in both agent objects (schema v2 in each). The alarm
derivation no longer reads `DurableAgentDrain.active`, the drain is awaited by
the invocation that starts it instead of being dropped into `waitUntil`, RPCs
enqueue rather than execute, and the alarm is floored at
`AGENT_RUN_DISPATCH_SWEEP_MS` while any row is non-terminal.
`agent-run-dispatch-queue.ts` holds the shared derivation.

**Why:** Every agent run in Global stalled behind a spinner with no error
anywhere. `nextRunDispatchAt` computed a *durable* wake-up from *in-memory*
state: `resumeRunDrain()` set `agentDrain.active`, the next line's
`scheduleNextAlarm()` therefore excluded the row it had just claimed, and with
nothing else pending it called `deleteAlarm()`. The invocation then returned
while the drain was still outstanding, so the runtime cancelled it — silently,
because cancellation is not a thrown error, which is why no
`substream_agent_drain_failed` was ever logged. The row stayed `running` with
no alarm left to rediscover it. The recovery clause existed and was correct;
nothing was scheduled to reach it.

**Considered and rejected:** Restoring the `OR state = 'running'` arm alone —
it re-reads memory to interpret durable rows, which is the defect rather than
an instance of it. Returning execution to Cloudflare Workflows, which would
undo the cutover this hierarchy exists to serve. Keeping `waitUntil` and only
extending the lease, which leaves the cancellation window open.

**Consequences:** A dispatch is recoverable by *any* later invocation, so
reclaim after an eviction is ordinary rather than exceptional — and immediate,
because construction releases the dead isolate's leases rather than waiting
them out. Retries are consequently guaranteed rather than best-effort, and a
reclaim replays the run: the run scope and tool receipts are what keep an
external write from happening twice, and the D1 harness attempt claim remains
the real mutual exclusion. A long run is not at risk from its own lease
lapsing, because the only reader inside a living isolate is the single-flight
drain that already holds it; the lease matters solely to a successor, and a
successor always releases it. `lease_token` fences the writes that release a
lease, so a straggler cannot clear its successor's claim — without that, one
late writer produces two concurrent runs, because a NULL lease reads as
reclaimable. An object with outstanding work now wakes at least once per sweep
interval. Adding a migration to either object no longer requires editing a
pinned count in the tests: the expected ledger length is read from the
published list.

The cost, accepted knowingly: because `alarm()` awaits the drain and the
platform does not deliver overlapping alarm invocations, an object executing a
run does not service its other alarm lanes until that run ends. Regional
effects committed *during* a run reach the parent `WorkstreamDO` when it
finishes rather than within 30 seconds, and an agent timer set mid-run fires
late by the same amount. The drain flushes due effects between runs so a queue
of runs does not compound it, and p95 run duration is under a minute — but a
multi-hour session delays the parent's view for hours. Not awaiting was the
alternative, and it is what produced the outage. Removing the trade rather than
picking a side needs resumable execution: a run that checkpoints at a step
boundary is cheap to interrupt, which is what would make the drain safe to
leave the alarm again.

### 2026-08-20 — The last maintenance-only RPC goes, and what still blocks the fence drop

**What changed:** `WorkspaceDO.importWorkstreamPins` and its request schema are
removed. Its only caller was the campaign machinery retired in #190, and it
refused every phase except `maintenance_importing` and `maintenance_verified`,
which nothing can enter now that the machinery driving those phases is gone.

**Why:** It was the last piece of import-only surface left on an object that no
longer imports.

**What a future change has to respect — the legacy D1 serving paths are NOT yet
removable, for two independent reasons, and the fences cannot be dropped until
both are resolved:**

1. `services/workstream-service.ts` is still reached post-open, so it is not the
   dead legacy implementation it appears to be. `slack-agent-service.ts` builds
   it ungated on two connector paths (`startFromPrompt` answering an open
   elicitation, and `createSlackWorkstreamSession` creating a work stream for a
   linked identity — neither has a phase check anywhere near it), and
   `work-opportunity-service.ts` calls into it from `startDurable`, the Durable
   Object path itself, for `createFromOpportunity` and — via `startedResponse`
   — `get`. Deleting the file breaks live Slack ingress and suggested-work
   starts in an already-open region. Those two callers have to move onto the
   object client first; that is a product migration, not a cleanup.

2. A freshly seeded local development environment runs at `legacy_open`.
   Migration 0079 inserts that row, and neither `scripts/seed-local-region.mjs`
   nor `packages/db/seed.sql` ever changes it, so local development serves the
   seeded workspace through exactly the branches a removal would delete —
   while `pnpm test` stays green, because the suites build their own fixtures
   and never go through the seed. Local seeding has to move to the
   post-cutover model (the regional half staying SQL, the work-stream half
   going through the object via `bootstrapWorkstreamRuntimeEnvironment`) before
   those branches can go.

### 2026-08-20 — A re-derived projection wins over the version it reuses

**What changed:** When a child effect arrives under a projection version this
object has already stored but with a different payload hash, the newer payload
is adopted and `substream_projection_version_reused` is logged, instead of
throwing `substream_projection_version_conflict`.

**Why:** The child numbers its own projections and restarts that counter when a
maintenance import rebuilds it, while this object's projection survives. A
re-derived effect therefore arrives under a version already seen, carrying
different bytes — which is not the divergence the conflict was written to
catch. It failed activation across the fleet immediately after the epoch guard
above stopped rejecting the same effects one layer earlier.

**What a future change has to respect:** the child is the authority for its own
projection; this table is a cache of it. Outside a campaign the two should
never disagree at the same version, which is why the disagreement is still
logged rather than passed over in silence.

### 2026-08-20 — The parent follows the authority epoch instead of gating on it

**What changed:** `applyChildEnvelope` matches identity on the workspace and
work stream alone. `workstream_metadata.authority_generation` is now advanced
whenever a child reports a newer epoch, and it no longer decides whether an
effect is accepted.

**Why:** That column is written once, when the metadata row is first created,
and was never rewritten. A child stamps every effect with the generation
current at enqueue time. Gating on equality could therefore only hold for a
cutover that ran exactly once — any restart moved the child forward, left the
parent behind, and made every effect permanently unacceptable. An earlier
attempt at this entry relaxed the comparison in one direction, which was the
wrong half: in production the envelopes were *newer* than the row, not older,
and the fleet failed activation identically.

**What a future change has to respect:** a value that is never written cannot
be a guard. Effects are already deduped by `child_effect_receipts` on message
and payload hash, and no new work is admitted while a campaign runs, so
identity is what needs enforcing and the epoch is bookkeeping that follows.

### 2026-08-20 — A tick stops when it meets a large workspace

**What changed:** The scrub tick ends after any sweep in which a route ran out
of its row budget, rather than only after the sweep cap.

**Why:** The cap bounds how many sweeps run, not what a sweep costs, and those
differ by an order of magnitude — a route that empties its targets probes and
leaves at roughly ten round trips, while one that exhausts its budget spends
forty probe-and-delete pairs first, near a hundred and thirty. Measured, three
sweeps of budget-exhausting routes issue about 1,700 subrequests against an
invocation ceiling of a thousand. The overrun degrades rather than breaks —
"too many subrequests" is transient, so the tick ends and the partial scrub
resumes — but it means every tick against a large workspace ends in an error,
which is exactly the signal the drain is being watched through.

**What a future change has to respect:** a route returning `false` is not
merely "not finished", it is the tick's only evidence that the work it just met
is large. Cheap fleets keep the full sweep cap; the expensive case stops early
on its own.

### 2026-08-20 — The scrub gets a rate limit of its own

**What changed:** A tick performs at most `WORKSPACE_SCRUB_PASSES_PER_TICK`
scrub sweeps. The bare `7429` alternative came back out of the transient
pattern. A sweep that activates nothing now logs
`workspace_scrub_pass_activated_nothing` with the generation and the
work spaces it touched.

**Why:** Making D1 overload transient and restoring the campaign's `continue`
in one change raised the per-tick query volume back to what produced the
overload — several thousand round trips, nineteen of the fifty-one target
probes being full scans of unindexed tables — while removing the only thing
that would have stopped it. Neither half was wrong alone; together they needed
a limit the operation budget cannot supply, because that budget charges a scrub
sweep the same single unit as an import page while a sweep costs fifty times
more. The `7429` alternative matched any message containing that number
anywhere, and both real overload strings already match on their words, so it
bought nothing and risked retrying a genuine defect forever.

**What a future change has to respect:** `activated === 0` is the stall
detector, and until this entry it was computed and discarded. A campaign
grinding through a large workspace and a campaign wedged on a route it can
never finish are indistinguishable from outside — and while wedged, every
request stays at 503, because `maintenance_verified` accepts no new work. Keep
that signal reaching the logs.

### 2026-08-20 — D1 overload is transient, and the scrub deletes the one RESTRICT child it was blocked by

**What changed:** Four repairs from an adversarial review of the chunked
scrub. `TRANSIENT_CAMPAIGN_ERROR` now recognizes D1's overload shed
(`7429` / "requests queued for too long"). The budget check moved above the
presence probe. `workstream_terminal_repositories` joined the scrub targets,
immediately before `connector_connections`. And the campaign distinguishes a
scrub pass that finished a route from one that merely spent its budget:
progress continues the tick, a stall ends it.

**Why:** D1 answered `7429` to an unrelated read while this scrub was running,
and that string matched nothing in the transient list — so the next one during
activation would have quarantined a healthy campaign mid-outage, which is
precisely the generation-4 cascade. The RESTRICT reference is the only foreign
key into the scrub from a table the scrub deliberately leaves behind: work
streams survive, so their terminal-repository rows survive, and deleting the
connector connection they point at raises a foreign-key error that is also not
transient. Neither had fired yet; both were waiting for the first workspace
with a terminal repository, or the first overloaded moment.

**What a future change has to respect:** the budget counts statements, not
rows — `budget -= WORKSPACE_SCRUB_CHUNK` is unconditional, so 20,000 with a
500-row chunk means forty deletes per route per tick, and the last chunk of
every target is charged in full. Reading it as a row count overestimates what
one tick achieves for a workspace whose rows are spread thinly across targets.

**Considered and rejected:** returning after every scrub pass regardless of
outcome, which was the first attempt — it serialized the fleet to one batch of
routes per tick and, because `maintenance_verified` refuses new work, turned
internal scheduling into user-visible downtime.

### 2026-08-20 — The scrub asks whether rows remain instead of trusting a delete's row count

**What changed:** Each chunk loop now issues a `SELECT 1 ... LIMIT 1` against
the target and stops when it comes back empty, rather than comparing the
delete's `meta.changes` against the chunk size. The campaign also performs one
scrub pass per route per tick instead of re-entering still-`verified` routes
for the rest of its operation budget.

**Why:** D1 reports `meta.changes` as zero for `DELETE ... WHERE rowid IN
(SELECT ...)`, so the loop believed every chunk deleted nothing and moved to
the next target after a single pass. Measured in production, that scrubbed 500
rows per target per minute against workspaces holding six figures of them —
correct, and roughly three hours from finishing. The local SQLite double
reports `changes` faithfully, so no test could see it; the regression test now
zeroes the field deliberately to reproduce what D1 does.

**What a future change has to respect:** progress through the scrub is a
property of the data, not of a driver's return value. Ask the table.

### 2026-08-20 — The activation scrub runs in resumable chunks

**What changed:** `activateWorkspaceProductRoute` no longer issues the whole
workspace deletion as one D1 batch. Its fifty targets are now a declared,
foreign-key-ordered list, deleted 500 rows at a time under a 20,000-row budget
per invocation. Falling short of the budget returns without activating: the
route stays `verified` and the next cron tick resumes.

**Why:** With the fences finally clear, the deletes ran — and D1 answered
`exceeded its CPU time limit and was reset`. The largest workspaces carry six
figures of provenance rows, each delete cascading further, which is more work
than one batch is allowed to do. This is the fourth distinct cause behind an
activation failure and the first that was never a correctness bug.

**What a future change has to respect:** the original batch was deliberately
all-or-nothing, so that D1 was never partially scrubbed while the control plane
still promised a rollback source. That property is gone and could not be kept —
the batch it depended on cannot run at this scale. The invariant that replaces
it is narrower but sufficient: a route turns `active` only after its last
target comes back empty, so an active route is always a fully scrubbed one, and
a partially scrubbed workspace is always still `verified`. Anything that reads
`verified` as "D1 untouched" is now wrong.

**Considered and rejected:** deleting per statement rather than per chunk (a
single `DELETE` over 72,000 edges exceeds the same limit on its own), and
deferring the scrub until after the region opens (it would leave a full copy of
the workspace readable in D1 for as long as the cleanup lagged).

### 2026-08-20 — Legacy bookkeeping triggers stand down once D1 stops being the authority

**What changed:** Migration 0089 confines eight legacy triggers to
`legacy_open` and `maintenance_draining`: the three that bump
`workstream_resource_inventory_revisions` when a note, attachment, or
work-stream resource link is deleted, and the five that enqueue R2 object
cleanup into `resource_object_deletion_outbox` and
`note_resource_deletion_outbox` when a resource is deleted or retargeted.

**Why:** The verified scrub deletes exactly the rows these triggers watch, so
each fired mid-scrub and wrote into a fenced table, aborting activation with
`workspace_do_authoritative` — the third distinct cause behind that one error,
after the cascade deletes (0087) and the `SET NULL` updates (0088). The scrub
already empties those outboxes first; that cannot help, because the deletes
themselves refill them.

**What a future change has to respect:** a fence stops a writer it can see. It
does not stop a *trigger* that writes on that writer's behalf, and this is the
third repair aimed at the same abort because each earlier pass reasoned about
one mechanism — direct statements, then foreign keys — without enumerating the
rest. A trigger that writes into a table whose authority has moved needs a
phase guard, not a relaxed fence at the destination: WorkspaceDO owns object
lifecycle and resource inventory after the cutover, and a D1 row written here
would schedule the deletion of an R2 object the object store still considers
live.

**Considered and rejected:** admitting `maintenance_verified` at the three
destination fences, which would have unblocked activation while letting the
scrub enqueue real R2 deletions against objects WorkspaceDO now owns; and
dropping the triggers outright, which would break the pre-cutover behaviour
they still provide to any region that has not yet migrated.

### 2026-08-20 — The scrub's SET NULL cascades are admitted too

**What changed:** Migration 0088 adds `maintenance_verified` to the update
fences of the eight tables an `ON DELETE SET NULL` reference can reach from a
table the scrub deletes: `automation_runs`, `connector_oauth_attempts`,
`resources`, `sandbox_tasks`, `tool_invocations`,
`work_opportunity_user_links`, `workstream_sandboxes`, and `workstreams`.

**Why:** 0087 admitted the scrub's `ON DELETE CASCADE` deletions and stopped
there, which covered only half of what a foreign key does on delete. A
`SET NULL` reference makes SQLite issue an UPDATE against the child, and no
update fence admitted a phase past draining — so activation aborted with the
same `workspace_do_authoritative` on the same statement, after every route had
imported and verified for a second time.

**What a future change has to respect:** a fence's insert, update, and delete
arms are not interchangeable, and the scrub needs whichever arm the foreign key
happens to fire. A new reference onto a fenced table has to relax the matching
arm — `ON DELETE CASCADE` the delete, `ON DELETE SET NULL` the update — or it
stops activation rather than import, which is the most expensive place to fail.
Inserts stay refused throughout, and every fence still refuses both updates and
deletes once the region is open.

**Considered and rejected:** dropping the `SET NULL` references so the scrub
only ever deletes (they exist so a disconnected connector leaves its history
readable), and relaxing every update fence rather than the eight reachable ones
(a fence that nothing can legitimately fire should stay shut).

### 2026-08-20 — The verified scrub can finish: cascades admitted, and one statement corrected

**What changed:** Migration 0087 adds `maintenance_verified` to the 34 work-stream
fences' delete triggers, matching what 0083 already grants the workspace
fences. The activation scrub's `note_resource_deletion_outbox` delete is scoped
through `resources` — that table is keyed by resource and has no workspace
column — and moved ahead of the `resources` delete it now depends on.

**Why:** Activation is the one step no earlier generation reached, so both
defects were invisible until every route had imported and verified. D1 enforces
foreign keys, so deleting a workspace's `activities`, `resources`, `notes`, and
`connector_connections` cascades into work-stream-owned children such as
`activity_suggestions` and `workstream_resources`. Those children carry the 0079
fences, written before 0083 established the scrub as a legitimate deletion, so
the cascade aborted with `workspace_do_authoritative` and quarantined the
campaign at the finish line. The second defect was plain invalid SQL that only a
workspace with no cascading rows ever reached.

**What a future change has to respect:** the scrub deletes across both
authorities at once. A new fence on any table reachable by cascade from a
workspace-owned parent must admit `maintenance_verified` for deletes, or it
will stop activation rather than the import — far later, and after the
expensive work is already done. Inserts and updates stay refused from the
moment import begins, and every fence still refuses deletes once the region is
open, so D1 cannot become a second writable authority.

**Considered and rejected:** deleting the cascade children explicitly before
their parents (they carry the same fences, so it moves the abort rather than
removing it), and letting activation tolerate a failed scrub (it would leave
the region open with a populated D1 shadow of the authority that just moved).

### 2026-08-19 — The import reconciles rows the object mutated, and product alarms wait for the open

**What changed:** Two halves of one rule — the frozen D1 snapshot is authority
for a WorkspaceDO's product tables until its region opens. `WorkspaceDO.alarm`
now performs no product work (no window claims, no retention reaps, no ranking
claims) while the authority phase is anything other than `durable_object_open`
or `legacy_open`; it just re-arms. And when an import page finds a row that
disagrees with the source, it updates that row to the source values instead of
failing — unless the same page already wrote that key, which is a mapper defect
and still fails, as does a value the converter cannot produce.

**Why:** Generation 5 of the Global cutover quarantined on
`opportunity_batch_windows` with no duplicate partition keys in the source. The
object's own alarm had claimed a window the importer had just written —
`pending` became `processing` with a lease — and the page's next delivery found
its exact-match check violated by the object's own mutation. Page re-delivery
became routine in the same change that made transient failures pause instead of
quarantine, which is why this surfaced only once both were live. A new
generation re-importing over an earlier one's rows hits the same wall.

**Considered and rejected:** `INSERT OR REPLACE` (its delete half cascades to
child rows an earlier stage already imported), truncating each object's product
tables at generation start (correct but far larger blast radius, and it
discards rows whose source pages have not been re-sent yet), and dropping the
exact-match verification (it is the only thing that catches converter defects —
generations 2, 3, and 4 were all caught by it).

### 2026-08-19 — Transient failures pause the import campaign instead of condemning it

**What changed:** A campaign route operation that rejects with an
infrastructure signature (platform fetch failures, D1 gateway blips,
subrequest exhaustion, Durable Object mid-deploy resets) now ends the tick and
leaves the route untouched — the idempotent page cursor makes the next cron
tick the retry. Genuine import errors still quarantine immediately. Quarantine
writers additionally preserve the first cause: a route or the control row that
is already quarantined keeps its original error code. The per-tick operation
budget is pinned at 100 so a tick always finishes inside the one-minute cron
interval.

**Why:** Generation 4 of the Global cutover quarantined with
`workspace_product_import_not_active` on every route — a cascade, not a cause.
One transient rejection quarantined the phase mid-tick; sibling operations
in-flight (including an overlapping tick, possible once the cron accelerated to
every minute with a 200-operation budget) then failed the WorkspaceDO's
phase-guard read and their quarantine writes overwrote the original diagnosis.
The campaign's zero-tolerance rejection handling predates the accelerated
cadence, where transient platform errors are no longer rare events.

**Considered and rejected:** In-place per-operation retry loops (the cron is
already a retry loop with a natural backoff; duplicating it inside the tick
adds concurrency for no coverage), and treating every error as retryable (a
data conflict must stop the campaign — retrying it forever would hide the
defect the quarantine exists to surface).

### 2026-08-19 — The authority cutover campaign machinery is retired

**What changed:** With both regions permanently at `durable_object_open`, the
one-time campaign code is deleted: the cron importer
(`workstream-authority-migration.ts`), the object-side import machinery
(`workstream-authority-import.ts`, `workspace-product-import.ts`,
`workspace-product-import-storage.ts`), the `importAuthority` /
`importWorkspaceProductRows` RPCs and the `/internal/authority-import` route,
the scheduled handler's maintenance-phase branches, the cutover driver script
and its deploy-workflow steps. `workstreamImportHash` survives in
`workstream-import-hash.ts` because create receipts and the runtime SQL port
store hashes under its encoding.

**Why:** The campaign completed; keeping ~2,500 lines of one-shot import code
in live Durable Objects left writable import surface on production objects and
made every reader of these files reason about a phase that can no longer
recur. The fences and the control/route tables deliberately stay:
`readWorkstreamAuthorityControl` fails closed to `quarantined` when the control
row is missing, so the row is load-bearing on every request, and
`workstream_authority_routes` is now the live directory that work-stream
creation writes and regional effect delivery fences on. The D1 writer fences
remain the tripwire that turns a resurrected legacy writer into a loud
`workstream_do_authoritative` error instead of silent split authority.

**Considered and rejected:** Deleting the control table and phase reads in the
same change (40+ call sites fail closed without the row — removal has to
follow, not accompany, the code that reads it), and keeping the import RPCs as
"harmless" dead surface (an import RPC on a live object is a data-corruption
primitive if ever reachable).

### 2026-08-19 — Every Durable Object reports its migration outcome

**What changed:** All five constructors now run their migration call inside
`withMigrationReport`, which puts the version the object landed on — or the error
it failed with — onto a regional Queue that `avalon-migration-tracker` consumes.
Nothing about the migration runner, the schemas, or the objects' behavior
changed.

**Why:** The runner's verdict was unreadable. Success is silent, and failure is
an exception thrown inside a constructor on one isolate — so a deploy that
stranded some objects on the old version, or broke one on
`component_schema_hash_mismatch`, was invisible until something downstream
noticed. The object is the only thing that knows its version, and the only
moment it knows it is when it applies one.

**Considered and rejected:** Putting the report inside
`applyDurableObjectSqliteMigrations` itself. It is synchronous, has no `env` and
no `waitUntil`, and one of the five sites does not call it directly —
`SubstreamAgent` reaches it through `WorkstreamObjectStore`'s constructor. A
wrapper that takes a thunk covers all five without the runner acquiring an
observer dependency it would then have to be tested with.

**Consequences:** A new Durable Object class in this hierarchy must wrap its
migration call or it is invisible to the tracker; nothing enforces that
automatically. The send is a queue send, not an RPC, so it must stay
fire-and-forget — see
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md) before making anything
here wait on the tracker. The reporter creates a `_migration_report_state` table in each
object's SQLite outside the migration history — deliberately, for the same
reason the runner bootstraps `_sql_schema_migrations` that way — so a schema
audit will find a table that is in no migration list. Reporting is
best-effort by contract: it must never be allowed to fail construction.

### 2026-08-19 — The fleet's tables get retention, byte-accurate bounds, and honest columns

**What changed:** A four-reviewer table audit plus a platform-limits research
pass produced one sweep. Every growth-only table gained a generous reap —
180 days for the block dispatch ledger (freshness-pinned run always kept),
`child_effect_receipts`, HyperSight run/result rows (each block's newest run
always kept), ranking rounds, spent wake-ups and substream dispatches, and
never-started expired opportunities with a recursive live-set sweep for
unreachable provenance nodes; 13 months for processed connector event bodies.
The resource-link poison-wedge closed at three layers: the producer caps links
at the envelope contract's 10,000, the child outbox and parent tables bound
payloads at 1.9 MB measured in BYTES (`length(CAST(… AS BLOB))` — the platform
2 MB limit is per-row bytes while `length()` on TEXT counts characters), and
the parent bound now equals the child's so a committed effect is always
deliverable. Confirmed platform numbers: DO-to-DO RPC allows 32 MiB, so the
transport never binds; Queue messages remain opaque wake-ups under 128 KB.
Domain-model findings landed with it: the parent outbox's effect class is a
CHECK-enumerated `effect_kind` column instead of `json_extract` in the drain,
the block dispatch freshness tuple became declared columns the queue ordering
reads, window/event admission shares one `pending` token (import maps legacy
`queued`), the compat block-run copy regained its status CHECK, the stream
checkpoint upsert enforces revision monotonicity, all three native
socket-ticket receipt tables store unix-ms, and the epoch-seconds
transcription columns carry their unit as `*_s` names. Dead weight left the
single initial migrations: WorkspaceDO's historical `socket_ticket_receipts`,
five writerless SubstreamAgent tables (`workstream_events`, `run_events`,
`activity_delivery_receipts`, `grant_sessions`, `legacy_artifacts` and its
import stage), five reader-less indexes, and the scheduler's dead retry index;
the scheduler's save became a change-guarded reconcile.

**Why:** The audit's verdict was consistent — transactional and idempotency
machinery sound, defects concentrated in retention, payload bounds, and
schema-invisible discriminators. The 10 GB object ceiling is the only hard
bound, so windows err long; but "no reap" is not generous, it is a slow
wedge. A load-bearing routing field hidden in JSON is invisible to STRICT,
CHECK, and schema inspection, and each billed index and full-scan grows with
the very tables that lacked retention.

**Considered and rejected:** A dead-letter lane on the parent outbox
(directory state is latest-wins per key and applies idempotently — permanent
receiver failure is quarantine-class, now documented on the table); dropping
the transcription epoch-seconds contract instead of naming it; fleet-wide
`pending` renames beyond the one adjacent-table collision; and sizing payload
CHECKs to the 32 MiB RPC cap rather than the 2 MB row cap.

**Consequences:** Reaps run inside existing transactions and alarms — no new
timers. A redelivery older than a receipt window converges on waterlines,
dedupe keys, and intent identities. Effects too large to deliver now fail in
the producing transaction where the producer can shrink them. The import maps
renamed/renumbered vocabulary (`queued`→`pending`, `*_s` columns) so legacy
D1 rows land unchanged in meaning.

### 2026-08-18 — Regional effect receipts, email receipts, and dictation admission move into WorkspaceDO

**What changed:** Activity/mention effect replay receipts left D1 entirely: the
regional Queue consumer resolves current actor/target/membership identity from
D1, then one `applyWorkstreamRegionalEffect` RPC commits the activity event or
notification intent *and* its receipt in a single WorkspaceDO transaction,
sharing `workspace_workstream_effect_receipts` with the directory path. The
unshipped `0080` migration no longer creates a D1 receipt table. WorkspaceDO's
initial schema also gained `workstream_email_receipts` (inbound-email
idempotency/lease) and the two `realtime_transcription_*` admission tables,
imported, scrubbed, and fenced through the standard workspace product campaign.
Receipt inserts now age rows older than 30 days out of the shared receipt
table.

**Why:** The D1 receipt could not commit atomically with the WorkspaceDO
product row it acknowledged, which was exactly the split invariant 14 forbids;
its safety already rested on the object-side idempotency guards, making the D1
row a second authority with no second job. Email receipt leases and dictation
concurrency caps were compare-and-set races in D1 that a serialized object
removes outright — the transcription release path even carried a retry-delay
loop to paper over lost D1 races.

**Considered and rejected:** Keeping a composite `(workstream, generation,
partition, source_version)` receipt axis in the object (a same-source
re-emission under a new message ID now converges on the event dedupe key or
intent identity instead), a separate object receipt table for regional effects
(one inbox, one retention rule), and WorkstreamDO ownership of email receipts
(one email may fan out to several work streams, and the ingest path already
addresses the workspace object).

**Consequences:** A crash between the atomic commit and the
mention-opportunity snapshot enqueue is repaired by redelivery, so the enqueue
now also runs on replays and relies on the batch-event unique key to converge.
Un-acknowledged effects older than 30 days lose their fast replay receipt and
fall back to product-identity convergence. The legacy pre-cutover email branch
still claims and settles its receipt in one regional D1 batch; the two stores
never mix within one phase.

### 2026-08-18 — Cross-authority retries converge without weakening ownership

**What changed:** Slack elicitation reads now enter the owning SubstreamAgent
runtime, the compatibility SQL router strips UPSERT only for rewritten views,
and regional effects acknowledge superseded authority generations and composite
receipt replays. Workspace resource-watch and automation-run split writes now
compensate or repeat their idempotent pair, and draft deletion checks the
WorkspaceDO's archive-agnostic work-stream resource links in the same SQL
statement that deletes the resource.

**Why:** A transient failure between two Durable Objects is not a transaction.
Treating it like one left one-sided watch/run state, while reading child-owned
elicitations or resource links through a parent projection made correctness
depend on deliberately removed D1 copies.

**Considered and rejected:** Restoring D1 projections, routing every operation
through a Queue, and accepting an archive-filtered preflight check. The first
two create another authority; the last has a check/delete race and can destroy
an attachment still referenced by an archived transcript.

**Consequences:** Cross-object mutations use idempotent retry or explicit
compensation. Old-generation Queue deliveries drain terminally, but a delivery
for a missing, inactive, or future generation still fails closed.

### 2026-08-18 — Runtime SQL routing preserves SQLite statement boundaries

**What changed:** The WorkspaceDO and SubstreamAgent compatibility adapters now
split multi-statement SQL only at semicolons outside SQLite literals, quoted
identifiers, and comments. Their table matchers are compiled once, SQL cursor
rows are returned without identity-copy allocations, and a malformed persisted
BlockDashboard dispatch is terminalized, logged, and removed from its outbox.

**Why:** A semicolon in content previously changed routing boundaries, while a
schema-drifted dispatch could retry forever and head-of-line block every later
refresh for the same HyperSight block.

**Considered and rejected:** Continuing to use string splitting, retrying
permanently invalid envelopes, and interpolating import identifiers supplied by
the request. Import identifiers remain safe because the parsed stage selects a
closed in-code table/column definition; row keys must exactly match it.

**Consequences:** Unterminated literals and block comments fail before routing.
Transient child-RPC failures still back off, but invalid durable envelopes
produce a visible failed run and cannot poison the per-block delivery lane.

### 2026-08-18 — Retry boundaries fail closed without blocking unrelated work

**What changed:** Creation replay repairs a missing parent snapshot, visibility
enumeration is capped and cursor-paged, completed opportunity windows accept
duplicate callbacks as no-ops, and WorkspaceScheduler isolates maintenance
workers with `allSettled` semantics.

**Why:** Ambiguous RPC results and at-least-once Workflow delivery are ordinary
runtime conditions. An unbounded result or one failed cleanup task could turn a
local retry into a workspace-wide availability problem.

**Considered and rejected:** Treating every retry as a conflict, retaining an
unbounded convenience RPC, and failing the full scheduler alarm on the first
maintenance rejection.

**Consequences:** Nonterminal lease mismatches still fail closed. Callers page
visibility results, creation may emit a repair snapshot, and maintenance
failures are logged while their durable source rows remain retryable.

### 2026-08-18 — WorkspaceDO becomes the workspace product database

**What changed:** The single initial WorkspaceDO migration now includes
connector credentials, connection-scoped webhook replay receipts, OAuth attempt
status, and workspace-local handoff, Terminal egress policy plus revision history, Slack
product state, automations, digests, schedules,
resources/notes/watches, R2 reference/deletion outboxes, memory, mention
intents, and external delivery state. Existing services run allowlisted
workspace SQL through a typed native-RPC compatibility adapter. WorkspaceScheduler
queries and drains the object-owned due tables. The maintenance controller
imports these domains in parent-before-child order and D1 permanently rejects
post-cutover writes. Connector-trigger prompts, between-turn automation
authority checks, and provider/event-type suggestion feedback resolve the
canonical WorkspaceDO event rather than a legacy D1 activity row.

**Why:** These records all have one workspace owner and are consumed beside
workspace directory/activity state. Retaining them in D1 made the control plane
a second product authority and made object-local workflows and sockets depend on
cross-database joins.

**Considered and rejected:** Per-domain Durable Objects, D1 read projections,
and dual writes. One WorkspaceDO gives
the related domains local transactions and SQL joins; the maintenance window
removes the need for dual authority. Parent-effect Queues remain opaque wake-ups;
connector ingress carries a bounded normalized event to avoid a D1 body relay.
Terminal mention shells are reaped by WorkspaceScheduler rather than a fleet-wide
D1 scan.

**Consequences:** D1 is reduced to identity, membership, placement/ingress
routing, migration, and operational audit/telemetry. R2 retains bytes but no
authoritative pointer. Operations that touch both a work stream and a workspace
perform explicit versioned reads/writes through the two object adapters; mixed
SQL batches fail rather than imply distributed atomicity. Terminal connector
revocation is checked at every child bootstrap instead of attempting unbounded
fan-out to all SubstreamAgents.

### 2026-08-18 — Workspace product authority includes activity and suggested work

**What changed:** WorkspaceDO's initial SQLite schema now owns the first-party
activity log and target edges plus opportunity batching, provenance, per-user
ranking/resolution, and immutable start snapshots. A WorkspaceDO alarm starts
bounded Workflows for model compute, while maintenance routes import the D1
source families in foreign-key order and permanently fence their legacy writers.

**Why:** Both datasets belong to one workspace and are queried with workspace
directory state. Leaving them in D1 kept the nominal routing/control plane on
the product serving path and split an opportunity from the evidence and user
decision that make it explainable.

**Considered and rejected:** A D1 read projection, dual writes, model execution
inside the object alarm, and separate provenance storage. The maintenance
window permits a clean authority switch; Workflow keeps long compute away from
the object request lane; one local transaction preserves graph consistency.

**Consequences:** Activity/digest reads and suggestion reads/writes use typed
WorkspaceDO RPC after cutover. D1 retains the import/route ledger, redacted
opportunity identity anchors required by its workstream foreign key, active
membership/connector identity needed for authorization, and external delivery
intent. It retains no activity rows, opportunity content/provenance/user state,
or live product path.

### 2026-08-18 — WorkspaceDO owns connector events before Workflow processing

**What changed:** WorkspaceDO's single initial SQLite schema now includes the
normalized connector-event authority and ingress receipt ledger. Regional Queue
messages carry the bounded normalized event directly to the consumer, which
commits it by typed RPC and then creates a deterministic per-event Workflow;
Workflow claim and terminal settlement are fenced in the object.

**Why:** A connector event is workspace-owned product data. D1 should route and
support relational control state, not remain the durable body store, while a
Queue callback should not hold routing inference and automation fan-out open.

**Considered and rejected:** One event shared across every workspace matching a
provider delivery would cross authorization boundaries. An ID-only Queue wake-up
would require a D1 body handoff; direct ingress-to-DO RPC without Queue would
lose regional buffering and failure isolation. Raw payloads remain in R2 so the
accepted normalized Queue contract stays bounded.

**Consequences:** Raw deliveries can fan out, normalized events cannot. Every
downstream processor starts from the WorkspaceDO claim. D1 has no live connector
event body or connection-scoped replay receipt to serve.

### 2026-08-18 — Agent-owned durable and transport identities use UUIDv7

**What changed:** Workstream product messages, runs, activities and response
parts; SubstreamAgent and BlockDashboard attempts and socket connections;
WorkspaceScheduler-created entities; Bind lifecycle, tool, checkpoint and
inference rows; Workflow attempts; socket-ticket JTIs; Queue claims; and
notification leases now use UUIDv7. ESLint rejects `crypto.randomUUID()` in
these owning paths.

**Why:** These identities cross SQL tables, Queue deliveries, Workflow steps,
sockets, and logs. A common millisecond-sortable representation makes incident
traces and raw-table inspection substantially easier without asking a random
v4 UUID's associated timestamp from another index.

**Considered and rejected:** Replacing waterlines or integer sequences with
UUID ordering, and converting deterministic DO names, Workflow IDs,
idempotency keys, provider tool-call IDs, or caller-owned IDs. UUIDv7 does not
establish causal order between writers, while those deterministic identities
derive their correctness from stable replay rather than creation time.

**Consequences:** New Rally-owned IDs in the agent-serving boundary expose an
approximate creation millisecond in lexical order. Authority generation plus
the relevant sequence or waterline remains the only freshness contract.

### 2026-08-18 — State converges through waterlined sockets and Queue

**What changed:** WorkstreamDO now appends every changed common or viewer
aggregate to `workstream_state_changes`, gives it an authority-local monotonic
waterline and UUIDv7 identity, persists the full envelope in its SQL outbox,
and sends only an opaque wake-up through Cloudflare Queue. The consumer applies
directory/user/feedback state to WorkspaceDO by typed RPC; WorkspaceDO persists
independent common/viewer waterlines and publishes current rows. Electron uses
one shared ledger for both sockets and ignores stale fields independently.
Workspace query invalidations likewise use a `waterline` plus UUIDv7, coalesce
missed topics on reconnect, and OAuth completion no longer polls.

**Why:** An active work stream needs the direct socket's low latency, while an
inactive work stream needs the workspace socket to update the sidebar and
discovery surfaces. Queue delivery is at-least-once and unordered, so a single
combined version could let a newer viewer update suppress a delayed common
update. Timer polling also spent requests while the app was idle and still
left race windows between two caches.

**Considered and rejected:** A globally causal UUID clock, direct runtime RPC
for every WorkstreamDO-to-WorkspaceDO transition, one combined common/viewer
waterline, pending-row coalescing, and retaining periodic query/OAuth polling.
UUIDv7 is only millisecond-time-sortable across independent writers; Queue is
valuable specifically as the many-work-stream buffering boundary; and losing
an intermediate transition is harmless only at receivers, not before durable
delivery.

**Consequences:** Runtime state transitions always use Queue and are safe under
duplication/reordering. Maintenance/bootstrap alone may synchronously flush the
initial directory snapshot before route activation. The UI may receive the
same event from both sockets without a visual rollback, and every new shared
state surface must name its authority and monotonic waterline key.

### 2026-08-18 — WorkspaceDO becomes the cross-work-stream serving authority

**What changed:** WorkstreamDO now sends common/user directory state, resource
links, and suggestion feedback by typed idempotent RPC into authoritative
WorkspaceDO SQLite. The existing workspace socket serves cursor-paged sidebar
rows, pins live in WorkspaceDO, and activation verifies this state before the
D1 route opens. The regional Queue and D1 inbox now carry only activity-log and
mention-delivery effects.

**Why:** Rebuildable D1 projections left the object hierarchy with two serving
planes and made sidebar correctness depend on a Queue/Worker/D1 round trip. A
workspace object is already the serialized, colocated owner for the exact
cross-work-stream queries the product needs.

**Considered and rejected:** Querying every WorkstreamDO from Electron, keeping
D1 projections as a read fallback, and sending all child effects through Queue.
They respectively create unbounded fan-out, preserve split authority, or add a
consumer hop to state that has one deterministic WorkspaceDO destination.

**Consequences:** WorkstreamDO must retain its SQL outbox until WorkspaceDO
acknowledges the hash; pagination and discovery read WorkspaceDO; D1 remains
necessary for membership, relational connector/automation/activity modules,
migration routing, and external delivery, but cannot serve work-stream
directory/resource/suggestion state after cutover.

### 2026-08-18 — BlockDashboard becomes the internal HyperSight boundary

**What changed:** The per-block Durable Object is now `BlockDashboardAgent`,
with `BLOCK_DASHBOARD_AGENTS`, `block-dashboard` routes/object names, and
`block_dashboard_*` SQL, event, model-role, and error identifiers. Electron and
the API use the same internal contract while still rendering HyperSight to
people.

**Why:** The product name described what users see, but it had spread into
placement, persistence, and transport identifiers. Naming the implementation
after its block-dashboard responsibility keeps operational traces and ownership
diagrams explicit without changing the product vocabulary.

**Considered and rejected:** Keeping the old URLs and wire names as aliases.
This implementation has not shipped, so aliases would create two permanent
names without protecting external clients.

**Consequences:** Internal code and operators use BlockDashboard exclusively;
visible copy must remain HyperSight. The unshipped Durable Object baseline and
class registration use the final name directly, but deployed D1 migration
`0043_hypersight.sql` stays immutable; migration
`0078_rename_hypersight_to_block_dashboard.sql` performs the D1 rename.

### 2026-08-18 — Unshipped Durable Object schemas start at one final baseline

**What changed:** WorkspaceDO, WorkstreamDO, SubstreamAgent, and
BlockDashboardAgent each expose one schema migration at version 1 containing
their complete launch DDL. Transitional `ALTER`, rebuild, and backfill steps
were folded into the corresponding initial `CREATE` statements. The existing
WorkspaceScheduler already had a single initial migration and remains so. Both
regional Wrangler manifests likewise register the final five product classes
and `CrashSymbolicatorContainer` in one `v1` migration, with no obsolete class
rename chain.

**Why:** None of these object schemas has shipped or owns production data yet.
Publishing intermediate development history would make every new object replay
obsolete transformations, preserve states that no deployed object can have,
and complicate the maintenance-window cutover without providing rollback value.

**Considered and rejected:** Retaining versions 2–6 as documentation of branch
development. Git already preserves that history; a runtime migration ledger is
an operational compatibility contract, not a development changelog.

**Consequences:** Every newly constructed object records exactly one schema
receipt, and a fresh regional deployment applies exactly one Durable Object
class-registration tag. From the first deployment onward, both baselines are
immutable; all later schema or class changes must append a new version and may
not rewrite version 1.

### 2026-08-18 — HyperSight retry order cannot regress block freshness

**What changed:** WorkstreamDO delivers its block dispatch outbox head-of-line
per block. BlockDashboardAgent independently rejects a causally older late
arrival, prioritizes its one executable refresh over terminal receipt retries,
and publishes committed socket state through one caught serial queue that
coalesces adjacent unsent cumulative checkpoints around control barriers.

**Why:** An older failed RPC could retry after a newer dispatch, supersede the
newest queued work by arrival order, and then make obsolete settlement calls
before useful inference. Concurrent best-effort broadcasts could also expose a
queued frame after the run had already become running.

**Considered and rejected:** Trusting only parent delivery order, serializing
all blocks behind one global outbox row, and awaiting socket authorization or
publication from the inference callback. The first is not defense in depth, the
second destroys block parallelism, and the third makes optional realtime
delivery part of execution correctness.

**Consequences:** Configuration version and source sequence, not retry timing,
decide freshness. Different blocks may still deliver concurrently; rows for one
block retain causal order. Socket frames preserve commit order without making a
viewer, D1 revalidation, or WorkstreamDO availability a prerequisite for a
healthy Bind loop. Under slow revalidation, high-rate full-text checkpoints
collapse to the latest unsent state instead of retaining quadratic text, while
queued/running/terminal state remains an ordering barrier.

### 2026-08-18 — SubstreamAgent serves cursor-paged transcript history

**What changed:** Hibernating feed sockets accept correlated before/after page
queries, reauthorize the reader, and return bounded local-SQL results without
changing room replay state. Electron uses them for upward infinite scroll and
newer-page recovery.

**Why:** Transcript authority and transcript download must share the same
object. Treating a historical read as a broadcast event would make one user's
scrolling visible in every resume cursor and needlessly wake connected clients.

**Considered and rejected:** Full-history snapshots, D1/REST-only history, and
room-sequenced page events. Those choices are unbounded, split authority, or
mix private query progress into shared ordering.

**Consequences:** One page wakes one SubstreamAgent only when requested; idle
sockets hibernate. Page frames cap rows and bytes, response UUIDs tolerate
interleaving, and Electron preserves the user's visual anchor while prepending.

### 2026-08-18 — SubstreamAgent persists its active compaction phase

**What changed:** The initial Workstream schema includes the strict,
attempt-fenced `active_agent_compaction` singleton. Lifecycle frames update it
transactionally with the room cursor and feed it into cold snapshots and resync
responses.

**Why:** Compaction can take long enough for navigation, socket loss, or object
eviction. In-memory activity cannot tell a reconnecting desktop whether the
loop is summarizing or merely quiet.

**Considered and rejected:** Reusing immutable `compaction_jobs` as UI state and
adding a transcript part. The former couples a transient phase to a richer
history record whose required fences are not available at start; the latter
makes runtime progress part of the model-visible conversation.

**Consequences:** One agent DO has at most one active phase, stale completions
are fenced by run/attempt/index, and terminal status clears abandoned state. The
table references the local run and uses integer-millisecond timestamps like
every other object-local operational table.

### 2026-08-18 — Agent sockets share durable full-checkpoint streaming

**What changed:** `BlockDashboardAgent` now exposes its own hibernating,
one-time-ticket WebSocket and persists the same full `ActiveStreamCheckpoint`
contract used by `SubstreamAgent`. Electron opens those sockets only while the
HyperSight panel is visible, replaces output from monotonically newer
revisions, and restores an in-progress run after object eviction or reconnect.
Internal `/internal/*` stub fetches became typed native RPC methods; a custom
ESLint rule prevents their return.

**Why:** Every agent-owned loop can stream for minutes or hours, so terminal
results alone hide useful progress and delta-only reconnects can duplicate or
drop visible text. Targeted object handoffs also benefit from native RPC's
typed surface and per-stub ordering without pretending a Queue send is atomic
with object-local SQLite.

**Considered and rejected:** Relaying block tokens through WorkstreamDO,
polling, storing one row per token, and replacing SubstreamAgent-to-WorkstreamDO
RPC with Queue. They respectively load the metadata control plane, lose smooth
progress, create unnecessary write volume, or retain the child outbox while
adding a Queue consumer and another delivery hop.

**Consequences:** Both agent sockets commit complete checkpoints before
broadcast, reconnect never concatenates a snapshot, block frames are batched
at no more than 10 fps, and direct RPC handoffs remain guarded by sender
outboxes plus receiver receipts. Block sockets revalidate on a bounded cache and
explicit parent sweeps rather than on every frame, and stale queued block runs
are terminalized before they spend inference. Queue is reserved for regional
fan-out where buffering unrelated work streams is valuable.

### 2026-08-18 — SQL fences model arrays and cross-object delivery explicitly

**What changed:** Core child rows now enforce provider-neutral part, tool,
control-part, suggestion-lifecycle, payload-size, and timestamp shapes in
SQLite. Compaction checkpoints retain immutable run/sequence identities;
HyperSight freezes an exact checkpoint hash plus a tool-safe upper sequence.
WorkstreamDO persists configuration refresh intent and no longer coalesces an
inflight regional projection.

**Why:** The object hierarchy is safe only if a frozen derived run cannot slide
to a newer summary, split a tool call from its result, or mistake an optional
suggestion for conversation. Likewise, an RPC timeout cannot prove that the
destination did not commit.

**Considered and rejected:** Reading “latest checkpoint” when the block starts,
persisting tool presentation rows as model messages, adding suggestions to the
message array, and deleting all older outbox rows on coalescing. Each loses a
different boundary: reproducibility, provider validity, audience semantics, or
cross-object delivery certainty.

**Consequences:** A HyperSight dispatch is reproducible or fails closed; exact
post-compaction tools remain available while pre-compaction tools are summary
only; terminal suggestion state cannot reopen; and inflight replacements may
briefly coexist until idempotent acknowledgement.

### 2026-08-18 — HyperSight blocks become independently durable agents

**What changed:** Every stable configured HyperSight block now maps to one
`BlockDashboardAgent`. WorkstreamDO owns configuration, refresh fan-out,
result receipts, and publication; main `SubstreamAgent("0")` emits fenced
refresh signals and serves the canonical runtime SQL used by each block agent.
Both agent classes share custom keep-alive and single-flight drain primitives.

**Why:** A complete unattended HyperSight Bind loop has the same eviction and
retry pressures as a conversation loop, but it has neither its own user-visible
message array nor a desktop feed. It needs an independent durable execution
owner without turning dashboard blocks into substreams or serializing them
through the transcript agent.

**Considered and rejected:** Running blocks in WorkstreamDO, dispatching them
directly from main SubstreamAgent, one Workflow per refresh, one agent for all
blocks, and replacing Bind with the Agents SDK. These respectively put models
in the control plane, duplicate configuration/fan-out state, retain a second
orchestration state machine, serialize unrelated blocks, or discard the
existing harness for lifecycle helpers Rally can implement narrowly.

**Consequences:** HyperSight refreshes fan out in parallel by stable block ID;
each block recovers independently after eviction; source runtime access is a
direct child-to-child internal RPC; results converge through WorkstreamDO's
existing socket; and tests must cover dispatch/result idempotency plus SQL
isolation across block-agent eviction.

### 2026-08-17 — Workspace affinity colocates the complete object hierarchy

**What changed:** Workspace creation now derives a west/east affinity from
Cloudflare request longitude, persists it in the Global binding, regional D1
workspace projection, and WorkspaceDO SQL, and supplies it to every
WorkstreamDO, SubstreamAgent, and workspace scheduler lookup. The US/EU
jurisdiction remains the hard boundary. The routing ESLint rule rejects both
direct namespace calls and the low-level region-only resolver.

**Why:** A fixed western hint satisfies residency but needlessly penalizes an
eastern workspace, while deriving placement on each request can scatter new
children away from their parent. Cloudflare honors a hint only on an object's
first lookup, so affinity must be selected once and carried by every possible
creator.

**Considered and rejected:** Using the current request location for each child,
proxying child creation through WorkspaceDO, and retaining fixed western hints.
Those options split the hierarchy, make the parent a provisioning bottleneck,
or preserve avoidable coast-to-coast latency.

**Consequences:** Affinity is immutable because changing the routing row cannot
move an existing object. Existing/missing-metadata/background-created rows use
`wnam` or `weur`; moving a live hierarchy still requires maintenance export and
import.

### 2026-08-17 — Workspace and work-stream control sockets become live synchronization planes

**What changed:** WorkspaceDO now keeps one persistent Electron socket with a
bounded SQL topic-version log and workspace-scoped message commands.
WorkstreamDO now serves complete revisioned common/viewer metadata over its own
hibernating socket. Selected and background-running work streams retain this
control socket alongside the direct SubstreamAgent feed.

**Why:** Settings/directories can change without a work stream being open, and
aggregate title/state/unread data can change independently of transcript token
traffic. The prior lazy, child-targeted workspace command connection provided
neither live workspace convergence nor an authoritative metadata channel.

**Considered and rejected:** Copying all D1 workspace rows into WorkspaceDO,
proxying child feeds through parent objects, and inferring sidebar metadata from
agent frames. They introduce a second workspace authority, a shared throughput
bottleneck, or a dependency on an active agent where none should exist.

**Consequences:** Every workspace mutation producer maps to a typed invalidation
topic; every WorkstreamDO nullable field participates in a full snapshot;
socket audiences and SQL receipts stay separate; and real-workerd tests must
force eviction for both control objects.

### 2026-08-17 — Control/data planes use jurisdictional IDs and hinted first placement

**What changed:** All workspace, work-stream, substream, scheduler, and crash
processor lookups use one resolver that selects `jurisdiction("us")` or
`jurisdiction("eu")`, derives the name-based ID there, and supplies a `wnam` or
`weur` location hint on every possible first `get()`. Product object constructors
validate `ctx.id.jurisdiction`, and ESLint rejects direct or aliased namespace
operations. The architecture now explicitly defines parent objects as the
control plane and direct `SubstreamAgent` traffic as the data plane.

**Why:** The previous EU-only helper left Global objects unrestricted, and three
effect-delivery paths bypassed it. Cloudflare maps the same name to different
jurisdictional IDs and honors a hint only on the first lookup, so partial use is
not a safety boundary. Routing data-plane streams through parents would also
undo the sharding benefit of one agent object per substream.

**Considered and rejected:** Region-prefixed names without jurisdiction locks,
hints only on creation endpoints, and parent-proxied feed traffic. They
respectively provide no placement guarantee, miss background first lookups, and
make a control object the shared throughput bottleneck.

**Consequences:** The maintenance import creates/populates the US/EU locked
target graph. A preexisting unrestricted Global object is a different identity
and cannot be a serving fallback. Hints improve initial latency but remain best
effort; future moves require an explicit migration. Local tests validate
arguments and invariants while skipping unsupported workerd jurisdictions.

### 2026-08-17 — Per-substream agent objects replace the one-room agent boundary

**What changed:** The hierarchy is now `WorkspaceDO -> WorkstreamDO ->
SubstreamAgent`. User writes enter the hibernating workspace command socket,
feeds stream directly from a child, the non-agent parent aggregates sidebar and
notification effects, and the child runs the complete Bind loop with durable
dispatch, targeted turn-boundary steering, local timers, and a custom
keep-alive.
Provider deltas are coalesced on a 100 ms/2,048-character boundary so the wire
rate is at most the chosen 10 fps presentation tier rather than token rate.

**Why:** Independent model contexts need independent ordering, loops, sockets,
compaction, timers, and failure domains, while a workspace still needs cheap
cross-work-stream queries and a work stream needs one aggregate sidebar state.

**Considered and rejected:** One agent object per work stream serializes every
substream; one object per turn/tool fragments context; the Agents SDK would
replace the established Bind harness for little value. Only its narrow
keep-alive lifecycle idea was ported.

**Consequences:** New context boundaries require explicit child provisioning and
parent aggregation. `WorkstreamDO` must remain model-free. Main child `0`
preserves the historical name; the later jurisdiction-lock change above defines
when maintenance imports that name into a distinct ID.

### 2026-08-17 — Durable Object persistence becomes SQL-only and constructor-gated

**What changed:** Every Durable Object class uses the shared append-only,
SQL-hash-checked SQLite migration runner under `blockConcurrencyWhile()`. The
runner upgrades the published `WorkstreamRoom` receipt ledger metadata without
rewriting its existing hashes. A custom
ESLint rule prohibits Durable Object KV persistence and modern workerd tests
exercise real migration, eviction, alarm, and hibernating-socket behavior.

**Why:** SQLite-backed Durable Objects still expose KV-shaped methods. Without a
code boundary, state can escape the visible schema, constraints, and migration
history even though the Cloudflare dashboard says “SQL.”

**Considered and rejected:** `durable-utils` and a bare `MAX(id)` runner. The
small local runner adds transaction ownership, drift/ahead detection,
foreign-key verification, and no external lifecycle dependency.

**Consequences:** Schema histories are immutable; data rewrites remain bounded
maintenance campaigns; tests must provide SQL rather than KV fakes.

### 2026-08-17 — Maintenance cutover makes object SQL authoritative

**What changed:** A regional maintenance generation imports frozen D1 product
rows into main child `0`, verifies them, activates the route, seeds the parent
projection, and permanently fences legacy product writers.

**Why:** Copying rows is not an authority switch. A no-dual-write maintenance
window makes the transition auditable and removes reconciliation ambiguity.

**Considered and rejected:** Live tailing, indefinite dual writes, and D1
fallback reads after activation.

**Consequences:** Object unavailability fails closed. D1 retains workspace and
regional query/control data but never reconstructs a missing transcript.
