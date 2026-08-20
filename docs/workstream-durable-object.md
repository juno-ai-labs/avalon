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

All five Durable Object classes in this subsystem (`WorkspaceDO`,
`WorkstreamDO`, `SubstreamAgent`, `BlockDashboardAgent`, and
`WorkspaceScheduler`) use SQLite-backed namespaces and explicit SQL only.
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
| `apps/api/src/durable-objects/workspace-product-schema.ts`, `workspace-product-storage.ts` | Strict WorkspaceDO activity, opportunity/provenance, ranking, and resolved-suggestion schema plus its transaction/lease repository. |
| `apps/api/src/durable-objects/workspace-domain-schema.ts`, `workspace-runtime-sql.ts` | Strict schemas for connector/Terminal/automation/digest/resource/note/memory/delivery domains and the transactionally executed trusted SQL RPC. |
| `apps/api/src/services/workspace-runtime-database.ts` | Allowlisted D1-compatible adapter: WorkspaceDO tables use native RPC, underlying control tables use D1, and mixed-authority transactions fail closed. |
| `apps/api/src/workflows/work-opportunity.ts` | Retryable admission and ranking compute using fenced WorkspaceDO RPC inputs and settlements. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Runtime-validated typed RPC contracts for cross-work-stream lists, visibility, scheduling, resource lookup, routing, feedback, and child effect application. |
| `apps/api/src/durable-objects/workstream-do.ts` | Non-agent aggregation of child directory/user effects, HyperSight configuration and refresh fan-out, complete metadata WebSocket snapshots, and the regional delivery outbox. |
| `apps/api/src/durable-objects/substream-agent.ts` | Authoritative substream SQL, direct Bind loop, hibernating feed socket, streaming checkpoints, timers, steering, and child-to-parent effect RPC. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | One durable Bind execution owner per stable HyperSight block, including dispatch recovery, keep-alive, fenced source-runtime access, resumable token checkpoints, hibernating block sockets, and result settlement. |
| `apps/api/src/durable-objects/durable-agent-runtime.ts` | Shared reference-counted keep-alive and single-flight drain primitives used by both agent Durable Objects. |
| `apps/api/src/durable-objects/block-dashboard-protocol.ts` | Runtime-validated WorkstreamDO control, block dispatch, result, and maintenance-import contracts. |
| `apps/api/src/durable-objects/rpc-result.ts` | Shared typed native-RPC status/body envelope used where former internal HTTP handlers must preserve status semantics without `stub.fetch()`. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Normalized `SubstreamAgent` schema and append-only schema versions. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Product transactions, message/run admission, read waterlines, compaction inputs, and local regional-effect creation. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | SQL repositories for replay, active output, alarms, inbox/outbox receipts, and projection versions. |
| `apps/api/src/durable-objects/workstream-runtime-sql.ts` | Restricted D1-compatible SQL adapter used by the Bind harness against object-local tables. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | Shared SQL-only constructor migration runner. |
| `apps/api/src/lib/durable-object-namespace.ts` | The only product-object stub resolver; applies jurisdiction, persisted workspace affinity, explicit singleton fallback, and runtime jurisdiction validation. |
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
claimed as `running`; constructor and alarm activation resume both queued and
abandoned-running rows after eviction. The harness attempt lease prevents a
replacement isolate from overlapping the previous owner. Once that lease
expires, replay resumes through the same run scope and tool receipts, so an
external write is not intentionally performed twice.

Legacy work-stream runs may still drain through `WorkstreamLoopWorkflow` before
the maintenance authority opens. New work-stream loops do not create a Workflow
after the switch. Non-workstream agent loops may continue using their generic
Workflow abstraction; this cutover changes only the work-stream-down runtime.

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
Live sockets are grouped by session and user and revalidated after at most 60
seconds. WorkstreamDO also requests immediate child sweeps after configuration,
visibility, or affected-viewer access changes. Token/checkpoint broadcasts
therefore remain object-local; they do not issue a D1 or parent RPC per frame.

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
ensures one in-isolate dispatcher drain at a time. Runtime ping/pong is handled
by WebSocket auto-response and does not wake the object.

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
substitutes for `compaction_jobs` or `compaction_checkpoints`.

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
suggestion feedback, or a mention notification writes a versioned envelope to
the child `durable_outbox` in the same SQLite transaction. The child sends those
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
feedback, activity, and mention delivery through one Cloudflare Queue outbox;
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
  -> mention delivery: typed RPC to WorkspaceDO
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
WorkspaceDO socket. Common and viewer rows retain separate monotonic waterlines,
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

### Maintenance-window cutover

The branch assumes no partial deployment and permits a maintenance window:

```text
legacy_open
  -> maintenance_draining
  -> maintenance_importing
  -> maintenance_verified
  -> durable_object_open
```

The drain rejects new HTTP/socket/queue work and waits for active legacy loops.
Import pages copy every legacy D1 work-stream product row into main
`SubstreamAgent 0`, preserving IDs and order. Verification checks table counts,
hashes, identities, references, and authority generation. Activation writes the
initial child projection to `WorkstreamDO`, synchronously flushes the resulting
common/user state to `WorkspaceDO`, verifies the workspace directory row,
imports the frozen legacy pins, and only then opens the regional route. Legacy
D1 product-table and pin triggers become permanent writer fences.

In the same maintenance campaign, `workspace_product_authority_routes` pages the
activity/opportunity graph and every workspace-scoped relational domain into
each WorkspaceDO in foreign-key order: connector and Slack state, Terminal
policy revisions, automations/digests/schedules, resources/notes/watches and R2
outboxes, memory, and notification intents. Activity insertion sequences, stable
IDs, leases, versions, credentials, resource references, and revision history
are preserved. A workspace product route must be `verified` and then `active`
before the serving-contract attestation can advance. Migration `0083` rejects
all legacy D1 writers as soon as import starts and scrubs imported connector
event bodies before open, so there is no dual-write or fallback path.

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
- **The WorkspaceDO directory is present before a D1 route becomes active.** Opening a route first creates a serving gap in which D1 is fenced and the sidebar has no authoritative row.
- **D1 workspace membership is rechecked for every workspace subscribe/command and every WorkstreamDO/SubstreamAgent/BlockDashboardAgent admission.** HyperSight attachments carry only a bounded 60-second authorization cache and receive explicit parent sweeps; no long-lived ticket or attachment is continuing authority for a new write.
- **Legacy D1 product rows are never a fallback after activation.** Fallback would silently split authority after an object failure.

## Boundary

This module owns work-stream-down Durable Object identity, SQL, message/run
ordering, sockets, local agent execution, and cross-object projection delivery.
It exposes typed product RPCs, four ticketed socket roles, and hash-checked regional
effects.

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
compaction recovery, HyperSight checkpoint recovery/revocation, obsolete queued
run coalescing, stale-arrival rejection, per-block parent head-of-line delivery,
ticket replay, and the read-only child socket.
Node tests cover migration
rollback/hash drift/ahead versions, normalized product SQL, authorization,
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
| `digest_schedules`, `digest_schedule_times`, `digest_delivery_targets`, `digest_deliveries`, `schedules` | User digest configuration/cursor/history plus the canonical due-work index for digests, automations, and connector polling. WorkspaceScheduler queries these rows through typed object SQL. |
| `resources`, `resource_watches`, `automation_resources` | Workspace resource metadata and workspace-level attachment/watch relationships. `content_ref` and derivative refs point to regional R2; each SubstreamAgent separately owns its work-stream link and resource inventory revision. |
| `resource_object_deletion_outbox`, `note_resource_deletion_outbox` | Durable lifecycle ownership for original, derivative, receipt, and note-linked R2 refs. Deletion bytes is a regional side effect performed only after an object-owned outbox claim. |
| `notes`, `note_transcript_segments`, `note_privacy_change_outbox` | Note authority, transcript segments and privacy-delivery intent. A note's linked resource is a real local foreign key. |
| `memory_scopes`, `memory_items`, `memory_mutations`, `memory_index_outbox` | Workspace/user/automation/work-stream memory facts, immutable mutation receipts and vector-index side effects. Work-stream/run IDs are opaque provenance, not foreign keys. |
| `memory_tables`, `memory_table_columns`, `memory_table_rows`, `memory_table_cells`, `memory_table_mutations` | Typed relational memory tables with local FTS indexes, schema/data revisions and durable mutation history. |
| `workstream_notification_intents`, `external_delivery_attempts` | Causally fenced mention intents plus the normalized ledger available to multi-destination delivery paths. Existing automation/digest transports keep their smaller idempotency receipts on their local target/receipt rows; all variants are WorkspaceDO-owned. Terminal mention shells are reaped by the per-workspace scheduler after 30 days. |
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
| `_sql_schema_migrations`, `_data_migrations`, `_migration_command_receipts`, `object_versions` | Schema/data/import versions and resumable maintenance receipts. |
| `workstream`, `substream_agent_identity`, `substreams` | Local root/authority, immutable external child identity, and LLM-array context metadata. Existing main data uses local context `0`. |
| `participants`, `member_attention` | Participation and personal read/mention waterlines; active workspace membership remains D1 authority. |
| `parts`, `part_attachments`, `part_mentions`, `content_refs` | One provider-neutral semantic order plus exact attachment, mention, and large-content joins. Tool UI rows project only as complete assistant-call/tool-result pairs; queued messages are fenced by their admitted run rather than leaking into an older run. |
| `runs`, `agent_run_dispatches`, `run_steering`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts` | Full-loop admission/recovery, targeted steering, frozen authority/context, and provider attempts. Terminal dispatch and spent wake-up rows age out after 180 days; `runs` is the durable record. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Planned/executed tools, replay fences, resumable activation, and human-input pauses. |
| `active_output_turns`, `active_output_chunks`, `active_agent_compaction`, `realtime_state` | Reconnect-safe partial output and active compaction phase, and the room sequence. `active_agent_compaction` is a singleton operational checkpoint; immutable summary history remains below. |
| `compaction_jobs`, `compaction_checkpoints`, `description_refresh_state` | Sequence/revision-fenced context derivations. Checkpoints are immutable per projection/run/sequence so a derived run can bind an exact compaction event rather than mutable “latest” state. |
| `workstream_wakeups`, `due_work` | Agent-created timers and other child-local alarm jobs. |
| `workstream_resource_links`, `resource_inventory_revision`, `suggested_actions` | Links to workspace resources, the authorization revision every relationship change advances (compat-routed changes included), and operational suggestion overlays. A suggestion is not transcript/model input unless acceptance explicitly authors a new part. |
| `block_dashboard_configuration_versions`, `block_dashboard_block_runs`, `block_dashboard_user_preferences` | Source-runtime compatibility records used by the Bind harness and maintenance import. WorkstreamDO is the post-cutover product authority for configuration, published run state, and viewer preference. |
| `terminal_workspace`, `terminal_commands`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | Durable Avalon state for the Daytona-backed Terminal plugin. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Versioned child-to-parent effects and inbound dedupe such as feed tickets. |

Compatibility views named `_runtime_*` map established D1-shaped repository SQL
onto these normalized tables. They are not duplicate storage or a second
authority.

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

### `WorkspaceScheduler`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable scheduler schema history. |
| `workspace_scheduler_state` | Singleton workspace identity for the scheduler object. |
| `scheduler_retry_states` | Per target attempt/retry timestamp, preventing a failing schedule, connector watch, wakeup, or Terminal reconciliation from causing a hot alarm loop. |

The scheduler queries WorkspaceDO for every workspace-scoped due schedule,
connector watch, resource/R2 cleanup, note privacy delivery, memory-index
outbox, Slack handoff, cross-work-stream wakeup, and Terminal target. Regional
D1 is used only to resolve identity/routing facts that are not product state. A
`SubstreamAgent` owns each agent-created timer row itself and the parent
directory sends only the next due timestamp required for workspace coordination.
Maintenance workers settle independently: a failed reaper is logged and
retained for retry while sibling cleanup tasks and due schedules continue in
the same alarm.

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
