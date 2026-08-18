# Workspace, work-stream, and substream Durable Objects

Avalon's regional stateful hierarchy is `WorkspaceDO -> WorkstreamDO ->
{SubstreamAgent, HyperSightBlockAgent}`. There is one `WorkspaceDO` per
workspace, one non-agent `WorkstreamDO` per work stream, one `SubstreamAgent`
per independently addressable model context, and one `HyperSightBlockAgent`
per stable configured HyperSight block. The main conversation is external
substream `0`.

All five Durable Object classes in this subsystem (`WorkspaceDO`,
`WorkstreamDO`, `SubstreamAgent`, `HyperSightBlockAgent`, and
`WorkspaceScheduler`) use SQLite-backed namespaces and explicit SQL only.
Durable Object key/value persistence is
forbidden by lint. Regional D1 remains the authority for workspace membership,
connector and automation control state, routing, and cross-work-stream query
projections; it is not a transcript fallback after cutover.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/names.ts` | The only constructors for deterministic workspace, work-stream, and substream object names. |
| `apps/api/src/durable-objects/workspace-do.ts` | Hibernating workspace synchronization/command socket, bounded topic replay, and one-time workspace-ticket receipts. |
| `apps/api/src/durable-objects/workstream-do.ts` | Non-agent aggregation of child directory/user effects, HyperSight configuration and refresh fan-out, complete metadata WebSocket snapshots, and the regional delivery outbox. |
| `apps/api/src/durable-objects/substream-agent.ts` | Authoritative substream SQL, direct Bind loop, hibernating feed socket, streaming checkpoints, timers, steering, and child-to-parent effect RPC. |
| `apps/api/src/durable-objects/hypersight-block-agent.ts` | One durable Bind execution owner per stable HyperSight block, including dispatch recovery, keep-alive, fenced source-runtime access, resumable token checkpoints, hibernating block sockets, and result settlement. |
| `apps/api/src/durable-objects/durable-agent-runtime.ts` | Shared reference-counted keep-alive and single-flight drain primitives used by both agent Durable Objects. |
| `apps/api/src/durable-objects/hypersight-protocol.ts` | Runtime-validated WorkstreamDO control, block dispatch, result, and maintenance-import contracts. |
| `apps/api/src/durable-objects/rpc-result.ts` | Shared typed native-RPC status/body envelope used where former internal HTTP handlers must preserve status semantics without `stub.fetch()`. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Normalized `SubstreamAgent` schema and append-only schema versions. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Product transactions, message/run admission, read waterlines, compaction inputs, and local regional-effect creation. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | SQL repositories for replay, active output, alarms, inbox/outbox receipts, and projection versions. |
| `apps/api/src/durable-objects/workstream-runtime-sql.ts` | Restricted D1-compatible SQL adapter used by the Bind harness against object-local tables. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | Shared SQL-only constructor migration runner. |
| `apps/api/src/lib/durable-object-namespace.ts` | The only product-object stub resolver; applies jurisdiction, persisted workspace affinity, explicit singleton fallback, and runtime jurisdiction validation. |
| `apps/api/src/services/workstream-object-client.ts` | Typed Worker-to-`SubstreamAgent` product RPCs. |
| `apps/api/src/services/workstream-regional-effect-service.ts` | Regional D1 inbox, sidebar/activity projections, and notification delivery. |
| `apps/api/src/durable-objects/workspace-scheduler.ts` | One SQLite-backed alarm coordinator per workspace. |
| `scripts/eslint-rules/durable-object-sql-storage.mjs` | Rejects Durable Object `get`, `put`, `delete`, `list`, and async `transaction` KV calls, including aliases. |
| `scripts/eslint-rules/durable-object-region-routing.mjs` | Rejects direct/aliased namespace construction and use of the low-level region-only resolver. |
| `scripts/eslint-rules/durable-object-native-rpc.mjs` | Rejects internal Durable Object `fetch()` calls; HTTP `fetch()` remains for WebSocket upgrades and genuine HTTP flows. |
| `packages/db/migrations/0077_workstream_do_authority_cutover.sql` | Maintenance control, routes, import receipts, projections, and legacy D1 writer fences. |
| `packages/db/migrations/0078_workstream_do_regional_effects.sql` | Regional effect inbox and causally fenced notification intents. |
| `packages/db/migrations/0080_workspace_durable_object_placement_affinity.sql` | Immutable Global/regional workspace affinity projection and migration/background fallbacks. |

## How it works

### Object hierarchy and identity

Names include region for operator clarity and deterministic routing:

```text
WorkspaceDO       <region>:<workspace-id>                    in WORKSPACE_DOS
WorkstreamDO      <region>:<workspace-id>:<workstream-id>    in WORKSTREAM_DOS
SubstreamAgent 0  <region>:<workspace-id>:<workstream-id>    in SUBSTREAM_AGENTS
SubstreamAgent N  <region>:<workspace-id>:<workstream-id>:<substream-id>
HyperSight block  <region>:<workspace-id>:<workstream-id>:hypersight:<block-id>
                                                              in HYPERSIGHT_BLOCK_AGENTS
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

The main child deliberately retains the historical object name in the renamed
`SUBSTREAM_AGENTS` binding. Wrangler's `renamed_classes` migration preserves the
class/storage namespace relationship, but it does not make an unrestricted
Global ID equal the new US-jurisdiction ID. The maintenance import therefore
populates the locked target graph from frozen D1 and never serves an
unrestricted predecessor as fallback. An already-EU-restricted predecessor can
retain its jurisdictional identity through the class rename.

`WorkspaceDO` is workspace synchronization/command control only. `WorkstreamDO`
owns aggregate metadata plus HyperSight configuration, refresh fan-out, and
published block state; it never runs a model. `SubstreamAgent` owns its
transcript and full conversation loop. Each `HyperSightBlockAgent` owns the
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
workspace commands, own resource metadata/directory aggregation, coordinate
HyperSight refreshes, and provide the one parent outbox for list, sidebar,
notification, and regional delivery effects. `SubstreamAgent` is the
fine-grained data-plane shard for one ordered conversation and agent loop;
`HyperSightBlockAgent` is the independent execution shard for one derived
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
  <- versioned workspace query-topic invalidations
  -> create_message naming the target work stream/substream

one connection per selected or background-running work stream
  <- WorkstreamDO complete revisioned common + viewer metadata

one connection per selected or background-running substream
  <- SubstreamAgent snapshot / stream frames / product events
  <- direct download and reconnect feed for exactly one substream

one connection per configured HyperSight block while its panel is visible
  <- HyperSightBlockAgent run snapshot / stream checkpoint / result
  <- direct reconnect replacement; no source conversation or user commands

user create_message after creation
  -> persistent WorkspaceDO socket
  -> per-command D1 session + membership recheck
  -> WorkstreamObjectClient for the selected SubstreamAgent
  -> local SQLite message/run transaction
```

The workspace socket is opened once per authenticated Electron renderer after
regional session/workspace activation and survives work-stream navigation. Its
SQL event log contains monotonically
versioned topic invalidations, not duplicate workspace rows. A reconnect replays
the bounded log when available and otherwise invalidates every workspace query
surface. A user message is never accepted on either read socket; a
`create_message` sent there receives `workspace_socket_required`. This keeps
workspace authorization and routing at the parent boundary while keeping the
high-volume read/stream path direct to its child.

All four socket roles use short-lived, audience-specific, single-use tickets. The
edge Worker verifies the signed ticket and passes only verified headers to the
object. `WorkspaceDO` consumes tickets in `workspace_socket_ticket_receipts`,
`WorkstreamDO` uses `workstream_socket_ticket_receipts`, and `SubstreamAgent`
uses `durable_inbox_receipts`. Each `HyperSightBlockAgent` uses
`hypersight_socket_ticket_receipts`. A ticket for one purpose cannot be replayed
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
for those rows. Producers publish the affected topic only after their mutation,
and Electron refetches using its existing authenticated REST contract.

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

Each outbox row resolves a stable `HyperSightBlockAgent` name using the
workspace's jurisdiction and placement affinity. That object runs the complete
read-only Bind loop directly. It does not use the Agents SDK or a Cloudflare
Workflow. `HyperSightBlockAgent` talks directly to `SubstreamAgent("0")` through
the internal runtime-SQL port: it resolves the transcript fence there and
stores the harness attempt, scope, inference attempts, tool receipts, and
terminal runtime record beside the source data they reference. The block DO's
own SQL dispatch row is the durable execution and recovery boundary, so an
eviction does not require the parent or source to retain an in-memory promise.
It permits at most one unsettled running dispatch. When a fresher refresh
arrives, all older queued dispatches are durably terminalized as
`hypersight_run_superseded`; the current running dispatch is allowed to settle
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
WorkstreamDO -- versioned durable fan-out --> HyperSightBlockAgent(block-id)
HyperSightBlockAgent -- fenced runtime SQL --> SubstreamAgent("0")
HyperSightBlockAgent -- versioned result settlement --> WorkstreamDO
HyperSightBlockAgent -- state + stream checkpoints --> Electron
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
singleton, coalescing `hypersight_source_refresh_outbox` row before contacting
main `SubstreamAgent("0")`. A crash after configuration commit therefore delays
the refresh but cannot silently lose it.

### Keep-alive without the Agents SDK

`DurableAgentKeepAlive.keepAlive()` and `.while()` are a narrow custom port of
the useful Agents SDK lifecycle behavior shared by `SubstreamAgent` and
`HyperSightBlockAgent`. The first reference ensures an alarm no later than 30
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
participation, listability, and “You Are Mentioned” are logical ORs. The parent
then owns the sole regional outbox for that work stream:

```text
SubstreamAgent SQLite product transaction
  -> child durable_outbox
  -> authenticated RPC to WorkstreamDO
  -> WorkstreamDO child receipt + aggregate + durable_outbox transaction
  -> opaque Cloudflare Queue wake-up
  -> regional Worker fetches the envelope from WorkstreamDO
  -> D1 projection/activity/notification intent + inbox receipt batch
  -> acknowledgement RPC deletes the parent outbox item
```

`workstream_directory_projections` supplies workspace-wide Work Streams, In
Progress, and Completed sections using title, description/preview, state, and
last activity. `workstream_directory_user_projections` supplies unread count,
participation, listability, “You Are Mentioned,” and the Home/sidebar list of
work streams of interest. D1 does not synchronously fan out to every child to
render a workspace.

Connector events are owned by one workspace and remain in that workspace's
regional D1 activity-ingestion tables because digests, routing, and suggestions
query across work streams. When an event is attached/admitted to a particular
work stream, the child stores its delivery receipt and relevant resource link.
Work-stream-specific suggested actions live in that child; workspace-level
suggested work streams/actions stay in regional D1. Accepted/dismissed local
feedback projects back through the same parent bridge.

### Durable Object communication: RPC versus Queue

Every object-to-object command uses a typed native RPC method. HTTP `fetch()` is
reserved for WebSocket upgrades because that platform flow must return a 101
`Response`; lint rejects `/internal/*` stub fetches. The complete relationship
map is:

| Sender | Receiver | Primitive | Durable handoff |
| --- | --- | --- | --- |
| WorkspaceDO/Worker | SubstreamAgent | typed RPC | idempotent child product transaction or run-dispatch row |
| SubstreamAgent | WorkstreamDO | typed RPC | child `durable_outbox`; parent receipt/aggregate/outbox transaction |
| SubstreamAgent("0") | WorkstreamDO | typed RPC | child pending refresh plus parent fan-out rows |
| WorkstreamDO | HyperSightBlockAgent | typed RPC | parent dispatch outbox; block dispatch ledger |
| HyperSightBlockAgent | SubstreamAgent("0") | typed RPC | block run ledger plus source-local runtime/tool receipts |
| HyperSightBlockAgent | WorkstreamDO | typed RPC | terminal outcome retained until the parent result receipt accepts it |
| WorkstreamDO | regional Worker | Cloudflare Queue | parent regional outbox plus opaque wake-up; D1 inbox then RPC ack |

Queues are deliberately used only at the regional fan-out boundary, where
buffering many independent work streams, consumer concurrency, and delivery
isolation are useful. A Queue cannot target a particular parent DO; it needs a
Worker consumer to resolve that DO and make another RPC. More importantly,
`queue.send()` cannot commit atomically with a child's SQLite product mutation.
Changing SubstreamAgent-to-WorkstreamDO to Queue would therefore **not delete
the child outbox**: the safe path would be child transaction/outbox, alarm,
Queue, consumer, parent RPC, parent receipt, and acknowledgement. That adds a
hop, cost, latency, route reconstruction, and best-effort Queue ordering while
retaining the code that makes the handoff durable. Direct RPC plus the existing
SQL outbox is smaller and preserves per-stub E-order; Queue remains appropriate
only if future load requires explicit asynchronous buffering beyond the parent.

Mention intent delivery rechecks current D1 membership and destination state
only after the required viewer-projection version is visible. This prevents an
out-of-order notification from emailing someone whose access or listability was
removed. Other external outcome deliveries remain regional services; they must
not be implemented by copying user profiles, connector credentials, or email
addresses into a child.

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
initial child projection to `WorkstreamDO`, opens the regional route, and turns
legacy D1 product-table triggers into permanent writer fences. There is no
dual-write or fallback serving path.

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
- **Child-to-parent and parent-to-region effects are hash-deduplicated and versioned.** Queue ordering and delivery uniqueness are not trusted.
- **D1 workspace membership is rechecked for every workspace subscribe/command and every WorkstreamDO/SubstreamAgent/HyperSightBlockAgent admission.** HyperSight attachments carry only a bounded 60-second authorization cache and receive explicit parent sweeps; no long-lived ticket or attachment is continuing authority for a new write.
- **Legacy D1 product rows are never a fallback after activation.** Fallback would silently split authority after an object failure.

## Boundary

This module owns work-stream-down Durable Object identity, SQL, message/run
ordering, sockets, local agent execution, and cross-object projection delivery.
It exposes typed product RPCs, four ticketed socket roles, and hash-checked regional
effects.

It does not own workspace identity/membership, connector credentials, automation
definitions, workspace-wide activity queries, email/Slack destinations,
Daytona execution, or large R2 blobs. Those remain regional services. It also
does not migrate unrelated agent loops to `SubstreamAgent`.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| Migration hash mismatch/schema ahead/foreign-key violation | Constructor activation fails; no request observes a partially migrated schema. |
| Object ID has the wrong/no jurisdiction in staging or production | Constructor activation fails before serving state; callers cannot silently use the unrestricted graph. |
| Location hint cannot be honored | Cloudflare selects the nearest available location inside the jurisdiction; correctness and residency do not depend on the best-effort hint. |
| Workspace socket hibernates | Runtime restores attachments; replayed tickets are rejected, topic versions resume, and pending commands resend under the same client message ID. |
| Workstream metadata socket hibernates | Runtime restores identity; subscribe returns a complete authoritative viewer snapshot and later effects push newer revisions. |
| Child evicted during a 2–30 minute or rare 2+ hour run | Keep-alive reduces occurrence; dispatch ledger plus lease resumes after activation/expiry. |
| Feed replay window lost | Child sends `resync_required`; desktop reloads canonical parts and active output checkpoint. |
| Transcript page requested | The agent accepts an opaque before/after cursor, defaults to 200 rows, and rejects limits above 250. A per-socket request has a 15-second desktop timeout and is queued again after reconnect without advancing the room cursor. |
| Encoded transcript page would exceed 900 KB | The agent shortens the page toward the requested boundary and returns an adjusted continuation cursor. A single defensive oversize message produces a correlated `message_page_too_large` error instead of an oversized frame. |
| Historical-page read loses authorization | The agent returns a correlated authorization error and closes the revoked socket with policy code 1008; cached history is not treated as current authority. |
| Queue duplicates or reorders effects | Stable IDs/hashes deduplicate immutable effects; generation/version orders projections. |
| Parent or Queue unavailable | Child or parent outbox remains pending and alarms retry with bounded backoff. User transcript commits are not rolled back. |
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
No RPC happens inside a local SQL transaction: the source commits a fact plus
an outbox intent, and the receiver commits its mutation plus a hash-checked
receipt. Only an unsent complete replacement may be coalesced; an inflight row
is retained because it may already have committed across the object boundary.

### `WorkspaceDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | One row per immutable schema version; shared runner metadata. |
| `workspace_identity` | Singleton row (`id = 1`) binding the object to workspace, region, and immutable placement affinity. |
| `socket_ticket_receipts` | Historical v1 per-target ticket receipts retained by append-only migration; no new socket writes this table. |
| `workspace_socket_ticket_receipts` | One consumed workspace-scoped ticket including user, expiry, and consumption time; its expiry index supports bounded cleanup. |
| `workspace_sync_events` | Monotonic version, JSON topic set, and occurrence time for the bounded 1,024-event replay window. Rows are invalidations only, never workspace data copies. |

`WorkspaceDO` stores no sidebar copy and no transcript. Its socket attachment
contains workspace/session identity plus the last delivered topic version; each
subscribe/command revalidates D1, and each command invokes the selected child
through the Worker-side client.

### `WorkstreamDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable parent schema history. |
| `workstream_metadata` | Singleton aggregate identity/generation and revisioned complete common metadata: title/description/preview/email/origin/creator/automation/planning/state/attention/activity/completion/archive/schedule timestamps. |
| `substream_directory` | Latest common envelope per child, keyed by external substream ID. |
| `substream_user_directory` | Latest viewer envelope per child/user pair. |
| `child_effect_receipts` | Child/message/hash inbox proving idempotent RPC acceptance. |
| `projection_keys` | Next version and last hash for parent aggregate partitions such as `common` and `user:<id>`. |
| `durable_outbox` | Hash-checked aggregate or immutable effect waiting for regional Queue delivery/ack. |
| `workstream_socket_ticket_receipts` | Consumed metadata-socket ticket IDs, users, expiry, and consumption time. |
| `hypersight_configuration_versions` | Append-only shared block definitions and optimistic configuration version. This is the product authority for which stable block agents exist. |
| `hypersight_block_runs` | Parent-visible queued/running/terminal block state keyed by block run, configuration, block, and transcript trigger. |
| `hypersight_user_preferences` | Viewer-specific dashboard visibility, kept with the WorkstreamDO socket authority that publishes it. |
| `hypersight_dispatch_outbox` | One retryable, affinity-routed dispatch per block run; deletion means the named block agent durably accepted it. |
| `hypersight_block_result_receipts` | Highest accepted result version and hash per block run, preventing a stale retry from rolling back terminal state. |
| `hypersight_source_refresh_outbox` | Singleton coalescing configuration-to-main-substream refresh intent; its retry deadline participates in WorkstreamDO's one native alarm. |

The child tables are inputs to `workstream_metadata` and the aggregate
projection. No SQL crosses object databases; the child sends an authenticated
envelope RPC, and the parent commits receipt, child value, aggregate, and outbox
inside its own transaction.

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
| `participants`, `grant_sessions`, `member_attention` | Participation and personal read/mention waterlines; active workspace membership remains D1 authority. |
| `parts`, `part_attachments`, `part_mentions`, `content_refs` | One provider-neutral semantic order plus exact attachment, mention, and large-content joins. Tool UI rows project only as complete assistant-call/tool-result pairs; queued messages are fenced by their admitted run rather than leaking into an older run. |
| `runs`, `agent_run_dispatches`, `run_steering`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts`, `run_events` | Full-loop admission/recovery, targeted steering, frozen authority/context, provider attempts, and durable events. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Planned/executed tools, replay fences, resumable activation, and human-input pauses. |
| `active_output_turns`, `active_output_chunks`, `active_agent_compaction`, `realtime_state`, `workstream_events` | Reconnect-safe partial output and active compaction phase, room sequence, and bounded/personal event replay. `active_agent_compaction` is a singleton operational checkpoint; immutable summary history remains below. |
| `compaction_jobs`, `compaction_checkpoints`, `description_refresh_state` | Sequence/revision-fenced context derivations. Checkpoints are immutable per projection/run/sequence so a derived run can bind an exact compaction event rather than mutable “latest” state. |
| `workstream_wakeups`, `due_work` | Agent-created timers and other child-local alarm jobs. |
| `workstream_resource_links`, `resource_inventory_revision`, `activity_delivery_receipts`, `suggested_actions`, `legacy_artifacts` | Links to workspace resources, authorization revision, connector admission receipts, operational suggestion overlays, and intentionally preserved import artifacts. A suggestion is not transcript/model input unless acceptance explicitly authors a new part. |
| `hypersight_configuration_versions`, `hypersight_block_runs`, `hypersight_user_preferences` | Source-runtime compatibility records used by the Bind harness and maintenance import. WorkstreamDO is the post-cutover product authority for configuration, published run state, and viewer preference. |
| `terminal_workspace`, `terminal_commands`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | Durable Avalon state for the Daytona-backed Terminal plugin. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Versioned child-to-parent effects and inbound dedupe such as feed tickets. |

Compatibility views named `_runtime_*` map established D1-shaped repository SQL
onto these normalized tables. They are not duplicate storage or a second
authority.

### `HyperSightBlockAgent`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable block-agent schema history. |
| `hypersight_block_identity` | Singleton immutable region/workspace/work-stream/block identity. A mismatched dispatch fails closed. |
| `agent_run_dispatches` | One durable dispatch per block run with payload hash, queued/running/terminal state, attempt count, retry deadline, and terminal result waiting to settle into WorkstreamDO. |
| `latest_dispatch_freshness` | Singleton causal high-water mark for configuration version, source trigger, source time, and run ID. It makes late-retry rejection constant-time even when the immutable dispatch history is large. |
| `agent_stream_checkpoint` | Singleton full-output checkpoint for the active dispatch, foreign-keyed to `agent_run_dispatches`; revision, epoch, sequence, text, and update time allow exact reconnect replacement without replaying token deltas. Terminal completion deletes it after the final result is durable. |
| `hypersight_socket_ticket_receipts` | One-time block-socket ticket consumption with expiry cleanup, separate from every other socket audience. |

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

The scheduler queries regional D1 for cross-work-stream due targets. After
cutover, a `SubstreamAgent` owns the timer row itself and the parent directory
projects only the next due timestamp required for workspace coordination.

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
credentials. Queue messages are opaque wake-ups, and the regional Worker fetches
the hash-verified body from the parent object.

## Operations

Health endpoints report role and object-local database bytes. Migration errors
include component/version reason. Inspect `_sql_schema_migrations`,
`agent_run_dispatches`, attempt leases, child and parent `durable_outbox`,
regional effect receipts, and authority route/generation before retrying a
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

The parent coalesces common/user projections by partition and hash. A streaming
work stream therefore costs realtime child frames and child SQLite checkpoint
writes, while workspace sidebar/D1 traffic is bounded by semantic metadata
changes rather than token rate or number of connected viewers.

## Changelog

### 2026-08-18 — Unshipped Durable Object schemas start at one final baseline

**What changed:** WorkspaceDO, WorkstreamDO, SubstreamAgent, and
HyperSightBlockAgent each expose one schema migration at version 1 containing
their complete launch DDL. Transitional `ALTER`, rebuild, and backfill steps
were folded into the corresponding initial `CREATE` statements. The existing
WorkspaceScheduler already had a single initial migration and remains so.

**Why:** None of these object schemas has shipped or owns production data yet.
Publishing intermediate development history would make every new object replay
obsolete transformations, preserve states that no deployed object can have,
and complicate the maintenance-window cutover without providing rollback value.

**Considered and rejected:** Retaining versions 2–6 as documentation of branch
development. Git already preserves that history; a runtime migration ledger is
an operational compatibility contract, not a development changelog.

**Consequences:** Every newly constructed object records exactly one schema
receipt. From the first deployment onward, version 1 and its hash are immutable;
all later schema changes must append a new version and may not rewrite this
baseline.

### 2026-08-18 — HyperSight retry order cannot regress block freshness

**What changed:** WorkstreamDO delivers its block dispatch outbox head-of-line
per block. HyperSightBlockAgent independently rejects a causally older late
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

**What changed:** `HyperSightBlockAgent` now exposes its own hibernating,
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
`HyperSightBlockAgent`. WorkstreamDO owns configuration, refresh fan-out,
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
