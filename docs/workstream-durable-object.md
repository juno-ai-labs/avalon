# Workspace, work-stream, and substream Durable Objects

Avalon's regional stateful hierarchy is `WorkspaceDO -> WorkstreamDO ->
SubstreamAgent`. There is one `WorkspaceDO` per workspace, one non-agent
`WorkstreamDO` per work stream, and one `SubstreamAgent` per independently
addressable model context. The main conversation is external substream `0`.

All four Durable Object classes in this subsystem (`WorkspaceDO`,
`WorkstreamDO`, `SubstreamAgent`, and `WorkspaceScheduler`) use SQLite-backed
namespaces and explicit SQL only. Durable Object key/value persistence is
forbidden by lint. Regional D1 remains the authority for workspace membership,
connector and automation control state, routing, and cross-work-stream query
projections; it is not a transcript fallback after cutover.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/names.ts` | The only constructors for deterministic workspace, work-stream, and substream object names. |
| `apps/api/src/durable-objects/workspace-do.ts` | Hibernating workspace command socket and one-time command-ticket receipts. |
| `apps/api/src/durable-objects/workstream-do.ts` | Non-agent aggregation of child directory/user effects and the regional delivery outbox. |
| `apps/api/src/durable-objects/substream-agent.ts` | Authoritative substream SQL, direct Bind loop, hibernating feed socket, streaming checkpoints, timers, steering, and child-to-parent effect RPC. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Normalized `SubstreamAgent` schema and append-only schema versions. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Product transactions, message/run admission, read waterlines, compaction inputs, and local regional-effect creation. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | SQL repositories for replay, active output, alarms, inbox/outbox receipts, and projection versions. |
| `apps/api/src/durable-objects/workstream-runtime-sql.ts` | Restricted D1-compatible SQL adapter used by the Bind harness against object-local tables. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | Shared SQL-only constructor migration runner. |
| `apps/api/src/services/workstream-object-client.ts` | Typed Worker-to-`SubstreamAgent` product RPCs. |
| `apps/api/src/services/workstream-regional-effect-service.ts` | Regional D1 inbox, sidebar/activity projections, and notification delivery. |
| `apps/api/src/durable-objects/workspace-scheduler.ts` | One SQLite-backed alarm coordinator per workspace. |
| `scripts/eslint-rules/durable-object-sql-storage.mjs` | Rejects Durable Object `get`, `put`, `delete`, `list`, and async `transaction` KV calls, including aliases. |
| `packages/db/migrations/0077_workstream_do_authority_cutover.sql` | Maintenance control, routes, import receipts, projections, and legacy D1 writer fences. |
| `packages/db/migrations/0078_workstream_do_regional_effects.sql` | Regional effect inbox and causally fenced notification intents. |

## How it works

### Object hierarchy and identity

Names include region so Global and EU object graphs never share an identity:

```text
WorkspaceDO       <region>:<workspace-id>                    in WORKSPACE_DOS
WorkstreamDO      <region>:<workspace-id>:<workstream-id>    in WORKSTREAM_DOS
SubstreamAgent 0  <region>:<workspace-id>:<workstream-id>    in SUBSTREAM_AGENTS
SubstreamAgent N  <region>:<workspace-id>:<workstream-id>:<substream-id>
```

The main child deliberately retains the historical object name in the renamed
`SUBSTREAM_AGENTS` namespace. Wrangler's `renamed_classes` migration changes
`WorkstreamRoom` to `SubstreamAgent`, so the already-populated SQLite database
is preserved during the maintenance deployment. `WorkstreamDO` has the same
logical suffix in a different namespace; namespace plus name, not the suffix
alone, is the Durable Object identity.

`WorkspaceDO` is command/control only. `WorkstreamDO` owns aggregate metadata
only and never runs a model. `SubstreamAgent` owns the transcript and its full
agent loop. An external substream ID is immutable once recorded in
`substream_agent_identity`; an object addressed under another ID fails closed.

Existing product data migrates into main child `0`. The current product exposes
only that main context. A future feature may provision another child only when
it needs a genuinely independent ordered message array and agent loop; it must
initialize the child before issuing a socket ticket. The route shape alone is
not permission to create an empty child.

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

### User command and feed paths

The desktop holds two hibernating WebSockets while a work stream is open:

```text
user create_message
  -> WorkspaceDO command socket
  -> per-command D1 session + membership recheck
  -> WorkstreamObjectClient for the selected SubstreamAgent
  -> local SQLite message/run transaction

SubstreamAgent feed socket
  <- snapshot / stream frames / product events
  <- direct download and reconnect feed for exactly one substream
```

The workspace command socket is lazy and shared by commands within that
workspace. A user message is never accepted on the feed socket; a
`create_message` sent there receives `workspace_socket_required`. This keeps
workspace authorization and routing at the parent boundary while keeping the
high-volume read/stream path direct to its child.

Both sockets use short-lived, audience-specific, single-use tickets. The edge
Worker verifies the signed ticket and passes only verified headers to the
object. `WorkspaceDO` consumes command tickets in `socket_ticket_receipts`;
`SubstreamAgent` consumes feed tickets in `durable_inbox_receipts`. A ticket for
one purpose cannot be replayed or used for the other.

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

### Keep-alive without the Agents SDK

`SubstreamAgent.keepAlive()` and `keepAliveWhile()` are a narrow custom port of
the useful Agents SDK lifecycle behavior. The first reference ensures an alarm
no later than 30 seconds; nested long operations share it; the final idempotent
disposer recomputes the alarm only from durable work. Runtime ping/pong is
handled by WebSocket auto-response and does not wake the object.

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

The child keeps a bounded replay window in memory. A connected desktop can
switch from stream A to stream B and back with no loss: it sends its last room
sequence; the child replays when the window is present, otherwise it returns
`resync_required`, and the desktop rebuilds from the authoritative message feed
plus active checkpoint. The renderer may animate a received text batch one
token at a time; that presentation trick does not change durable text or cursor
semantics.

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

### Timers and Daytona

Agent-created one-shot timers live in `workstream_wakeups` inside the exact
`SubstreamAgent` that created them. `due_work` contains child-local derived jobs
such as HyperSight refresh. One alarm is set to the earliest regional effect,
HyperSight refresh, run dispatch, agent timer, or keep-alive heartbeat. A due
timer admits work into that same child, preserving its transcript and authority.

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
- **`WorkstreamDO` runs no model and owns no transcript.** Putting an agent there recreates one serialization bottleneck across substreams.
- **User messages enter through `WorkspaceDO`; feeds stream directly from `SubstreamAgent`.** Accepting writes on both sockets creates two authorization and ordering boundaries.
- **Every Durable Object persists through explicit SQL.** KV calls create invisible schema and bypass migration, constraints, inspection, and lint.
- **Room sequence and active text commit atomically.** Advancing only the cursor loses streamed text after eviction.
- **One unexpired attempt lease owns a child run.** Two owners can duplicate an external tool effect or terminal assistant message.
- **A steering record names the targeted run.** A generic “steer next” flag can stop an unrelated future run.
- **Compaction results cannot cover rows above their input fence.** Otherwise a message accepted during summarization disappears from model context.
- **Child-to-parent and parent-to-region effects are hash-deduplicated and versioned.** Queue ordering and delivery uniqueness are not trusted.
- **D1 workspace membership is rechecked for every workspace-socket command and feed admission.** A long-lived ticket or socket attachment is not continuing authorization for a new write.
- **Legacy D1 product rows are never a fallback after activation.** Fallback would silently split authority after an object failure.

## Boundary

This module owns work-stream-down Durable Object identity, SQL, message/run
ordering, sockets, local agent execution, and cross-object projection delivery.
It exposes typed product RPCs, two ticketed sockets, and hash-checked regional
effects.

It does not own workspace identity/membership, connector credentials, automation
definitions, workspace-wide activity queries, email/Slack destinations,
Daytona execution, or large R2 blobs. Those remain regional services. It also
does not migrate unrelated agent loops to `SubstreamAgent`.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| Migration hash mismatch/schema ahead/foreign-key violation | Constructor activation fails; no request observes a partially migrated schema. |
| Workspace command socket hibernates | Runtime restores attachments; replayed command ticket is rejected from SQL. |
| Child evicted during a 2–30 minute or rare 2+ hour run | Keep-alive reduces occurrence; dispatch ledger plus lease resumes after activation/expiry. |
| Feed replay window lost | Child sends `resync_required`; desktop reloads canonical parts and active output checkpoint. |
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

`apps/api/vitest.workers.config.ts` uses Cloudflare's current Vitest pool with
`runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, and
`evictDurableObject`. `test-workers/durable-object-runtime.test.ts` exercises
constructor migrations, per-object SQL isolation across eviction, keep-alive
alarms, `WorkstreamDO` aggregation, hibernating workspace command sockets,
ticket replay, and the read-only child socket. Node tests cover migration
rollback/hash drift/ahead versions, normalized product SQL, authorization,
effect idempotency, streaming checkpoints, and renderer socket switching.

Do not replace workerd lifecycle tests with hand-made state objects. Focused
Node repository tests may use `node:sqlite`, but their `DurableObjectState`
doubles must include real SQL/transaction behavior when constructor migration
is under test.

## Data model

The DDL in source is authoritative. This catalog defines ownership and joins.

### `WorkspaceDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | One row per immutable schema version; shared runner metadata. |
| `workspace_identity` | Singleton row (`id = 1`) binding the object to workspace and region. |
| `socket_ticket_receipts` | One consumed command ticket, including user, work stream, substream, expiry, and consumption time; expiry index supports bounded cleanup. |

`WorkspaceDO` stores no sidebar copy and no transcript. Its socket attachment
contains routing identity; each command revalidates D1 and invokes the selected
child through the Worker-side client.

### `WorkstreamDO`

| Table | Key and relationship |
| --- | --- |
| `_sql_schema_migrations` | Immutable parent schema history. |
| `workstream_metadata` | Singleton aggregate identity, authority generation, common metadata, state, and activity/completion timestamps. |
| `substream_directory` | Latest common envelope per child, keyed by external substream ID. |
| `substream_user_directory` | Latest viewer envelope per child/user pair. |
| `child_effect_receipts` | Child/message/hash inbox proving idempotent RPC acceptance. |
| `projection_keys` | Next version and last hash for parent aggregate partitions such as `common` and `user:<id>`. |
| `durable_outbox` | Hash-checked aggregate or immutable effect waiting for regional Queue delivery/ack. |

The child tables are inputs to `workstream_metadata` and the aggregate
projection. No SQL crosses object databases; the child sends an authenticated
envelope RPC, and the parent commits receipt, child value, aggregate, and outbox
inside its own transaction.

### `SubstreamAgent`

| Table group | Meaning and relationships |
| --- | --- |
| `_sql_schema_migrations`, `_data_migrations`, `_migration_command_receipts`, `object_versions` | Schema/data/import versions and resumable maintenance receipts. |
| `workstream`, `substream_agent_identity`, `substreams` | Local root/authority, immutable external child identity, and LLM-array context metadata. Existing main data uses local context `0`. |
| `participants`, `grant_sessions`, `member_attention` | Participation and personal read/mention waterlines; active workspace membership remains D1 authority. |
| `parts`, `part_attachments`, `part_mentions`, `content_refs` | Ordered LLM-shaped message parts and exact joins to attachments, mentions, and large content. |
| `runs`, `agent_run_dispatches`, `run_steering`, `run_scopes`, `run_memory_contexts`, `run_plugin_activations`, `run_lifecycle_events`, `inference_attempts`, `run_events` | Full-loop admission/recovery, targeted steering, frozen authority/context, provider attempts, and durable events. |
| `tool_effects`, `tool_effect_checkpoints`, `attachment_tool_receipts`, `plugin_activation_hints`, `elicitation_requests` | Planned/executed tools, replay fences, resumable activation, and human-input pauses. |
| `active_output_turns`, `active_output_chunks`, `realtime_state`, `workstream_events` | Reconnect-safe partial output, room sequence, and bounded/personal event replay. |
| `compaction_jobs`, `compaction_checkpoints`, `description_refresh_state` | Sequence/revision-fenced context derivations. |
| `workstream_wakeups`, `due_work` | Agent-created timers and other child-local alarm jobs. |
| `workstream_resource_links`, `resource_inventory_revision`, `activity_delivery_receipts`, `suggested_actions`, `legacy_artifacts` | Links to workspace resources, authorization revision, connector admission receipts, local actions, and intentionally preserved import artifacts. |
| `hypersight_configuration_versions`, `hypersight_block_runs`, `hypersight_user_preferences` | Child-local HyperSight configuration, execution, and viewer preference state. |
| `terminal_workspace`, `terminal_commands`, `terminal_tasks`, `terminal_imported_resources`, `terminal_repository`, `terminal_publication_grants`, `repository_publications` | Durable Avalon state for the Daytona-backed Terminal plugin. |
| `projection_keys`, `durable_outbox`, `durable_inbox_receipts` | Versioned child-to-parent effects and inbound dedupe such as feed tickets. |

Compatibility views named `_runtime_*` map established D1-shaped repository SQL
onto these normalized tables. They are not duplicate storage or a second
authority.

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

Every object is selected through the workspace's immutable region. Production
EU namespaces use the EU jurisdiction namespace, and EU D1/R2/Queues process EU
workspace data. The global registry carries only routing/identity metadata; no
transcript, token frame, connector payload, notification body, or full Workflow
input crosses it.

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
operators must never reopen legacy D1 writers as recovery.

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
preserves the renamed historical SQLite object during the maintenance cutover.

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
