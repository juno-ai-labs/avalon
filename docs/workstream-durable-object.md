# Workspace, work-stream, and substream Durable Objects

Avalon's regional stateful hierarchy is `WorkspaceDO -> WorkstreamDO ->
{SubstreamAgent, BlockDashboardAgent}`. There is one `WorkspaceDO` per
workspace, one non-agent `WorkstreamDO` per work stream, one `SubstreamAgent`
per independently addressable model context, and one `BlockDashboardAgent`
per stable configured HyperSight block. The main conversation is external
substream `0`.

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
| `apps/api/src/services/workspace-runtime-database.ts` | Allowlisted D1-compatible adapter: WorkspaceDO tables use native RPC, underlying control tables use D1, and mixed-authority transactions fail closed. |
| `apps/api/src/services/sidebar-reads.ts` | The one statement and row mapping per sidebar list, used by WorkspaceDO's batch read and by the REST services that route back into it. |
| `apps/api/src/workflows/work-opportunity.ts` | Retryable admission and ranking compute using fenced WorkspaceDO RPC inputs and settlements. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Runtime-validated typed RPC contracts for cross-work-stream lists, visibility, scheduling, resource lookup, routing, feedback, and child effect application. |
| `apps/api/src/durable-objects/workstream-do.ts` | Non-agent aggregation of child directory/user effects, HyperSight configuration and refresh fan-out, complete metadata WebSocket snapshots, and the regional delivery outbox. |
| `apps/api/src/durable-objects/substream-agent.ts` | Authoritative substream SQL, direct Bind loop, hibernating feed socket, streaming checkpoints, timers, steering, and child-to-parent effect RPC. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | One durable Bind execution owner per stable HyperSight block, including dispatch recovery, keep-alive, fenced source-runtime access, resumable token checkpoints, hibernating block sockets, and result settlement. |
| `apps/api/src/durable-objects/durable-agent-runtime.ts` | Shared reference-counted keep-alive and single-flight drain primitives used by both agent Durable Objects. |
| `apps/api/src/durable-objects/agent-run-dispatch-queue.ts` | The dispatch queue's leased claim and its wake-up derivation, shared by both agent objects. Derived from persisted rows only; read it before changing how either object schedules an alarm. |
| `apps/api/src/durable-objects/block-dashboard-protocol.ts` | Runtime-validated WorkstreamDO control, block dispatch, result, and maintenance-import contracts. |
| `apps/api/src/durable-objects/rpc-result.ts` | Shared typed native-RPC status/body envelope used where former internal HTTP handlers must preserve status semantics without `stub.fetch()`. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Normalized `SubstreamAgent` schema and append-only schema versions. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Product transactions, message/run admission, read waterlines, compaction inputs, and local regional-effect creation. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | SQL repositories for replay, active output, alarms, inbox/outbox receipts, and projection versions. |
| `apps/api/src/durable-objects/workstream-runtime-sql.ts` | Restricted D1-compatible SQL adapter used by the Bind harness against object-local tables. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | Shared SQL-only constructor migration runner. |
| `apps/api/src/durable-objects/migration-reporting.ts` | `withMigrationReport`, which wraps every constructor's migration call and reports the outcome to `avalon-migration-tracker`. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| `apps/api/src/lib/durable-object-namespace.ts` | The only product-object stub resolver; applies jurisdiction, persisted workspace affinity, explicit singleton fallback, and runtime jurisdiction validation. |
| `apps/api/src/lib/durable-object-self.ts` | Where an object recognizes its own name, so a shared helper addressing "the object that owns this work stream" reaches the caller directly instead of leaving it over RPC and coming back. Every Durable Object class registers here in its constructor. |
| `apps/api/src/lib/uuid-v7.ts` | RFC 9562 UUIDv7 generation for cross-socket/Queue event identities; ordering correctness remains in authority-local waterlines. |
| `apps/api/src/services/workstream-object-client.ts` | Typed Worker-to-`SubstreamAgent` product RPCs. |
| `apps/api/src/services/workstream-regional-effect-service.ts` | Queue consumer handoff into WorkspaceDO for directory/user/feedback/activity/notification effects. |
| `apps/api/src/durable-objects/workspace-scheduler.ts` | One SQLite-backed alarm coordinator per workspace; due workspace products are loaded from WorkspaceDO. |
| `scripts/eslint-rules/durable-object-sql-storage.mjs` | Rejects Durable Object `get`, `put`, `delete`, `list`, and async `transaction` KV calls, including aliases. |
| `scripts/eslint-rules/durable-object-region-routing.mjs` | Rejects direct/aliased namespace construction and use of the low-level region-only resolver. |
| `scripts/eslint-rules/durable-object-native-rpc.mjs` | Rejects internal Durable Object `fetch()` calls; HTTP `fetch()` remains for WebSocket upgrades and genuine HTTP flows. |
| `packages/db/migrations/0043_hypersight.sql` | Immutable deployed HyperSight baseline; its complete filename is the migration identity and must not change. |
| `packages/db/migrations/0078_rename_hypersight_to_block_dashboard.sql` | Forward-only rename from the deployed `hypersight_*` D1 vocabulary to internal `block_dashboard_*` identifiers. |
| `packages/db/migrations/0079_workstream_do_authority_cutover.sql` | Maintenance control, routes, import receipts, identity anchors, and permanent legacy-product/pin writer fences. |
| `packages/db/migrations/0080_workstream_do_regional_effects.sql` | Legacy causally fenced notification-intent shells; the activity/mention effect replay receipt is object-local (`workspace_workstream_effect_receipts`), never a D1 row. |
| `packages/db/migrations/0081_workstream_do_full_serving.sql` | Serving-contract attestation and idempotent workspace-driven work-stream creation receipts; it intentionally creates no directory projection tables. |
| `packages/db/migrations/0082_workspace_durable_object_placement_affinity.sql` | Immutable Global/regional workspace affinity projection and migration/background fallbacks. |
| `packages/db/migrations/0083_workspace_product_do_authority.sql` | Per-workspace product import routes plus permanent D1 writer fences for the migrated activity and opportunity families. |

## How it works

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

Avalon uses deterministic `idFromName` identities, so a separate opaque
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

one connection per selected or background-running work stream
  <- WorkstreamDO complete independently waterlined common + viewer metadata

one connection per selected or background-running substream
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
participation/listability, unread count, mention state, read-through and manual
unread waterlines, and latest mention sequence. It is always a full snapshot;
nullable values clear cached fields rather than behaving like absent patches.

### Full agent-loop execution

After `durable_object_open`, one `SubstreamAgent` runs one complete Bind harness
loop directly. A run is not one model turn: it includes every model/tool turn,
plugin activation, structured elicitation, compaction, Terminal interaction,
and terminalization needed to finish the admitted work. Bind remains the loop
implementation; Avalon does not depend on the Agents SDK.

Expected wall time is 2–30 minutes. Time to first token is normally 1–5 seconds,
ordinary tools take seconds, and a Daytona Terminal action may take 3–5 minutes
although p95 is expected below one minute. Rare coding sessions may run for more
than two hours. The durable run, attempt lease, tool receipts, final message, and
dispatch ledger—not an in-memory promise—are the recovery authority for all of
those durations.

`agent_run_dispatches` is the child-local durable dispatcher. `queued` work is
claimed as `running` under a `lease_expires_at` deadline, and both queued and
lease-expired running rows are resumed by the alarm after an eviction. The
lease is what makes "a run in flight" and "a run whose owner died" separable
without a live process to ask; a claim with no deadline is not recoverable
state. Two rules keep the queue live and are not negotiable:

- **The next alarm is a pure function of the rows.** No in-memory value may be
  an input to it. `SubstreamAgent.nextRunDispatchAt` and
  `BlockDashboardAgent.nextRunAt` both once consulted a "drain is active" flag
  and both went permanently inert because of it.
- **The alarm executes; callers only enqueue.** An RPC records the dispatch,
  arms the alarm, and returns. Durable work is never handed to a promise the
  invocation then abandons, because the runtime cancels it and cancellation
  raises nothing.

`agent-run-dispatch-queue.ts` owns both rules for both objects. While any row is
non-terminal the alarm is additionally floored at
`AGENT_RUN_DISPATCH_SWEEP_MS`, so a future scheduling defect costs one interval
rather than the run.

Construction releases every surviving lease. A lease is only ever held by a
living isolate and an object runs one isolate at a time, so a lease still
recorded when a new isolate boots was issued by one that is gone: its run is
recoverable immediately rather than at expiry. The lease duration therefore
bounds how long a *cancelled invocation within a living isolate* goes
unnoticed, not how long an eviction does. The harness attempt lease prevents a
replacement isolate from overlapping the previous owner. Once that lease
expires, replay resumes through the same run scope and tool receipts, so an
external write is not intentionally performed twice.

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
the internal runtime-SQL port: it resolves the transcript fence there and
stores the harness attempt, scope, inference attempts, tool receipts, and
terminal runtime record beside the source data they reference. The block DO's
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
BlockDashboardAgent -- fenced runtime SQL --> SubstreamAgent("0")
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
recomputes the alarm only from durable work. `DurableAgentDrain` similarly
ensures one in-isolate dispatcher drain at a time — deduplication only. It
never suppresses scheduling, and its result is awaited by the invocation that
started it rather than left to `waitUntil`. Runtime ping/pong is handled
by WebSocket auto-response and does not wake the object.

A keep-alive heartbeat is a separate Durable Object event. When it observes an
already active drain it never awaits that promise: joining would carry the alarm
across a model/tool loop that belongs to another request context, hold unrelated
alarm lanes open, and can invalidate later request-scoped I/O. It instead arms
a heartbeat no sooner than 30 seconds, excluding the already-due run row from
that calculation so the alarm cannot spin at `now + 1` while the run remains
active. Recent in-memory drain progress or an unexpired durable harness attempt
lease proves the owner is still healthy, including legitimate multi-hour runs.
After five minutes without progress, the agent checks that durable lease; only
when no live lease remains does it abandon the stranded promise and start a
fenced successor. The late predecessor cannot clear the successor because the
single-flight promise and dispatch lease tokens are both identity-fenced. The
same rule applies to `SubstreamAgent` and `BlockDashboardAgent`; the former
reads its local harness lease and the latter reads the source WorkstreamDO's
runtime lease.

The keep-alive alarm lowers the chance of eviction during a long model request,
external API wait, or computation. It is not correctness state. If an isolate
is evicted anyway, `agent_run_dispatches`, the attempt lease, run events, tool
receipts, streaming checkpoint, and final-message fence drive recovery.

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
stored once as an ordinary `parts` row and the active checkpoint is removed.
Token frames never write regional D1 and never update the sidebar.

Compaction uses the same ordered publication boundary but no token checkpoint.
`compaction_started` writes the singleton `active_agent_compaction` with its run,
harness attempt, index, trigger, and start time; the matching
`compaction_finished` deletes it only after the history checkpoint is durable
(or the attempt fails). A finish from an abandoned attempt cannot clear a
recovered attempt at the same run/index. Snapshot and resync frames carry that
singleton. It exists solely to restore the desktop activity indicator and never
substitutes for `compaction_checkpoints`.

The child keeps a bounded replay window in memory. A connected desktop can
switch from stream A to stream B and back with no loss: it sends its last room
sequence; the child replays when the window is present, otherwise it returns
`resync_required`, and the desktop rebuilds from the authoritative message feed
plus active checkpoint. The renderer may animate a received text batch one
token at a time; that presentation trick does not change durable text or cursor
semantics.

The newest bounded message page and its older/newer cursors ride in the initial
snapshot. Further pages are direct `load_message_page` requests against the
same child's local `parts`; replies are correlated to one socket and consume no
room sequence because they are queries, not shared events. The default page is
200 rows, the contract caps it at 250, and the encoded reply is capped at 900
KB by shortening the page toward the requested boundary while returning the
new continuation cursor. Electron automatically asks for the next older page
near the top and adjusts the scroll offset by inserted height, so the visible
message does not jump.

### Queueing and steering

Every admitted run is ordered in the selected child. Queue mode appends the new
message and run without changing the in-flight run.

Steer mode targets only the run that was active when the message committed.
`run_steering` records that run, message, and boundary count. Bind never aborts
an active model request or tool call. It observes the steering request at turn
boundaries: the current turn completes, and the old run stops no later than one
additional turn. A new run admitted for the steering message then reads the
persisted transcript fence. If the targeted run terminalized first, the stale
steer cannot affect a later run.

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

### Sidebar, activity, suggestions, and notifications

A product transaction that changes common metadata, a viewer overlay, activity,
suggestion feedback, or a person notification — a mention, or somebody being
added to the work stream — writes a versioned envelope to the child
`durable_outbox` in the same SQLite transaction. The child sends those
envelopes by RPC to its parent `WorkstreamDO`.

`WorkstreamDO` deduplicates by child/message/hash, stores the latest common and
per-user projection from each child, and computes one aggregate work-stream
view. Common state uses a deterministic state priority; last activity is the
maximum child timestamp. Viewer unread counts sum across children, while
participation, listability, and “You Are Mentioned” are logical ORs. Every
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
interest. Pins, resource links, and resolved suggestion feedback live beside
those rows so cross-work-stream queries are one local SQLite query rather than a
fan-out to every child. Electron requests cursor-paged rows over its existing
WorkspaceDO socket, and receives the sidebar itself on the answer to
`subscribe` — the first page together with the viewer's
`automation_subscriptions` and `notes` rows, since all three are this object's
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
receipt through typed RPC before creating a deterministic connector-event
Workflow. Large/raw bytes remain in R2. Regional D1 carries only opaque ingress
routes and provider-global receipts needed before one workspace is known; no
live event body is written there. Connection-scoped webhook replay receipts live
in WorkspaceDO. Legacy D1 activity bodies are imported and scrubbed during the maintenance
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
| WorkspaceDO/Worker | SubstreamAgent | typed RPC | idempotent child product transaction or run-dispatch row |
| SubstreamAgent | WorkstreamDO | typed RPC | child `durable_outbox`; parent receipt/aggregate/outbox transaction |
| SubstreamAgent("0") | WorkstreamDO | typed RPC | child pending refresh plus parent fan-out rows |
| WorkstreamDO | BlockDashboardAgent | typed RPC | parent dispatch outbox; block dispatch ledger |
| BlockDashboardAgent | SubstreamAgent("0") | typed RPC | block run ledger plus source-local runtime/tool receipts |
| BlockDashboardAgent | WorkstreamDO | typed RPC | terminal outcome retained until the parent result receipt accepts it |
| WorkstreamDO | regional Worker | Cloudflare Queue | every directory/user/feedback/activity/mention change is retained in the parent outbox; the message is an opaque UUIDv7 wake-up |
| regional Queue Worker | WorkspaceDO | typed RPC | unordered directory/user/feedback envelope; generation + per-key waterline, hash receipt, and authoritative directory/index transaction |
| regional Queue Worker | WorkspaceDO | typed RPC | first-party activity event, all target edges, and the replay receipt commit atomically; the object-local sequence is the digest/feed cursor |
| regional Queue Worker | WorkspaceDO | typed RPC | notification intent, bounded destination payload, and the replay receipt commit atomically; current user/member identity is resolved from D1 before the call and crosses as data |
| connector ingress Worker | regional Queue | Cloudflare Queue | one bounded normalized event plus region/workspace/ingress UUID/content hash per workspace target; raw bytes remain in R2 |
| regional Queue Worker | WorkspaceDO | typed RPC | complete normalized connector event plus content hash; object-local provider/dedupe constraints and ingress receipt choose the canonical ID |
| regional Queue Worker | ConnectorEventWorkflow | Workflow binding | deterministic instance created only after WorkspaceDO acceptance; duplicate instance conflict is success |
| ConnectorEventWorkflow | WorkspaceDO | typed RPC | claim/load/terminal settlement against the canonical event; Workflow retries never trust Queue delivery count or order |
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

Creation replays are repair operations. If the authoritative child transaction
committed but building or delivering its parent snapshot failed, repeating
`initialize` rebuilds the `common` and `user:<id>` effects. `projection_keys`
suppresses an already-delivered identical snapshot, so retries close a missing
directory gap without producing sidebar churn.

Mention intent delivery rechecks current D1 membership and WorkspaceDO-owned
destination state only after WorkspaceDO reports the required viewer-directory version. This prevents an
out-of-order notification from emailing someone whose access or listability was
removed. Delivery compute remains a regional Worker/service, but intent,
attempt, idempotency key, frozen destination, and provider receipt are
WorkspaceDO rows. They must not be copied into a child.

### SQL-only schema migration

Every constructor gates requests with `state.blockConcurrencyWhile()` and calls
the shared migration runner. Its contract is stronger than a bare `MAX(id)`
example:

1. create strict `_sql_schema_migrations` if absent;
2. validate positive, strictly increasing, append-only versions;
3. compare the deterministic implementation hash of every applied version;
4. apply each version's SQL and receipt in one `transactionSync` transaction;
5. reject an object whose schema is ahead of the Worker or whose historical SQL
   was edited;
6. run `PRAGMA foreign_key_check`, then `PRAGMA optimize` after changes.

Migration definitions may not include their own `BEGIN`, `COMMIT`, or
`ROLLBACK`; the runner owns atomicity. Constructor migrations are bounded DDL.
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
- **Every Durable Object persists through explicit SQL.** KV calls create invisible schema and bypass migration, constraints, inspection, and lint.
- **Room sequence and active text commit atomically.** Advancing only the cursor loses streamed text after eviction.
- **One unexpired attempt lease owns a child run.** Two owners can duplicate an external tool effect or terminal assistant message.
- **A steering record names the targeted run.** A generic “steer next” flag can stop an unrelated future run.
- **Compaction results cannot cover rows above their input fence.** Otherwise a message accepted during summarization disappears from model context.
- **Child-to-parent and parent-to-workspace effects are hash-deduplicated and versioned.** RPC retries, Queue ordering, and delivery uniqueness are not trusted.
- **Nothing may `await` between a sync waterline's allocation and its send.** The waterline is a monotonic counter and the desktop discards anything at or below the last one it applied, so a publication that allocated first has to send first. `publishSync` allocates in `transactionSync` and sends in the same synchronous run, which is what makes that true; an `await` between the two opens the input gate and lets a later publication overtake, and the desktop then silently drops the parked payload along with every topic it named. This is not hypothetical — it is the bug the revalidation sweep shipped, recorded in the changelog.
- **No publish path asks D1 anything.** Losing workspace access is carried by the queue in [`access-revocation.md`](access-revocation.md) and by nothing else — no object polls, revalidates on a timer, or re-reads `workspace_members` before sending. Putting a D1 query back on a publish path is where the waterline ordering bug came from, and the transcript feed would pay it per token frame. An object enforcing its *own* SQL — `canRead`, `product.canRead` — is not that: it is synchronous, local, and answers a question no queue message carries.
- **D1 workspace membership is rechecked for every workspace subscribe/command and every WorkstreamDO/SubstreamAgent/BlockDashboardAgent admission.** Admission is where authorization is decided, and it is decided fresh every time; no long-lived ticket or attachment is continuing authority for a new write. What an admitted socket then holds is ended by the revocation queue, not by re-asking.
- **A product request names its auth principal, and each is verified against the fact that owns it.** (An *auth* principal — who is asking — is distinct from the run's `ExecutionPrincipal`, which names whose authority a run spends.) A login session (`principal` absent) is re-verified against its `sessions` row joined to membership, which is what makes a revoked login stop working mid-flight. A connector principal (`principal: "connector"`, connector ingress only) has no session row — its standing authority is the connector link, verified by the Worker on the very message being delivered — so the object re-checks membership alone (`connectorPrincipalAuth`) and refuses staleness as `connector_member_revoked`. Sockets never carry a connector principal; tickets are issued to login sessions only.
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
| Workspace socket hibernates | Runtime restores attachments; replayed tickets are rejected, topic waterlines resume, and pending commands resend under the same client message ID. |
| Workstream metadata socket hibernates | Runtime restores identity; subscribe returns a complete authoritative viewer snapshot and later effects push newer revisions. |
| Child evicted during a 2–30 minute or rare 2+ hour run | Keep-alive reduces occurrence; dispatch ledger plus lease resumes after activation/expiry. |
| Feed replay window lost | Child sends `resync_required`; desktop reloads canonical parts and active output checkpoint. |
| Transcript page requested | The agent accepts an opaque before/after cursor, defaults to 200 rows, and rejects limits above 250. A per-socket request has a 15-second desktop timeout and is queued again after reconnect without advancing the room cursor. |
| Encoded transcript page would exceed 900 KB | The agent shortens the page toward the requested boundary and returns an adjusted continuation cursor. A single defensive oversize message produces a correlated `message_page_too_large` error instead of an oversized frame. |
| Historical-page read loses authorization | The agent returns a correlated authorization error and closes the revoked socket with policy code 1008; cached history is not treated as current authority. |
| Somebody loses access while holding sockets | A queue message per object closes their sockets; a failed hop retries and then dead-letters. Nothing else closes them, so a message that is never published leaves the socket open until the client reconnects. See [`access-revocation.md`](access-revocation.md). |
| RPC or Queue duplicates/reorders effects | Stable IDs/hashes deduplicate immutable effects; generation/version orders WorkspaceDO state and delivery receipts. |
| WorkspaceDO, parent, or Queue unavailable | The source outbox remains pending and alarms retry with bounded backoff. User transcript commits are not rolled back. |
| D1 unavailable during a user command | Command fails closed before mutation because current session/membership cannot be established. |
| Model/tool wait exceeds the attempt lease | Heartbeats extend an owned attempt; after genuine abandonment a new executor waits for expiry and replays through receipts. |
| Substream child not provisioned | No feed ticket should be issued; the object must not bootstrap product authority from an untrusted socket route. |
| Object approaches SQLite storage limit | Alert and archive/export; do not split one ordered child implicitly. Cloudflare's per-object limit is 10 GB. |

The realtime in-memory window is an optimization. Canonical parts and active
output are SQL. Provider fragments are batched; regional D1 sees semantic
projection changes only, not token cadence.

## Testing

Run:

```bash
pnpm --filter @avalon/api test
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
and work-stream control sockets, typed native-RPC success/conflict envelopes,
bidirectional message pages without room-cursor movement, page revocation,
compaction recovery, HyperSight checkpoint recovery/revocation, socket
revocation across all four roles, obsolete queued
run coalescing, stale-arrival rejection, per-block parent head-of-line delivery,
ticket replay, and the read-only child socket.
Node tests cover migration
rollback/hash drift/ahead versions, normalized product SQL, compatibility-view
replay deduplication and same-row tool settlement, authorization — including
the product API's session and connector principals in
`test/workstream-room-authorization.test.ts` —
effect idempotency, streaming checkpoints, and renderer socket switching.
Desktop tests cover page merging, reconnect queueing, direction-neutral page
errors, scroll threshold/anchor preservation, compaction reconciliation, and
HyperSight full-checkpoint replacement. `scripts/durable-object-native-rpc.test.mjs`
proves the custom lint rule rejects direct, computed, aliased, optional, and
typed-stub internal fetches without flagging unrelated HTTP clients.
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
All Durable Object tables are SQLite `STRICT` tables, use integer Unix
milliseconds internally, bound inline/JSON payloads, and keep external object
identity in one singleton rather than repeating it on every child row. Live
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
| `workspace_connector_events` | Complete authoritative normalized provider event, connection/workspace scope, bounded JSON/text fields, provider/dedupe unique keys, local insertion sequence, and Workflow claim/terminal state. It is never shared with another workspace. |
| `workspace_connector_event_ingress_receipts` | One ingress UUID/content-hash to canonical-event mapping. It makes provider replay and at-least-once Queue delivery idempotent even when a second delivery used a different UUIDv7; ingest opportunistically reaps the oldest receipts after 30 days while the provider/dedupe keys continue to resolve the canonical event. |
| `connector_connections`, `external_user_identities` | Workspace connector credentials, cursor/configuration/health, model plugin identity, refresh lease, and verified provider-user mappings. Global/provider ingress routes retain only the opaque fields needed to find this object. |
| `slack_agent_*`, `slack_delivery_preferences`, `slack_user_links`, `slack_ingress_jobs`, `slack_link_challenges`, `slack_unfurled_links` | Workspace-local Slack policy, allowlist, identity, execution session, queued handoff, delivery preference, and shared-link state. Global Slack installation routing remains outside the object because the workspace is not known at initial ingress. |
| `workspace_sandbox_network_policies`, `workspace_sandbox_network_domains`, `workspace_sandbox_network_policy_mutations` | Terminal network/egress authority, current verified revision, domain set, and complete preview/confirm/result history. Substream terminal state stores only the applied revision and rechecks this object before reuse. |
| `automation_templates`, `automation_template_versions`, `automation_subscriptions`, `automation_runs`, `automation_resources`, `automation_delivery_targets`, `automation_email_receipts`, `automation_email_rate_windows` | Complete workspace automation definition, immutable versions, draft/active lifecycle, trigger/run state, resource links, inbound-email receipts/rate windows, and frozen delivery configuration. Work-stream IDs are opaque references into child authority. |
| `digest_schedules`, `digest_schedule_times`, `digest_delivery_targets`, `digest_deliveries`, `schedules` | User digest configuration/cursor/history plus the canonical due-work index for digests, automations, and connector polling. This object's own alarm reads them directly and mirrors each due time into `_internal_durable_alarms`; see [`durable-object-alarms.md`](durable-object-alarms.md). |
| `resources`, `resource_watches`, `automation_resources` | Workspace resource metadata and workspace-level attachment/watch relationships. `content_ref` and derivative refs point to regional R2; each SubstreamAgent separately owns its work-stream link and resource inventory revision. |
| `resource_object_deletion_outbox`, `note_resource_deletion_outbox` | Durable lifecycle ownership for original, derivative, receipt, and note-linked R2 refs. Deletion bytes is a regional side effect performed only after an object-owned outbox claim. |
| `notes`, `note_transcript_segments`, `note_privacy_change_outbox` | Note authority, transcript segments and privacy-delivery intent. A note's linked resource is a real local foreign key. |
| `memory_scopes`, `memory_items`, `memory_mutations`, `memory_index_outbox` | Workspace/user/automation/work-stream memory facts, immutable mutation receipts and vector-index side effects. Work-stream/run IDs are opaque provenance, not foreign keys. |
| `memory_tables`, `memory_table_columns`, `memory_table_rows`, `memory_table_cells`, `memory_table_mutations` | Typed relational memory tables with local FTS indexes, schema/data revisions and durable mutation history. |
| `workstream_notification_intents` | Causally fenced person-notification intents, `notification_kind` in (`mention`, `participant_added`). Automation and digest transports keep their idempotency receipts on their own target/receipt rows; all variants are WorkspaceDO-owned. Terminal mention shells are reaped by this object's `notification_intents` maintenance alarm after 30 days. |
| `workstream_email_receipts` | Inbound-email processing idempotency keyed `(resend_email_id, workstream_id)` with the expiring exclusive lease a Worker holds while it fetches, stores, and posts one email. Claim, renewal, settlement, and failure all serialize in this object once the route is open; the legacy pre-cutover branch settles the same shape in one regional D1 batch instead. |
| `realtime_transcription_ticket_receipts`, `realtime_transcription_sessions` | Dictation socket admission: one-time consumption of the signed ticket's `jti` and the short concurrency leases the per-user/per-workspace session caps are counted over. The expiry sweep, ticket consume, and cap-checked insert run as one serialized transaction, which is what makes the caps race-free. Epochs are Unix seconds — the signed ticket's external contract and the one departure from the object's unix-ms rule — so the columns carry the unit (`*_s`); the import maps the unitless D1 names over. |
| `workspace_directory_state` | Singleton monotonically increasing `waterline` used to order page membership/pin reconciliation. |
| `workspace_workstream_directory` | One authoritative common row per work stream, fenced by authority generation, per-common `waterline`, UUIDv7 `source_event_id`, and hash. Supplies title, description/preview, scope/state, provenance, planning, attention, recency, archive, wakeup, and Terminal scheduling fields. |
| `workspace_workstream_viewers` | One authoritative viewer overlay per work stream/user, independently fenced by generation, viewer `waterline`, UUIDv7 source event, and hash. It supplies participation, listability, unread/mention state, and read fences and cascades from the common row. |
| `workspace_workstream_pins` | User-ordered pins referencing the directory row; all pin writes and reorder operations execute in this object. |
| `workspace_workstream_resource_links` | Inverted resource-to-work-stream/watch index derived from authoritative child relationships, enabling connector and authorization lookup without cross-object SQL. |
| `workspace_workstream_suggestion_feedback` | Resolved work-stream action feedback indexed for workspace discovery and ranking. The action itself remains in its SubstreamAgent. |
| `workspace_workstream_effect_receipts` | Message/hash receipts making WorkstreamDO-to-WorkspaceDO effect retries idempotent — directory effects and the regional activity/mention effects alike; each receipt commits in the same transaction as the row it acknowledges, and inserts age receipts out after 30 days. |
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

Visibility enumeration is cursor-paged by work-stream ID with a hard 250-row
page limit. Callers follow `nextCursor`; no RPC materializes every visible work
stream for a large workspace in one object invocation.

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
| `parts`, `part_attachments`, `part_mentions`, `content_refs` | One provider-neutral semantic order plus exact attachment, mention, and large-content joins. One stable tool part advances in place from started to its terminal state even though both its id and `client_message_id` conflict; a different part under the same client id remains an ignored replay. A terminal `tool_effects` update also projects into the same-id visible tool part, so alarm/reaper settlement cannot leave a started card behind. Tool UI rows project only as complete assistant-call/tool-result pairs; queued messages are fenced by their admitted run rather than leaking into an older run. |
| `runs`, `agent_run_dispatches`, `run_steering`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts` | Full-loop admission/recovery, targeted steering, frozen authority/context, and provider attempts. Terminal dispatch and spent wake-up rows age out after 180 days; `runs` is the durable record. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Planned/executed tools, replay fences, resumable activation, and human-input pauses. |
| `active_output_turns`, `active_output_chunks`, `active_agent_compaction`, `realtime_state` | Reconnect-safe partial output and active compaction phase, and the room sequence. `active_agent_compaction` is a singleton operational checkpoint; immutable summary history remains below. |
| `compaction_checkpoints`, `description_refresh_state` | Sequence/revision-fenced context derivations. Checkpoints are immutable per projection/run/sequence so a derived run can bind an exact compaction event rather than mutable “latest” state. |
| `workstream_wakeups`, `due_work` | Agent-created timers and other child-local alarm jobs. |
| `workstream_resource_links`, `resource_inventory_revision`, `suggested_actions` | Links to workspace resources, the authorization revision every relationship change advances (compat-routed changes included), and operational suggestion overlays. A suggestion is not transcript/model input unless acceptance explicitly authors a new part. |
| `block_dashboard_configuration_versions`, `block_dashboard_block_runs`, `block_dashboard_user_preferences` | Source-runtime compatibility records used by the Bind harness and maintenance import. WorkstreamDO is the post-cutover product authority for configuration, published run state, and viewer preference. |
| `terminal_workspace`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | Durable Avalon state for the Daytona-backed Terminal plugin. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Versioned child-to-parent effects and inbound dedupe such as feed tickets. |

`parts.sequence_number` is transcript order, including tool and system rows.
`parts.attention_ordinal` is the independent people-visible main-substream
waterline used by unread tracking. Product messages expose the latter as the
nullable `attentionSequenceNumber`; tool/transient rows carry `null`. Desktop
read receipts and unread anchors must never substitute transcript sequence for
that field, including while an older Worker omits the optional wire property.

Compatibility views named `_runtime_*` map established D1-shaped repository SQL
onto these normalized tables. They are not duplicate storage or a second
authority. For a compatibility-view mutation, `_runtime_statement_changes` is
the semantic row count returned to the caller. workerd's native cursor count
also includes bookkeeping and projection rows touched inside the `INSTEAD OF`
trigger, so using that physical count would misclassify a first receipt write
as a replay. Direct normalized-table mutations continue to use the native
count.

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
`agent_run_dispatches`, attempt leases, child and parent `durable_outbox`,
WorkspaceDO external-delivery attempts, and authority route/generation before retrying a
quarantined object. The maintenance control plane can quarantine a failed route;
operators must never reopen legacy D1 writers or an unrestricted predecessor as
recovery. Cloudflare does not move an existing object when a hint changes; a
placement/jurisdiction change requires the same explicit maintenance export,
import, verification, and authority switch used here.

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
through a stub returned by `durableObjectSelf`, and that path does not
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

**Why:** being added was the one thing that could happen to a person in Avalon
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
traces joined by an `avalon.socket.connection_id` attribute instead.

**Consequences:** An operation outside the three traced flows opens no spans, so
tracing a fourth means naming its flow rather than reusing one. The upgrade and
the subscription only meet through `avalon.socket.connection_id`, so anything
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

**Consequences:** New Avalon-owned IDs in the agent-serving boundary expose an
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
existing harness for lifecycle helpers Avalon can implement narrowly.

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
